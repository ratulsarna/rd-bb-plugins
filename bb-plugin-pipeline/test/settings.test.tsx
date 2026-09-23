// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PipelineSettingsValues } from "../lib/settings";

const app = await loadPluginApp(() => import("../app"));
const mounted: Array<ReturnType<typeof renderSlot>> = [];
afterEach(() => { while (mounted.length) mounted.pop()!.lifecycle.unmount(); cleanup(); vi.restoreAllMocks(); });
const defaults: PipelineSettingsValues = {
  intake: { providerId: "claude-code", model: "claude-opus-5-5[1m]", reasoningLevel: "high" },
  lead: { providerId: "codex", model: "gpt-6-sol", reasoningLevel: "high" },
  rememberExecution: true, taskLimit: 2, permissionMode: "full", reviewRequestComment: "@codex review",
  autoReviewFollowup: true, notificationsEnabled: true, notifyQuestions: true, notifyFailures: true, notifyReview: true, jevThreshold: .725,
};
type View = { values: PipelineSettingsValues; jevApiKeyConfigured: boolean };
type Update = { values: Partial<PipelineSettingsValues>; jevApiKey?: string | null };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function setup(options: { machinesFail?: boolean; integrationsFail?: boolean } = {}) {
  let view: View = { values: structuredClone(defaults), jevApiKeyConfigured: true };
  const get = vi.fn(async () => structuredClone(view));
  const update = vi.fn(async (input: Update) => {
    view = { values: { ...view.values, ...input.values }, jevApiKeyConfigured: input.jevApiKey === undefined ? view.jevApiKeyConfigured : input.jevApiKey !== null };
    return structuredClone(view);
  });
  const slot = renderSlot(app.navPanels[0]!, { subPath: "settings" }, { rpc: {
    getSettings: get, updateSettings: (input) => update(input as Update),
    settingsMachines: async () => {
      if (options.machinesFail) throw new Error("Machine catalog offline");
      return { machines: [{ id: "first", name: "First machine", status: "connected" }, { id: "second", name: "Second machine", status: "connected" }] };
    },
    integrationStatus: async () => {
      if (options.integrationsFail) throw new Error("Status unavailable");
      return { github: { available: true, detail: "Authenticated" }, jev: { configured: true }, notify: { available: true, detail: "Running" } };
    },
  } });
  mounted.push(slot);
  await screen.findByRole("spinbutton", { name: /Concurrent tasks/ });
  return { slot, get, update, current: () => view, set: (next: View) => { view = next; } };
}
const saveButton = () => screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
function changeLimit(value: string) { fireEvent.change(screen.getByRole("spinbutton", { name: /Concurrent tasks/ }), { target: { value } }); }
function advanced() { fireEvent.click(screen.getByText("Advanced", { selector: "summary" })); }

