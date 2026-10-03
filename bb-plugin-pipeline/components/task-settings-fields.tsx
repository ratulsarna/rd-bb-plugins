import { MODES, SIZES, shapeReviewLabel, type CardMode, type CardSize } from "@/lib/store";
import { PipelineSelect } from "./select";

type ShapeReview = "on" | "off";
const SHAPE_REVIEW: readonly ShapeReview[] = ["off", "on"];

const LABELS: Record<CardMode | CardSize | ShapeReview, string> = {
  manual: "Manual",
  auto: "Auto",
  small: "Small",
  standard: "Standard",
  off: "Off",
  on: "On",
};

function SettingSelect<T extends CardMode | CardSize | ShapeReview>(props: {
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
  shapeReview: boolean;
  onShapeReviewChange(on: boolean): void;
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
      <SettingSelect name="Shape review" label={`Shape review${suffix}`} options={SHAPE_REVIEW} value={shapeReviewLabel(props.shapeReview)}
        onChange={(value) => props.onShapeReviewChange(value === "on")} disabled={props.disabled} />
    </>
  );
}
