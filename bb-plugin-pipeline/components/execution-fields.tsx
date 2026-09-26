import { experimental_ProviderModelPicker as ProviderModelPicker } from "@get-bb/plugin-sdk/app";
import type { ExecutionSelection } from "@/lib/execution";
import type { PipelineMachine } from "@/lib/machines";
import { MachineSelect } from "./machine-select";

/**
 * Single owner of the machine + intake/lead execution picker block shared by
 * the new-task dialog and the imported-task start setup dialog.
 */
export function ExecutionFields(props: {
  machines: PipelineMachine[];
  hostId: string;
  onHostChange(hostId: string): void;
  intake: ExecutionSelection | null;
  lead: ExecutionSelection | null;
  onIntakeChange(selection: ExecutionSelection): void;
  onLeadChange(selection: ExecutionSelection): void;
  disabled: boolean;
}) {
  const selectedHostId = props.machines.some((machine) => machine.id === props.hostId) ? props.hostId : "";
  const { intake, lead } = props;
  const executionReady = intake !== null && lead !== null;
  return (
    <>
      <MachineSelect
        machines={props.machines}
        value={selectedHostId}
        onChange={props.onHostChange}
        disabled={props.disabled}
      />
      {props.machines.length === 0 ? (
        <p className="pipeline-field-hint">This project has no machine with a checkout.</p>
      ) : null}
      {selectedHostId !== "" && executionReady ? (
        <div className="pipeline-execution">
          <div className="pipeline-execution-row" role="group" aria-label="Intake">
            <span className="pipeline-field-label">Intake</span>
            <ProviderModelPicker
              key={`intake-${selectedHostId}`}
              className="pipeline-execution-picker"
              value={intake}
              onChange={props.onIntakeChange}
              routing={{ kind: "host", hostId: selectedHostId }}
              disabled={props.disabled}
            />
          </div>
          <div className="pipeline-execution-row" role="group" aria-label="Lead">
            <span className="pipeline-field-label">Lead</span>
            <ProviderModelPicker
              key={`lead-${selectedHostId}`}
              className="pipeline-execution-picker"
              value={lead}
              onChange={props.onLeadChange}
              routing={{ kind: "host", hostId: selectedHostId }}
              disabled={props.disabled}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
