import { describe, expect, it, vi } from "vitest";
import { fetchZaiUsage, normalizeZaiQuota, ZAI_QUOTA_URL } from "./zai";

const NOW = Date.parse("2026-09-08T10:00:00.000Z");
const at = () => new Date(NOW);

const limit = (overrides: Record<string, unknown>) => ({
  type: "TOKENS_LIMIT",
  unit: 3,
  number: 5,
  percentage: 40,
  usage: null,
  currentValue: null,
  remaining: null,
  nextResetTime: null,
  ...overrides,
});

const quota = (limits: unknown[], extra: Record<string, unknown> = {}) => ({
  success: true,
  code: 200,
  data: { level: "pro", limits, ...extra },
});

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("normalizeZaiQuota", () => {
  it("orders windows 5-hour, weekly, MCP and prefers raw counters over the rounded percentage", () => {
    const result = normalizeZaiQuota(
      quota([
        limit({ type: "TIME_LIMIT", unit: 5, number: 1, percentage: 10, nextResetTime: NOW + 20 * 86_400_000 }),
        limit({ unit: 1, number: 7, percentage: 12, nextResetTime: NOW + 3 * 86_400_000 }),
        limit({ percentage: 40, usage: 1000, remaining: 250, currentValue: 700, nextResetTime: NOW + 3_600_000 }),
        limit({ type: "IGNORED_LIMIT" }),
      ]),
      NOW,
    );

    expect(result.status).toBe("ok");
    expect(result.planLabel).toBe("Pro");
    expect(result.windows).toEqual([
      // used = max(usage - remaining, currentValue) = 750 of 1000, not the reported 40.
      { label: "5-hour", usedPercent: 75, resetsAt: new Date(NOW + 3_600_000).toISOString() },
      { label: "Weekly", usedPercent: 12, resetsAt: new Date(NOW + 3 * 86_400_000).toISOString() },
      { label: "MCP", usedPercent: 10, resetsAt: new Date(NOW + 20 * 86_400_000).toISOString() },
    ]);
  });

  it("drops a 5-hour reset that is more than five hours away but keeps weekly ones", () => {
    const result = normalizeZaiQuota(
      quota([
        limit({ nextResetTime: NOW + 10 * 3_600_000 }),
        limit({ unit: 1, number: 7, nextResetTime: NOW + 10 * 3_600_000 }),
      ]),
      NOW,
    );

    expect(result.windows?.map((window) => window.resetsAt)).toEqual([
      null,
      new Date(NOW + 10 * 3_600_000).toISOString(),
    ]);
  });

  it("clamps a used count above the limit to 100 and negative percentages to 0", () => {
    const result = normalizeZaiQuota(
      quota([limit({ usage: 100, currentValue: 140 }), limit({ unit: 1, number: 7, percentage: -5 })]),
      NOW,
    );

    expect(result.windows?.map((window) => window.usedPercent)).toEqual([100, 0]);
  });

  it("rejects unsuccessful envelopes and malformed limits", () => {
    expect(() => normalizeZaiQuota({ success: false, code: 200, data: { limits: [] } }, NOW)).toThrow();
    expect(() => normalizeZaiQuota(quota([{ type: "TOKENS_LIMIT" }]), NOW)).toThrow();
    expect(() => normalizeZaiQuota(quota([limit({ usage: 12.5 })]), NOW)).toThrow();
    expect(() => normalizeZaiQuota({ success: true, code: 200, data: {} }, NOW)).toThrow();
  });
});

describe("fetchZaiUsage", () => {
  it("reports unauthenticated without a network call when the key is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    expect(await fetchZaiUsage(undefined, fetchImpl, at)).toEqual({ status: "unauthenticated" });
    expect(await fetchZaiUsage("   ", fetchImpl, at)).toEqual({ status: "unauthenticated" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends the key as a bearer token and never leaks it into the result", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(200, quota([limit({})])));

    const result = await fetchZaiUsage(" secret-key ", fetchImpl, at);

    expect(fetchImpl).toHaveBeenCalledWith(
      ZAI_QUOTA_URL,
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer secret-key" }) }),
    );
    expect(result.status).toBe("ok");
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("maps rejected keys to unauthenticated and everything else that fails to error", async () => {
    const responses = [
      jsonResponse(401, {}),
      jsonResponse(500, {}),
      // A revoked key arrives as HTTP 200 with this envelope.
      jsonResponse(200, { code: 1000, msg: "Authentication Failed", success: false }),
      jsonResponse(200, { code: "1000", success: false }),
      jsonResponse(200, { success: false, msg: "  authentication failed  " }),
      // Unrecognized failures stay generic, however plausible they sound.
      jsonResponse(200, { success: false, msg: "invalid api key" }),
      jsonResponse(200, { code: 3000, msg: "Internal Error", success: false }),
      jsonResponse(200, { success: false }),
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () => responses.shift()!);

    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("unauthenticated");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("error");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("unauthenticated");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("unauthenticated");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("unauthenticated");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("error");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("error");
    expect((await fetchZaiUsage("key", fetchImpl, at)).status).toBe("error");

    const offline = vi.fn<typeof fetch>(async () => {
      throw new Error("offline");
    });
    expect((await fetchZaiUsage("key", offline, at)).status).toBe("error");
  });
});
