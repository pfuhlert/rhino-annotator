---
name: verify-simple-annotator
description: Prove Simple annotator UI with ./scripts/verify-simple-annotator on the app host, including while npm run dev is already on :3000/:8000. Never Cursor browser tools or the dev ports — those miss a remote Kubernetes pod or hit the wrong stack.
---

# Verify Simple annotator

`npm run dev` on `:3000`/`:8000` may already be running. **Leave it.** Do not stop, kill, or reuse that process.

Run the helper on this host. It starts a second stack (ports from 3100/8100, `/tmp` SQLite, `frontend/.next-verify`). Cursor browser tools hit the laptop, not the pod.

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

Handles: `username`, `password`, `login-submit`, `register-submit`, `logout`, `annotate-app`, `job-switcher`, `job-glomerulus`, `job-tubule`, `tool-switcher`, `tool-point`, `tool-polygon`, `tool-brush`, `patch-canvas`, `next`, `prev`.

One `browser` invocation is one session. Navigate with `goto --path`. Files use `--out`. After `login-proof`, the default route is `/annotate`.

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  click --testid next \
  screenshot --out .cursor/skills/verify-simple-annotator/artifacts/after.png \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/after.aria.txt \
  me --out .cursor/skills/verify-simple-annotator/artifacts/me.json
```

Also: `fill --testid … --value …`, `select --testid job-switcher --option job-tubule`, `press --key Tab` (`Shift+Tab` reverses), `wait --testid tool-switcher --text "Brush (R)"`, `click --testid patch-canvas --at 640,360`, `drag --testid patch-canvas --from 500,220 --via 800,240 --to 640,500` (`--shift` erases). Use `login-proof` for register. Read `features/README.md` before other features.

## Evidence

Write under `.cursor/skills/verify-simple-annotator/artifacts/` (survives `down`). Need the UI action plus `/me` or `sqlite3 $(./scripts/verify-simple-annotator sqlite)`. Do not POST `/auth/register` as login proof. Crops are placeholders (`GIRDER_TOKEN` unset).
