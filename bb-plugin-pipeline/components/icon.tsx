import { experimental_Icon as HostIcon } from "@get-bb/plugin-sdk/app";

export function Icon({ name, className = "" }: { name: string; className?: string }) {
  return <HostIcon name={name} aria-hidden="true" className={`pipeline-icon ${className}`} />;
}
