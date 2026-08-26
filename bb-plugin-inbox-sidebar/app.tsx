import { definePluginApp } from "@bb/plugin-sdk/app";
import { MODE_TOGGLE_EVENT, ModeSidebar } from "@/components/mode-sidebar";

export default definePluginApp((app) => {
  app.slots.experimental_threadList({
    id: "board",
    title: "Inbox Sidebar",
    description:
      "Code mode: Pinned, Inbox and Settled sections, newest thread first, with subagents nested under their parent. Assistants mode: one row per assistant. The footer button switches modes.",
    component: ModeSidebar,
  });
  // The flip happens in place — no navigation, no origin change — so it works
  // the same in a browser tab and inside an installed PWA.
  app.slots.sidebarFooterAction({
    id: "mode-toggle",
    title: "Switch between code and assistants",
    icon: "ArrowReloadHorizontal",
    run: () => {
      window.dispatchEvent(new Event(MODE_TOGGLE_EVENT));
    },
  });
});
