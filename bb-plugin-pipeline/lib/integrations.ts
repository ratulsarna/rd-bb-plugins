import type { PluginBbSdk } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { integrationStatusSchema } from "./settings";
import { runGh } from "./gh";

export async function integrationStatus(
  sdk: PluginBbSdk,
  jevConfigured: boolean,
  gh: typeof runGh = runGh,
): Promise<z.infer<typeof integrationStatusSchema>> {
  const [github, notify] = await Promise.all([
    gh(["api", "user", "--jq", ".login"]).then((login) => ({
      available: true, detail: `Authenticated as ${login.trim()}`,
    }), () => ({ available: false, detail: "Could not verify GitHub authentication on the BB server" })),
    sdk.plugins.list({ signal: AbortSignal.timeout(5_000) }).then(({ plugins }) => {
      const notify = plugins.find((plugin) => plugin.id === "notify");
      const available = notify?.enabled === true && notify.status === "running";
      return { available, detail: available ? "Running" : notify === undefined ? "Not installed" : !notify.enabled ? "Disabled" : "Not running" };
    }, () => ({ available: false, detail: "Could not check Notify" })),
  ]);
  return { github, notify, jev: { configured: jevConfigured } };
}
