/**
 * Opheliapp Proxy Worker
 * Sits between the GitHub Pages app and Supabase.
 * Uses Firebase Auth (Third-Party Auth) for identity — no service role key.
 *
 * Environment variables (wrangler.toml [vars]):
 *   SUPABASE_URL          = https://eizcooctnlugsxcyrplh.supabase.co
 *   DISCORD_CLIENT_ID     = 1503113409678410019
 *   FIREBASE_PROJECT_ID   = opheliapp-wow
 *
 * Secrets (wrangler secret put):
 *   SUPABASE_ANON_KEY
 *   DISCORD_CLIENT_SECRET
 *   FIREBASE_SERVICE_ACCOUNT
 *   GITHUB_BOT_TOKEN — fine-grained PAT for opheliapp-bot, Contents r/w on bicipikay/ophelia
 */

const ALLOWED_ORIGIN = 'https://bicipikay.github.io';
const DISCORD_REDIRECT_URI = 'https://bicipikay.github.io/ophelia/auth/callback.html';

const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

const BLOCKED_IPS = new Set([]);

// DELETE on these tables is admin-only. tiles/tilesets DELETE is forwarded to
// Supabase for everyone and RLS decides.
const ADMIN_SENSITIVE_TABLES = new Set([
  'profiles',
]);
const RLS_DELETE_TABLES = new Set(['tilesets', 'tiles']);

// Populated on first use; re-fetched after 1 hour.
let firebasePublicKeysCache = null;
let firebasePublicKeysCacheTime = 0;

export default {
  async fetch(request, env) {
    try {
      const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
      if (BLOCKED_IPS.has(ip)) {
        return new Response(null, { status: 403 });
      }

      if (request.method === 'OPTIONS') {
        return corsResponse(null, 204);
      }

      if (env.RATE_LIMITER) {
        const { success } = await env.RATE_LIMITER.limit({ key: ip });
        if (!success) return rateLimitResponse();
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/\/+/g, '/').toLowerCase();

      if (path === '/discord-token' || path === '/discord-refresh' || path === '/firebase-refresh') {
        if (env.AUTH_LIMITER) {
          const { success } = await env.AUTH_LIMITER.limit({ key: ip });
          if (!success) return rateLimitResponse();
        }
        if (path === '/discord-token') return handleDiscordToken(request, env);
        if (path === '/firebase-refresh') return handleFirebaseRefresh(request, env);
        return handleDiscordRefresh(request, env);
      }

      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
        return corsResponse({ error: 'Worker misconfigured' }, 500);
      }

      if (path === '/github/upload') {
        return handleGithubUpload(request, env);
      }

      if (path === '/github/delete') {
        return handleGithubDelete(request, env);
      }

      if (path === '/github/move') {
        return handleGithubMove(request, env);
      }

      if (path === '/github/delete-many') {
        return handleGithubDeleteMany(request, env);
      }

      if (path === '/github/diag') {
        return handleGithubDiag(request, env);
      }

      if (path.startsWith('/rest/v1/') || path.startsWith('/storage/v1/')) {
        return handleSupabaseProxy(request, url, path, env);
      }

      return corsResponse({ error: 'Forbidden' }, 403);
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return corsResponse({ error: 'Internal server error' }, 500);
    }
  }
};

async function handleDiscordToken(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  if (!env.DISCORD_CLIENT_SECRET) return corsResponse({ error: 'Worker misconfigured' }, 500);
  if (!env.FIREBASE_SERVICE_ACCOUNT) return corsResponse({ error: 'Worker misconfigured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { code, code_verifier, redirect_uri } = body;
  if (!code || !code_verifier || !redirect_uri) {
    return corsResponse({ error: 'Missing required fields: code, code_verifier, redirect_uri' }, 400);
  }

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri,
      code_verifier
    })
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('Discord token exchange failed:', tokens);
    return corsResponse({ error: 'Token exchange failed' }, tokenRes.status);
  }

  const discordUser = await fetchDiscordUser(tokens.access_token);
  if (!discordUser) {
    return corsResponse({ error: 'Failed to verify Discord user' }, 401);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT');
    return corsResponse({ error: 'Worker misconfigured' }, 500);
  }

  const firebaseToken = await mintFirebaseCustomToken(serviceAccount, discordUser.id);

  return corsResponse({
    firebase_token: firebaseToken,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in,
    discord_user: {
      id: discordUser.id,
      username: discordUser.global_name || discordUser.username,
      avatar: discordUser.avatar
    }
  }, 200);
}

