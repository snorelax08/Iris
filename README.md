# 🎙️ Akon — Voice-Controlled Music Assistant

Akon listens for the wake word **"Akon"**, parses simple voice commands, and plays music
**directly in your browser** using the **Spotify Web Playback SDK**.

> ⚠️ Akon only ever controls the in-browser Web Playback SDK device ("Akon Web Player").
> It does **not** control your Spotify desktop app, phone, or any other device.

---

## 📁 Project Structure

```
akon/
├── frontend/
│   ├── index.html      # UI (+ small hidden debug panel)
│   ├── style.css       # Minimal styling
│   ├── app.js           # Wires voice + Spotify together, updates UI + debug panel
│   ├── voice.js         # Web Speech API wake-word + command listener
│   └── spotify.js       # Web Playback SDK + Web API controller (search, matching, playback)
├── backend/
│   ├── server.js        # Express server, serves frontend + mounts auth routes
│   └── auth.js           # Spotify OAuth (login, callback, token refresh, /auth/debug)
├── test/
│   └── matching.test.js # Credential-free unit tests for the search-matching pipeline
├── .env.example
├── package.json
├── CHANGELOG.md
├── TASKS.md
├── CLAUDE.md
└── README.md
```

---

## ✅ Requirements

- Node.js 16+ and npm
- A **Spotify Premium** account (the Web Playback SDK requires Premium — free accounts cannot stream via the SDK)
- Google Chrome or Microsoft Edge (best Web Speech API support)

---

## 🚀 Step-by-Step Setup

### 1. Create a Spotify App (to get API credentials)

1. Go to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and log in.
2. Click **Create app**.
3. Fill in any name/description.
4. For **Redirect URI**, enter exactly:
   ```
   http://localhost:8888/auth/callback
   ```
5. Save. Open the app you just created, click **Settings**, and copy your **Client ID** and **Client Secret**.

### 2. Install dependencies

From the `akon/` project root:

```bash
npm install
```

### 3. Configure environment variables

```bash
cp .env.example .env
```

Open `.env` and paste in your credentials:

```
SPOTIFY_CLIENT_ID=paste_your_client_id_here
SPOTIFY_CLIENT_SECRET=paste_your_client_secret_here
SPOTIFY_REDIRECT_URI=http://localhost:8888/auth/callback
PORT=8888
```

### 4. Run the app

```bash
npm start
```

This starts the Express backend **and** serves the frontend, all on one port.

### 5. Open it in your browser

Go to:

```
http://localhost:8888
```

### 6. Connect Spotify

1. Click **Connect Spotify**.
2. Log in and approve the permissions.
3. You'll be redirected back — the app UI will appear once "Player ready" shows.

### 7. Start talking to Akon

1. Click **Start Listening**.
2. Allow microphone access when your browser prompts you.
3. Try:
   - **"Akon play Believer"**
   - **"Akon pause"**
   - **"Akon next"**
   - **"Akon volume up"**

The very first thing Spotify plays after connecting may need one manual play/pause on the Spotify app on any device once, if Spotify hasn't handed off playback to a new device before — this is a one-time Spotify quirk, not a bug in Akon.

---

## 🩺 Debug Panel

Once connected, click **Show Debug Info** to open a small panel showing:
- Server-side auth state: whether you're logged in, token expiry, last refresh time, last known device id, and the redirect URI the server is actually configured with — from `GET /auth/debug` (no secrets or tokens are ever included).
- A live client-side log of recent voice commands, search matches (with scores), device-transfer attempts, and any playback errors.

Use this first whenever something doesn't work — most issues (wrong redirect URI, device not active, low-confidence search match) show up here immediately.

## 🧠 How Commands Work

Akon listens continuously. Every time it hears speech, it checks whether the transcript contains the wake word `"akon"`. Everything **after** the wake word is treated as the command:

| You say                     | Akon hears (command) | Action                          |
|------------------------------|-----------------------|----------------------------------|
| "Akon play Believer"         | `play believer`       | Searches Spotify, plays top result |
| "Akon pause" / "Akon stop"   | `pause` / `stop`      | Pauses playback                  |
| "Akon play" / "Akon resume"  | `play` / `resume`     | Resumes playback                 |
| "Akon next" / "Akon skip"    | `next` / `skip`       | Skips to next track              |
| "Akon previous" / "Akon back"| `previous` / `back`   | Goes to previous track           |
| "Akon volume up"             | `volume up`           | Raises volume by 15%             |
| "Akon volume down"           | `volume down`         | Lowers volume by 15%             |

---

## 🔐 About Authentication & Secrets

