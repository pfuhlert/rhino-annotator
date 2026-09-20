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

- **Register.** One shot: `./scripts/verify-simple-annotator login-proof`.
- **Sign in.** Same stack, after register:

```bash
./scripts/verify-simple-annotator browser \
  goto --path /annotate \
  click --testid logout \
  fill --testid username --value "$USER" \
  fill --testid password --value verify-pass \
  click --testid login-submit \
  wait --testid annotate-app
```

`$USER` is the username from `login-me.json`.
- **Proof.** Artifacts `login-before.png`, `login-after.png`, `login-after.aria.txt` exist. `login-me.json` has the registered username. `annotate-app` is in the ARIA snapshot.

## Gotchas

- POSTing `/auth/register` with curl is not login proof.
- Keep a multi-step flow in one `browser` chain (or `login-proof`).
- A 401 on `/me` means the helper used the wrong origin or storage state.
