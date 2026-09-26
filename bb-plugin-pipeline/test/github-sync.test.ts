import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createGithubSync, reviewFollowup } from "../lib/github-sync";
import type { GithubFeedback, GithubSnapshot, ReviewClassification } from "../lib/github-types";
import { createCardStore, MIGRATIONS } from "../lib/store";
import { createPipelineService } from "../lib/service";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import { cardSchema } from "../lib/contract";
import { classifyReview } from "../lib/review-classifier";
import { taskGithubFollowup, taskGithubReviewLabel, taskGithubSummary, taskNeedsAttention } from "../components/task-state";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });
const url = "https://github.com/example/repo/pull/12";
const feedback = (overrides: Partial<GithubFeedback> = {}): GithubFeedback => ({
  id: "inline:1", kind: "inline", author: "reviewer", body: "This loses saved data", url: `${url}#discussion_r1`,
  commitSha: "abc", state: null, updatedAt: 1, inReplyTo: null, ...overrides,
});
function setup() {
  let snapshot: GithubSnapshot = { url, number: 12, state: "open", draft: true, headSha: "abc", author: "owner", checks: [],
    mergeable: "mergeable", reviewDecision: null, feedback: [], fetchedAt: Date.now() };
  const queue: ReturnType<typeof makeQueueEntry>[] = [];
  const events: Awaited<ReturnType<PluginBbSdk["threads"]["events"]["list"]>> = [];
  const thread = makeThreadResponse({ id: "lead", status: "idle" });
  const send = vi.fn(async (args: { input: Array<{ type: string; text?: string }> }) => {
    const entry = makeQueueEntry({ id: `q${queue.length}`, threadId: "lead", content: args.input as never });
    queue.push(entry);
    return { delivery: "queued" as const, queuedMessage: entry };
  });
  const host = createFakePluginHost({ pluginId: "pipeline", sdk: { threads: {
    get: async () => thread, send, events: { list: async () => events },
    queuedMessages: { list: async () => queue, delete: async ({ queuedMessageId }) => {
      const index = queue.findIndex((item) => item.id === queuedMessageId);
      if (index >= 0) queue.splice(index, 1);
      return { ok: true };
    } },
  } } });
  hosts.push(host);
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  store.create({ id: "card", projectId: "proj", hostId: "host", title: "Task", body: "", attachments: [], source: "ui" });
  store.update("card", { leadThreadId: "lead", ownerRole: "lead", column: "pr", prUrl: url });
  const read = vi.fn(async () => structuredClone(snapshot));
  const post = vi.fn(async (_url: string, _body: string, _signal?: AbortSignal) => {});
  const notify = vi.fn();
  const classify = vi.fn(async (_args: Parameters<typeof classifyReview>[0]): Promise<ReviewClassification> => ({ decision: "feedback", probability: .99 }));
  const settings = { jevApiKey: "test", jevThreshold: "0.7", reviewRequestComment: "@codex review", autoReviewFollowup: true };
  const makeSync = () => createGithubSync({ bb: host.bb, store, read, post, classify, notify, getSettings: async () => settings });
  const sync = makeSync();
  return { host, db, store, send, queue, events, read, post, notify, classify, sync, makeSync, settings, thread,
    snapshot: () => snapshot, change: (patch: Partial<GithubSnapshot>) => { snapshot = { ...snapshot, ...patch }; }, card: () => store.get("card")! };
}

