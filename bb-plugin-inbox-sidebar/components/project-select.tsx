import { useCallback, useEffect, useState } from "react";
import type { PluginSidebarProject } from "@bb/plugin-sdk/app";

/**
 * The display-only project scope, shared by both surfaces. "" means every
 * project; a project that disappears releases the filter rather than leaving
 * the board scoped to something the user can no longer see.
 */
export function useProjectFilter(
  projects: readonly PluginSidebarProject[],
): [
  string,
  (projectId: string) => void,
  (projectId: string) => void,
] {
  const [selection, setSelection] = useState({
    projectId: "",
    allowMissing: false,
  });

  const setProjectId = useCallback((projectId: string) => {
    setSelection({ projectId, allowMissing: false });
  }, []);

  const setPendingProjectId = useCallback((projectId: string) => {
    setSelection({ projectId, allowMissing: true });
  }, []);

  useEffect(() => {
    if (!selection.projectId) return;

    const exists = projects.some(
      (project) => project.id === selection.projectId,
    );
    if (selection.allowMissing) {
      if (exists) {
        setSelection((current) =>
          current.projectId === selection.projectId
            ? { ...current, allowMissing: false }
            : current,
        );
      }
      return;
    }

    if (!exists) setProjectId("");
  }, [projects, selection, setProjectId]);

  return [selection.projectId, setProjectId, setPendingProjectId];
}

export function ProjectSelect({
  projects,
  value,
  onChange,
  className,
}: {
  projects: readonly PluginSidebarProject[];
  value: string;
  onChange: (projectId: string) => void;
  className: string;
}) {
  return (
    <select
      aria-label="Filter by project"
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      <option value="">All projects</option>
      {projects.map((project) => (
        <option key={project.id} value={project.id}>
          {project.name}
        </option>
      ))}
    </select>
  );
}
