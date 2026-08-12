export function Field({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-[0.04em] text-muted-foreground">
        {label}
      </div>
      <div className="truncate text-[13px] leading-snug text-foreground">
        {value}
      </div>
    </div>
  );
}

export function Chip({
  children,
  tone = "default",
}: {
  children: string;
  tone?: "default" | "accent";
}) {
  return (
    <span
      className={
        tone === "accent"
          ? "rounded-full border border-primary/35 px-1.5 py-1 text-[10.5px] leading-none text-primary"
          : "rounded-full border border-border bg-muted/40 px-1.5 py-1 text-[10.5px] leading-none text-muted-foreground"
      }
    >
      {children}
    </span>
  );
}
