"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, ViewTransition } from "react";
import ProjectsPanel, { expanded } from "@/components/ProjectsPanel";
import { api } from "@/lib/api";

// The full-page projects overview; the editor shows the same list as an overlay.
export default function ProjectsPage() {
  const router = useRouter();
  // Opened from the overlay, it starts with the overlay's list so the panel can morph.
  const [handoff] = useState(() => expanded.current);
  // undefined until loaded; null when no project was opened yet.
  const [currentId, setCurrentId] = useState(handoff?.currentId);

  useEffect(() => {
    expanded.current = undefined;
    api.me().then(
      (me) => setCurrentId(me.last_project_id),
      (error: { status?: number }) => {
        if (error.status === 401) router.replace("/?next=/projects");
      },
    );
  }, [router]);

  if (currentId === undefined) return null;
  return (
    // The overlay's card, named the same, grows into this page; leaving shrinks it (globals.css).
    <ViewTransition name="projects-card" enter="auto" exit="auto" default="none">
      <div className="min-h-full bg-background">
        <main className="mx-auto flex max-w-3xl flex-col p-8 sm:p-10">
          <ProjectsPanel
            currentId={currentId}
            initialProjects={handoff?.projects}
            onOpen={(p) => router.push(`/annotate?project=${p.id}`)}
            onChanged={() => {}}
            onDeleted={() => {}}
          />
        </main>
      </div>
    </ViewTransition>
  );
}
