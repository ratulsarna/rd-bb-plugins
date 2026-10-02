import * as Select from "@radix-ui/react-select";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { Icon } from "./icon";

interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

const EMPTY_OPTION = "__pipeline_empty__";

export function PipelineSelect(props: {
  "aria-label": string;
  value: string;
  onValueChange(value: string): void;
  options: readonly SelectOption[];
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  className?: string;
}) {
  const portalScope = usePortalScopeProps();
  const groups = new Map<string, SelectOption[]>();
  for (const option of props.options) {
    const group = option.group ?? "";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(option);
  }

  return <Select.Root value={props.value} disabled={props.disabled} required={props.required}
    onValueChange={(value) => {
      // Ignore hidden form-control changes during option loading; explicit clears use EMPTY_OPTION.
      if (value !== "") props.onValueChange(value === EMPTY_OPTION ? "" : value);
    }}>
    <Select.Trigger type="button" className={`pipeline-select ${props.className ?? ""}`} aria-label={props["aria-label"]}>
      <Select.Value placeholder={props.placeholder} />
      <Select.Icon asChild><Icon name="ChevronDown" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content {...portalScope} className="pipeline-ui pipeline-select-content" position="popper" sideOffset={5} collisionPadding={12}>
        <Select.ScrollUpButton className="pipeline-select-scroll"><Icon name="ChevronUp" /></Select.ScrollUpButton>
        <Select.Viewport className="pipeline-select-viewport">
          {[...groups].map(([group, options]) => <Select.Group key={group} className="pipeline-select-group">
            {group && <Select.Label className="pipeline-select-label">{group}</Select.Label>}
            {options.map((option) => <Select.Item key={option.value} value={option.value || EMPTY_OPTION}
              disabled={option.disabled} className="pipeline-select-item">
              <Select.ItemText>{option.label}</Select.ItemText>
              <Select.ItemIndicator className="pipeline-select-indicator"><Icon name="Check" /></Select.ItemIndicator>
            </Select.Item>)}
          </Select.Group>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="pipeline-select-scroll"><Icon name="ChevronDown" /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
