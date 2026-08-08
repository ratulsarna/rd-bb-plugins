import { describe, expect, it } from "vitest";
import { shouldRefreshOnReconnect } from "./reconnect";

describe("shouldRefreshOnReconnect", () => {
  it("refreshes only when a reconnect returns to connected", () => {
    expect(shouldRefreshOnReconnect("connecting", "connected")).toBe(false);
    expect(shouldRefreshOnReconnect("connected", "reconnecting")).toBe(false);
    expect(shouldRefreshOnReconnect("reconnecting", "reconnecting")).toBe(
      false,
    );
    expect(shouldRefreshOnReconnect("connected", "connected")).toBe(false);
    expect(shouldRefreshOnReconnect("reconnecting", "connected")).toBe(true);
  });
});
