# CLAUDE.md — Run Rules for This Repo

This file tells an AI assistant (or a new contributor) how to work on Akon autonomously,
and exactly when to stop and ask instead of guessing.

## Say what "done" looks like first

Before making changes, state the acceptance criteria in concrete, testable terms — not
"improve search," but "saying 'Akon play Believer' plays Imagine Dragons' Believer within
a couple seconds, and the debug panel shows the matched track + score." Then implement,
then verify against that exact statement before calling the task done. The QA checklist in
`README.md` is the canonical "done" definition for this project's core flows — any change
that breaks one of those 10 test phrases is not done, regardless of what else it improves.

## Proceed autonomously when

- The change is inside `frontend/` or `backend/` and doesn't require new third-party
  credentials.
- The fix is verifiable by static checks (`node --check`), the existing unit tests
  (`npm test`), or a local smoke test of the Express server (`/auth/status`, `/auth/debug`).
- The task is scoped to the reported symptoms (device not showing, next skipping, search
  accuracy, auth refresh, logging) rather than a general rewrite.
- Docs (`README.md`, `.env.example`, `CHANGELOG.md`, `TASKS.md`) need updating to match a
  code change already made.

## Stop and ask when

- You need a real Spotify Client ID/Secret, a user's refresh token, or any other credential
  you cannot generate yourself. State exactly which value is needed and where it goes
  (`.env` key name, or the exact Spotify Dashboard / Render field).
- A fix would require changing the registered Spotify Redirect URI. List the exact new URI
  and the two places it must be set (Spotify Dashboard *and* the `SPOTIFY_REDIRECT_URI` env
  var) — then wait for confirmation before assuming it's been done, since you cannot verify
  the Dashboard side yourself.
- A requested change would mean controlling a device other than the in-browser Web Playback
  SDK player (e.g. the desktop app, a phone) — this violates the project's core constraint
  and should be flagged, not implemented.
- A fix would require a large UI redesign to work — prefer a backend/controller-level fix
  and flag the trade-off instead of silently expanding scope.
- Something in scope turns out to depend on data you can't inspect (e.g. a specific user's
  real Spotify search results) — describe the mock/test data you used instead, and say so
  explicitly rather than presenting simulated results as confirmed production behavior.

## Style constraints for this repo

- No secrets in code, logs, or docs — ever. Diagnostic endpoints (`/auth/debug`) must only
  ever expose shape/timing info (booleans, timestamps, device ids), never tokens.
- Prefer the Spotify Web Playback SDK's own player methods (`player.pause()`,
  `player.nextTrack()`, etc.) over Web API calls scoped by `device_id` wherever both are
  viable — the SDK methods act on this exact device and can't be misrouted.
- Keep changes minimal and localized to the reported problem's actual root cause; don't
  refactor unrelated code in the same pass.
- Every non-trivial fix gets a one-line rationale as a code comment at the point of change,
  not just in the changelog — so the "why" survives even if `CHANGELOG.md` is skimmed.

## How to verify before declaring done

1. `node --check` every changed `.js` file.
2. `npm test` — must pass (credential-free matching tests).
3. `npm start`, then hit `/auth/status` and `/auth/debug` with `curl` to confirm the server
   boots and the new endpoints respond.
4. Walk the QA checklist in `README.md` against a real Spotify Premium account before
   telling the user it's fixed — static checks catch syntax errors, not Spotify API
   behavior.
