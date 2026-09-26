// @vitest-environment jsdom
import { useRef } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureFakeSdk, pullRequestProbeCalls } from "@/test/sdk-fake";
import { PrProbe } from "./pr-probes";

class TestIntersectionObserver {
  private readonly targets = new Set<Element>();

  constructor(private readonly callback: IntersectionObserverCallback) {}

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  emit(target: Element, visible: boolean) {
    if (!this.targets.has(target)) return;
    this.callback(
      [{ target, isIntersecting: visible } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

function ProbeRow({ threadId }: { threadId: string }) {
  const rowRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rowRef} data-probe-row={threadId}>
      <PrProbe threadId={threadId} report={() => {}} targetRef={rowRef} />
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PrProbe visibility", () => {
  it("mounts queries only for intersecting rows out of a large board", () => {
    configureFakeSdk();
    let observer: TestIntersectionObserver | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class extends TestIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          super(callback);
          observer = this;
        }
      },
    );
    const { container } = render(
      <div data-sidebar="panel" data-state="open">
        {Array.from({ length: 120 }, (_, index) => (
          <ProbeRow key={index} threadId={`thread-${index}`} />
        ))}
      </div>,
    );

    expect(pullRequestProbeCalls).toEqual([]);
    const rows = container.querySelectorAll("[data-probe-row]");
    act(() => {
      for (const index of [0, 1, 2, 3]) {
        observer!.emit(rows[index]!, true);
      }
    });
    expect(new Set(pullRequestProbeCalls)).toEqual(
      new Set(["thread-0", "thread-1", "thread-2", "thread-3"]),
    );
  });

  it("waits for a closed mobile drawer even when rows intersect", async () => {
    configureFakeSdk();
    let observer: TestIntersectionObserver | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class extends TestIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          super(callback);
          observer = this;
        }
      },
    );
    const { container, rerender } = render(
      <div data-sidebar="panel" data-state="closed" inert>
        <ProbeRow threadId="thread-mobile" />
      </div>,
    );
    const panel = container.firstElementChild!;
    const row = container.querySelector("[data-probe-row]")!;

    act(() => observer!.emit(row, true));
    expect(pullRequestProbeCalls).toEqual([]);

    act(() => {
      panel.removeAttribute("inert");
      panel.setAttribute("data-state", "open");
    });
    await waitFor(() => expect(pullRequestProbeCalls).toContain("thread-mobile"));

    act(() => panel.setAttribute("data-state", "closed"));
    await act(async () => {
      await Promise.resolve();
    });
    pullRequestProbeCalls.length = 0;
    rerender(
      <div data-sidebar="panel" data-state="closed" inert>
        <ProbeRow threadId="thread-mobile" />
      </div>,
    );
    expect(pullRequestProbeCalls).toEqual([]);
  });

  it("does not probe a collapsed desktop sidebar", async () => {
    configureFakeSdk();
    let observer: TestIntersectionObserver | null = null;
    vi.stubGlobal(
      "IntersectionObserver",
      class extends TestIntersectionObserver {
        constructor(callback: IntersectionObserverCallback) {
          super(callback);
          observer = this;
        }
      },
    );
    const { container } = render(
      <div data-collapsible="offcanvas" data-state="collapsed">
        <div data-sidebar="panel">
          <ProbeRow threadId="thread-desktop" />
        </div>
      </div>,
    );
    const panel = container.firstElementChild!;
    const row = container.querySelector("[data-probe-row]")!;

    act(() => observer!.emit(row, true));
    expect(pullRequestProbeCalls).toEqual([]);

    act(() => panel.setAttribute("data-collapsible", ""));
    await waitFor(() => expect(pullRequestProbeCalls).toContain("thread-desktop"));
  });
});