async function handleDiscordRefresh(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  if (!env.DISCORD_CLIENT_SECRET) return corsResponse({ error: 'Worker misconfigured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { refresh_token } = body;
  if (!refresh_token) return corsResponse({ error: 'Missing required field: refresh_token' }, 400);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token
    })
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok) {
    console.error('Discord token refresh failed:', tokens);
    return corsResponse({ error: 'Token refresh failed' }, tokenRes.status);
  }

  return corsResponse({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_in: tokens.expires_in
  }, 200);
}

async function handleFirebaseRefresh(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  if (!env.FIREBASE_SERVICE_ACCOUNT) return corsResponse({ error: 'Worker misconfigured' }, 500);

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { access_token } = body;
  if (!access_token) return corsResponse({ error: 'Missing required field: access_token' }, 400);

  const discordUser = await fetchDiscordUser(access_token);
  if (!discordUser) {
    return corsResponse({ error: 'Invalid Discord access token' }, 401);
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT);
  } catch {
    return corsResponse({ error: 'Worker misconfigured' }, 500);
  }

  const firebaseToken = await mintFirebaseCustomToken(serviceAccount, discordUser.id);
  return corsResponse({ firebase_token: firebaseToken }, 200);
}

async function getUserRole(firebaseUid, env, token = null) {
  try {
    const authHeader = token ? `Bearer ${token}` : `Bearer ${env.SUPABASE_ANON_KEY}`;
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${firebaseUid}&select=role`,
      {
        headers: {
          'apikey': env.SUPABASE_ANON_KEY,
          'Authorization': authHeader,
        }
      }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? rows[0].role : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub helpers (path validation, ownership, Git Data API)
// ---------------------------------------------------------------------------

const GH_REPO = 'bicipikay/ophelia';
const GH_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const MAX_MOVES = 500;
// Names we create (uploads, move targets): letters digits . _ - + only.
const STRICT_NAME_RE = /^[A-Za-z0-9._+-]{1,100}$/;
// Folder segment must equal tilesets.folder_path; allow a space for legacy folders.
const FOLDER_RE = /^[A-Za-z0-9._+ -]{1,100}$/;
// Files that already exist (move sources, deletes) may have legacy names with
// spaces etc. They still may not contain % # ? \ / or control characters.
// Flip to true to apply the strict rule to sources/deletes as well.
const STRICT_SOURCE_NAMES = false;
const LEGACY_NAME_RE = /^[^%#?\\\/\x00-\x1f]{1,255}$/;

function cleanMessage(msg, fallback) {
  return String(msg || fallback).replace(/[\x00-\x1f\[\]]/g, '').slice(0, 256) || fallback;
}

// Validates Resources/<folder>[/<Sub>]/<name>. No decoding, no normalising:
// anything unusual is rejected, never altered. `strict` = creating a name.
function validateResourcePath(raw, strict) {
  if (typeof raw !== 'string' || !raw) return { error: 'Path must be a non-empty string' };
  if (raw.includes('..')) return { error: 'Path must not contain ".."' };
  if (/[%#?\\\x00-\x1f]/.test(raw)) return { error: 'Path must not contain % # ? \\ or control characters' };
  const segs = raw.split('/');
  if (segs[0] !== 'Resources') return { error: 'Path must start with Resources/' };
  if (segs.length < 3 || segs.length > 4) {
    return { error: 'Path must be Resources/<folder_path>/<name> with at most one sub-folder' };
  }
  if (segs.some(s => s === '' || s.startsWith('.') || s !== s.trim())) {
    return { error: 'Path contains an empty, hidden or padded segment' };
  }
  const folder = segs[1];
  if (!FOLDER_RE.test(folder)) return { error: 'Folder name has characters outside letters, digits, space . _ - +' };
  const nameRe = (strict || STRICT_SOURCE_NAMES) ? STRICT_NAME_RE : LEGACY_NAME_RE;
  const sub = segs.length === 4 ? segs[2] : null;
  const name = segs[segs.length - 1];
  if (sub !== null && !nameRe.test(sub)) {
    return { error: 'Sub-folder must be 1-100 characters: letters, digits, . _ - +' };
  }
  if (!nameRe.test(name)) {
    return { error: 'File name must be 1-100 characters: letters, digits, . _ - + only' };
  }
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || !GH_IMAGE_EXTS.has(name.slice(dot).toLowerCase())) {
    return { error: 'Unsupported file type (png, jpg, jpeg, gif, webp)' };
  }
  return { path: raw, folder, sub, name, dir: segs.slice(0, -1).join('/') };
}

async function authGithub(request, env, adminOnly = false) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { response: corsResponse({ error: 'Authentication required' }, 401) };
  }
  const token = authHeader.slice(7);
  const payload = await verifyFirebaseJwt(token);
  if (!payload || !payload.sub) return { response: corsResponse({ error: 'Invalid token' }, 401) };
  const role = await getUserRole(payload.sub, env, token);
  if (adminOnly ? role !== 'admin' : (role !== 'admin' && role !== 'creator')) {
    return { response: corsResponse({ error: 'Forbidden' }, 403) };
  }
  return { auth: { uid: payload.sub, token, role, folderCache: new Map() } };
}

// Admin: any folder. Creator: only folders whose tileset(s) they own
// (looked up with the caller's own token, so RLS limits visibility).
// Global and unowned tilesets are admin-only.
async function canManageFolder(auth, env, folder) {
  if (auth.role === 'admin') return { ok: true };
  if (folder.toLowerCase() === 'global') return { ok: false, error: 'Resources/Global is admin-only' };
  if (auth.folderCache.has(folder)) return auth.folderCache.get(folder);
  let result;
  try {
    const res = await fetch(
      `${env.SUPABASE_URL}/rest/v1/tilesets?folder_path=eq.${encodeURIComponent(folder)}&select=id,owner_id`,
      { headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${auth.token}` } }
    );
    if (!res.ok) {
      result = { ok: false, error: `Ownership lookup failed (${res.status})` };
    } else {
      const rows = await res.json();
      if (!Array.isArray(rows) || rows.length === 0) {
        result = { ok: false, error: `No tileset you can access uses folder "${folder}"` };
      } else if (rows.every(r => r.owner_id && r.owner_id === auth.uid)) {
        result = { ok: true };
      } else {
        result = { ok: false, error: `You do not own the tileset for folder "${folder}"` };
      }
    }
  } catch {
    result = { ok: false, error: 'Ownership lookup failed' };
  }
  auth.folderCache.set(folder, result);
  return result;
}

