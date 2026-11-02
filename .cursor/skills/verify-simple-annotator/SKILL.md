---
name: verify-simple-annotator
description: Prove Simple annotator UI with ./scripts/verify-simple-annotator on the app host, including while npm run dev is already on :3000/:8000. Never Cursor browser tools or the dev ports — those miss a remote Kubernetes pod or hit the wrong stack.
---

# Verify Simple annotator

`npm run dev` on `:3000`/`:8000` may already be running. **Leave it.** Do not stop, kill, or reuse that process.

Run the helper on this host. It runs `npm run dev`, including the AI worker by default, in a second stack (ports from 3100/8100, `/tmp` SQLite, `frontend/.next-verify`). Cursor browser tools hit the laptop, not the pod.

Keep all verification build output under `frontend/.next-verify/`, which ESLint excludes. Cleanup must target only the current run’s build directory; the helper records each run’s build directory and `down` deletes only that run’s directory. Each run also points Next at its own `frontend/.next-verify/<run>.tsconfig.json` (via `typescript.tsconfigPath`), so `frontend/tsconfig.json` never changes.

## Run

From the repo root (dev server can stay up):

```bash
./scripts/verify-simple-annotator doctor
./scripts/verify-simple-annotator login-proof
```

Require `ok: true` and `webUrl` not on port 3000. Then drive `features/` against `$(./scripts/verify-simple-annotator url)` only.

```bash
./scripts/verify-simple-annotator down
```

`down` tears down only the verify supervisor. It must not change `:3000`/`:8000`.

`doctor` / `login-proof` start verify if needed. First browser launch may download Chromium to `/tmp/simple-annotator-playwright`. If doctor fails, read `log` and stop — do not fall back to `:3000`.

## Drive

Handles: `username`, `password`, `login-submit`, `register-submit`, `user-menu`, `logout` (inside `user-menu`), `theme-light`, `theme-dark`, `theme-system`, `shortcuts`, `shortcuts-dialog`, `annotate-app`, `job-switcher`, `job-glomerulus`, `job-tubule`, `folder-switcher`, `folder-placeholder`, `folder-back`, `folder-collapse`, `folder-progress`, `folder-refresh`, `images-indexing`, `sidebar-trigger`, `sidebar-pin`, `sidebar-resize`, `marked-scrollbar`, `tab-images`, `tab-annotations`, `image-list`, `image-group-<group>`, `image-row-<item>`, `stain-filter`, `stain-option-<stain>`, `stain-clear`, `annotation-list`, `tool-switcher`, `tool-point`, `tool-polygon`, `tool-brush`, `brush-size`, `brush-size-slider`, `patch-canvas`, `next`, `prev`, `project-list`, `project-<id>`, `project-settings-<id>`, `new-project`, `filter-all|private|shared`, `project-dialog`, `project-name`, `add-folder`, `folder-picker-dialog`, `pick-folder-<id>`, `pick-parent`, `open-folder-<id>`, `add-folders`, `project-labels-histo|elmi`, `add-label-histo|elmi`, `new-label`, `save-project`, `share-dialog`, `share-people`, `share-everyone`, `member-name`, `share-save`, `project-header`, `projects-overlay`, `expand-projects`, `close-projects`, `copy-to-layer` (inside `user-menu`), `other-labels`, `hide-other-labels`, `annotation-label-<mark>`.

One `browser` invocation is one session. Navigate with `goto --path`. Files use `--out`. Login lands on `/annotate`, which opens the last project, which is "All annotations" for new users; `/annotate?project=<id>` opens another. `/projects` is the full-page project list. After `login-proof`, the default route is `/annotate`.

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  click --testid next \
  screenshot --out .cursor/skills/verify-simple-annotator/artifacts/after.png \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/after.aria.txt \
  me --out .cursor/skills/verify-simple-annotator/artifacts/me.json
```

Also: `fill --testid … --value …`, `select --testid job-switcher --option job-tubule`, `press --key Tab` (`Shift+Tab` reverses), `wait --testid tool-switcher --text "Brush"`, `click --testid patch-canvas --at 640,360`, `drag --testid patch-canvas --from 500,220 --via 800,240 --to 640,500` (`--shift` erases). Use `login-proof` for register. Read `features/README.md` before other features.

For assertions requiring network interception or canvas instrumentation, use `browser script --file /path/to/check.mjs`. The module exports `default async (page, state) => { ... }` and runs in the same isolated browser session.

## Evidence

Write under `.cursor/skills/verify-simple-annotator/artifacts/` (survives `down`). Need the UI action plus `/me` or `sqlite3 $(./scripts/verify-simple-annotator sqlite)`. Do not POST `/auth/register` as login proof. Crops are placeholders (`GIRDER_TOKEN` unset).

For real-image AI verification, use the localhost-only fixture described in [AI annotation](features/ai-annotation.md). All other runs keep the placeholder image source.
