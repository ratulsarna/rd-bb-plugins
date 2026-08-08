import { useEffect } from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";

type Report = (
  threadId: string,
  pullRequest: PluginSidebarPullRequest | null,
) => void;

function PrProbe({ threadId, report }: { threadId: string; report: Report }) {
  const { isLoading, pullRequest } = useSidebarThreadPullRequest(threadId);

  useEffect(() => {
    if (!isLoading) report(threadId, pullRequest);
  }, [isLoading, pullRequest, report, threadId]);

  return null;
}

/**
 * The board's only PR subscriptions. Rendering nothing keeps them independent
 * of which rows are on screen — a collapsed tree still reports its PR state.
 */
export function PrProbes({
  threadIds,
  report,
}: {
  threadIds: readonly string[];
  report: Report;
}) {
  return (
    <>
      {threadIds.map((threadId) => (
        <PrProbe key={threadId} threadId={threadId} report={report} />
      ))}
    </>
  );
}
