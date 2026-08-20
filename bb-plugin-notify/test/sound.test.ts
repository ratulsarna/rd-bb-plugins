import assert from "node:assert/strict";
import { test } from "node:test";
import {
  playSound,
  resolveSound,
  SOUND_NAMES,
  SOUND_OFF,
  SOUND_OPTIONS,
  SOUND_SYSTEM,
} from "../sound.ts";

test("the settings dropdown offers off, system, then the tones", () => {
  assert.equal(SOUND_OPTIONS[0], SOUND_OFF);
  assert.equal(SOUND_OPTIONS[1], SOUND_SYSTEM);
  assert.deepEqual([...SOUND_OPTIONS].slice(2), [...SOUND_NAMES]);
  assert.equal(new Set(SOUND_OPTIONS).size, SOUND_OPTIONS.length);
});

test("resolveSound maps the three kinds of choice", () => {
  assert.deepEqual(resolveSound(SOUND_OFF, true), {
    desktopSilent: true,
    pushSilent: true,
    play: null,
  });
  assert.deepEqual(resolveSound(SOUND_SYSTEM, true), {
    desktopSilent: false,
    pushSilent: false,
    play: null,
  });
  // A named tone silences the notification so macOS does not stack its own
  // default underneath the chosen one. Web Push still uses its default sound.
  assert.deepEqual(resolveSound("Ping", true), {
    desktopSilent: true,
    pushSilent: false,
    play: "Ping",
  });
});

test("a named tone falls back to each device's default off macOS", () => {
  assert.deepEqual(resolveSound("Ping", false), {
    desktopSilent: false,
    pushSilent: false,
    play: null,
  });
});

test("resolveSound falls back to silent for a value that is not on the list", () => {
  const silent = { desktopSilent: true, pushSilent: true, play: null };
  assert.deepEqual(resolveSound("Nonesuch", true), silent);
  assert.deepEqual(resolveSound("", true), silent);
  // Case matters: the name is matched, never normalised into a path.
  assert.deepEqual(resolveSound("ping", true), silent);
});

test("every listed tone resolves to itself", () => {
  for (const name of SOUND_NAMES) {
    assert.deepEqual(resolveSound(name, true), {
      desktopSilent: true,
      pushSilent: false,
      play: name,
    });
  }
});

test("playSound ignores a name that is not on the list", async () => {
  // The guard is what keeps a settings string out of the filesystem, so these
  // must return without touching disk rather than throwing.
  await playSound("Ping; rm -rf /");
  await playSound("../../../bin/sh");
  await playSound("");
});
