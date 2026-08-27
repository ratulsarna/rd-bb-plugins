import type { ComponentType } from "react";

type RpcHandler = (input: unknown) => unknown | Promise<unknown>;

interface NavPanelRegistration {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: ComponentType<{ subPath: string }>;
  headerContent?: ComponentType<{ subPath: string }>;
}

export const registrations = {
  navPanels: [] as NavPanelRegistration[],
};

export const rpcCalls: Array<{ method: string; input: unknown }> = [];

let rpcHandler: RpcHandler = () => {
  throw new Error("No getWall handler configured");
};

const rpc = {
  call(method: string, input: unknown) {
    rpcCalls.push({ method, input });
    return Promise.resolve(rpcHandler(input));
  },
};

export function configureFakeSdk(getWall: RpcHandler) {
  rpcHandler = getWall;
  rpcCalls.length = 0;
}

export function definePluginApp(
  setup: (app: {
    slots: { navPanel(registration: NavPanelRegistration): void };
  }) => void,
) {
  setup({
    slots: {
      navPanel: (registration) => registrations.navPanels.push(registration),
    },
  });
  return registrations;
}

export const useRpc = () => rpc;
