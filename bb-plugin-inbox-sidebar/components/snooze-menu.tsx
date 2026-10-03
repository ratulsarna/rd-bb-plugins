import { useState, type FormEvent, type ReactNode } from "react";
import * as Popover from "@radix-ui/react-popover";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { isolatedRowGestureProps } from "@/components/row-gesture";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { snoozePresets } from "@/lib/snooze";

/** `datetime-local` speaks local wall-clock text, not epoch ms. */
function toLocalInputValue(ms: number): string {
  const at = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/**
 * The snooze picker for one row. Wrap the row in it and mark the row with
 * `SnoozeAnchor`: the hover clock button and the row's context menu (the
 * touch path) then open one picker in one place. Content portals out and sits
 * beside the row in the React tree, so its clicks never reach the row's
 * open-thread handlers.
 */
export function SnoozeMenu({
  open,
  onOpenChange,
  onSnooze,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Absent on rows that cannot snooze; the picker then never renders. */
  onSnooze?: (until: number) => void;
  children: ReactNode;
}) {
  const portalScope = usePortalScopeProps();

  return (
    <Popover.Root open={open && onSnooze !== undefined} onOpenChange={onOpenChange}>
      {children}
      {onSnooze && (
        <Popover.Portal>
          <Popover.Content
            {...portalScope}
            align="end"
            sideOffset={4}
            aria-label="Snooze until"
            className="z-50 w-56 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md"
          >
            <SnoozeChoices
              onSnooze={(until) => {
                onOpenChange(false);
                onSnooze(until);
              }}
            />
          </Popover.Content>
        </Popover.Portal>
      )}
    </Popover.Root>
  );
}

export const SnoozeAnchor = Popover.Anchor;

/** The hover clock button. Must render inside `SnoozeMenu`'s children. */
export function SnoozeButton({ title }: { title: string }) {
  return (
    <Popover.Trigger asChild>
      <button
        type="button"
        aria-label={`Snooze ${title}`}
        title="Snooze"
        className="pointer-events-auto inline-flex size-5 items-center justify-center rounded bg-sidebar-accent text-muted-foreground opacity-0 hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/row:opacity-100 data-[state=open]:opacity-100"
        {...isolatedRowGestureProps}
      >
        <HugeiconsIcon icon={Clock01Icon} className="size-3.5" />
      </button>
    </Popover.Trigger>
  );
}

// Content mounts only while open, so the presets and the custom default are computed
// from the clock at the moment the user looks at them.
function SnoozeChoices({ onSnooze }: { onSnooze: (until: number) => void }) {
  const [now] = useState(() => new Date());
  const [custom, setCustom] = useState(() =>
    toLocalInputValue(now.getTime() + 60 * 60 * 1_000),
  );
  // An empty or malformed value parses to NaN, which fails the comparison.
  const customUntil = new Date(custom).getTime();
  const customValid = customUntil > Date.now();

  const submitCustom = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (customValid) onSnooze(customUntil);
  };

  return (
    <>
      {snoozePresets(now).map((preset) => (
        <button
          key={preset.label}
          type="button"
          onClick={() => onSnooze(preset.until)}
          className="flex w-full rounded-md px-2 py-1.5 text-left text-sm outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground"
        >
          {preset.label}
        </button>
      ))}
      <form
        onSubmit={submitCustom}
        className="mt-1 flex flex-col gap-1.5 border-t border-border px-2 pb-1 pt-2"
      >
        <label className="text-xs text-muted-foreground">
          Custom
          <input
            type="datetime-local"
            value={custom}
            min={toLocalInputValue(now.getTime())}
            onChange={(event) => setCustom(event.target.value)}
            className="mt-1 block w-full rounded border border-border bg-background px-1.5 py-1 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <button
          type="submit"
          disabled={!customValid}
          className="rounded-md bg-primary px-2 py-1 text-sm text-primary-foreground disabled:opacity-50"
        >
          Snooze
        </button>
      </form>
    </>
  );
}
