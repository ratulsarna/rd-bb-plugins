import type { PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { ThreadInbox } from "../ThreadInbox";
import { BotsSection } from "./bots-section";

/**
 * The rd sidebar: the assistant fleet's Bots section on top of the upstream
 * thread list. Bots owns its rows (one per assistant, drag-ordered), the
 * inbox owns everything else, and the assistants project never reaches the
 * inbox's shelves or project picker — see the rd patch in ThreadInbox.
 */
export function InboxWithBots(props: PluginThreadListProps) {
  return (
    <>
      <BotsSection
        activeThreadId={props.activeThreadId}
        isCompactViewport={props.isCompactViewport}
        onNavigate={props.onNavigate}
        searchQuery={props.searchQuery}
      />
      <ThreadInbox {...props} />
    </>
  );
}