describe("Pipeline settings page", () => {
  it("keeps dirty choices across realtime refresh and saves only those choices without the secret", async () => {
    const s = await setup();
    expect(s.update).not.toHaveBeenCalled();
    changeLimit("3");
    s.set({ ...s.current(), values: { ...s.current().values, lead: { ...defaults.lead, model: "new-remembered-model" }, notifyFailures: false } });
    await s.slot.behavior.emitRealtime("settings:changed", {});
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Lead" })).getByLabelText("Model")).toHaveProperty("value", "new-remembered-model"));
    expect(screen.getByRole("spinbutton", { name: /Concurrent tasks/ })).toHaveProperty("value", "3");
    fireEvent.click(saveButton());
    await waitFor(() => expect(saveButton().disabled).toBe(true));
    expect(s.update).toHaveBeenCalledExactlyOnceWith({ values: { taskLimit: 3 } });
    expect(s.current().values.lead.model).toBe("new-remembered-model");
  });

  it("locks an in-flight save, preserves a failed draft, and clears a replacement key only after success", async () => {
    const s = await setup(); advanced();
    const key = screen.getByLabelText("TypeSafe API key") as HTMLInputElement;
    expect(key.value).toBe("");
    fireEvent.change(key, { target: { value: "replacement-key" } });
    changeLimit("4");
    const pending = deferred<View>(); s.update.mockImplementationOnce(() => pending.promise);
    fireEvent.click(saveButton());
    expect(saveButton().disabled).toBe(true);
    expect(key.disabled).toBe(true);
    fireEvent.submit(screen.getByRole("form", { name: "Pipeline settings" }));
    expect(s.update).toHaveBeenCalledTimes(1);
    await act(async () => pending.reject(new Error("Write failed")));
    expect(screen.getByText("Write failed")).toBeTruthy();
    expect(key.value).toBe("replacement-key");
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(key.value).toBe(""));
    expect(s.update).toHaveBeenLastCalledWith({ values: { taskLimit: 4 }, jevApiKey: "replacement-key" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Clear saved key" }));
    fireEvent.click(saveButton());
    await waitFor(() => expect(s.current().jevApiKeyConfigured).toBe(false));
    expect(s.update).toHaveBeenLastCalledWith({ values: {}, jevApiKey: null });
  });

  it("ignores a stale settings read completing after a successful save", async () => {
    const s = await setup();
    const stale = deferred<View>(); s.get.mockImplementationOnce(() => stale.promise);
    await s.slot.behavior.emitRealtime("settings:changed", {});
    changeLimit("5"); fireEvent.click(saveButton());
    await screen.findByText("Saved", { selector: "[role=status]" });
    await act(async () => stale.resolve({ values: defaults, jevApiKeyConfigured: false }));
    expect(screen.getByRole("spinbutton", { name: /Concurrent tasks/ })).toHaveProperty("value", "5");
    advanced(); expect(screen.getByText("Key configured")).toBeTruthy();
  });

  it("routes each picker to the chosen catalog and saves role selections and automatic-review intent", async () => {
    const s = await setup();
    const lead = within(screen.getByRole("group", { name: "Lead" }));
    expect(lead.getByTestId("bb-provider-model-picker").getAttribute("data-routing-id")).toBe("first");
    fireEvent.change(screen.getByRole("combobox", { name: "Model catalog" }), { target: { value: "second" } });
    expect(lead.getByTestId("bb-provider-model-picker").getAttribute("data-routing-id")).toBe("second");
    fireEvent.change(lead.getByLabelText("Model"), { target: { value: "chosen-model" } });
    fireEvent.change(lead.getByLabelText("Reasoning level"), { target: { value: "max" } });
    fireEvent.change(lead.getByLabelText("Service tier"), { target: { value: "fast" } });
    fireEvent.click(lead.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Request review" }), { target: { value: "automatic" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(s.update).toHaveBeenCalledExactlyOnceWith({ values: { lead: { ...defaults.lead, model: "chosen-model", reasoningLevel: "max", serviceTier: "fast" }, reviewRequestComment: "" } }));
  });

  it("allows other preferences when discovery fails, rejects invalid numbers and blank review requests", async () => {
    const s = await setup({ machinesFail: true, integrationsFail: true });
    await screen.findByText(/Machine catalog offline/);
    expect(screen.queryByTestId("bb-provider-model-picker")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Remember last task’s choices" }));
    changeLimit("0"); expect(saveButton().disabled).toBe(true);
    changeLimit("1.5"); expect(saveButton().disabled).toBe(true);
    changeLimit("32"); expect(saveButton().disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Review request comment" }), { target: { value: " " } });
    expect(saveButton().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Review request comment" }), { target: { value: "@reviewer review" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(s.update).toHaveBeenCalledExactlyOnceWith({ values: { rememberExecution: false, taskLimit: 32, reviewRequestComment: "@reviewer review" } }));
  });

  it("uses the plugin settings link and Back to tasks without mounting a duplicate form", async () => {
    const slot = renderSlot(app.settingsSections[0]!, {}, {}); mounted.push(slot);
    expect(screen.queryByRole("form")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Pipeline settings" }));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "board", options: { subPath: "settings" } }]);
    slot.lifecycle.unmount(); mounted.pop();
    const s = await setup();
    fireEvent.click(screen.getByRole("button", { name: "Back to tasks" }));
    expect(s.slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "board", options: undefined }]);
  });
});
