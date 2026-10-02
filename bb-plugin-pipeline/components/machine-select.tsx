import type { PipelineMachine } from "@/lib/machines";
import { PipelineSelect } from "./select";

export function MachineSelect(props: {
  machines: PipelineMachine[];
  value: string;
  onChange(hostId: string): void;
  disabled: boolean;
  label?: string;
}) {
  return (
    <label className="pipeline-field">
      <span className="pipeline-field-label">Machine</span>
      <PipelineSelect
        aria-label={props.label ?? "Machine"}
        required
        value={props.value}
        disabled={props.disabled || props.machines.length === 0}
        onValueChange={props.onChange}
        placeholder="Choose a machine"
        options={props.machines.map((machine) => ({
          value: machine.id,
          label: `${machine.name}${machine.status === "connected" ? "" : ` (${machine.status})`}`,
        }))}
      />
    </label>
  );
}
