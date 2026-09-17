import { useEffect, useState, type ReactElement } from "react";
import {
  experimental_useProviders as useProviders,
  experimental_useSidebarThreads as useSidebarThreads,
  useRpc,
  useRealtime,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import type { bbSidebarRpcContract } from "./server";
import { ThreadHoverCard } from "./components/ThreadHoverCard";
import { threadDisplayTitle } from "./inbox";
import { Icon, type IconName } from "./components/Icon";
import { ProviderGlyph } from "./ProviderGlyph";
import { StatusGlyph } from "./StatusGlyph";
import { ProjectFavicon } from "./ProjectFavicon";
import { PROJECT_ICONS_CHANNEL, projectIconUrl } from "./project-icons";
import { OpenPortDetails } from "./OpenPorts";

export function ThreadDetailsTooltip({
  thread,
  disabled,
  children,
}: {
  thread: PluginSidebarThread;
  disabled: boolean;
  children: ReactElement;
}) {
  const { providers } = useProviders();
  const { projects } = useSidebarThreads();
  const { call } = useRpc<typeof bbSidebarRpcContract>();
  const [iconRevision, setIconRevision] = useState(0);
  useRealtime(PROJECT_ICONS_CHANNEL, () => {
    setIconRevision((revision) => revision + 1);
  });
  const [open, setOpen] = useState(false);
  const [execution, setExecution] = useState({ model: "Loading…", reasoningLevel: "" });
  const visible = open && !disabled;

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setExecution({ model: "Loading…", reasoningLevel: "" });
    void call("getThreadExecutionDetails", { threadId: thread.id }).then(
      (details) => {
        if (!cancelled) {
          setExecution(details ?? { model: "Not set", reasoningLevel: "" });
        }
      },
      () => {
        if (!cancelled) setExecution({ model: "Unavailable", reasoningLevel: "" });
      },
    );
    return () => { cancelled = true; };
  }, [call, thread.id, visible]);

  const provider = providers.find((entry) => entry.id === thread.providerId);
  const project = projects.find((entry) => entry.id === thread.projectId);
  const status = thread.hasPendingInteraction ? "Needs you" : thread.indicatorLabel ?? "Idle";
  const label = (
    <div className="flex flex-col gap-2">
      <div className="truncate text-xs font-semibold leading-4 text-popover-foreground">
        {threadDisplayTitle(thread)}
      </div>
      <div className="flex flex-col gap-1.5 text-xs leading-4 text-muted-foreground">
        {project ? (
          <div className="flex items-center gap-2">
            <ProjectFavicon
              src={projectIconUrl(project.id, iconRevision)}
              fallback={<Icon name="FolderGit" className="size-3.5 shrink-0" aria-hidden />}
            />
            <span className="truncate"><span className="sr-only">Project: </span>{project.name}</span>
          </div>
        ) : null}
        {thread.host ? <DetailRow icon="Computer" label="Machine" value={thread.host.name} /> : null}
        {thread.environment?.name ? (
          <DetailRow icon="Terminal" label="Environment" value={thread.environment.name} />
        ) : null}
        {thread.environment?.branchName ? (
          <DetailRow icon="GitBranch" label="Branch" value={thread.environment.branchName} />
        ) : null}
        <div className="flex items-start gap-2">
          <span className="relative mt-px flex size-3.5 shrink-0 items-center justify-center">
            <ProviderGlyph providerId={thread.providerId} provider={provider ?? null} className="size-3.5 [&_span]:size-3.5" />
            {thread.indicator !== "none" ? (
              <span className="absolute -bottom-1 -right-1 rounded-full bg-popover">
                <StatusGlyph indicator={thread.indicator} label={status} className="size-2.5" />
              </span>
            ) : null}
          </span>
          <div className="min-w-0 flex-1">
            <div className="break-words"><span className="sr-only">Model: </span>{execution.model}</div>
            <div className="text-[11px] leading-4">
              <span className="sr-only">Provider: </span>{provider?.displayName ?? thread.providerId}
              {execution.reasoningLevel ? <><span aria-hidden> · </span><span className="sr-only">Reasoning: </span>{execution.reasoningLevel}</> : null}
            </div>
          </div>
        </div>
        <span className="sr-only">Status: {status}</span>
        <OpenPortDetails thread={thread} />
      </div>
    </div>
  );

  return (
    <ThreadHoverCard
      content={label}
      open={visible}
      onOpenChange={setOpen}
    >
      {children}
    </ThreadHoverCard>
  );
}

function DetailRow({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2">
      <Icon name={icon} className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate"><span className="sr-only">{label}: </span>{value}</span>
    </div>
  );
}
