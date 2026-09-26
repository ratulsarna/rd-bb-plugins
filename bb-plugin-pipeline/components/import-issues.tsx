import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import type { GithubIssueSummary } from "@/lib/issue-types";
import type { Card } from "@/lib/store";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Icon } from "./icon";

export type GithubIssueRow = GithubIssueSummary & { cardId: string | null };

export interface IssueListPage {
  repository: string;
  viewer: string;
  issues: GithubIssueRow[];
  hasMore: boolean;
}

export interface IssueImportResult {
  cards: Card[];
  errors: Array<{ number: number; message: string }>;
}

const MAX_BATCH = 50;

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function ImportIssues(props: {
  disabled: boolean;
  loadIssues(page: number): Promise<IssueListPage>;
  importIssues(numbers: number[]): Promise<IssueImportResult>;
  onImported(): void;
}) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageData, setPageData] = useState<IssueListPage | null>(null);
  const [pageLoading, setPageLoading] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Map<number, string>>(new Map());
  const [importing, setImporting] = useState(false);
  const [importErrors, setImportErrors] = useState<Array<{ number: number; message: string }>>([]);
  const [importedCount, setImportedCount] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [limitNotice, setLimitNotice] = useState(false);
  const pageRequest = useRef(0);
  const portalScope = usePortalScopeProps();

  useEffect(() => () => {
    pageRequest.current += 1;
  }, []);

  async function loadPage(target: number) {
    const request = ++pageRequest.current;
    setPageLoading(true);
    setPageError(null);
    try {
      const result = await props.loadIssues(target);
      if (request !== pageRequest.current) return;
      setPage(target);
      setPageData(result);
      setSelected((current) => {
        const next = new Map(current);
        for (const number of next.keys()) {
          if (result.issues.some((issue) => issue.number === number && issue.cardId !== null)) {
            next.delete(number);
          }
        }
        return next;
      });
    } catch (cause) {
      if (request !== pageRequest.current) return;
      setPageError(causeMessage(cause));
    } finally {
      if (request === pageRequest.current) setPageLoading(false);
    }
  }

  function handleOpenChange(next: boolean) {
    if (importing) return;
    if (next) {
      setPage(1);
      setPageData(null);
      setSelected(new Map());
      setImportErrors([]);
      setImportedCount(null);
      setSubmitError(null);
      setLimitNotice(false);
      void loadPage(1);
    } else {
      pageRequest.current += 1;
    }
    setOpen(next);
  }

  function toggle(issue: GithubIssueRow) {
    if (issue.cardId !== null) return;
    if (selected.has(issue.number)) {
      const next = new Map(selected);
      next.delete(issue.number);
      setSelected(next);
      setLimitNotice(false);
      return;
    }
    if (selected.size >= MAX_BATCH) {
      setLimitNotice(true);
      return;
    }
    const next = new Map(selected);
    next.set(issue.number, issue.title);
    setSelected(next);
    setLimitNotice(false);
  }

  async function submit() {
    const numbers = [...selected.keys()];
    if (numbers.length === 0 || importing) return;
    setImporting(true);
    setImportErrors([]);
    setImportedCount(null);
    setSubmitError(null);
    try {
      const result = await props.importIssues(numbers);
      const failedNumbers = new Set(result.errors.map((issueError) => issueError.number));
      // Prune by the request, not by returned snapshots: pre-existing regular
      // cards have importedIssue null but must still drop out of the selection.
      setSelected((current) => {
        const next = new Map(current);
        for (const number of numbers) {
          if (!failedNumbers.has(number)) next.delete(number);
        }
        return next;
      });
      setImportErrors(result.errors);
      setImportedCount(result.cards.length);
      props.onImported();
      await loadPage(page);
    } catch (cause) {
      setSubmitError(causeMessage(cause));
    } finally {
      setImporting(false);
    }
  }

  const issues = pageData?.issues ?? [];

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Trigger asChild>
        <button type="button" className="pipeline-button" disabled={props.disabled}>
          Import issues
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <div {...portalScope} className="pipeline-ui pipeline-overlay-scope">
          <Dialog.Overlay className="pipeline-dialog-overlay" />
          <Dialog.Content
            className="pipeline-dialog pipeline-import-dialog"
            onInteractOutside={(event) => event.preventDefault()}
          >
            <div className="pipeline-dialog-header">
              <div className="pipeline-dialog-heading">
                <Dialog.Title>Import issues</Dialog.Title>
                <Dialog.Description className="sr-only">
                  Pick open GitHub issues assigned to the connected account and import them to Backlog.
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button type="button" className="pipeline-icon-button" aria-label="Close import issues" disabled={importing}>
                  <Icon name="X" />
                </button>
              </Dialog.Close>
            </div>
            <div className="pipeline-import-body">
              <p className="pipeline-import-source">
                <Icon name="Folder" />
                {pageData === null ? <span>Loading repository…</span> : (
                  <span>{pageData.repository} · assigned to {pageData.viewer}</span>
                )}
                <button
                  type="button"
                  className="pipeline-button pipeline-ghost pipeline-import-refresh"
                  disabled={pageLoading || importing}
                  onClick={() => void loadPage(page)}
                >
                  <Icon name="RotateCcw" /> Refresh list
                </button>
              </p>
              {pageError !== null ? (
                <div role="alert" className="pipeline-import-notice pipeline-import-notice-error">
                  <Icon name="AlertCircle" />
                  <span>{pageError}</span>
                  <button type="button" className="pipeline-button pipeline-ghost" disabled={pageLoading} onClick={() => void loadPage(page)}>
                    <Icon name="RotateCcw" /> Retry
                  </button>
                </div>
              ) : pageLoading && pageData === null ? (
                <p role="status" className="pipeline-import-status">Loading issues…</p>
              ) : issues.length === 0 ? (
                <p className="pipeline-import-status">
                  {pageData === null ? "Loading issues…" : `No open issues assigned to ${pageData.viewer}.`}
                </p>
              ) : (
                <ul className="pipeline-import-list" aria-busy={pageLoading}>
                  {issues.map((issue) => {
                    const added = issue.cardId !== null;
                    return (
                      <li key={issue.number} className="pipeline-import-item" data-added={added}>
                        <label>
                          <input
                            type="checkbox"
                            aria-label={`Import issue ${issue.number}`}
                            checked={selected.has(issue.number)}
                            disabled={importing || added}
                            onChange={() => toggle(issue)}
                          />
                          <span className="pipeline-import-title">
                            <span className="pipeline-import-number">#{issue.number}</span>
                            {issue.title}
                          </span>
                          {issue.labels.length === 0 ? null : (
                            <span className="pipeline-import-labels">
                              {issue.labels.map((label) => (
                                <span key={label} className="pipeline-import-label">{label}</span>
                              ))}
                            </span>
                          )}
                          {added ? <span className="pipeline-github-chip" data-tone="neutral">Added</span> : null}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              {limitNotice || selected.size >= MAX_BATCH ? (
                <p className="pipeline-import-status">You can import up to {MAX_BATCH} issues at once.</p>
              ) : null}
              {importedCount !== null ? (
                <p role="status" className="pipeline-import-notice pipeline-import-notice-ok">
                  <Icon name="Play" />
                  <span>Imported {importedCount} issue{importedCount === 1 ? "" : "s"} to Backlog.</span>
                </p>
              ) : null}
              {importErrors.length > 0 ? (
                <div role="alert" className="pipeline-import-notice pipeline-import-notice-error">
                  <Icon name="AlertCircle" />
                  <span>
                    Could not import {importErrors.length} issue{importErrors.length === 1 ? "" : "s"}:
                    <ul className="pipeline-import-error-list">
                      {importErrors.map((issueError) => (
                        <li key={issueError.number}>#{issueError.number}: {issueError.message}</li>
                      ))}
                    </ul>
                  </span>
                </div>
              ) : null}
              {submitError === null ? null : (
                <p role="alert" className="pipeline-import-notice pipeline-import-notice-error">
                  <Icon name="AlertCircle" />
                  <span>{submitError}</span>
                </p>
              )}
            </div>
            <div className="pipeline-import-footer">
              <div className="pipeline-import-paging">
                <button
                  type="button"
                  className="pipeline-button pipeline-ghost"
                  disabled={page <= 1 || pageLoading || importing}
                  onClick={() => void loadPage(page - 1)}
                >
                  <Icon name="ChevronLeft" /> Previous
                </button>
                <span className="pipeline-import-page">Page {page}</span>
                <button
                  type="button"
                  className="pipeline-button pipeline-ghost"
                  disabled={pageData === null || !pageData.hasMore || pageLoading || importing}
                  onClick={() => void loadPage(page + 1)}
                >
                  Next <Icon name="ChevronRight" />
                </button>
              </div>
              <div className="pipeline-form-footer">
                <Dialog.Close asChild>
                  <button type="button" className="pipeline-button pipeline-ghost" disabled={importing}>Cancel</button>
                </Dialog.Close>
                <button
                  type="button"
                  className="pipeline-button pipeline-primary"
                  disabled={importing || selected.size === 0}
                  onClick={() => void submit()}
                >
                  <Icon name={importing ? "Loading" : "Plus"} className={importing ? "pipeline-spin" : ""} />
                  Import {selected.size === 0 ? "" : `${selected.size} `}issue{selected.size === 1 ? "" : "s"}
                </button>
              </div>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
