import { useEffect, useRef, useState } from "react";
import {
  favoriteAvailabilityError,
  favoriteOpenLabel,
  speedLabel,
} from "@/lib/favorites";
import type { Favorite } from "@/lib/schema";
import { Chip, Field } from "./field";

export function FavoriteTile({
  favorite,
  onOpen,
  onDelete,
}: {
  favorite: Favorite;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const launchError = favoriteAvailabilityError(favorite);
  const speed = speedLabel(favorite.serviceTier);
  const name = favorite.name.trim();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [menuOpen]);

  return (
    <div className="relative aspect-square min-w-0">
      <button
        type="button"
        aria-label={favoriteOpenLabel(favorite)}
        onClick={onOpen}
        className="flex size-full min-w-0 flex-col gap-2 overflow-hidden rounded-[14px] border border-border bg-card p-3.5 text-left transition-colors hover:bg-accent/40"
      >
        {name ? (
          <div className="truncate pr-7 text-[14px] font-semibold leading-5 text-foreground">
            {name}
          </div>
        ) : null}
        <div className="grid min-h-0 min-w-0 flex-1 grid-cols-2 content-start gap-x-3 gap-y-2">
          <Field label="Project" value={favorite.projectName} />
          <Field label="Machine" value={favorite.hostName} />
          <Field label="Harness" value={favorite.providerName} />
          <Field label="Model" value={favorite.modelName} />
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Chip>{favorite.reasoningLevel}</Chip>
          {speed ? (
            <Chip tone={speed === "Fast" ? "accent" : "default"}>{speed}</Chip>
          ) : null}
        </div>
        {launchError ? (
          <p className="text-[11px] leading-snug text-destructive">
            {launchError}
          </p>
        ) : null}
      </button>
      <div ref={menuRef} className="absolute top-2 right-2">
        <button
          type="button"
          aria-label={`More actions for ${name || favorite.projectName}`}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
          className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          ⋯
        </button>
        {menuOpen ? (
          <div
            role="menu"
            className="absolute top-7 right-0 z-10 min-w-28 rounded-lg border border-border bg-popover p-1 shadow-none"
          >
            <button
              type="button"
              role="menuitem"
              className="block w-full rounded-md px-2 py-1.5 text-left text-[13px] text-destructive hover:bg-accent"
              onClick={(event) => {
                event.stopPropagation();
                setMenuOpen(false);
                onDelete();
              }}
            >
              Delete
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
