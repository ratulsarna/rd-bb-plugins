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
