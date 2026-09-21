import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { ExecutionSelection } from "./execution";
import type { Card, CardAttachment } from "./store";

export type PipelineRole = "intake" | "lead";

export interface PipelineLaunchSettings extends ExecutionSelection {
  permissionMode: "accept-edits" | "auto" | "full";
}

export async function environmentFor(
  sdk: PluginBbSdk,
  projectId: string,
  hostId: string,
  role: PipelineRole,
  knownProject?: Awaited<ReturnType<PluginBbSdk["projects"]["get"]>>,
) {
  const project = knownProject ?? (await sdk.projects.get({ projectId }));
  const source = project.sources.find(
    (candidate) =>
      candidate.type === "local_path" && candidate.hostId === hostId,
  );
  if (source === undefined) {
    throw new Error(`project has no checkout on ${hostId}`);
  }
  if (role === "lead") {
    return {
      type: "host",
      hostId,
      workspace: {
        type: "managed-worktree",
        baseBranch: { kind: "default" },
      },
    } as const;
  }

  const path = source.path.replace(/\/+$/u, "") || "/";
  const [environment] = await sdk.environments.list({ projectId, hostId, path });
  if (environment === undefined) {
    throw new Error(
      `open the project checkout ${path} on ${hostId} in BB once, then retry intake`,
    );
  }
  if (environment.status !== "ready" || environment.lifecycle.phase !== "active") {
    throw new Error(
      `project checkout ${environment.id} on ${hostId} is ${environment.status}/${environment.lifecycle.phase}; open or restore the checkout in BB, then retry intake`,
    );
  }
  return { type: "reuse", environmentId: environment.id } as const;
}

export function attachmentInputs(attachments: CardAttachment[]) {
  return attachments.map((attachment) =>
    attachment.isImage
      ? ({ type: "localImage", path: attachment.path } as const)
      : ({
          type: "localFile",
          path: attachment.path,
          name: attachment.filename,
          ...(attachment.mimeType === undefined
            ? {}
            : { mimeType: attachment.mimeType }),
          ...(attachment.sizeBytes === undefined
            ? {}
            : { sizeBytes: attachment.sizeBytes }),
        } as const),
  );
}

export function kickoffRequest(input: {
  card: Card;
  role: PipelineRole;
  prompt: string;
  settings: PipelineLaunchSettings;
}) {
  const { card, role, prompt, settings } = input;
  return {
    projectId: card.projectId,
    providerId: settings.providerId,
    model: settings.model,
    reasoningLevel: settings.reasoningLevel,
    ...(settings.serviceTier === undefined
      ? {}
      : { serviceTier: settings.serviceTier }),
    permissionMode: settings.permissionMode,
    title: `${role === "intake" ? "Intake" : "Lead"} · ${card.title}`.slice(
      0,
      120,
    ),
    pluginMetadata: { cardId: card.id, role, hostId: card.hostId },
    input: [
      { type: "text" as const, text: prompt, mentions: [] },
      ...attachmentInputs(card.attachments),
    ],
  };
}