function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_BOT_TOKEN}`,
    'User-Agent': 'opheliapp-bot',
    'Accept': 'application/vnd.github+json',
  };
}

function ghContentsUrl(path) {
  return `https://api.github.com/repos/${GH_REPO}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
}

// Returns { status, json, ok }. Never throws.
async function ghCall(env, apiPath, method = 'GET', body = undefined) {
  try {
    const res = await fetch(`https://api.github.com/repos/${GH_REPO}${apiPath}`, {
      method,
      headers: body === undefined ? ghHeaders(env) : { ...ghHeaders(env), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text.slice(0, 500) }; }
    return { status: res.status, ok: res.ok, json };
  } catch (e) {
    return { status: 502, ok: false, json: { message: 'Network error calling GitHub: ' + (e && e.message) } };
  }
}

// GitHub's real status/message. A GitHub 401 is mapped to 502 so the app does
// not mistake a bad bot token for an expired user session.
function ghFail(step, r) {
  return corsResponse({
    error: `GitHub ${step} failed`,
    step,
    github_status: r.status,
    github_message: (r.json && r.json.message) || null,
    detail: r.json || null,
  }, r.status === 401 ? 502 : r.status);
}

const refPath = branch => `/git/ref/heads/${branch.split('/').map(encodeURIComponent).join('/')}`;

// default branch -> ref -> commit. Returns { head } or { response }.
async function ghGetHead(env) {
  const repo = await ghCall(env, '');
  if (!repo.ok) return { response: ghFail('read repository', repo) };
  const branch = repo.json.default_branch;
  const ref = await ghCall(env, refPath(branch));
  if (!ref.ok) return { response: ghFail('read default branch ref', ref) };
  const commitSha = ref.json.object.sha;
  const commit = await ghCall(env, `/git/commits/${commitSha}`);
  if (!commit.ok) return { response: ghFail('read head commit', commit) };
  return { head: { branch, commitSha, treeSha: commit.json.tree.sha } };
}

// Lazily lists a directory of the head tree (non-recursive, so large repos are fine).
// Returns Map name -> {type, sha}; empty Map when the directory does not exist.
function makeDirLoader(env, head) {
  const cache = new Map();
  const load = dir => {
    if (cache.has(dir)) return cache.get(dir);
    const p = (async () => {
      let treeSha;
      if (dir === '') {
        treeSha = head.treeSha;
      } else {
        const i = dir.lastIndexOf('/');
        const parent = await load(i < 0 ? '' : dir.slice(0, i));
        if (parent.error) return parent;
        const entry = parent.get(i < 0 ? dir : dir.slice(i + 1));
        if (!entry || entry.type !== 'tree') return new Map();
        treeSha = entry.sha;
      }
      const r = await ghCall(env, `/git/trees/${treeSha}`);
      if (!r.ok) { const m = new Map(); m.error = r; return m; }
      if (r.json.truncated) { const m = new Map(); m.error = { status: 413, json: { message: 'Directory listing truncated' } }; return m; }
      return new Map(r.json.tree.map(e => [e.path, { type: e.type, sha: e.sha }]));
    })();
    cache.set(dir, p);
    return p;
  };
  return async path => {
    const i = path.lastIndexOf('/');
    const dirMap = await load(path.slice(0, i));
    if (dirMap.error) return { error: dirMap.error };
    return { entry: dirMap.get(path.slice(i + 1)) || null };
  };
}

// tree (with base_tree) -> commit -> update ref (no force)
async function ghCommitEntries(env, head, entries, message) {
  const tree = await ghCall(env, '/git/trees', 'POST', { base_tree: head.treeSha, tree: entries });
  if (!tree.ok) return { response: ghFail('create tree', tree) };
  const commit = await ghCall(env, '/git/commits', 'POST', { message, tree: tree.json.sha, parents: [head.commitSha] });
  if (!commit.ok) return { response: ghFail('create commit', commit) };
  const upd = await ghCall(env, `/git/refs/heads/${head.branch.split('/').map(encodeURIComponent).join('/')}`, 'PATCH',
    { sha: commit.json.sha, force: false });
  if (!upd.ok) return { response: ghFail('update ref', upd) };
  return { commit: { sha: commit.json.sha, url: commit.json.html_url || null, branch: head.branch } };
}

function httpStatusFor(results) {
  const codes = results.filter(r => !r.ok).map(r => r.code);
  if (codes.includes('forbidden')) return 403;
  if (codes.includes('exists') || codes.includes('missing') || codes.includes('conflict')) return 409;
  return 400;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleGithubUpload(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  const a = await authGithub(request, env);
  if (a.response) return a.response;
  const auth = a.auth;

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { filePath, contentBase64, commitMessage } = body || {};
  const overwrite = body && body.overwrite === true;
  if (!filePath || !contentBase64) return corsResponse({ error: 'Missing filePath or contentBase64' }, 400);
  if (typeof contentBase64 !== 'string') return corsResponse({ error: 'contentBase64 must be a string' }, 400);
  // Reject if decoded content exceeds 10 MB
  if (Math.ceil(contentBase64.length * 3 / 4) > 10 * 1024 * 1024) {
    return corsResponse({ error: 'File too large' }, 400);
  }

  const v = validateResourcePath(filePath, true);
  if (v.error) return corsResponse({ error: 'Invalid filePath: ' + v.error, code: 'invalid_path' }, 400);
  const own = await canManageFolder(auth, env, v.folder);
  if (!own.ok) return corsResponse({ error: 'Forbidden: ' + own.error, code: 'forbidden' }, 403);

  const apiUrl = ghContentsUrl(v.path);
  const headers = ghHeaders(env);

  let sha;
  const getRes = await fetch(apiUrl, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    if (Array.isArray(existing)) {
      return corsResponse({ error: 'Path is a directory', code: 'conflict', path: v.path }, 409);
    }
    if (!overwrite) {
      return corsResponse({ error: 'A file already exists at this path. Choose another name.', code: 'exists', path: v.path }, 409);
    }
    sha = existing.sha;
  } else if (getRes.status !== 404) {
    const errBody = await getRes.text();
    return corsResponse({ error: 'GitHub GET failed', detail: errBody }, getRes.status === 401 ? 502 : getRes.status);
  }

  const putBody = { message: cleanMessage(commitMessage, `Upload ${v.path}`), content: contentBase64 };
  if (sha) putBody.sha = sha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });

  const putJson = await putRes.json();
  return corsResponse(putJson, putRes.status);
}

