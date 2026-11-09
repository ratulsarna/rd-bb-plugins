import { useMemo, useRef } from "react";
import { experimental_useSidebarThreads as useSidebarThreads } from "@get-bb/plugin-sdk/app";
import { selectedAssistantsProjectId } from "@/lib/assistant-identity";
import { useAssistantHidden, type AssistantHiddenApi } from "@/lib/use-assistant-hidden";
import { useAssistantIdentities, type AssistantIdentitiesApi } from "@/lib/use-assistant-identities";
import { useAssistantOrder, type AssistantOrderApi } from "@/lib/use-assistant-order";
import { useAssistantSubtitles, type AssistantSubtitlesApi } from "@/lib/use-assistant-subtitles";

export interface BotsData {
  projectId: string | null;
  /** Environments behind the fleet's rows. */
  environmentIds: readonly string[];
  order: AssistantOrderApi;
  hidden: AssistantHiddenApi;
  identities: AssistantIdentitiesApi;
  subtitles: AssistantSubtitlesApi;
  /**
   * False until the threads, the order, the hidden bots, the subtitles and the
   * current rows' identities have landed; then true for good, so a later
   * read never blanks the board under the reader.
   */
  loaded: boolean;
}

/**
 * What the Bots rows are placed, tucked and sized by. Read beside the board
 * rather than inside the section, so the board can wait for it: rows drawn
 * before it lands show in activity order with every hidden bot out and no
 * subtitles, then jump.
 */
export function useBotsData(): BotsData {
  const { status, threads, projects } = useSidebarThreads();
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
  const subtitles = useAssistantSubtitles();
  const shown = useRef(false);
  if (
    status !== "loading" &&
    order.loaded &&
    hidden.loaded &&
    subtitles.loaded &&
    identities.loaded
  ) {
    shown.current = true;
  }
  const loaded = shown.current;
  return useMemo(
    () => ({ projectId, environmentIds, order, hidden, identities, subtitles, loaded }),
    [environmentIds, hidden, identities, loaded, order, projectId, subtitles],
  );
}
