import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, expect } from "vitest";

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => {
  if (!scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value() {} });
  }
});
afterAll(() => {
  if (!scrollIntoView) Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

export async function openSelect(trigger: HTMLElement) {
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  return screen.findByRole("listbox");
}

export async function chooseSelectOption(trigger: HTMLElement, name: string | RegExp) {
  const menu = await openSelect(trigger);
  fireEvent.click(within(menu).getByRole("option", { name }));
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}
