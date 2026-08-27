import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  TouchSensor,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
  type Modifier,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { RowReorder } from "@/components/sidebar-row";
import {
  projectPinnedReorder,
  type PinnedReorderProjection,
} from "@/lib/pinned-order";

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const rowCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  return pointerHits.length > 0 ? pointerHits : closestCenter(args);
};

interface SortableRowsProps<T> {
  items: readonly T[];
  idOf(item: T): string;
  /** The complete order, including rows a filter hides from `items`. */
  fullOrder: readonly string[];
  enabled: boolean;
  movePending: boolean;
  onMove(activeId: string, projection: PinnedReorderProjection): void;
  children: (item: T, reorder: RowReorder | undefined) => ReactNode;
}

/**
 * Pointer sorting for a section's rows. Shared by Pinned (whose order bb owns,
 * moved by neighbours) and Bots (whose order the plugin stores whole) — the
 * projection hands each caller both shapes.
 */
export function SortableRows<T>({
  items,
  idOf,
  fullOrder,
  enabled,
  movePending,
  onMove,
  children,
}: SortableRowsProps<T>) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 4 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 6 },
    }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [projectedOrder, setProjectedOrder] = useState<readonly string[] | null>(
    null,
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const { beginSuppressingClicks, finishSuppressingClicks } =
    useDragClickSuppression();

  // A server response is authoritative, whether the move worked or refreshed
  // after failure. Until then the completed projection prevents a visual snap.
  useEffect(() => setProjectedOrder(null), [fullOrder]);
  useEffect(() => {
    if (!movePending) setProjectedOrder(null);
  }, [movePending]);

  const reorderLocked = movePending || projectedOrder !== null;

  const visibleItems = useMemo(() => {
    const rank = new Map(
      (projectedOrder ?? fullOrder).map((id, index) => [id, index]),
    );
    return [...items].sort(
      (a, b) =>
        (rank.get(idOf(a)) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(idOf(b)) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [fullOrder, idOf, items, projectedOrder]);
  const visibleIds = useMemo(
    () => visibleItems.map(idOf),
    [idOf, visibleItems],
  );

  const finishGesture = useCallback(() => {
    setActiveId(null);
    finishSuppressingClicks();
  }, [finishSuppressingClicks]);

  // The host split session dispatches Escape when the pointer leaves the
  // sidebar. Clear our owner state even if dnd-kit consumes that event first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && activeId !== null) finishGesture();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [activeId, finishGesture]);

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      setActiveId(String(event.active.id));
      beginSuppressingClicks();
    },
    [beginSuppressingClicks],
  );

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const projection = event.over
        ? projectPinnedReorder(
            fullOrder,
            String(event.active.id),
            String(event.over.id),
          )
        : null;
      if (projection) {
        setProjectedOrder(projection.ids);
        onMove(String(event.active.id), projection);
      }
      finishGesture();
    },
    [finishGesture, fullOrder, onMove],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={rowCollisionDetection}
      modifiers={[verticalOnly]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={finishGesture}
    >
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        {visibleItems.map((item) => (
          <SortableRow
            key={idOf(item)}
            id={idOf(item)}
            item={item}
            disabled={!enabled || reorderLocked}
          >
            {children}
          </SortableRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortableRow<T>({
  id,
  item,
  disabled,
  children,
}: {
  id: string;
  item: T;
  disabled: boolean;
  children: SortableRowsProps<T>["children"];
}) {
  const sortable = useSortable({ id, disabled });
  const reorder: RowReorder | undefined = disabled
    ? undefined
    : {
        attributes: sortable.attributes,
        listeners: sortable.listeners,
        setNodeRef: sortable.setNodeRef,
        setActivatorNodeRef: sortable.setActivatorNodeRef,
        isDragging: sortable.isDragging,
        style: {
          transform: CSS.Translate.toString(sortable.transform),
          transition: sortable.transition,
          opacity: sortable.isDragging ? 0.7 : undefined,
          zIndex: sortable.isDragging ? 1 : undefined,
        },
      };
  return children(item, reorder);
}

function useDragClickSuppression() {
  const suppressing = useRef(false);
  const releaseTimer = useRef<number | null>(null);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (!suppressing.current) return;
      suppressing.current = false;
      if (releaseTimer.current !== null) {
        window.clearTimeout(releaseTimer.current);
        releaseTimer.current = null;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
    };
  }, []);

  const beginSuppressingClicks = useCallback(() => {
    if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
    suppressing.current = true;
  }, []);

  const finishSuppressingClicks = useCallback(() => {
    if (releaseTimer.current !== null) window.clearTimeout(releaseTimer.current);
    releaseTimer.current = window.setTimeout(() => {
      suppressing.current = false;
      releaseTimer.current = null;
    }, 350);
  }, []);

  return { beginSuppressingClicks, finishSuppressingClicks };
}
