import type { PipelineMachine } from "@/lib/machines";
import { Icon } from "./icon";

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
      <span className="pipeline-select-wrap">
        <select
          aria-label={props.label ?? "Machine"}
          required
          className="pipeline-select"
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
        <Icon name="ChevronDown" />
      </span>
    </label>
  );
}
