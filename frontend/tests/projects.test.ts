import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../src/lib/api";
import {
  LABEL_COLORS,
  adaptLabels,
  colorDistance,
  folderKinds,
  nextColor,
  pickerJobs,
} from "../src/lib/projects";

test("the label picker offers project classes plus an old class being edited", () => {
  const jobs = [
    {
      id: 1,
      name: "GBM",
      color: "#e11d48",
      kind: "histo" as const,
      mode: "mask" as const,
      in_project: true,
    },
    {
      id: 2,
      name: "Tubule",
      color: "#2563eb",
      kind: "histo" as const,
      mode: "mask" as const,
      in_project: false,
    },
    {
      id: 3,
      name: "Vessel",
      color: "#059669",
      kind: "histo" as const,
      mode: "mask" as const,
      in_project: false,
    },
  ];
  assert.deepEqual(
    pickerJobs(jobs, 1).map((j) => j.id),
    [1],
  );
  assert.deepEqual(
    pickerJobs(jobs, 3).map((j) => j.id),
    [1, 3],
  );
});

test("label classes follow the kinds of images in the project's folders", () => {
  const presets: Record<"histo" | "elmi", Job[]> = {
    histo: [{ id: 1, name: "Tubule", color: "#2563eb", kind: "histo", mode: "mask" }],
    elmi: [
      { id: 2, name: "GBM", color: "#e11d48", kind: "elmi", mode: "mask" },
      { id: 3, name: "Podocyte", color: "#2563eb", kind: "elmi", mode: "mask" },
    ],
  };
  const histo = [{ id: "h", path: "/collection/Histology", kind: "histo" as const }];
  const both = [...histo, { id: "e", path: "/collection/ELMI", kind: "elmi" as const }];
  assert.deepEqual(folderKinds([]), ["histo", "elmi"]);
  assert.deepEqual(folderKinds(both.slice(1)), ["elmi"]);

  const start = adaptLabels([], [], folderKinds(histo), presets);
  assert.deepEqual(
    start.map((l) => l.name),
    ["Tubule"],
  );
  const withElmi = adaptLabels(start, folderKinds(histo), folderKinds(both), presets);
  assert.deepEqual(
    withElmi.map((l) => l.name),
    ["Tubule", "GBM", "Podocyte"],
  );
  // Removing the ELMI folder keeps a recolored preset and a custom class.
  const edited = [
    ...withElmi.map((l) => (l.name === "GBM" ? { ...l, color: "#000000" } : l)),
    { name: "Deposit", color: "#ffffff", kind: "elmi" as const, mode: "mask" as const },
  ];
  assert.deepEqual(
    adaptLabels(edited, folderKinds(both), folderKinds(histo), presets).map((l) => l.name),
    ["Tubule", "GBM", "Deposit"],
  );
});

test("new classes stay apart from the colors already used", () => {
  // The EM presets, then four classes added from the editor.
  const used = [
    "#ff8b00",
    "#a200ff",
    "#2e8b5d",
    "#46e8ff",
    "#2effa2",
    "#ff172e",
    "#8ba2ff",
    "#00468b",
    "#742e00",
    "#8b0046",
    "#e88bb9",
    "#ffe800",
  ];
  for (let i = 0; i < 4; i++) {
    const color = nextColor(used);
    assert.ok(Math.min(...used.map((u) => colorDistance(u, color))) > 0.1, color);
    used.push(color);
  }
  assert.equal(nextColor([]), LABEL_COLORS[0]);
});