async function handleGithubDelete(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  const a = await authGithub(request, env);
  if (a.response) return a.response;
  const auth = a.auth;

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { filePath, commitMessage } = body || {};
  if (!filePath) return corsResponse({ error: 'Missing filePath' }, 400);
  const v = validateResourcePath(filePath, false);
  if (v.error) return corsResponse({ error: 'Invalid filePath: ' + v.error, code: 'invalid_path' }, 400);
  const own = await canManageFolder(auth, env, v.folder);
  if (!own.ok) return corsResponse({ error: 'Forbidden: ' + own.error, code: 'forbidden' }, 403);

  const apiUrl = ghContentsUrl(v.path);
  const headers = ghHeaders(env);

  const getRes = await fetch(apiUrl, { headers });
  if (getRes.status === 404) return corsResponse({ error: 'File not found' }, 404);
  if (!getRes.ok) {
    const errBody = await getRes.text();
    return corsResponse({ error: 'GitHub GET failed', detail: errBody }, getRes.status === 401 ? 502 : getRes.status);
  }
  const existing = await getRes.json();
  if (Array.isArray(existing)) return corsResponse({ error: 'Path is a directory' }, 409);

  const delRes = await fetch(apiUrl, {
    method: 'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: cleanMessage(commitMessage, `Delete ${v.path}`), sha: existing.sha }),
  });

  const delJson = await delRes.json();
  return corsResponse(delJson, delRes.status);
}

