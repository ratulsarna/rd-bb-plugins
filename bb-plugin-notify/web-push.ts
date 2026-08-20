import { randomUUID } from "node:crypto";

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import webPush from "web-push";

const VAPID_SUBJECT = "https://github.com/ratulsarna/rd-bb-plugins";
const PUSH_TTL_SECONDS = 60;
const PUSH_TIMEOUT_MS = 10_000;

export const WEB_PUSH_MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS web_push_vapid_keys (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     public_key TEXT NOT NULL,
     private_key TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS web_push_subscriptions (
     endpoint TEXT PRIMARY KEY,
     p256dh TEXT NOT NULL,
     auth TEXT NOT NULL,
     expiration_time INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
] as const;

type PluginDatabase = ReturnType<BbPluginApi["storage"]["database"]>;

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  expirationTime: number | null;
}

export interface WebPushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  silent: boolean;
}

type WebPushPayloadInput = Omit<WebPushPayload, "tag">;

export interface WebPushDeliverySummary {
  attempted: number;
  sent: number;
  removed: number;
  failed: number;
}

export interface WebPushStatus {
  publicKey: string;
  subscriptionCount: number;
  subscribed: boolean;
}

export type WebPushTestResult = "sent" | "missing" | "expired" | "failed";

interface WebPushDependencies {
  generateVapidKeys: () => VapidKeys;
  sendNotification: (
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload: string,
    options: {
      TTL: number;
      timeout: number;
      urgency: "high";
      vapidDetails: VapidKeys & { subject: string };
    },
  ) => Promise<unknown>;
  now: () => number;
  createNotificationId: () => string;
}

const productionDependencies: WebPushDependencies = {
  generateVapidKeys: webPush.generateVAPIDKeys,
  sendNotification: (subscription, payload, options) =>
    webPush.sendNotification(subscription, payload, options),
  now: Date.now,
  createNotificationId: randomUUID,
};

export class InvalidSubscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSubscriptionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function decodeBase64Url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  try {
    return Buffer.from(value, "base64url");
  } catch {
    return null;
  }
}

export function parsePushEndpoint(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new InvalidSubscriptionError("Invalid push endpoint.");
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new InvalidSubscriptionError("Invalid push endpoint.");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new InvalidSubscriptionError("Invalid push endpoint.");
  }
  return url.href;
}

export function parsePushSubscription(value: unknown): StoredSubscription {
  if (!isRecord(value) || !isRecord(value.keys)) {
    throw new InvalidSubscriptionError("Invalid push subscription.");
  }
  const endpoint = parsePushEndpoint(value.endpoint);
  const p256dh = value.keys.p256dh;
  const auth = value.keys.auth;
  const decodedP256dh = typeof p256dh === "string" ? decodeBase64Url(p256dh) : null;
  const decodedAuth = typeof auth === "string" ? decodeBase64Url(auth) : null;
  if (decodedP256dh?.length !== 65 || decodedP256dh[0] !== 4) {
    throw new InvalidSubscriptionError("Invalid p256dh key.");
  }
  if (decodedAuth?.length !== 16) {
    throw new InvalidSubscriptionError("Invalid auth key.");
  }

  const expirationTime = value.expirationTime ?? null;
  if (
    expirationTime !== null &&
    (typeof expirationTime !== "number" ||
      !Number.isFinite(expirationTime) ||
      expirationTime <= 0)
  ) {
    throw new InvalidSubscriptionError("Invalid subscription expiration time.");
  }

  return {
    endpoint,
    p256dh: p256dh as string,
    auth: auth as string,
    expirationTime,
  };
}

function responseStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  return typeof error.statusCode === "number" ? error.statusCode : null;
}

function subscriptionFromRow(row: unknown): StoredSubscription {
  const value = row as {
    endpoint: string;
    p256dh: string;
    auth: string;
    expiration_time: number | null;
  };
  return {
    endpoint: value.endpoint,
    p256dh: value.p256dh,
    auth: value.auth,
    expirationTime: value.expiration_time,
  };
}

export function createWebPushPayload(
  input: WebPushPayloadInput,
  notificationId: string = randomUUID(),
): WebPushPayload {
  return {
    ...input,
    tag: `bb-notify-push-${notificationId}`,
  };
}

export class WebPushOwner {
  private readonly db: PluginDatabase;
  private readonly vapidKeys: VapidKeys;
  private readonly dependencies: WebPushDependencies;
  private readonly log: Pick<BbPluginApi["log"], "debug" | "warn">;
  private readonly selectSubscriptions;
  private readonly selectSubscription;
  private readonly countSubscriptions;
  private readonly upsertSubscription;
  private readonly deleteSubscription;
  private readonly deleteExpiredSubscriptions;

