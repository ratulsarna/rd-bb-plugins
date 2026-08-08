import { useEffect, useState } from "react";
import type { PluginSidebarProject } from "@bb/plugin-sdk/app";

/**
 * The display-only project scope, shared by both surfaces. "" means every
 * project; a project that disappears releases the filter rather than leaving
 * the board scoped to something the user can no longer see.
 */
export function useProjectFilter(
  projects: readonly PluginSidebarProject[],
): [string, (projectId: string) => void] {
  const [projectId, setProjectId] = useState("");

  useEffect(() => {
    if (projectId && !projects.some((project) => project.id === projectId)) {
      setProjectId("");
    }
  }, [projectId, projects]);

  return [projectId, setProjectId];
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
