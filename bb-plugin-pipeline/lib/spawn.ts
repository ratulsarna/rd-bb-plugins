import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { Card, CardAttachment } from "./store";

export type PipelineRole = "intake" | "lead";

export interface PipelineLaunchSettings {
  hostId: string;
  providerId: string;
  model: string;
  reasoningLevel: "low" | "medium" | "high" | "xhigh" | "max";
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
  return role === "intake"
    ? ({
        type: "host",
        hostId,
        workspace: { type: "unmanaged", path: source.path },
      } as const)
    : ({
        type: "host",
        hostId,
        workspace: {
          type: "managed-worktree",
          baseBranch: { kind: "default" },
        },
      } as const);
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

export function spawnRequest(input: {
  card: Card;
  role: PipelineRole;
  prompt: string;
  environment: Awaited<ReturnType<typeof environmentFor>>;
  settings: PipelineLaunchSettings;
}) {
  const { card, role, prompt, environment, settings } = input;
  return {
    projectId: card.projectId,
    environment,
    providerId: settings.providerId,
    model: settings.model,
    reasoningLevel: settings.reasoningLevel,
    permissionMode: settings.permissionMode,
    title: `${role === "intake" ? "Intake" : "Lead"} · ${card.title}`.slice(
      0,
      120,
    ),
    pluginMetadata: { cardId: card.id, role },
    input: [
      { type: "text" as const, text: prompt, mentions: [] },
      ...attachmentInputs(card.attachments),
    ],
  };
}
