import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PipelineBoard } from "./components/board";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Pipeline",
    icon: "Columns",
    path: "board",
    component: PipelineBoard,
  });
});
