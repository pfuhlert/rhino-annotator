# Switch job

Switch job changes the active label target on the current crop. The new job stays selected for the next crop until the user changes it again.

## Sub-features

- `job-change` updates the job switcher on the current patch.
- `job-sticky` keeps that job on the following patch.
- `job-persist` writes `users.last_job_id` in the verify SQLite.

## How to get to it (user POV)

- After login, use the job select in the annotate footer.
- Next or Previous; the next crop still shows the chosen job.

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy and a user is on `/annotate` (`login-proof`).

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  wait --testid annotate-app \
  select --testid job-switcher --option job-tubule \
  click --testid next \
  snapshot --out .cursor/skills/verify-simple-annotator/artifacts/job-after.aria.txt \
  me --out .cursor/skills/verify-simple-annotator/artifacts/job-me.json
```

- **Proof.** Snapshot Job is `tubule`. `job-me.json` `last_job_id` matches `sqlite3 $(./scripts/verify-simple-annotator sqlite) "select id from jobs where name='tubule';"`. Copy the query into `artifacts/` before `down`.

## Gotchas

- Switching job only retints new marks. Old marks keep their job color.
- Do not infer stickiness from the first patch alone; load the next patch.
- `select` can leave the listbox in the ARIA tree; snapshot only after Next/Previous, not immediately after the option click.
