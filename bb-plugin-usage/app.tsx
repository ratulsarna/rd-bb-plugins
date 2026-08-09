import { definePluginApp } from "@bb/plugin-sdk/app";
import { UsageHeader } from "@/components/usage-header";
import { UsagePanel } from "@/components/usage-panel";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "Gauge",
    path: "usage",
    component: UsagePanel,
    headerContent: UsageHeader,
  });
});
