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

const ADMIN_SENSITIVE_TABLES = new Set([
  'profiles',
  'tilesets',
  'tiles',
]);

// Populated on first use; lives for the duration of the Worker instance.
let firebasePublicKeysCache = null;

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

async function handleGithubUpload(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return corsResponse({ error: 'Authentication required' }, 401);
  }
  const payload = await verifyFirebaseJwt(authHeader.slice(7));
  if (!payload || !payload.sub) return corsResponse({ error: 'Invalid token' }, 401);
  const uid = payload.sub;

  const role = await getUserRole(uid, env, authHeader.slice(7));
  if (role !== 'admin' && role !== 'creator') {
    return corsResponse({ error: 'Forbidden' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { filePath, contentBase64, commitMessage } = body;
  if (!filePath || !contentBase64) return corsResponse({ error: 'Missing filePath or contentBase64' }, 400);
  if (contentBase64.length > 10_000_000) return corsResponse({ error: 'File too large' }, 400);
  if (!filePath.startsWith('Resources/')) return corsResponse({ error: 'Forbidden: filePath must start with Resources/' }, 403);
  const normalisedUploadPath = filePath.split('/').reduce((acc, seg) => {
    if (seg === '..') acc.pop();
    else if (seg !== '.') acc.push(seg);
    return acc;
  }, []).join('/');
  if (normalisedUploadPath !== filePath || !normalisedUploadPath.startsWith('Resources/')) {
    return corsResponse({ error: 'Forbidden: invalid filePath' }, 403);
  }

  const apiUrl = `https://api.github.com/repos/bicipikay/ophelia/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_BOT_TOKEN}`,
    'User-Agent': 'opheliapp-bot',
    'Accept': 'application/vnd.github+json',
  };

  let sha;
  const getRes = await fetch(apiUrl, { headers: ghHeaders });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  } else if (getRes.status !== 404) {
    const errBody = await getRes.text();
    return corsResponse({ error: 'GitHub GET failed', detail: errBody }, getRes.status);
  }

  const putBody = { message: (commitMessage || `Upload ${filePath}`).replace(/[\x00-\x1f]/g, '').slice(0, 256), content: contentBase64 };
  if (sha) putBody.sha = sha;

  const putRes = await fetch(apiUrl, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(putBody),
  });

  const putJson = await putRes.json();
  return corsResponse(putJson, putRes.status);
}

async function handleGithubDelete(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405);

  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return corsResponse({ error: 'Authentication required' }, 401);
  }
  const payload = await verifyFirebaseJwt(authHeader.slice(7));
  if (!payload || !payload.sub) return corsResponse({ error: 'Invalid token' }, 401);
  const uid = payload.sub;

  const role = await getUserRole(uid, env, authHeader.slice(7));
  if (role !== 'admin' && role !== 'creator') {
    return corsResponse({ error: 'Forbidden' }, 403);
  }

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON body' }, 400); }

  const { filePath, commitMessage } = body;
  if (!filePath) return corsResponse({ error: 'Missing filePath' }, 400);
  if (!filePath.startsWith('Resources/')) return corsResponse({ error: 'Forbidden: filePath must start with Resources/' }, 403);
  const normalisedDeletePath = filePath.split('/').reduce((acc, seg) => {
    if (seg === '..') acc.pop();
    else if (seg !== '.') acc.push(seg);
    return acc;
  }, []).join('/');
  if (normalisedDeletePath !== filePath || !normalisedDeletePath.startsWith('Resources/')) {
    return corsResponse({ error: 'Forbidden: invalid filePath' }, 403);
  }

  const apiUrl = `https://api.github.com/repos/bicipikay/ophelia/contents/${encodeURIComponent(filePath).replace(/%2F/g, '/')}`;
  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_BOT_TOKEN}`,
    'User-Agent': 'opheliapp-bot',
    'Accept': 'application/vnd.github+json',
  };

  const getRes = await fetch(apiUrl, { headers: ghHeaders });
  if (getRes.status === 404) return corsResponse({ error: 'File not found' }, 404);
  if (!getRes.ok) {
    const errBody = await getRes.text();
    return corsResponse({ error: 'GitHub GET failed', detail: errBody }, getRes.status);
  }
  const existing = await getRes.json();
  const sha = existing.sha;

  const delRes = await fetch(apiUrl, {
    method: 'DELETE',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: (commitMessage || `Delete ${filePath}`).replace(/[\x00-\x1f]/g, '').slice(0, 256), sha }),
  });

  const delJson = await delRes.json();
  return corsResponse(delJson, delRes.status);
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
      return corsResponse({ error: 'Authentication required' }, 401);
    }

    const payload = decodeJwtPayload(authHeader.slice(7));
    if (!payload || !payload.sub) {
      return corsResponse({ error: 'Invalid token' }, 401);
    }
    firebaseUid = payload.sub;
    console.error(`[auth] uid=${firebaseUid} method=${method} table=${table}`);

    if (method === 'DELETE' && ADMIN_SENSITIVE_TABLES.has(table)) {
      const isAdmin = await verifyAdmin(request, env);
      if (!isAdmin) {
        console.warn(`Unauthorized DELETE on ${table} by uid=${firebaseUid}`);
        return corsResponse({ error: 'Forbidden' }, 403);
      }
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

  return patched;
}

async function getFirebasePublicKeys() {
  if (firebasePublicKeysCache) return firebasePublicKeysCache;
  const res = await fetch(
    'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com'
  );
  if (!res.ok) return null;
  firebasePublicKeysCache = await res.json();
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
    return valid ? payload : null;
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
