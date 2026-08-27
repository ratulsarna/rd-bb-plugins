import { useState, type ReactNode } from "react";

const storageKey = (id: string) => `inbox-sidebar:collapsed:${id}`;

function readCollapsed(id: string): boolean | null {
  const raw = localStorage.getItem(storageKey(id));
  return raw === null ? null : raw === "1";
}

interface CollapsibleSectionProps {
  /** Storage key suffix; stable across renames of the visible label. */
  id: string;
  label: string;
  count: number;
  /** What an untouched section does. A click stores an explicit choice. */
  defaultExpanded: boolean;
  /**
   * Display-only override: search results must never hide behind a collapsed
   * header. The stored choice is untouched and returns when the force lifts.
   */
  forceExpanded?: boolean;
  /**
   * A control rendered at the header's right edge, beside the collapse
   * arrow. Only shown while expanded — it acts on the visible rows.
   */
  headerAction?: ReactNode;
  children: ReactNode;
}

/**
 * A sidebar section behind a collapsible header, the way the Settled shelf
 * has always worked: the label carries the count while shut, one click flips
 * it, and the choice persists across reloads.
 */
export function CollapsibleSection({
  id,
  label,
  count,
  defaultExpanded,
  forceExpanded = false,
  headerAction,
  children,
}: CollapsibleSectionProps) {
  const [collapsed, setCollapsed] = useState<boolean | null>(() =>
    readCollapsed(id),
  );
  const expanded = forceExpanded || !(collapsed ?? !defaultExpanded);

  const toggle = () => {
    const next = !expanded;
    setCollapsed(!next);
    localStorage.setItem(storageKey(id), next ? "0" : "1");
  };

  return (
    <section aria-label={label}>
      <div className="mt-5 flex w-full items-center gap-2 px-2.5 pb-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
            {expanded ? label : `${label} (${count})`}
          </span>
          <span className="h-px flex-1 bg-sidebar-border" />
          <span aria-hidden className="text-[11px] text-muted-foreground/70">
            {expanded ? "▾" : "▸"}
          </span>
        </button>
        {expanded && headerAction}
      </div>
      {expanded && <ul className="flex flex-col gap-1">{children}</ul>}
    </section>
  );
}
