import { basename } from "node:path";
import type {
  PluginBbSdk,
  PluginCliContext,
  PluginCliRegistration,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { COLUMNS, isColumn } from "./columns";
import { executionSelectionSchema, type ExecutionSelection } from "./execution";
import type { PipelineService } from "./service";
import type { PipelineCapacity } from "./capacity";
import type { PipelineControls } from "./controls";
import type { GithubSync } from "./github-sync";
import { ownerThread } from "./card";
import type { MachineQueue } from "./contract";
import type { Card, CardAttachment, CardStore } from "./store";
import { readWorkflow } from "./workflow";
import { USER_HANDOFF } from "./prompts";

const USAGE = `Usage:
  bb pipeline instructions [overview|intake|plan|implement|debug|close-out] [--file <relative-path>] [--json]
  bb pipeline add --title <text> --machine <id-or-name> [--start] [--body <text>] [--attachment <uploaded-path>]... [--project <id>] [--json]
  bb pipeline start <card-id> [--json]
  bb pipeline list [--project <id>] [--all] [--json]
  bb pipeline show <card-id> [--json]
  bb pipeline queue [--project <id>] [--json]
  bb pipeline run-next <card-id> [--clear] [--json]
  bb pipeline move <card-id> <column> [--json]
  bb pipeline report [--card <id>] [--column <column>] [--needs-you <reason> | --working] [--issue <url>] [--pr <url>] [--tier <trivial|small|standard>] [--json]
  bb pipeline github-sync <card-id> [--json]
  bb pipeline review-wait [--card <id>] [--handled <batch-id>] [--json]
  bb pipeline review-retry <card-id> [--json]
  bb pipeline retry <card-id> [--json]
  bb pipeline pause <card-id> [--json]
  bb pipeline resume <card-id> [--json]
  bb pipeline stop <card-id> [--json]
  bb pipeline report --paused <request-id> [--card <id>] [--json]
  bb pipeline set-machine <card-id> --machine <id-or-name> [--json]
  bb pipeline remove <card-id> [--json]

Add execution options (optional; omitted fields use remembered Pipeline settings):
  --intake-provider <id> --intake-model <id> --intake-reasoning <level>
  --lead-provider <id> --lead-model <id> --lead-reasoning <level>
  --intake-service-tier <default|fast> --lead-service-tier <default|fast>

Reporting updates card state only. Ask questions and request approval in the task's chat; --needs-you takes a short waiting reason.

Columns: ${COLUMNS.join(", ")}`;

const EXECUTION_OPTIONS = [
  "intake-provider", "intake-model", "intake-reasoning",
  "lead-provider", "lead-model", "lead-reasoning",
  "intake-service-tier", "lead-service-tier",
];
const VALUE_OPTIONS = new Set([
  ...EXECUTION_OPTIONS,
  "title",
  "body",
  "attachment",
  "project",
  "machine",
  "card",
  "column",
  "needs-you",
  "issue",
  "pr",
  "tier",
  "paused",
  "handled",
  "file",
]);
const BOOLEAN_OPTIONS = new Set(["json", "all", "working", "clear", "start"]);
const MACHINE_COMMANDS = new Set(["add", "set-machine"]);

interface ParsedArgs {
  command?: string;
  positionals: string[];
  options: Map<string, string[]>;
}

function parse(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const name = token.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      options.set(name, ["true"]);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`unknown option --${name}`);
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${name} requires a value`);
    }
    index += 1;
    options.set(name, [...(options.get(name) ?? []), value]);
  }
  return { command, positionals, options };
}

function option(args: ParsedArgs, name: string): string | undefined {
  return args.options.get(name)?.at(-1);
}

function jsonEnabled(args: ParsedArgs): boolean {
  return args.options.has("json");
}

function executionOptions(args: ParsedArgs, role: "intake" | "lead"): Partial<ExecutionSelection> {
  const providerId = option(args, `${role}-provider`);
  const model = option(args, `${role}-model`);
  const reasoningLevel = option(args, `${role}-reasoning`);
  const serviceTier = option(args, `${role}-service-tier`);
  return executionSelectionSchema.partial().parse({
    ...(providerId === undefined ? {} : { providerId }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningLevel === undefined ? {} : { reasoningLevel }),
    ...(serviceTier === undefined ? {} : { serviceTier }),
  });
}

function success(
  args: ParsedArgs,
  value: unknown,
  text: string,
): PluginCliResult {
  return {
    exitCode: 0,
    stdout: jsonEnabled(args) ? JSON.stringify(value, null, 2) : text,
  };
}

function failure(message: string, hint?: string): PluginCliResult {
  return {
    exitCode: 1,
    stderr: hint === undefined ? message : `${message}\nHint: ${hint}`,
  };
}

function projectId(args: ParsedArgs, context: PluginCliContext): string {
  const id = option(args, "project") ?? context.projectId;
  if (id === undefined) {
    throw new Error("project is required; pass --project <id>");
  }
  return id;
}

function attachment(path: string): CardAttachment {
  const filename = basename(path);
  return {
    path,
    filename,
    isImage: /\.(avif|gif|jpe?g|png|webp)$/iu.test(filename),
  };
}

interface CardQueueDetails {
  queued: boolean;
  waitingReasons: string[];
  runNext: boolean;
}

function queueDetails(queue: MachineQueue[], cardId: string): CardQueueDetails {
  const reasons = new Set<string>();
  let queued = false;
  let runNext = false;
  for (const machine of queue) {
    if (machine.nextCardId === cardId) runNext = true;
    for (const waiting of machine.waiting) {
      if (waiting.cardId !== cardId) continue;
      queued = true;
      for (const reason of waiting.reasons) reasons.add(reason);
    }
  }
  return { queued, waitingReasons: [...reasons], runNext };
}

function formatCard(
  card: Card,
  queue: CardQueueDetails = { queued: false, waitingReasons: [], runNext: false },
): string {
  const flags = [
    card.startRequested ? null : "not started",
    card.runState === "running" ? null : card.runState.replaceAll("_", " "),
    card.controlError,
    queue.queued
      ? `queued${queue.waitingReasons.length === 0 ? "" : `: ${queue.waitingReasons.join(", ")}`}`
      : null,
    queue.runNext ? "run next" : null,
    card.tier,
    card.hostId === null ? "machine: unassigned" : `machine: ${card.hostId}`,
    card.needsUser ? `needs you: ${card.attentionReason ?? "unknown"}` : null,
    card.attentionUnknown ? "idle, unchecked" : null,
    card.launchError,
    card.github === null ? null : card.github.number === null ? "PR not synced" : `PR #${card.github.number}: ${card.github.state}; review ${card.github.review}`,
    card.github?.error ?? null,
  ].filter((value): value is string => value !== null);
  return `${card.id}  ${card.column.padEnd(12)}  ${card.title}${flags.length === 0 ? "" : `  [${flags.join("; ")}]`}`;
}

