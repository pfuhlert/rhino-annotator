---
name: verify-simple-annotator
description: Drive the Simple annotator web UI (Next.js + FastAPI) with an isolated stack and Playwright. Use when proving login, job switching, next, or previous without touching a developer's npm run dev session.
---

# Verify Simple annotator

Primary surface is the Next.js UI. FastAPI is secondary (health, `/me`, SQLite). There is no product CLI.

Human/dev launch is root `npm run dev` on `127.0.0.1:3000` (web) and `127.0.0.1:8000` (API) with `backend/data/annotator.sqlite`. Verification never uses those ports or that file.

## Launch

From the repo root:

```bash
chmod +x scripts/verify-simple-annotator
./scripts/verify-simple-annotator up
```

This starts a second full stack via `scripts/dev.mjs` with:

- free ports from 3100 (web) and 8100 (API), never 3000/8000
- `SIMPLE_ANNOTATOR_SQLITE=/tmp/simple-annotator-verify-$RUN_ID.sqlite`
- `NEXT_PUBLIC_API_URL` pointing at that API
- `GIRDER_TOKEN` unset (placeholder crops)

Ready when `GET $API_URL/health` returns `{"ok":true}` and the web port answers. `up` prints the state JSON (`pid`, `apiUrl`, `webUrl`, `sqlite`). State is stored in `/tmp/simple-annotator-verify-state.json`.

Teardown:

```bash
./scripts/verify-simple-annotator down
```

`down` signals only the supervisor pid (and its process group) recorded by `up`. It does not kill by process name and does not touch a stack on 3000/8000.

## Doctor

```bash
./scripts/verify-simple-annotator doctor
```

Require `ok: true`, a live supervisor `pid`, `ownsDefaultDevPorts: false`, and both URLs from the state file. If doctor fails, stop driving. Never treat `http://127.0.0.1:3000` as the verify origin.

## Drive

Stable handles (use these, not CSS or coordinates):

| Handle | Role |
|---|---|
| `username` | login textbox |
| `password` | login password |
| `login-submit` | Log in |
| `register-submit` | Register |
| `annotate-app` | annotate shell after auth |
| `job-switcher` | job `<select>` |
| `tool-point` / `tool-polygon` | tools |
| `next` / `prev` | advance or go back |

Routes: `/` login, `/annotate` the loop.

Playwright is wrapped by the helper (storage state in `/tmp/simple-annotator-verify-storage.json`):

```bash
./scripts/verify-simple-annotator browser goto --path /
./scripts/verify-simple-annotator browser fill --testid username --value ada
./scripts/verify-simple-annotator browser fill --testid password --value secret
./scripts/verify-simple-annotator browser click --testid register-submit
./scripts/verify-simple-annotator browser screenshot --path .cursor/skills/verify-simple-annotator/artifacts/shot.png
./scripts/verify-simple-annotator browser snapshot --path .cursor/skills/verify-simple-annotator/artifacts/aria.txt
```

`login-proof` runs the login feature in one browser session (preferred for that feature). Read `features/README.md` before driving other features. Start each recipe from a fresh `up` unless the feature says otherwise.

## Evidence

Proof lives in `.cursor/skills/verify-simple-annotator/artifacts/` and must survive `down`.

Standards:

- Drive the real UI (register/login buttons, job select, next/prev). Do not POST `/auth/register` as a substitute for login proof.
- Capture the action and the resulting state (before + after screenshot or ARIA, plus a side effect).
- Side effects: `GET $WEB_URL/me` with the browser cookie (API is proxied through Next), and/or rows in the verify SQLite (`users`, `annotations`, `patch_visits`). Query with `sqlite3 $(./scripts/verify-simple-annotator sqlite)`.
- Placeholder crops are the isolated production boundary (Girder unset). Do not mock FastAPI.

## Cleanup

```bash
./scripts/verify-simple-annotator down
```

Removes the supervisor, verify SQLite, and Playwright storage. Does not delete `artifacts/`.

## Helpers

All invocations are from the repo root. The helper is `scripts/verify-simple-annotator`.

- `up` — isolated stack
- `doctor` — read-only health of that stack
- `down` — tear down that stack only
- `url` / `sqlite` — print verify web URL or SQLite path
- `browser …` — Playwright against the verify origin
- `login-proof` — mapped login feature, writes `artifacts/login-before.png`, `login-after.png`, `login-after.aria.txt`, `login-me.json`
