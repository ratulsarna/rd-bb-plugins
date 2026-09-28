import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Card, CardStore } from "./store";

// BB tears down a managed worktree a few minutes after its last thread is archived and keeps the branch,
// so archiving the lead worktree's threads is all a finished task needs.
export function createWorktreeCleanup(bb: BbPluginApi, store: CardStore) {
  async function retire(card: Card) {
    if (card.leadThreadId === null) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: card.leadThreadId, experimental_includeDeleted: true });
      if (thread.deletedAt !== null || thread.archivedAt !== null || thread.environmentId === null) return;
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
      // Never the shared project checkout, only the lead's own worktree.
      if (!environment.managed || !environment.isWorktree || environment.status === "destroyed") return;
      await bb.sdk.environments.archiveThreads({ environmentId: environment.id });
      store.recordHistory(card.id, { kind: "worktree_retired", source: "system", threadId: thread.id, note: environment.id });
    } catch (cause) {
      bb.log.warn(`could not clean up the worktree for card ${card.id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  store.onDone((card) => void retire(card));
  return {
    /** Catches tasks that finished before this existed, or while the plugin was down. */
    async retireFinished() {
      for (const card of store.listDoneWithLead()) await retire(card);
    },
  };
}
