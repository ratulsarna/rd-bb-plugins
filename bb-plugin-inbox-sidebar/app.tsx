import { definePluginApp } from "@bb/plugin-sdk/app";
import { BoardSidebar } from "@/components/sidebar-list";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "board",
    title: "Inbox Sidebar",
    description:
      "Pinned, Inbox and Settled sections, newest thread first, with subagents nested under their parent.",
    component: BoardSidebar,
  });
});