  constructor(
    db: PluginDatabase,
    log: Pick<BbPluginApi["log"], "debug" | "warn">,
    dependencies: Partial<WebPushDependencies> = {},
  ) {
    this.db = db;
    this.log = log;
    this.dependencies = { ...productionDependencies, ...dependencies };
    this.vapidKeys = this.loadOrCreateVapidKeys();
    this.selectSubscriptions = db.prepare(
      `SELECT endpoint, p256dh, auth, expiration_time
       FROM web_push_subscriptions
       ORDER BY created_at ASC`,
    );
    this.selectSubscription = db.prepare(
      `SELECT endpoint, p256dh, auth, expiration_time
       FROM web_push_subscriptions
       WHERE endpoint = ?`,
    );
    this.countSubscriptions = db.prepare(
      `SELECT COUNT(*) AS count FROM web_push_subscriptions`,
    );
    this.upsertSubscription = db.prepare(
      `INSERT INTO web_push_subscriptions (
         endpoint, p256dh, auth, expiration_time, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         p256dh = excluded.p256dh,
         auth = excluded.auth,
         expiration_time = excluded.expiration_time,
         updated_at = excluded.updated_at`,
    );
    this.deleteSubscription = db.prepare(
      `DELETE FROM web_push_subscriptions WHERE endpoint = ?`,
    );
    this.deleteExpiredSubscriptions = db.prepare(
      `DELETE FROM web_push_subscriptions
       WHERE expiration_time IS NOT NULL AND expiration_time <= ?`,
    );
  }

  private loadOrCreateVapidKeys(): VapidKeys {
    const select = this.db.prepare(
      `SELECT public_key, private_key FROM web_push_vapid_keys WHERE id = 1`,
    );
    let row = select.get() as
      | { public_key: string; private_key: string }
      | undefined;
    if (row === undefined) {
      const generated = this.dependencies.generateVapidKeys();
      this.db
        .prepare(
          `INSERT OR IGNORE INTO web_push_vapid_keys (
             id, public_key, private_key, created_at
           ) VALUES (1, ?, ?, ?)`,
        )
        .run(generated.publicKey, generated.privateKey, this.dependencies.now());
      row = select.get() as { public_key: string; private_key: string } | undefined;
    }
    if (row === undefined) throw new Error("Could not persist VAPID keys.");
    return { publicKey: row.public_key, privateKey: row.private_key };
  }

  private removeExpiredRows(): number {
    return this.deleteExpiredSubscriptions.run(this.dependencies.now()).changes;
  }

  private count(): number {
    return (this.countSubscriptions.get() as { count: number }).count;
  }

  status(endpoint: string | null): WebPushStatus {
    this.removeExpiredRows();
    return {
      publicKey: this.vapidKeys.publicKey,
      subscriptionCount: this.count(),
      subscribed:
        endpoint !== null &&
        this.selectSubscription.get(parsePushEndpoint(endpoint)) !== undefined,
    };
  }

  subscribe(value: unknown): WebPushStatus {
    const subscription = parsePushSubscription(value);
    const now = this.dependencies.now();
    this.upsertSubscription.run(
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      subscription.expirationTime,
      now,
      now,
    );
    return this.status(subscription.endpoint);
  }

  unsubscribe(endpoint: unknown): WebPushStatus {
    const parsed = parsePushEndpoint(endpoint);
    this.deleteSubscription.run(parsed);
    return this.status(null);
  }

  private async deliver(
    subscription: StoredSubscription,
    payload: WebPushPayload,
  ): Promise<WebPushTestResult> {
    try {
      await this.dependencies.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify(payload),
        {
          TTL: PUSH_TTL_SECONDS,
          timeout: PUSH_TIMEOUT_MS,
          urgency: "high",
          vapidDetails: {
            subject: VAPID_SUBJECT,
            ...this.vapidKeys,
          },
        },
      );
      return "sent";
    } catch (error) {
      const status = responseStatus(error);
      if (status === 404 || status === 410) {
        this.deleteSubscription.run(subscription.endpoint);
        this.log.debug(`removed expired web push endpoint (${status})`);
        return "expired";
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.log.warn(`web push delivery failed${status === null ? "" : ` (${status})`}: ${detail}`);
      return "failed";
    }
  }

  async send(payload: WebPushPayload): Promise<WebPushDeliverySummary> {
    const removedBeforeSend = this.removeExpiredRows();
    const subscriptions = this.selectSubscriptions
      .all()
      .map(subscriptionFromRow);
    const results = await Promise.all(
      subscriptions.map((subscription) => this.deliver(subscription, payload)),
    );
    const summary = {
      attempted: subscriptions.length,
      sent: results.filter((result) => result === "sent").length,
      removed:
        removedBeforeSend + results.filter((result) => result === "expired").length,
      failed: results.filter((result) => result === "failed").length,
    };
    if (summary.attempted > 0) {
      this.log.debug(
        `web push sent ${summary.sent}/${summary.attempted}; removed ${summary.removed}; failed ${summary.failed}`,
      );
    }
    return summary;
  }

  async test(endpoint: unknown, silent: boolean): Promise<WebPushTestResult> {
    const parsed = parsePushEndpoint(endpoint);
    this.removeExpiredRows();
    const row = this.selectSubscription.get(parsed);
    if (row === undefined) return "missing";
    return this.deliver(
      subscriptionFromRow(row),
      createWebPushPayload(
        {
          title: "bb notify",
          body: "Web Push is working on this device.",
          url: "/",
          silent,
        },
        this.dependencies.createNotificationId(),
      ),
    );
  }
}

export function createWebPushOwner(
  bb: BbPluginApi,
  dependencies: Partial<WebPushDependencies> = {},
): WebPushOwner {
  const db = bb.storage.database();
  bb.storage.migrate(db, [...WEB_PUSH_MIGRATIONS]);
  return new WebPushOwner(db, bb.log, dependencies);
}
