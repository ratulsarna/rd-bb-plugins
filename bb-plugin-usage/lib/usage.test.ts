import { describe, expect, it, vi } from "vitest";
import {
  createUsageService,
  fetchUsageLimits,
  normalizeUsage,
  remainingPercent,
  type RawUsageResponse,
} from "./usage";

const rawUsage = (): RawUsageResponse => ({
  codex: {
    status: "ok",
    accountEmail: "codex@example.com",
    planLabel: "Pro",
    windows: [
      {
        label: "Current session",
        usedPercent: 40,
        resetsAt: "2026-08-09T12:00:00.000Z",
      },
    ],
  },
  claudeCode: {
    status: "ok",
    accountEmail: "claude@example.com",
    planLabel: "Max",
    windows: [
      {
        label: "Sonnet",
        usedPercent: 25,
        resetsAt: "2026-08-15T12:00:00.000Z",
      },
    ],
  },
});

const expiredClaudeUsage = (): RawUsageResponse => ({
  ...rawUsage(),
  claudeCode: { status: "expired" },
});

describe("remainingPercent", () => {
  it("reverses used values, rounds, and clamps every non-finite boundary", () => {
    expect(remainingPercent(23.6)).toBe(76);
    expect(remainingPercent(-20)).toBe(100);
    expect(remainingPercent(150)).toBe(0);
    expect(remainingPercent(Number.POSITIVE_INFINITY)).toBe(0);
    expect(remainingPercent(Number.NEGATIVE_INFINITY)).toBe(100);
    expect(remainingPercent(Number.NaN)).toBe(0);
  });
});