function formatQueue(queue: MachineQueue[]): string {
  if (queue.length === 0) return "No Pipeline work is running or waiting.";
  return queue.map((machine) => {
    const occupied = machine.occupied.length === 0
      ? ["  Running: none"]
      : ["  Running:", ...machine.occupied.map((task) => `    ${task.cardId}  ${task.title}`)];
    const waiting = machine.waiting.length === 0
      ? ["  Waiting: none"]
      : [
          "  Waiting:",
          ...machine.waiting.map((task) => {
            const flags = [
              machine.nextCardId === task.cardId ? "NEXT" : null,
              ...task.reasons,
            ].filter((value): value is string => value !== null);
            return `    ${task.cardId}  ${task.title}${flags.length === 0 ? "" : `  [${flags.join("; ")}]`}`;
          }),
        ];
    return [
      `${machine.hostName} (${machine.hostId}) — ${machine.occupied.length}/${machine.limit} slots occupied`,
      ...occupied,
      ...waiting,
    ].join("\n");
  }).join("\n\n");
}

export function createPipelineCli(input: {
  service: PipelineService;
  store: CardStore;
  sdk: PluginBbSdk;
  capacity: PipelineCapacity;
  controls: PipelineControls;
  github: GithubSync;
}): PluginCliRegistration {
  return {
    name: "pipeline",
    summary: "Manage pipeline cards and report delivery progress",
    commands: [
      { name: "instructions", summary: "Read Pipeline workflow instructions or a phase template", usage: "bb pipeline instructions [overview|intake|plan|implement|debug|close-out] [--file <relative-path>] [--json]" },
      { name: "add", summary: "Add a card", usage: "bb pipeline add --title <text> --machine <id-or-name> [options]" },
      { name: "start", summary: "Start intake for a saved task", usage: "bb pipeline start <card-id> [--json]" },
      { name: "list", summary: "List cards", usage: "bb pipeline list [--project <id>] [--all] [--json]" },
      { name: "show", summary: "Show a card", usage: "bb pipeline show <card-id> [--json]" },
      { name: "queue", summary: "Show running and waiting work by machine", usage: "bb pipeline queue [--project <id>] [--json]" },
      { name: "run-next", summary: "Choose or clear the next task for its machine", usage: "bb pipeline run-next <card-id> [--clear] [--json]" },
      { name: "move", summary: "Move a card", usage: "bb pipeline move <card-id> <column> [--json]" },
      { name: "report", summary: "Report phase or attention", usage: "bb pipeline report [options]" },
      { name: "github-sync", summary: "Refresh linked PR status", usage: "bb pipeline github-sync <card-id> [--json]" },
      { name: "review-wait", summary: "Request external review and hand off", usage: "bb pipeline review-wait [--card <id>] [--handled <batch-id>] [--json]" },
      { name: "review-retry", summary: "Retry review feedback delivery", usage: "bb pipeline review-retry <card-id> [--json]" },
      { name: "retry", summary: "Retry a failed launch", usage: "bb pipeline retry <card-id> [--json]" },
      { name: "pause", summary: "Ask the intake or lead to pause the task gracefully", usage: "bb pipeline pause <card-id> [--json]" },
      { name: "resume", summary: "Resume a paused task", usage: "bb pipeline resume <card-id> [--json]" },
      { name: "stop", summary: "Stop task execution now and hold queued work", usage: "bb pipeline stop <card-id> [--json]" },
      { name: "set-machine", summary: "Assign a machine to a card that has none", usage: "bb pipeline set-machine <card-id> --machine <id-or-name> [--json]" },
      { name: "remove", summary: "Remove a card", usage: "bb pipeline remove <card-id> [--json]" },
    ],
    async run(argv, context) {
      let args: ParsedArgs;
      try {
        args = parse(argv);
      } catch (cause) {
        return failure(cause instanceof Error ? cause.message : String(cause), USAGE);
      }
      if (
        args.command === undefined ||
        args.command === "help" ||
        args.command === "--help" ||
        args.command === "-h"
      ) {
        return { exitCode: 0, stdout: USAGE };
      }
      if (args.options.has("machine") && !MACHINE_COMMANDS.has(args.command!)) {
        return failure(
          `--machine is only accepted by add and set-machine, not ${args.command}`,
          USAGE,
        );
      }
      if (args.command !== "add" && EXECUTION_OPTIONS.some((name) => args.options.has(name))) {
        return failure("intake and lead execution options are only accepted by add", USAGE);
      }
      if (args.options.has("handled") && args.command !== "review-wait") return failure("--handled is only accepted by review-wait", USAGE);
      if (args.options.has("paused") && args.command !== "report") return failure("--paused is only accepted by report", USAGE);
      if (args.options.has("clear") && args.command !== "run-next") return failure("--clear is only accepted by run-next", USAGE);
      if (args.options.has("start") && args.command !== "add") return failure("--start is only accepted by add", USAGE);
      if (args.options.has("file") && args.command !== "instructions") return failure("--file is only accepted by instructions", USAGE);

      try {
        switch (args.command) {
          case "instructions": {
            if (args.positionals.length > 1 || [...args.options.keys()].some((name) => name !== "file" && name !== "json")) {
              return failure("instructions accepts one optional phase, --file, and --json", USAGE);
            }
            const document = await readWorkflow(args.positionals[0], option(args, "file"));
            return success(args, document, document.content);
          }
          case "add": {
            const title = option(args, "title");
            if (title === undefined || args.positionals.length > 0) {
              return failure("add requires --title and no positional arguments", USAGE);
            }
            const machine = option(args, "machine");
            if (machine === undefined) {
              return failure("add requires --machine <id-or-name>", USAGE);
            }
            const card = await input.service.createCard({
              projectId: projectId(args, context),
              hostId: machine,
              intake: executionOptions(args, "intake"),
              lead: executionOptions(args, "lead"),
              title,
              body: option(args, "body") ?? "",
              attachments: (args.options.get("attachment") ?? []).map(attachment),
              source: "cli",
              start: args.options.has("start"),
            });
            return success(args, card, `Added ${formatCard(card)}`);
          }
          case "start": {
            if (args.positionals.length !== 1) return failure("start requires one card id", USAGE);
            const card = await input.service.start(args.positionals[0]!, "cli");
            return success(args, card, formatCard(card));
          }
          case "list": {
            if (args.positionals.length > 0) return failure("list takes no positional arguments", USAGE);
            const project = projectId(args, context);
            const cards = input.store.list(
              project,
              args.options.has("all"),
            );
            const queue = await input.capacity.snapshot(project);
            return success(
              args,
              cards.map((card) => ({ ...card, ...queueDetails(queue, card.id) })),
              cards.length === 0
                ? "No pipeline cards."
                : cards.map((card) => formatCard(card, queueDetails(queue, card.id))).join("\n"),
            );
          }
          case "show": {
            if (args.positionals.length !== 1) return failure("show requires one card id", USAGE);
            const card = input.store.get(args.positionals[0]!);
            if (card === null) {
              return failure(`unknown card ${args.positionals[0]}`, "Run `bb pipeline list` to see cards.");
            }
            const threadId = ownerThread(card);
            let interactions = null;
            let interactionsNote: string | undefined;
            if (threadId !== null) {
              try {
                interactions = await input.sdk.threads.interactions.list({ threadId });
              } catch (cause) {
                interactions = [];
                interactionsNote = `Could not load interactions for ${threadId}: ${errorMessage(cause)}`;
              }
            }
            const queue = await input.capacity.snapshot(card.projectId);
            const details = queueDetails(queue, card.id);
            const value = {
              card,
              ...details,
              history: input.store.history(card.id),
              ownerThreadId: threadId,
              interactions,
              ...(interactionsNote === undefined ? {} : { interactionsNote }),
            };
            return success(args, value, JSON.stringify(value, null, 2));
          }
          case "queue": {
            if (args.positionals.length > 0) return failure("queue takes no positional arguments", USAGE);
            const queue = await input.capacity.snapshot(projectId(args, context));
            return success(args, queue, formatQueue(queue));
          }
          case "run-next": {
            if (args.positionals.length !== 1) return failure("run-next requires one card id", USAGE);
            const cardId = args.positionals[0]!;
            const enabled = !args.options.has("clear");
            await input.capacity.setRunNext(cardId, enabled);
            return success(
              args,
              { cardId, runNext: enabled },
              enabled
                ? `Set ${cardId} to run next when capacity opens.`
                : `Cleared run-next for ${cardId}.`,
            );
          }
          case "move": {
            if (args.positionals.length !== 2 || !isColumn(args.positionals[1]!)) {
              return failure("move requires a card id and valid column", USAGE);
            }
            const card = await input.service.move(
              args.positionals[0]!,
              args.positionals[1]!,
              "cli",
            );
            return success(args, card, formatCard(card));
          }
          case "report": {
            if (args.positionals.length > 0) return failure("report takes options only", USAGE);
            const pauseRequest = option(args, "paused");
            if (pauseRequest !== undefined) {
              if ([...args.options.keys()].some((name) => !["paused", "card", "json"].includes(name))) {
                return failure("--paused cannot be combined with other report changes", USAGE);
              }
              const card = await input.controls.acknowledge({ cardId: option(args, "card"), threadId: context.threadId, requestId: pauseRequest });
              return success(args, card, formatCard(card));
            }
            const column = option(args, "column");
            if (column !== undefined && !isColumn(column)) {
              return failure(`unknown column ${column}`, USAGE);
            }
            const tier = option(args, "tier");
            if (tier !== undefined && !["trivial", "small", "standard"].includes(tier)) {
              return failure(`unknown tier ${tier}`, USAGE);
            }
            const hasReport =
              column !== undefined ||
              option(args, "needs-you") !== undefined ||
              args.options.has("working") ||
              option(args, "issue") !== undefined ||
              option(args, "pr") !== undefined ||
              tier !== undefined;
            if (!hasReport) return failure("report requires at least one change", USAGE);
            const card = await input.service.report({
              threadId: context.threadId,
              cardId: option(args, "card"),
              column,
              needsYou: option(args, "needs-you"),
              working: args.options.has("working"),
              issueUrl: option(args, "issue"),
              prUrl: option(args, "pr"),
              tier: tier as "trivial" | "small" | "standard" | undefined,
            });
            return success(args, card, option(args, "needs-you") === undefined
              ? formatCard(card)
              : `${formatCard(card)}\n${USER_HANDOFF}`);
          }
          case "github-sync":
          case "review-retry": {
            if (args.positionals.length !== 1) return failure(`${args.command} requires one card id`, USAGE);
            const card = await input.github[args.command === "github-sync" ? "sync" : "retry"](args.positionals[0]!);
            return success(args, card, formatCard(card));
          }
          case "review-wait": {
            if (args.positionals.length > 0) return failure("review-wait takes options only", USAGE);
            const cardId = option(args, "card") ?? (context.threadId === undefined ? undefined : input.store.getByThread(context.threadId)?.id);
            if (cardId === undefined) return failure("Pass --card or run from the owning lead thread", USAGE);
            const card = await input.github.waitForReview(cardId, context.threadId, option(args, "handled"));
            return success(args, card, formatCard(card));
          }
          case "retry": {
            if (args.positionals.length !== 1) return failure("retry requires one card id", USAGE);
            const card = await input.service.retry(args.positionals[0]!);
            return success(args, card, formatCard(card));
          }
          case "pause":
          case "resume":
          case "stop": {
            if (args.positionals.length !== 1) return failure(`${args.command} requires one card id`, USAGE);
            const card = await input.controls[args.command](args.positionals[0]!);
            return success(args, card, formatCard(card));
          }
          case "set-machine": {
            if (args.positionals.length !== 1) return failure("set-machine requires one card id", USAGE);
            const machine = option(args, "machine");
            if (machine === undefined) {
              return failure("set-machine requires --machine <id-or-name>", USAGE);
            }
            const card = await input.service.setMachine(args.positionals[0]!, machine);
            return success(args, card, `Assigned ${formatCard(card)}`);
          }
          case "remove": {
            if (args.positionals.length !== 1) return failure("remove requires one card id", USAGE);
            input.service.remove(args.positionals[0]!);
            return success(args, { removed: true, id: args.positionals[0] }, `Removed ${args.positionals[0]}`);
          }
          default:
            return failure(`unknown command ${args.command}`, USAGE);
        }
      } catch (cause) {
        return failure(errorMessage(cause));
      }
    },
  };
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
