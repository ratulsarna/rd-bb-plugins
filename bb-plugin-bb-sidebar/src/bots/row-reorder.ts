import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import type { CSSProperties } from "react";

/** dnd-kit's sortable bindings for one draggable row. */
export interface RowReorder {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  setNodeRef(node: HTMLElement | null): void;
  setActivatorNodeRef(node: HTMLElement | null): void;
  isDragging: boolean;
  style: CSSProperties;
}
