import { definePluginApp } from "@bb/plugin-sdk/app";
import { VoiceControl } from "@/components/voice-control";

export default definePluginApp((app) => {
  app.slots.experimental_threadHeaderAction({
    id: "voice",
    title: "Voice",
    component: VoiceControl,
  });
});
