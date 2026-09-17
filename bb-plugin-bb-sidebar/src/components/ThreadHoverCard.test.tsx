// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThreadHoverCard } from "./ThreadHoverCard";

function Card() {
  const [open, setOpen] = useState(false);
  return <ThreadHoverCard open={open} onOpenChange={setOpen} content={<a href="#port">Port</a>}><a href="#thread">Thread</a></ThreadHoverCard>;
}
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("stays open over blank card space and closes once the pointer leaves both regions", async () => {
  vi.useFakeTimers();
  render(<Card />);
  const row = screen.getByRole("link", { name: "Thread" });
  fireEvent.pointerMove(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(260); });
  const panel = screen.getByRole("dialog");
  expect(screen.getByRole("link", { name: "Thread", description: "Port" })).toBe(row);
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ left: 100, right: 350, top: 0, bottom: 300 } as DOMRect);
  fireEvent.pointerLeave(row);
  fireEvent(document, new MouseEvent("pointermove", { clientX: 200, clientY: 150, bubbles: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole("dialog")).toBe(panel);
  fireEvent(document, new MouseEvent("pointermove", { clientX: 500, clientY: 500, bubbles: true }));
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("does not open from pointer focus or a click", () => {
  render(<Card />);
  const row = screen.getByRole("link", { name: "Thread" });
  fireEvent.pointerDown(row);
  act(() => row.focus());
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.pointerUp(document);
  fireEvent.click(row);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("cancels dismissal when the pointer re-enters the row", async () => {
  vi.useFakeTimers();
  render(<Card />);
  const row = screen.getByRole("link", { name: "Thread" });
  fireEvent.pointerMove(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(260); });
  fireEvent.pointerLeave(row);
  fireEvent.pointerMove(row);
  await act(async () => { await vi.advanceTimersByTimeAsync(400); });
  expect(screen.getByRole("dialog")).toBeDefined();
});