- Your Client ID/Secret live only in `.env`, which is never committed (add it to `.gitignore`).
- The backend (`backend/auth.js`) performs the OAuth code exchange and holds the access/refresh tokens **server-side**.
- The frontend never sees your Client Secret — it only fetches a short-lived access token from `/auth/token` when needed.
- This starter uses simple in-memory token storage (fine for local/single-user use). For a real multi-user deployment, swap this for a session- or database-backed store.

---

## 🛠️ Troubleshooting

- **"Speech recognition is not supported"** → Use Chrome or Edge; Safari/Firefox have limited Web Speech API support.
- **Nothing plays / "Song not found"** → Open the debug panel — the client log shows the top-3 scored candidates for your query. Double check the song name, and confirm your Spotify account is **Premium**.
- **401 / login loop** → Make sure the Redirect URI in your `.env` matches *exactly* (including `http://`/`https://` and port) what's registered in the Spotify Dashboard. `GET /auth/debug` shows what the server thinks it's configured with.
- **Player never shows "ready" / "Akon Web Player" missing from your devices** → Open the browser console for SDK errors (usually an invalid/expired token or a non-Premium account); the debug panel's client log also shows every playback-transfer attempt and retry.
- **"Akon next" doesn't skip** → Should not happen after the v2 fixes below (it now calls the SDK's own `nextTrack()` directly). If it does, check the debug panel log for `SDK nextTrack() failed` — that means it fell back to the Web API path, which needs the device to be the active one; check `/auth/debug`'s `last_known_device_id`.

---

## ✅ QA Checklist

Run through this after any change, locally and again after deploying to Render.

### Local

```bash
npm install
cp .env.example .env        # fill in your real Spotify credentials
npm start
npm test                    # runs the search-matching unit tests (no credentials needed)
```

Then in the browser at `http://localhost:8888`:

1. **Connect** — Click **Connect Spotify**, approve access, confirm you land back on the app with **Player ready** shown.
2. **Device check** — In the Spotify app (any device) or via `open.spotify.com`, confirm **"Akon Web Player"** appears in the device list once connected here. Open the debug panel and confirm `last_known_device_id` is populated.
3. **Start Listening** — Click it, allow mic access, confirm status changes to `Listening...`.

| # | Say | Expect | Where to check if it fails |
|---|-----|--------|------------------------------|
| 1 | "Akon play Believer" | Imagine Dragons' "Believer" starts playing within a couple seconds | Debug panel client log: search candidates + scores |
| 2 | "Akon play Shape of You" | Ed Sheeran's "Shape of You" plays | Debug panel |
| 3 | "Akon play ye tune kya kiya" | "Ye Tune Kya Kiya" (Javed Bashir / Pritam) plays — it is a real song title, not filler | Debug panel: `Resolve ... -> play` line with the top 3 scores |
| 4 | "Akon play [a real song with a Hindi/Hinglish title mixed with filler words, e.g. "ye Kesariya wala gaana bajao"]" | The real title ("Kesariya") is correctly extracted and played, ignoring filler words | Debug panel — "cleaned" query shown in the search log line |
| 5 | "Akon pause" | Playback pauses immediately | UI "Playback" field → Paused |
| 6 | "Akon resume" (or "Akon play") | Playback resumes | UI "Playback" field → Playing |
| 7 | "Akon next" | Moves to the **next track** — must NOT pause | UI "Now playing" changes; debug log shows "Skipped to next track via SDK" |
| 8 | "Akon previous" | Moves to the previous track | UI "Now playing" changes back |
| 9 | "Akon volume up" (say it twice) | Volume audibly increases | Debug log: "Volume set to X% via SDK" |
| 10 | "Akon volume down" | Volume audibly decreases | Debug log |
| 11 | "Akon play stronger" | Kanye West's "Stronger" plays; hint offers "option two" (Kelly Clarkson) | Hint under the mic button |
| 12 | "Akon option two" (right after #11) | Switches to the runner-up | Now playing changes |
| 13 | "Akon play asdf qwerty" | Nothing plays; "I couldn't find that song…" | Debug panel: `not_found` |
| 14 | "Akon agla gaana" / "Akon awaaz badhao" | Next track / volume up | Debug panel: `Intent:` line |
| 15 | "Akon play stronger by kanye west", then "Akon next" | Real track (not karaoke) plays; next moves to the next album track | Debug panel |

**Server logs to watch** (terminal running `npm start`): `[Akon:auth] Login successful`, `[Akon:auth] Access token refreshed` (should appear automatically ~1 min before the ~60-minute token expiry if you leave it running), `[Akon:device] Frontend reported device id: ...`.

### Render

1. Deploy the repo (Node service, build command `npm install`, start command `npm start`).
2. Set environment variables in the Render dashboard (see **Deployment** below), then **redeploy** — env var changes don't apply until redeploy.
3. Add the Render HTTPS URL's `/auth/callback` to your Spotify Dashboard app's Redirect URIs.
4. Repeat the full local checklist above against the Render URL instead of `localhost:8888`.
5. Confirm `GET https://your-app.onrender.com/auth/debug` shows `configured_redirect_uri` matching your Render URL exactly.

---

## 🎨 Polish QA (v3)

**a) Functional — must be unchanged.** Re-run the original 10 phrases in *QA Checklist* above (Believer, Shape of You, noisy Hindi-mixed phrase, pause, resume, next, previous, volume up/down). All must behave exactly as before. `npm test` must print ALL TESTS PASSED.

