import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, type Machine } from "./contract";

export default function plugin(bb: BbPluginApi) {
  const hosts = bb.hosts.experimental_client({ contract: hostContract });
  async function requireConnected(hostId: string) {
    const host = await bb.sdk.hosts.get({ hostId });
    if (host.status !== "connected")
      throw new Error("This machine is offline. Reconnect it and retry.");
    return host;
  }
  bb.rpc.register(rpcContract, {
    list: async ({ refresh }) => {
      const roster = await bb.sdk.hosts.list();
      const machines = await Promise.all(
        roster
          .filter((host) => host.lifecycle.phase !== "destroyed")
          .map(async (host): Promise<Machine> => {
            const base = {
              hostId: host.id,
              name: host.name,
              connected: host.status === "connected",
            };
            if (!base.connected)
              return {
                ...base,
                available: false,
                identity: null,
                issue: "Machine is offline.",
                login: null,
              };
            try {
              return {
                ...base,
                ...(await hosts.call(
                  "inspect",
                  { refresh },
                  { hostId: host.id },
                )),
              };
            } catch {
              return {
                ...base,
                available: false,
                identity: null,
                issue:
                  "Could not reach Claude Code on this machine. Refresh to retry.",
                login: null,
              };
            }
          }),
      );
      return {
        machines,
      };
    },
    start: async ({ hostIds }) =>
      Promise.all(
        [...new Set(hostIds)].map(async (hostId) => {
          try {
            await requireConnected(hostId);
            const login = await hosts.call("start", {}, { hostId });
            return { hostId, login, error: null };
          } catch {
            return {
              hostId,
              login: null,
              error:
                "Could not start login. Refresh to check for an existing login or an offline machine.",
            };
          }
        }),
      ),
    submit: async ({ hostId, id, code }) => {
      await requireConnected(hostId);
      return hosts.call("submit", { id, code }, { hostId });
    },
    cancel: async ({ hostId, id }) => {
      await requireConnected(hostId);
      return hosts.call("cancel", { id }, { hostId });
    },
  });
}
