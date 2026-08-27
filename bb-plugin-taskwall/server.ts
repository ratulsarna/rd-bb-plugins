import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  emptySnapshot,
  groupTasks,
  parseLedger,
  type TaskwallSnapshot,
} from "./lib/taskwall.ts";

export const LEDGER_ROOT = "/home/ratul/assistants/sam/tasks";
export const LEDGER_PATH = `${LEDGER_ROOT}/ledger.json`;

const taskSchema = z
  .object({
    id: z.string(),
    text: z.string(),
    dueDate: z.string().nullable(),
    dueTime: z.string().nullable(),
    status: z.enum(["open", "done"]),
    createdAt: z.string(),
    doneAt: z.string().nullable(),
  })
  .strict();

const outputSchema = z
  .object({
    overdue: z.array(taskSchema),
    today: z.array(taskSchema),
    upcoming: z.array(taskSchema),
    doneToday: z.array(taskSchema),
    todayKey: z.string(),
    refreshedAt: z.string().datetime(),
    skippedCount: z.number().int().nonnegative(),
    error: z.string().nullable(),
  })
  .strict();

export const rpcContract = defineRpcContract({
  getWall: {
    input: z.null(),
    output: outputSchema,
  },
});

export default function plugin(bb: BbPluginApi) {
  bb.rpc.register(rpcContract, {
    getWall: async (): Promise<TaskwallSnapshot> => {
      const now = new Date();
      try {
        const file = await bb.sdk.files.read({
          path: LEDGER_PATH,
          rootPath: LEDGER_ROOT,
        });
        if (file.contentEncoding !== "utf8") {
          throw new Error("Ledger was not returned as UTF-8 text.");
        }

        const { tasks, skippedCount } = parseLedger(file.content);
        return {
          ...groupTasks(tasks, now),
          refreshedAt: now.toISOString(),
          skippedCount,
          error: skippedCount ? "Some ledger entries could not be read." : null,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        bb.log.warn(`task ledger read failed: ${detail}`);
        return emptySnapshot(now, "Ledger is unavailable.");
      }
    },
  });
}
