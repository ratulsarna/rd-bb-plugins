import type { JSX as ReactJSX } from "react";

// dnd-kit's declarations still use the pre-React-19 global JSX.Element name.
declare global {
  namespace JSX {
    type Element = ReactJSX.Element;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}

export {};
