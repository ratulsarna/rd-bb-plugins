import { definePluginApp, type PluginThreadListProps } from "@get-bb/plugin-sdk/app";
import { BoardSidebar } from "inbox-core/components/sidebar-list";
import { BotsSection } from "@/components/bots-section";
import { useBotsData } from "@/lib/use-bots-data";

// The board is inbox-core's; this plugin contributes the Bots section on top
// and keeps the assistants project out of the inbox lanes and the picker.
function AssistantsSidebar(props: PluginThreadListProps) {
  const bots = useBotsData();
  return (
    <BoardSidebar
      {...props}
      excludedProjectId={bots.projectId}
      topSectionLoading={!bots.loaded}
      topSection={
        <BotsSection
          bots={bots}
          activeThreadId={props.activeThreadId}
          isCompactViewport={props.isCompactViewport}
          onNavigate={props.onNavigate}
          searchQuery={props.searchQuery}
        />
      }
    />
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "board",
    title: "Assistants",
    description:
      "One list: a Bots section with one row per assistant on top, then Pinned, Inbox and Settled, every section behind a collapsible header.",
    component: AssistantsSidebar,
  });
});
