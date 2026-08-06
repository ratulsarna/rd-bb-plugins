import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";

export type SearchableOption = {
  value: string;
  label: string;
  description?: string;
  badge?: string;
};

type SearchablePickerProps = {
  title: string;
  description: string;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  disabled?: boolean;
  value: SearchableOption | null;
  loadOptions: (query: string) => Promise<SearchableOption[]>;
  customOption?: (query: string) => SearchableOption | null;
  onSelect: (option: SearchableOption) => void;
};

export function SearchablePicker({
  title,
  description,
  placeholder,
  searchPlaceholder,
  emptyLabel,
  disabled,
  value,
  loadOptions,
  customOption,
  onSelect,
}: SearchablePickerProps) {
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchableOption[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      void loadOptions(query)
        .then((loaded) => {
          if (cancelled) return;
          const custom = customOption?.(query) ?? null;
          const hasLoadedMatch = custom && loaded.some(({ value }) =>
            value.toLowerCase().startsWith(custom.value.toLowerCase())
          );
          setOptions(
            custom && !hasLoadedMatch
              ? [custom, ...loaded]
              : loaded,
          );
          setActiveIndex(0);
        })
        .catch((cause) => {
          if (!cancelled) {
            setOptions([]);
            setError(cause instanceof Error ? cause.message : "Could not load options");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [customOption, loadOptions, open, query]);

  function choose(option: SearchableOption) {
    onSelect(option);
    setOpen(false);
    setQuery("");
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="h-9 w-full justify-between gap-2 px-3 font-normal"
          disabled={disabled}
        >
          <span className={value ? "truncate" : "truncate text-muted-foreground"}>
            {value?.label ?? placeholder}
          </span>
          <Icon name="ChevronDown" className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DialogTrigger>
      <DialogContent className="gap-3 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Input
          value={query}
          placeholder={searchPlaceholder}
          role="combobox"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={options[activeIndex]
            ? `${listboxId}-${activeIndex}`
            : undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActiveIndex((current) =>
                Math.min(current + 1, Math.max(options.length - 1, 0)),
              );
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex((current) => Math.max(current - 1, 0));
            }
            if (event.key === "Home") {
              event.preventDefault();
              setActiveIndex(0);
            }
            if (event.key === "End") {
              event.preventDefault();
              setActiveIndex(Math.max(options.length - 1, 0));
            }
            if (event.key === "Enter" && options[activeIndex]) {
              event.preventDefault();
              choose(options[activeIndex]);
            }
          }}
        />
        <div
          id={listboxId}
          role="listbox"
          className="max-h-72 overflow-y-auto rounded-md border border-border p-1"
        >
          {loading && (
            <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Icon name="Spinner" className="size-4 animate-spin" aria-hidden="true" />
              Loading…
            </div>
          )}
          {!loading && error && <p className="p-3 text-sm text-destructive">{error}</p>}
          {!loading && !error && options.length === 0 && (
            <p className="p-3 text-sm text-muted-foreground">{emptyLabel}</p>
          )}
          {!loading && !error && options.map((option, index) => (
            <button
              key={`${option.value}:${option.badge ?? ""}`}
              id={`${listboxId}-${index}`}
              type="button"
              role="option"
              aria-selected={value?.value === option.value}
              className={`flex w-full items-start gap-2 rounded-sm px-2 py-2 text-left text-sm ${
                activeIndex === index ? "bg-accent text-accent-foreground" : ""
              }`}
              title={option.description ? `${option.label} — ${option.description}` : option.label}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{option.label}</span>
                {option.description && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {option.description}
                  </span>
                )}
              </span>
              {option.badge && (
                <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  {option.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
