// @vitest-environment jsdom
import { fireEvent, waitFor, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Machine, rpcContract } from "../contract";
afterEach(cleanup);

it("works without an active thread and switches only the chosen machines", async () => {
  const app = await loadPluginApp(() => import("../app"));
  const machines: Machine[] = ["VPS", "Mac", "WSL", "Offline"].map((name) => ({
    hostId: name,
    name,
    connected: name !== "Offline",
    available: name !== "Offline",
    identity: null,
    issue: name === "Offline" ? "Machine is offline." : null,
    login: null,
  }));
  const slot = renderSlot<{ subPath: string }, typeof rpcContract>(
    app.navPanels[0],
    { subPath: "" },
    {
      context: { projectId: null, threadId: null },
      rpc: {
        list: async () => ({
          machines,
        }),
        start: async ({ hostIds }) =>
          hostIds.map((hostId) => ({
            hostId,
            error: null,
            login: {
              id: hostId,
              phase: "starting",
              url: null,
              message: "Starting...",
              expiresAt: Date.now() + 60_000,
            },
          })),
        submit: async () => {
          throw new Error("not used");
        },
        cancel: async () => {
          throw new Error("not used");
        },
      },
    },
  );
  await waitFor(() =>
    expect(
      slot.getByRole("button", { name: "Switch account on 3 machines" }),
    ).toBeTruthy(),
  );
  expect(
    slot.inspection.rpcCalls.filter((call) => call.method === "start"),
  ).toHaveLength(0);
  expect(slot.queryByLabelText("Personal email")).toBeNull();
  expect(slot.queryByLabelText("Work email")).toBeNull();
  expect(slot.queryByRole("radio")).toBeNull();
  fireEvent.click(slot.getByRole("checkbox", { name: /^Mac / }));
  fireEvent.click(
    slot.getByRole("button", { name: "Switch account on 2 machines" }),
  );
  await waitFor(() =>
    expect(
      slot.inspection.rpcCalls.find((call) => call.method === "start")?.input,
    ).toEqual({ hostIds: ["VPS", "WSL"] }),
  );
  expect(
    (slot.getByRole("checkbox", { name: /Offline/ }) as HTMLInputElement)
      .disabled,
  ).toBe(true);
  slot.lifecycle.unmount();
});
