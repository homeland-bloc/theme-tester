# Security Audit — Opheliapp (theme-tester)

Read-only review of the repository at commit `6886a68`. No source files were modified, no network requests were sent, and nothing was run against live systems. Findings come from reading the code. The Supabase schema and RLS policies, the Discord application settings, and the GitHub repo/Pages settings are not in this repo, so findings that depend on them are marked **Needs confirmation**.

## 1. Executive summary

**Overall posture:** moderate. The Cloudflare Worker is carefully written in several places. It verifies Firebase JWTs with a real RS256 signature check on the GitHub routes, validates repo paths strictly, and uses PKCE. The front end has no HTML-injection sinks. The weak points are the Worker's trust model: it accepts any Discord token, its body sanitiser fails open, and it forwards almost any Supabase path.

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 3 |
| Low | 4 |
| Informational | 3 |

**Fix first:**
1. **H-1:** `/firebase-refresh` and the `verifyAdmin` fallback accept a Discord token issued to any application, so any other Discord app can be used to impersonate users.
2. **H-2:** `sanitiseBody` fails open. A non-JSON `Content-Type` skips the `role` and `owner_id` stripping.
3. **M-1:** The Supabase proxy forwards every table, RPC and storage path. Security therefore rests entirely on RLS, which isn't in this repo and which I could not review.

## 2. Architecture and threat model

**Stack:** a static single-page app on GitHub Pages (`bicipikay.github.io/ophelia`). It is React 18 and in-browser Babel, loaded from unpkg, in one `index.html` of about 9,200 lines. Helper scripts are `sensor.js`, `sensor_ui.js` and `tile_palette.js`. There is no `package.json`, build step or CI config. The back end is a Cloudflare Worker (`worker.js`, `wrangler.toml`) that sits in front of three services:
- Supabase (PostgREST and storage), for profiles, tilesets and tiles.
- Discord OAuth2 (PKCE, scope `identify`).
- The GitHub Contents/Git Data API, using a bot PAT, to store tile images in `bicipikay/ophelia/Resources/`.

**Trust boundaries:**
- Browser → Worker routes:
  - `/discord-token`, `/discord-refresh`, `/firebase-refresh`
  - `/github/{upload,delete,move,delete-many,diag}`
  - `/rest/v1/*` and `/storage/v1/*` (proxied to Supabase)
- Worker → Discord, GitHub, Supabase and Google's Firebase public keys.
- Browser → `raw.githubusercontent.com` for tile images (URLs come from the DB column `tiles.image_url`).
- Local state in localStorage: the `oph_user` session object, which holds the Discord access and refresh tokens and the Firebase ID token, plus the grid, uploads and settings.

**Identity and roles:** Discord login yields a Worker-minted Firebase custom token whose `uid` is the Discord ID. Supabase trusts the Firebase token (third-party auth). Roles are `admin`, `creator` and `user`, stored in `profiles.role`. The client-side role checks are UI only. Enforcement is split between the Worker (`sanitiseBody`, `authGithub`, `canManageFolder`) and Supabase RLS.

**Sensitive data:** Discord refresh/access tokens (in localStorage), Firebase ID tokens, the Worker secrets (`DISCORD_CLIENT_SECRET`, `FIREBASE_SERVICE_ACCOUNT`, `GITHUB_BOT_TOKEN`, `SUPABASE_ANON_KEY`), and profile data (Discord ID, username, avatar hash, role).

**Attackers and goals:**
- Anonymous internet user: read data, abuse the open proxy.
- Malicious Discord app operator: take over other users' accounts.
- Malicious or compromised `creator`: overwrite other creators' tiles, escalate to admin.
- Normal user: escalate to creator or admin.

## 3. Findings

