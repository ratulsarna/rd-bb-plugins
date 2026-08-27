import { definePluginApp } from "@bb/plugin-sdk/app";
import { BoardSidebar } from "@/components/sidebar-list";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "board",
    title: "Inbox Sidebar",
    description:
      "One list: a Bots section with one row per assistant on top, then Pinned, Inbox and Settled, every section behind a collapsible header.",
    component: BoardSidebar,
  });
});
