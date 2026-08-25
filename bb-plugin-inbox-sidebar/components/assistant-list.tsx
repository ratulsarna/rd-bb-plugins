import { useCallback, useMemo, useState } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import {
  experimental_useSidebarThreadActions as useSidebarThreadActions,
  experimental_useSidebarThreads as useSidebarThreads,
  type PluginSidebarThread,
  type PluginThreadListProps,
} from "@bb/plugin-sdk/app";
import { ComposeDialog } from "@/components/compose-dialog";
import { useAssistantAvatars } from "@/lib/use-assistant-avatars";
import { useAssistantSubtitles } from "@/lib/use-assistant-subtitles";

/** The project whose root threads are the assistants. */
const ASSISTANTS_PROJECT_NAME = "assistants";

/**
 * The assistant world as bb's sidebar thread list: one row per assistant,
 * newest activity first, like a messenger's conversation list.
 *
 * The host owns the search field above the list, so this filters by the
 * `searchQuery` prop. Child threads are an assistant's workers, not
 * assistants — only root threads get rows.
 */
export function AssistantList({
  activeThreadId,
  onNavigate,
  searchQuery,
}: PluginThreadListProps) {
  const { status, threads, projects } = useSidebarThreads();
  const actions = useSidebarThreadActions();
  const { subtitles, set: setSubtitle } = useAssistantSubtitles();
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

  const rows = useMemo(() => {
    if (!project) return [];
    const query = searchQuery.trim().toLowerCase();
    return threads
      .filter(
        (thread) =>
          thread.projectId === project.id &&
          thread.parentThreadId === null &&
          !thread.isArchived &&
          (query === "" || nameOf(thread).toLowerCase().includes(query)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [project, searchQuery, threads]);

  const environmentIds = useMemo(
    () =>
      rows.flatMap((thread) =>
        thread.environment?.id ? [thread.environment.id] : [],
      ),
    [rows],
  );
  const avatars = useAssistantAvatars(environmentIds);

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

  if (status === "error") {
    return (
      <p role="status" className="px-3 py-6 text-center text-xs text-destructive">
        Could not load assistants.
      </p>
    );
  }
  if (status === "loading") return null;

  if (!project) {
    return (
      <p role="status" className="px-3 py-6 text-center text-xs text-muted-foreground">
        No project named &ldquo;{ASSISTANTS_PROJECT_NAME}&rdquo; yet. Create it
        and its threads appear here.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 pt-1">
        {rows.length === 0 ? (
          <p role="status" className="px-2 py-6 text-center text-xs text-muted-foreground">
            {searchQuery.trim() ? "No assistants found" : "No assistants yet"}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {rows.map((thread) => (
              <AssistantRow
                key={thread.id}
                thread={thread}
                avatarUrl={
                  (thread.environment?.id
                    ? avatars.get(thread.environment.id)
                    : undefined) ?? null
                }
                subtitle={
                  (thread.environment?.id
                    ? subtitles.get(thread.environment.id)
                    : undefined) ?? null
                }
                isActive={thread.id === activeThreadId}
                isEditingSubtitle={thread.id === editingThreadId}
                onOpen={openThread}
                onRestart={restartThread}
                onEditSubtitle={() => setEditingThreadId(thread.id)}
                onSaveSubtitle={(value) => {
                  setSubtitle(thread.id, value);
                  setEditingThreadId(null);
                }}
                onCancelEditSubtitle={() => setEditingThreadId(null)}
              />
            ))}
          </ul>
        )}
      </div>
      <ComposeDialog
        replaceThreadId={restartThreadId}
        onClose={() => setRestartThreadId(null)}
        onNavigate={onNavigate}
      />
    </div>
  );
}

function AssistantRow({
  thread,
  avatarUrl,
  subtitle,
  isActive,
  isEditingSubtitle,
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
  onOpen: (threadId: string) => void;
  onRestart: (threadId: string) => void;
  onEditSubtitle: () => void;
  onSaveSubtitle: (value: string) => void;
  onCancelEditSubtitle: () => void;
}) {
  const name = nameOf(thread);
  const tone = toneOf(thread);
  return (
    <li className="group flex list-none items-center gap-1">
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <a
            data-sidebar-thread-shortcut-target=""
            data-sidebar-thread-id={thread.id}
            href="#"
            aria-label={thread.indicatorLabel ?? name}
            aria-current={isActive ? "true" : undefined}
            onClick={(event) => {
              event.preventDefault();
              if (isEditingSubtitle) return;
              onOpen(thread.id);
            }}
            className={`flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
              isActive ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
            }`}
          >
            {avatarUrl ? (
              <img
                aria-hidden
                alt=""
                src={avatarUrl}
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