### H-1 — Any Discord access token (from any application) can mint a Firebase session for that user (High)
- **Location:** `worker.js:198-223` (`handleFirebaseRefresh`), `worker.js:823-835` (`fetchDiscordUser`), `worker.js:805-820` (`verifyAdmin` fallback via `X-Discord-Token`)
- **Description:** `/firebase-refresh` takes an `access_token`, calls `GET discord.com/api/users/@me` with it, and mints a Firebase custom token for the returned user ID. Nothing checks that the token was issued to *this* application (`DISCORD_CLIENT_ID`). Discord's `/oauth2/@me` returns the application ID, but it is never called. The same weakness exists in the `X-Discord-Token` branch of `verifyAdmin`.
- **Attack scenario:** An attacker runs a Discord application, or a bot or website with "Login with Discord" at `identify` scope. Every user who signs in there hands the attacker a valid Discord access token. The attacker POSTs it to `https://oph.opheliapp.workers.dev/firebase-refresh` (CORS doesn't apply to non-browser clients). The Worker returns a Firebase token for the victim's Discord ID. The attacker can then act as the victim in Supabase, and through the GitHub routes if the victim is a creator or admin. If the victim is an admin, that includes role changes and deletes. The endpoint is limited to 5 requests per minute per IP, which only slows this down.
- **Fix:** After `users/@me`, also call `GET https://discord.com/api/oauth2/@me` with the same token and require `application.id === env.DISCORD_CLIENT_ID`. Do this inside `fetchDiscordUser` so every caller is covered:
  ```js
  const me = await (await fetch('https://discord.com/api/oauth2/@me', {headers:{Authorization:`Bearer ${token}`}})).json();
  if (me.application?.id !== env.DISCORD_CLIENT_ID || !me.user?.id) return null;
  ```
  Alternatively, stop accepting Discord tokens in `/firebase-refresh` and refresh only via the stored refresh token through `/discord-refresh`. That path uses the client secret, so it is bound to this app. Remove the legacy `X-Discord-Token` admin fallback.
- **Confidence:** Confirmed (by code reading). I did not test it live.

### H-2 — Body sanitiser fails open, so `role` and `owner_id` protections can be bypassed (High)
- **Location:** `worker.js:750-763`, with the sanitiser at `worker.js:837-872`
- **Description:** For POST/PATCH/PUT the Worker clones the request, then tries `request.json()` and `sanitiseBody`. On *any* exception it executes `request = cloned` and forwards the original body untouched. PostgREST also accepts `POST` bodies with `Content-Type: text/csv` and `application/x-www-form-urlencoded`. For those, `request.json()` throws, the `catch` fires, and the raw body reaches Supabase with `role`, `owner_id`, `last_updated_by` and so on exactly as the attacker wrote them. `Content-Type` is forwarded as sent (`worker.js:771-774`).
- **Attack scenario:** A logged-in normal user sends `POST /rest/v1/profiles` with `Prefer: resolution=merge-duplicates`, `Content-Type: text/csv`, and the body `id,role` / `<own id>,admin`. The client already makes this kind of upsert at login (`auth/callback.html`, the profiles POST), so RLS evidently allows a user to write their own profile row. If RLS or a column grant doesn't block `role`, this makes them admin. The Worker comment at `worker.js:852` shows the code treats the Worker as the control for `role`. The same technique lets a creator POST `tilesets` or `tiles` with another user's `owner_id`.
- **Fix:** Fail closed. Reject any write whose `Content-Type` isn't `application/json`, and return 400 if parsing or sanitising throws:
  ```js
  if (!/^application\/json/i.test(request.headers.get('Content-Type') || '')) return corsResponse({error:'JSON required'},415);
  try { ... } catch { return corsResponse({error:'Invalid body'},400); }
  ```
  Also enforce `role` and `owner_id` in the database, with a trigger or column-level privileges. Don't rely on the Worker for it.
- **Confidence:** Likely. The bypass is confirmed in code. Whether it yields privilege escalation depends on RLS and grants, which I couldn't see.

### M-1 — Supabase proxy forwards any path with no allowlist (Medium)
- **Location:** `worker.js:90-91`, `worker.js:713-792`
- **Description:** Every `/rest/v1/*` and `/storage/v1/*` request is forwarded with the server-held anon key. That includes `rpc/*` functions, any table, `GET /rest/v1/` (the OpenAPI schema), and storage. The Worker's own checks cover only `DELETE` on `profiles` and bulk `DELETE` on tiles/tilesets. Unauthenticated reads are forwarded as the `anon` role. The bulk-delete guard (`worker.js:746`) accepts any parameter of the form `x=eq.` or `x=in.`, so it isn't a reliable filter check.
- **Attack scenario:** A client can enumerate and call every exposed table or RPC. If any table or function has permissive RLS, it is exploitable through this proxy, and the proxy gives no second line of defence.
- **Fix:** Allowlist the exact tables, methods and RPCs the app uses (`profiles`, `tilesets`, `tiles`). Block `/rest/v1/` root and unused `/storage/v1/`. Review RLS for every table and RPC.
- **Confidence:** Confirmed behaviour. Impact **Needs confirmation** (RLS).

### M-2 — Creator ownership check may be bypassable via tileset `folder_path` (Medium)
- **Location:** `worker.js:316-343` (`canManageFolder`), `index.html:6797-6803` (tileset insert, client-chosen `folder_path`)
- **Description:** A creator may upload, delete and move files under `Resources/<folder>` if every tileset row *visible to them* with that `folder_path` is theirs. The lookup uses the caller's own token, so RLS hides unpublished tilesets owned by others. The client inserts tilesets with a freely chosen `folder_path` and the Worker does not constrain it.
- **Attack scenario:** Creator A inserts a tileset named anything with `folder_path` equal to victim B's unpublished folder. Both rows exist, but A sees only their own, so `rows.every(owner_id === uid)` passes. A can then overwrite or delete B's images in the shared GitHub repo through the bot. This needs a guessable or leaked folder name and no unique constraint on `folder_path`.
- **Fix:** Add a unique constraint on `tilesets.folder_path`. Have the Worker look up ownership with a privileged read that ignores RLS, or maintain an ownership map keyed by folder.
- **Confidence:** Needs confirmation (RLS and constraints are not in the repo).

### M-3 — Tokens in localStorage, no CSP, unpinned CDN scripts without SRI (Medium)
- **Location:** `auth/callback.html:140`, `index.html:2529` and `:2606` (tokens stored in `oph_user`); `index.html:29-31` (unpkg React and Babel), `:35-36` and `auth/callback.html:7-8` (Firebase from gstatic); no `Content-Security-Policy` anywhere
- **Description:** The long-lived Discord refresh token and the access token sit in localStorage next to the Firebase ID token. Third-party scripts load with no `integrity=` attribute. The app also needs `unsafe-eval` because Babel compiles in the browser, so a restrictive CSP is hard to add as things stand. I found no HTML-injection sinks in the app code (see section 4), so there is no known XSS path today. If one appears, or an unpkg/gstatic script is compromised, the attacker gets full account takeover, including reuse of the refresh token.
- **Fix:** Add SRI hashes, or self-host React and Babel. Pre-compile the JSX at build time, drop Babel, and add a CSP (`script-src 'self'`). Prefer keeping the refresh token out of JS-readable storage.
- **Confidence:** Confirmed (hardening gap; no current exploit).

### L-1 — Unauthenticated reads and no abuse limits beyond a per-IP counter (Low)
`worker.js:48-51`. Reads need no token, and the 300 req/min per IP limit is easy to spread across IPs. `AUTH_LIMITER` at 5 per minute per IP can also lock out legitimate users behind shared NAT. *Fix:* tune the limits and rate-limit per uid for authenticated routes. *Confidence:* Confirmed.

### L-2 — Uploaded content isn't checked beyond file extension (Low)
`worker.js:468-512`. `contentBase64` is committed as-is to a public repo after checking only the filename extension (png/jpg/gif/webp) and size. A creator can host arbitrary binary data under an image name, or flood the repo with commits (the bot opens a commit per upload). Files are served by extension, so I found no script execution path. *Fix:* check magic bytes and cap uploads per user per period. *Confidence:* Confirmed.

### L-3 — `tiles.image_url` can point to any external host (Low)
`index.html:325` (`src: row.image_url`), `:438-440`. Only the Worker's GitHub upload path is validated. Tile rows written through the proxy can contain any URL. A creator could set a tile image to a tracking URL and learn the IP of everyone who loads the tileset. *Fix:* validate `image_url` starts with `RAW_BASE` via a DB check constraint. *Confidence:* Likely. It depends on the DB accepting arbitrary URLs.

### L-4 — Unverified JWT payload used for decisions before Supabase sees it (Low)
`worker.js:730-735`, `:799-803`, `:949-957`. `decodeJwtPayload` doesn't verify the signature, and its `sub` is interpolated unencoded into `getUserRole`'s query (`worker.js:229`). Supabase rejects forged tokens, so I found no exploitable path today. It is fragile, though: any code path that reaches `getUserRole` with a null token would use the anon key with an attacker-chosen `sub`. *Fix:* use `verifyFirebaseJwt` everywhere and `encodeURIComponent` the uid. *Confidence:* Confirmed (latent).

### Informational
- **I-1 — No OAuth `state` parameter** (`index.html:4286-4294`, `auth/callback.html`). The PKCE verifier kept in `sessionStorage` effectively binds the flow to the browser, which mitigates login CSRF. Adding `state` is cheap defence in depth.
- **I-2 — `redirect_uri` is client-supplied to `/discord-token`** (`worker.js:111-127`). Discord validates it against the registered list, so the practical risk is low. Hardcode it in the Worker.
- **I-3 — Observability persists full invocation logs and traces at 100% sampling** (`wrangler.toml:8-18`), and some handlers log uids or Discord error bodies. Confirm no tokens appear, and set retention.

## 4. Positive observations
- Firebase JWT verification on the GitHub routes is correct: the algorithm is pinned to RS256, `kid` is looked up in Google's keys, and `aud`, `iss`, `exp` and `iat` are checked (`worker.js:912-947`).
- GitHub path validation is strict. It requires `Resources/…`, rejects `..`, `%`, `#`, `?`, `\`, hidden segments, and disallowed extensions, and never decodes or normalises (`worker.js:268-296`). `Resources/Global` is admin-only.
- No committed secrets. Git history contains no keys or tokens. The Firebase `apiKey` in the page is public by design. Secrets are Worker secrets.
- PKCE with S256 is used for Discord login. The client secret stays server-side.
- No `innerHTML`, `dangerouslySetInnerHTML`, `eval` or `document.write`, and no `postMessage` handlers in app code. React escapes rendered values. Locally uploaded SVGs are only used as `<img>` blob URLs.
- CORS is pinned to one origin. Commits are non-force and commit messages are sanitised. The bulk-delete guard and request-size cap are sensible.

## 5. Remediation roadmap
**Quick wins (hours):**
1. H-1: bind Discord tokens to your application ID, and remove the `X-Discord-Token` admin fallback.
2. H-2: require `application/json` and fail closed in the proxy.
3. M-1: add a table/RPC allowlist.
4. L-4: use verified JWT payloads and encode the uid.
5. Add SRI to the CDN scripts and `state` to OAuth.

**Larger work:**
1. Enforce `role` and `owner_id` in Postgres (RLS, triggers, column grants) so the Worker isn't the only control.
2. Fix folder ownership (M-2): unique `folder_path` and a privileged ownership lookup.
3. Replace in-browser Babel with a build step so a strict CSP is possible (M-3). Move away from storing refresh tokens in localStorage.
4. Add upload content checks and per-user quotas (L-2).

## 6. Coverage notes
- **Reviewed:** `worker.js` (all of it), `wrangler.toml`, `auth/callback.html`, the auth/session, data-access, upload and export code paths in `index.html` (by search plus reading the relevant regions, not every line of its 9,200), `manifest.json`, and git history for secrets.
- **Not reviewed or not applicable:** `sensor.js`, `sensor_ui.js`, `tile_palette.js` and the tests were only checked for dangerous sinks, not line by line. There is no `package.json`, so no `npm audit` was possible. Dependencies are CDN scripts at pinned versions without SRI. There are no Dockerfiles, CI workflows, GraphQL or LLM features, so those categories were skipped. The app has no passwords, MFA or server-side sessions of its own, so those parts of authentication do not apply.
- **Needs runtime testing or a human pentest:** Supabase RLS and column grants for `profiles`, `tilesets`, `tiles` and storage; whether CSV or form-encoded writes are accepted end to end (H-2); Discord app settings (H-1); GitHub Pages headers on the app and `raw.githubusercontent.com`; actual Worker log contents.
