"use client";

import { useEffect, useState, ViewTransition } from "react";
import { Maximize2Icon, SettingsIcon, UsersIcon, XIcon } from "lucide-react";
import { cn } from "cn";
import ProjectDialog from "@/components/ProjectDialog";
import ShareDialog from "@/components/ShareDialog";
import { Button, PILL } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { api, type Project } from "@/lib/api";
import {
  folderLabel,
  matchesFilter,
  openedLabel,
  plural,
  type ProjectFilter,
  sharingLabel,
} from "@/lib/projects";

const FILTERS: [ProjectFilter, string][] = [
  ["all", "All"],
  ["private", "Private"],
  ["shared", "Shared"],
];

function ProjectRow({
  project,
  current,
  now,
  onOpen,
  onSettings,
  onShare,
}: {
  project: Project;
  current: boolean;
  now: number;
  onOpen: () => void;
  onSettings: () => void;
  onShare: () => void;
}) {
  const badge = sharingLabel(project);
  const [first, ...rest] = project.folders;
  return (
    <li
      data-testid={`project-${project.id}`}
      aria-current={current || undefined}
      className={cn(
        "group -mx-3 grid cursor-pointer grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-xl border-b px-3 py-4.5 hover:border-transparent hover:bg-muted/60",
        current && "border-transparent bg-muted/60",
      )}
      onClick={onOpen}
    >
      <div className="flex min-w-0 items-center gap-2.5 font-medium">
        <span className="truncate">{project.name}</span>
        {current && (
          <span className="shrink-0 rounded-full bg-foreground px-2 text-xs font-normal text-background">
            Current
          </span>
        )}
        {badge && (
          <span className="shrink-0 rounded-full border px-2 text-xs font-normal text-muted-foreground">
            {badge}
          </span>
        )}
      </div>
      <div className="row-span-2 flex items-center gap-4 self-center">
        {project.is_owner && (
          <span className="flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Share"
              title="Share"
              className="rounded-full text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onShare();
              }}
            >
              <UsersIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Settings"
              title="Settings"
              data-testid={`project-settings-${project.id}`}
              className="rounded-full text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                onSettings();
              }}
            >
              <SettingsIcon />
            </Button>
          </span>
        )}
        <span className="text-right text-sm text-muted-foreground tabular-nums">
          <b className="block text-[15px] font-medium text-foreground">
            {project.annotation_count?.toLocaleString("en-US") ?? "–"}
          </b>
          {project.shared_layer ? "shared annotations" : "annotations"}
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground">
        <span className="flex" aria-label={project.jobs.map((j) => j.name).join(", ")}>
          {project.jobs.slice(0, 8).map((j, i) => (
            <i
              key={j.id}
              className={cn("size-2.5 rounded-full ring-2 ring-background", i > 0 && "-ml-0.75")}
              style={{ background: j.color }}
            />
          ))}
        </span>
        {first ? (
          <>
            <span className="truncate font-mono text-xs">{folderLabel(first.path)}</span>
            {rest.length > 0 && <span>+{plural(rest.length, "folder")}</span>}
          </>
        ) : (
          <span>Any folder</span>
        )}
        {project.image_count !== null && <span>{plural(project.image_count, "image")}</span>}
        {project.listing_error && <span className="text-destructive">{project.listing_error}</span>}
        <span>{openedLabel(project.opened, now)}</span>
      </div>
    </li>
  );
}

// What the overlay showed when it expanded, so the projects page opens with the same list in
// place and the panel morphs from one to the other.
export const expanded: { current?: { projects: Project[] | null; currentId: number | null } } = {};

