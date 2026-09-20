import type { PluginBbSdk } from "@get-bb/plugin-sdk";

export interface PipelineMachine {
  id: string;
  name: string;
  status: string;
}

/**
 * Machines that hold a local checkout of the project. A machine missing from
 * the host list (or without a project source) is not selectable.
 */
export async function listProjectMachines(
  sdk: PluginBbSdk,
  projectId: string,
): Promise<PipelineMachine[]> {
  const [project, hosts] = await Promise.all([
    sdk.projects.get({ projectId }),
    sdk.hosts.list(),
  ]);
  const checkoutHosts = new Set(
    project.sources
      .filter((source) => source.type === "local_path")
      .map((source) => source.hostId),
  );
  return hosts
    .filter((host) => checkoutHosts.has(host.id))
    .map(({ id, name, status }) => ({ id, name, status }));
}

/**
 * Resolve a machine by exact id or unambiguous name, requiring a local
 * project checkout. Used for CLI `--machine <id-or-name>` and for validating
 * an explicit host id before any card is created or thread spawned.
 */
export async function resolveMachine(
  sdk: PluginBbSdk,
  projectId: string,
  reference: string,
): Promise<PipelineMachine> {
  const machines = await listProjectMachines(sdk, projectId);
  const byId = machines.find((machine) => machine.id === reference);
  if (byId !== undefined) return byId;
  const byName = machines.filter((machine) => machine.name === reference);
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) {
    throw new Error(
      `machine "${reference}" is ambiguous; pass the machine id instead`,
    );
  }
  throw new Error(
    `unknown machine "${reference}": it must exist and have a local checkout of this project`,
  );
}
