import { isNewThreadRequest } from "./new-thread-request";

export async function spawnFromComposerRequest(
  spawn: (request: unknown) => Promise<{ id: string }>,
  request: unknown,
): Promise<{ threadId: string }> {
  if (!isNewThreadRequest(request)) {
    throw new Error("Expected a New Thread request.");
  }
  const thread = await spawn(request);
  return { threadId: thread.id };
}
