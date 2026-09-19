# Switch job

Switch job changes the active label target on the current crop. The new job stays selected for the next crop until the user changes it again. Tools stay point and polygon.

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

- **See jobs.** Open `job-switcher`; options include `glomerulus` and `tubule`.
- **Change job.** Click `job-switcher`, then the `tubule` option.
- **Advance.** Click `next` (empty crop is valid).
- **Proof.** The next patch still has Job `tubule`. `GET $WEB_URL/me` (browser cookie) has `last_job_id` for tubule. `sqlite3 $(./scripts/verify-simple-annotator sqlite) 'select last_job_id from users;'` matches.

## Gotchas

- Switching job only retints new marks. Old marks keep their job color.
- Do not infer stickiness from the first patch alone; load the next patch.
