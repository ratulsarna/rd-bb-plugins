import { useCallback, useMemo, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  useBbNavigate,
  useRpc,
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { ComposeDialog } from "@/components/compose-dialog";
import { CollapsibleSection } from "@/components/section";
import { SortableRows } from "@/components/sortable-rows";
import type { RowReorder } from "@/components/sidebar-row";
import { assistantDisplayOrder, projectAssistantReorder } from "@/lib/assistant-order";
import { selectedAssistantsProjectId } from "@/lib/assistant-identity";
import { useAssistantAvatars } from "@/lib/use-assistant-avatars";
import { useAssistantIdentities } from "@/lib/use-assistant-identities";
import { useAssistantMemoryWarnings } from "@/lib/use-assistant-memory";
import { useAssistantOrder } from "@/lib/use-assistant-order";
import { useAssistantSubtitles } from "@/lib/use-assistant-subtitles";
import { usePortalScopeProps } from "@/lib/portal-scope";
import type { boardRpcContract } from "@/server";

interface BotsSectionProps {
  activeThreadId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
}

/** Rows shown until "Show more"; the rest stay a click away. */
const PREVIEW_COUNT = 3;

/**
 * The assistant fleet as the board's top section: one row per root conversation,
 * like a messenger's conversation list. Rows order by hand — drag one, the
 * whole order lands in the plugin's store — and new assistants append at the
 * bottom by activity until placed.
 *
 * Child threads are an assistant's workers, not assistants — only root
 * threads get rows.
 */
export function BotsSection({
  activeThreadId,
  isCompactViewport,
  onNavigate,
  searchQuery,
}: BotsSectionProps) {
  const { threads, projects } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const navigate = useBbNavigate();
  const { subtitles, set: setSubtitle } = useAssistantSubtitles();
  const memoryWarnings = useAssistantMemoryWarnings();
  const order = useAssistantOrder();
  const [restartThreadId, setRestartThreadId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const projectId = selectedAssistantsProjectId(projects);

  const isSearching = searchQuery.trim().length > 0;

  // Environments behind the fleet's rows; identities are derived for all of
  // them in one round-trip.
  const environmentIds = useMemo(
    () =>
      projectId
        ? threads.flatMap(
            (thread) =>
              thread.projectId === projectId &&
              thread.parentThreadId === null &&
              !thread.isArchived &&
              thread.environment?.id
                ? [thread.environment.id]
                : [],
          )
        : [],
    [projectId, threads],
  );
  const identitiesApi = useAssistantIdentities(environmentIds);
  const identities = identitiesApi.identities;

  const allRows = useMemo(() => {
    if (!projectId) return [];
    return assistantDisplayOrder(
      threads
        .filter(
          (thread) =>
            thread.projectId === projectId &&
            thread.parentThreadId === null &&
            !thread.isArchived,
        )
        .map((thread) => ({
          thread,
          environmentId: thread.environment?.id ?? null,
          // Display can fall back while resolution keeps moves disabled.
          identity: thread.environment?.id
            ? (identities.get(thread.environment.id) ??
              thread.environment.id)
            : null,
          updatedAt: thread.updatedAt,
        })),
      order.ids,
    );
  }, [identities, order.ids, projectId, threads]);

  // Row identity is the thread id — always unique. Environment ids are NOT:
  // an automation run in an assistant's home shares its environment, and two
  // rows under one key leave React's list reconciliation stranding ghost rows
  // when one of them goes away.
  //
  // Neighbours for a drag come from every bot, never from a searched view — a
  // hidden row is still the one the dropped row lands beside.
  const fullOrder = useMemo(
    () => allRows.map((row) => row.thread.id),
    [allRows],
  );

  const rows = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (query === "") return allRows;
    return allRows.filter((row) =>
      nameOf(row.thread).toLowerCase().includes(query),
    );
  }, [allRows, searchQuery]);

  const openThread = useCallback(
    (threadId: string) => {
      actions.open(threadId);
      onNavigate();
    },
    [actions, onNavigate],
  );

  // Archived threads are not in the sidebar list, which `actions.open` ignores.
  const openPastThread = useCallback(
    (threadId: string) => {
      navigate.toThread(threadId);
      onNavigate();
    },
    [navigate, onNavigate],
  );

  const restartThread = useCallback((threadId: string) => {
    setRestartThreadId(threadId);
  }, []);

  const avatars = useAssistantAvatars(environmentIds);

  const moveBot = useCallback(
    (activeId: string, projection: { ids: string[] }) => {
      // A drag that lands before identities resolve would store environment
      // ids over the saved order; the rows are not draggable until then.
      if (!identitiesApi.ready) return false;
      const ids = projectAssistantReorder(
        allRows.map((row) => ({ id: row.thread.id, identity: row.identity })),
        activeId, projection.ids,
      );
      if (!ids) return false;
      order.set(ids);
    },
    [identitiesApi.ready, allRows, order],
  );

  // A search may only match a bot the cap hides — matches always show.
  const capped = !showAll && !isSearching && rows.length > PREVIEW_COUNT;
  const visibleRows = capped ? rows.slice(0, PREVIEW_COUNT) : rows;

  if (!projectId || rows.length === 0) return null;

  return (
    <>
      <CollapsibleSection
        id="bots"
        label="Bots"
        count={rows.length}
        defaultExpanded
        forceExpanded={isSearching}
        headerAction={
          !isSearching && rows.length > PREVIEW_COUNT ? (
            <button
              type="button"
              onClick={() => setShowAll((current) => !current)}
              className="shrink-0 text-[10px] font-medium text-muted-foreground/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {showAll ? "Show less" : "Show more"}
            </button>
          ) : undefined
        }
      >
        <SortableRows
          items={visibleRows}
          idOf={(row) => row.thread.id}
          fullOrder={fullOrder}
          enabled={
            order.ready && identitiesApi.ready && !isCompactViewport
          }
          movePending={order.moving}
          onMove={moveBot}
        >
          {(row, reorder) => (
            <AssistantRow
              key={row.thread.id}
              thread={row.thread}
              avatarUrl={
                (row.environmentId
                  ? avatars.get(row.environmentId)
                  : undefined) ?? null
              }
              subtitle={
                (row.identity
                  ? subtitles.get(row.identity)
                  : undefined) ?? null
              }
              memoryWarning={
                (row.identity
                  ? memoryWarnings.get(row.identity)
                  : undefined) ?? null
              }
              isActive={row.thread.id === activeThreadId}
              isEditingSubtitle={row.thread.id === editingThreadId}
              reorder={reorder}
              onOpen={openThread}
              onOpenPast={openPastThread}
              onRestart={restartThread}
              onEditSubtitle={() => setEditingThreadId(row.thread.id)}
              onSaveSubtitle={(value) => {
                setSubtitle(row.thread.id, value);
                setEditingThreadId(null);
              }}
              onCancelEditSubtitle={() => setEditingThreadId(null)}
            />
          )}
        </SortableRows>
      </CollapsibleSection>
      <ComposeDialog
        replaceThreadId={restartThreadId}
        onClose={() => setRestartThreadId(null)}
        onNavigate={onNavigate}
      />
    </>
  );
}

