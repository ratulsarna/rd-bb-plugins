import {
  definePluginApp,
  type PluginNavPanelProps,
  type PluginThreadHeaderActionProps,
  useBbNavigate,
} from "@bb/plugin-sdk/app";
import { ThreadBoard } from "@/components/board";
import { BoardSidebar } from "@/components/sidebar-list";

function BoardPanel(_props: PluginNavPanelProps) {
  return <ThreadBoard />;
}

function MobileBoardAction({
  isCompactViewport,
}: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();

  if (!isCompactViewport) return null;

  return (
    <button
      type="button"
      className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-foreground/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Open Board"
      title="Open Board"
      onClick={() => navigate.toPluginPanel("board")}
    >
      <span
        aria-hidden
        className="grid size-4 grid-rows-3 gap-px rounded-[3px] border border-current p-[2px]"
      >
        <span className="rounded-[1px] bg-current" />
        <span className="rounded-[1px] bg-current" />
        <span className="rounded-[1px] bg-current" />
      </span>
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Board",
    icon: "Rows3",
    path: "board",
    component: BoardPanel,
  });

  app.slots.experimental_threadList({
    id: "board",
    title: "Thread Board",
    description:
      "Pinned, Inbox and Settled sections, newest thread first, with subagents nested under their parent.",
    component: BoardSidebar,
  });

  app.slots.experimental_threadHeaderAction({
    id: "back-to-board",
    title: "Board navigation",
    component: MobileBoardAction,
  });
});
