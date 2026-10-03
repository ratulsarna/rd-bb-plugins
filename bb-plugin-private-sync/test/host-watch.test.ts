import type { ExperimentalHostWatchListener } from "@get-bb/plugin-sdk";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { describe, expect, it } from "vitest";
import { createHostEntry } from "../host";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const folder = (root = "/test/notes") => ({
  folderId: "notes",
  root,
  ignorePaths: [],
});
const changed = {
  kind: "changed",
  changes: [{ path: "doc.md", type: "update" }],
} as const;

describe("host watch ownership through the SDK harness", () => {
  it("coalesces overlapping requests while a native subscription is being created", async () => {
    const entered = deferred();
    const release = deferred();
    const listeners = new Set<ExperimentalHostWatchListener>();
    let creations = 0;
    let disposals = 0;
    const host = experimental_createHostEntryHarness(createHostEntry(), {
      experimental_watch: async (_options, listener) => {
        creations += 1;
        entered.resolve();
        await release.promise;
        listeners.add(listener);
        return {
          dispose: async () => {
            disposals += 1;
            listeners.delete(listener);
          },
        };
      },
    });
    try {
      const first = host.experimental_call("watch", { folders: [folder()] });
      await entered.promise;
      const second = host.experimental_call("watch", { folders: [folder()] });
      await new Promise(setImmediate);
      release.resolve();
      expect(await Promise.all([first, second])).toEqual([
        { watching: 1 },
        { watching: 1 },
      ]);
      expect(creations).toBe(1);
      expect(listeners.size).toBe(1);
      await Promise.all([...listeners].map((listener) => listener(changed)));
      expect(host.experimental_getSignals()).toHaveLength(1);
      expect(await host.experimental_call("watch", { folders: [] })).toEqual({
        watching: 0,
      });
      expect(listeners.size).toBe(0);
      expect(disposals).toBe(1);
    } finally {
      release.resolve();
      await host.experimental_dispose();
    }
  });

  it("orders reconfigure and clear behind subscription disposal and suppresses retiring callbacks", async () => {
    const disposing = deferred();
    const release = deferred();
    const listeners: ExperimentalHostWatchListener[] = [];
    const live = new Set<string>();
    const disposed: string[] = [];
    const host = experimental_createHostEntryHarness(createHostEntry(), {
      experimental_watch: async ({ rootPath }, listener) => {
        listeners.push(listener);
        live.add(rootPath);
        return {
          dispose: async () => {
            if (rootPath === "/test/old") {
              disposing.resolve();
              await release.promise;
            }
            live.delete(rootPath);
            disposed.push(rootPath);
          },
        };
      },
    });
    try {
      await host.experimental_call("watch", { folders: [folder("/test/old")] });
      const configure = host.experimental_call("watch", {
        folders: [folder("/test/new")],
      });
      await disposing.promise;
      const clear = host.experimental_call("watch", { folders: [] });
      const newest = host.experimental_call("watch", {
        folders: [folder("/test/newest")],
      });
      await new Promise(setImmediate);
      await listeners[0]!(changed);
      expect(host.experimental_getSignals()).toHaveLength(0);
      release.resolve();
      expect(await Promise.all([configure, clear, newest])).toEqual([
        { watching: 1 },
        { watching: 0 },
        { watching: 1 },
      ]);
      expect([...live]).toEqual(["/test/newest"]);
      expect(disposed).toEqual(["/test/old", "/test/new"]);
      await Promise.all(listeners.map((listener) => listener(changed)));
      expect(host.experimental_getSignals()).toHaveLength(1);
    } finally {
      release.resolve();
      await host.experimental_dispose();
    }
    expect(live.size).toBe(0);
    expect(disposed).toEqual(["/test/old", "/test/new", "/test/newest"]);
  });

  it("drains a late subscription and queued configure calls when the host is disposed", async () => {
    const entered = deferred();
    const release = deferred();
    let creates = 0;
    let live = 0;
    let disposes = 0;
    let listener!: ExperimentalHostWatchListener;
    const host = experimental_createHostEntryHarness(createHostEntry(), {
      experimental_watch: async (_options, callback) => {
        creates += 1;
        listener = callback;
        entered.resolve();
        await release.promise;
        live += 1;
        return {
          dispose: async () => {
            live -= 1;
            disposes += 1;
          },
        };
      },
    });
    const pending = host.experimental_call("watch", { folders: [folder()] });
    await entered.promise;
    const queued = host.experimental_call("watch", {
      folders: [folder("/test/new")],
    });
    await new Promise(setImmediate);
    const stopped = host.experimental_dispose();
    release.resolve();
    await Promise.all([pending, queued, stopped]);
    expect({ creates, live, disposes }).toEqual({
      creates: 1,
      live: 0,
      disposes: 1,
    });
    await listener(changed);
    expect(host.experimental_getSignals()).toHaveLength(0);
  });

  it("does not install a cancelled generation's late subscription", async () => {
    const entered = deferred();
    const release = deferred();
    let creates = 0;
    let live = 0;
    const host = experimental_createHostEntryHarness(createHostEntry(), {
      experimental_watch: async () => {
        creates += 1;
        if (creates === 1) {
          entered.resolve();
          await release.promise;
        }
        live += 1;
        return {
          dispose: async () => {
            live -= 1;
          },
        };
      },
    });
    try {
      const controller = new AbortController();
      const cancelled = host.experimental_call(
        "watch",
        { folders: [folder()] },
        { signal: controller.signal },
      );
      await entered.promise;
      controller.abort();
      const replacement = host.experimental_call("watch", {
        folders: [folder("/test/new")],
      });
      release.resolve();
      expect(await cancelled).toEqual({ watching: 0 });
      expect(await replacement).toEqual({ watching: 1 });
      expect(live).toBe(1);
    } finally {
      release.resolve();
      await host.experimental_dispose();
    }
    expect(live).toBe(0);
  });
});
