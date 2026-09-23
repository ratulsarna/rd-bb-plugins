import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttentionNotifier } from "../lib/notifications";
import { createCardStore, MIGRATIONS } from "../lib/store";

const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { while (hosts.length) await hosts.pop()!.harness.lifecycle.dispose(); });

it("applies live category and master preferences while preserving card suppression", async () => {
  const host = createFakePluginHost({ pluginId: "pipeline" });
  hosts.push(host);
  host.harness.inspection.sdk.stub("plugins.callRpc", async () => ({ delivery: "held" }));
  const db = host.bb.storage.database();
  host.bb.storage.migrate(db, [...MIGRATIONS]);
  const store = createCardStore(db);
  store.create({ id: "card", projectId: "project", hostId: "host", title: "Task", body: "", attachments: [], source: "ui" });
  let preferences = { notificationsEnabled: true, notifyQuestions: true, notifyFailures: false, notifyReview: false };
  const notify = createAttentionNotifier(host.bb, () => preferences);
  const card = () => store.get("card")!;
  const calls = () => host.harness.inspection.sdk.callsTo("plugins.callRpc");

  notify(card(), "Question");
  notify(card(), "Failure", "failures");
  notify(card(), "Review", "review");
  expect(calls()).toHaveLength(1);
  expect(calls()[0]![0]).toMatchObject({ pluginId: "notify", method: "send", input: { message: "Question" } });

  preferences = { notificationsEnabled: true, notifyQuestions: false, notifyFailures: true, notifyReview: true };
  notify(card(), "Question 2", "questions");
  notify(card(), "Failure 2", "failures");
  notify(card(), "Review 2", "review");
  expect(calls()).toHaveLength(3);
  expect(calls()[1]![0]).toMatchObject({ input: { message: "Failure 2" } });
  expect(calls()[2]![0]).toMatchObject({ input: { message: "Review 2" } });

  preferences.notificationsEnabled = false;
  notify(card(), "Failure 3", "failures");
  expect(calls()).toHaveLength(3);
  preferences.notificationsEnabled = true;
  expect(calls()).toHaveLength(3);

  store.update("card", { runState: "paused" });
  notify(card(), "Paused", "review");
  store.update("card", { runState: "running", startRequested: false });
  notify(card(), "Saved", "review");
  store.update("card", { startRequested: true, column: "done" });
  notify(card(), "Done", "review");
  expect(calls()).toHaveLength(3);

  store.update("card", { column: "pr" });
  createAttentionNotifier(host.bb)(card(), "Default review", "review");
  expect(calls()).toHaveLength(4);
});
