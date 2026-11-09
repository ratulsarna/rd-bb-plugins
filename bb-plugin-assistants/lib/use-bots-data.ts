import { useMemo } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { selectedAssistantsProjectId } from "@/lib/assistant-identity";
import { useAssistantHidden, type AssistantHiddenApi } from "@/lib/use-assistant-hidden";
import { useAssistantIdentities, type AssistantIdentitiesApi } from "@/lib/use-assistant-identities";
import { useAssistantOrder, type AssistantOrderApi } from "@/lib/use-assistant-order";

export interface BotsData {
  projectId: string | null;
  /** Environments behind the fleet's rows. */
  environmentIds: readonly string[];
  order: AssistantOrderApi;
  hidden: AssistantHiddenApi;
  identities: AssistantIdentitiesApi;
  /** False until the order, the hidden bots and the identities first land. */
  loaded: boolean;
}

/**
 * What the Bots rows are placed and tucked by. Read beside the board rather
 * than inside the section, so the board can wait for it: rows drawn before it
 * lands show in activity order with every hidden bot out, then jump.
 */
export function useBotsData(): BotsData {
  const { threads, projects } = useSidebarThreads();
  const projectId = selectedAssistantsProjectId(projects);
  const environmentIds = useMemo(
    () =>
      projectId
        ? threads.flatMap(
            (thread) =>
              thread.projectId === projectId &&
              thread.parentThreadId === null &&
              !thread.isArchived &&
              thread.environment?.id
                ? [thread.environment.id]
                : [],
          )
        : [],
    [projectId, threads],
  );
  const order = useAssistantOrder();
  const hidden = useAssistantHidden();
  const identities = useAssistantIdentities(environmentIds);
  const loaded = order.loaded && hidden.loaded && identities.loaded;
  return useMemo(
    () => ({ projectId, environmentIds, order, hidden, identities, loaded }),
    [environmentIds, hidden, identities, loaded, order, projectId],
  );
}
