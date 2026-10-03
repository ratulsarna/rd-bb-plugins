import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Coordinator } from "../lib/coordinator";
import {
  cleanup,
  folderOf,
  hostClient,
  machine,
  openStore,
  put,
  startCoordinator,
  tempDir,
} from "./helpers";

let base: string;
let stops: (() => Promise<void>)[];
beforeEach(async () => {
  base = await tempDir();
  stops = [];
});
afterEach(async () => {
  for (const stop of stops) await stop();
  await cleanup(base);
});
async function until(check: () => boolean) {
  for (let i = 0; i < 400; i += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for test transition");
}
const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("sync barriers", () => {
  it("rejects a later target's disconnect while an earlier target scan is held, even if it reconnects", async () => {
    const a = await machine(base, "host-a");
    const b = await machine(base, "host-b");
    const machines = [a, b];
    await put(a, "keep.txt", "keep");
    const run = startCoordinator(
      openStore(join(base, "hub.db")),
      machines,
      [folderOf(machines)],
      { pruneMs: 1 },
    );
    stops.push(run.stop);
    await run.coordinator.sync("notes");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scanning = false;
    a.before = async (method) => {
      if (method !== "scan") return;
      scanning = true;
      await held;
    };
    const barrier = run.coordinator.sync("notes", [a.id, b.id]).then(
      () => new Error("Barrier unexpectedly succeeded"),
      (error: unknown) => error,
    );
    try {
      await until(() => scanning);
      await delay(30);
      b.online = false;
      await until(
        () =>
          run.coordinator.status().folders[0]!.nodes[1]!.phase === "offline",
      );
      const result = await Promise.race([
        barrier,
        delay(100).then(() => new Error("Barrier ignored offline target")),
      ]);
      expect(result).toMatchObject({ message: `Machine ${b.id} went offline` });
      b.online = true;
      await until(() => run.coordinator.isOnline(b.id));
      expect(await barrier).toBe(result);
    } finally {
      b.online = true;
      a.before = undefined;
      release();
    }
    expect(
      (await run.coordinator.sync("notes")).nodes.every((node) => node.ready),
    ).toBe(true);
  });

  it("times out during the first connectivity poll and never queues an expired request's scan", async () => {
    const a = await machine(base, "host-a");
    await put(a, "keep.txt", "keep");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let scans = 0;
    a.before = (method) => {
      if (method === "scan") scans += 1;
    };
    const coordinator = new Coordinator({
      store: openStore(join(base, "hub.db")),
      host: hostClient([a]),
      listHosts: async () => {
        await held;
        return [{ id: a.id, status: "connected" }];
      },
      log: () => {},
      onStatusChange: () => {},
      timings: { pollMs: 10, retryMs: 10 },
    });
    // An expired request can coalesce with startup's scan; count request starts too.
    const ticks = vi.spyOn(coordinator, "tick");
    const controller = new AbortController();
    coordinator.apply({
      enabled: true,
      paused: false,
      configError: null,
      folders: [folderOf([a])],
    });
    const running = coordinator.run(controller.signal);
    stops.push(async () => {
      release();
      controller.abort();
      await running;
    });
    const barrier = coordinator.sync("notes", [a.id], 25).then(
      () => new Error("Barrier unexpectedly succeeded"),
      (error: unknown) => error,
    );
    try {
      expect(
        await Promise.race([
          barrier,
          delay(100).then(() => new Error("Deadline excluded connectivity")),
        ]),
      ).toMatchObject({ message: "Timed out waiting for sync" });
      expect(scans).toBe(0);
    } finally {
      release();
    }
    await until(() => coordinator.status().folders[0]!.nodes[0]!.ready);
    await delay(30);
    expect(scans).toBe(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(await barrier).toMatchObject({
      message: "Timed out waiting for sync",
    });
    expect(
      (await coordinator.sync("notes", [a.id], 1000)).nodes[0]!.ready,
    ).toBe(true);
    expect(scans).toBe(2);
  });
});
