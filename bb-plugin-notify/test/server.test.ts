import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";

import { NotificationQueue } from "../queue.ts";
import plugin from "../server.ts";

test("a parent notifies only after its last background agent finishes", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  const parent = {
    id: "thr_parent",
    projectId: "proj_plugins",
  } as const;
  await host.harness.behavior.callRpc("setThreadNotification", {
    threadId: parent.id,
    enabled: true,
  });

  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ ...parent, status: "active" }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      ...parent,
      status: "idle",
      activeBackgroundAgentCount: 1,
    }),
    lastAssistantText: "Waiting for review.",
  });
  assert.equal(await queue.count(), 0);

  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({ ...parent, status: "active" }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      ...parent,
      status: "idle",
      activeBackgroundAgentCount: 0,
    }),
    lastAssistantText: "Review finished.",
  });
  assert.equal(await queue.count(), 1);
});

test("a focused BB app suppresses new and held desktop notifications", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  const finish = async (id: string) => {
    await host.harness.behavior.callRpc("setThreadNotification", {
      threadId: id,
      enabled: true,
    });
    const base = { id, projectId: "proj_plugins" } as const;
    await host.harness.behavior.emitThreadEvent("thread.active", {
      thread: makeThreadResponse({ ...base, status: "active" }),
    });
    await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ ...base, status: "idle" }),
      lastAssistantText: "Done.",
    });
  };

  await finish("thr_held");
  assert.equal(await queue.count(), 1);

  const focused = await host.harness.behavior.fetchHttp("POST", "/foreground", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId: "desktop-window", foreground: true }),
  });
  assert.deepEqual(await focused.json(), { ok: true, foreground: true });

  const pending = await host.harness.behavior.fetchHttp("GET", "/pending");
  assert.deepEqual(await pending.json(), {
    leaseId: null,
    notifications: [],
  });
  assert.equal(await queue.count(), 0);

  await finish("thr_focused");
  assert.equal(await queue.count(), 0);

  await host.harness.behavior.fetchHttp("POST", "/foreground", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId: "desktop-window", foreground: false }),
  });
  await finish("thr_background");
  assert.equal(await queue.count(), 1);
});

test("threads notify only after they are enabled", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        get: async () =>
          makeThreadResponse({ id: "thr_opt_in", projectId: "proj_plugins" }),
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  assert.deepEqual(
    await host.harness.behavior.callRpc("getThreadNotification", {
      threadId: "thr_opt_in",
    }),
    { enabled: false },
  );

  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "active",
    }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "idle",
    }),
    lastAssistantText: "Done.",
  });
  await host.harness.behavior.callAgentTool(
    "notify_user",
    { message: "Needs review." },
    { threadId: "thr_opt_in", projectId: "proj_plugins" },
  );
  assert.equal(await queue.count(), 0);

  const manual = await host.harness.behavior.runCli(
    ["send", "Manual check."],
    {
      threadId: "thr_opt_in",
      projectId: "proj_plugins",
      signal: new AbortController().signal,
    },
  );
  assert.equal(manual.exitCode, 0);
  assert.equal(await queue.count(), 1);

  await host.harness.behavior.callRpc("setThreadNotification", {
    threadId: "thr_opt_in",
    enabled: true,
  });
  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "active",
    }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "idle",
    }),
    lastAssistantText: "Done.",
  });
  assert.equal(await queue.count(), 2);

  await host.harness.behavior.callAgentTool(
    "notify_user",
    { message: "Needs review." },
    { threadId: "thr_opt_in", projectId: "proj_plugins" },
  );
  assert.equal(await queue.count(), 3);

  await host.harness.behavior.callRpc("setThreadNotification", {
    threadId: "thr_opt_in",
    enabled: false,
  });
  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "active",
    }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      id: "thr_opt_in",
      projectId: "proj_plugins",
      status: "idle",
    }),
    lastAssistantText: "Done again.",
  });
  assert.equal(await queue.count(), 3);
});

