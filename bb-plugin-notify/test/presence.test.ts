import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FOREGROUND_PRESENCE_TTL_MS,
  ForegroundPresence,
  InvalidPresenceError,
} from "../presence.ts";

test("presence stays active until every page leaves or expires", () => {
  let now = 1_000;
  const presence = new ForegroundPresence(() => now);

  assert.equal(presence.update("desktop", true), true);
  assert.equal(presence.update("pwa", true), true);
  assert.equal(presence.update("desktop", false), true);
  assert.equal(presence.count(), 1);

  now += FOREGROUND_PRESENCE_TTL_MS;
  assert.equal(presence.isForeground(), false);
  assert.equal(presence.count(), 0);
});

test("foreground presence rejects malformed page state", () => {
  const presence = new ForegroundPresence();

  assert.throws(() => presence.update("", true), InvalidPresenceError);
  assert.throws(() => presence.update("page", "yes"), InvalidPresenceError);
});
