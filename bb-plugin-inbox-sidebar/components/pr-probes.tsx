import { useEffect, useState, type RefObject } from "react";
import {
  experimental_useSidebarThreadPullRequest as useSidebarThreadPullRequest,
  type PluginSidebarPullRequest,
} from "@bb/plugin-sdk/app";

type Report = (
  threadId: string,
  pullRequest: PluginSidebarPullRequest | null,
) => void;

interface VisibilityEntry {
  callback: (visible: boolean) => void;
  intersects: boolean;
  panel: Element | null;
}

const visibleCallbacks = new Map<Element, VisibilityEntry>();
let visibilityObserver: IntersectionObserver | null = null;
let panelObserver: MutationObserver | null = null;

function isVisible(entry: VisibilityEntry): boolean {
  const panel = entry.panel;
  return (
    entry.intersects &&
    (panel === null ||
      (!panel.hasAttribute("inert") &&
        panel.getAttribute("data-state") !== "closed" &&
        panel.getAttribute("data-collapsible") !== "offcanvas"))
  );
}

function observeVisibility(
  target: Element,
  callback: (visible: boolean) => void,
): () => void {
  visibilityObserver ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const observed = visibleCallbacks.get(entry.target);
      if (observed === undefined) continue;
      observed.intersects = entry.isIntersecting;
      observed.callback(isVisible(observed));
    }
  });
  panelObserver ??= new MutationObserver((changes) => {
    for (const change of changes) {
      for (const observed of visibleCallbacks.values()) {
        if (observed.panel === change.target) {
          observed.callback(isVisible(observed));
        }
      }
    }
  });
  const panel =
    target.closest("[data-collapsible]") ??
    target.closest('[data-sidebar="panel"]');
  visibleCallbacks.set(target, { callback, intersects: false, panel });
  if (panel !== null) {
    panelObserver.observe(panel, {
      attributes: true,
      attributeFilter: ["inert", "data-state", "data-collapsible"],
    });
  }
  visibilityObserver.observe(target);
  return () => {
    visibilityObserver?.unobserve(target);
    visibleCallbacks.delete(target);
    if (visibleCallbacks.size === 0) {
      visibilityObserver?.disconnect();
      visibilityObserver = null;
      panelObserver?.disconnect();
      panelObserver = null;
    }
  };
}

function ActivePrProbe({
  threadId,
  report,
}: {
  threadId: string;
  report: Report;
}) {
  const { isLoading, pullRequest } = useSidebarThreadPullRequest(threadId);

  useEffect(() => {
    if (!isLoading) report(threadId, pullRequest);
  }, [isLoading, pullRequest, report, threadId]);

  return null;
}

export function PrProbe({
  threadId,
  report,
  targetRef,
}: {
  threadId: string;
  report: Report;
  targetRef: RefObject<HTMLElement | null>;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const target = targetRef.current;
    if (target === null) return;
    if (typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    return observeVisibility(target, setVisible);
  }, [targetRef]);

  return visible ? <ActivePrProbe threadId={threadId} report={report} /> : null;
}
