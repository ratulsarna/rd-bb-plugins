import { useCallback, useMemo, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  experimental_useSidebarThreadSplit as useSidebarThreadSplit,
  type PluginSidebarThread,
} from "@bb/plugin-sdk/app";
import { ComposeDialog } from "@/components/compose-dialog";
import { CollapsibleSection } from "@/components/section";
import { SortableRows } from "@/components/sortable-rows";
import type { RowReorder } from "@/components/sidebar-row";
import { assistantDisplayOrder, orderableIds } from "@/lib/assistant-order";
import { useAssistantAvatars } from "@/lib/use-assistant-avatars";
import { useAssistantOrder } from "@/lib/use-assistant-order";
import { useAssistantSubtitles } from "@/lib/use-assistant-subtitles";
import { ASSISTANTS_PROJECT_NAME } from "@/lib/use-board-state";

interface BotsSectionProps {
  activeThreadId: string | null;
  isCompactViewport: boolean;
  onNavigate: () => void;
  searchQuery: string;
}

/**
 * The assistant fleet as the board's top section: one row per assistant,
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
  const { subtitles, set: setSubtitle } = useAssistantSubtitles();
  const order = useAssistantOrder();
  const [restartThreadId, setRestartThreadId] = useState<string | null>(null);
  const [editingThreadId, setEditingThreadId] = useState<string | null>(null);

  const project = useMemo(
    () =>
      projects.find(
        (candidate) =>
          candidate.name.toLowerCase() === ASSISTANTS_PROJECT_NAME,
      ) ?? null,
    [projects],
  );

  const isSearching = searchQuery.trim().length > 0;

  const allRows = useMemo(() => {
    if (!project) return [];
    return assistantDisplayOrder(
      threads
        .filter(
          (thread) =>
            thread.projectId === project.id &&
            thread.parentThreadId === null &&
            !thread.isArchived,
        )
        .map((thread) => ({
          thread,
          environmentId: thread.environment?.id ?? null,
          updatedAt: thread.updatedAt,
        })),
      order.ids,
    );
  }, [order.ids, project, threads]);

  // Neighbours for a drag come from every bot, never from a searched view — a
  // hidden row is still the one the dropped row lands beside.
  const fullOrder = useMemo(() => orderableIds(allRows), [allRows]);

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

  const restartThread = useCallback((threadId: string) => {
    setRestartThreadId(threadId);
  }, []);

  const avatars = useAssistantAvatars(fullOrder);

  const moveBot = useCallback(
    (_activeId: string, projection: { ids: string[] }) =>
      order.set(projection.ids),
    [order],
  );

  if (!project || rows.length === 0) return null;

  return (
    <>
      <CollapsibleSection
        id="bots"
        label="Bots"
        count={rows.length}
        defaultExpanded
        forceExpanded={isSearching}
      >
        <SortableRows
          items={rows}
          idOf={(row) => row.environmentId ?? row.thread.id}
          fullOrder={fullOrder}
          enabled={order.ready && !isCompactViewport}
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
                (row.environmentId
                  ? subtitles.get(row.environmentId)
                  : undefined) ?? null
              }
              isActive={row.thread.id === activeThreadId}
              isEditingSubtitle={row.thread.id === editingThreadId}
              reorder={reorder}
              onOpen={openThread}
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
  isActive,
  isEditingSubtitle,
  reorder,
  onOpen,
  onRestart,
  onEditSubtitle,
  onSaveSubtitle,
  onCancelEditSubtitle,
}: {
  thread: PluginSidebarThread;
  avatarUrl: string | null;
  subtitle: string | null;
  isActive: boolean;
  isEditingSubtitle: boolean;
  reorder: RowReorder | undefined;
  onOpen: (threadId: string) => void;
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
            aria-label={thread.indicatorLabel ?? name}
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
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <button
        type="button"
        title="New thread"
        aria-label={`New thread with ${name}`}
        onClick={() => onRestart(thread.id)}
        className="shrink-0 rounded-md px-1.5 py-2 text-[13px] text-muted-foreground/50 hover:bg-sidebar-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        ↻
      </button>
    </li>
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
