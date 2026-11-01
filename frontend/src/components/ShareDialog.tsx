"use client";

import { type FormEvent, useState } from "react";
import { XIcon } from "lucide-react";
import { cn } from "cn";
import { PILL } from "@/components/FolderPickerDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type Project, type Visibility } from "@/lib/api";
import { plural } from "@/lib/projects";

const OPTIONS: [Exclude<Visibility, "private">, string, string][] = [
  ["people", "Specific people", "Only the people you add"],
  ["everyone", "Everyone", "Anyone with an account"],
];

export default function ShareDialog({
  project,
  onOpenChange,
  onSaved,
}: {
  // Open while set.
  project: Project | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (project: Project) => void;
}) {
  return (
    <Dialog open={!!project} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg" data-testid="share-dialog">
        {project && (
          <Form project={project} onClose={() => onOpenChange(false)} onSaved={onSaved} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function Form({
  project,
  onClose,
  onSaved,
}: {
  project: Project;
  onClose: () => void;
  onSaved: (project: Project) => void;
}) {
  const shared = project.visibility !== "private";
  const [mode, setMode] = useState<Visibility>(
    project.visibility === "everyone" ? "everyone" : "people",
  );
  const [members, setMembers] = useState(project.members);
  const [adding, setAdding] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(visibility: Visibility) {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.shareProject(project.id, visibility, members));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not share the project.");
    } finally {
      setBusy(false);
    }
  }

  function add(e: FormEvent) {
    e.preventDefault();
    const name = adding.trim();
    if (name && name !== project.owner && !members.includes(name)) setMembers([...members, name]);
    setAdding("");
  }

  const mine = project.my_annotation_count;
  return (
    <div className="grid gap-5">
      <DialogTitle className="truncate">Share “{project.name}”</DialogTitle>
      <div role="group" aria-label="Who can open this project" className="grid grid-cols-2 gap-2">
        {OPTIONS.map(([value, title, hint]) => (
          <button
            key={value}
            type="button"
            data-testid={`share-${value}`}
            aria-pressed={mode === value}
            className={cn(
              "rounded-xl border px-3.5 py-3 text-left",
              mode === value && "border-foreground ring-1 ring-foreground",
            )}
            onClick={() => setMode(value)}
          >
            <b className="block font-medium">{title}</b>
            <span className="text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>
      {mode === "people" && (
        <div className="grid gap-1">
          <div className="flex justify-between py-1">
            {project.owner} <span className="text-muted-foreground">Owner</span>
          </div>
          {members.map((m) => (
            <div key={m} className="flex items-center justify-between py-0.5">
              {m}
              <span className="flex items-center gap-1 text-muted-foreground">
                Can annotate
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${m}`}
                  className="rounded-full"
                  onClick={() => setMembers(members.filter((x) => x !== m))}
                >
                  <XIcon />
                </Button>
              </span>
            </div>
          ))}
          <form className="mt-1 flex gap-2" onSubmit={add}>
            <Input
              data-testid="member-name"
              className="h-9 rounded-xl px-3"
              placeholder="Add by username"
              value={adding}
              onChange={(e) => setAdding(e.target.value)}
            />
            <Button variant="outline" className={PILL} disabled={!adding.trim()}>
              Add
            </Button>
          </form>
        </div>
      )}
      {!project.has_layer && (
        <p className="rounded-xl bg-muted px-3.5 py-3 text-muted-foreground">
          {mine !== 0 ? (
            <>
              <b className="font-medium text-foreground">
                {/* Null while the project's images are still being counted. */}
                {mine === null
                  ? "Your annotations"
                  : `Your ${plural(mine, "annotation")}`}{" "}
                will be copied to a shared layer.
              </b>{" "}
              Everyone edits the copy, and your own annotations stay unchanged.
            </>
          ) : (
            "Everyone annotates one shared layer of this project."
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        {shared && (
          <Button
            variant="ghost"
            className={`${PILL} mr-auto`}
            disabled={busy}
            onClick={() => void save("private")}
          >
            Stop sharing
          </Button>
        )}
        <Button variant="outline" className={`${PILL} ml-auto`} onClick={onClose}>
          Cancel
        </Button>
        <Button
          className={PILL}
          data-testid="share-save"
          disabled={busy}
          onClick={() => void save(mode)}
        >
          {shared ? "Save" : "Share project"}
        </Button>
      </div>
    </div>
  );
}