describe("GitHub review handoff", () => {
  it("keeps manual findings pending until Retry review explicitly sends one batch", async () => {
    const s = setup();
    s.settings.autoReviewFollowup = false;
    s.change({ feedback: [feedback()] });
    await s.sync.poll();
    const batch = s.store.getGithub("card")!.batch!;
    expect(s.card().github).toMatchObject({ review: "feedback", followup: "pending", batchId: batch.id, manualReviewPending: true });
    expect(cardSchema.parse(s.card()).github?.manualReviewPending).toBe(true);
    expect(taskNeedsAttention(s.card(), false)).toBe(true);
    expect(taskGithubSummary(s.card())?.label).toBe("Review needs your triage");
    expect(taskGithubReviewLabel(s.card())).toBe("Review needs your triage");
    expect(taskGithubFollowup(s.card())).toBe("Review findings awaiting your decision");
    expect(s.send).not.toHaveBeenCalled();
    expect(s.notify).toHaveBeenCalledWith(s.card(), expect.stringContaining("need your triage"), "review");
    await s.makeSync().poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();

    await s.sync.retry("card");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github?.manualReviewPending).toBe(false);
    expect(taskNeedsAttention(s.card(), false)).toBe(false);
    expect(s.store.getGithub("card")!.batch).toMatchObject({ id: batch.id, manualDispatch: true, state: "queued" });
    const context = makeMessageDispatchHookContext({ thread: s.thread,
      input: { text: reviewFollowup(s.card(), batch), blocks: [] } });
    expect(await s.makeSync().decide(context)).toBeNull();
    s.makeSync().onMessage("queued", s.queue[0]!);
    expect(s.store.getGithub("card")!.batch?.manualDispatch).toBe(true);
    expect(await s.makeSync().decide(context)).toBeNull();
    await s.makeSync().poll();
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("holds an automatic queued follow-up after disabling delivery and releases it when reenabled", async () => {
    const s = setup();
    s.change({ feedback: [feedback()] });
    await s.sync.poll();
    const batch = s.store.getGithub("card")!.batch!;
    expect(s.card().github?.manualReviewPending).toBe(false);
    expect(taskNeedsAttention(s.card(), false)).toBe(false);
    const context = makeMessageDispatchHookContext({ thread: s.thread,
      input: { text: reviewFollowup(s.card(), batch), blocks: [] } });
    expect(await s.sync.decide(context)).toBeNull();
    s.settings.autoReviewFollowup = false;
    expect(await s.makeSync().decide(context)).toMatchObject({ action: "wait", reason: expect.stringContaining("triage") });
    await s.makeSync().poll();
    expect(s.card().github).toMatchObject({ followup: "queued", batchId: batch.id, manualReviewPending: true });
    expect(taskNeedsAttention(s.card(), false)).toBe(true);
    expect(s.notify).toHaveBeenCalledWith(s.card(), expect.stringContaining("need your triage"), "review");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.queue).toHaveLength(1);
    s.settings.autoReviewFollowup = true;
    expect(await s.makeSync().decide(context)).toBeNull();
    await s.makeSync().poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github?.manualReviewPending).toBe(false);
    expect(taskNeedsAttention(s.card(), false)).toBe(false);
    s.settings.autoReviewFollowup = false;
    await s.makeSync().poll();
    await s.sync.retry("card");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.store.getGithub("card")!.batch?.manualDispatch).toBe(true);
    expect(s.card().github?.manualReviewPending).toBe(false);
    expect(await s.makeSync().decide(context)).toBeNull();
  });

  it("keeps queued manual feedback held when Retry cannot verify GitHub, then cancels a closed PR", async () => {
    const s = setup();
    s.change({ feedback: [feedback()] });
    await s.sync.poll();
    s.settings.autoReviewFollowup = false;
    await s.sync.poll();
    const batch = s.store.getGithub("card")!.batch!;
    const context = makeMessageDispatchHookContext({ thread: s.thread,
      input: { text: reviewFollowup(s.card(), batch), blocks: [] } });
    s.read.mockRejectedValueOnce(new Error("GitHub offline"));
    await s.sync.retry("card");
    expect(s.card().github?.error).toContain("GitHub offline");
    expect(s.store.getGithub("card")!.batch?.manualDispatch).not.toBe(true);
    expect(await s.sync.decide(context)).toMatchObject({ action: "wait" });
    expect(s.send).toHaveBeenCalledTimes(1);
    s.change({ state: "closed" });
    await s.sync.retry("card");
    expect(s.card().github).toMatchObject({ state: "closed", followup: "cancelled" });
    expect(s.queue).toHaveLength(0);
    expect(await s.sync.decide(context)).toMatchObject({ action: "reject" });
  });

  it("does not resend unconfirmed delivery after switching manual follow-ups off and on", async () => {
    const s = setup();
    s.change({ feedback: [feedback()] });
    await s.sync.poll();
    s.settings.autoReviewFollowup = false;
    await s.sync.poll();
    s.queue.length = 0;
    s.settings.autoReviewFollowup = true;
    await s.makeSync().poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github).toMatchObject({ followup: "queued", error: expect.stringContaining("unconfirmed") });
    await s.sync.retry("card");
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it("refreshes an uncertain abbreviated-commit review into a merge decision without waking the lead", async () => {
    const s = setup();
    const head = "7116d57764d244f4a7bdf43a645e4a13575cfca9";
    s.change({ headSha: head, feedback: [feedback({ kind: "comment", commitSha: null,
      body: "Codex Review: Didn't find any major issues. Another round soon, please!\n\n**Reviewed commit:** `7116d57764`",
    })] });
    let clean = 0.5;
    const fetch = vi.fn(async () => new Response(JSON.stringify({ answers: {
      findings: { type: "noul", noul: 0.05 },
      clean_current_revision: { type: "noul", noul: clean },
      waiting: { type: "noul", noul: 0.8 },
      informational: { type: "noul", noul: 0.05 },
    } })));
    s.classify.mockImplementation((args) => classifyReview({ ...args, fetch }));
    await s.sync.poll();
    expect(s.card().github?.review).toBe("unknown");
    clean = 0.94;
    await s.sync.poll();
    expect(fetch).toHaveBeenCalledTimes(1);
    await s.sync.sync("card");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(s.card()).toMatchObject({ column: "pr", github: { review: "clear", followup: null, batchId: null, error: null } });
    expect(s.notify).toHaveBeenLastCalledWith(expect.anything(), "Review settled; ready for your merge decision", "review");
    expect(s.send).not.toHaveBeenCalled();
  });

  it("keeps invalid legacy links readable and canonicalizes valid legacy links before handoff", async () => {
    const s = setup();
    s.store.update("card", { prUrl: "not-a-url" });
    await s.sync.poll();
    expect(cardSchema.parse(s.card()).github).toMatchObject({ number: null, error: expect.stringContaining("valid github.com") });
    expect(s.read).not.toHaveBeenCalled();
    s.store.update("card", { prUrl: `${url}/files#discussion_r123` });
    await s.sync.waitForReview("card", "lead");
    expect(s.card()).toMatchObject({ prUrl: url, github: { url, number: 12, error: null } });
    expect(s.read).toHaveBeenCalledWith(url, expect.any(AbortSignal));
    expect(s.store.getGithub("card")!.awaitingReviewRevision).toBe(s.card().revision);
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("observes empty approvals and revoked reviews instead of keeping an obsolete settled state", async () => {
    const s = setup();
    const approval = feedback({ kind: "review", state: "APPROVED", body: "" });
    s.change({ feedback: [approval], reviewDecision: "APPROVED" });
    s.classify.mockResolvedValueOnce({ decision: "clear", probability: .99 });
    await s.sync.poll();
    expect(s.classify.mock.calls[0]?.[0]).toMatchObject({ feedback: [approval] });
    expect(s.card().github?.review).toBe("clear");
    s.change({ feedback: [{ ...approval, state: "DISMISSED" }], reviewDecision: "REVIEW_REQUIRED" });
    s.classify.mockResolvedValueOnce({ decision: "waiting", probability: .99 });
    await s.sync.poll();
    expect(s.classify).toHaveBeenCalledTimes(2);
    expect(s.card().github).toMatchObject({ review: "waiting", reviewDecision: "REVIEW_REQUIRED" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("preserves settled review across a late completion summary, but still delivers later findings", async () => {
    const s = setup();
    const clean = feedback({ id: "clean", kind: "review", state: "APPROVED", body: "No issues found." });
    s.change({ feedback: [clean] });
    s.classify.mockResolvedValueOnce({ decision: "clear", probability: .95 });
    await s.sync.poll();
    const summary = feedback({ id: "summary", kind: "comment", commitSha: null, body: "Code review: Completed" });
    s.change({ feedback: [clean, summary] });
    s.classify.mockResolvedValueOnce({ decision: "informational", probability: .95 });
    await s.sync.poll();
    expect(s.card().github?.review).toBe("clear");
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.send).not.toHaveBeenCalled();
    s.change({ feedback: [clean, summary, feedback({ id: "new-finding" })] });
    await s.sync.poll();
    expect(s.card().github).toMatchObject({ review: "feedback", followup: "queued" });
    expect(s.send).toHaveBeenCalledOnce();
  });

  it("keeps a pending review quiet when a teammate posts conversational feedback", async () => {
    const s = setup();
    await s.sync.waitForReview("card", "lead");
    s.change({ feedback: [feedback({ kind: "comment", commitSha: null, body: "Nice work!" })] });
    s.classify.mockResolvedValueOnce({ decision: "informational", probability: .95 });
    await s.sync.poll();
    expect(s.card().github).toMatchObject({ review: "waiting", followup: null });
    expect(s.notify).not.toHaveBeenCalled();
    expect(s.send).not.toHaveBeenCalled();
  });

  it("does not make an informational summary settle a new revision", async () => {
    const s = setup();
    s.change({ feedback: [feedback({ kind: "review", body: "No findings" })] });
    s.classify.mockResolvedValueOnce({ decision: "clear", probability: .95 });
    await s.sync.poll();
    s.change({ headSha: "def", feedback: [feedback({ id: "summary", kind: "comment", commitSha: null, body: "Review: Completed" })] });
    s.classify.mockResolvedValueOnce({ decision: "informational", probability: .95 });
    await s.sync.poll();
    expect(s.card().github).toMatchObject({ review: "waiting", headSha: "def" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("accepts an explicitly current clean comment predating discovery, then reflects a new review in progress", async () => {
    const s = setup();
    s.change({ feedback: [feedback({ kind: "comment", commitSha: null, body: "Review of abc complete, no findings", updatedAt: 1 })] });
    s.classify.mockResolvedValueOnce({ decision: "clear", probability: .99 });
    await s.sync.poll();
    expect(s.card().github?.review).toBe("clear");
    s.change({ feedback: [...s.snapshot().feedback, feedback({ id: "comment:progress", kind: "comment", body: "Second review started" })] });
    s.classify.mockResolvedValueOnce({ decision: "waiting", probability: .99 });
    await s.sync.poll();
    expect(s.card().github?.review).toBe("waiting");
    expect(s.send).not.toHaveBeenCalled();
  });

  it("requests once per revision, returns without waiting, and supports automatic reviews", async () => {
    const s = setup();
    await Promise.all([s.sync.waitForReview("card", "lead"), s.sync.waitForReview("card", "lead")]);
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.post.mock.calls[0]).toEqual([url, "@codex review\n\n<!-- pipeline-review-request:card:abc -->", expect.any(AbortSignal)]);
    expect(s.send).not.toHaveBeenCalled();
    expect(s.card().github).toMatchObject({ review: "waiting", checks: [], headSha: "abc" });
    expect(s.store.getGithub("card")!.awaitingReviewRevision).toBe(s.card().revision);
    s.change({ headSha: "def" }); s.settings.reviewRequestComment = "";
    await s.sync.waitForReview("card", "lead");
    expect(s.post).toHaveBeenCalledTimes(1);
    await expect(s.sync.waitForReview("card", "intake")).rejects.toThrow("owning lead");
  });

  it("recovers a posted trigger after a lost response using the persisted GitHub marker", async () => {
    const s = setup();
    s.post.mockImplementationOnce(async () => { s.change({ feedback: [feedback({ kind: "comment", author: "owner", body: "@codex review\n<!-- pipeline-review-request:card:abc -->" })] }); throw new Error("lost response"); });
    await expect(s.sync.waitForReview("card", "lead")).rejects.toThrow("lost response");
    await s.sync.waitForReview("card", "lead");
    expect(s.post).toHaveBeenCalledTimes(1);
  });

  it("keeps a settled review and a later user question when the same handoff is repeated", async () => {
    const s = setup();
    await s.sync.waitForReview("card", "lead");
    s.classify.mockResolvedValue({ decision: "clear", probability: .99 });
    s.change({ feedback: [feedback({ kind: "review", body: "No findings" })] });
    await s.sync.poll();
    s.store.update("card", { needsUser: true, attentionReason: "Which release?", reportSignal: "needs_you" });
    await s.sync.waitForReview("card", "lead");
    expect(s.card()).toMatchObject({ needsUser: true, attentionReason: "Which release?", github: { review: "clear" } });
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.classify).toHaveBeenCalledTimes(1);
    expect(s.store.history("card").filter((entry) => entry.kind === "review_waiting")).toHaveLength(1);
  });

  it("coalesces feedback into one durable follow-up across repeated scans and reload", async () => {
    const s = setup();
    s.change({ feedback: [feedback(), feedback({ id: "comment:2", kind: "comment", author: "another-bot" })] });
    await Promise.all([s.sync.sync("card"), s.sync.sync("card")]);
    expect(s.classify).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github).toMatchObject({ review: "feedback", followup: "queued" });
    expect(s.send.mock.calls[0]![0]).toMatchObject({ mode: "queue-if-active", sendAt: expect.any(Number) });
    await s.makeSync().poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    const batch = s.store.getGithub("card")!.batch!;
    expect(s.queue[0]!.content).toEqual([{ type: "text", text: reviewFollowup(s.card(), batch), mentions: [] }]);
  });

  it("does not use old reviews, own replies, or a request comment to wake the lead", async () => {
    const s = setup();
    s.change({ feedback: [feedback({ commitSha: "old" }), feedback({ id: "comment:2", author: "owner" }), feedback({ id: "comment:3", body: "<!-- pipeline-review-request:card:abc -->" })] });
    await s.sync.sync("card");
    expect(s.classify).not.toHaveBeenCalled(); expect(s.send).not.toHaveBeenCalled();
  });

  it("requests review for a pushed fix without inheriting the previous revision's clean result", async () => {
    const s = setup();
    await s.sync.waitForReview("card", "lead");
    s.change({ feedback: [feedback()] }); await s.sync.poll();
    const batch = s.store.getGithub("card")!.batch!;
    s.sync.onMessage("dispatched", s.queue.shift()!);
    s.change({ headSha: "def" });
    await s.sync.waitForReview("card", "lead", batch.id);
    expect(s.post).toHaveBeenCalledTimes(2);
    expect(s.post.mock.calls[1]![1]).toContain("pipeline-review-request:card:def");
    expect(s.card().github).toMatchObject({ headSha: "def", review: "waiting", followup: "handled" });
    expect(s.send).toHaveBeenCalledTimes(1);
    s.classify.mockResolvedValue({ decision: "clear", probability: .99 });
    s.change({ feedback: [feedback(), feedback({ id: "review:new", commitSha: "def", body: "No issues" })] });
    await s.sync.poll();
    expect(s.card().github?.review).toBe("clear");
    s.change({ headSha: "ghi" }); await s.sync.poll();
    expect(s.card().github?.review).toBe("waiting");
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("keeps delivered feedback delivered when queue events and the send response arrive late", async () => {
    const s = setup(); s.change({ feedback: [feedback()] });
    s.send.mockImplementationOnce(async (args) => {
      const entry = makeQueueEntry({ id: "racing", threadId: "lead", content: args.input as never });
      s.sync.onMessage("dispatched", entry);
      s.sync.onMessage("queued", entry);
      return { delivery: "queued", queuedMessage: entry };
    });
    await s.sync.poll(); await s.makeSync().poll();
    expect(s.card().github?.followup).toBe("delivered");
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])("recovers a missed delivery event without resending or false triage (auto=%s)", async (automatic) => {
    const s = setup(); s.change({ feedback: [feedback()] }); await s.sync.poll();
    s.settings.autoReviewFollowup = automatic;
    const entry = s.queue.shift()!;
    s.events.push({ id: "accepted", scope: "client", threadId: "lead", seq: 10, createdAt: Date.now(),
      type: "client/turn/requested", data: { input: entry.content } } as never);
    await s.makeSync().poll();
    expect(s.card().github).toMatchObject({ followup: "delivered", error: null, manualReviewPending: false });
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.notify).not.toHaveBeenCalled();
    await expect(s.sync.retry("card")).rejects.toThrow("already received");
  });

  it.each([true, false])("shows uncertain delivery without duplicating it (auto=%s)", async (automatic) => {
    const s = setup(); s.change({ feedback: [feedback()] }); await s.sync.poll();
    s.settings.autoReviewFollowup = automatic;
    s.queue.length = 0;
    await s.makeSync().poll(); await s.sync.poll();
    expect(s.card().github?.error).toContain("unconfirmed");
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(1);
    await s.sync.retry("card");
    expect(s.send).toHaveBeenCalledTimes(2);
  });

  it("does not classify a handed-off idle lead as waiting for the user, but still reports failures", async () => {
    const s = setup();
    const classify = vi.fn(async () => ({ decision: "needs" as const, probability: .99 }));
    const service = createPipelineService({
      store: s.store, sdk: s.host.bb.sdk, classify, publish: () => {}, log: () => {}, onAttention: () => {},
      readIssue: async () => ({ title: "", body: "", labels: [] }),
      refreshImportedIssue: async (id) => s.store.get(id)!,
      getSettings: async () => ({ providerId: "codex", model: "model", reasoningLevel: "high", permissionMode: "full", jevThreshold: ".7" }),
    });
    await s.sync.waitForReview("card", "lead");
    await service.onThreadIdle(s.thread, "External review pending. Nothing needed from you.");
    expect(classify).not.toHaveBeenCalled();
    expect(s.card().needsUser).toBe(false);
    await service.onThreadActive({ ...s.thread, status: "active" });
    await service.onThreadIdle(s.thread, "Which behavior should this use?");
    expect(classify).toHaveBeenCalledTimes(1);
    expect(s.card()).toMatchObject({ needsUser: true, attentionReason: "Which behavior should this use?" });
    await service.onThreadFailed({ ...s.thread, status: "error" }, "Provider unavailable");
    expect(s.card()).toMatchObject({ needsUser: true, threadError: "Provider unavailable" });
  });

  it("preserves new comments while a batch is in flight and handles answered findings without a new request", async () => {
    const s = setup();
    await s.sync.waitForReview("card", "lead");
    s.change({ feedback: [feedback()] }); await s.sync.sync("card");
    const first = s.store.getGithub("card")!.batch!.id;
    s.sync.onMessage("dispatched", s.queue.shift()!);
    s.change({ feedback: [feedback(), feedback({ id: "inline:2" })] }); await s.sync.poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    await s.sync.waitForReview("card", "lead", first);
    expect(s.post).toHaveBeenCalledTimes(1);
    expect(s.send).toHaveBeenCalledTimes(2);
    expect(s.store.getGithub("card")!.batch!.id).not.toBe(first);
    await expect(s.sync.waitForReview("card", "lead", first)).rejects.toThrow("no longer current");
  });

  it("remembers changed text on the same comment and waits for an explicit retry of unknown classification", async () => {
    const s = setup();
    s.classify.mockResolvedValue({ decision: "unknown", probability: .5 });
    const item = feedback(); s.change({ feedback: [item] });
    await s.sync.poll(); await s.sync.poll();
    expect(s.classify).toHaveBeenCalledTimes(1);
    expect(s.card().github?.review).toBe("unknown"); expect(s.notify).toHaveBeenCalledTimes(1);
    s.change({ feedback: [{ ...item, body: "Edited finding" }] }); await s.sync.poll();
    expect(s.classify).toHaveBeenCalledTimes(2);
    await s.sync.sync("card"); expect(s.classify).toHaveBeenCalledTimes(3);
  });

  it("shows clean review without waking lead or clearing an unrelated question", async () => {
    const s = setup();
    s.classify.mockResolvedValue({ decision: "clear", probability: .99 });
    s.store.update("card", { needsUser: true, attentionReason: "Which release?" });
    s.change({ feedback: [feedback({ kind: "review", state: "APPROVED", body: "No findings" })] });
    await s.sync.poll();
    expect(s.card()).toMatchObject({ needsUser: true, attentionReason: "Which release?", github: { review: "clear" } });
    expect(s.send).not.toHaveBeenCalled();
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("holds feedback during pause and delivers after resume without a new GitHub event", async () => {
    const s = setup(); s.store.update("card", { runState: "paused" });
    s.change({ feedback: [feedback()] }); await s.sync.poll();
    expect(s.card().github?.followup).toBe("pending"); expect(s.send).not.toHaveBeenCalled();
    s.store.update("card", { runState: "running" }); await s.sync.poll();
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it("alerts once for an unavailable lead and delivers after it is restored", async () => {
    const s = setup(); s.thread.archivedAt = Date.now();
    s.change({ feedback: [feedback()] });
    await s.sync.poll(); await s.sync.poll();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.card().github?.error).toContain("Restore the lead thread");
    expect(s.notify).toHaveBeenCalledTimes(1);
    s.thread.archivedAt = null; await s.sync.poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github).toMatchObject({ followup: "queued", error: null });
  });

  it("marks merged Done without stopping work; closed stays in place and manual Done stays closed", async () => {
    const s = setup(); s.change({ state: "closed" }); await s.sync.poll();
    expect(s.card().column).toBe("pr");
    s.change({ state: "merged" }); await s.sync.poll();
    expect(s.card().column).toBe("done");
    expect(s.host.harness.inspection.sdk.callsTo("threads.stop")).toHaveLength(0);
    s.change({ state: "open" }); await s.sync.sync("card");
    expect(s.card().column).toBe("done");
    expect(s.store.history("card").filter((item) => item.kind === "pr_merged")).toHaveLength(1);
  });

  it("rejects stale queued follow-ups after PR replacement or manual completion", async () => {
    const s = setup(); s.change({ feedback: [feedback()] }); await s.sync.poll();
    const text = reviewFollowup(s.card(), s.store.getGithub("card")!.batch!);
    const context = makeMessageDispatchHookContext({ thread: s.thread, input: { text, blocks: [] } });
    expect(await s.sync.decide(context)).toBeNull();
    s.store.update("card", { column: "done" }); expect((await s.sync.decide(context))?.action).toBe("reject");
    s.store.update("card", { column: "pr", prUrl: "https://github.com/example/repo/pull/13" });
    expect(s.card().github).toBeNull(); expect((await s.sync.decide(context))?.action).toBe("reject");
  });

  it("drops a slow snapshot after the linked PR changes", async () => {
    const s = setup();
    let resolve!: (snapshot: GithubSnapshot) => void;
    s.read.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const pending = s.sync.sync("card"); await vi.waitFor(() => expect(s.read).toHaveBeenCalled());
    s.store.update("card", { prUrl: "https://github.com/example/repo/pull/13" });
    resolve(s.snapshot()); await pending;
    expect(s.card().github).toBeNull(); expect(s.send).not.toHaveBeenCalled();
  });

  it("surfaces sync failure without erasing known check results", async () => {
    const s = setup(); s.change({ checks: [{ name: "build", state: "failed", url: "https://github.com/example/repo/actions/runs/1" }] });
    await s.sync.poll();
    s.read.mockRejectedValueOnce(new Error("authentication expired")); await s.sync.poll();
    expect(s.card().github).toMatchObject({ checks: [{ name: "build", state: "failed" }], error: expect.stringContaining("authentication expired") });
    expect(s.send).not.toHaveBeenCalled();
  });

  it("shows transient read failures but only notifies persistent failure, without re-announcing settled review on recovery", async () => {
    const s = setup();
    s.classify.mockResolvedValue({ decision: "clear", probability: .99 });
    s.change({ feedback: [feedback({ body: "No findings" })] });
    await s.sync.poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    s.notify.mockClear();
    s.read.mockRejectedValueOnce(new Error("connection reset"));
    await s.sync.poll();
    expect(s.card().github?.error).toContain("connection reset");
    expect(s.notify).not.toHaveBeenCalled();
    s.read.mockRejectedValueOnce(new Error("network timeout"));
    await s.makeSync().poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    s.read.mockRejectedValueOnce(new Error("network timeout"));
    await s.sync.poll();
    await s.sync.poll();
    expect(s.card().github).toMatchObject({ review: "clear", error: null });
    expect(s.notify).toHaveBeenCalledTimes(1);
  });

  it("ends a read-failure streak when the read succeeds even if feedback processing fails", async () => {
    const s = setup();
    s.read.mockRejectedValueOnce(new Error("network timeout")).mockRejectedValueOnce(new Error("network timeout"));
    await s.sync.poll(); await s.sync.poll();
    expect(s.notify).toHaveBeenCalledTimes(1);

    s.change({ feedback: [feedback()] });
    s.classify.mockRejectedValueOnce(new Error("classifier failed"));
    await s.sync.poll();
    expect(s.store.getGithub("card")!.readFailures).toBe(0);
    expect(s.card().github?.error).toContain("classifier failed");
    s.notify.mockClear();

    const reloaded = s.makeSync();
    s.read.mockRejectedValue(new Error("new outage"));
    await reloaded.poll();
    expect(s.notify).not.toHaveBeenCalled();
    await reloaded.poll(); await reloaded.poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.notify).toHaveBeenLastCalledWith(expect.anything(), "GitHub sync: new outage", "failures");
  });

  it.each(["closed", "cancelled"] as const)("does not re-announce %s attention when GitHub reads fail", async (attention) => {
    const s = setup();
    if (attention === "closed") {
      s.change({ state: "closed" });
      await s.sync.poll();
    } else {
      s.change({ feedback: [feedback()] });
      await s.sync.poll();
      s.sync.onMessage("cancelled", s.queue.shift()!);
    }
    expect(s.notify).toHaveBeenCalledTimes(1);
    s.notify.mockClear();
    s.read.mockRejectedValue(new Error("rate limited"));
    await s.sync.poll(); await s.sync.poll(); await s.sync.poll();
    expect(s.card().github?.error).toBe("GitHub sync: rate limited");
    expect(s.notify).not.toHaveBeenCalled();
  });

  it("does not blindly resend after an uncertain send, and recovers a queued marker", async () => {
    const s = setup(); s.change({ feedback: [feedback()] });
    s.send.mockRejectedValueOnce(new Error("connection lost"));
    await s.sync.poll(); await s.sync.poll();
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.card().github?.error).toContain("unconfirmed");
    const batch = s.store.getGithub("card")!.batch!;
    s.queue.push(makeQueueEntry({ id: "recovered", threadId: "lead", content: [{ type: "text", text: reviewFollowup(s.card(), batch), mentions: [] }] }));
    await s.makeSync().poll();
    expect(s.send).toHaveBeenCalledTimes(1); expect(s.card().github?.followup).toBe("queued");
  });

  it("keeps a user-cancelled follow-up cancelled until explicit retry", async () => {
    const s = setup(); s.change({ feedback: [feedback()] }); await s.sync.poll();
    s.sync.onMessage("cancelled", s.queue.shift()!);
    await s.sync.poll(); expect(s.send).toHaveBeenCalledTimes(1);
    await s.sync.retry("card"); expect(s.send).toHaveBeenCalledTimes(2);
  });
});