// The projects list with its create, settings and share dialogs, over the editor or as a page.
export default function ProjectsPanel({
  currentId,
  onOpen,
  onChanged,
  onDeleted,
  onExpand,
  onClose,
  initialProjects = null,
}: {
  currentId: number | null;
  onOpen: (project: Project) => void;
  // A project's settings or sharing changed.
  onChanged: (project: Project) => void;
  onDeleted: (id: number) => void;
  // Only in the overlay: opens the projects page.
  onExpand?: () => void;
  // Only in the overlay, when there is a project to return to.
  onClose?: () => void;
  initialProjects?: Project[] | null;
}) {
  const [projects, setProjects] = useState(initialProjects);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [sharing, setSharing] = useState<Project | null>(null);
  // The projects page keeps the panel open, so "Opened …" labels advance.
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);

  // Counts are null until the server has listed a project's images in the background.
  const counting = projects?.some((p) => p.annotation_count === null && !p.listing_error) ?? false;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => {
      if (!document.hidden) api.projects().then(setProjects, () => {});
    }, 3000);
    return () => clearInterval(timer);
  }, [counting]);

  const replace = (p: Project) => {
    setProjects((all) => all && all.map((x) => (x.id === p.id ? p : x)));
    onChanged(p);
  };
  const shown = projects?.filter((p) => matchesFilter(p, filter)) ?? [];
  const Title = onExpand ? DialogTitle : "h1";

  return (
    <>
      <ViewTransition name="projects-panel" share="auto" default="none">
        <div data-testid="projects-panel" className="flex min-h-0 flex-col text-base">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Title className="text-[28px] leading-none font-semibold tracking-tight">
              Projects
            </Title>
            <div className="flex items-center gap-2">
              {/* Slides over to where the expand button was, rather than crossfading. */}
              <ViewTransition name="projects-new" share="auto" default="none">
                <Button
                  className={PILL}
                  data-testid="new-project"
                  onClick={() => setCreating(true)}
                >
                  New project
                </Button>
              </ViewTransition>
              {onExpand && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open full page"
                  title="Open full page"
                  data-testid="expand-projects"
                  className="size-9 rounded-full text-muted-foreground"
                  onClick={() => {
                    expanded.current = { projects, currentId };
                    onExpand();
                  }}
                >
                  <Maximize2Icon />
                </Button>
              )}
              {onClose && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Close"
                  title="Close"
                  data-testid="close-projects"
                  className="-ml-1 size-9 rounded-full text-muted-foreground"
                  onClick={onClose}
                >
                  <XIcon />
                </Button>
              )}
            </div>
          </div>
          <div
            role="group"
            aria-label="Filter projects"
            className="mt-5 mb-2 inline-flex gap-1 self-start rounded-full bg-muted p-0.75"
          >
            {FILTERS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={filter === id}
                data-testid={`filter-${id}`}
                className="rounded-full px-3.5 py-1 text-[13px] text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-sm"
                onClick={() => setFilter(id)}
              >
                {label}
              </button>
            ))}
          </div>
          {error && (
            <p role="alert" className="py-6 text-sm text-destructive">
              Could not load projects. {error}
            </p>
          )}
          {!projects && !error && <p className="py-6 text-sm text-muted-foreground">Loading</p>}
          {projects && !shown.length && (
            <p className="py-6 text-sm text-muted-foreground">
              {filter === "all" ? "No projects yet." : `No ${filter} projects.`}
            </p>
          )}
          <ul data-testid="project-list" className="-mx-3 min-h-0 overflow-y-auto px-3">
            {shown.map((p) => (
              <ProjectRow
                key={p.id}
                project={p}
                current={p.id === currentId}
                now={now}
                onOpen={() => onOpen(p)}
                onSettings={() => setEditing(p)}
                onShare={() => setSharing(p)}
              />
            ))}
          </ul>
        </div>
      </ViewTransition>
      <ProjectDialog open={creating} onOpenChange={setCreating} onSaved={onOpen} />
      <ProjectDialog
        key={editing?.id}
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        project={editing ?? undefined}
        onSaved={replace}
        onDeleted={() => {
          if (!editing) return;
          setProjects((all) => all && all.filter((x) => x.id !== editing.id));
          onDeleted(editing.id);
        }}
      />
      <ShareDialog
        project={sharing}
        onOpenChange={(o) => !o && setSharing(null)}
        onSaved={replace}
      />
    </>
  );
}
