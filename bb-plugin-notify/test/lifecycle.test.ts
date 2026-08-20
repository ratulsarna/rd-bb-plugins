import assert from "node:assert/strict";
import { test } from "node:test";
import { latestRunWasManuallyStopped } from "../lifecycle.ts";

interface Event {
  seq: number;
  type: string;
  data: unknown;
}

function event(seq: number, type: string, data: unknown = {}): Event {
  return { seq, type, data };
}

function list(events: Event[]) {
  return async ({
    limit,
    order,
    types,
  }: {
    limit: string;
    order: "desc";
    types: readonly string[];
  }) => {
    assert.equal(order, "desc");
    return events
      .filter((item) => types.includes(item.type))
      .sort((left, right) => right.seq - left.seq)
      .slice(0, Number(limit));
  };
}

test("manual stop of the latest run suppresses its idle notification", async () => {
  const stopped = await latestRunWasManuallyStopped(
    list([
      event(1, "client/turn/requested"),
      event(2, "turn/started"),
      event(3, "system/thread/interrupted", { reason: "manual-stop" }),
    ]),
  );

  assert.equal(stopped, true);
});

test("an old manual stop does not suppress a later completed run", async () => {
  const stopped = await latestRunWasManuallyStopped(
    list([
      event(1, "client/turn/requested"),
      event(2, "system/thread/interrupted", { reason: "manual-stop" }),
      // A provider start is also a run boundary, even if an older log does not
      // contain the corresponding client request event.
      event(3, "turn/started"),
      event(4, "turn/completed", { status: "completed" }),
    ]),
  );

  assert.equal(stopped, false);
});

test("non-manual interruptions do not suppress notifications", async () => {
  for (const reason of ["host-daemon-restarted", "provider-turn-idle"]) {
    const stopped = await latestRunWasManuallyStopped(
      list([event(1, "client/turn/requested"), event(2, "system/thread/interrupted", { reason })]),
    );
    assert.equal(stopped, false, reason);
  }
});

test("only the newest relevant lifecycle event is requested", async () => {
  let requests = 0;
  const stopped = await latestRunWasManuallyStopped(async (args) => {
    requests += 1;
    assert.deepEqual(args, {
      limit: "1",
      order: "desc",
      types: ["client/turn/requested", "turn/started", "system/thread/interrupted"],
    });
    return [event(9_999, "system/thread/interrupted", { reason: "manual-stop" })];
  });

  assert.equal(stopped, true);
  assert.equal(requests, 1);
});
