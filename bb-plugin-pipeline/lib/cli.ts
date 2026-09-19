import { basename } from "node:path";
import type {
  PluginBbSdk,
  PluginCliContext,
  PluginCliRegistration,
  PluginCliResult,
} from "@get-bb/plugin-sdk";
import { COLUMNS, isColumn } from "./columns";
import type { PipelineService } from "./service";
import { ownerThread } from "./store";
import type { Card, CardAttachment, CardStore } from "./store";

const USAGE = `Usage:
  bb pipeline add --title <text> [--body <text>] [--attachment <uploaded-path>]... [--project <id>] [--json]
  bb pipeline list [--project <id>] [--all] [--json]
  bb pipeline show <card-id> [--json]
  bb pipeline move <card-id> <column> [--json]
  bb pipeline report [--card <id>] [--column <column>] [--needs-you <reason> | --working] [--issue <url>] [--pr <url>] [--tier <trivial|small|standard>] [--json]
  bb pipeline retry <card-id> [--json]
  bb pipeline remove <card-id> [--json]

Columns: ${COLUMNS.join(", ")}`;

const VALUE_OPTIONS = new Set([
  "title",
  "body",
  "attachment",
  "project",
  "card",
  "column",
  "needs-you",
  "issue",
  "pr",
  "tier",
]);
const BOOLEAN_OPTIONS = new Set(["json", "all", "working"]);

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

function formatCard(card: Card): string {
  const flags = [
    card.tier,
    card.needsUser ? `needs you: ${card.attentionReason ?? "unknown"}` : null,
    card.attentionUnknown ? "idle, unchecked" : null,
    card.launchError,
  ].filter((value): value is string => value !== null);
  return `${card.id}  ${card.column.padEnd(12)}  ${card.title}${flags.length === 0 ? "" : `  [${flags.join("; ")}]`}`;
}

export function createPipelineCli(input: {
  service: PipelineService;
  store: CardStore;
  sdk: PluginBbSdk;
}): PluginCliRegistration {
  return {
    name: "pipeline",
    summary: "Manage pipeline cards and report delivery progress",
    commands: [
      { name: "add", summary: "Add a card", usage: "bb pipeline add --title <text> [options]" },
      { name: "list", summary: "List cards", usage: "bb pipeline list [--project <id>] [--all] [--json]" },
      { name: "show", summary: "Show a card", usage: "bb pipeline show <card-id> [--json]" },
      { name: "move", summary: "Move a card", usage: "bb pipeline move <card-id> <column> [--json]" },
      { name: "report", summary: "Report phase or attention", usage: "bb pipeline report [options]" },
      { name: "retry", summary: "Retry a failed launch", usage: "bb pipeline retry <card-id> [--json]" },
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

      try {
        switch (args.command) {
          case "add": {
            const title = option(args, "title");
            if (title === undefined || args.positionals.length > 0) {
              return failure("add requires --title and no positional arguments", USAGE);
            }
            const card = await input.service.createCard({
              projectId: projectId(args, context),
              title,
              body: option(args, "body") ?? "",
              attachments: (args.options.get("attachment") ?? []).map(attachment),
              source: "cli",
            });
            return success(args, card, `Added ${formatCard(card)}`);
          }
          case "list": {
            if (args.positionals.length > 0) return failure("list takes no positional arguments", USAGE);
            const cards = input.store.list(
              projectId(args, context),
              args.options.has("all"),
            );
            return success(
              args,
              cards,
              cards.length === 0 ? "No pipeline cards." : cards.map(formatCard).join("\n"),
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
            const value = {
              card,
              history: input.store.history(card.id),
              ownerThreadId: threadId,
              interactions,
              ...(interactionsNote === undefined ? {} : { interactionsNote }),
            };
            return success(args, value, JSON.stringify(value, null, 2));
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
            return success(args, card, formatCard(card));
          }
          case "retry": {
            if (args.positionals.length !== 1) return failure("retry requires one card id", USAGE);
            const card = await input.service.retry(args.positionals[0]!);
            return success(args, card, formatCard(card));
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
