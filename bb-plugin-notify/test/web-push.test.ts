import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { test } from "node:test";

import Database from "better-sqlite3";
import webPush from "web-push";

import {
  createWebPushPayload,
  InvalidSubscriptionError,
  WEB_PUSH_MIGRATIONS,
  WebPushOwner,
  type WebPushPayload,
} from "../web-push.ts";

const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString(
  "base64url",
);
const auth = Buffer.alloc(16, 3).toString("base64url");

function subscription(endpoint: string, expirationTime: number | null = null) {
  return {
    endpoint,
    expirationTime,
    keys: { p256dh, auth },
  };
}

function pushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`push ${statusCode}`), { statusCode });
}

function createOwner(
  sendNotification: (
    subscription: { endpoint: string },
    payload: string,
    options: { timeout: number },
  ) => Promise<unknown> = async () => undefined,
  now: () => number = () => 10_000,
) {
  const db = new Database(":memory:");
  for (const migration of WEB_PUSH_MIGRATIONS) db.exec(migration);
  const owner = new WebPushOwner(
    db,
    { debug() {}, warn() {} },
    {
      generateVapidKeys: () => ({ publicKey: "public-key", privateKey: "private-key" }),
      sendNotification,
      now,
      createNotificationId: () => "test-id",
    },
  );
  return { db, owner };
}

test("invalid subscriptions never reach storage", async () => {
  const { owner, db } = createOwner();
  const invalid = [
    null,
    {},
    subscription("http://push.example/device"),
    subscription("https://user:secret@push.example/device"),
    { ...subscription("https://push.example/device"), keys: { p256dh: "short", auth } },
    { ...subscription("https://push.example/device"), keys: { p256dh, auth: "short" } },
    subscription("https://push.example/device", -1),
  ];

  for (const value of invalid) {
    assert.throws(() => owner.subscribe(value), InvalidSubscriptionError);
  }
  assert.equal(owner.status(null).subscriptionCount, 0);
  db.close();
});

test("one VAPID key pair survives owner replacement", async () => {
  const db = new Database(":memory:");
  for (const migration of WEB_PUSH_MIGRATIONS) db.exec(migration);
  let generated = 0;
  const dependencies = {
    generateVapidKeys: () => {
      generated += 1;
      return { publicKey: `public-${generated}`, privateKey: `private-${generated}` };
    },
    sendNotification: async () => undefined,
    now: () => 10_000,
  };

  const log = { debug() {}, warn() {} };
  const first = new WebPushOwner(db, log, dependencies);
  const second = new WebPushOwner(db, log, dependencies);
  assert.equal(generated, 1);
  assert.equal(first.status(null).publicKey, "public-1");
  assert.equal(second.status(null).publicKey, "public-1");
  db.close();
});

test("each subscriber is attempted even when one push fails", async () => {
  const endpoints: string[] = [];
  const payloads: WebPushPayload[] = [];
  const timeouts: number[] = [];
  const { owner, db } = createOwner(async (target, payload, options) => {
    endpoints.push(target.endpoint);
    payloads.push(JSON.parse(payload) as WebPushPayload);
    timeouts.push(options.timeout);
    if (target.endpoint.endsWith("/broken")) throw pushError(503);
  });
  for (const name of ["phone-a", "broken", "phone-b"]) {
    owner.subscribe(subscription(`https://push.example/${name}`));
  }

  const payload = createWebPushPayload(
    {
      title: "Thread",
      body: "Done",
      url: "/projects/proj_1/threads/thr_1",
      threadId: "thr_1",
      silent: true,
    },
    "notice-1",
  );
  const result = await owner.send(payload);

  assert.deepEqual(result, { attempted: 3, sent: 2, removed: 0, failed: 1 });
  assert.deepEqual(endpoints, [
    "https://push.example/phone-a",
    "https://push.example/broken",
    "https://push.example/phone-b",
  ]);
  assert.deepEqual(payloads, [payload, payload, payload]);
  assert.deepEqual(timeouts, [10_000, 10_000, 10_000]);
  assert.equal(owner.status(null).subscriptionCount, 3);
  db.close();
});

test("404 and 410 responses remove only expired endpoints", async () => {
  const attempts: string[] = [];
  const { owner, db } = createOwner(async (target) => {
    attempts.push(target.endpoint);
    if (target.endpoint.endsWith("/gone")) throw pushError(404);
    if (target.endpoint.endsWith("/expired")) throw pushError(410);
  });
  owner.subscribe(subscription("https://push.example/gone"));
  owner.subscribe(subscription("https://push.example/expired"));
  owner.subscribe(subscription("https://push.example/live"));

  const first = await owner.send(
    createWebPushPayload(
      {
        title: "Thread",
        body: "Done",
        url: "/projects/proj_1/threads/thr_1",
        threadId: "thr_1",
        silent: false,
      },
      "notice-1",
    ),
  );
  assert.deepEqual(first, { attempted: 3, sent: 1, removed: 2, failed: 0 });
  assert.equal(owner.status(null).subscriptionCount, 1);

  attempts.length = 0;
  const second = await owner.send(
    createWebPushPayload(
      {
        title: "Thread",
        body: "Again",
        url: "/projects/proj_1/threads/thr_1",
        threadId: "thr_1",
        silent: false,
      },
      "notice-2",
    ),
  );
  assert.deepEqual(second, { attempted: 1, sent: 1, removed: 0, failed: 0 });
  assert.deepEqual(attempts, ["https://push.example/live"]);
  db.close();
});

test("payloads keep project thread URLs relative and carry the sound choice", () => {
  assert.deepEqual(
    createWebPushPayload(
      {
        title: "Build",
        body: "Done",
        url: "/projects/proj_abc/threads/thr_abc-123",
        threadId: "thr_abc-123",
        silent: true,
      },
      "id-1",
    ),
    {
      title: "Build",
      body: "Done",
      tag: "bb-notify-push-id-1",
      url: "/projects/proj_abc/threads/thr_abc-123",
      threadId: "thr_abc-123",
      silent: true,
    },
  );
  assert.equal(
    createWebPushPayload(
      { title: "bb", body: "Hi", url: "/", threadId: null, silent: false },
      "id-2",
    ).url,
    "/",
  );
});

test("the sender encrypts payloads with modern aes128gcm", () => {
  const receiver = createECDH("prime256v1");
  receiver.generateKeys();
  const vapid = webPush.generateVAPIDKeys();
  const request = webPush.generateRequestDetails(
    {
      endpoint: "https://push.example/device",
      keys: {
        p256dh: receiver.getPublicKey().toString("base64url"),
        auth,
      },
    },
    JSON.stringify(
      createWebPushPayload(
        {
          title: "Thread",
          body: "Done",
          url: "/projects/proj_1/threads/thr_1",
          threadId: "thr_1",
          silent: true,
        },
        "id",
      ),
    ),
    {
      TTL: 60,
      urgency: "high",
      vapidDetails: {
        subject: "https://github.com/ratulsarna/rd-bb-plugins",
        ...vapid,
      },
    },
  );

  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
});