// POST /github/move  { moves:[{from,to}], deleteOld:boolean, commitMessage }
async function handleGithubMove(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  const a = await authGithub(request, env);
  if (a.response) return a.response;
  const auth = a.auth;

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const moves = body && body.moves;
  const deleteOld = body && body.deleteOld === true;
  if (!Array.isArray(moves) || moves.length === 0) return corsResponse({ error: 'moves must be a non-empty array' }, 400);
  if (moves.length > MAX_MOVES) return corsResponse({ error: `At most ${MAX_MOVES} moves per request` }, 400);

  // 1. Static validation (paths, ownership, duplicates)
  const results = [];
  const toSeen = new Set();
  const fromSeen = new Set();
  const fromAll = new Set(moves.map(m => m && m.from));
  for (let i = 0; i < moves.length; i++) {
    const m = moves[i] || {};
    const r = { index: i, from: m.from, to: m.to, ok: true };
    results.push(r);
    const vf = validateResourcePath(m.from, false);
    const vt = validateResourcePath(m.to, true);
    if (vf.error) { Object.assign(r, { ok: false, code: 'invalid_path', error: 'from: ' + vf.error }); continue; }
    if (vt.error) { Object.assign(r, { ok: false, code: 'invalid_path', error: 'to: ' + vt.error }); continue; }
    if (vf.path === vt.path) { Object.assign(r, { ok: false, code: 'invalid_path', error: 'from and to are identical' }); continue; }
    for (const folder of new Set([vf.folder, vt.folder])) {
      const own = await canManageFolder(auth, env, folder);
      if (!own.ok) { Object.assign(r, { ok: false, code: 'forbidden', error: own.error }); break; }
    }
    if (!r.ok) continue;
    if (toSeen.has(vt.path)) { Object.assign(r, { ok: false, code: 'duplicate_to', error: 'Duplicate target in this request' }); continue; }
    toSeen.add(vt.path);
    if (fromAll.has(vt.path)) { Object.assign(r, { ok: false, code: 'conflict', error: 'Target is also a source in this request' }); continue; }
    if (deleteOld && fromSeen.has(vf.path)) { Object.assign(r, { ok: false, code: 'duplicate_from', error: 'Duplicate source with deleteOld' }); continue; }
    fromSeen.add(vf.path);
    r.v = { from: vf.path, to: vt.path };
  }
  if (results.some(r => !r.ok)) {
    return corsResponse({ error: 'Validation failed; nothing was changed', results: results.map(({ v, ...r }) => r) }, httpStatusFor(results));
  }

  // 2. Current state of GitHub
  const h = await ghGetHead(env);
  if (h.response) return h.response;
  const lookup = makeDirLoader(env, h.head);
  const entries = [];
  const deleted = new Set();
  for (const r of results) {
    const src = await lookup(r.v.from);
    if (src.error) return ghFail('list directory', src.error);
    if (!src.entry || src.entry.type !== 'blob') {
      Object.assign(r, { ok: false, code: 'missing', error: 'Source file does not exist' });
      continue;
    }
    const dst = await lookup(r.v.to);
    if (dst.error) return ghFail('list directory', dst.error);
    if (dst.entry) {
      Object.assign(r, { ok: false, code: 'exists', error: 'Target already exists' });
      continue;
    }
    r.blobSha = src.entry.sha;
    entries.push({ path: r.v.to, mode: '100644', type: 'blob', sha: src.entry.sha });
    if (deleteOld && !deleted.has(r.v.from)) {
      deleted.add(r.v.from);
      entries.push({ path: r.v.from, mode: '100644', type: 'blob', sha: null });
    }
  }
  if (results.some(r => !r.ok)) {
    return corsResponse({ error: 'Validation failed; nothing was changed', results: results.map(({ v, ...r }) => r) }, httpStatusFor(results));
  }

  // 3. One commit
  const message = cleanMessage(body.commitMessage, `${deleteOld ? 'Move' : 'Copy'} ${results.length} file(s)`);
  const c = await ghCommitEntries(env, h.head, entries, message);
  if (c.response) return c.response;
  return corsResponse({
    ok: true,
    commit: c.commit,
    deleteOld,
    results: results.map(r => ({ index: r.index, from: r.from, to: r.to, ok: true, status: deleteOld ? 'moved' : 'copied', blobSha: r.blobSha })),
  }, 200);
}

