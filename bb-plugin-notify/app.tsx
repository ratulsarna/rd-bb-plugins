// Frontend half of bb-plugin-notify.
//
// macOS credits a notification to the process that posted it. A scripted
// notification is therefore always the interpreter's, which is why the
// osascript path wears the Script Editor icon. Posting from this window makes
// the notification BB's own: BB's icon, BB's name, and a click that opens the
// thread.
//
// A content script stays mounted everywhere for the desktop queue and service
// worker click bridge. The settings slot owns phone subscription controls.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { useCallback, useEffect, useState } from "react";

import { isDesktopNotificationHost, isThreadId, notificationTag } from "./format";
import {
  SERVICE_WORKER_SCOPE,
  SERVICE_WORKER_URL,
  WEB_PUSH_ROUTE_BASE,
} from "./service-worker";

const PENDING_URL = "/api/v1/plugins/notify/http/pending";
const ACK_URL = "/api/v1/plugins/notify/http/ack";
/** Only one window may poll; the rest wait behind this lock. */
const POLL_LOCK = "bb-plugin-notify:poller";
/** Backoff after a failed poll, so a server restart is not hammered. */
const RETRY_DELAY_MS = 3_000;
/**
 * Floor between two empty polls. The server holds the request open, so an
 * empty batch should never come back fast; if one does — a proxy that will not
 * hold, a route answering 200 with nothing — this keeps the loop from becoming
 * a spin. A batch with notifications in it re-polls immediately, as it should.
 */
const MIN_EMPTY_POLL_MS = 1_000;
const WORKER_START_TIMEOUT_MS = 10_000;

interface PendingNotification {
  id: number;
  title: string;
  body: string;
  threadId: string | null;
  url: string;
  silent: boolean;
}

function isPending(value: unknown): value is PendingNotification {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "number" &&
    typeof item.title === "string" &&
    typeof item.body === "string" &&
    typeof item.silent === "boolean" &&
    typeof item.url === "string" &&
    (item.threadId === null || typeof item.threadId === "string")
  );
}

