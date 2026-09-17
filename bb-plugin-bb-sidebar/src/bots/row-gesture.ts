import type { SyntheticEvent } from "react";

const stopRowGesture = (event: SyntheticEvent) => event.stopPropagation();

/** Keep an independent control out of both row-level drag gestures. */
export const isolatedRowGestureProps = {
  onPointerDown: stopRowGesture,
  onMouseDown: stopRowGesture,
  onTouchStart: stopRowGesture,
  onKeyDown: stopRowGesture,
};