// POST /github/delete-many  { paths:[...], commitMessage }  -> one commit
async function handleGithubDeleteMany(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);
  const a = await authGithub(request, env);
  if (a.response) return a.response;
  const auth = a.auth;

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const paths = body && body.paths;
  if (!Array.isArray(paths) || paths.length === 0) return corsResponse({ error: 'paths must be a non-empty array' }, 400);
  if (paths.length > MAX_MOVES) return corsResponse({ error: `At most ${MAX_MOVES} paths per request` }, 400);

  const results = [];
  const seen = new Set();
  for (let i = 0; i < paths.length; i++) {
    const r = { index: i, path: paths[i], ok: true };
    results.push(r);
    const v = validateResourcePath(paths[i], false);
    if (v.error) { Object.assign(r, { ok: false, code: 'invalid_path', error: v.error }); continue; }
    const own = await canManageFolder(auth, env, v.folder);
    if (!own.ok) { Object.assign(r, { ok: false, code: 'forbidden', error: own.error }); continue; }
    if (seen.has(v.path)) { Object.assign(r, { ok: false, code: 'invalid_path', error: 'Duplicate path in request' }); continue; }
    seen.add(v.path);
  }
  if (results.some(r => !r.ok)) {
    return corsResponse({ error: 'Validation failed; nothing was changed', results }, httpStatusFor(results));
  }

  const h = await ghGetHead(env);
  if (h.response) return h.response;
  const lookup = makeDirLoader(env, h.head);
  const entries = [];
  for (const r of results) {
    const f = await lookup(r.path);
    if (f.error) return ghFail('list directory', f.error);
    if (!f.entry || f.entry.type !== 'blob') { r.status = 'missing'; continue; }
    r.status = 'deleted';
    entries.push({ path: r.path, mode: '100644', type: 'blob', sha: null });
  }
  if (entries.length === 0) {
    return corsResponse({ ok: true, commit: null, results }, 200);
  }
  const c = await ghCommitEntries(env, h.head, entries, cleanMessage(body.commitMessage, `Delete ${entries.length} file(s)`));
  if (c.response) return c.response;
  return corsResponse({ ok: true, commit: c.commit, results }, 200);
}

// GET /github/diag  (admin only): can the bot token read the default branch ref?
async function handleGithubDiag(request, env) {
  if (request.method !== 'GET') return corsResponse({ error: 'Method not allowed' }, 405);
  const a = await authGithub(request, env, true);
  if (a.response) return a.response;
  const repo = await ghCall(env, '');
  if (!repo.ok) {
    return corsResponse({ ok: false, step: 'read repository', github_status: repo.status, github_message: (repo.json && repo.json.message) || null }, repo.status === 401 ? 502 : repo.status);
  }
  const branch = repo.json.default_branch;
  const ref = await ghCall(env, refPath(branch));
  return corsResponse({
    ok: ref.ok,
    repo: GH_REPO,
    default_branch: branch,
    step: 'read default branch ref',
    github_status: ref.status,
    github_message: ref.ok ? null : ((ref.json && ref.json.message) || null),
    ref_sha: ref.ok ? ref.json.object.sha : null,
  }, ref.ok ? 200 : (ref.status === 401 ? 502 : ref.status));
}

