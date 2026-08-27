// bb-plugin-notify — notifications for BB thread lifecycle events.
//
// BB notifies agents (parent threads, workflow completions) but never notifies
// the person. This plugin closes that gap: it listens to thread.idle and
// thread.failed and sends one shared notification to the desktop queue and
// subscribed phones. Agents and scripts use that same path through the
// `notify_user` tool and `bb notify` command.
//
// One formatter feeds two delivery transports. The BB app window posts the
// desktop alert so macOS credits BB, while standards-based Web Push sends the
// same alert to each subscribed Home Screen app. When neither app is in the
// foreground and no desktop window is open, that copy waits in a short queue.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import type { Context } from "hono";
import { z } from "zod";

import {
  notificationLines,
  notificationUrl,
  oneLine,
  parseSeconds,
  parseSendArgs,
  plainText,
  suppressionReason,
  threadLabel,
} from "./format.ts";
import { latestRunWasManuallyStopped } from "./lifecycle.ts";
import { ForegroundPresence, InvalidPresenceError } from "./presence.ts";
import {
  NotificationQueue,
  QUEUE_MAX,
  type LeaseResult,
  type NotificationInput,
} from "./queue.ts";
import { SERVICE_WORKER_SOURCE } from "./service-worker.ts";
import { playSound, resolveSound, SOUND_OFF, SOUND_OPTIONS } from "./sound.ts";
import {
  THREAD_NOTIFICATION_CHANNEL,
  type ThreadNotificationChange,
} from "./thread-notification.ts";
import {
  createWebPushOwner,
  createWebPushPayload,
  InvalidSubscriptionError,
} from "./web-push.ts";

const BODY_MAX_CHARS = 160;
/** How long a long-poll is held open before returning an empty batch. */
const POLL_HOLD_MS = 25_000;
/** A window that polled this recently still counts as able to display. */
const RENDERER_TTL_MS = 40_000;
/** Two events about one thread inside this window collapse into the first. */
const DEDUPE_WINDOW_MS = 3_000;
/** Bounds the in-memory per-thread maps on a long-lived server. */
const MAX_TRACKED_THREADS = 500;
/** How long a cached project name is trusted before it is read again. */
const PROJECT_NAME_TTL_MS = 5 * 60_000;
const THREAD_NOTIFICATION_KEY_PREFIX = "thread-notification:";

type DeliveryResult = "skipped" | "queued" | "held";
type ThreadDeliveryResult = DeliveryResult | "disabled";

