// bb-plugin-subagent-dashboard — frontend entry.
//
// Surfaces the Subagent Dashboard in two places, both rendering the single
// reusable <SubagentDashboard>: a top-level "Subagents" nav panel scoped to
// the current project when available (or all projects from the personal
// workspace), and a per-thread panel scoped to that thread's direct children.
import {
  definePluginApp,
  type PluginNavPanelProps,
  type PluginThreadPanelProps,
} from "@bb/plugin-sdk/app";
import { SubagentDashboard } from "@/components/subagent-dashboard";

function SubagentsNavPanel(_props: PluginNavPanelProps) {
  return (
    <div className="p-4">
      <SubagentDashboard projectId={null} parentThreadId={null} />
    </div>
  );
}

function SubagentsThreadPanel({ threadId }: PluginThreadPanelProps) {
  return <SubagentDashboard projectId={null} parentThreadId={threadId} />;
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "subagents",
    title: "Subagents",
    icon: "Workflow",
    path: "subagents",
    component: SubagentsNavPanel,
  });

  app.slots.threadPanelAction({
    id: "subagents",
    title: "Subagents",
    icon: "Workflow",
    component: SubagentsThreadPanel,
  });
});
