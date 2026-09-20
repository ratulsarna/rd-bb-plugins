import type { PipelineMachine } from "@/lib/machines";

export function MachineSelect(props: {
  machines: PipelineMachine[];
  value: string;
  onChange(hostId: string): void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <label className="block w-full text-xs">
      <span className="mb-1 block text-muted-foreground">Machine</span>
      <select
        aria-label={props.label ?? "Machine"}
        required
        className="h-9 w-full rounded-md border border-input bg-background px-2 disabled:opacity-50"
        value={props.value}
        disabled={props.disabled || props.machines.length === 0}
        onChange={(event) => props.onChange(event.target.value)}
      >
        <option value="" disabled>Choose a machine</option>
        {props.machines.map((machine) => (
          <option key={machine.id} value={machine.id}>
            {machine.name}{machine.status === "connected" ? "" : ` (${machine.status})`}
          </option>
        ))}
      </select>
    </label>
  );
}
