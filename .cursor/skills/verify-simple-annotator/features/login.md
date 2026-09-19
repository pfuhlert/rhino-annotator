# Login

Login lets a user register or sign in from `/` and then reach the annotate loop with a session cookie.

## Sub-features

- `login-register` creates an account from the register button.
- `login-signin` signs in an existing account from Log in.
- `login-session` can call `/me` with the browser cookie.
- `login-redirect` shows `annotate-app` after success.

## How to get to it (user POV)

- Open `/` and choose `Register`.
- Open `/` and choose `Log in`.

## Driving it with Playwright

Preconditions:

- Isolated stack is healthy (`./scripts/verify-simple-annotator doctor`).
- Drive `$(./scripts/verify-simple-annotator url)`, never port 3000.

- **Open login.** Run `./scripts/verify-simple-annotator browser goto --path /`. The Username and Password fields are visible.
- **Register.** Preferred one-shot: `./scripts/verify-simple-annotator login-proof`. It fills `username` and `password`, clicks `register-submit`, waits for `annotate-app`, and writes artifacts.
- **Sign in.** After `down` + `up`, fill the same username and click `login-submit`. `annotate-app` appears.
- **Proof.** Artifacts `login-before.png`, `login-after.png`, `login-after.aria.txt` exist. `login-me.json` has the registered username. `annotate-app` is in the ARIA snapshot.

## Gotchas

- POSTing `/auth/register` with curl is not login proof.
- `browser fill` / `click` reload the route each invocation; use `login-proof` so register and redirect stay in one session.
- A 401 on `/me` means the helper used the wrong origin or storage state.