function AssistantRow({
  thread,
  avatarUrl,
  subtitle,
  memoryWarning,
  isActive,
  isEditingSubtitle,
  reorder,
  onOpen,
  onOpenPast,
  onRestart,
  onEditSubtitle,
  onSaveSubtitle,
  onCancelEditSubtitle,
}: {
  thread: PluginSidebarThread;
  avatarUrl: string | null;
  subtitle: string | null;
  /** Shown as a mark; cleared with `bb assistants memory status <thread> --clear`. */
  memoryWarning: string | null;
  isActive: boolean;
  isEditingSubtitle: boolean;
  reorder: RowReorder | undefined;
  onOpen: (threadId: string) => void;
  onOpenPast: (threadId: string) => void;
  onRestart: (threadId: string) => void;
  onEditSubtitle: () => void;
  onSaveSubtitle: (value: string) => void;
  onCancelEditSubtitle: () => void;
}) {
  const name = nameOf(thread);
  const tone = toneOf(thread);
  const { splitProps } = useSidebarThreadSplit(thread.id);
  return (
    <li
      ref={reorder?.setNodeRef}
      className="group flex list-none items-center gap-1"
      data-pinned-reordering={reorder?.isDragging || undefined}
      style={reorder?.style}
    >
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <a
            ref={reorder?.setActivatorNodeRef}
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={[thread.indicatorLabel ?? name, thread.host?.name].filter(Boolean).join(" — ")}
            aria-current={isActive ? "true" : undefined}
            draggable={false}
            onClick={(event) => {
              event.preventDefault();
              if (isEditingSubtitle) return;
              onOpen(thread.id);
            }}
            className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
            } ${reorder ? "select-none touch-manipulation" : ""}`}
            {...(reorder?.attributes ?? {})}
            {...(reorder?.listeners ?? {})}
            {...splitProps}
          >
            {avatarUrl ? (
              <img
                aria-hidden
                alt=""
                src={avatarUrl}
                draggable={false}
                className="size-7 shrink-0 rounded-full object-cover"
              />
            ) : (
              <span
                aria-hidden
                className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-[11px] font-semibold uppercase text-muted-foreground"
              >
                {initialsOf(name)}
              </span>
            )}
            <span className="min-w-0 flex-1">
              <span
                className={`block truncate text-[13px] ${
                  thread.isUnread
                    ? "font-semibold text-foreground"
                    : "font-normal text-foreground/90"
                }`}
              >
                {name}
              </span>
              {thread.host && <span className="block truncate text-[10px] text-muted-foreground/70">{thread.host.name}</span>}
              {isEditingSubtitle ? (
                <input
                  autoFocus
                  defaultValue={subtitle ?? ""}
                  placeholder="What they do"
                  aria-label={`Subtitle for ${name}`}
                  maxLength={200}
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onTouchStart={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.key === "Enter") {
                      onSaveSubtitle(event.currentTarget.value.trim());
                    } else if (event.key === "Escape") {
                      onCancelEditSubtitle();
                    }
                  }}
                  onBlur={onCancelEditSubtitle}
                  className="block w-full border-b border-ring bg-transparent text-[11px] text-muted-foreground outline-none placeholder:text-muted-foreground/50"
                />
              ) : subtitle ? (
                <span className="block truncate text-[11px] text-muted-foreground">
                  {subtitle}
                </span>
              ) : null}
            </span>
            {tone !== "none" && (
              <span
                aria-hidden
                className={`size-2 shrink-0 rounded-full ${
                  tone === "working"
                    ? "animate-pulse bg-success"
                    : tone === "waiting"
                      ? "bg-warning"
                      : "bg-primary"
                }`}
              />
            )}
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              {relativeTime(thread.updatedAt)}
            </span>
          </a>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content
            aria-label={`Actions for ${name}`}
            className="z-50 min-w-44 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <ContextMenu.Item
              onSelect={() => {
                // Let Radix close the menu before the editor takes focus.
                window.setTimeout(onEditSubtitle, 0);
              }}
              className="cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
            >
              Edit subtitle
            </ContextMenu.Item>
            <PastChats threadId={thread.id} onOpen={onOpenPast} />
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      {memoryWarning && (
        <span
          role="img"
          aria-label={`Memory warning: ${memoryWarning}`}
          title={memoryWarning}
          className="shrink-0 px-1 text-[13px] font-semibold text-amber-600"
        >
          !
        </span>
      )}
      <button
        type="button"
        title="New thread"
        aria-label={`New thread with ${name}${thread.host ? ` on ${thread.host.name}` : ""}`}
        onClick={() => onRestart(thread.id)}
        className="shrink-0 rounded-md px-1.5 py-2 text-[13px] text-muted-foreground/50 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ↻
      </button>
    </li>
  );
}

const PAST_SPAN = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** The assistant's archived conversations, fetched each time the submenu opens. */
function PastChats({
  threadId,
  onOpen,
}: {
  threadId: string;
  onOpen: (threadId: string) => void;
}) {
  const rpc = useRpc<typeof boardRpcContract>();
  const portalScope = usePortalScopeProps();
  const [rows, setRows] = useState<Array<{ id: string; createdAt: number; archivedAt: number }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const itemClass =
    "cursor-pointer rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground";
  return (
    <ContextMenu.Sub
      onOpenChange={(open: boolean) => {
        if (!open) return;
        setRows(null);
        setError(null);
        rpc.call("pastAssistantThreads", { threadId }).then(
          (result) => setRows(result.rows),
          (cause: unknown) => setError(String(cause)),
        );
      }}
    >
      <ContextMenu.SubTrigger className={`flex items-center ${itemClass} data-[state=open]:bg-accent`}>
        Past chats
        <HugeiconsIcon icon={ArrowRight01Icon} className="ml-auto size-4 opacity-60" />
      </ContextMenu.SubTrigger>
      <ContextMenu.Portal>
        <ContextMenu.SubContent
          {...portalScope}
          aria-label="Past chats"
          sideOffset={4}
          className="z-50 max-h-80 min-w-44 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {error || rows === null || rows.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {error ?? (rows === null ? "Loading…" : "No past chats")}
            </p>
          ) : (
            rows.map((row) => (
              <ContextMenu.Item key={row.id} onSelect={() => onOpen(row.id)} className={itemClass}>
                {PAST_SPAN.formatRange(row.createdAt, row.archivedAt)}
              </ContextMenu.Item>
            ))
          )}
        </ContextMenu.SubContent>
      </ContextMenu.Portal>
    </ContextMenu.Sub>
  );
}

function nameOf(thread: PluginSidebarThread): string {
  return thread.title ?? thread.titleFallback ?? "Untitled";
}

function initialsOf(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2);
  return words[0][0] + words[1][0];
}

/**
 * One dot per row: is the assistant doing something, blocked on the user, or
 * holding an unread reply. Unknown indicator kinds fall through to "none" —
 * bb adds kinds over time.
 */
function toneOf(
  thread: PluginSidebarThread,
): "none" | "unread" | "waiting" | "working" {
  if (thread.hasPendingInteraction || thread.indicator === "waiting-for-input")
    return "waiting";
  const activity = thread.activity;
  if (
    thread.indicator === "runtime" ||
    activity.workflows +
      activity.backgroundAgents +
      activity.backgroundCommands >
      0
  )
    return "working";
  if (thread.isUnread) return "unread";
  return "none";
}

function relativeTime(epochMs: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - epochMs) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
