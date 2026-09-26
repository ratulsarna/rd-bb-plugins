import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { createGithubSync } from "../lib/github-sync";
import type { GithubSnapshot } from "../lib/github-types";
import type { JevResult } from "../lib/jev";
import { createPipelineService, type PipelineServiceDependencies, type PipelineSettings } from "../lib/service";
import { createCardStore, MIGRATIONS } from "../lib/store";

const prUrl = "https://github.com/example/repo/pull/12";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });

function setup(threadOverrides: Partial<ReturnType<typeof makeThreadResponse>> = {}) {
  let snapshot: GithubSnapshot = { url: prUrl, number: 12, state: "open", draft: false, headSha: "abc", author: "owner", checks: [],
    mergeable: "mergeable", reviewDecision: null, feedback: [], fetchedAt: Date.now() };
  const queue: ReturnType<typeof makeQueueEntry>[] = [];
  const events: Awaited<ReturnType<PluginBbSdk["threads"]["events"]["list"]>> = [];
  const thread = makeThreadResponse({ id: "lead", status: "idle", ...threadOverrides });
  const send = vi.fn(async (args: { input: Array<{ type: string; text?: string }> }) => {
    const entry = makeQueueEntry({ id: `q${queue.length}`, threadId: "lead", content: args.input as never });
    queue.push(entry);
    return { delivery: "queued" as const, queuedMessage: entry };
  });
  const host = createFakePluginHost({ pluginId: "pipeline", sdk: {
    projects: { get: async () => ({ id: "proj", name: "Example", sources: [] }) as never },
    threads: {
      get: async () => thread, send, events: { list: async () => events },
      queuedMessages: { list: async () => queue, delete: async ({ queuedMessageId }) => {
        const index = queue.findIndex((item) => item.id === queuedMessageId);
        if (index >= 0) queue.splice(index, 1);
        return { ok: true };
      } },
    },
  } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  store.create({ id: "card", projectId: "proj", hostId: "host", title: "Task", body: "", attachments: [], source: "ui" });
  store.update("card", { leadThreadId: "lead", ownerRole: "lead", column: "pr", prUrl,
    issueUrl: "https://github.com/example/repo/issues/7" });
  const read = vi.fn(async () => structuredClone(snapshot));
  const notify = vi.fn();
  const sync = createGithubSync({ bb: host.bb, store, read, notify,
    getSettings: async () => ({ jevApiKey: "test", jevThreshold: "0.7", reviewRequestComment: "@codex review" }) });
  return { host, store, sync, send, read, notify, thread };
}

const serviceSettings: PipelineSettings = {
  providerId: "codex", model: "model", reasoningLevel: "high", permissionMode: "full", jevThreshold: ".7",
};

function makeService(s: ReturnType<typeof setup>, overrides: Partial<PipelineServiceDependencies> = {}) {
  return createPipelineService({
    store: s.store, sdk: s.host.bb.sdk, publish: () => {}, log: () => {}, onAttention: vi.fn(),
    classify: async () => ({ decision: "no", probability: .1 }),
    readIssue: async () => ({ title: "Issue", body: "", labels: [] }),
    refreshImportedIssue: async (id) => s.store.get(id)!,
    getSettings: async () => serviceSettings,
    ...overrides,
  });
}

describe("GitHub sync racing task actions", () => {
  it("records a pending Jev attention result even when a sync observes the unchanged open PR meanwhile", async () => {
    const s = setup();
    let release!: (verdict: JevResult) => void;
    const verdict = new Promise<JevResult>((done) => { release = done; });
    const classify = vi.fn(() => verdict);
    const onAttention = vi.fn();
    const service = makeService(s, { classify, onAttention });
    const idle = service.onThreadIdle(s.thread, "Which release ships next?");
    await vi.waitFor(() => expect(classify).toHaveBeenCalledTimes(1));

    await s.sync.poll();
    expect(s.store.getGithub("card")?.status.headSha).toBe("abc");
    expect(s.store.get("card")).toMatchObject({ needsUser: false, attentionSource: null });

    release({ decision: "needs", probability: .99 });
    await idle;
    expect(s.store.get("card")).toMatchObject({ needsUser: true, attentionSource: "jev", attentionReason: "Which release ships next?" });
    expect(onAttention).toHaveBeenCalledOnce();
    expect(s.store.get("card")!.github).toMatchObject({ headSha: "abc", review: "waiting" });
  });

  it("completes a retried cancelled kickoff when a sync lands during readIssue preparation", async () => {
    const s = setup({ status: "pending" });
    let release!: () => void;
    const preparing = new Promise<void>((done) => { release = done; });
    const readIssue = vi.fn(async () => { await preparing; return { title: "Issue", body: "", labels: [] }; });
    const service = makeService(s, { readIssue });
    s.store.update("card", { launchError: "lead: start cancelled", needsUser: true, attentionReason: "lead start cancelled", attentionSource: "system" });
    const retry = service.retry("card");
    await vi.waitFor(() => expect(readIssue).toHaveBeenCalledTimes(1));

    const revisionBefore = s.store.get("card")!.revision;
    await s.sync.poll();
    expect(s.store.getGithub("card")).not.toBeNull();
    expect(s.store.get("card")!.revision).toBe(revisionBefore);

    release();
    await retry;
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]![0]).toMatchObject({ threadId: "lead", mode: "auto" });
    expect(s.store.get("card")).toMatchObject({ launchError: null, needsUser: false, attentionReason: null });
  });

  it("still blocks a retried kickoff when the task is paused during preparation", async () => {
    const s = setup({ status: "pending" });
    let release!: () => void;
    const preparing = new Promise<void>((done) => { release = done; });
    const readIssue = vi.fn(async () => { await preparing; return { title: "Issue", body: "", labels: [] }; });
    const service = makeService(s, { readIssue });
    s.store.update("card", { launchError: "lead: start cancelled" });
    const retry = service.retry("card");
    await vi.waitFor(() => expect(readIssue).toHaveBeenCalledTimes(1));

    const revisionBefore = s.store.get("card")!.revision;
    s.store.update("card", { runState: "paused" });
    expect(s.store.get("card")!.revision).toBe(revisionBefore + 1);
    release();
    await retry;
    expect(s.send).not.toHaveBeenCalled();
    expect(s.store.get("card")).toMatchObject({ launchError: "lead: start cancelled", runState: "paused" });
  });
});
