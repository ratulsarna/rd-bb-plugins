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
import type { BoardItem } from "@/lib/lanes";
import { projectPinnedReorder } from "@/lib/pinned-order";

const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

const pinnedCollisionDetection: CollisionDetection = (args) => {
  const pointerHits = pointerWithin(args);
  return pointerHits.length > 0 ? pointerHits : closestCenter(args);
};

interface PinnedReorderProps {
  items: readonly BoardItem[];
  fullOrder: readonly string[];
  enabled: boolean;
  movePending: boolean;
  onMove: (
    threadId: string,
    previousThreadId: string | null,
    nextThreadId: string | null,
  ) => void;
  children: (item: BoardItem, reorder: RowReorder | undefined) => ReactNode;
}

/** BB-compatible pointer sorting for pinned roots. */
export function PinnedReorder({
  items,
  fullOrder,
  enabled,
  movePending,
  onMove,
  children,
}: PinnedReorderProps) {
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
      (projectedOrder ?? fullOrder).map((threadId, index) => [threadId, index]),
    );
    return [...items].sort(
      (a, b) =>
        (rank.get(a.thread.id) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.thread.id) ?? Number.MAX_SAFE_INTEGER),
    );
  }, [fullOrder, items, projectedOrder]);
  const visibleIds = useMemo(
    () => visibleItems.map((item) => item.thread.id),
    [visibleItems],
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
        onMove(
          String(event.active.id),
          projection.previousThreadId,
          projection.nextThreadId,
        );
      }
      finishGesture();
    },
    [finishGesture, fullOrder, onMove],
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pinnedCollisionDetection}
      modifiers={[verticalOnly]}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={finishGesture}
    >
      <SortableContext items={visibleIds} strategy={verticalListSortingStrategy}>
        {visibleItems.map((item) => (
          <SortablePinnedRow
            key={item.thread.id}
            item={item}
            disabled={!enabled || reorderLocked}
          >
            {children}
          </SortablePinnedRow>
        ))}
      </SortableContext>
    </DndContext>
  );
}

function SortablePinnedRow({
  item,
  disabled,
  children,
}: {
  item: BoardItem;
  disabled: boolean;
  children: PinnedReorderProps["children"];
}) {
  const sortable = useSortable({ id: item.thread.id, disabled });
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