export const rpcContract = defineRpcContract({
  getThreadNotification: {
    input: z.object({ threadId: z.string().min(1).max(256) }).strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
  setThreadNotification: {
    input: z
      .object({
        threadId: z.string().min(1).max(256),
        enabled: z.boolean(),
      })
      .strict(),
    output: z.object({ enabled: z.boolean() }).strict(),
  },
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    notifyOnIdle: {
      type: "boolean",
      label: "Notify when a thread finishes",
      default: true,
    },
    notifyOnFailed: {
      type: "boolean",
      label: "Notify when a thread fails",
      default: true,
    },
    includeChildThreads: {
      type: "boolean",
      label: "Include child threads",
      description: "Subagent threads are noisy; off by default.",
      default: false,
    },
    includeHiddenThreads: {
      type: "boolean",
      label: "Include hidden threads",
      description: "Background plugin workers are hidden threads.",
      default: false,
    },
    minRunSeconds: {
      type: "string",
      label: "Minimum run time (seconds)",
      description:
        "Skip threads that finished faster than this. A thread whose start the plugin never saw always notifies.",
      default: "0",
    },
    sound: {
      type: "select",
      label: "Sound",
      description:
        "Named tones play when the BB server runs on macOS. Other devices use their system sound.",
      options: [...SOUND_OPTIONS],
      default: SOUND_OFF,
    },
    agentTool: {
      type: "boolean",
      label: "Give agents a notify_user tool",
      description: "Lets an agent interrupt you deliberately. Off until you want that.",
      default: false,
    },
  });

  // configure() is synchronous, so the latest values are mirrored here rather
  // than awaited per resolution.
  let current = await settings.get();
  settings.onChange((next) => {
    current = next;
    bb.log.info("settings changed");
  });

  const threadNotificationKey = (threadId: string) =>
    `${THREAD_NOTIFICATION_KEY_PREFIX}${threadId}`;
  const isThreadNotificationEnabled = async (threadId: string) =>
    (await bb.storage.kv.get<boolean>(threadNotificationKey(threadId))) === true;

  bb.rpc.register(rpcContract, {
    async getThreadNotification({ threadId }) {
      return { enabled: await isThreadNotificationEnabled(threadId) };
    },
    async setThreadNotification({ threadId, enabled }) {
      if (enabled) {
        await bb.storage.kv.set(threadNotificationKey(threadId), true);
      } else {
        await bb.storage.kv.delete(threadNotificationKey(threadId));
      }
      bb.realtime.publish(THREAD_NOTIFICATION_CHANNEL, {
        threadId,
        enabled,
      } satisfies ThreadNotificationChange);
      return { enabled };
    },
  });

  // --- The delivery queue ---------------------------------------------------
  //
  // One window at a time holds a long-poll open here. A delivered batch stays
  // persisted under a lease until the renderer acknowledges the notifications
  // it constructed. A dropped response therefore retries instead of vanishing.
  const notifications = new NotificationQueue(bb.storage.kv);
  const foreground = new ForegroundPresence();
  const webPush = createWebPushOwner(bb);
  const pushDeliveries = new Set<Promise<void>>();
  const waiters = new Set<() => void>();
  let lastPollAt = 0;
  let soundPlayback = Promise.resolve();

  /** True while a BB window is polling, or has polled recently enough. */
  function windowIsListening(): boolean {
    return waiters.size > 0 || Date.now() - lastPollAt < RENDERER_TTL_MS;
  }

  function wakeWaiters(): void {
    for (const wake of waiters) wake();
  }

  async function enqueue(item: NotificationInput): Promise<boolean> {
    await notifications.enqueue(item);
    const listening = windowIsListening();
    wakeWaiters();
    bb.log.debug(`${listening ? "queued" : "held"} — opens ${item.threadId ?? "nothing"}`);
    return listening;
  }

  async function leaseForRenderer(): Promise<LeaseResult> {
    const delivery = await notifications.lease();
    if (delivery.lease === null || !foreground.isForeground()) return delivery;

    await notifications.acknowledge(
      delivery.lease.id,
      delivery.lease.notifications.map((item) => item.id),
    );
    bb.log.debug(
      `skipped ${delivery.lease.notifications.length} held desktop notification${delivery.lease.notifications.length === 1 ? "" : "s"}; BB is foreground`,
    );
    return { lease: null, retryAfterMs: 0 };
  }

  function sendWebPush(item: NotificationInput, silent: boolean): void {
    const delivery = webPush
      .send(
        createWebPushPayload({
          title: item.title,
          body: item.body,
          url: item.url,
          silent,
        }),
      )
      .then(() => undefined)
      .catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        bb.log.warn(`web push fanout failed: ${detail}`);
      });
    pushDeliveries.add(delivery);
    void delivery.finally(() => pushDeliveries.delete(delivery));
  }

  function waitForQueue(signal: AbortSignal, holdMs: number): Promise<void> {
    if (signal.aborted || holdMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      // Reachable from three directions — a new notification, the hold
      // expiring, and the client hanging up. The first one through disarms
      // the other two, so the body runs exactly once.
      const settle = () => {
        waiters.delete(settle);
        clearTimeout(timer);
        signal.removeEventListener("abort", settle);
        // oxlint-disable-next-line promise/no-multiple-resolved
        resolve();
      };
      const timer = setTimeout(settle, holdMs);
      signal.addEventListener("abort", settle, { once: true });
      waiters.add(settle);
    });
  }

  bb.http.route("GET", "/pending", async (context) => {
    const { signal } = context.req.raw;
    lastPollAt = Date.now();
    let delivery = await leaseForRenderer();
    if (delivery.lease === null) {
      const holdMs = Math.min(POLL_HOLD_MS, delivery.retryAfterMs ?? POLL_HOLD_MS);
      await waitForQueue(signal, holdMs);
      // Do not acquire a lease for a response whose client has already gone.
      if (signal.aborted) {
        return context.json({ leaseId: null, notifications: [] });
      }
      delivery = await leaseForRenderer();
    }
    lastPollAt = Date.now();
    return context.json({
      leaseId: delivery.lease?.id ?? null,
      notifications: delivery.lease?.notifications ?? [],
    });
  });

  bb.http.route("POST", "/ack", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const leaseId = isRecord(body) ? body.leaseId : undefined;
    const notificationIds = isRecord(body) ? body.notificationIds : undefined;
    const displayed = isRecord(body) ? body.displayed : undefined;
    if (
      typeof leaseId !== "string" ||
      leaseId === "" ||
      leaseId.length > 128 ||
      !Array.isArray(notificationIds) ||
      notificationIds.length > QUEUE_MAX ||
      notificationIds.some((id) => !Number.isSafeInteger(id) || (id as number) < 1) ||
      (displayed !== undefined && typeof displayed !== "boolean")
    ) {
      return context.json({ ok: false, error: "invalid acknowledgement" }, 400);
    }
    const result = await notifications.acknowledge(leaseId, notificationIds as number[]);
    const sound = result.play;
    if (sound !== null && displayed !== false) {
      // One tone per acknowledged batch, serialized so a group of completed
      // threads does not launch overlapping afplay processes.
      soundPlayback = soundPlayback.then(() => playSound(sound));
    }
    return context.json({ ok: true, acknowledged: result.acknowledged });
  });

  bb.http.route("POST", "/foreground", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    try {
      const active = foreground.update(
        isRecord(body) ? body.pageId : undefined,
        isRecord(body) ? body.foreground : undefined,
      );
      if (active) wakeWaiters();
      return context.json({ ok: true, foreground: active });
    } catch (error) {
      if (error instanceof InvalidPresenceError) {
        return context.json({ ok: false, error: error.message }, 400);
      }
      throw error;
    }
  });

  bb.http.route("GET", "/web-push/service-worker.js", () =>
    new Response(SERVICE_WORKER_SOURCE, {
      headers: {
        "cache-control": "no-cache",
        "content-type": "application/javascript; charset=utf-8",
      },
    }),
  );

  function pushRouteError(context: Context, error: unknown): Response {
    if (error instanceof InvalidSubscriptionError) {
      return context.json({ ok: false, error: error.message }, 400);
    }
    const detail = error instanceof Error ? error.message : String(error);
    bb.log.warn(`web push route failed: ${detail}`);
    return context.json({ ok: false, error: "Web Push request failed." }, 500);
  }

  bb.http.route("POST", "/web-push/status", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    const endpoint = isRecord(body) ? body.endpoint : undefined;
    if (endpoint !== null && typeof endpoint !== "string") {
      return context.json({ ok: false, error: "Invalid push endpoint." }, 400);
    }
    try {
      return context.json(webPush.status(endpoint));
    } catch (error) {
      return pushRouteError(context, error);
    }
  });

  bb.http.route("POST", "/web-push/subscribe", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    try {
      return context.json(webPush.subscribe(body));
    } catch (error) {
      return pushRouteError(context, error);
    }
  });

  bb.http.route("POST", "/web-push/unsubscribe", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    try {
      return context.json(webPush.unsubscribe(isRecord(body) ? body.endpoint : undefined));
    } catch (error) {
      return pushRouteError(context, error);
    }
  });

  bb.http.route("POST", "/web-push/test", async (context) => {
    const body: unknown = await context.req.json().catch(() => null);
    try {
      const result = await webPush.test(
        isRecord(body) ? body.endpoint : undefined,
        resolveSound(current.sound).pushSilent,
      );
      if (result === "sent") return context.json({ ok: true });
      if (result === "missing") {
        return context.json({ ok: false, error: "This device is not subscribed." }, 404);
      }
      if (result === "expired") {
        return context.json({ ok: false, error: "This subscription expired." }, 410);
      }
      return context.json({ ok: false, error: "The push service rejected the test." }, 502);
    } catch (error) {
      return pushRouteError(context, error);
    }
  });

  /**
   * Format once, persist the desktop copy, then fan out phone copies without
   * making phone delivery part of the desktop queue's success path.
   */
  async function post(
    project: string | null,
    projectId: string | null,
    threadName: string,
    message: string,
    threadId: string | null,
  ): Promise<DeliveryResult> {
    if (foreground.isForeground()) {
      bb.log.debug(`skipped notification; BB is foreground; opens ${threadId ?? "nothing"}`);
      return "skipped";
    }
    const { desktopSilent, pushSilent, play } = resolveSound(current.sound);
    const { title, body } = notificationLines(project, oneLine(threadName, 90), message);
    const item = {
      title: oneLine(title, 90),
      body: oneLine(body, BODY_MAX_CHARS),
      threadId,
      url: notificationUrl(projectId, threadId),
      silent: desktopSilent,
      play,
    };
    const listening = await enqueue(item);
    sendWebPush(item, pushSilent);
    return listening ? "queued" : "held";
  }

  async function postForThread(
    project: string | null,
    projectId: string | null,
    threadName: string,
    message: string,
    threadId: string,
  ): Promise<ThreadDeliveryResult> {
    if (!(await isThreadNotificationEnabled(threadId))) {
      bb.log.debug(
        `skipped notification; thread notifications are disabled; opens ${threadId}`,
      );
      return "disabled";
    }
    return post(project, projectId, threadName, message, threadId);
  }

  // Bounded by the number of projects, which is small — the TTL is here for
  // freshness, not size. Without it a renamed project would keep tagging
  // notifications with its old name for the life of the server.
  const projectNames = new Map<string, { name: string; readAt: number }>();
  async function projectName(projectId: string): Promise<string | null> {
    const cached = projectNames.get(projectId);
    if (cached !== undefined && Date.now() - cached.readAt < PROJECT_NAME_TTL_MS) {
      return cached.name;
    }
    try {
      const project = await bb.sdk.projects.get({ projectId });
      projectNames.set(projectId, { name: project.name, readAt: Date.now() });
      return project.name;
    } catch {
      // A refresh that fails should not strip the tag off the notification;
      // the last known name is still better than no name.
      return cached?.name ?? null;
    }
  }

  const startedAt = new Map<string, { at: number }>();
  const notifiedAt = new Map<string, number>();

  function remember<T>(map: Map<string, T>, threadId: string, value: T): void {
    // Re-setting a key does not move it in a JS Map, so a busy thread would
    // keep the position of its first sighting and be evicted ahead of threads
    // nobody has touched since. Delete first, and iteration order becomes a
    // true least-recently-seen order for the eviction below.
    map.delete(threadId);
    while (map.size >= MAX_TRACKED_THREADS) {
      const oldest = map.keys().next();
      if (oldest.done) break;
      map.delete(oldest.value);
    }
    map.set(threadId, value);
  }

  function forget(threadId: string): void {
    startedAt.delete(threadId);
    notifiedAt.delete(threadId);
  }

  async function wasManuallyStopped(threadId: string): Promise<boolean> {
    try {
      return await latestRunWasManuallyStopped((args) =>
        bb.sdk.threads.events.list({ threadId, ...args }),
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      bb.log.warn(`could not inspect stop reason for ${threadId}: ${detail}`);
      // Preserve the existing notification behavior when the diagnostic read
      // fails. A transient SDK error must not hide a genuine completion.
      return false;
    }
  }

  async function notifyThread(
    thread: {
      id: string;
      projectId: string;
      title: string | null;
      titleFallback: string | null;
      visibility: "visible" | "hidden";
      parentThreadId: string | null;
    },
    outcome: "finished" | "failed",
    detail: string | null,
  ): Promise<void> {
    const suppressed = suppressionReason(thread, {
      includeHiddenThreads: current.includeHiddenThreads,
      includeChildThreads: current.includeChildThreads,
    });
    if (suppressed !== null) return;

    const observedRun = startedAt.get(thread.id);
    if (outcome === "finished") {
      const manuallyStopped = await wasManuallyStopped(thread.id);
      // A new turn can start while the event lookup is in flight. Its state
      // belongs to the next completion, so this older handler must not touch it.
      if (startedAt.get(thread.id) !== observedRun) return;
      if (manuallyStopped) {
        startedAt.delete(thread.id);
        return;
      }
    }

    const now = Date.now();
    const lastNotified = notifiedAt.get(thread.id);
    if (lastNotified !== undefined && now - lastNotified < DEDUPE_WINDOW_MS) {
      return;
    }

    const minRunMs = parseSeconds(current.minRunSeconds) * 1000;
    const start = observedRun?.at;
    if (minRunMs > 0 && start !== undefined && now - start < minRunMs) {
      startedAt.delete(thread.id);
      return;
    }
    startedAt.delete(thread.id);
    // Reserve the dedupe window before the awaits below so idle and failed
    // events arriving together cannot both enqueue. Roll it back if delivery
    // persistence fails, allowing a later event to retry.
    remember(notifiedAt, thread.id, Date.now());

    try {
      const project = await projectName(thread.projectId);
      const fallback = outcome === "failed" ? "Thread failed." : "Turn finished.";
      // The outcome used to sit on its own line. Now that the title carries
      // project and thread, only a failure earns the words.
      const said = oneLine(plainText(detail?.trim() || fallback), BODY_MAX_CHARS);
      const delivery = await postForThread(
        project,
        thread.projectId,
        threadLabel(thread),
        outcome === "failed" ? `Failed — ${said}` : said,
        thread.id,
      );
      if (delivery === "disabled") notifiedAt.delete(thread.id);
    } catch (error) {
      notifiedAt.delete(thread.id);
      throw error;
    }
  }

  bb.events.on("thread.active", ({ thread }) => {
    remember(startedAt, thread.id, { at: Date.now() });
  });

  bb.events.on("thread.idle", ({ thread, lastAssistantText }) => {
    if (!current.notifyOnIdle) {
      startedAt.delete(thread.id);
      return;
    }
    // A parent can go idle while delegated agents are still running. Their
    // completion wakes it for the final turn, which is the one worth showing.
    if (thread.activeBackgroundAgentCount > 0) {
      startedAt.delete(thread.id);
      return;
    }
    return notifyThread(thread, "finished", lastAssistantText);
  });

  bb.events.on("thread.failed", ({ thread, error }) => {
    if (!current.notifyOnFailed) {
      startedAt.delete(thread.id);
      return;
    }
    return notifyThread(thread, "failed", error);
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    forget(thread.id);
    await bb.storage.kv.delete(threadNotificationKey(thread.id));
  });
  bb.events.on("thread.archived", ({ thread }) => forget(thread.id));

  // Published SDK types do not yet include the runtime's presentation field.
  const notifyUserPresentation = {
    presentation: {
      label: {
        pending: "Notifying the user",
        completed: "Notified the user",
      },
    },
  };

  bb.agents.registerTool({
    name: "notify_user",
    description:
      "Post a notification on the user's desktop and subscribed phones. Use it when the user has likely walked away and something needs them now: a long job finished, or you are blocked on a decision. Do not use it for routine progress while they are watching.",
    instructions:
      "notify_user posts a notification titled with the project and thread. Keep the message under 120 characters, lead with what the user would act on, and write plain prose — markdown syntax is stripped, not rendered.",
    ...notifyUserPresentation,
    // No title parameter: the heading is always `<project> · <thread>`, the
    // same as an event notification. An agent-supplied headline would make
    // one row of the notification list look unlike all the others, and it is
    // information the reader already has.
    parameters: z.object({
      message: z.string().min(1).describe("One line the user will act on."),
    }),
    async execute({ message }, ctx) {
      let heading = "bb";
      let project: string | null = null;
      let projectId: string | null = null;
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        heading = threadLabel(thread);
        projectId = thread.projectId;
        project = await projectName(thread.projectId);
      } catch {
        // Thread lookup is decoration only — still send the notification.
      }
      const delivery = await postForThread(
        project,
        projectId,
        heading,
        oneLine(plainText(message), BODY_MAX_CHARS),
        ctx.threadId,
      );
      if (delivery === "disabled") {
        return "Notification skipped because notifications are not enabled for this thread.";
      }
      if (delivery === "skipped") {
        return "Notification skipped because BB is in the foreground.";
      }
      return delivery === "queued"
        ? "Notification queued; a BB window is listening."
        : "No BB window is open; the notification will appear when one is.";
    },
  });

  bb.agents.configure(() => ({
    tools: current.agentTool ? ["notify_user"] : [],
    skills: [],
  }));

  bb.cli.register({
    name: "notify",
    summary: "Post a notification through BB",
    commands: [
      {
        name: "send",
        summary: "Post a notification",
        usage: 'bb notify send "<message>" [--title <text>] [--thread <id>]',
      },
      {
        name: "test",
        summary: "Post a sample notification to verify the setup",
        usage: "bb notify test",
      },
      {
        name: "status",
        summary: "Show desktop and phone delivery status, and the filters",
        usage: "bb notify status",
      },
    ],
    async run(argv, ctx) {
      const [command, ...rest] = argv;
      // An agent running `bb notify send` from inside a thread should get a
      // notification that opens that thread, without naming it.
      const invokingThread = ctx.threadId ?? null;
      const sent = (delivery: DeliveryResult) => {
        if (delivery === "skipped") {
          return { exitCode: 0, stdout: "Skipped. BB is in the foreground.\n" };
        }
        return delivery === "queued"
          ? { exitCode: 0, stdout: "Queued — a BB window is listening.\n" }
          : {
              exitCode: 0,
              stdout: "Held — no BB window is open. It will appear when one is.\n",
            };
      };

      if (command === "status") {
        const held = await notifications.count();
        const phones = webPush.status(null).subscriptionCount;
        const lines = [
          `window:     ${windowIsListening() ? `listening (${waiters.size} polling)` : "none open — notifications will wait"}`,
          `foreground: ${foreground.count() > 0 ? "yes" : "no"}`,
          `phones:     ${phones} subscribed`,
          `held:       ${held}`,
          `on idle:    ${current.notifyOnIdle}`,
          `on failed:  ${current.notifyOnFailed}`,
          `children:   ${current.includeChildThreads}`,
          `hidden:     ${current.includeHiddenThreads}`,
          `min run:    ${parseSeconds(current.minRunSeconds)}s`,
          `sound:      ${current.sound}`,
          `agent tool: ${current.agentTool ? "notify_user" : "disabled"}`,
        ];
        return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
      }

      if (command === "test") {
        const project = ctx.projectId === undefined ? null : await projectName(ctx.projectId);
        return sent(
          await post(
            project,
            ctx.projectId ?? null,
            "bb notify",
            "Notifications are working. Click to open the thread this came from.",
            invokingThread,
          ),
        );
      }

      if (command === "send") {
        const parsed = parseSendArgs(rest);
        if (!parsed.ok) {
          return { exitCode: 2, stderr: `${parsed.error}\n` };
        }
        // Same title shape as an event notification, so a scripted one does
        // not look like it came from somewhere else.
        const overrideThreadId = parsed.value.threadId;
        const targetThread = overrideThreadId ?? invokingThread;
        let targetProjectId = ctx.projectId ?? null;
        if (overrideThreadId !== null) {
          try {
            targetProjectId = (
              await bb.sdk.threads.get({ threadId: overrideThreadId })
            ).projectId;
          } catch {
            // The notification still sends; a missing thread opens the caller's project.
          }
        }
        const project =
          targetProjectId === null ? null : await projectName(targetProjectId);
        return sent(
          await post(
            project,
            targetProjectId,
            parsed.value.title ?? "bb",
            oneLine(plainText(parsed.value.message), BODY_MAX_CHARS),
            targetThread,
          ),
        );
      }

      return {
        exitCode: 2,
        stderr: "usage: bb notify <send|test|status>\n",
      };
    },
  });

  bb.onDispose(async () => {
    // Release held long-polls before waiting for sound playback. Each wake
    // removes itself from the set, which Set iteration tolerates.
    wakeWaiters();
    startedAt.clear();
    notifiedAt.clear();
    projectNames.clear();
    await Promise.all([soundPlayback, Promise.allSettled([...pushDeliveries])]);
  });
}