async function handleSupabaseProxy(request, url, normalizedPath, env) {
  const method = request.method;

  const segment = normalizedPath.startsWith('/rest/v1/')
    ? normalizedPath.slice('/rest/v1/'.length)
    : normalizedPath.slice('/storage/v1/'.length);
  const table = segment.split('?')[0].split('/')[0];

  const authHeader = request.headers.get('Authorization');
  let firebaseUid = null;

  if (WRITE_METHODS.has(method)) {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.warn('[auth] missing token', method, table);
      return corsResponse({ error: 'Authentication required' }, 401);
    }

    const payload = decodeJwtPayload(authHeader.slice(7));
    if (!payload || !payload.sub) {
      console.warn('[auth] invalid token', method, table);
      return corsResponse({ error: 'Invalid token' }, 401);
    }
    firebaseUid = payload.sub;

    if (method === 'DELETE' && ADMIN_SENSITIVE_TABLES.has(table)) {
      const isAdmin = await verifyAdmin(request, env);
      if (!isAdmin) {
        console.warn('[auth] unauthorized DELETE', table, 'uid:', firebaseUid);
        return corsResponse({ error: 'Forbidden' }, 403);
      }
    }

    // tiles/tilesets: RLS decides, but never forward an unfiltered bulk DELETE.
    if (method === 'DELETE' && RLS_DELETE_TABLES.has(table) && !/[?&][a-z_]+=(eq|in)\./i.test(url.search)) {
      return corsResponse({ error: 'DELETE requires an id filter' }, 400);
    }

    if (method === 'POST' || method === 'PATCH' || method === 'PUT') {
      const cloned = request.clone();
      try {
        const bodyJson = await request.json();
        const sanitised = await sanitiseBody(bodyJson, firebaseUid, env, authHeader.slice(7));
        request = new Request(request.url, {
          method,
          headers: request.headers,
          body: JSON.stringify(sanitised)
        });
      } catch {
        request = cloned;
      }
    }
  }

  const supabaseUrl = `${env.SUPABASE_URL}${url.pathname}${url.search}`;
  const headers = new Headers();
  headers.set('apikey', env.SUPABASE_ANON_KEY);
  if (authHeader) headers.set('Authorization', authHeader);

  for (const h of ['Content-Type', 'Prefer', 'X-Upsert', 'Range']) {
    const val = request.headers.get(h);
    if (val) headers.set(h, val);
  }

  const supabaseResp = await fetch(new Request(supabaseUrl, {
    method,
    headers,
    body: WRITE_METHODS.has(method) ? request.body : undefined
  }));

  const responseBody = await supabaseResp.text();
  const extraHeaders = {};
  const contentRange = supabaseResp.headers.get('Content-Range');
  if (contentRange) extraHeaders['Content-Range'] = contentRange;
  return corsResponse(
    responseBody,
    supabaseResp.status,
    supabaseResp.headers.get('Content-Type') || 'application/json',
    extraHeaders
  );
}

async function verifyAdmin(request, env) {
  // Prefer Firebase JWT (consistent with GitHub routes, no extra Discord header needed)
  const authHeader = request.headers.get('Authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    const payload = decodeJwtPayload(token);
    if (payload && payload.sub) {
      const role = await getUserRole(payload.sub, env, token);
      if (role === 'admin') return true;
    }
  }
  // Fallback: legacy Discord token check
  const discordToken = request.headers.get('X-Discord-Token');
  if (!discordToken) return false;
  const discordUser = await fetchDiscordUser(discordToken);
  if (!discordUser) return false;
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${discordUser.id}&select=role`,
    {
      headers: {
        'apikey': env.SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${env.SUPABASE_ANON_KEY}`
      }
    }
  );
  const rows = await res.json();
  return Array.isArray(rows) && rows.length > 0 && rows[0].role === 'admin';
}

async function fetchDiscordUser(token) {
  try {
    const res = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.id || !/^\d+$/.test(data.id)) return null;
    return data;
  } catch {
    return null;
  }
}

async function sanitiseBody(body, firebaseUid, env, token = null) {
  if (Array.isArray(body)) {
    return Promise.all(body.map(item => sanitiseBody(item, firebaseUid, env, token)));
  }
  const patched = { ...body };

  // Admins may transfer ownership; everyone else cannot set owner_id to another uid
  if ('owner_id' in patched && patched.owner_id !== firebaseUid) {
    const role = await getUserRole(firebaseUid, env, token);
    if (role !== 'admin') {
      console.warn(`Body sanitisation: owner_id overwritten with verified uid (non-admin)`);
      patched.owner_id = firebaseUid;
    }
  }

  // Non-admins cannot set role to any value; admins may change role freely
  if ('role' in patched) {
    const callerRole = await getUserRole(firebaseUid, env, token);
    if (callerRole !== 'admin') {
      console.warn(`Body sanitisation: role stripped from non-admin request by uid=${firebaseUid}`);
      delete patched.role;
    }
  }

  // Always overwrite last_updated_at with server timestamp
  if ('last_updated_at' in patched) {
    patched.last_updated_at = new Date().toISOString();
  }

  // Always overwrite last_updated_by with verified uid (cannot be spoofed)
  if ('last_updated_by' in patched) {
    patched.last_updated_by = firebaseUid;
  }

  return patched;
}