describe("normalizeUsage", () => {
  it("whitelists providers and strips cursor, cost, and raw errors", () => {
    const raw = {
      ...rawUsage(),
      cursor: { status: "ok", accountEmail: "cursor@example.com" },
      codex: {
        ...rawUsage().codex,
        windows: [
          {
            ...rawUsage().codex.windows![0]!,
            cost: { usedUsdCents: 12_00, limitUsdCents: 20_00 },
          },
        ],
      },
      claudeCode: {
        status: "error",
        message: "private provider failure",
        accountEmail: "claude@example.com",
        planLabel: "Max",
      },
    };

    const result = normalizeUsage(
      raw,
      () => new Date("2026-08-09T09:30:00.000Z"),
    );
    expect(Object.keys(result.providers)).toEqual(["codex", "claudeCode"]);
    expect(result.providers.codex.windows[0]).toEqual({
      label: "Current session",
      remainingPercent: 60,
      resetsAt: "2026-08-09T12:00:00.000Z",
      pace: { kind: "reserve", percentage: 10 },
    });
    expect(result.providers.claudeCode).toMatchObject({
      status: "error",
      accountEmail: "claude@example.com",
      planLabel: "Max",
      windows: [],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /cursor|cost|usedUsdCents|private provider failure/,
    );
  });

  it("isolates provider failures and nulls malformed reset times", () => {
    const raw = rawUsage();
    raw.codex = { status: "unauthenticated" };
    raw.claudeCode.windows![0]!.resetsAt = "tomorrow-ish";

    const result = normalizeUsage(
      raw,
      () => new Date("2026-08-09T09:30:00.000Z"),
    );
    expect(result.providers.codex).toMatchObject({
      status: "unauthenticated",
      accountEmail: null,
      planLabel: null,
      windows: [],
    });
    expect(result.providers.claudeCode.windows[0]).toMatchObject({
      resetsAt: null,
      pace: null,
    });
  });
});

describe("fetchUsageLimits", () => {
  it("passes only an injected 35-second abort signal", async () => {
    const signal = new AbortController().signal;
    const timeoutSignal = vi.fn(() => signal);
    const usageLimits = vi.fn(async () => rawUsage());

    await fetchUsageLimits(usageLimits, timeoutSignal);

    expect(timeoutSignal).toHaveBeenCalledWith(35_000);
    expect(usageLimits).toHaveBeenCalledWith({ signal });
  });
});

describe("createUsageService", () => {
  it("shares an in-flight request and publishes once when a refresh joins it", async () => {
    let resolveFetch!: (value: RawUsageResponse) => void;
    const fetchUsage = vi.fn(
      () =>
        new Promise<RawUsageResponse>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const publishUsageUpdated = vi.fn();
    const service = createUsageService({
      fetchUsage,
      publishUsageUpdated,
      clock: () => new Date("2026-08-09T09:30:00.000Z"),
    });

    const bodyRead = service.getUsage({});
    const headerRefresh = service.getUsage({ refresh: true });
    expect(headerRefresh).toBe(bodyRead);
    expect(fetchUsage).toHaveBeenCalledTimes(1);

    resolveFetch(rawUsage());
    const result = await bodyRead;
    expect(await headerRefresh).toBe(result);
    expect(publishUsageUpdated).toHaveBeenCalledTimes(1);
    expect(publishUsageUpdated).toHaveBeenCalledWith({
      fetchedAt: result.fetchedAt,
    });
  });

  it("caches settled reads for 60 seconds and refresh bypasses that cache", async () => {
    let nowMs = Date.parse("2026-08-09T09:30:00.000Z");
    const fetchUsage = vi.fn(async () => rawUsage());
    const publishUsageUpdated = vi.fn();
    const service = createUsageService({
      fetchUsage,
      publishUsageUpdated,
      clock: () => new Date(nowMs),
    });

    const initial = await service.getUsage({});
    nowMs += 59_999;
    expect(await service.getUsage({})).toBe(initial);
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(publishUsageUpdated).not.toHaveBeenCalled();

    const refreshed = await service.getUsage({ refresh: true });
    expect(refreshed).not.toBe(initial);
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(publishUsageUpdated).toHaveBeenCalledWith({
      fetchedAt: refreshed.fetchedAt,
    });

    nowMs += 60_000;
    await service.getUsage({});
    expect(fetchUsage).toHaveBeenCalledTimes(3);
  });

  it("recovers an expired Claude session once, then returns the retry", async () => {
    const fetchUsage = vi
      .fn<() => Promise<RawUsageResponse>>()
      .mockResolvedValueOnce(expiredClaudeUsage())
      .mockResolvedValueOnce(rawUsage());
    const recoverClaudeCredentials = vi.fn(async () => undefined);
    const publishUsageUpdated = vi.fn();
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials,
      publishUsageUpdated,
    });

    const result = await service.getUsage({ refresh: true });

    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(recoverClaudeCredentials).toHaveBeenCalledTimes(1);
    expect(result.providers.claudeCode.status).toBe("ok");
    expect(publishUsageUpdated).toHaveBeenCalledTimes(1);
  });

  it("does not recover healthy Claude usage", async () => {
    const fetchUsage = vi.fn(async () => rawUsage());
    const recoverClaudeCredentials = vi.fn(async () => undefined);
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials,
      publishUsageUpdated: vi.fn(),
    });

    await service.getUsage({ refresh: true });

    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(recoverClaudeCredentials).not.toHaveBeenCalled();
  });

  it("does not recover expired Claude usage on an ordinary read", async () => {
    const fetchUsage = vi.fn(async () => expiredClaudeUsage());
    const recoverClaudeCredentials = vi.fn(async () => undefined);
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials,
      publishUsageUpdated: vi.fn(),
    });

    const result = await service.getUsage({});

    expect(result.providers.claudeCode.status).toBe("expired");
    expect(fetchUsage).toHaveBeenCalledTimes(1);
    expect(recoverClaudeCredentials).not.toHaveBeenCalled();
  });

  it("upgrades an ordinary in-flight read to one recovery and one retry", async () => {
    let resolveFirstFetch!: (value: RawUsageResponse) => void;
    const fetchUsage = vi
      .fn<() => Promise<RawUsageResponse>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstFetch = resolve;
          }),
      )
      .mockResolvedValueOnce(rawUsage());
    const recoverClaudeCredentials = vi.fn(async () => undefined);
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials,
      publishUsageUpdated: vi.fn(),
    });

    const ordinary = service.getUsage({});
    const firstRefresh = service.getUsage({ refresh: true });
    const secondRefresh = service.getUsage({ refresh: true });
    expect(firstRefresh).toBe(ordinary);
    expect(secondRefresh).toBe(ordinary);

    resolveFirstFetch(expiredClaudeUsage());
    const result = await ordinary;

    expect(result.providers.claudeCode.status).toBe("ok");
    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(recoverClaudeCredentials).toHaveBeenCalledTimes(1);
  });

  it("keeps a healthy cache when recovery and retry leave Claude expired", async () => {
    const fetchUsage = vi
      .fn<() => Promise<RawUsageResponse>>()
      .mockResolvedValueOnce(rawUsage())
      .mockResolvedValueOnce(expiredClaudeUsage())
      .mockResolvedValueOnce(expiredClaudeUsage())
      .mockResolvedValueOnce(rawUsage());
    const recoverClaudeCredentials = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("probe failed"));
    const publishUsageUpdated = vi.fn();
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials,
      publishUsageUpdated,
    });

    const healthy = await service.getUsage({});
    await expect(service.getUsage({ refresh: true })).rejects.toThrow(
      "Claude Code usage refresh failed",
    );
    expect(await service.getUsage({})).toBe(healthy);
    expect(publishUsageUpdated).not.toHaveBeenCalled();

    await expect(service.getUsage({ refresh: true })).resolves.toMatchObject({
      providers: { claudeCode: { status: "ok" } },
    });
  });

  it("returns Codex data when recovery cannot restore Claude and no cache exists", async () => {
    const retry = expiredClaudeUsage();
    retry.codex.windows![0]!.usedPercent = 12;
    const fetchUsage = vi
      .fn<() => Promise<RawUsageResponse>>()
      .mockResolvedValueOnce(expiredClaudeUsage())
      .mockResolvedValueOnce(retry);
    const service = createUsageService({
      fetchUsage,
      recoverClaudeCredentials: vi.fn(async () => {
        throw new Error("unavailable");
      }),
      publishUsageUpdated: vi.fn(),
    });

    const result = await service.getUsage({ refresh: true });

    expect(result.providers.codex.windows[0]?.remainingPercent).toBe(88);
    expect(result.providers.claudeCode.status).toBe("expired");
  });

  it("does not cache or publish a rejected request", async () => {
    const fetchUsage = vi
      .fn<() => Promise<RawUsageResponse>>()
      .mockRejectedValueOnce(new Error("transport failed"))
      .mockResolvedValueOnce(rawUsage());
    const publishUsageUpdated = vi.fn();
    const service = createUsageService({ fetchUsage, publishUsageUpdated });

    await expect(service.getUsage({ refresh: true })).rejects.toThrow(
      "transport failed",
    );
    await service.getUsage({});

    expect(fetchUsage).toHaveBeenCalledTimes(2);
    expect(publishUsageUpdated).not.toHaveBeenCalled();
  });
});
