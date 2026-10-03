import { describe, expect, it } from "vitest";
import {
  assistantIdentity,
  homeSegmentUnder,
} from "./assistant-identity";

const FLEET = "/home/me/assistants";
const sources = [
  { hostId: "host_vps", path: FLEET },
  { hostId: "host_mac", path: "/Users/me/assistants" },
  { hostId: "host_wsl", path: "/home/me/assistants" },
];
const env = (
  projectId: string,
  hostId: string,
  path: string | null,
) => ({ projectId, hostId, path });

describe("homeSegmentUnder", () => {
  it("sees the home directly below the root", () => {
    expect(homeSegmentUnder(`${FLEET}/sam`, FLEET)).toBe("sam");
    expect(homeSegmentUnder("/Users/me/assistants/sam", "/Users/me/assistants")).toBe("sam");
  });

  it("ignores trailing slashes on either side", () => {
    expect(homeSegmentUnder(`${FLEET}/sam/`, `${FLEET}/`)).toBe("sam");
  });

  it("refuses the root itself and nested paths", () => {
    expect(homeSegmentUnder(FLEET, FLEET)).toBeNull();
    expect(homeSegmentUnder(`${FLEET}/sam/memory`, FLEET)).toBeNull();
    expect(homeSegmentUnder(`${FLEET}/sam/memory/deep`, FLEET)).toBeNull();
  });

  it("keeps the path boundary: a shared prefix is not the root", () => {
    expect(homeSegmentUnder("/home/me/assistants-x/sam", FLEET)).toBeNull();
    expect(homeSegmentUnder("/home/me/assistants-extra/sam", FLEET)).toBeNull();
  });
});

describe("assistantIdentity", () => {
  it("recognizes the same home on every host of the project", () => {
    for (const { hostId, path } of sources) {
      expect(assistantIdentity(env("proj_fleet", hostId, `${path}/sam`), sources)).toBe(
        "proj_fleet:sam",
      );
    }
  });

  it("keys an unrelated project's sam home under its own project", () => {
    const other = assistantIdentity(
      env("proj_other", "host_mac", "/Users/me/assistants/sam"),
      sources,
    );
    expect(other).toBe("proj_other:sam");
    expect(other).not.toBe("proj_fleet:sam");
  });

  it("does not capture a path outside the host's registered source", () => {
    expect(
      assistantIdentity(env("proj_fleet", "host_vps", "/home/someone/assistants/sam"), sources),
    ).toBeNull();
    expect(
      assistantIdentity(env("proj_fleet", "host_unknown", `${FLEET}/sam`), sources),
    ).toBeNull();
  });

  it("keeps the segment boundary: a longer name is a different assistant", () => {
    expect(assistantIdentity(env("proj_fleet", "host_vps", `${FLEET}/samuel`), sources)).toBe(
      "proj_fleet:samuel",
    );
  });

  it("gives a mishomed environment no identity, without inventing one", () => {
    // A thread parked on the fleet root, and one without a path at all.
    expect(assistantIdentity(env("proj_fleet", "host_vps", FLEET), sources)).toBeNull();
    expect(assistantIdentity(env("proj_fleet", "host_vps", null), sources)).toBeNull();
  });
});
