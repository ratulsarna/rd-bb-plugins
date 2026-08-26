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
    title: "Switch between code and assistants (Cmd/Ctrl+Shift+S)",
    icon: "ArrowReloadHorizontal",
    run: () => {
      window.dispatchEvent(new Event(MODE_TOGGLE_EVENT));
    },
  });
  // bb's keybinding table is a fixed core-command list, so the shortcut is a
  // plain page listener. Mod+Shift+S is unclaimed by bb (checked against
  // `bb settings keyboard list`) and by the browsers/desktop shell.
  app.contentScripts.register({
    id: "mode-toggle-shortcut",
    mount({ signal }) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (!(event.metaKey || event.ctrlKey)) return;
        if (!event.shiftKey || event.altKey) return;
        if (event.key.toLowerCase() !== "s") return;
        event.preventDefault();
        window.dispatchEvent(new Event(MODE_TOGGLE_EVENT));
      };
      document.addEventListener("keydown", onKeyDown, { signal });
    },
  });
});
