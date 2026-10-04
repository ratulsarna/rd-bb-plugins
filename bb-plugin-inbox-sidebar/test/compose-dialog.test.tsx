// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ComposeDialog } from "../components/compose-dialog";
import { configureFakeSdk, lastComposerProps, navigateCalls, pendingRpc, resolvePendingRpc, rpcCalls } from "./sdk-fake";

const machines = [
  { hostId: "srv", name: "Server", connected: true, assistantsRoot: "/srv/assistants", vaultPath: "/srv/vault", ready: true, reason: null },
  { hostId: "mac", name: "Mac", connected: true, assistantsRoot: "/Users/me/assistants", vaultPath: "/Users/me/vault", ready: true, reason: null },
];
const seeds = {
  title: "Sam", projectId: "fleet", environmentId: "env-old", sourceHostId: "srv", machines,
  identity: "fleet:sam", vaultPath: "/srv/vault", providerId: "retired-provider", model: "retired-model", reasoningLevel: "high", permissionMode: "full", serviceTier: "priority",
  homePath: "/srv/assistants/sam", homes: [{ name: "sam", path: "/srv/assistants/sam" }],
};
function destination(hostId: "srv" | "mac", providerAvailable = true) {
  const machine = machines.find((machine) => machine.hostId === hostId)!;
  const homePath = `${machine.assistantsRoot}/sam`;
  return { hostId, identity: "fleet:sam", homePath, vaultPath: machine.vaultPath, homes: [{ name: "sam", path: homePath }], ready: true, reason: null, providerAvailable };
}
beforeEach(() => configureFakeSdk({
  assistantSeeds: { old: seeds }, assistantDestinations: { srv: destination("srv"), mac: destination("mac", false) },
}));
afterEach(cleanup);

