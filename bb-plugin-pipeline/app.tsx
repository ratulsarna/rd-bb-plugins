import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PipelineSettingsLink } from "./components/settings";
import { PipelineBoard } from "./components/board";
import "./components/pipeline.css";

export default definePluginApp((app) => {
  app.slots.settingsSection({ id: "settings", component: PipelineSettingsLink });
  app.slots.navPanel({
    id: "board",
    title: "Pipeline",
    icon: "Columns2",
    path: "board",
    component: PipelineBoard,
  });
});
