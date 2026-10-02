import { MODES, SIZES, type CardMode, type CardSize } from "@/lib/store";
import { PipelineSelect } from "./select";

const LABELS: Record<CardMode | CardSize, string> = {
  manual: "Manual",
  auto: "Auto",
  small: "Small",
  standard: "Standard",
};

function SettingSelect<T extends CardMode | CardSize>(props: {
  name: string;
  label: string;
  options: readonly T[];
  value: T | null;
  onChange(value: T): void;
  disabled: boolean;
}) {
  return (
    <label className="pipeline-field">
      <span className="pipeline-field-label">{props.name}</span>
      <PipelineSelect
        aria-label={props.label}
        value={props.value ?? ""}
        disabled={props.disabled}
        onValueChange={(value) => props.onChange(value as T)}
        placeholder="Not set"
        options={props.options.map((value) => ({ value, label: LABELS[value] }))}
      />
    </label>
  );
}

export function TaskSettingsFields(props: {
  mode: CardMode | null;
  size: CardSize | null;
  onModeChange(mode: CardMode): void;
  onSizeChange(size: CardSize): void;
  disabled: boolean;
  /** Names the task in accessible labels when several are on screen. */
  taskTitle?: string;
}) {
  const suffix = props.taskTitle === undefined ? "" : ` for ${props.taskTitle}`;
  return (
    <>
      <SettingSelect name="Mode" label={`Mode${suffix}`} options={MODES} value={props.mode}
        onChange={props.onModeChange} disabled={props.disabled} />
      <SettingSelect name="Size" label={`Size${suffix}`} options={SIZES} value={props.size}
        onChange={props.onSizeChange} disabled={props.disabled} />
    </>
  );
}