test("an explicit rpc send delivers while the thread bell is off", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  assert.deepEqual(
    await host.harness.behavior.callRpc("send", {
      title: "Pipeline",
      message: "Card **needs** review.",
      projectId: "proj_plugins",
      threadId: "thr_card",
    }),
    { delivery: "held" },
  );
  const first = await queue.lease();
  assert.deepEqual(first.lease?.notifications, [
    {
      id: 1,
      title: "Pipeline",
      body: "[plugins] Card needs review.",
      threadId: "thr_card",
      url: "/projects/proj_plugins/threads/thr_card",
      silent: true,
    },
  ]);
  await queue.acknowledge(first.lease!.id, [1]);

  // The same thread without its bell stays quiet for lifecycle events.
  await host.harness.behavior.emitThreadEvent("thread.active", {
    thread: makeThreadResponse({
      id: "thr_card",
      projectId: "proj_plugins",
      status: "active",
    }),
  });
  await host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({
      id: "thr_card",
      projectId: "proj_plugins",
      status: "idle",
    }),
    lastAssistantText: "Done.",
  });
  assert.equal(await queue.count(), 0);

  // Explicit sends are one per call — nothing collapses them — and default
  // to the "bb" heading opening the bb home route.
  await host.harness.behavior.callRpc("send", { message: "Again." });
  const second = await queue.lease();
  assert.deepEqual(second.lease?.notifications, [
    {
      id: 2,
      title: "bb",
      body: "Again.",
      threadId: null,
      url: "/",
      silent: true,
    },
  ]);
});

test("an explicit rpc send resolves the project from the thread and still sends when it is gone", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) =>
          ({ name: projectId === "proj_fallback" ? "fallback" : "plugins" }) as never,
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          if (threadId === "thr_gone") throw new Error("thread not found");
          return makeThreadResponse({ id: threadId, projectId: "proj_fallback" });
        },
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  await host.harness.behavior.callRpc("send", {
    message: "Needs review.",
    threadId: "thr_live",
  });
  const live = await queue.lease();
  assert.deepEqual(live.lease?.notifications, [
    {
      id: 1,
      title: "bb",
      body: "[fallback] Needs review.",
      threadId: "thr_live",
      url: "/projects/proj_fallback/threads/thr_live",
      silent: true,
    },
  ]);
  await queue.acknowledge(live.lease!.id, [1]);

  // A deleted thread still sends, opening the bare thread route.
  await host.harness.behavior.callRpc("send", {
    message: "Still here.",
    threadId: "thr_gone",
  });
  const gone = await queue.lease();
  assert.deepEqual(gone.lease?.notifications, [
    {
      id: 2,
      title: "bb",
      body: "Still here.",
      threadId: "thr_gone",
      url: "/threads/thr_gone",
      silent: true,
    },
  ]);
});

test("a focused BB app suppresses an explicit rpc send", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const queue = new NotificationQueue(host.bb.storage.kv);
  await host.harness.behavior.fetchHttp("POST", "/foreground", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId: "desktop-window", foreground: true }),
  });
  assert.deepEqual(
    await host.harness.behavior.callRpc("send", { message: "Blocked?" }),
    { delivery: "skipped" },
  );
  assert.equal(await queue.count(), 0);

  await host.harness.behavior.fetchHttp("POST", "/foreground", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ pageId: "desktop-window", foreground: false }),
  });
  assert.deepEqual(
    await host.harness.behavior.callRpc("send", { message: "Blocked?" }),
    { delivery: "held" },
  );
  assert.equal(await queue.count(), 1);
});

test("the send rpc refuses malformed input", async (context) => {
  const host = createFakePluginHost({
    pluginId: "notify",
    sdk: {
      projects: {
        get: async () => ({ name: "plugins" }) as never,
      },
      threads: {
        events: { list: async () => [] },
      },
    },
  });
  context.after(() => host.harness.lifecycle.dispose());
  await plugin(host.bb);

  const refused = async (input: unknown) => {
    await assert.rejects(
      host.harness.behavior.callRpc("send", input),
      (error: { code?: string }) => error.code === "invalid_input",
    );
  };

  await refused({});
  await refused({ message: "   " });
  await refused({ message: "x", threadId: "not a thread id" });
  await refused({ message: "x", projectId: "proj plug" });
  await refused({ message: "x", extra: 1 });
  await refused({ message: "x", title: null });
  await refused({ message: "x".repeat(4001) });

  // Explicit nulls are accepted and mean "absent".
  const queue = new NotificationQueue(host.bb.storage.kv);
  assert.deepEqual(
    await host.harness.behavior.callRpc("send", {
      message: "Home.",
      projectId: null,
      threadId: null,
    }),
    { delivery: "held" },
  );
  const batch = await queue.lease();
  assert.equal(batch.lease?.notifications[0]!.url, "/");
  assert.equal(batch.lease?.notifications[0]!.title, "bb");
});
