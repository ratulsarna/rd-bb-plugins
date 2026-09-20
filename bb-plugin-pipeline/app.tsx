import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { PipelineBoard } from "./components/board";
import "./components/pipeline.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Pipeline",
    icon: "Columns2",
    path: "board",
    component: PipelineBoard,
  });
});
