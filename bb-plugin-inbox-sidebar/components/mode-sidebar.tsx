import { useEffect, useState } from "react";
import { useBbNavigate, type PluginThreadListProps } from "@bb/plugin-sdk/app";
import { BoardSidebar } from "@/components/sidebar-list";
import { AssistantList } from "@/components/assistant-list";

/**
 * One sidebar, two modes: the code board and the assistant list. The mode
 * flips in place — no navigation, no origin change — so it works the same in
 * a browser tab and inside an installed PWA. Each mode remembers the thread
 * it last had open and returns to it on toggle.
 */
export type SidebarMode = "code" | "assistants";

const MODE_KEY = "inbox-sidebar:mode";
const lastThreadKey = (mode: SidebarMode) =>
  `inbox-sidebar:last-thread:${mode}`;

/** Fired by the footer action; the mounted sidebar handles the flip. */
export const MODE_TOGGLE_EVENT = "inbox-sidebar:toggle-mode";

function currentMode(): SidebarMode {
  return localStorage.getItem(MODE_KEY) === "assistants"
    ? "assistants"
    : "code";
}

export function ModeSidebar(props: PluginThreadListProps) {
  const [mode, setMode] = useState<SidebarMode>(currentMode);
  const navigate = useBbNavigate();
  const { activeThreadId } = props;

  useEffect(() => {
    if (activeThreadId)
      localStorage.setItem(lastThreadKey(mode), activeThreadId);
  }, [mode, activeThreadId]);

  useEffect(() => {
    const onToggle = () => {
      const next: SidebarMode =
        currentMode() === "code" ? "assistants" : "code";
      localStorage.setItem(MODE_KEY, next);
      setMode(next);
      const last = localStorage.getItem(lastThreadKey(next));
      if (last) navigate.toThread(last);
    };
    window.addEventListener(MODE_TOGGLE_EVENT, onToggle);
    return () => window.removeEventListener(MODE_TOGGLE_EVENT, onToggle);
  }, [navigate]);

  return mode === "assistants" ? (
    <AssistantList {...props} />
  ) : (
    <BoardSidebar {...props} />
  );
}
