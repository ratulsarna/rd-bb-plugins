import { randomUUID } from "node:crypto";
import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import {
  githubRepository, listAssignedIssues, normalizeGithubIssueUrl,
  readGithubIssue, readGithubViewer,
} from "./issue";
import type { Card, CardStore } from "./store";

export function createIssueImporter(input: {
  sdk: PluginBbSdk;
  store: CardStore;
  publish(projectId: string): void;
  readIssue?: typeof readGithubIssue;
  listIssues?: typeof listAssignedIssues;
  readViewer?: typeof readGithubViewer;
}) {
  const { store } = input;
  const read = input.readIssue ?? readGithubIssue;
  const list = input.listIssues ?? listAssignedIssues;
  const viewer = input.readViewer ?? readGithubViewer;
  const refreshing = new Map<string, Promise<Card>>();

  async function repository(projectId: string) {
    const project = await input.sdk.projects.get({ projectId });
    return githubRepository(project.gitRemoteUrl);
  }

  function existing(projectId: string, url: string): Card | undefined {
    const key = normalizeGithubIssueUrl(url)?.toLowerCase();
    const link = store.listIssueLinks(projectId).find((card) =>
      key !== undefined && normalizeGithubIssueUrl(card.issueUrl)?.toLowerCase() === key,
    );
    return link === undefined ? undefined : store.get(link.id) ?? undefined;
  }

  function required(cardId: string) {
    const card = store.get(cardId);
    if (!card) throw new Error(`unknown card ${cardId}`);
    if (!card.importedIssue) throw new Error("This task has no imported GitHub issue");
    return card;
  }

  return {
    async list(projectId: string, page = 1) {
      if (!Number.isSafeInteger(page) || page < 1) throw new Error("page must be a positive integer");
      const repo = await repository(projectId);
      const login = await viewer();
      const result = await list(repo, login, page);
      const links = new Map(store.listIssueLinks(projectId).map((card) => [normalizeGithubIssueUrl(card.issueUrl)?.toLowerCase(), card.id]));
      return {
        repository: repo, viewer: login, hasMore: result.hasMore,
        issues: result.issues.map((issue) => ({ ...issue, cardId: links.get(normalizeGithubIssueUrl(issue.url)?.toLowerCase()) ?? null })),
      };
    },
    async import(projectId: string, numbers: number[]) {
      if (numbers.length === 0 || numbers.length > 50 || numbers.some((n) => !Number.isSafeInteger(n) || n <= 0)) {
        throw new Error("Choose between 1 and 50 issue numbers");
      }
      const repo = await repository(projectId);
      const login = await viewer();
      const cards: Card[] = [];
      const errors: Array<{ number: number; message: string }> = [];
      const selected = [...new Set(numbers)];
      for (let offset = 0; offset < selected.length; offset += 4) {
        await Promise.all(selected.slice(offset, offset + 4).map(async (number) => {
          try {
            const url = `https://github.com/${repo}/issues/${number}`;
            let card = existing(projectId, url);
            if (!card) {
              const issue = await read(url);
              if (issue.state !== "open" || !issue.assignees.some((name) => name.toLowerCase() === login.toLowerCase())) {
                throw new Error("This issue is no longer open and assigned to you. Refresh the list.");
              }
              // Recheck after the read: another request may have imported or linked it.
              card = existing(projectId, url) ?? store.create({
                id: randomUUID().slice(0, 12), projectId, hostId: null,
                title: issue.title, body: "", attachments: [], startRequested: false, source: "github",
                importedIssue: { ...issue, importedBy: login, syncedAt: Date.now(), error: null },
              });
              input.publish(projectId);
            }
            cards.push(card);
          } catch (cause) {
            errors.push({ number, message: cause instanceof Error ? cause.message : String(cause) });
          }
        }));
      }
      return { cards, errors };
    },
    refresh(cardId: string): Promise<Card> {
      const pending = refreshing.get(cardId);
      if (pending) return pending;
      const operation = (async () => {
        const card = required(cardId);
        const source = card.importedIssue!;
        try {
          const issue = await read(source.url);
          store.setImportedIssue(cardId, { ...issue, importedBy: source.importedBy, syncedAt: Date.now(), error: null });
          input.publish(card.projectId);
          return required(cardId);
        } catch (cause) {
          const current = store.get(cardId);
          if (current?.importedIssue) {
            const error = (cause instanceof Error ? cause.message : String(cause)).slice(0, 2000);
            store.setImportedIssue(cardId, { ...current.importedIssue, error });
            input.publish(card.projectId);
          }
          throw cause;
        }
      })();
      refreshing.set(cardId, operation);
      void operation.finally(() => refreshing.delete(cardId)).catch(() => {});
      return operation;
    },
  };
}

export type IssueImporter = ReturnType<typeof createIssueImporter>;
