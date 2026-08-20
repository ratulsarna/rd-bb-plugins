import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";

import { SERVICE_WORKER_SOURCE } from "../service-worker.ts";

type WorkerListener = (event: {
  data?: { json(): unknown };
  notification?: { data?: unknown; close(): void };
  waitUntil(value: Promise<unknown>): void;
}) => void;

interface FakeWindowClient {
  url: string;
  focus(): Promise<FakeWindowClient>;
  postMessage(value: unknown): void;
}

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function workerHarness(windows: FakeWindowClient[] = []) {
  const listeners = new Map<string, WorkerListener>();
  const notifications: Array<{ title: string; options: Record<string, unknown> }> = [];
  const opened: string[] = [];
  const self = {
    location: { origin: "https://bb.example" },
    registration: {
      async showNotification(title: string, options: Record<string, unknown>) {
        notifications.push({ title, options });
      },
    },
    clients: {
      async matchAll() {
        return windows;
      },
      async openWindow(url: string) {
        opened.push(url);
        return null;
      },
    },
    addEventListener(type: string, listener: WorkerListener) {
      listeners.set(type, listener);
    },
  };
  vm.runInNewContext(SERVICE_WORKER_SOURCE, { self, URL });
  return { listeners, notifications, opened };
}

async function dispatch(
  listener: WorkerListener,
  event: Omit<Parameters<WorkerListener>[0], "waitUntil">,
): Promise<void> {
  let work: Promise<unknown> | null = null;
  listener({
    ...event,
    waitUntil(value) {
      work = value;
    },
  });
  assert.notEqual(work, null, "event did not call waitUntil");
  await work;
}

test("push displays the supplied payload immediately", async () => {
  const harness = workerHarness();
  await dispatch(harness.listeners.get("push")!, {
    data: {
      json: () => ({
        title: "Fix login",
        body: "Tests passed.",
        tag: "notice-7",
        url: "/projects/proj_1/threads/thr_7",
        threadId: "thr_7",
        silent: true,
      }),
    },
  });

  assert.deepEqual(plain(harness.notifications), [
    {
      title: "Fix login",
      options: {
        body: "Tests passed.",
        tag: "notice-7",
        renotify: true,
        silent: true,
        data: { url: "/projects/proj_1/threads/thr_7", threadId: "thr_7" },
      },
    },
  ]);
});

test("invalid push data still shows a visible fallback", async () => {
  const harness = workerHarness();
  await dispatch(harness.listeners.get("push")!, {
    data: { json: () => "bad payload" },
  });

  assert.equal(harness.notifications.length, 1);
  assert.equal(harness.notifications[0]?.title, "bb");
  assert.equal(harness.notifications[0]?.options.body, "A BB notification arrived.");
});

test("click focuses a window already showing the matching thread", async () => {
  let focused = 0;
  const messages: unknown[] = [];
  const client: FakeWindowClient = {
    url: "https://bb.example/projects/proj_1/threads/thr_7",
    async focus() {
      focused += 1;
      return this;
    },
    postMessage(value) {
      messages.push(value);
    },
  };
  const harness = workerHarness([client]);
  let closed = false;
  await dispatch(harness.listeners.get("notificationclick")!, {
    notification: {
      data: { url: "/projects/proj_1/threads/thr_7", threadId: "thr_7" },
      close() {
        closed = true;
      },
    },
  });

  assert.equal(closed, true);
  assert.equal(focused, 1);
  assert.deepEqual(messages, []);
  assert.deepEqual(harness.opened, []);
});

test("click asks an existing uncontrolled BB page to open the thread", async () => {
  const messages: unknown[] = [];
  const client: FakeWindowClient = {
    url: "https://bb.example/threads/another",
    async focus() {
      return this;
    },
    postMessage(value) {
      messages.push(value);
    },
  };
  const harness = workerHarness([client]);
  await dispatch(harness.listeners.get("notificationclick")!, {
    notification: {
      data: { url: "/projects/proj_1/threads/thr_7", threadId: "thr_7" },
      close() {},
    },
  });

  assert.deepEqual(plain(messages), [
    {
      type: "bb-notify-open-thread",
      threadId: "thr_7",
      url: "/projects/proj_1/threads/thr_7",
    },
  ]);
  assert.deepEqual(harness.opened, []);
});

test("click opens a same-origin thread URL when no BB page is open", async () => {
  const harness = workerHarness();
  await dispatch(harness.listeners.get("notificationclick")!, {
    notification: {
      data: { url: "/projects/proj_1/threads/thr_7", threadId: "thr_7" },
      close() {},
    },
  });
  assert.deepEqual(harness.opened, [
    "https://bb.example/projects/proj_1/threads/thr_7",
  ]);

  const invalid = workerHarness();
  await dispatch(invalid.listeners.get("notificationclick")!, {
    notification: {
      data: { url: "https://evil.example", threadId: "https://evil.example" },
      close() {},
    },
  });
  assert.deepEqual(invalid.opened, ["https://bb.example/"]);
});