/** Wait, cut short by abort. Each path disarms the other, so `finish` runs once. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      // oxlint-disable-next-line promise/no-multiple-resolved
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

function localPath(value: unknown): string {
  return typeof value === "string" && value.startsWith("/") && !value.startsWith("//")
    ? value
    : "/";
}

function navigateToThreadLocally(threadId: string, url: unknown): void {
  const row = document.querySelector<HTMLElement>(
    `[data-sidebar-thread-id="${CSS.escape(threadId)}"]`,
  );
  if (row !== null) {
    row.click();
    return;
  }
  window.location.assign(localPath(url));
}

function listenForServiceWorkerClicks(signal: AbortSignal): void {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener(
    "message",
    (event) => {
      const value: unknown = event.data;
      if (
        typeof value === "object" &&
        value !== null &&
        (value as { type?: unknown }).type === "bb-notify-open-thread"
      ) {
        const threadId = (value as { threadId?: unknown }).threadId;
        if (typeof threadId === "string" && isThreadId(threadId)) {
          // The worker already focused this window. Navigate it directly so a
          // waking PWA does not depend on its WebSocket reconnecting first.
          navigateToThreadLocally(threadId, (value as { url?: unknown }).url);
        }
      }
    },
    { signal },
  );
}

function updateInstalledServiceWorker(): void {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker
    .getRegistration(SERVICE_WORKER_SCOPE)
    .then((registration) => registration?.update())
    .catch(() => undefined);
}

function present(item: PendingNotification): void {
  // A stable per-thread tag makes Chromium replace an earlier delivered alert.
  // macOS keeps that replacement in Notification Center but can skip its banner,
  // so every queued item needs its own tag.
  // `silent` is the only sound control the web API has. The server only
  // silences this notification when it can play the chosen macOS tone itself.
  const notification = new Notification(item.title, {
    body: item.body,
    tag: notificationTag(item.id),
    silent: item.silent,
  });
  notification.addEventListener("click", () => {
    window.focus();
    if (item.threadId !== null) navigateToThreadLocally(item.threadId, item.url);
    notification.close();
  });
}

async function acknowledge(
  leaseId: string,
  notificationIds: readonly number[],
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(ACK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ leaseId, notificationIds }),
    credentials: "same-origin",
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}

async function poll(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    const startedAt = Date.now();
    try {
      const response = await fetch(PENDING_URL, {
        signal,
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload: unknown = await response.json();
      const record =
        typeof payload === "object" && payload !== null
          ? (payload as Record<string, unknown>)
          : null;
      const list = Array.isArray(record?.notifications) ? record.notifications : [];
      const leaseId = typeof record?.leaseId === "string" ? record.leaseId : null;
      if (list.length > 0 && leaseId === null) {
        throw new Error("notification batch has no lease");
      }
      let shown = 0;
      const shownIds: number[] = [];
      for (const item of list) {
        if (!isPending(item)) continue;
        try {
          present(item);
          shown += 1;
          shownIds.push(item.id);
        } catch {
          // A failed item remains leased and is retried later; the rest of the
          // batch can still be acknowledged independently.
        }
      }
      if (leaseId !== null && shownIds.length > 0) {
        await acknowledge(leaseId, shownIds, signal);
      }
      if (shown === 0 && Date.now() - startedAt < MIN_EMPTY_POLL_MS) {
        await sleep(MIN_EMPTY_POLL_MS, signal);
      }
    } catch {
      if (signal.aborted) return;
      await sleep(RETRY_DELAY_MS, signal);
    }
  }
}

async function bridge(signal: AbortSignal): Promise<void> {
  const desktopBridge = (window as Window & { readonly bbDesktop?: unknown }).bbDesktop;
  // The same content script also mounts in web browsers. Letting one of those
  // poll races claim the queue attributes the alert to that browser and applies
  // its notification settings instead of bb's.
  if (!isDesktopNotificationHost(desktopBridge)) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission === "default") {
    await Notification.requestPermission();
  }
  if (Notification.permission !== "granted") return;

  if (navigator.locks === undefined) {
    await poll(signal);
    return;
  }
  // The lock elects a single poller across windows, and hands over
  // automatically when that window closes.
  await navigator.locks.request(POLL_LOCK, { signal }, () => poll(signal));
}

interface ServerPushStatus {
  publicKey: string;
  subscriptionCount: number;
  subscribed: boolean;
}

function webPushSupportError(): string | null {
  if (!window.isSecureContext) return "Web Push needs HTTPS.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return "This browser does not support Web Push.";
  }
  if (!("Notification" in window)) return "This browser cannot show notifications.";

  const standalone = navigator as Navigator & { readonly standalone?: boolean };
  if ("standalone" in standalone && standalone.standalone !== true) {
    return "Add BB to your iPhone Home Screen, then open it from there.";
  }
  return null;
}

function isServerPushStatus(value: unknown): value is ServerPushStatus {
  if (typeof value !== "object" || value === null) return false;
  const status = value as Record<string, unknown>;
  return (
    typeof status.publicKey === "string" &&
    Number.isSafeInteger(status.subscriptionCount) &&
    (status.subscriptionCount as number) >= 0 &&
    typeof status.subscribed === "boolean"
  );
}

async function postWebPush<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${WEB_PUSH_ROUTE_BASE}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const detail =
      typeof value === "object" &&
      value !== null &&
      typeof (value as { error?: unknown }).error === "string"
        ? (value as { error: string }).error
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return value as T;
}

function applicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const decoded = atob(padded);
  const key = new Uint8Array(new ArrayBuffer(decoded.length));
  for (let index = 0; index < decoded.length; index += 1) {
    key[index] = decoded.charCodeAt(index);
  }
  return key;
}

function sameApplicationServerKey(
  subscription: PushSubscription,
  expected: Uint8Array<ArrayBuffer>,
): boolean {
  const current = subscription.options.applicationServerKey;
  if (current === null || current.byteLength !== expected.byteLength) return false;
  const bytes = new Uint8Array(current);
  return bytes.every((byte, index) => byte === expected[index]);
}

function waitForActiveWorker(
  registration: ServiceWorkerRegistration,
): Promise<ServiceWorkerRegistration> {
  if (registration.active !== null) return Promise.resolve(registration);
  const worker = registration.installing ?? registration.waiting;
  if (worker === null) return Promise.reject(new Error("Service worker did not start."));
  if (worker.state === "activated") return Promise.resolve(registration);

  return new Promise((resolve, reject) => {
    const finish = () => {
      clearTimeout(timer);
      worker.removeEventListener("statechange", changed);
    };
    const changed = () => {
      if (worker.state === "activated") {
        finish();
        resolve(registration);
      } else if (worker.state === "redundant") {
        finish();
        reject(new Error("Service worker install failed."));
      }
    };
    const timer = window.setTimeout(() => {
      finish();
      reject(new Error("Service worker install timed out."));
    }, WORKER_START_TIMEOUT_MS);
    worker.addEventListener("statechange", changed);
  });
}

function buttonClass(primary = false): string {
  return [
    "inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium",
    "disabled:cursor-not-allowed disabled:opacity-50",
    primary
      ? "border-primary bg-primary text-primary-foreground"
      : "border-border bg-background text-foreground hover:bg-muted",
  ].join(" ");
}

function WebPushSettings() {
  const supportError = webPushSupportError();
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [serverStatus, setServerStatus] = useState<ServerPushStatus | null>(null);
  const [notice, setNotice] = useState<string | null>(supportError);
  const [loading, setLoading] = useState(supportError === null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (nextRegistration: ServiceWorkerRegistration) => {
    const nextSubscription = await nextRegistration.pushManager.getSubscription();
    const status = await postWebPush<unknown>("status", {
      endpoint: nextSubscription?.endpoint ?? null,
    });
    if (!isServerPushStatus(status)) throw new Error("Invalid Web Push status.");
    setSubscription(nextSubscription);
    setServerStatus(status);
    setNotice(null);
  }, []);

  useEffect(() => {
    if (supportError !== null) return;
    let cancelled = false;
    void (async () => {
      try {
        const installed = await navigator.serviceWorker.register(SERVICE_WORKER_URL, {
          scope: SERVICE_WORKER_SCOPE,
        });
        const active = await waitForActiveWorker(installed);
        if (cancelled) return;
        setRegistration(active);
        await refresh(active);
      } catch (error) {
        if (!cancelled) {
          setNotice(error instanceof Error ? error.message : "Could not start Web Push.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh, supportError]);

  async function enable(): Promise<void> {
    if (registration === null || serverStatus === null) return;
    setBusy(true);
    setNotice(null);
    try {
      if (Notification.permission === "denied") {
        throw new Error("Notifications are blocked. Allow them in iPhone Settings.");
      }

      const expectedKey = applicationServerKey(serverStatus.publicKey);
      let nextSubscription = subscription;
      if (
        nextSubscription !== null &&
        !sameApplicationServerKey(nextSubscription, expectedKey)
      ) {
        throw new Error("This device has an old push key. Disable it, then enable it again.");
      }

      const created = nextSubscription === null;
      nextSubscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: expectedKey,
      });
      try {
        const status = await postWebPush<unknown>("subscribe", nextSubscription.toJSON());
        if (!isServerPushStatus(status)) throw new Error("Invalid Web Push status.");
        setSubscription(nextSubscription);
        setServerStatus(status);
        setNotice("Enabled on this device.");
      } catch (error) {
        if (created) await nextSubscription.unsubscribe().catch(() => false);
        throw error;
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not enable Web Push.");
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    if (subscription === null) return;
    setBusy(true);
    setNotice(null);
    try {
      await postWebPush("test", { endpoint: subscription.endpoint });
      setNotice("Test sent.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send the test.");
      if (registration !== null) await refresh(registration).catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  async function disable(): Promise<void> {
    if (registration === null) return;
    setBusy(true);
    setNotice(null);
    try {
      const currentSubscription = await registration.pushManager.getSubscription();
      if (currentSubscription !== null) {
        await postWebPush("unsubscribe", { endpoint: currentSubscription.endpoint });
        await currentSubscription.unsubscribe();
      }
      await refresh(registration);
      setNotice("Disabled on this device.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not disable Web Push.");
    } finally {
      setBusy(false);
    }
  }

  const enabled = subscription !== null && serverStatus?.subscribed === true;
  const count = serverStatus?.subscriptionCount ?? 0;
  const statusText =
    supportError ??
    (loading
      ? "Checking this device…"
      : enabled
        ? `Enabled on this device. ${count} ${count === 1 ? "device" : "devices"} subscribed.`
        : subscription !== null
          ? "This device needs to be enabled again."
          : `Not enabled on this device. ${count} ${count === 1 ? "other device" : "other devices"} subscribed.`);

  return (
    <div className="space-y-3 text-sm">
      <p className="text-muted-foreground" aria-live="polite">
        {notice ?? statusText}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className={buttonClass(true)}
          disabled={busy || loading || supportError !== null || registration === null || enabled}
          onClick={() => void enable()}
        >
          Enable
        </button>
        <button
          type="button"
          className={buttonClass()}
          disabled={busy || !enabled}
          onClick={() => void test()}
        >
          Test
        </button>
        <button
          type="button"
          className={buttonClass()}
          disabled={busy || subscription === null}
          onClick={() => void disable()}
        >
          Disable
        </button>
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.contentScripts.register({
    id: "notification-bridge",
    mount({ signal }) {
      listenForServiceWorkerClicks(signal);
      updateInstalledServiceWorker();
      // Detached on purpose: the host time-boxes awaited mount work, and this
      // bridge runs for the lifetime of the window.
      void bridge(signal).catch(() => {
        // A dead bridge must not take the app's plugin surface down with it.
      });
    },
  });
  app.slots.settingsSection({
    id: "web-push",
    title: "iPhone Home Screen notifications",
    description: "Send encrypted notifications to each subscribed Home Screen app.",
    component: WebPushSettings,
  });
});
