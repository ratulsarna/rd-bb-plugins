import { MODES, SIZES, type CardMode, type CardSize } from "@/lib/store";
import { Icon } from "./icon";

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
      <span className="pipeline-select-wrap">
        <select
          aria-label={props.label}
          className="pipeline-select"
          value={props.value ?? ""}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value as T)}
        >
          {props.value === null ? <option value="" disabled>Not set</option> : null}
          {props.options.map((option) => <option key={option} value={option}>{LABELS[option]}</option>)}
        </select>
        <Icon name="ChevronDown" />
      </span>
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
