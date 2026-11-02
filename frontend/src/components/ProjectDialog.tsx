"use client";

import { type FormEvent, useEffect, useState } from "react";
import { PlusIcon, XIcon } from "lucide-react";
import FolderPickerDialog from "@/components/FolderPickerDialog";
import { Button, PILL } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type Job, type Kind, type Project, type ProjectFolder } from "@/lib/api";
import {
  adaptLabels,
  folderKinds,
  folderLabel,
  KINDS,
  type Label,
  nextColor,
} from "@/lib/projects";
import { errorMessage } from "@/lib/utils";

// Creates a project, or edits one when given.
export default function ProjectDialog({
  open,
  onOpenChange,
  project,
  onSaved,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project?: Project;
  onSaved: (project: Project) => void;
  onDeleted?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="project-dialog">
        <Form
          project={project}
          onClose={() => onOpenChange(false)}
          onSaved={onSaved}
          onDeleted={onDeleted}
        />
      </DialogContent>
    </Dialog>
  );
}

function Form({
  project,
  onClose,
  onSaved,
  onDeleted,
}: {
  project?: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
  onDeleted?: () => void;
}) {
  const [name, setName] = useState(project?.name ?? "");
  const [folders, setFolders] = useState<ProjectFolder[]>(project?.folders ?? []);
  const [labels, setLabels] = useState<Label[]>(project?.jobs ?? []);
  const [presets, setPresets] = useState<Record<Kind, Job[]>>({ histo: [], elmi: [] });
  // The group a label is being added to, and its name so far.
  const [newLabel, setNewLabel] = useState<{ kind: Kind; name: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.jobPresets().then(
      (loaded) => {
        setPresets(loaded);
        // A new project starts with the presets for every kind its (no) folders may hold.
        if (!project)
          setLabels((l) => (l.length ? l : adaptLabels([], [], folderKinds([]), loaded)));
      },
      () => {},
    );
  }, [project]);

  function changeFolders(next: ProjectFolder[]) {
    setLabels((l) => adaptLabels(l, folderKinds(folders), folderKinds(next), presets));
    setFolders(next);
  }

  async function addFolders(ids: string[]) {
    try {
      // The server keeps only the outermost folders, so show what it will save.
      changeFolders(await api.resolveFolders([...folders.map((f) => f.id), ...ids]));
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function addLabel() {
    const name = newLabel?.name.trim();
    if (newLabel && name)
      setLabels((l) => [
        ...l,
        { name, color: nextColor(l.map((j) => j.color)), kind: newLabel.kind },
      ]);
    setNewLabel(null);
  }

  const kinds = folderKinds(folders);
  const groups = KINDS.filter(
    ({ kind }) => kinds.includes(kind) || labels.some((l) => l.kind === kind),
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body = { name: name.trim(), folders: folders.map((f) => f.id), jobs: labels };
    try {
      onSaved(await (project ? api.updateProject(project.id, body) : api.createProject(body)));
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!project || !window.confirm(`Delete “${project.name}”? Its annotations are kept.`)) return;
    try {
      await api.deleteProject(project.id);
      onDeleted?.();
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submit}>
      <DialogTitle>{project ? "Project settings" : "New project"}</DialogTitle>
      <label className="grid gap-1.5">
        <span className="text-muted-foreground">Name</span>
        <Input
          data-testid="project-name"
          className="h-10 rounded-xl px-3"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Podocyte foot processes"
          required
          autoFocus
        />
      </label>
      <div className="grid gap-1.5">
        <span className="text-muted-foreground">Folders</span>
        <div className="grid gap-1.5">
          {folders.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between gap-3 rounded-xl border py-1.5 pr-1.5 pl-3"
            >
              <span className="truncate font-mono text-xs">{folderLabel(f.path)}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${folderLabel(f.path)}`}
                className="rounded-full text-muted-foreground"
                onClick={() => changeFolders(folders.filter((x) => x.id !== f.id))}
              >
                <XIcon />
              </Button>
            </div>
          ))}
          <button
            type="button"
            data-testid="add-folder"
            className="rounded-xl border border-dashed px-3 py-2 text-left text-muted-foreground hover:bg-muted/60 hover:text-foreground"
            onClick={() => setPicking(true)}
          >
            + Add folder
          </button>
        </div>
        <p className="text-muted-foreground">
          {folders.length
            ? "Removing a folder hides its images here; their annotations are kept."
            : "Leave empty to browse any folder."}
        </p>
      </div>
      <div className="grid gap-3">
        <span className="text-muted-foreground">Label classes</span>
        {groups.map(({ kind, title }) => (
          <div key={kind} className="grid gap-1.5" data-testid={`project-labels-${kind}`}>
            <span className="text-xs font-medium text-muted-foreground">{title}</span>
            <div className="flex flex-wrap gap-1.5">
              {labels.map(
                (label, i) =>
                  label.kind === kind && (
                    <LabelChip
                      key={label.id ?? `new-${i}`}
                      label={label}
                      onColor={(color) =>
                        setLabels((l) => l.map((x, k) => (k === i ? { ...x, color } : x)))
                      }
                      onRemove={() => setLabels((l) => l.filter((_, k) => k !== i))}
                    />
                  ),
              )}
              {!kinds.includes(kind) ? null : newLabel?.kind === kind ? (
                <Input
                  data-testid="new-label"
                  autoFocus
                  className="h-7 w-40 rounded-full px-3"
                  placeholder="Label name"
                  value={newLabel.name}
                  onChange={(e) => setNewLabel({ kind, name: e.target.value })}
                  onBlur={addLabel}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addLabel();
                    }
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setNewLabel(null);
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  data-testid={`add-label-${kind}`}
                  className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed px-2.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  onClick={() => setNewLabel({ kind, name: "" })}
                >
                  <PlusIcon className="size-3.5" />
                  Add
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {project && (
          <Button
            type="button"
            variant="ghost"
            className={`${PILL} mr-auto text-destructive hover:text-destructive`}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        )}
        <Button type="button" variant="outline" className={`${PILL} ml-auto`} onClick={onClose}>
          Cancel
        </Button>
        <Button
          className={PILL}
          data-testid="save-project"
          disabled={busy || !name.trim() || !labels.length}
        >
          {project ? "Save" : "Create project"}
        </Button>
      </div>
      <FolderPickerDialog
        open={picking}
        onOpenChange={setPicking}
        existing={folders.map((f) => f.id)}
        onAdd={(ids) => void addFolders(ids)}
      />
    </form>
  );
}

function LabelChip({
  label,
  onColor,
  onRemove,
}: {
  label: Label;
  onColor: (color: string) => void;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-full border pr-1 pl-2">
      <label
        className="relative size-2.5 cursor-pointer rounded-full"
        style={{ background: label.color }}
        title="Change color"
      >
        <input
          type="color"
          aria-label={`${label.name} color`}
          className="absolute inset-0 cursor-pointer opacity-0"
          value={label.color}
          onChange={(e) => onColor(e.target.value)}
        />
      </label>
      {label.name}
      <button
        type="button"
        aria-label={`Remove ${label.name}`}
        className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={onRemove}
      >
        <XIcon className="size-3" />
      </button>
    </span>
  );
}