**b) Visual checks**

| Feature | What to look for |
|---|---|
| Login → app | "Connect Spotify" disappears; app fades in once |
| Album art | Art of the current track appears; a music-note placeholder when idle; no broken-image icon |
| Icons | Icons beside Connect / mic / Debug labels; mic icon turns into a stop square while listening |
| Listening pulse | Green ring pulses on the mic button and status card while listening; stops when you stop |
| Wake flash | Mic button flashes amber the instant you say "Akon" |
| Chime (off) | Nothing unless `CONFIG.chime = true`; then a very short beep, and commands still work |
| History strip | Last 5 commands as chips, newest first; "Last command" row still updates |
| Searching skeleton | Shimmer card with "Searching: X…" right after "Akon play X"; replaced by art when found |
| Low-confidence hint | On a poor match: "Best guess: X — Y. Say "Akon next" if that's wrong." Clears on the next command |
| Toasts | "Song not found", "Volume 85%", errors; at most 3, auto-dismiss, status fields still update |
| Equalizer | Bars move only while a track is playing; freeze on pause |
| Mobile (≤520 px) | Full-width big buttons, no sideways scroll, comfortable spacing |
| Manifest | Browser offers "Install / Add to Home Screen"; icon and name look right |
| Keyboard | Click page background first. Space = pause/resume, → next, ← previous (same behavior as voice) |
| Accessibility | Screen reader announces status changes; visible focus ring on Tab; reduced-motion disables animation |
| Debug panel | Show/Hide works and still shows server state + client log |

**Turning features off:** flip the switches at the top of `frontend/polish.js` (`CONFIG`).

## 🚢 Deployment (Render)

1. Push this repo to GitHub/GitLab.
2. In Render, create a **New Web Service** from the repo.
   - **Build command:** `npm install`
   - **Start command:** `npm start`
3. Under **Environment**, add:
   ```
   SPOTIFY_CLIENT_ID=your_spotify_client_id
   SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
   SPOTIFY_REDIRECT_URI=https://your-app-name.onrender.com/auth/callback
   ```
   (Leave `PORT` unset — Render provides it automatically, and `server.js` already reads `process.env.PORT`.)
4. Deploy. Once live, copy the exact Render URL.
5. In the [Spotify Dashboard](https://developer.spotify.com/dashboard), open your app → **Settings** → **Redirect URIs** → add `https://your-app-name.onrender.com/auth/callback` (must match `SPOTIFY_REDIRECT_URI` exactly, including trailing slashes or lack thereof). Save.
6. Back in Render, if you changed any environment variable after the first deploy, click **Manual Deploy → Redeploy** — Render does not hot-reload env var changes.
7. Run through the **Render QA checklist** above against the live URL.

---

## 🌱 Next Steps / Improvements

**Improve voice accuracy:**
- Add a small fuzzy-matching step (e.g. Levenshtein distance) before treating a phrase as "not the wake word" to tolerate mishearing "Akon" as similar-sounding words.
- Let users pick a different wake word in the UI.

**Add smarter (LLM-based) command parsing:**
- Instead of simple string matching in `app.js`, send the transcript to an LLM with a small function-calling schema (`{action: "play"|"pause"|"next"|..., query?: string}`) so phrasing like *"Akon can you skip this one"* still works.
- This is a natural place to plug in the Anthropic API — happy to wire that up next.

**Deploy it:**
- Host the Node/Express backend on something like Render, Railway, or Fly.io.
- Update `SPOTIFY_REDIRECT_URI` (both in `.env` and in your Spotify Dashboard app settings) to your deployed HTTPS URL — Spotify requires HTTPS redirect URIs in production.
- Swap the in-memory token store for a real session store if more than one person will use it.

---

Now ask me for the next step, and I will guide you step-by-step for API integration.