async function getFirebasePublicKeys() {
  const ONE_HOUR = 3600 * 1000;
  if (firebasePublicKeysCache && Date.now() - firebasePublicKeysCacheTime < ONE_HOUR) {
    return firebasePublicKeysCache;
  }
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) return null;
  firebasePublicKeysCache = await res.json();
  firebasePublicKeysCacheTime = Date.now();
  return firebasePublicKeysCache;
}

// Extracts the SubjectPublicKeyInfo (SPKI) DER buffer from a PEM X.509 certificate.
// Works by locating the RSA OID inside the DER and reading the enclosing SEQUENCE.
function pemCertToSpki(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  // RSA OID 1.2.840.113549.1.1.1 — 9 bytes, no tag/length prefix
  const rsaOid = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
  for (let i = 0; i <= der.length - rsaOid.length; i++) {
    if (!rsaOid.every((b, j) => der[i + j] === b)) continue;
    // OID tag (0x06) + length (0x09) sit 2 bytes before the OID value bytes
    if (i < 2 || der[i - 2] !== 0x06 || der[i - 1] !== 0x09) continue;
    // AlgorithmIdentifier SEQUENCE (0x30) sits 2 bytes before the OID tag
    const algIdOff = i - 4;
    if (algIdOff < 4 || der[algIdOff] !== 0x30) continue;
    // SubjectPublicKeyInfo SEQUENCE uses long-form length (0x30 0x82 nn nn), 4 bytes before AlgId
    const spkiOff = algIdOff - 4;
    if (spkiOff < 0 || der[spkiOff] !== 0x30 || der[spkiOff + 1] !== 0x82) continue;
    const spkiLen = (der[spkiOff + 2] << 8) | der[spkiOff + 3];
    if (spkiOff + 4 + spkiLen > der.length) continue;
    return der.slice(spkiOff, spkiOff + 4 + spkiLen).buffer;
  }
  return null;
}

async function verifyFirebaseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const decode = s => JSON.parse(atob(s.replace(/-/g, '+').replace(/_/g, '/')));
    const header  = decode(parts[0]);
    const payload = decode(parts[1]);
    if (!header.kid || header.alg !== 'RS256') return null;
    if (payload.aud !== 'opheliapp-wow') return null;
    if (payload.iss !== 'https://securetoken.google.com/opheliapp-wow') return null;
    const keys = await getFirebasePublicKeys();
    if (!keys || !keys[header.kid]) return null;
    const spki = pemCertToSpki(keys[header.kid]);
    if (!spki) return null;
    const cryptoKey = await crypto.subtle.importKey(
      'spki', spki,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    );
    const sigBytes = Uint8Array.from(
      atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0)
    );
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', cryptoKey, sigBytes,
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || now > payload.exp) return null;
    if (typeof payload.iat !== 'number' || payload.iat > now + 30) return null;
    return payload;
  } catch {
    return null;
  }
}

function decodeJwtPayload(token) {
  try {
    const [, payloadB64] = token.split('.');
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(padded));
  } catch {
    return null;
  }
}

async function mintFirebaseCustomToken(serviceAccount, uid) {
  const now = Math.floor(Date.now() / 1000);
  const headerB64 = base64UrlEncodeStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payloadB64 = base64UrlEncodeStr(JSON.stringify({
    iss: serviceAccount.client_email,
    sub: serviceAccount.client_email,
    aud: 'https://identitytoolkit.googleapis.com/google.identity.identitytoolkit.v1.IdentityToolkit',
    iat: now,
    exp: now + 3600,
    uid,
    claims: { role: 'authenticated' }
  }));

  const signingInput = `${headerB64}.${payloadB64}`;
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pemToBinary(serviceAccount.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  return `${signingInput}.${base64UrlEncodeBuffer(sigBytes)}`;
}

function base64UrlEncodeStr(str) {
  return base64UrlEncodeBuffer(new TextEncoder().encode(str).buffer);
}

function base64UrlEncodeBuffer(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pemToBinary(pem) {
  const base64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function rateLimitResponse() {
  return new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Retry-After': '60',
    }
  });
}

function corsResponse(body, status, contentType = 'application/json', extraHeaders = {}) {
  const headers = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, X-Discord-Token, Prefer, X-Upsert, Cache-Control, Pragma, Expires, Range, Content-Range',
    'Access-Control-Expose-Headers': 'Content-Range',
    'Access-Control-Max-Age': '86400',
    'Content-Type': contentType,
    ...extraHeaders
  };

  const responseBody =
    body === null ? null :
    typeof body === 'string' ? body :
    JSON.stringify(body);

  return new Response(responseBody, { status, headers });
}