it("submits the edited composition, not the seeds", async () => {
  const onClose = vi.fn();
  render(<ComposeDialog replaceThreadId="old" onClose={onClose} onNavigate={() => {}} />);
  const prompt = await screen.findByRole("textbox", { name: "Prompt" });
  const draftKey = lastComposerProps!.draftKey;
  fireEvent.change(prompt, { target: { value: "Use my edited context, not the initial prompt" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Provider" }), { target: { value: "pi" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "edited-model" } });
  expect(lastComposerProps!.draftKey).toBe(draftKey);
  fireEvent.click(screen.getByRole("button", { name: "Send conversation" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(rpcCalls.find((call) => call.method === "createReplacementThread")?.input).toMatchObject({
    destinationHostId: "srv", homePath: "/srv/assistants/sam",
    request: { providerId: "pi", model: "edited-model", input: [{ type: "text", text: "Use my edited context, not the initial prompt", mentions: [] }] },
  });
});

it.each(["machine", "source"])("still changes the composer draft and seeds when the %s changes", async (change) => {
  configureFakeSdk({
    assistantSeeds: { old: seeds, other: { ...seeds, title: "Forge" } },
    assistantDestinations: { srv: destination("srv"), mac: destination("mac", false) },
  });
  const view = render(<ComposeDialog replaceThreadId="old" onClose={() => {}} onNavigate={() => {}} />);
  const prompt = await screen.findByRole("textbox", { name: "Prompt" });
  fireEvent.change(prompt, { target: { value: "Old destination draft" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Provider" }), { target: { value: "pi" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "edited-model" } });
  if (change === "machine") {
    fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "mac" } });
  } else {
    view.rerender(<ComposeDialog replaceThreadId="other" onClose={() => {}} onNavigate={() => {}} />);
  }
  const nextPrompt = await screen.findByRole("textbox", { name: "Prompt" });
  expect(nextPrompt).not.toBe(prompt);
  expect((nextPrompt as HTMLTextAreaElement).value).not.toBe("Old destination draft");
  expect((screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe(change === "machine" ? "destination-model" : "retired-model");
  fireEvent.click(screen.getByRole("button", { name: "Send conversation" }));
  await waitFor(() => expect(rpcCalls.some((call) => call.method === "createReplacementThread")).toBe(true));
  expect(rpcCalls.find((call) => call.method === "createReplacementThread")?.input).toMatchObject({
    replaceThreadId: change === "machine" ? "old" : "other",
    destinationHostId: change === "machine" ? "mac" : "srv",
  });
});

it("selects the destination machine/home/vault and submits without the original host", async () => {
  const onClose = vi.fn();
  configureFakeSdk({
    assistantSeeds: { old: seeds }, assistantDestinations: { srv: destination("srv"), mac: destination("mac", false) },
    composerRequest: {
      projectId: "fleet", providerId: "codex", model: "destination-model", permissionMode: "full", reasoningLevel: "high", executionInputSources: {},
      environment: { type: "reuse", environmentId: "env-old" }, input: [{ type: "text", text: "Hello", mentions: [] }],
    },
  });
  render(<ComposeDialog replaceThreadId="old" onClose={onClose} onNavigate={() => {}} />);
  await screen.findByRole("button", { name: "Send conversation" });
  expect(lastComposerProps?.defaultModel).toBe("retired-model");
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "mac" } });
  await waitFor(() => expect((screen.getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe("/Users/me/assistants/sam"));
  expect(screen.getByText("Vault: /Users/me/vault")).toBeTruthy();
  expect(lastComposerProps?.defaultEnvironment).toEqual({ type: "host", hostId: "mac", workspace: { type: "unmanaged", path: "/Users/me/assistants/sam" } });
  expect(lastComposerProps?.defaultProviderId).toBeUndefined();
  expect(lastComposerProps?.defaultModel).toBeUndefined();
  expect(lastComposerProps?.defaultPermissionMode).toBe("full");
  expect(lastComposerProps?.initialPrompt).toContain("- /Users/me/vault/Notes/Dated/");
  expect(lastComposerProps?.initialPrompt).not.toContain("/srv/vault");
  fireEvent.click(screen.getByRole("button", { name: "Send conversation" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(rpcCalls.find((call) => call.method === "createReplacementThread")?.input).toMatchObject({ destinationHostId: "mac", homePath: "/Users/me/assistants/sam", request: { environment: { type: "reuse", environmentId: "env-old" } } });
  expect(navigateCalls).toEqual([{ method: "toThread", arg: "new-conversation" }]);
});

it("does not submit a stale target when machine responses arrive out of order", async () => {
  configureFakeSdk({ assistantSeeds: { old: seeds }, deferRpc: ["assistantDestination"] });
  render(<ComposeDialog replaceThreadId="old" onClose={() => {}} onNavigate={() => {}} />);
  await waitFor(() => expect(pendingRpc).toHaveLength(1));
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "mac" } });
  await waitFor(() => expect(pendingRpc).toHaveLength(2));
  expect(screen.queryByRole("button", { name: "Send conversation" })).toBeNull();
  await act(async () => resolvePendingRpc("assistantDestination", "newest", destination("mac")));
  await screen.findByRole("button", { name: "Send conversation" });
  await act(async () => resolvePendingRpc("assistantDestination", "oldest", destination("srv")));
  expect((screen.getByRole("combobox", { name: "Home" }) as HTMLSelectElement).value).toBe("/Users/me/assistants/sam");
  fireEvent.click(screen.getByRole("button", { name: "Send conversation" }));
  await waitFor(() => expect(rpcCalls.some((call) => call.method === "createReplacementThread")).toBe(true));
  expect(rpcCalls.find((call) => call.method === "createReplacementThread")?.input).toMatchObject({ destinationHostId: "mac" });
});

it("ignores late source seeds after choosing another assistant conversation", async () => {
  configureFakeSdk({ deferRpc: ["assistantSeeds"] });
  const view = render(<ComposeDialog replaceThreadId="old" onClose={() => {}} onNavigate={() => {}} />);
  await waitFor(() => expect(pendingRpc).toHaveLength(1));
  view.rerender(<ComposeDialog replaceThreadId="new-source" onClose={() => {}} onNavigate={() => {}} />);
  await waitFor(() => expect(pendingRpc).toHaveLength(2));
  await act(async () => resolvePendingRpc("assistantSeeds", "newest", { ...seeds, title: "Forge" }));
  expect(screen.getByText("New thread with Forge")).toBeTruthy();
  await act(async () => resolvePendingRpc("assistantSeeds", "oldest", seeds));
  expect(screen.queryByText("New thread with Sam")).toBeNull();
});

it("withholds the composer for an unready target and shows its reason", async () => {
  configureFakeSdk({ assistantSeeds: { old: seeds }, assistantDestinations: { srv: destination("srv"), mac: { ...destination("mac"), ready: false, reason: "Private Sync is paused" } } });
  render(<ComposeDialog replaceThreadId="old" onClose={() => {}} onNavigate={() => {}} />);
  await screen.findByRole("button", { name: "Send conversation" });
  fireEvent.change(screen.getByRole("combobox", { name: "Machine" }), { target: { value: "mac" } });
  await screen.findByText("Private Sync is paused");
  expect(screen.queryByRole("button", { name: "Send conversation" })).toBeNull();
  expect(rpcCalls.filter((call) => call.method === "createReplacementThread")).toEqual([]);
});
