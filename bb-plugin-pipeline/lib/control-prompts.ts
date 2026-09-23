import type { Card } from "./store";
import { WORKFLOW_ACCESS } from "./prompts";

export function pauseInstruction(card: Card): string {
  return `Pause Pipeline task ${card.id}. Pause request: ${card.pauseRequestId}.
Start no new task work. Bring this task's intake, lead, existing workers, and running commands to a safe stopping point; coordinate with them as needed. Preserve files and leave a short handoff in this conversation with progress, remaining work, and worker status. Pause any active autonomous goal using its goal controls.
Once all task work is safe to pause, run \`bb pipeline report --paused ${card.pauseRequestId}\` as your last action and end your turn. Do not report working or start further work until the user resumes this task.`;
}

function resumeHandoff(card: Card): string {
  return `Resume Pipeline task ${card.id} from its pause handoff in this conversation. Inspect the existing workspace and worker state, then continue the interrupted task from where it stopped. Coordinate existing workers and preserve work already completed. If you still need a user decision, report that instead of guessing.`;
}

export function resumeInstruction(card: Card): string {
  const phase = card.ownerRole === "intake" ? "intake" : "overview";
  return `${resumeHandoff(card)}\n${WORKFLOW_ACCESS}\nRun \`bb pipeline instructions ${phase}\` and read the current phase before continuing.`;
}

export function isResumeInstruction(card: Card, text: string): boolean {
  return text.split("\n", 1)[0] === resumeHandoff(card);
}
