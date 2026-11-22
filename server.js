// KiluaAI — Social Scheduler
// Express backend + MongoDB storage (MONGODB_URI in Vercel env vars), with
// local JSON files in data/ ONLY as a local-dev fallback. On Vercel the
// filesystem is ephemeral, so nothing durable may live in files there:
// users, sessions, posts, media, templates, settings, the Instagram token
// and import jobs all live in MongoDB (database "social_scheduler", a
// separate database in the same Atlas cluster as PureNest).
// Login: email + password accounts (first user is the owner), scrypt hashes,
// HMAC-signed httpOnly session cookie (SESSION_SECRET from env — set it in
// Vercel or logins die on every redeploy/restart).
// Instagram connection: "Connect Instagram" Meta login (OAuth) in Settings
// is the ONLY flow (the token-paste flow was removed). The token from the
// login is verified live and stored encrypted at rest in MongoDB.
// INSTAGRAM_ACCESS_TOKEN / IG_USER_ID env vars are the last-resort fallback.
// Never commit a token, a password hash, or any credential.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const tls = require('tls');
const dnsPromises = require('node:dns').promises;
const db = require('./db');

const app = express();
app.disable('x-powered-by'); // don't advertise the stack in every response
const PORT = process.env.PORT || 3000;

// SESSION_SECRET signs login cookies: it MUST come from env vars in
// production. Without it a random per-process secret is generated and every
// user is logged out whenever the server restarts or Vercel redeploys —
// that was the main login bug. /api/db-status reports whether the env var
// is set (name only, never the value).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set — sessions use a random secret and will NOT survive a restart or redeploy. Set SESSION_SECRET in Vercel env vars (all environments).');
}
const SESSION_COOKIE = 'ss_session';
const SESSION_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

app.use(express.json({ limit: '15mb' })); // largest legit body is a ~12 MB base64 upload; 100 MB invited abuse
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// Security headers (no new dependency): nosniff, no framing, no referrer
// leak, a real CSP that still allows Instagram CDN media + data: uploads,
// and a locked-down permissions policy. API JSON is never cached. HSTS is
// sent only on secure requests (production / HTTPS) — over plain HTTP it
// is meaningless and browsers ignore it anyway.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // accounts.google.com appears in script/frame/connect ONLY for the
  // Google Identity Services sign-in button on the login screen —
  // no other external host is allowed to script or frame this app.
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' https: data:; media-src 'self' https: data: blob:; font-src 'self'; connect-src 'self' https://graph.facebook.com https://accounts.google.com; frame-src https://accounts.google.com; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'");
  if (isSecureRequest(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  next();
});

// Request log: method/path/status/ms only — never bodies, tokens or cookies.
app.use((req, res, next) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (req.path.startsWith('/api')) console.log(`[api] ${req.method} ${req.path} ${res.statusCode} ${ms}ms`);
  });
  next();
});

// Rate limiting (in-memory, per instance): 300 requests/min per IP on the
// API generally, 20/min on auth routes. Generous on purpose — the import
// poller hits every 1.5 s and publish polls every 5 s, so a tight limit
// would break real use. Returns 429 + Retry-After.
const rateBuckets = new Map();
function rateLimit(max, windowMs, name) {
  return (req, res, next) => {
    const key = `${name}:${req.ip || req.socket?.remoteAddress || 'unknown'}`;
    const now = Date.now();
    const rec = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + windowMs; }
    rec.count += 1;
    rateBuckets.set(key, rec);
    if (rec.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((rec.resetAt - now) / 1000)));
      return res.status(429).json({ ok: false, error: 'Too many requests — please wait a minute and try again.' });
    }
    return next();
  };
}
const apiRateLimit = rateLimit(300, 60000, 'api');
const authRateLimit = rateLimit(20, 60000, 'auth');
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.resetAt) rateBuckets.delete(k);
}, 60000).unref?.();

// Same-origin check on state-changing API calls: the frontend is
// same-origin, so a cross-origin POST/PATCH/DELETE with an Origin header
// is CSRF, not a user. The cron endpoint is exempt (bearer token instead).
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'DELETE'].includes(req.method) && !req.path.startsWith('/cron/')) {
    const origin = req.get('origin');
    if (origin) {
      try {
        const host = req.get('host') || '';
        const originHost = new URL(origin).host;
        // Local dev: the Vite dev server (localhost:5173) proxies /api to
        // this server (localhost:3000), so Origin and Host legitimately
        // differ by port. Allow localhost origins outside production only.
        const isLocalOrigin = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(originHost);
        if (originHost !== host && !(process.env.NODE_ENV !== 'production' && isLocalOrigin)) {
          return res.status(403).json({ ok: false, error: 'That request did not come from this site — please use the app itself.' });
        }
      } catch {
        // An Origin header that cannot be parsed at all (e.g. the
        // literal "null" browsers send for opaque origins) is not
        // evidence of a same-origin request — reject it exactly like
        // a foreign origin instead of falling through to auth.
        return res.status(403).json({ ok: false, error: 'That request did not come from this site — please use the app itself.' });
      }
    }
  }
  next();
});

// Security: reject MongoDB operator keys ($gt, $ne, ...) and prototype
// pollution keys (__proto__, constructor) ANYWHERE in a JSON body, plus
// dotted keys. Request bodies are data, never query operators — an object
// smuggled in as a field value used to be cast to a string and corrupt the
// saved post. Legitimate bodies here only ever use plain field names.
function hasBadKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return false;
  if (Array.isArray(value)) return value.some((v) => hasBadKey(v, depth + 1));
  return Object.keys(value).some((k) =>
    k.startsWith('$') || k.includes('.') || k === '__proto__' || k === 'constructor' || k === 'prototype' || hasBadKey(value[k], depth + 1));
}
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object' && hasBadKey(req.body)) {
    return res.status(400).json({ ok: false, error: 'That request contained something the server does not accept — please try again.' });
  }
  next();
});

// Serve the Vite build when present. Hashed /assets/* files are immutable
// for a year; index.html is never cached (it references the new hashes).
const DIST = path.join(__dirname, 'frontend', 'dist');
if (fs.existsSync(path.join(DIST, 'index.html'))) {
  app.use(express.static(DIST, {
    setHeaders: (res, filePath) => {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
}

function uid(prefix) { return prefix + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'); }
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Owner console (batch 2): a server-rendered page + API under one
// deliberately non-obvious path segment. It is gated server-side by
// the owner's account identity plus a PIN; every other visitor —
// logged in or not — gets the plain 404 an unknown route gets, and
// nothing in the client app references it. The path is recorded only
// in the goal's hidden build-progress file, never in user-facing docs.
// Keep this constant in sync with the /api middleware exemption below.
const ADMIN_SLUG = 'hq-7f3k9';

// The app's own public origin, used to build URLs that outside services
// (Instagram's media fetcher) download from — same host derivation as
// the connect links: the request's host, falling back to production.
function publicBase(req) {
  const proto = req && isSecureRequest(req) ? 'https' : 'http';
  const host = (req && req.get('host')) || 'social-scheduler-one-sandy.vercel.app';
  return `${proto}://${host}`;
}
// Unguessable id for a stored media file (128 bits of randomness): the
// /media/<id> URL is public by design — Instagram must fetch it without
// logging in — so the id itself is the access control.
function newMediaFileId() { return 'f' + crypto.randomBytes(16).toString('hex'); }
// Uploadable media types: raster images and the video formats Instagram
// takes. Deliberately NOT a bare image/* wildcard — image/svg+xml is an
// XML document that can carry script, and anything served back from
// /media/<id> must be inert bytes, never an executable document type.
const SAFE_MEDIA_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/quicktime', 'video/webm',
]);
// Magic-byte verification (audit L-02, 2026-11-22): the declared MIME
// type used to be trusted on its own — a text file declared as
// image/jpeg was stored as an "image". The bytes must now carry the
// signature of the type they claim to be. Signatures are the stable
// file-format magics: JPEG SOI, PNG IHDR preamble, GIF header, RIFF
// container with a WEBP form type, an ISO-BMFF ftyp box for MP4 /
// QuickTime / AVIF (AVIF additionally requires an avif-family brand),
// and the EBML header for WebM.
function mediaSignatureOk(contentType, buffer) {
  if (!buffer || buffer.length < 4) return false;
  const b = buffer;
  const ascii = (from, to) => b.toString('latin1', from, to);
  switch (contentType) {
    case 'image/jpeg': return b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF;
    case 'image/png': return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 && b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A;
    case 'image/gif': return ascii(0, 4) === 'GIF8';
    case 'image/webp': return b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP';
    case 'image/avif': return b.length >= 12 && ascii(4, 8) === 'ftyp' && /^(avif|avis|mif1|mif2|msf1)/.test(ascii(8, 12));
    case 'video/mp4':
    case 'video/quicktime': return b.length >= 8 && ascii(4, 8) === 'ftyp';
    case 'video/webm': return b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3;
    default: return false;
  }
}
// Parse a data: URL into { contentType, buffer }, or null when it is not
// a decodable image/video data URL of an allowed type whose bytes match
// that type's signature (audit L-02).
function parseDataUrl(s) {
  if (typeof s !== 'string') return null;
  const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(s);
  if (!m) return null;
  const contentType = (m[1] || '').toLowerCase();
  if (!SAFE_MEDIA_TYPES.has(contentType)) return null;
  try {
    const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
    if (!buffer.length || !mediaSignatureOk(contentType, buffer)) return null;
    return { contentType, buffer };
  } catch { return null; }
}

// ---------- OCI Object Storage media backend (optional) ----------
// When BOTH MEDIA_OCI_READ_BASE and MEDIA_OCI_WRITE_BASE are set —
// pre-authenticated request (PAR) base URLs for the bridge bucket,
// each ending in "/o/" — new uploads are stored as objects in OCI
// Object Storage instead of as binaries in the database mediafiles
// store. The object name is the same unguessable media file id, the
// library item records storage:"oci" + objectName, and its public url
// is the read-base URL Instagram fetches. The write base also serves
// deletes (post-publish auto-delete, library item delete). With
// either variable unset, uploads behave exactly as before.
const OCI_READ_BASE = (process.env.MEDIA_OCI_READ_BASE || '').trim();
const OCI_WRITE_BASE = (process.env.MEDIA_OCI_WRITE_BASE || '').trim();
function ociEnabled() { return !!(OCI_READ_BASE && OCI_WRITE_BASE); }
function ociObjectUrl(base, objectName) { return (base.endsWith('/') ? base : base + '/') + objectName; }
function ociReadUrl(objectName) { return ociObjectUrl(OCI_READ_BASE, objectName); }
async function ociPutObject(objectName, buffer, contentType) {
  const res = await fetch(ociObjectUrl(OCI_WRITE_BASE, objectName), {
    method: 'PUT',
    headers: { 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer,
  });
  if (!res.ok) throw new Error(`Object storage upload failed (HTTP ${res.status})`);
}
// Object deletion is the one operation a PAR cannot perform: OCI
// answers 404 to DELETE (and HEAD) on a write PAR — a PAR permits
// PUT only — and DeleteObject requires a signed API request. So when
// the signing settings are present (MEDIA_OCI_API_KEY_PEM + tenancy/
// user OCIDs + fingerprint + namespace + bucket), deletes go out as
// signed DeleteObject calls.
//
// PRODUCTION BUG (found 2026-11-17 by a live test): with the signing
// variables sourced from Vercel environment variables, deletes failed
// SILENTLY — the library item was removed, the API answered ok, and
// the object stayed in the bucket as an orphan. The old code only
// unescaped literal \n in the PEM, treated "any variable empty" as
// "unconfigured" (falling back to the no-op PAR delete), and swallowed
// every error. The rules below are the fix:
//   * The PEM is normalised (literal \n escapes, CRLF, missing final
//     newline, even a collapsed single-line body is re-wrapped) and
//     PARSED once at startup — an unparseable key is a configuration
//     error, reported loudly, never a silent fallback. The key may
//     alternatively be supplied base64-encoded as a single line
//     (auto-detected): dashboard pastes of the multi-line PEM have
//     arrived invisibly corrupted, so the single-line form is the
//     paste-proof way to enter it.
//   * If ANY signing variable is set, signed mode is intended: a
//     missing variable or bad key means deletes fail loudly (log +
//     caller-visible warning), never the PAR no-op.
//   * Only with NO signing variables at all does the best-effort PAR
//     delete remain (local/dev setups without signing configured).
//   * ociDeleteObject returns true only when the object is gone (or
//     already was); callers use it to report honestly.
function normalizeOciKeyPem(raw) {
  if (typeof raw !== 'string') return '';
  // Paste-proof transport form: the key may also be supplied
  // base64-encoded as ONE single line. Multi-line PEM values pasted
  // through dashboards have arrived invisibly corrupted in production
  // (armour intact, body characters altered, OpenSSL refuses to parse)
  // — a single-line base64 string has no newlines or special
  // characters to mangle. If the value with ALL whitespace stripped
  // is pure base64 that decodes to text containing PEM armour, decode
  // it and normalise the decoded PEM as usual. A raw PEM can never
  // match this test (its armour contains '-'), and a bare base64 key
  // body decodes to binary DER, not text with armour — both fall
  // through to the existing handling completely unchanged.
  const compact = raw.replace(/\s+/g, '');
  if (compact.length > 100 && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    try {
      const decoded = Buffer.from(compact, 'base64').toString('utf8');
      if (decoded.includes('-----BEGIN')) return normalizeOciKeyPem(decoded);
    } catch { /* not the transport form — fall through */ }
  }
  let s = raw.trim();
  if (!s) return '';
  if (s.includes('\\n')) s = s.replace(/\\n/g, '\n');
  if (s.includes('\\r')) s = s.replace(/\\r/g, '');
  s = s.replace(/\r\n?/g, '\n').trim();
  const begin = s.match(/-----BEGIN [^-]+-----/);
  const end = s.match(/-----END [^-]+-----/);
  if (begin && end && s.indexOf(end[0]) > s.indexOf(begin[0])) {
    const body = s.slice(s.indexOf(begin[0]) + begin[0].length, s.indexOf(end[0])).replace(/[^A-Za-z0-9+/=]/g, '');
    if (body) return `${begin[0]}\n${body.replace(/(.{64})/g, '$1\n').trim()}\n${end[0]}\n`;
    return s;
  }
  // No PEM armour survived (e.g. only the base64 body was pasted):
  // re-wrap it as a PKCS#8 private key.
  const body = s.replace(/[^A-Za-z0-9+/=]/g, '');
  if (body.length > 100) return `-----BEGIN PRIVATE KEY-----\n${body.replace(/(.{64})/g, '$1\n').trim()}\n-----END PRIVATE KEY-----\n`;
  return s;
}
const OCI_SIGN = {
  keyPem: normalizeOciKeyPem(process.env.MEDIA_OCI_API_KEY_PEM || ''),
  tenancy: (process.env.MEDIA_OCI_TENANCY_OCID || '').trim(),
  user: (process.env.MEDIA_OCI_USER_OCID || '').trim(),
  fingerprint: (process.env.MEDIA_OCI_FINGERPRINT || '').trim(),
  region: (process.env.MEDIA_OCI_REGION || 'ap-mumbai-1').trim(),
  namespace: (process.env.MEDIA_OCI_NAMESPACE || '').trim(),
  bucket: (process.env.MEDIA_OCI_BUCKET || '').trim(),
};
let ociKeyObject = null;
let ociKeyError = '';
if (OCI_SIGN.keyPem) {
  try { ociKeyObject = crypto.createPrivateKey(OCI_SIGN.keyPem); } catch (e) { ociKeyError = (e && e.message) || 'unparseable key'; }
}
const OCI_SIGN_ANY_SET = !!(OCI_SIGN.keyPem || OCI_SIGN.tenancy || OCI_SIGN.user || OCI_SIGN.fingerprint || OCI_SIGN.namespace || OCI_SIGN.bucket);
function ociSigningProblem() {
  if (!OCI_SIGN_ANY_SET) return '';
  const missing = [];
  if (!OCI_SIGN.keyPem) missing.push('MEDIA_OCI_API_KEY_PEM');
  if (!OCI_SIGN.tenancy) missing.push('MEDIA_OCI_TENANCY_OCID');
  if (!OCI_SIGN.user) missing.push('MEDIA_OCI_USER_OCID');
  if (!OCI_SIGN.fingerprint) missing.push('MEDIA_OCI_FINGERPRINT');
  if (!OCI_SIGN.namespace) missing.push('MEDIA_OCI_NAMESPACE');
  if (!OCI_SIGN.bucket) missing.push('MEDIA_OCI_BUCKET');
  if (missing.length) return `missing ${missing.join(', ')}`;
  if (!ociKeyObject) return `MEDIA_OCI_API_KEY_PEM could not be parsed (${ociKeyError || 'invalid key'})`;
  return '';
}
// 'signed' (ready), 'unconfigured' (nothing set — PAR fallback), or
// 'misconfigured' (partly set / bad key — fail loudly, never fall back).
function ociSigningState() {
  if (!OCI_SIGN_ANY_SET) return 'unconfigured';
  return ociSigningProblem() ? 'misconfigured' : 'signed';
}
if (ociSigningState() === 'misconfigured') {
  console.error(`[oci] Signing configuration is invalid: ${ociSigningProblem()}. OCI object deletes will fail loudly until this is fixed.`);
}
async function ociSignedDeleteObject(objectName) {
  const host = `objectstorage.${OCI_SIGN.region}.oraclecloud.com`;
  const target = `/n/${OCI_SIGN.namespace}/b/${OCI_SIGN.bucket}/o/${encodeURIComponent(objectName)}`;
  const date = new Date().toUTCString();
  const signingString = `(request-target): delete ${target}\nhost: ${host}\ndate: ${date}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingString);
  const signature = signer.sign(ociKeyObject, 'base64');
  const keyId = `${OCI_SIGN.tenancy}/${OCI_SIGN.user}/${OCI_SIGN.fingerprint}`;
  const res = await fetch(`https://${host}${target}`, {
    method: 'DELETE',
    headers: {
      date,
      host,
      authorization: `Signature version="1",keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`,
    },
  });
  // 204 = deleted; 404 = already gone — both are the desired end state.
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`Object storage delete failed (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
}
// Returns true when the object is gone afterwards, false when it could
// not be deleted. Failures are ALWAYS logged with their cause — a
// cleanup that silently leaves orphans in the bucket is how the
// production bug above hid.
async function ociDeleteObject(objectName) {
  const state = ociSigningState();
  if (state === 'signed') {
    try { await ociSignedDeleteObject(objectName); return true; } catch (e) {
      console.error(`[oci] Signed delete failed for object ${objectName}: ${(e && e.message) || e}`);
      return false;
    }
  }
  if (state === 'misconfigured') {
    console.error(`[oci] Delete of object ${objectName} not attempted: signing configuration is invalid (${ociSigningProblem()}).`);
    return false;
  }
  try {
    const res = await fetch(ociObjectUrl(OCI_WRITE_BASE, objectName), { method: 'DELETE' });
    return res.ok || res.status === 404;
  } catch { return false; }
}

// ---------- auth (email + password, scrypt hashes, signed cookie) ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
// Fixed salt used ONLY to spend the same scrypt time on a login whose
// email has no account, so the response timing cannot reveal whether
// an account exists for that email (a timing oracle).
const DUMMY_SALT = 'kiluaai-timing-equaliser';
function verifyPassword(password, user) {
  if (!user || !user.passwordHash || !user.salt) return false;
  const expected = Buffer.from(user.passwordHash, 'hex');
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}
// Common-password blocklist (audit L-01, 2026-11-22): the length-only
// policy (8–128) let through the exact passwords credential-stuffing
// lists try first. This is a focused exact-match list (compared
// lower-cased) of the most-guessed values, rejected at EVERY
// password-setting site — signup, change-password and reset — via
// isCommonPassword(). It is deliberately not a dictionary: length,
// the per-email login throttle and the per-IP auth limit carry the
// rest of the defence.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '123456', '1234567', '12345678', '123456789', '1234567890', '123456789a', '12345', '1234', '123123', '111111', '000000',
  'abc123', 'abcd1234', 'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty1', '1q2w3e4r', '1q2w3e', '1qaz2wsx', 'qazwsx', 'zxcvbnm',
  'letmein', 'iloveyou', 'admin', 'admin123', 'administrator', 'welcome', 'welcome123', 'login', 'user1234',
  'monkey', 'dragon', 'football', 'baseball', 'basketball', 'soccer', 'hockey', 'tennis123', 'cricket',
  'sunshine', 'master', 'shadow', 'ashley', 'michael', 'superman', 'batman', 'spiderman', 'starwars',
  'ninja', 'mustang', 'princess', 'charlie', 'thomas', 'jordan', 'hunter', 'hunter2', 'ranger', 'buster',
  'killer', 'george', 'trustno1', 'computer', 'internet', 'samsung', 'pokemon', 'naruto', 'lol12345',
  'secret', 'secret123', 'happy123', 'summer123', 'winter123', 'orange123', 'banana123', 'flower123',
  'india123', 'indian123', 'mumbai123', 'delhi123', 'google123', 'facebook1', 'instagram1', 'youtube123',
  'newpassword', 'newpassword123', 'changeme', 'changeme123', 'default1', 'testing123', 'testtest', 'abcd12345',
]);
function isCommonPassword(password) {
  return COMMON_PASSWORDS.has(String(password || '').toLowerCase());
}
const COMMON_PASSWORD_ERROR = 'That password is one of the most commonly guessed — choose a less obvious one.';
function publicUser(u) {
  if (!u) return null;
  const out = { id: u.id, email: u.email, role: u.role || 'member', createdAt: u.createdAt };
  if (u.name) out.name = u.name;
  // Plan summary (batch 2): the EFFECTIVE plan (comp grants, expiry
  // and the owner bypass already applied) so the client can label the
  // account honestly. Never the stored admin fields themselves.
  const eff = effectivePlanOf(u);
  out.plan = eff.id;
  out.planName = eff.name;
  if (u.comp || isOwnerCompEmail(u)) out.comp = true;
  if (u.planExpiresAt && eff.id !== 'free') out.planExpiresAt = u.planExpiresAt;
  return out;
}
// Owner-flagged payload for AUTH SUCCESS responses and /me — ONE
// shared helper (bug fix, 22 Nov 2026, owner-reported: after a fresh
// login the "Switch to Admin" button was missing until a full reload,
// because only /me added the flag while login/signup/Google returned
// plain publicUser and the client sets its user state directly from
// the auth response). Batch 6 (owner's final model): the flag and the
// console URL travel inside the owner's own auth responses and
// nowhere else — the slug is never a literal in the shipped client
// bundle (the Batch 2 secrecy invariant still holds; tests grep src +
// dist for it). Every other account's payload carries NEITHER field.
async function publicAuthUser(u) {
  const out = publicUser(u);
  if (!out) return out;
  const ownerId = await db.ownerId().catch(() => null);
  if (ownerId && u.id === ownerId) {
    out.isOwner = true;
    out.adminUrl = `/api/${ADMIN_SLUG}/console`;
  }
  return out;
}
function signSession(sessionId, userId) {
  const exp = Date.now() + SESSION_MAX_AGE_MS;
  const payload = `${sessionId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
async function verifySession(token) {
  try {
    if (!token || typeof token !== 'string') return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const [sessionId, userId, exp] = payload.split('.');
    if (!sessionId || !userId || !exp || Number(exp) < Date.now()) return null;
    // Logged-out sessions are rejected. A missing session record does NOT
    // reject (logins made while the DB was down still work from the cookie).
    try { if (await db.isSessionRevoked(sessionId)) return null; } catch { /* DB hiccup: trust the signed cookie */ }
    return { sessionId, userId };
  } catch { return null; }
}
function parseCookies(req) {
  const out = {};
  const header = req.headers && req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
async function getAuthUser(req) {
  const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (!verified) return null;
  return db.getUserById(verified.userId);
}
function isSecureRequest(req) {
  return process.env.NODE_ENV === 'production' || req.secure || req.get('x-forwarded-proto') === 'https';
}
async function setSessionCookie(req, res, userId) {
  const sessionId = uid('sess');
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_MS);
  try { await db.createSession({ id: sessionId, userId, expiresAt, revoked: false, createdAt: new Date().toISOString() }); } catch { /* login must not fail because the session ledger write failed */ }
  res.cookie(SESSION_COOKIE, signSession(sessionId, userId), {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: SESSION_MAX_AGE_MS,
  });
  return sessionId;
}
async function clearSessionCookie(req, res) {
  const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
  if (verified) { try { await db.revokeSession(verified.sessionId); } catch { /* cookie is cleared below regardless */ } }
  res.cookie(SESSION_COOKIE, '', {
    httpOnly: true, sameSite: 'lax', secure: isSecureRequest(req),
    path: '/', maxAge: 0,
  });
}
async function requireAuth(req, res, next) {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  req.user = publicUser(user);
  req.userId = user.id;
  return next();
}
// Gmail-alias cleanup gate: the first /api request in a process runs
// the guarded one-time cleanup (runGmailAliasCleanup) before any
// route answers; every later request reuses the settled promise.
app.use('/api', (req, res, next) => { ensureAliasCleanup().then(() => ensureTestBroadcastCleanup()).then(() => next(), () => next()); });
// Every /api/* route except /api/health, /api/db-status and /api/auth/*
// requires login.
app.use('/api', apiRateLimit, (req, res, next) => { if (req.path.startsWith('/auth/')) return authRateLimit(req, res, next); return next(); });
app.use('/api', ah(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/db-status' || req.path === '/version' || req.path === '/app-status' || req.path.startsWith('/auth/') || req.path.startsWith('/cron/') || req.path.startsWith(`/${ADMIN_SLUG}/`)) return next();
  // Make sure the database connection is up (no-op when already connected
  // or when no MONGODB_URI is set — JSON fallback is used then).
  await db.ensureMongo();
  // The Instagram OAuth connect + callback GETs authenticate themselves:
  // connect accepts the session cookie OR a signed one-time connect link
  // (?t=, minted by the logged-in app), and the callback's user is bound
  // into the HMAC-signed OAuth state. The browser that finishes a Meta
  // login — e.g. the system browser the Android app hands off to — has
  // no session cookie, so these two GETs must not require one; without
  // valid self-authentication they answer with a friendly HTML page.
  if (req.method === 'GET' && (req.path === '/instagram/connect' || req.path === '/instagram/callback' || req.path === '/instagram/ig-connect' || req.path === '/instagram/ig-callback' || req.path === '/youtube/connect' || req.path === '/youtube/callback')) return next();
  return requireAuth(req, res, next);
}));
// Team workspace gate (batch 3): runs AFTER auth, only when the caller
// sends an x-workspace-id header naming a workspace OWNER. The caller
// must hold an ACTIVE invite from that owner; the data scope then
// swaps to the owner's (req.userId becomes the owner id, the real
// caller stays in req.selfId) and the role gate below decides what
// the request may touch. Without a valid active invite the answer is
// a flat 403 — and because membership is re-checked on EVERY request,
// removing a member cuts their access on the very next call.
//   viewer    — reads only, and only the workspace allowlist.
//   scheduler — reads + the composer's write allowlist (create/edit/
//               reschedule/duplicate/publish/retry posts, upload
//               media, save templates/hashtag groups/drafts, AI
//               suggestions). Never deletes, never connections,
//               settings, plan, team management or account actions.
const WS_GET_ALLOW = [
  /^\/posts(\/.*)?$/, /^\/media$/, /^\/stats$/, /^\/my-stats$/,
  /^\/templates$/, /^\/hashtag-groups$/, /^\/drafts$/, /^\/next-best-time$/,
  /^\/team\/memberships$/, /^\/team\/context$/, /^\/auth\/me$/,
];
const WS_SCHEDULER_POST_ALLOW = [
  /^\/posts$/, /^\/posts\/preflight$/, /^\/posts\/bulk$/,
  /^\/posts\/[^/]+\/(reschedule|duplicate|publish|retry)$/,
  /^\/publish-due$/, /^\/media$/, /^\/media\/upload$/, /^\/media\/upload\/(init|chunk|complete)$/,
  /^\/templates$/, /^\/hashtag-groups$/, /^\/drafts$/, /^\/ai\/caption$/,
];
const WS_SCHEDULER_PATCH_ALLOW = [/^\/posts\/[^/]+$/];
app.use('/api', ah(async (req, res, next) => {
  if (!req.userId) return next(); // public/exempt path — auth gate already ran
  const ws = String(req.get('x-workspace-id') || '').trim();
  if (!ws || ws === req.userId) return next();
  const memberships = await db.listMemberships(req.userId).catch(() => []);
  const m = memberships.find((i) => i.ownerId === ws && i.status === 'active');
  if (!m) return res.status(403).json({ ok: false, error: 'You do not have access to that workspace. If you were invited, sign in with the invited email address.' });
  req.selfId = req.userId;
  req.selfEmail = (req.user && req.user.email) || '';
  req.userId = m.ownerId;
  req.teamRole = m.role;
  req.teamInviteId = m.id;
  const p = req.path;
  const deny = () => res.status(403).json({ ok: false, error: req.teamRole === 'viewer'
    ? 'You have view-only access to this workspace — you can look, but not change anything.'
    : 'Your role in this workspace does not allow that action.' });
  if (req.method === 'GET') {
    if (WS_GET_ALLOW.some((re) => re.test(p))) return next();
    return deny();
  }
  // Method-aware write gate: DELETE is never allowed in a workspace,
  // PATCH only for a post's own fields, POST only for the allowlist.
  if (req.teamRole === 'scheduler') {
    if (req.method === 'POST' && WS_SCHEDULER_POST_ALLOW.some((re) => re.test(p))) return next();
    if (req.method === 'PATCH' && WS_SCHEDULER_PATCH_ALLOW.some((re) => re.test(p))) return next();
  }
  return deny();
}));
// Maintenance gate (batch 6): when the owner flips maintenance mode
// on in the console, WRITE calls from ordinary users pause with a 503
// and the owner's message — reads keep working so users can see their
// data and the message, auth keeps working so they can log in and read
// it, and the app owner is never locked out of his own app. Cron and
// console paths are exempt (the publisher must not stall, and the
// owner needs the console to switch maintenance back off).
app.use('/api', ah(async (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const p = req.path;
  if (p.startsWith('/auth/') || p.startsWith('/cron/') || p.startsWith(`/${ADMIN_SLUG}/`)
    || p === '/health' || p === '/db-status' || p === '/version' || p === '/app-status') return next();
  if (!req.userId) return next(); // public/exempt path — the auth gate already answered
  const gs = await globalSettings();
  if (!gs.maintenance) return next();
  const owner = await db.ownerId().catch(() => null);
  if (owner && (req.selfId || req.userId) === owner) return next();
  return res.status(503).json({
    ok: false, maintenance: true,
    error: String(gs.maintenanceMessage || '').trim() || MAINTENANCE_FALLBACK_MSG,
  });
}));

function validEmail(email) { return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()); }

// ---------- canonical email identity (Gmail-alias normalization) ----------
// Gmail and googlemail.com are the same service, and it ignores dots
// in the local part and delivers +suffix aliases to the same inbox —
// so one person can present ONE inbox as many different addresses
// (the classic free-trial / multi-account abuse). Identity matching
// therefore canonicalizes: lowercase + trim for every domain; for
// gmail.com / googlemail.com ONLY, strip the local part's dots, drop
// any +suffix, and map googlemail.com -> gmail.com. Every other
// domain keeps its dots and suffixes (they are significant there).
// This is used for identity matching and storage at signup — never
// for the MAIL_FROM / sender configuration.
const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
function canonicalEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at <= 0) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf('+');
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return `${local}@${domain}`;
}
// Resolve the account an email address belongs to, in identity order:
// (1) the canonical form (what new signups store), (2) the exact
// typed form (pre-existing accounts stored before canonicalization),
// (3) a legacy sweep — any stored address that canonicalizes to the
// same identity. The fallbacks guarantee no pre-existing account is
// ever locked out by the normalization.
async function findUserForEmail(raw) {
  const typed = String(raw || '').trim().toLowerCase();
  const canon = canonicalEmail(typed);
  let user = await db.getUserByEmail(canon);
  if (user) return user;
  if (typed !== canon) {
    user = await db.getUserByEmail(typed);
    if (user) return user;
  }
  const users = await db.listUsers();
  return users.find((u) => canonicalEmail(u.email) === canon) || null;
}

// Simple login throttle: 10 failed attempts per email in 10 minutes, then
// a plain 429. In-memory per container — best-effort on serverless.
const loginAttempts = new Map();
function loginBlocked(email) {
  const rec = loginAttempts.get(email);
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { loginAttempts.delete(email); return false; }
  return rec.count >= 10;
}
function recordFailedLogin(email) {
  const rec = loginAttempts.get(email) || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  loginAttempts.set(email, rec);
}

app.post('/api/auth/signup', ah(async (req, res) => {
  const typedEmail = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  // Optional display name from the sign-up form (used only for the
  // greeting). Plain text, length-capped; never required.
  const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
  if (typedEmail.length > 254) return res.status(400).json({ ok: false, error: 'That email address is too long — enter a valid email address.' });
  if (!validEmail(typedEmail)) return res.status(400).json({ ok: false, error: 'Enter a valid email address, like you@example.com.' });
  // The stored address is the CANONICAL identity (Gmail dots/+aliases
  // collapse to the one inbox), so the same inbox can never register
  // twice under different spellings.
  const email = canonicalEmail(typedEmail);
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address, like you@example.com.' });
  if (password.length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters long.' });
  if (password.length > 128) return res.status(400).json({ ok: false, error: 'Password must be at most 128 characters long.' });
  if (isCommonPassword(password)) return res.status(400).json({ ok: false, error: COMMON_PASSWORD_ERROR });
  const users = await db.listUsers();
  // Owner console toggle (batch 6): signups can be paused globally.
  // The very first account (the owner bootstrap) is never blocked —
  // a fresh install must always be able to create its owner.
  if (users.length > 0) {
    const gs = await globalSettings();
    if (gs.signupOpen === false) return res.status(403).json({ ok: false, error: 'Signups are paused right now — please try again later.' });
  }
  // Generic wording on purpose: the response must not confirm whether
  // this exact email is the one that is already registered.
  if (users.some((u) => canonicalEmail(u.email) === email)) return res.status(409).json({ ok: false, error: 'We could not create an account with those details. If you already have an account, log in instead.' });
  const salt = crypto.randomBytes(16).toString('hex');
  // Referral (Phase D11): every account gets a short invite code; a
  // signup that arrives with ?ref=<code> records who invited them.
  // An unknown code is ignored — never an error.
  let referralCode = '';
  do { referralCode = 'K' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }
  while (users.some((u) => u.referralCode === referralCode));
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim().toUpperCase().slice(0, 16) : '';
  const referredBy = ref && users.some((u) => u.referralCode === ref) ? ref : '';
  const user = {
    id: uid('user'), email, salt,
    passwordHash: hashPassword(password, salt),
    role: users.length === 0 ? 'owner' : 'member',
    createdAt: new Date().toISOString(),
    referralCode,
    ...(referredBy ? { referredBy } : {}),
    ...(name ? { name } : {}),
  };
  await db.saveUser(user);
  const granted = await applyOwnerComp(user);
  await bindTeamInvites(user).catch(() => null);
  await setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: await publicAuthUser(granted || user) });
}));
app.post('/api/auth/login', ah(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!validEmail(email) || !password) return res.status(400).json({ ok: false, error: 'Enter your email and password.' });
  // The throttle is keyed by the canonical identity too, so respelling
  // a Gmail address with dots/+aliases cannot dodge the attempt limit.
  const throttleKey = canonicalEmail(email);
  if (loginBlocked(throttleKey)) return res.status(429).json({ ok: false, error: 'Too many wrong attempts — wait 10 minutes and try again.' });
  const user = await findUserForEmail(email);
  if (!user) {
    // No account for this email: still spend the same scrypt time a
    // real password check costs, so the response time does not reveal
    // that the account does not exist. The error body is identical.
    try { hashPassword(password, DUMMY_SALT); } catch { /* timing equalisation only */ }
    recordFailedLogin(throttleKey);
    return res.status(401).json({ ok: false, error: 'Wrong email or password. Check both and try again — or sign up if you have no account yet.' });
  }
  if (!verifyPassword(password, user)) {
    recordFailedLogin(throttleKey);
    return res.status(401).json({ ok: false, error: 'Wrong email or password. Check both and try again — or sign up if you have no account yet.' });
  }
  loginAttempts.delete(throttleKey);
  const granted = await applyOwnerComp(user);
  await bindTeamInvites(user).catch(() => null);
  await setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: await publicAuthUser(granted || user) });
}));
// ---------- Sign in with Google (ID-token flow — NO client secret) ----------
// The client ID is a PUBLIC identifier (it ships in the login page).
// The browser hands us Google's signed ID token; the server verifies
// it against Google's tokeninfo endpoint on EVERY call and requires
// the audience (this app), the issuer (Google), a future expiry and
// a VERIFIED email before any session is issued. The env overrides
// exist so the test suite can point verification at a local stub.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '628297569656-dc5stqkpmdogk64e396paagapciai7vj.apps.googleusercontent.com';
const GOOGLE_TOKENINFO_URL = process.env.GOOGLE_TOKENINFO_URL || 'https://oauth2.googleapis.com/tokeninfo';
async function fetchGoogleClaims(idToken) {
  const r = await fetch(`${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(idToken)}`, { signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}
const GOOGLE_FAIL = 'Google sign-in could not be verified — try again, or use your email and password.';
// Shared core of BOTH Google sign-in flows (the web session below and
// the in-app browser-code flow further down): verifies the ID token
// and resolves it to an account — an existing one, or a newly created
// one under the same gates as password signup. Returns { user } on
// success or { fail: { status, body } } carrying the EXACT responses
// the web flow has always given, so neither flow can drift apart.
async function resolveGoogleAccount(req) {
  const fail = (status, body) => ({ fail: { status, body } });
  const idToken = typeof req.body?.idToken === 'string' ? req.body.idToken : '';
  if (!idToken || idToken.length > 4096) return fail(401, { ok: false, error: GOOGLE_FAIL });
  let claims = null;
  try { claims = await fetchGoogleClaims(idToken); } catch { claims = null; }
  const claimEmail = claims && typeof claims.email === 'string' ? claims.email : '';
  if (!claims || !validEmail(claimEmail)) return fail(401, { ok: false, error: GOOGLE_FAIL });
  // The same per-email throttle as password login, keyed by the
  // canonical identity, so a locked-out address cannot be retried
  // through Google under a different Gmail spelling.
  const throttleKey = canonicalEmail(claimEmail);
  if (loginBlocked(throttleKey)) return fail(429, { ok: false, error: 'Too many wrong attempts — wait 10 minutes and try again.' });
  const issOk = claims.iss === 'accounts.google.com' || claims.iss === 'https://accounts.google.com';
  const expOk = Number.isFinite(Number(claims.exp)) && Number(claims.exp) * 1000 > Date.now();
  const verifiedOk = claims.email_verified === true || claims.email_verified === 'true';
  if (claims.aud !== GOOGLE_CLIENT_ID || !issOk || !expOk || !verifiedOk) {
    recordFailedLogin(throttleKey);
    return fail(401, { ok: false, error: GOOGLE_FAIL });
  }
  loginAttempts.delete(throttleKey);
  // An existing account (any spelling of the one inbox) gets the same
  // session a password login issues. This stays available while
  // signups are paused or maintenance is on — exactly like password
  // login, which the maintenance gate also exempts.
  const existing = await findUserForEmail(claimEmail);
  if (existing) {
    const granted = await applyOwnerComp(existing);
    await bindTeamInvites(existing).catch(() => null);
    return { user: granted || existing };
  }
  // A NEW account faces the same creation gates as password signup:
  // signups paused or maintenance mode refuse CREATION only. The very
  // first account (owner bootstrap) is never blocked.
  const users = await db.listUsers();
  if (users.length > 0) {
    const gs = await globalSettings();
    if (gs.signupOpen === false) return fail(403, { ok: false, error: 'Signups are paused right now — please try again later.' });
    if (gs.maintenance) return fail(503, { ok: false, maintenance: true, error: String(gs.maintenanceMessage || '').trim() || MAINTENANCE_FALLBACK_MSG });
  }
  const email = canonicalEmail(claimEmail);
  const name = typeof claims.name === 'string' ? claims.name.trim().slice(0, 80) : '';
  let referralCode = '';
  do { referralCode = 'K' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }
  while (users.some((u) => u.referralCode === referralCode));
  const ref = typeof req.body?.ref === 'string' ? req.body.ref.trim().toUpperCase().slice(0, 16) : '';
  const referredBy = ref && users.some((u) => u.referralCode === ref) ? ref : '';
  // Passwordless account: no salt / passwordHash are stored, so
  // password login answers the standard wrong-password error (never a
  // crash), and the user can set a password later via forgot-password.
  const user = {
    id: uid('user'), email,
    role: users.length === 0 ? 'owner' : 'member',
    createdAt: new Date().toISOString(),
    referralCode,
    ...(referredBy ? { referredBy } : {}),
    ...(name ? { name } : {}),
  };
  await db.saveUser(user);
  const granted = await applyOwnerComp(user);
  await bindTeamInvites(user).catch(() => null);
  return { user: granted || user };
}
app.post('/api/auth/google', ah(async (req, res) => {
  const r = await resolveGoogleAccount(req);
  if (r.fail) return res.status(r.fail.status).json(r.fail.body);
  await setSessionCookie(req, res, r.user.id);
  res.json({ ok: true, user: await publicAuthUser(r.user) });
}));
// ---------- In-app Google sign-in (system-browser flow) ----------
// Google refuses its sign-in inside embedded WebViews, so the Android
// app opens /app-start.html in the SYSTEM BROWSER; that page runs the
// normal GIS flow there and posts the ID token to the app-code route.
// Instead of a session (that browser is not the app), the route
// issues a one-time return code: 192-bit random, only its SHA-256
// hash stored, 5-minute life, single-use, one live code per account,
// bound to nothing beyond the account it signs in. The browser then
// lands on the https return page (/app-return.html?code=...) — the
// URL the next APK claims as an app link (v1.3.6) — and the app
// exchanges the code at /api/auth/app-exchange for the normal session
// cookie inside the WebView, with the same payload as a login.
const APP_CODE_TTL_MS = 5 * 60 * 1000;
app.post('/api/auth/google/app-code', ah(async (req, res) => {
  const r = await resolveGoogleAccount(req);
  if (r.fail) return res.status(r.fail.status).json(r.fail.body);
  const code = crypto.randomBytes(24).toString('base64url');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex');
  await db.deleteAppCodesForUser(r.user.id);
  await db.createAppCode({
    id: uid('appcode'), userId: r.user.id, codeHash,
    expiresAt: new Date(Date.now() + APP_CODE_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  res.json({ ok: true, returnUrl: `/app-return.html?code=${encodeURIComponent(code)}` });
}));
app.post('/api/auth/app-exchange', ah(async (req, res) => {
  const EXCHANGE_FAIL = 'That app sign-in code has expired or already been used — open the app and try Google sign-in again.';
  // Throttled like login (one shared failure bucket, the same shape
  // as the console PIN gate): with a 192-bit code, guessing is
  // hopeless anyway — the bucket only stops scripted abuse.
  if (loginBlocked('app-exchange')) return res.status(429).json({ ok: false, error: 'Too many wrong attempts — wait 10 minutes and try again.' });
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  const codeHash = code ? crypto.createHash('sha256').update(code).digest('hex') : '';
  const doc = codeHash ? await db.getAppCodeByHash(codeHash).catch(() => null) : null;
  if (!doc || !(Date.parse(doc.expiresAt || '') > Date.now())) {
    recordFailedLogin('app-exchange');
    return res.status(401).json({ ok: false, error: EXCHANGE_FAIL });
  }
  // Consume FIRST: the code can never be replayed, even if anything
  // below were to fail.
  await db.deleteAppCodeByHash(codeHash);
  const user = await db.getUserById(doc.userId).catch(() => null);
  if (!user) {
    recordFailedLogin('app-exchange');
    return res.status(401).json({ ok: false, error: EXCHANGE_FAIL });
  }
  loginAttempts.delete('app-exchange');
  const granted = await applyOwnerComp(user);
  await setSessionCookie(req, res, user.id);
  res.json({ ok: true, user: await publicAuthUser(granted || user) });
}));
app.get('/api/auth/me', ah(async (req, res) => {
  const user = await applyOwnerComp(await getAuthUser(req));
  if (!user) return res.status(401).json({ ok: false, error: 'Not logged in. Please log in again.' });
  await bindTeamInvites(user).catch(() => null);
  // The owner flag + console URL come from the one shared helper
  // (see publicAuthUser) so /me and every auth success response agree.
  const out = await publicAuthUser(user);
  res.json({ ok: true, user: out });
}));
app.post('/api/auth/logout', ah(async (req, res) => {
  await clearSessionCookie(req, res);
  res.json({ ok: true });
}));
// Change password: the old password must be correct, the new one must be
// 8–128 chars. All other sessions are revoked — a password change logs
// every other device out.
app.post('/api/auth/change-password', ah(async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const current = String(req.body?.currentPassword || '');
  const next = String(req.body?.newPassword || '');
  if (!verifyPassword(current, user)) return res.status(401).json({ ok: false, error: 'Your current password is not right — check it and try again.' });
  if (next.length < 8) return res.status(400).json({ ok: false, error: 'The new password must be at least 8 characters long.' });
  if (next.length > 128) return res.status(400).json({ ok: false, error: 'The new password must be at most 128 characters long.' });
  if (isCommonPassword(next)) return res.status(400).json({ ok: false, error: COMMON_PASSWORD_ERROR });
  if (next === current) return res.status(400).json({ ok: false, error: 'The new password is the same as the old one — pick a different one.' });
  const salt = crypto.randomBytes(16).toString('hex');
  await db.updateUser(user.id, { salt, passwordHash: hashPassword(next, salt) });
  // Revoke every session except the one making this request.
  try {
    const verified = await verifySession(parseCookies(req)[SESSION_COOKIE]);
    if (verified) {
      const sessions = await db.listSessions();
      for (const s of sessions) {
        if (s.userId === user.id && s.id !== verified.sessionId) await db.revokeSession(s.id);
      }
    }
  } catch { /* password already changed; session cleanup is best-effort */ }
  res.json({ ok: true });
}));
// Delete my account: removes the user and everything that belongs to them
// (posts, media, templates, settings, Instagram connection, import jobs,
// sessions). If the deleted user was the owner, the oldest remaining user
// becomes the owner so the app is never ownerless.
app.delete('/api/auth/account', ah(async (req, res) => {
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const wasOwner = user.role === 'owner';
  await clearSessionCookie(req, res);
  await db.deleteUserData(user.id);
  if (wasOwner) {
    const remaining = await db.listUsers();
    if (remaining.length) await db.updateUser(remaining[0].id, { role: 'owner' });
  }
  res.json({ ok: true });
}));

// ---------- transactional email (password resets + team invites) ----------
// The app sends exactly two kinds of email: the password-reset link
// and the team-invite notice (batch 6). Sender is configured purely by
// env: SMTP_HOST, SMTP_PORT (465 = implicit TLS; anything else starts
// plain and upgrades via STARTTLS when the server offers it),
// SMTP_USER, SMTP_PASS, MAIL_FROM. No new dependency — the client
// below is a minimal SMTP speaker over net/tls.
// MAIL_FROM may be a bare address (goyaldhiman00@gmail.com) or the
// display form (KiluaAI <goyaldhiman00@gmail.com>) — mailFromParts()
// splits it so the SMTP envelope always carries the bare address.
// When NO sender is configured the flows still work end to end
// (reset token created, /reset page functional, invite recorded); in
// non-production the reset link is written to the SERVER LOG ONLY so
// local development can complete the flow, and in production a
// sender-less request is logged without the link. A send is never
// faked: the reset API answers the same generic response either way,
// exactly like an unknown email does, and the invite API reports
// honestly whether the email went out (emailed: true/false).
const SMTP_CONF = {
  host: (process.env.SMTP_HOST || '').trim(),
  port: Number(process.env.SMTP_PORT || 0) || 587,
  user: (process.env.SMTP_USER || '').trim(),
  pass: process.env.SMTP_PASS || '',
  from: (process.env.MAIL_FROM || '').trim(),
};
function mailFromParts() {
  const raw = SMTP_CONF.from;
  const m = /^(.*?)<([^<>]+)>$/.exec(raw);
  if (m) return { address: m[2].trim(), header: raw };
  return { address: raw, header: `KiluaAI <${raw}>` };
}
function mailerConfigured() { return !!(SMTP_CONF.host && SMTP_CONF.user && SMTP_CONF.pass && mailFromParts().address); }

function smtpSend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { try { socket.destroy(); } catch { /* already gone */ } reject(new Error('Email server took too long to answer.')); }, 20000);
    let socket = null;
    let buffer = '';
    let waiters = [];
    const fail = (e) => { clearTimeout(timeout); try { socket && socket.destroy(); } catch { /* ignore */ } reject(e); };
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // SMTP replies end with "<code> " (continuations use "<code>-").
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        const m = /^(\d{3})([ -])/.exec(line);
        if (!m || !waiters.length) continue;
        const w = waiters[0];
        w.all = w.all ? `${w.all}\n${line}` : line;
        if (m[2] === ' ') {
          waiters.shift();
          w.done(Number(m[1]), w.all);
        }
      }
    };
    const expect = (codes) => new Promise((res2, rej2) => {
      waiters.push({
        all: '',
        done: (code, all) => {
          if (codes.includes(code)) res2(all);
          else rej2(new Error(`Email server answered ${code}: ${String(all).split('\n').pop().slice(0, 120)}`));
        },
      });
    });
    const send = (line) => socket.write(line + '\r\n');
    const connect = () => {
      socket.on('data', onData);
      socket.on('error', fail);
      (async () => {
        await expect([220]);
        send(`EHLO kiluaai.app`);
        let ehlo = await expect([250]);
        if (SMTP_CONF.port !== 465 && /STARTTLS/i.test(ehlo)) {
          send('STARTTLS');
          await expect([220]);
          const upgraded = tls.connect({ socket, servername: SMTP_CONF.host });
          await new Promise((res2, rej2) => { upgraded.once('secureConnect', res2); upgraded.once('error', rej2); });
          socket = upgraded;
          socket.on('data', onData);
          socket.on('error', fail);
          send(`EHLO kiluaai.app`);
          ehlo = await expect([250]);
        }
        send('AUTH LOGIN');
        await expect([334]);
        send(Buffer.from(SMTP_CONF.user, 'utf8').toString('base64'));
        await expect([334]);
        send(Buffer.from(SMTP_CONF.pass, 'utf8').toString('base64'));
        await expect([235]);
        send(`MAIL FROM:<${mailFromParts().address}>`);
        await expect([250]);
        send(`RCPT TO:<${to}>`);
        await expect([250, 251]);
        send('DATA');
        await expect([354]);
        const headers = [
          `From: ${mailFromParts().header}`,
          `To: <${to}>`,
          `Subject: ${subject}`,
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=utf-8',
          '',
        ].join('\r\n');
        socket.write(headers + String(text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..') + '\r\n.\r\n');
        await expect([250]);
        send('QUIT');
        clearTimeout(timeout);
        try { socket.end(); } catch { /* done */ }
        resolve(true);
      })().catch(fail);
    };
    try {
      socket = SMTP_CONF.port === 465
        ? tls.connect({ host: SMTP_CONF.host, port: SMTP_CONF.port, servername: SMTP_CONF.host }, connect)
        : net.connect({ host: SMTP_CONF.host, port: SMTP_CONF.port }, connect);
      socket.on('error', fail);
    } catch (e) { fail(e); }
  });
}

async function sendPasswordResetEmail(user, link) {
  if (!mailerConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      // Dev-only escape hatch: the link exists so the flow can be
      // completed locally, but it reaches the server log ONLY — never
      // an API response, never another user.
      console.log(`[password-reset] No email sender configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM). Reset link for ${user.email}: ${link}`);
    } else {
      console.log('[password-reset] A reset was requested but no email sender is configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM) — nothing was sent.');
    }
    return false;
  }
  try {
    await smtpSend({
      to: user.email,
      subject: 'Reset your KiluaAI password',
      text: [
        'Hello,',
        '',
        'Someone asked to reset the password for this KiluaAI account.',
        'Open this link within 60 minutes to choose a new password:',
        '',
        link,
        '',
        'The link works once. If you did not ask for this, ignore this email — your password stays the same.',
        '',
        '— KiluaAI',
      ].join('\n'),
    });
    return true;
  } catch (e) {
    console.error('[password-reset] Send failed:', String((e && e.message) || e).slice(0, 200));
    return false;
  }
}

// Team-invite email (batch 6): tells the invited address who invited
// them, what their role lets them do, and where to sign in. The invite
// carries no secret link — access binds to the ACCOUNT with this
// email when it signs up / logs in — so the message is safe to log in
// development. Never throws: a mail failure must not fail the invite
// itself; the caller reports the honest `emailed` flag either way.
async function sendTeamInviteEmail(owner, invite, baseUrl) {
  if (!mailerConfigured()) {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[team-invite] No email sender configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM). Invite for ${invite.email} was recorded but not emailed.`);
    } else {
      console.log('[team-invite] An invite was recorded but no email sender is configured (set SMTP_HOST, SMTP_USER, SMTP_PASS, MAIL_FROM) — nothing was sent.');
    }
    return false;
  }
  const roleLine = invite.role === 'scheduler'
    ? 'As a Scheduler you can create and schedule posts in their workspace. You cannot change their connections, settings or plan.'
    : 'As a Viewer you can look at their workspace — posts, queue and stats — but not change anything.';
  try {
    await smtpSend({
      to: invite.email,
      subject: 'You are invited to a KiluaAI team',
      text: [
        'Hello,',
        '',
        `${owner.name || owner.email} (${owner.email}) has invited you to join their team on KiluaAI, the Instagram + YouTube scheduler.`,
        '',
        roleLine,
        '',
        'To accept, open KiluaAI and sign up or log in with THIS email address — your access starts right away, no invite link needed:',
        '',
        baseUrl,
        '',
        'If you were not expecting this invitation, you can ignore this email.',
        '',
        '— KiluaAI',
      ].join('\n'),
    });
    return true;
  } catch (e) {
    console.error('[team-invite] Send failed:', String((e && e.message) || e).slice(0, 200));
    return false;
  }
}

// ---------- forgot / reset password ----------
// POST /api/auth/forgot ALWAYS answers the same generic success —
// whether the email has an account, whether a link was sent, whether
// the per-account throttle (3 links/hour) tripped. Nothing in the
// response can be used to probe which emails are registered.
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;
app.post('/api/auth/forgot', ah(async (req, res) => {
  const generic = { ok: true, message: 'If an account exists for that email, a password reset link is on its way.' };
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!validEmail(email) || email.length > 254) return res.json(generic);
  const user = await findUserForEmail(email);
  if (!user) {
    try { hashPassword('timing', DUMMY_SALT); } catch { /* timing equalisation only */ }
    return res.json(generic);
  }
  const recent = (await db.listPasswordResetsForUser(user.id))
    .filter((r) => r.createdAt && Date.now() - new Date(r.createdAt).getTime() < 3600000);
  if (recent.length >= 3) return res.json(generic);
  const raw = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await db.createPasswordReset({
    id: uid('rst'), userId: user.id, tokenHash,
    expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS).toISOString(),
    createdAt: new Date().toISOString(),
  });
  const link = `${publicBase(req)}/reset?token=${encodeURIComponent(raw)}`;
  await sendPasswordResetEmail(user, link);
  return res.json(generic);
}));
// POST /api/auth/reset { token, newPassword }: validates the token
// (hashed lookup, unused because a successful reset deletes every
// outstanding token for the user, unexpired), sets a fresh scrypt
// hash, and revokes ALL of the user's sessions — a reset logs every
// device out, exactly like a password change.
app.post('/api/auth/reset', ah(async (req, res) => {
  const invalid = () => res.status(400).json({ ok: false, error: 'That reset link is not valid or has expired — request a new one from the login screen.' });
  const token = String(req.body?.token || '');
  const next = String(req.body?.newPassword || '');
  if (!token || token.length > 200) return invalid();
  if (next.length < 8) return res.status(400).json({ ok: false, error: 'The new password must be at least 8 characters long.' });
  if (next.length > 128) return res.status(400).json({ ok: false, error: 'The new password must be at most 128 characters long.' });
  if (isCommonPassword(next)) return res.status(400).json({ ok: false, error: COMMON_PASSWORD_ERROR });
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const rec = await db.getPasswordResetByHash(tokenHash);
  if (!rec || !rec.expiresAt || new Date(rec.expiresAt).getTime() < Date.now()) return invalid();
  const user = await db.getUserById(rec.userId);
  if (!user) return invalid();
  const salt = crypto.randomBytes(16).toString('hex');
  await db.updateUser(user.id, { salt, passwordHash: hashPassword(next, salt) });
  await db.deletePasswordResetsForUser(user.id);
  try {
    const sessions = await db.listSessions();
    for (const s of sessions) if (s.userId === user.id) await db.revokeSession(s.id);
  } catch { /* password already reset; session cleanup is best-effort */ }
  res.json({ ok: true });
}));

// ---------- per-user data helpers ----------
// Internal uses (stats, publish-due, next-best-time) need the full list,
// not the paginated API page.
async function getPosts(req) { return db.listPosts(req.userId, { all: true }); }
async function getMedia(req) { return db.listMedia(req.userId, { all: true }); }
function getTemplates(req) { return db.listTemplates(req.userId); }
async function getSettings(req) {
  const s = await db.getSettings(req.userId);
  return { instagramHandle: s.instagramHandle || '', ...s };
}
// Instagram credentials: the token from the Connect Instagram login is stored server-side
// (encrypted in MongoDB) and takes priority; env vars are the fallback.
// The full token is never sent to the frontend — only a masked form.
// Accepts either a req-like object ({ userId }) or a bare userId string
// (used by the cron publisher, which has no request user).
function uidOf(x) { return typeof x === 'string' ? x : (x && x.userId) || ''; }
async function getInstagramStored(x, igUserId) {
  const userId = uidOf(x);
  if (!userId) return {};
  if (igUserId) {
    const s = await db.getInstagramAccount(userId, igUserId);
    return s && typeof s === 'object' ? s : {};
  }
  const s = await db.getInstagram(userId);
  return s && typeof s === 'object' ? s : {};
}
// The user's connected Instagram accounts, as safe summary objects for
// API responses (no tokens): everything the Settings list and the post
// composer's account selector need.
async function instagramAccountSummaries(userId) {
  const { accounts, defaultIgUserId } = await db.getInstagramAccounts(userId);
  return {
    defaultIgUserId: defaultIgUserId || '',
    accounts: accounts.map((a) => ({
      igUserId: a.igUserId || '',
      username: a.username || '',
      isDefault: !!defaultIgUserId && String(a.igUserId || '') === String(defaultIgUserId),
      connectedAt: a.connectedAt || '',
      profile: a.profile || null,
      health: instagramHealth(a),
    })),
  };
}
// Which Graph host serves a stored connection: Instagram Login tokens
// live on graph.instagram.com (unversioned paths); Facebook Login
// tokens live on graph.facebook.com (versioned paths). Records with no
// host recorded (legacy rows, env-var tokens) are Facebook-host, as
// they always were. Every Graph call that operates on a stored
// connection must build its URL from this helper.
function graphApiBase(tokenHost) {
  return tokenHost === 'instagram' ? 'https://graph.instagram.com' : 'https://graph.facebook.com/' + GRAPH_API_VERSION;
}
async function getInstagramCreds(x) {
  const userId = uidOf(x);
  const stored = await getInstagramStored(userId);
  // The INSTAGRAM_ACCESS_TOKEN / IG_USER_ID env vars are the OWNER's
  // last-resort connection (see the header note). They must apply ONLY
  // to the owner's own account: handing them to every signed-in user
  // would let any signup publish to the owner's Instagram.
  let envToken = '';
  let envIgUserId = '';
  if (process.env.INSTAGRAM_ACCESS_TOKEN || process.env.IG_USER_ID) {
    let isOwner = false;
    try { const owner = await db.ownerId(); isOwner = !!userId && !!owner && userId === owner; } catch { /* no owner resolvable: no env fallback */ }
    if (isOwner) {
      envToken = process.env.INSTAGRAM_ACCESS_TOKEN || '';
      envIgUserId = process.env.IG_USER_ID || '';
    }
  }
  const token = stored.token || envToken;
  const igUserId = stored.igUserId || envIgUserId;
  return { token, igUserId, username: stored.username || '', tokenHost: stored.tokenHost || '', pageId: stored.pageId || '', source: stored.token ? 'stored' : (envToken ? 'env' : 'none') };
}
function maskToken(t) {
  if (!t) return '';
  if (t.length <= 8) return '••••••••';
  return t.slice(0, 4) + '…' + t.slice(-4);
}
// Creds for ONE specific connected account of the user (no env
// fallback — the env token belongs to the default/legacy connection
// only). Returns null when that account is not connected.
async function getInstagramCredsForAccount(userId, igUserId) {
  const stored = await getInstagramStored(userId, igUserId);
  if (!stored || !stored.token || !stored.igUserId) return null;
  return { token: stored.token, igUserId: stored.igUserId, username: stored.username || '', tokenHost: stored.tokenHost || '', pageId: stored.pageId || '', source: 'stored' };
}
// Which connection publishes this post? A post that names a target
// account publishes with THAT account's token — and if the account
// has since been disconnected, the publish must fail loudly (the
// caller marks it failed with a notification); it must NEVER fall
// back to a different account and post to the wrong profile. A post
// with no target (everything scheduled before multi-account support)
// publishes via the default/legacy connection, exactly as before.
async function resolvePublishCreds(userId, post) {
  const target = post && post.igAccountId ? String(post.igAccountId) : '';
  if (!target) {
    const ig = await getInstagramCreds(userId);
    return { ig };
  }
  const ig = await getInstagramCredsForAccount(userId, target);
  if (ig) return { ig };
  return { missing: true, igAccountId: target, username: (post && post.igAccountUsername) || '' };
}
function missingAccountError(missing) {
  const who = missing.username ? `@${missing.username}` : 'the Instagram account';
  return `This post was scheduled for ${who}, which is no longer connected. Reconnect it in Settings, or edit the post to choose a connected account — it was NOT posted to a different account.`;
}
async function igConfigured(req) { const c = await getInstagramCreds(req); return !!(c.token && c.igUserId); }

// ---------- Instagram token keeper (self-renewing connection) ----------
// One login, unlimited use: the server watches the stored token's real
// expiry (Meta's debug_token) and renews it BEFORE it expires, so the
// user never has to reconnect on a schedule again.
// Renewal paths, tried in order:
//   1. Instagram Login tokens — GET graph.instagram.com/refresh_access_token
//      (grant_type=ig_refresh_token). Needs no app secret.
//   2. Facebook Login tokens — GET /oauth/access_token
//      (grant_type=fb_exchange_token). Needs META_APP_SECRET in env.
// A reconnect is only needed when Meta has actually revoked the token
// (password change, access removed in Meta settings, security check) —
// debug_token then reports is_valid=false and health.needsReconnect is set.
// The token value itself is never logged or returned anywhere here.
const META_APP_ID = process.env.META_APP_ID || '1671693167666941';
// The Meta app secret has exactly ONE source — this accessor, reading
// the META_APP_SECRET env var at call time. db-status, both OAuth
// callbacks and the token keeper all go through it, so they can never
// disagree about whether the secret is configured. (A module-load
// snapshot is how the keeper once kept reporting "META_APP_SECRET not
// set" — and, via the sticky throttle below, never retried — long
// after the secret had been set in Vercel and db-status said so.)
function metaAppSecret() { return process.env.META_APP_SECRET || ''; }
const TOKEN_REFRESH_WINDOW_DAYS = 10;
// "Connect Instagram" (Facebook Login for Business / Unified Login): the
// user approves access in Meta's own dialog — no token pasting — and the
// callback exchanges the returned code for a long-lived token that the
// keeper above then renews automatically. The config ID and app ID are
// public identifiers (they appear in the dialog URL); the app secret
// stays in env only. The redirect URI must match the one configured in
// the Meta app dashboard EXACTLY.
const GRAPH_API_VERSION = 'v27.0';
const META_LOGIN_CONFIG_ID = process.env.META_LOGIN_CONFIG_ID || '2385364258963804';
const META_OAUTH_REDIRECT_URI = process.env.META_OAUTH_REDIRECT_URI || 'https://social-scheduler-one-sandy.vercel.app/api/instagram/callback';
// "Instagram API with Unified Login" (the primary "Connect Instagram"
// flow, /api/instagram/ig-connect): Meta no longer offers "API setup
// with Instagram login" to newer apps — this app has no Instagram
// platform app of its own, so the old instagram.com/oauth/authorize
// dialog answered "Invalid platform app". Unified Login is the
// documented replacement: the SAME Facebook Login for Business dialog
// as above (facebook.com/dialog/oauth + the configuration ID), which
// lets the user continue with Instagram OR Facebook, needs no Facebook
// Page, and returns a business system-user token whose Instagram
// accounts are discovered via /me/assigned_instagram_accounts (see the
// ig-callback). It uses the Meta app's own credentials — there is no
// separate Instagram app ID/secret. The redirect URI must be the one
// registered for this configuration in the Meta app dashboard EXACTLY;
// it is a DIFFERENT callback path from the Facebook flow's above.
const IG_LOGIN_REDIRECT_URI = process.env.IG_LOGIN_REDIRECT_URI || 'https://social-scheduler-one-sandy.vercel.app/api/instagram/ig-callback';
function unifiedLoginConfigured() { return !!(META_APP_ID && META_LOGIN_CONFIG_ID && metaAppSecret()); }
// db-status keeps reporting this under its historical field name; it
// now describes the Unified Login setup above.
function instagramLoginConfigured() { return unifiedLoginConfigured(); }
// Legacy, kept only so the keeper can still debug a stored Instagram
// Login token (tokenHost 'instagram') from the retired direct-Instagram
// setup. No connect flow reads these any more.
const INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_ID || '';
const INSTAGRAM_APP_SECRET = process.env.INSTAGRAM_APP_SECRET || '';

// Returns { data } on success or { error: "Meta's message" } — the error
// text is Meta's own wording about the token (never the token itself),
// stored so connection problems are diagnosable instead of silent.
// Host-aware: Instagram Login tokens are debugged on
// graph.instagram.com (inspected by the Instagram app's token when
// configured, else self-inspection); Facebook Login tokens keep the
// original graph.facebook.com attempts, unchanged and in the same
// order. For an Instagram-host token the Facebook attempts remain as a
// harmless fallback.
async function debugInstagramToken(token, tokenHost) {
  // Attempts are [endpoint, inspector, isAppToken]. The app access
  // token (appId|appSecret) is tried FIRST wherever the app secret is
  // configured: debug_token requires it for tokens the caller does not
  // own outright (system-user tokens included) — self-inspection with
  // the token itself only answers "(#100) You must provide an app
  // access token..." for those. When every attempt fails, the APP
  // token attempt's error is the one reported: it is Meta's verdict on
  // the token, while a self-inspection failure only says the token
  // could not inspect itself and would mask the real reason.
  const attempts = [];
  if (tokenHost === 'instagram') {
    const igInspectors = [];
    if (INSTAGRAM_APP_ID && INSTAGRAM_APP_SECRET) igInspectors.push([`${INSTAGRAM_APP_ID}|${INSTAGRAM_APP_SECRET}`, true]);
    igInspectors.push([token, false]); // self-inspection
    for (const [inspector, isApp] of igInspectors) attempts.push(['https://graph.instagram.com/debug_token', inspector, isApp]);
  }
  const inspectors = [];
  const secret = metaAppSecret();
  if (secret) inspectors.push([`${META_APP_ID}|${secret}`, true]);
  inspectors.push([token, false]); // self-inspection
  for (const [inspector, isApp] of inspectors) attempts.push(['https://graph.facebook.com/v27.0/debug_token', inspector, isApp]);
  let lastError = 'debug_token returned nothing';
  let appTokenError = '';
  for (const [endpoint, inspector, isApp] of attempts) {
    try {
      const out = await graphGet(endpoint + '?input_token=' + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(inspector));
      if (out && out.data) return { data: out.data };
      if (out && out.error) {
        const msg = String(out.error.message || out.error.type || 'debug_token error').slice(0, 200);
        lastError = msg;
        if (isApp && !appTokenError) appTokenError = msg;
      }
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 200);
      lastError = msg;
      if (isApp && !appTokenError) appTokenError = msg;
    }
  }
  return { error: appTokenError || lastError };
}

// Which host accepts this token? Instagram Login tokens answer on
// graph.instagram.com; Facebook-host tokens answer on graph.facebook.com
// via the IG user id (the exact call the connect flow verifies with).
// Returns { host } or { host:'', error, dead } — dead=true when Meta's
// answer proves the token itself is invalid/expired (code 190).
async function probeInstagramTokenHost(token, igUserId) {
  try {
    const me = await graphGet('https://graph.instagram.com/me?fields=id,username&access_token=' + encodeURIComponent(token));
    if (me && me.id && !me.error) return { host: 'instagram' };
  } catch { /* fall through */ }
  if (igUserId) {
    try {
      const chk = await graphGet('https://graph.facebook.com/v27.0/' + encodeURIComponent(igUserId) + '?fields=username&access_token=' + encodeURIComponent(token));
      if (chk && chk.id && !chk.error) return { host: 'facebook' };
      if (chk && chk.error) {
        const msg = String(chk.error.message || chk.error.type || 'facebook check failed').slice(0, 200);
        const dead = chk.error.code === 190 || /invalid oauth|expired|invalid token/i.test(msg);
        return { host: '', error: msg, dead };
      }
    } catch (e) { return { host: '', error: String((e && e.message) || e).slice(0, 200), dead: false }; }
  }
  return { host: '', error: 'no host accepted the token', dead: false };
}

// Returns { token, expiresIn, via } or { error } with Meta's messages.
// Host-aware: a token is renewed only on its own host — Instagram
// Login tokens via ig_refresh_token on graph.instagram.com, Facebook
// Login tokens via fb_exchange_token on graph.facebook.com (an
// exchange on the wrong host/app can never succeed). When the host is
// not recorded yet, both paths are tried in the original order, which
// is how legacy records behaved.
async function tryRefreshInstagramToken(token, tokenHost) {
  const errors = [];
  if (tokenHost !== 'facebook') {
    try {
      const out = await graphGet('https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=' + encodeURIComponent(token));
      if (out && out.access_token) return { token: out.access_token, expiresIn: Number(out.expires_in) || 0, via: 'instagram-refresh' };
      if (out && out.error) errors.push('instagram-refresh: ' + String(out.error.message || out.error.type || 'error').slice(0, 150));
    } catch (e) { errors.push('instagram-refresh: ' + String((e && e.message) || e).slice(0, 150)); }
  }
  if (tokenHost !== 'instagram') {
    const secret = metaAppSecret();
    if (secret) {
      try {
        const out = await graphGet('https://graph.facebook.com/v27.0/oauth/access_token?grant_type=fb_exchange_token&client_id=' + encodeURIComponent(META_APP_ID) + '&client_secret=' + encodeURIComponent(secret) + '&fb_exchange_token=' + encodeURIComponent(token));
        if (out && out.access_token) return { token: out.access_token, expiresIn: Number(out.expires_in) || 0, via: 'facebook-exchange' };
        if (out && out.error) errors.push('facebook-exchange: ' + String(out.error.message || out.error.type || 'error').slice(0, 150));
      } catch (e) { errors.push('facebook-exchange: ' + String((e && e.message) || e).slice(0, 150)); }
    } else {
      errors.push('facebook-exchange: skipped (META_APP_SECRET not set)');
    }
  }
  return { error: errors.join(' | ') || 'no refresh path succeeded' };
}

function instagramHealth(stored) {
  if (!stored || !stored.token) return null;
  const now = Date.now();
  const neverExpires = !!stored.tokenNeverExpires;
  const expMs = stored.tokenExpiresAt ? new Date(stored.tokenExpiresAt).getTime() : 0;
  return {
    connected: true,
    username: stored.username || '',
    tokenType: stored.tokenType || '',
    tokenExpiresAt: neverExpires ? null : (stored.tokenExpiresAt || null),
    tokenNeverExpires: neverExpires,
    daysRemaining: neverExpires ? null : (expMs ? Math.max(0, Math.round((expMs - now) / 86400000)) : null),
    lastCheckedAt: stored.lastTokenCheckAt || null,
    lastRefreshAt: stored.lastRefreshAt || null,
    tokenHost: stored.tokenHost || '',
    lastDebugError: stored.lastDebugError || null,
    lastRefreshError: stored.lastRefreshError || null,
    refreshBlocked: stored.tokenRefreshError === 'auto-refresh-unavailable',
    needsReconnect: stored.tokenRefreshError === 'revoked-or-expired',
  };
}

const tokenCheckInFlight = new Map();
// Is a full Meta check due for this stored record? A check is due
// unless the last one ran <24h ago AND the token is comfortably valid
// (never expires, or >10 days left, or a Meta-side refresh failure
// already settled it). A past refresh failure settles the keeper into
// a quiet daily rhythm — but only when the failure was Meta-side: a
// failure caused by missing server config (the app secret not yet set
// when the attempt ran) must never settle the keeper, otherwise the
// connection would report "refresh blocked" forever on the strength of
// one stale error string.
function keeperCheckDue(stored, now) {
  if (!stored || !stored.token) return false;
  const expMs = stored.tokenExpiresAt ? new Date(stored.tokenExpiresAt).getTime() : 0;
  const daysLeft = stored.tokenNeverExpires ? Infinity : (expMs ? (expMs - now) / 86400000 : null);
  const lastCheck = stored.lastTokenCheckAt ? new Date(stored.lastTokenCheckAt).getTime() : 0;
  const refreshFailureWasConfig = /META_APP_SECRET not set/i.test(stored.lastRefreshError || '');
  const settled = !!lastCheck && now - lastCheck < 24 * 3600 * 1000
    && (stored.tokenNeverExpires || (daysLeft !== null && daysLeft > TOKEN_REFRESH_WINDOW_DAYS) || (stored.tokenRefreshError === 'auto-refresh-unavailable' && stored.tokenHost && !refreshFailureWasConfig));
  return !settled;
}
// A due check is URGENT when its outcome changes what happens next:
// the token is inside the refresh window (a renewal must complete) or
// its expiry is unknown (it must be learned). A due check on a
// comfortably healthy token is ROUTINE — pure bookkeeping
// (lastTokenCheckAt, debug fields) that no response needs to wait for.
function keeperCheckUrgent(stored, now) {
  if (!stored || !stored.token || stored.tokenNeverExpires) return false;
  if (!keeperCheckDue(stored, now)) return false;
  const expMs = stored.tokenExpiresAt ? new Date(stored.tokenExpiresAt).getTime() : 0;
  if (!expMs) return true;
  return (expMs - now) / 86400000 <= TOKEN_REFRESH_WINDOW_DAYS;
}
// Check (and if needed renew) one user's stored token. Throttled: a full
// Meta check runs at most once per 24h per user per instance unless the
// expiry is inside the refresh window. Returns instagramHealth() or null.
// With { background: true } (page loads: Settings, db-status), a ROUTINE
// due check is started in the background — registered in the in-flight
// map, so a foreground caller can still await the same run — and the
// STORED health is returned immediately; a routine check used to block
// these pages for seconds on debug_token calls. An URGENT due check
// still runs in the foreground, exactly as before, so a renewal or a
// revocation is always reflected in the response that triggered it.
// Foreground callers (publish paths, connect callbacks) are unchanged.
// Multi-account: opts.igUserId selects WHICH connection to check (the
// keeper runs per connection; the in-flight map is keyed per account).
// Without it, the user's default connection is checked, as before.
async function ensureInstagramTokenFresh(userId, opts = {}) {
  if (!userId) return null;
  const key = `${userId}:${opts.igUserId || ''}`;
  if (tokenCheckInFlight.has(key)) {
    if (opts.background) { const s = await getInstagramStored(userId, opts.igUserId).catch(() => ({})); return instagramHealth(s); }
    return tokenCheckInFlight.get(key);
  }
  if (opts.background && !opts.force) {
    const stored = await getInstagramStored(userId, opts.igUserId).catch(() => ({}));
    if (!stored.token) return null;
    if (!keeperCheckDue(stored, Date.now())) return instagramHealth(stored);
    if (!keeperCheckUrgent(stored, Date.now())) {
      const run = runKeeperCheck(userId, { igUserId: opts.igUserId });
      tokenCheckInFlight.set(key, run);
      run.catch(() => { /* background check: failures land in the health fields */ })
        .finally(() => { if (tokenCheckInFlight.get(key) === run) tokenCheckInFlight.delete(key); });
      return instagramHealth(stored);
    }
    // Urgent: fall through to the foreground run below.
  }
  const run = runKeeperCheck(userId, opts);
  tokenCheckInFlight.set(key, run);
  try { return await run; } finally { if (tokenCheckInFlight.get(key) === run) tokenCheckInFlight.delete(key); }
}
async function runKeeperCheck(userId, opts = {}) {
    const stored = await getInstagramStored(userId, opts.igUserId);
    if (!stored.token) return null; // env token or not connected — nothing stored to renew
    const now = Date.now();
    if (!opts.force && !keeperCheckDue(stored, now)) {
      return instagramHealth(stored);
    }
    let current = { ...stored };
    const patch = { lastTokenCheckAt: new Date().toISOString() };
    const dbgRes = await debugInstagramToken(current.token, current.tokenHost).catch((e) => ({ error: String((e && e.message) || e).slice(0, 200) }));
    const dbg = dbgRes && dbgRes.data ? dbgRes.data : null;
    if (dbg) {
      patch.lastDebugError = '';
      if (typeof dbg.type === 'string') patch.tokenType = dbg.type;
      if (dbg.is_valid === false) patch.tokenRefreshError = 'revoked-or-expired';
      else if (current.tokenRefreshError === 'revoked-or-expired') patch.tokenRefreshError = '';
      if (dbg.expires_at === 0) { patch.tokenNeverExpires = true; patch.tokenExpiresAt = ''; }
      else if (dbg.expires_at) { patch.tokenNeverExpires = false; patch.tokenExpiresAt = new Date(dbg.expires_at * 1000).toISOString(); }
    } else {
      // debug_token would not describe this token (common for Instagram
      // Login tokens without an app token). Record Meta's reason and
      // probe which host accepts it, so we still know it is alive.
      patch.lastDebugError = (dbgRes && dbgRes.error) || 'debug_token failed';
      if (!current.tokenHost) {
        const probe = await probeInstagramTokenHost(current.token, current.igUserId).catch((e) => ({ host: '', error: String((e && e.message) || e).slice(0, 200), dead: false }));
        if (probe.host) patch.tokenHost = probe.host;
        else {
          if (probe.error) patch.lastDebugError = (patch.lastDebugError + ' | live check: ' + probe.error).slice(0, 300);
          if (probe.dead) patch.tokenRefreshError = 'revoked-or-expired';
        }
      }
    }
    await db.saveInstagram(userId, patch, current.igUserId);
    current = { ...current, ...patch };
    if (dbg && dbg.is_valid === false) return instagramHealth(current);
    const expMs2 = current.tokenExpiresAt ? new Date(current.tokenExpiresAt).getTime() : 0;
    const daysLeft2 = current.tokenNeverExpires ? Infinity : (expMs2 ? (expMs2 - now) / 86400000 : null);
    const anchor = current.lastRefreshAt || current.connectedAt;
    const anchorAgeDays = anchor ? (now - new Date(anchor).getTime()) / 86400000 : 0;
    // Refresh when the expiry is inside the window — or when the expiry
    // is unknown and the token is more than a day old: a successful
    // refresh both renews it AND teaches us the new expiry (expires_in).
    const needsRefresh = !current.tokenNeverExpires
      && ((daysLeft2 !== null && daysLeft2 < TOKEN_REFRESH_WINDOW_DAYS)
        || (daysLeft2 === null && anchorAgeDays > 1));
    if (!needsRefresh && current.tokenRefreshError === 'auto-refresh-unavailable'
      && /META_APP_SECRET not set/i.test(current.lastRefreshError || '')) {
      // Self-heal: the only recorded refresh failure was the missing
      // app secret, this run proves the token is valid with time to
      // spare, and the secret lookup above now succeeds — clear the
      // stale "refresh blocked" state instead of reporting it forever.
      const patch3 = { tokenRefreshError: '', lastRefreshError: '' };
      await db.saveInstagram(userId, patch3, current.igUserId);
      current = { ...current, ...patch3 };
    }
    if (needsRefresh) {
      // Learn the token's host before renewing when it was never
      // recorded (legacy records): renewal is attempted only on the
      // token's own host, so a Facebook-host token never wastes an
      // ig_refresh_token attempt — that attempt fails with a token
      // parse error and pollutes the recorded refresh error.
      if (!current.tokenHost) {
        const probe = await probeInstagramTokenHost(current.token, current.igUserId).catch((e) => ({ host: '', error: String((e && e.message) || e).slice(0, 200), dead: false }));
        if (probe.host) {
          const patchH = { tokenHost: probe.host };
          await db.saveInstagram(userId, patchH, current.igUserId);
          current = { ...current, ...patchH };
        } else if (probe.dead) {
          const patchH = { tokenRefreshError: 'revoked-or-expired' };
          await db.saveInstagram(userId, patchH, current.igUserId);
          return instagramHealth({ ...current, ...patchH });
        }
      }
      const refreshed = await tryRefreshInstagramToken(current.token, current.tokenHost).catch((e) => ({ error: String((e && e.message) || e).slice(0, 200) }));
      if (refreshed && refreshed.token) {
        const patch2 = { token: refreshed.token, lastRefreshAt: new Date().toISOString(), lastTokenCheckAt: new Date().toISOString(), tokenRefreshError: '', lastRefreshError: '', tokenHost: refreshed.via === 'instagram-refresh' ? 'instagram' : (current.tokenHost || '') };
        if (refreshed.expiresIn > 0) { patch2.tokenNeverExpires = false; patch2.tokenExpiresAt = new Date(now + refreshed.expiresIn * 1000).toISOString(); }
        await db.saveInstagram(userId, patch2, current.igUserId);
        current = { ...current, ...patch2, token: refreshed.token };
        const dbg2Res = await debugInstagramToken(refreshed.token, refreshed.via === 'instagram-refresh' ? 'instagram' : current.tokenHost).catch(() => null);
        const dbg2 = dbg2Res && dbg2Res.data ? dbg2Res.data : null;
        if (dbg2) {
          const p3 = { lastDebugError: '' };
          if (typeof dbg2.type === 'string') p3.tokenType = dbg2.type;
          if (dbg2.expires_at === 0) { p3.tokenNeverExpires = true; p3.tokenExpiresAt = ''; }
          else if (dbg2.expires_at) { p3.tokenNeverExpires = false; p3.tokenExpiresAt = new Date(dbg2.expires_at * 1000).toISOString(); }
          await db.saveInstagram(userId, p3, current.igUserId);
          current = { ...current, ...p3 };
        }
      } else {
        const patch2 = { tokenRefreshError: 'auto-refresh-unavailable', lastRefreshError: ((refreshed && refreshed.error) || 'refresh failed').slice(0, 300) };
        await db.saveInstagram(userId, patch2, current.igUserId);
        current = { ...current, ...patch2 };
      }
    }
    return instagramHealth(current);
}

// Plain-words version of an Instagram Graph API error.
function friendlyGraphError(data, fallback) {
  const err = data && data.error;
  const msg = (err && (err.message || '')) || '';
  const code = err && err.code;
  if (code === 190 || /invalid oauth|expired|invalid token/i.test(msg)) {
    return 'Instagram says this connection is invalid or expired. The app renews your token automatically, so this means Meta has revoked it (password change, or access removed in your Meta settings) — reconnect in Settings to fix it.';
  }
  if (code === 100 || /permission|not authorized|does not exist/i.test(msg)) {
    return 'Instagram rejected the request — the connection may lack permission or the Instagram User ID may be wrong. Reconnect Instagram in Settings so Meta grants the app its configured profile and publishing permissions.';
  }
  if (msg) return `Instagram said: ${msg} If this keeps happening, check the connection health in Settings.`;
  return fallback;
}

// ---------- health / stats ----------
// The build id of the running deployment: the Vercel git SHA when
// deployed, else the id the frontend build wrote to dist/build-id.json
// (the same value baked into the bundle as __BUILD_ID__). The app's
// update guard compares its own baked-in id with this one (and with
// the static /build-id.json) and offers a refresh when they differ —
// a stale tab can then never sit on chunks that no longer exist.
function serverBuildId() {
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DIST, 'build-id.json'), 'utf8'));
    return typeof parsed.buildId === 'string' && parsed.buildId ? parsed.buildId : null;
  } catch { return null; }
}
app.get('/api/version', (req, res) => {
  res.json({ ok: true, buildId: serverBuildId() });
});
// ---------- global app settings (batch 6) ----------
// The owner console's safe global toggles (signup open/closed,
// maintenance mode + message), stored via db.getGlobalSettings and
// read through a 30-second in-process cache so enforcement costs no
// database hit per request. Fails OPEN on any read error: a settings
// glitch must never lock every user out of the app.
let globalSettingsCache = { at: 0, value: null };
async function globalSettings() {
  if (globalSettingsCache.value && Date.now() - globalSettingsCache.at < 30000) return globalSettingsCache.value;
  const value = await db.getGlobalSettings().catch(() => ({ signupOpen: true, maintenance: false, maintenanceMessage: '' }));
  globalSettingsCache = { at: Date.now(), value };
  return value;
}
function bustGlobalSettingsCache() { globalSettingsCache = { at: 0, value: null }; }
const MAINTENANCE_FALLBACK_MSG = 'KiluaAI is under quick maintenance — posting is paused for a few minutes. Please try again shortly.';
// Public status for the login screen + app shell: are signups open,
// is maintenance on, and what should the user be told. No user data.
app.get('/api/app-status', ah(async (req, res) => {
  const gs = await globalSettings();
  res.json({
    ok: true,
    signupOpen: gs.signupOpen !== false,
    maintenance: !!gs.maintenance,
    maintenanceMessage: gs.maintenance ? String(gs.maintenanceMessage || '') : '',
    // Public plan display data for the landing pricing strip (Phase 3
    // Batch D, L-02) — read from the single PLANS config so the
    // marketing page can never drift from the enforced prices.
    plans: Object.values(PLANS).map((p) => ({ id: p.id, name: p.name, priceInr: p.priceInr })),
  });
}));
app.get('/api/health', ah(async (req, res) => {
  res.json({ ok: true, service: 'social-scheduler', db: db.getStatus().db, instagramConfigured: await igConfigured(req).catch(() => false) });
}));
app.get('/health', (req, res) => res.json({ ok: true, service: 'social-scheduler' }));
// Database + login health: names/booleans only, never values. If db is
// "json", data does NOT survive redeploys — set MONGODB_URI in Vercel.
// If sessionSecretFromEnv is false, logins die on every restart — set
// SESSION_SECRET in Vercel.
// The connected-account scan behind db-status (user count + every
// stored Instagram doc) is ONE query via db.listInstagram(), and its
// result is cached for 15 s: db-status is a status page, and the old
// per-user loop cost one sequential database round trip per account on
// every call, which made it the slowest route in the app. Only the
// scan is cached — the keeper below still runs on every call, so a
// token renewal or revocation is reflected exactly as before.
let igScanCache = { at: 0, scan: null };
async function instagramScan(force = false) {
  if (!force && igScanCache.scan && Date.now() - igScanCache.at < 15000) return igScanCache.scan;
  const [usersScanned, docs] = await Promise.all([db.countUsers(), db.listInstagram()]);
  const scan = { usersScanned, docsFound: 0, tokensReadable: 0, connectedUserId: null, accountsConnected: 0, connectedAccountsCount: 0 };
  for (const st of docs) {
    if (st && (st.igUserId || st.connectedAt)) scan.docsFound += 1;
    scan.accountsConnected += (st && st.accountsCount) || 0;
    if (st && st.token) {
      scan.tokensReadable += 1;
      if (!scan.connectedUserId) { scan.connectedUserId = st.userId; scan.connectedAccountsCount = st.accountsCount || 0; }
    }
  }
  igScanCache = { at: Date.now(), scan };
  return scan;
}
app.get('/api/db-status', ah(async (req, res) => {
  // Audit fix V-01 (2026-11-22): this page returns deployment-health
  // detail AND runs the Instagram token keeper on every call — it is
  // the OWNER's diagnostics page, not a public probe. Owner session
  // only (the same identity the admin console trusts); everyone else
  // gets the console's plain 404, so the page's existence is not
  // admitted and no unauthenticated caller can trigger the keeper.
  // Public liveness lives at /api/health. The frontend already
  // tolerates a failed db-status call (Settings simply renders
  // without the storage warning), and the keeper still runs on cron
  // and on the owner's own authenticated activity.
  const me = await adminOwner(req);
  if (!me) return adminApi404(res);
  // Connect eagerly first: without this, a cold container reports "json"
  // until some other data request happens, and the UI shows a false warning.
  await db.ensureMongo();
  const s = db.getStatus();
  // Owner's Instagram connection health (metadata only — type, expiry,
  // renewal state; never the token). Running the keeper here means this
  // status check also renews the token when it is inside the window.
  let ownerInstagram = null;
  const igDiag = { usersScanned: 0, docsFound: 0, tokensReadable: 0, accountsConnected: 0, keeperError: null };
  try {
    // The connected account is whichever user actually has a stored token
    // (normally the owner) — scan all connections, counts only, never values.
    let scan = await instagramScan();
    if (scan.connectedUserId) ownerInstagram = await ensureInstagramTokenFresh(scan.connectedUserId, { background: true });
    if (!ownerInstagram) {
      // The cached scan may predate a connection change (a connect or
      // disconnect seconds ago): verify once with a fresh scan before
      // reporting "not connected", so this page never shows a stale
      // connection state for longer than one call.
      const fresh = await instagramScan(true);
      if (fresh.connectedUserId && fresh.connectedUserId !== scan.connectedUserId) {
        scan = fresh;
        ownerInstagram = await ensureInstagramTokenFresh(fresh.connectedUserId, { background: true });
      }
    }
    // usersScanned always comes from a FRESH recount: the cached
    // scan's count lagged one call behind reality (a user created
    // between calls only appeared on the call after).
    const freshUserCount = await db.countUsers().catch(() => null);
    igDiag.usersScanned = freshUserCount !== null ? freshUserCount : scan.usersScanned;
    igDiag.docsFound = scan.docsFound;
    igDiag.tokensReadable = scan.tokensReadable;
    // Multi-account: how many Instagram accounts are connected in
    // total (a user can hold several since multi-account support).
    igDiag.accountsConnected = scan.accountsConnected;
    // The `instagram` health below stays the connected user's DEFAULT
    // account, exactly as existing consumers expect; the count of that
    // user's accounts rides along for the multi-account UI.
    if (ownerInstagram) ownerInstagram = { ...ownerInstagram, accountsConnected: scan.connectedAccountsCount };
  } catch (e) { igDiag.keeperError = String((e && e.message) || e).slice(0, 200); }
  res.json({
    ok: true,
    buildId: serverBuildId(),
    db: s.db,
    database: s.database,
    mongoReady: s.mongoReady,
    uriConfigured: s.uriConfigured,
    sessionSecretFromEnv: s.sessionSecretFromEnv,
    tokenEncryptionAvailable: s.tokenEncryptionAvailable,
    metaAppSecretConfigured: !!metaAppSecret(),
    instagramLoginConfigured: instagramLoginConfigured(),
    instagram: ownerInstagram,
    instagramDiag: igDiag,
    lastError: s.lastError,
    warning: s.db !== 'mongodb'
      ? 'Database is local JSON files — accounts and posts will disappear on redeploy. Set MONGODB_URI in Vercel env vars.'
      : (!s.sessionSecretFromEnv ? 'SESSION_SECRET is not set — logins will not survive a restart or redeploy. Set SESSION_SECRET in Vercel env vars.' : null),
  });
}));
app.get('/api/stats', ah(async (req, res) => {
  const posts = await getPosts(req); const media = await getMedia(req);
  res.json({
    ok: true,
    scheduled: posts.filter((p) => p.status === 'scheduled').length,
    published: posts.filter((p) => p.status === 'published').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    drafts: posts.filter((p) => p.status === 'draft').length,
    mediaCount: media.length,
    total: posts.length,
  });
}));
// Export my data: the user's own posts, media, templates and settings as
// JSON. The Instagram token is never included.
app.get('/api/export', ah(async (req, res) => {
  const [posts, media, templates, settings] = await Promise.all([
    db.listPosts(req.userId), db.listMedia(req.userId), db.listTemplates(req.userId), db.getSettings(req.userId),
  ]);
  res.setHeader('Content-Disposition', 'attachment; filename="social-scheduler-export.json"');
  res.json({ ok: true, exportedAt: new Date().toISOString(), user: req.user, posts, media, templates, settings });
}));

// ---------- settings ----------
app.get('/api/settings', ah(async (req, res) => {
  const s = await getSettings(req);
  // Opening Settings is a keeper checkpoint: if a token check is due it
  // runs in the BACKGROUND (throttled to once a day) — this response
  // answers from the stored health and never waits on Meta, so the page
  // loads fast even on the day a check falls due.
  const health = await ensureInstagramTokenFresh(req.userId, { background: true }).catch(() => null);
  const ig = await getInstagramCreds(req);
  const stored = await getInstagramStored(req);
  const summaries = await instagramAccountSummaries(req.userId);
  // The keeper runs per connection: background-check every other
  // connected account too (throttled + in-flight-guarded, so this is
  // a no-op unless a check is actually due).
  for (const a of summaries.accounts) {
    if (a.igUserId && a.igUserId !== summaries.defaultIgUserId) {
      ensureInstagramTokenFresh(req.userId, { background: true, igUserId: a.igUserId }).catch(() => null);
    }
  }
  const settingsResponse = {
    ok: true,
    instagramHandle: s.instagramHandle || ig.username || '',
    instagramConnected: !!(ig.token && ig.igUserId),
    tokenConfigured: !!(ig.token && ig.igUserId),
    instagramUsername: ig.username || '',
    maskedToken: maskToken(ig.token),
    tokenSource: ig.source,
    igUserIdSet: !!ig.igUserId,
    tokenEncrypted: stored.token ? !!stored.encrypted : null,
    instagramProfile: stored.profile || null,
    connectedAt: stored.connectedAt || '',
    instagramHealth: health || instagramHealth(stored),
    instagramAccounts: summaries.accounts,
    defaultIgUserId: summaries.defaultIgUserId,
    setupDone: s.setupDone === true,
    checklistDismissed: s.checklistDismissed === true,
    guideDismissed: s.guideDismissed === true,
    keepServerCopyAfterPublish: s.keepServerCopyAfterPublish === true,
    ytDefaultVisibility: ytVisibilityOf(s.ytDefaultVisibility),
  };
  res.json(settingsResponse);
}));
app.post('/api/settings', ah(async (req, res) => {
  // Settings are a set of named values: an array (or scalar) body is
  // rejected outright — array indices used to be stored as settings
  // keys "0", "1", ….
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ ok: false, error: 'Settings must be sent as a set of named values — please try again.' });
  }
  // Default YouTube visibility (Phase E) must be one of the three
  // privacy states — anything else is rejected, never stored.
  if (req.body.ytDefaultVisibility !== undefined && !YT_VISIBILITIES.includes(req.body.ytDefaultVisibility)) {
    return res.status(400).json({ ok: false, error: 'That default YouTube visibility is not valid — use Public, Unlisted or Private.' });
  }
  const s = { ...(await getSettings(req)), ...(req.body || {}) };
  // Settings hold simple values only — objects/arrays are rejected so a
  // crafted value cannot corrupt the stored settings.
  for (const [k, v] of Object.entries(req.body || {})) {
    if (v !== null && typeof v === 'object') return res.status(400).json({ ok: false, error: `The setting “${k}” is not valid — settings can only hold simple text or on/off values.` });
  }
  // Tokens and the connected flag are never set from this form — the
  // connection state comes only from /api/instagram/connect (verified
  // against the Graph API) or the env fallback.
  delete s.token; delete s.accessToken; delete s.instagramConnected; delete s.tokenConfigured;
  delete s.maskedToken; delete s.tokenSource; delete s.instagramUsername;
  delete s.instagramProfile; delete s.tokenEncrypted;
  await db.saveSettings(req.userId, s);
  const ig = await getInstagramCreds(req);
  const stored = await getInstagramStored(req);
  const summaries = await instagramAccountSummaries(req.userId);
  res.json({ ok: true, instagramHandle: s.instagramHandle || ig.username || '', instagramConnected: !!(ig.token && ig.igUserId), tokenConfigured: !!(ig.token && ig.igUserId), instagramUsername: ig.username || '', maskedToken: maskToken(ig.token), tokenSource: ig.source, igUserIdSet: !!ig.igUserId, tokenEncrypted: stored.token ? !!stored.encrypted : null, instagramProfile: stored.profile || null, connectedAt: stored.connectedAt || '', instagramHealth: instagramHealth(stored), instagramAccounts: summaries.accounts, defaultIgUserId: summaries.defaultIgUserId, setupDone: s.setupDone === true, checklistDismissed: s.checklistDismissed === true, guideDismissed: s.guideDismissed === true, keepServerCopyAfterPublish: s.keepServerCopyAfterPublish === true, ytDefaultVisibility: ytVisibilityOf(s.ytDefaultVisibility) });
}));

// ---------- Instagram connect (Meta login only) ----------
// The manual token-paste flow was removed: connecting happens ONLY
// through the Meta login flow below (the owner's instruction). This
// route stays as a 410 so an old client gets a clear answer instead of
// a 404. Stored connections and the token keeper are unaffected.
async function graphGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return r.json().catch(() => null);
}
app.post('/api/instagram/connect', (req, res) => {
  res.status(410).json({ ok: false, error: 'Pasting a token is no longer supported. Use the \u201cConnect Instagram\u201d button \u2014 one Meta login, and the connection renews itself automatically.' });
});
app.post('/api/instagram/disconnect', ah(async (req, res) => {
  // Per-account disconnect: { igUserId } removes just that account and
  // leaves the user's other connections (and their queued posts)
  // untouched. Removing the default promotes the first remaining
  // account. With no igUserId (older clients), the DEFAULT account —
  // the one the single-connection UI always showed — is removed; when
  // it was the only account, that is a full disconnect, as before.
  const body = req.body || {};
  let target = body.igUserId ? String(body.igUserId) : '';
  if (!target) {
    const { defaultIgUserId } = await db.getInstagramAccounts(req.userId);
    target = defaultIgUserId || '';
  }
  if (target) await db.removeInstagramAccount(req.userId, target);
  else await db.clearInstagram(req.userId);
  const ig = await getInstagramCreds(req);
  const summaries = await instagramAccountSummaries(req.userId);
  res.json({ ok: true, instagramConnected: !!(ig.token && ig.igUserId), tokenSource: ig.source, maskedToken: maskToken(ig.token), instagramUsername: ig.username || '', instagramAccounts: summaries.accounts, defaultIgUserId: summaries.defaultIgUserId });
}));
// Choose which connected account is the default (new posts pre-select
// it, and untargeted posts publish through it).
app.post('/api/instagram/default', ah(async (req, res) => {
  const igUserId = req.body && req.body.igUserId ? String(req.body.igUserId) : '';
  if (!igUserId) return res.status(400).json({ ok: false, error: 'Choose an account to make the default.' });
  const ok = await db.setDefaultInstagramAccount(req.userId, igUserId);
  if (!ok) return res.status(404).json({ ok: false, error: 'That Instagram account is not connected.' });
  const summaries = await instagramAccountSummaries(req.userId);
  res.json({ ok: true, instagramAccounts: summaries.accounts, defaultIgUserId: summaries.defaultIgUserId });
}));

// ---------- Instagram connect via Meta login (OAuth, the only flow) ----------
// GET /api/instagram/connect sends the user to Meta's Facebook Login for
// Business dialog; Meta returns them to the callback with a short-lived
// code; the callback exchanges it (code -> short-lived -> long-lived),
// finds the Instagram professional account linked to one of the user's
// Facebook Pages, and stores the long-lived token encrypted — the token
// keeper then renews it automatically. One login, unlimited use: the
// user only repeats this if Meta revokes the connection. The OAuth
// `state` is HMAC-signed with the session secret, bound to the user it
// was minted for, and expires in 10 minutes — the callback takes the
// user id FROM the verified state, because the browser that returns
// from Meta (the phone's system browser, when the app handed off) has
// no session cookie. Codes and tokens are never logged (the request
// logger records paths only, never query strings).
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
function signOAuthState(userId) {
  const exp = Date.now() + OAUTH_STATE_TTL_MS;
  const payload = `igstate.${userId}.${crypto.randomBytes(16).toString('hex')}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
// Verifies the state signature + expiry and returns the user id bound
// into it, or '' when the state is forged, malformed or expired.
function userIdFromOAuthState(state) {
  try {
    if (!state || typeof state !== 'string') return '';
    const dot = state.lastIndexOf('.');
    if (dot < 0) return '';
    const payload = Buffer.from(state.slice(0, dot), 'base64url').toString('utf8');
    const sig = state.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'igstate' || !parts[1]) return '';
    if (!parts[3] || Number(parts[3]) < Date.now()) return '';
    return parts[1];
  } catch { return ''; }
}
function verifyOAuthState(state, userId) {
  return !!userId && userIdFromOAuthState(state) === userId;
}

// ---------- One-time connect links (app / system-browser handoff) ----------
// Inside the Android app the Connect button lives in a WebView, but the
// Meta dialog is handed to the system browser, which has no session
// cookie — a session-only /connect could never work from the app (it
// answered raw "Please log in first" JSON). Instead the app, while
// logged in, asks POST /api/instagram/connect-link for a signed
// one-time link: HMAC over SESSION_SECRET, bound to the user,
// purpose-tagged, good for 10 minutes. Opening the link starts the
// normal dialog flow. The link carries no Instagram credential.
const CONNECT_TOKEN_TTL_MS = 10 * 60 * 1000;
function signConnectToken(userId) {
  const exp = Date.now() + CONNECT_TOKEN_TTL_MS;
  const payload = `igconnect.${userId}.${crypto.randomBytes(16).toString('hex')}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
// Returns the user id the link was minted for, or '' when invalid/expired.
function verifyConnectToken(token) {
  try {
    if (!token || typeof token !== 'string') return '';
    const dot = token.lastIndexOf('.');
    if (dot < 0) return '';
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'igconnect' || !parts[1]) return '';
    if (!parts[3] || Number(parts[3]) < Date.now()) return '';
    return parts[1];
  } catch { return ''; }
}

// Single-use enforcement for connect links: a link is called "one-time"
// in the UI, so its first successful use must consume it — a replayed
// link (same URL opened twice inside its 10-minute window) used to
// start the connect flow again. The minted link's random nonce is
// remembered until the link expires and the first verification burns
// it; a second use verifies as ''. In-memory per instance (like the
// rate limiter): a replay has to reach the same warm instance inside
// the window, which is exactly the realistic replay case.
const usedConnectNonces = new Map(); // link nonce -> link expiry (ms)
function consumeConnectToken(token) {
  const userId = verifyConnectToken(token);
  if (!userId) return '';
  let nonce = '';
  try {
    const payload = Buffer.from(String(token).slice(0, String(token).lastIndexOf('.')), 'base64url').toString('utf8');
    nonce = payload.split('.')[2] || '';
  } catch { return ''; }
  if (!nonce) return '';
  const now = Date.now();
  for (const [k, exp] of usedConnectNonces) if (exp <= now) usedConnectNonces.delete(k);
  if (usedConnectNonces.has(nonce)) return '';
  usedConnectNonces.set(nonce, now + CONNECT_TOKEN_TTL_MS);
  return userId;
}

// Friendly self-contained result pages for the browser that finishes a
// Meta login (often the phone's system browser, not the app): no SPA and
// no login needed — just the outcome and what to do next. Inline styles
// only (the CSP allows style-src 'unsafe-inline'; there are no scripts).
function igResultPage(res, status, { ok, title, message }) {
  const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return res.status(status).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — KiluaAI</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0e1325;color:#f5f1e6;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px;box-sizing:border-box">
<main style="max-width:430px;text-align:center">
<div style="font-size:52px;line-height:1;color:${ok ? '#7dd87d' : '#e8c268'}">${ok ? '✓' : '!'}</div>
<h1 style="font-size:24px;margin:16px 0 10px;color:#e8c268">${esc(title)}</h1>
<p style="font-size:16px;line-height:1.55;margin:0 0 26px">${esc(message)}</p>
<a href="https://social-scheduler-one-sandy.vercel.app/open-app" style="display:inline-block;background:#e8c268;color:#0e1325;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">Open KiluaAI</a>
<p style="font-size:13px;opacity:.65;margin-top:18px">You can close this tab — nothing else is needed here.</p>
</main></body></html>`);
}
const IG_OAUTH_REASONS = {
  denied: 'Meta login was cancelled or not approved, so nothing was connected. Go back to the KiluaAI app and tap “Connect Instagram” to try again.',
  state: 'That login link expired or was already used. Go back to the KiluaAI app and tap “Connect Instagram” — then finish the login in one go.',
  exchange: 'Meta did not complete the login. Go back to the KiluaAI app and tap “Connect Instagram” to try again — if it keeps failing, let the app owner know.',
  no_instagram: 'No Instagram professional account was found for that login. Instagram must be a Business or Creator account linked to a Facebook Page — link them in the Instagram app under Settings → Accounts Centre, then try again from the KiluaAI app.',
  config: 'Instagram login is not fully set up on the server yet. Let the app owner know to finish the Meta setup.',
};
// Resolve the Instagram professional account linked to one of the
// token's Facebook Pages: list the Pages, then read each Page's
// instagram_business_account. First match wins. Shared by both connect
// callbacks — the Facebook flow resolves this way primarily; the
// Unified Login flow uses it as a fallback for accounts that do have
// a linked Page. Returns { account, pageId, pageList } with account
// null when no Page has an Instagram account linked.
async function findInstagramAccountViaPages(token) {
  let pages = null;
  try {
    pages = await graphGet('https://graph.facebook.com/' + GRAPH_API_VERSION + '/me/accounts?fields=id,name&access_token=' + encodeURIComponent(token));
  } catch { /* handled below */ }
  const pageList = pages && Array.isArray(pages.data) ? pages.data : [];
  for (const page of pageList) {
    if (!page || !page.id) continue;
    try {
      const p = await graphGet('https://graph.facebook.com/' + GRAPH_API_VERSION + '/' + encodeURIComponent(page.id) + '?fields=instagram_business_account{id,username}&access_token=' + encodeURIComponent(token));
      if (p && p.instagram_business_account && p.instagram_business_account.id) {
        return { account: p.instagram_business_account, pageId: page.id, pageList };
      }
    } catch { /* try the next Page */ }
  }
  return { account: null, pageId: '', pageList };
}
// Session-authenticated (the /api middleware ran requireAuth): mints
// the one-time connect link the app opens in the system browser.
app.post('/api/instagram/connect-link', ah(async (req, res) => {
  // Audit hardening L-06: this handler mints a signed token from
  // req.userId — refuse explicitly when the auth middleware did not
  // populate it, instead of trusting the exemption list alone.
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = req.get('host') || 'social-scheduler-one-sandy.vercel.app';
  const url = `${proto}://${host}/api/instagram/connect?t=${encodeURIComponent(signConnectToken(req.userId))}`;
  res.json({ ok: true, url });
}));
app.get('/api/instagram/connect', ah(async (req, res) => {
  // Self-authenticating (see the /api middleware note): the session
  // cookie (normal browser use) OR a valid one-time connect link.
  let userId = '';
  const sessionUser = await getAuthUser(req).catch(() => null);
  if (sessionUser) userId = sessionUser.id;
  if (!userId && req.query && req.query.t) userId = consumeConnectToken(String(req.query.t));
  if (!userId) {
    return igResultPage(res, 401, {
      ok: false,
      title: 'This connect link has expired',
      message: 'Connect links work for 10 minutes. Go back to the KiluaAI app and tap “Connect Instagram” again — or open KiluaAI in this browser, log in, and connect from Settings here.',
    });
  }
  const dialog = 'https://www.facebook.com/' + GRAPH_API_VERSION + '/dialog/oauth'
    + '?client_id=' + encodeURIComponent(META_APP_ID)
    + '&config_id=' + encodeURIComponent(META_LOGIN_CONFIG_ID)
    + '&response_type=code'
    + '&redirect_uri=' + encodeURIComponent(META_OAUTH_REDIRECT_URI)
    + '&state=' + encodeURIComponent(signOAuthState(userId));
  return res.redirect(302, dialog);
}));
app.get('/api/instagram/callback', ah(async (req, res) => {
  // The browser landing here usually has no session (system-browser
  // handoff), so every outcome is a friendly result page, not a redirect
  // into the SPA. The user is identified by the signed OAuth state.
  const fail = (reason) => igResultPage(res, 200, { ok: false, title: 'Instagram was not connected', message: IG_OAUTH_REASONS[reason] || IG_OAUTH_REASONS.exchange });
  const failMsg = (message) => igResultPage(res, 200, { ok: false, title: 'Instagram was not connected', message });
  const q = req.query || {};
  if (q.error) return fail('denied');
  const code = String(q.code || '');
  const userId = userIdFromOAuthState(String(q.state || ''));
  if (!code || !userId) return fail('state');
  if (!metaAppSecret()) return fail('config');
  const oauthBase = 'https://graph.facebook.com/' + GRAPH_API_VERSION + '/oauth/access_token';
  // 1) code -> short-lived user token.
  let shortTok = null;
  try {
    shortTok = await graphGet(oauthBase
      + '?client_id=' + encodeURIComponent(META_APP_ID)
      + '&client_secret=' + encodeURIComponent(metaAppSecret())
      + '&redirect_uri=' + encodeURIComponent(META_OAUTH_REDIRECT_URI)
      + '&code=' + encodeURIComponent(code));
  } catch { /* handled below as an exchange failure */ }
  if (!shortTok || !shortTok.access_token) return fail('exchange');
  // 2) short-lived -> long-lived (~60 days; the keeper renews it from here).
  let longTok = null;
  try {
    longTok = await graphGet(oauthBase
      + '?grant_type=fb_exchange_token'
      + '&client_id=' + encodeURIComponent(META_APP_ID)
      + '&client_secret=' + encodeURIComponent(metaAppSecret())
      + '&fb_exchange_token=' + encodeURIComponent(shortTok.access_token));
  } catch { /* handled below */ }
  if (!longTok || !longTok.access_token) return fail('exchange');
  const token = longTok.access_token;
  const expiresIn = Number(longTok.expires_in) || 0;
  // 3) Resolve the Instagram professional account via the user's
  // Pages (shared helper — see findInstagramAccountViaPages).
  const viaPages = await findInstagramAccountViaPages(token);
  const pageList = viaPages.pageList;
  const igAccount = viaPages.account;
  const pageId = viaPages.pageId;
  if (!igAccount) {
    // Diagnostic detail for the owner: which Pages (if any) this
    // Facebook login actually returned, so a wrong-account login, an
    // unselected Page in the dialog, or a missing Page↔Instagram link
    // is obvious from the error page itself. Page names are the user's
    // own data (shown only to the person who just logged in); no token
    // values are ever included here or in any log.
    const guidance = 'KiluaAI needs the Facebook account that manages your Page. If your Page isn\'t listed, log out of Facebook in this browser, log in with the account that owns your Page, and in the KiluaAI dialog select your Page AND your Instagram account, then try again.';
    if (pageList.length === 0) {
      return failMsg('No Pages were returned for this login (0 Pages found), so no Instagram account could be resolved. ' + guidance);
    }
    const names = pageList.map((p) => (p && p.name ? String(p.name) : '(unnamed Page)')).join(', ');
    const plural = pageList.length !== 1;
    return failMsg(
      `Your Page${plural ? 's' : ''} — ${names} — ${plural ? 'were' : 'was'} found (${pageList.length} Page${plural ? 's' : ''}), but no Instagram professional account is linked to ${plural ? 'them' : 'it'}. `
      + 'Link Instagram to the Page in the Instagram app → Settings → Accounts Centre, or in the Page\'s Settings → Linked Accounts, then try again from the KiluaAI app. '
      + guidance
    );
  }
  // Multi-account: this ADDS the account to the user's connections (or
  // refreshes it when the same Instagram account reconnects) — an
  // existing connection for a different account is never replaced.
  await db.saveInstagramAccount(userId, {
    token, igUserId: String(igAccount.id), username: igAccount.username || '', pageId,
    connectedAt: new Date().toISOString(),
    tokenExpiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : '',
    tokenNeverExpires: false, tokenType: '', tokenHost: 'facebook',
    lastTokenCheckAt: '', lastRefreshAt: '', tokenRefreshError: '', lastDebugError: '', lastRefreshError: '',
  });
  // Learn the token's real type + exact expiry from Meta right away so
  // the keeper's records are precise from day one.
  await ensureInstagramTokenFresh(userId, { force: true, igUserId: String(igAccount.id) }).catch(() => null);
  return igResultPage(res, 200, {
    ok: true,
    title: 'Instagram connected ✓',
    message: igAccount.username
      ? `@${igAccount.username} is connected — switch back to the KiluaAI app, it will show Connected. The connection renews itself automatically from here.`
      : 'Your Instagram is connected — switch back to the KiluaAI app, it will show Connected. The connection renews itself automatically from here.',
  });
}));

// ---------- Instagram connect via Unified Login (primary) ----------
// Meta's "Instagram API with Unified Login" — the documented setup
// for newer apps, and the only Instagram setup this app has: GET
// /api/instagram/ig-connect sends the user to the Facebook Login for
// Business dialog (facebook.com/dialog/oauth + the app's Unified
// Login configuration ID — the exact URL the Meta dashboard generates
// for this app). In the dialog the user can continue with Instagram
// OR with Facebook; no Facebook Page is required. Meta returns them
// to /api/instagram/ig-callback with a code; the callback exchanges
// it at graph.facebook.com/oauth/access_token (Meta app ID + secret)
// for a business system-user token, then discovers the Instagram
// professional account(s) the login shared:
//   1. GET /me/assigned_instagram_accounts — the documented Unified
//      Login discovery (/me is the system user, not the person);
//   2. fallback: the Pages machinery (findInstagramAccountViaPages)
//      for accounts that also have a linked Facebook Page.
// The connection is stored exactly like the Facebook flow's
// (tokenHost 'facebook': every Graph call for it — profile, media,
// publish — goes to graph.facebook.com addressed by the Instagram
// user ID), and the token keeper watches it from there; system-user
// tokens debug as expires_at 0 (never expires) or with the lifetime
// the dashboard configuration grants. Permissions come from the
// dashboard configuration (instagram_basic, instagram_content_publish
// family), so the dialog URL carries config_id and NO scope — the
// retired instagram.com/oauth/authorize dialog ("Invalid platform
// app" for this app) and the instagram_business_* scope family
// belonged to the Instagram Login setup this app cannot have.
// The signed-state / one-time-link machinery is the same as the
// Facebook flow above: the browser that returns from Meta usually
// has no session cookie, so the user id comes from the verified
// state, and every outcome is a friendly result page. Codes and
// tokens are never logged.
const IG_LOGIN_REASONS = {
  denied: 'Meta login was cancelled or not approved, so nothing was connected. Go back to the KiluaAI app and tap “Connect Instagram” to try again.',
  state: 'That login link expired or was already used. Go back to the KiluaAI app and tap “Connect Instagram” — then finish the login in one go.',
  exchange: 'Meta did not complete the login. Go back to the KiluaAI app and tap “Connect Instagram” to try again — if it keeps failing, let the app owner know.',
  config: 'Instagram login is not fully set up on the server yet. Let the app owner know to finish the Meta setup.',
  not_configured: 'Instagram login is still being set up on the server — the final step is finishing now. Try again shortly.',
};
// Session-authenticated: mints the one-time link the app opens in the
// system browser (same pattern as /api/instagram/connect-link).
app.post('/api/instagram/ig-connect-link', ah(async (req, res) => {
  // Audit hardening L-06: explicit in-handler auth check (see
  // /api/instagram/connect-link).
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = req.get('host') || 'social-scheduler-one-sandy.vercel.app';
  const url = `${proto}://${host}/api/instagram/ig-connect?t=${encodeURIComponent(signConnectToken(req.userId))}`;
  res.json({ ok: true, url });
}));
app.get('/api/instagram/ig-connect', ah(async (req, res) => {
  // Self-authenticating (see the /api middleware note): the session
  // cookie (normal browser use) OR a valid one-time connect link.
  let userId = '';
  const sessionUser = await getAuthUser(req).catch(() => null);
  if (sessionUser) userId = sessionUser.id;
  if (!userId && req.query && req.query.t) userId = consumeConnectToken(String(req.query.t));
  if (!userId) {
    return igResultPage(res, 401, {
      ok: false,
      title: 'This connect link has expired',
      message: 'Connect links work for 10 minutes. Go back to the KiluaAI app and tap “Connect Instagram” again — or open KiluaAI in this browser, log in, and connect from Settings here.',
    });
  }
  if (!unifiedLoginConfigured()) {
    return igResultPage(res, 200, {
      ok: false,
      title: 'Instagram login is nearly ready',
      message: IG_LOGIN_REASONS.not_configured,
    });
  }
  // The Unified Login dialog URL, exactly as the Meta dashboard
  // generates it for this app: facebook.com host, the configuration
  // ID selects the requested assets + permissions (no scope param),
  // and the redirect lands on THIS flow's callback.
  const dialog = 'https://www.facebook.com/dialog/oauth'
    + '?client_id=' + encodeURIComponent(META_APP_ID)
    + '&config_id=' + encodeURIComponent(META_LOGIN_CONFIG_ID)
    + '&redirect_uri=' + encodeURIComponent(IG_LOGIN_REDIRECT_URI)
    + '&response_type=code'
    + '&state=' + encodeURIComponent(signOAuthState(userId));
  return res.redirect(302, dialog);
}));
app.get('/api/instagram/ig-callback', ah(async (req, res) => {
  // The browser landing here usually has no session (system-browser
  // handoff), so every outcome is a friendly result page, not a redirect
  // into the SPA. The user is identified by the signed OAuth state.
  const fail = (reason) => igResultPage(res, 200, { ok: false, title: 'Instagram was not connected', message: IG_LOGIN_REASONS[reason] || IG_LOGIN_REASONS.exchange });
  const failMsg = (message) => igResultPage(res, 200, { ok: false, title: 'Instagram was not connected', message });
  const q = req.query || {};
  if (q.error) return fail('denied');
  // Meta appends a "#_" fragment artifact to the code in some
  // browsers; it can survive into the query value — strip it.
  const code = String(q.code || '').replace(/#_$/, '');
  const userId = userIdFromOAuthState(String(q.state || ''));
  if (!code || !userId) return fail('state');
  if (!unifiedLoginConfigured()) return fail('config');
  // 1) code -> the business system-user token (single documented
  // exchange; the token's lifetime is set by the dashboard
  // configuration, and the keeper learns its real expiry from
  // debug_token immediately below via the force-check).
  let tok = null;
  try {
    tok = await graphGet('https://graph.facebook.com/' + GRAPH_API_VERSION + '/oauth/access_token'
      + '?client_id=' + encodeURIComponent(META_APP_ID)
      + '&client_secret=' + encodeURIComponent(metaAppSecret())
      + '&redirect_uri=' + encodeURIComponent(IG_LOGIN_REDIRECT_URI)
      + '&code=' + encodeURIComponent(code));
  } catch { /* handled below as an exchange failure */ }
  if (!tok || !tok.access_token) return fail('exchange');
  const token = tok.access_token;
  const expiresIn = Number(tok.expires_in) || 0;
  // 2) Discover the shared Instagram account(s): the documented
  // Unified Login edge first — /me is the system user the token
  // belongs to, and assigned_instagram_accounts lists the Instagram
  // professional accounts the login shared with the app.
  let assigned = null;
  try {
    assigned = await graphGet('https://graph.facebook.com/' + GRAPH_API_VERSION + '/me/assigned_instagram_accounts?fields=id,username&access_token=' + encodeURIComponent(token));
  } catch { /* handled below — the Pages fallback still runs */ }
  const assignedList = assigned && Array.isArray(assigned.data) ? assigned.data.filter((a) => a && a.id) : [];
  let igAccount = assignedList.length ? assignedList[0] : null;
  let pageId = null;
  let pageList = [];
  // 3) Fallback: an account that also has a linked Facebook Page
  // resolves through the Pages machinery instead.
  if (!igAccount) {
    const viaPages = await findInstagramAccountViaPages(token);
    pageList = viaPages.pageList;
    if (viaPages.account) { igAccount = viaPages.account; pageId = viaPages.pageId; }
  }
  if (!igAccount) {
    // Diagnostic detail for the owner: what this login actually
    // shared, so an unshared account, a wrong login, or an account
    // missing from the business portfolio is obvious from the page
    // itself. Counts and the user's own Page names only — no tokens.
    const pageNames = pageList.map((p) => (p && p.name ? String(p.name) : '(unnamed Page)')).join(', ');
    return failMsg(
      `Meta did not share an Instagram account for that login (0 Instagram accounts assigned${pageList.length ? `; ${pageList.length} Page${pageList.length !== 1 ? 's' : ''} found${pageNames ? ` — ${pageNames}` : ''}, none with an Instagram account the app can use` : ''}). `
      + 'The account must be an Instagram Business or Creator account: in the Meta login dialog choose “Continue with Instagram” (or the Facebook account that owns the Instagram account) and approve access to it. '
      + 'If the account belongs to a business portfolio, it must be added to that portfolio in Meta Business Settings before it can be shared.'
    );
  }
  const igUserId = String(igAccount.id);
  const username = igAccount.username || '';
  // Multi-account: this ADDS the account to the user's connections (or
  // refreshes it when the same Instagram account reconnects) — an
  // existing connection for a different account is never replaced.
  await db.saveInstagramAccount(userId, {
    token, igUserId, username, pageId,
    connectedAt: new Date().toISOString(),
    tokenExpiresAt: expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : '',
    tokenNeverExpires: false, tokenType: tok.token_type || '', tokenHost: 'facebook',
    lastTokenCheckAt: '', lastRefreshAt: '', tokenRefreshError: '', lastDebugError: '', lastRefreshError: '',
  });
  // Learn the token's real type + exact expiry from Meta right away so
  // the keeper's records are precise from day one.
  await ensureInstagramTokenFresh(userId, { force: true, igUserId }).catch(() => null);
  return igResultPage(res, 200, {
    ok: true,
    title: 'Instagram connected ✓',
    message: username
      ? `@${username} is connected — switch back to the KiluaAI app, it will show Connected. The connection renews itself automatically from here.`
      : 'Your Instagram is connected — switch back to the KiluaAI app, it will show Connected. The connection renews itself automatically from here.',
  });
}));

// ---------- YouTube cross-post (Phase B) ----------
// A CHANNEL connection via Google OAuth — not app sign-in (the app's
// login stays email/password). Env-gated on YOUTUBE_CLIENT_ID +
// YOUTUBE_CLIENT_SECRET: with them absent everything below is inert —
// the status endpoint reports configured:false, connect attempts get a
// clear "not configured" answer, and the publish leg never runs.
// The connect flow mirrors Instagram's: a signed one-time link minted
// by the logged-in app, opened in the system browser (which has no
// session cookie), with the user bound into the signed OAuth state.
const YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_ID || '';
const YOUTUBE_CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET || '';
const YOUTUBE_REDIRECT_URI = process.env.YOUTUBE_REDIRECT_URI || 'https://social-scheduler-one-sandy.vercel.app/api/youtube/callback';
const YOUTUBE_SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly';
function youtubeConfigured() { return !!(YOUTUBE_CLIENT_ID && YOUTUBE_CLIENT_SECRET); }
function signYouTubeConnectToken(userId) {
  const exp = Date.now() + CONNECT_TOKEN_TTL_MS;
  const payload = `ytconnect.${userId}.${crypto.randomBytes(16).toString('hex')}.${exp}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return Buffer.from(payload, 'utf8').toString('base64url') + '.' + sig;
}
function verifyYouTubeConnectToken(token) {
  try {
    if (!token || typeof token !== 'string') return '';
    const dot = token.lastIndexOf('.');
    if (dot < 0) return '';
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const sig = token.slice(dot + 1);
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    const a = Buffer.from(sig, 'utf8'); const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return '';
    const parts = payload.split('.');
    if (parts.length !== 4 || parts[0] !== 'ytconnect' || !parts[1]) return '';
    if (!parts[3] || Number(parts[3]) < Date.now()) return '';
    return parts[1];
  } catch { return ''; }
}
function consumeYouTubeConnectToken(token) {
  const userId = verifyYouTubeConnectToken(token);
  if (!userId) return '';
  let nonce = '';
  try {
    const payload = Buffer.from(String(token).slice(0, String(token).lastIndexOf('.')), 'base64url').toString('utf8');
    nonce = payload.split('.')[2] || '';
  } catch { return ''; }
  if (!nonce) return '';
  const now = Date.now();
  for (const [k, exp] of usedConnectNonces) if (exp <= now) usedConnectNonces.delete(k);
  if (usedConnectNonces.has(nonce)) return '';
  usedConnectNonces.set(nonce, now + CONNECT_TOKEN_TTL_MS);
  return userId;
}
app.get('/api/youtube/status', ah(async (req, res) => {
  const conn = await db.getYouTube(req.userId).catch(() => null);
  res.json({
    ok: true,
    configured: youtubeConfigured(),
    connected: !!conn,
    channelId: (conn && conn.channelId) || '',
    channelTitle: (conn && conn.channelTitle) || '',
    channelThumb: (conn && conn.channelThumb) || '',
    connectedAt: (conn && conn.connectedAt) || '',
  });
}));
app.post('/api/youtube/connect-link', ah(async (req, res) => {
  // Audit hardening L-06: explicit in-handler auth check (see
  // /api/instagram/connect-link).
  if (!req.userId) return res.status(401).json({ ok: false, error: 'Please log in first — your session has expired or you are not logged in.' });
  if (!youtubeConfigured()) return res.status(503).json({ ok: false, error: 'YouTube is not configured on the server yet — the app owner needs to finish the Google setup.' });
  const proto = isSecureRequest(req) ? 'https' : 'http';
  const host = req.get('host') || 'social-scheduler-one-sandy.vercel.app';
  const url = `${proto}://${host}/api/youtube/connect?t=${encodeURIComponent(signYouTubeConnectToken(req.userId))}`;
  res.json({ ok: true, url });
}));
app.get('/api/youtube/connect', ah(async (req, res) => {
  // Self-authenticating like the Instagram connect: session cookie OR
  // a valid one-time connect link.
  let userId = '';
  const sessionUser = await getAuthUser(req).catch(() => null);
  if (sessionUser) userId = sessionUser.id;
  if (!userId && req.query && req.query.t) userId = consumeYouTubeConnectToken(String(req.query.t));
  if (!userId) {
    return igResultPage(res, 401, {
      ok: false,
      title: 'This connect link has expired',
      message: 'Connect links work for 10 minutes. Go back to the KiluaAI app and tap “Connect YouTube” again — or open KiluaAI in this browser, log in, and connect from the Connections page here.',
    });
  }
  if (!youtubeConfigured()) {
    return igResultPage(res, 200, { ok: false, title: 'YouTube is not set up yet', message: 'YouTube connecting is not fully set up on the server yet. Let the app owner know to finish the Google setup.' });
  }
  const dialog = 'https://accounts.google.com/o/oauth2/v2/auth'
    + '?client_id=' + encodeURIComponent(YOUTUBE_CLIENT_ID)
    + '&redirect_uri=' + encodeURIComponent(YOUTUBE_REDIRECT_URI)
    + '&response_type=code'
    + '&scope=' + encodeURIComponent(YOUTUBE_SCOPES)
    + '&access_type=offline'
    + '&prompt=consent'
    + '&state=' + encodeURIComponent(signOAuthState(userId));
  return res.redirect(302, dialog);
}));
app.get('/api/youtube/callback', ah(async (req, res) => {
  const fail = (message) => igResultPage(res, 200, { ok: false, title: 'YouTube was not connected', message });
  const q = req.query || {};
  if (q.error) return fail('Google login was cancelled or not approved, so nothing was connected. Go back to the KiluaAI app and tap “Connect YouTube” to try again.');
  const code = String(q.code || '');
  const userId = userIdFromOAuthState(String(q.state || ''));
  if (!code || !userId) return fail('That login link expired or was already used. Go back to the KiluaAI app and tap “Connect YouTube” — then finish the login in one go.');
  if (!youtubeConfigured()) return fail('YouTube connecting is not fully set up on the server yet. Let the app owner know to finish the Google setup.');
  let tok = null;
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: YOUTUBE_CLIENT_ID, client_secret: YOUTUBE_CLIENT_SECRET, redirect_uri: YOUTUBE_REDIRECT_URI, grant_type: 'authorization_code' }).toString(),
    });
    tok = await r.json().catch(() => null);
    if (!r.ok) tok = null;
  } catch { tok = null; }
  if (!tok || !tok.access_token || !tok.refresh_token) {
    return fail('Google did not complete the connection — no lasting access was granted. Try again and approve all the requested permissions.');
  }
  let channel = null;
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { Authorization: 'Bearer ' + tok.access_token } });
    const j = await r.json().catch(() => null);
    if (j && Array.isArray(j.items) && j.items[0]) channel = j.items[0];
  } catch { /* handled below */ }
  if (!channel || !channel.id) {
    return fail('No YouTube channel was found for that Google account. Create a YouTube channel for the account first (open YouTube once and create the channel), then connect again.');
  }
  const snippet = channel.snippet || {};
  const thumb = (snippet.thumbnails && snippet.thumbnails.default && snippet.thumbnails.default.url) || '';
  const existing = await db.getYouTube(userId).catch(() => null);
  const enc = db.encryptToken(tok.refresh_token);
  await db.saveYouTube({
    userId,
    channelId: String(channel.id),
    channelTitle: String(snippet.title || ''),
    channelThumb: String(thumb || ''),
    refreshTokenEnc: enc.tokenEnc,
    refreshTokenEncrypted: !!enc.encrypted,
    connectedAt: (existing && existing.connectedAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return igResultPage(res, 200, {
    ok: true,
    title: 'YouTube connected ✓',
    message: `${snippet.title ? `“${snippet.title}”` : 'Your channel'} is connected — switch back to the KiluaAI app. In the Studio you can now tick “Also post to YouTube” when scheduling a video.`,
  });
}));
app.post('/api/youtube/disconnect', ah(async (req, res) => {
  await db.deleteYouTube(req.userId);
  res.json({ ok: true });
}));
// Access tokens are minted from the stored refresh token on demand
// and cached briefly in memory (per instance).
const ytAccessCache = new Map(); // userId -> { token, exp }
async function youtubeAccessToken(userId) {
  const cached = ytAccessCache.get(userId);
  if (cached && cached.exp > Date.now() + 30000) return cached.token;
  const conn = await db.getYouTube(userId);
  if (!conn || !conn.refreshTokenEnc) return '';
  const refreshToken = db.decryptToken({ tokenEnc: conn.refreshTokenEnc, encrypted: conn.refreshTokenEncrypted });
  if (!refreshToken) return '';
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: YOUTUBE_CLIENT_ID, client_secret: YOUTUBE_CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.access_token) return '';
  ytAccessCache.set(userId, { token: j.access_token, exp: Date.now() + (Number(j.expires_in) || 3600) * 1000 });
  return j.access_token;
}
// ---------- SSRF guard for user-supplied media URLs (audit V-02) ----------
// At publish time the server fetches a post's mediaUrl, which the post's
// owner supplied — without checks that is a server-side request forgery
// surface (internal services, metadata-adjacent addresses). The guarded
// fetch below enforces: https only; the host must resolve ONLY to public
// addresses (private / loopback / link-local / reserved ranges rejected,
// IP literals checked directly); every redirect hop is re-validated the
// same way; a 15 s ceiling on the whole transfer; and a streamed size
// cap matching the app's largest media limit (UPLOAD_MAX_BYTES, 200 MB).
// Known residual: DNS is re-resolved by fetch itself, so a sub-second
// DNS-rebinding race remains in theory — accepted for this threat model
// (authenticated users only, GET only, body goes to the user's own
// YouTube upload, and the deployment has no credential metadata
// endpoint). Deliberate scoping: 198.18.0.0/15 (benchmarking) is NOT
// blocked — it hosts no internal services on the deployment target,
// while fake-IP DNS resolvers (corporate proxies, privacy DNS) map
// ordinary public hosts into it, so blocking it would break legitimate
// public media fetches behind such resolvers.
function ipIsPrivateOrReserved(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true; // "this network", private, loopback
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT shared address space
    if (a === 169 && b === 254) return true; // link-local (incl. cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF special (incl. NAT64 well-known)
    if (a === 192 && b === 168) return true; // private
    if (ip.startsWith('192.0.2.')) return true; // TEST-NET-1 documentation
    if (ip.startsWith('198.51.100.')) return true; // TEST-NET-2 documentation
    if (ip.startsWith('203.0.113.')) return true; // TEST-NET-3 documentation
    if (a >= 224) return true; // multicast + reserved (240/4) + broadcast
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return true; // unspecified + loopback
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return ipIsPrivateOrReserved(mapped[1]); // IPv4-mapped
    const nat64 = v.match(/^64:ff9b::(\d+\.\d+\.\d+\.\d+)$/);
    if (nat64) return ipIsPrivateOrReserved(nat64[1]); // NAT64 well-known prefix embeds IPv4
    if (/^f[cd]/.test(v)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(v)) return true; // fe80::/10 link-local
    if (v.startsWith('ff')) return true; // multicast
    if (v.startsWith('2001:db8:')) return true; // documentation
    if (v.startsWith('100:')) return true; // 100::/64 discard-only
    return false;
  }
  return true; // not a parseable IP — fail closed
}
async function assertPublicHttpsUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) return null;
  if (net.isIP(host)) return ipIsPrivateOrReserved(host) ? null : u;
  let addrs;
  try { addrs = await dnsPromises.lookup(host, { all: true, verbatim: true }); } catch { return null; }
  if (!addrs || !addrs.length) return null;
  for (const a of addrs) if (ipIsPrivateOrReserved(a.address)) return null;
  return u;
}
const REMOTE_MEDIA_TIMEOUT_MS = 15 * 1000;
const REMOTE_MEDIA_MAX_BYTES = 200 * 1024 * 1024; // == UPLOAD_MAX_BYTES (chunked-upload ceiling)
async function fetchPublicMediaBytes(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= 4; hop++) {
    const u = await assertPublicHttpsUrl(current);
    if (!u) return null;
    let r;
    try {
      r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(REMOTE_MEDIA_TIMEOUT_MS) });
    } catch { return null; }
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc || hop === 4) return null;
      try { current = new URL(loc, u).toString(); } catch { return null; }
      continue; // the next loop iteration re-validates the new hop
    }
    if (!r.ok) return null;
    const declared = Number(r.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > REMOTE_MEDIA_MAX_BYTES) return null;
    try {
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total > REMOTE_MEDIA_MAX_BYTES) { try { await reader.cancel(); } catch { /* already gone */ } return null; }
          chunks.push(Buffer.from(value));
        }
        const buffer = Buffer.concat(chunks, total);
        return buffer.length ? { buffer, contentType: r.headers.get('content-type') || 'video/mp4' } : null;
      }
      const buffer = Buffer.from(await r.arrayBuffer());
      if (!buffer.length || buffer.length > REMOTE_MEDIA_MAX_BYTES) return null;
      return { buffer, contentType: r.headers.get('content-type') || 'video/mp4' };
    } catch { return null; }
  }
  return null;
}
// Read the bytes of a post's media for the YouTube upload: app-stored
// files via /media/<id>, inline data: URLs, or any public https URL
// (OCI bridge copies and link media included). Remote URLs go through
// the SSRF-guarded fetch above (audit V-02).
async function fetchPostMediaBytes(post) {
  const url = String((post && post.mediaUrl) || '');
  const m = url.match(/\/media\/([A-Za-z0-9_-]{6,})/);
  if (m) {
    const f = await db.getMediaFile(m[1]).catch(() => null);
    if (f && f.buffer && f.buffer.length) return { buffer: f.buffer, contentType: f.contentType || 'video/mp4' };
  }
  if (url.startsWith('data:')) {
    const dm = url.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
    if (dm) {
      const buffer = dm[2] ? Buffer.from(dm[3], 'base64') : Buffer.from(decodeURIComponent(dm[3]), 'utf8');
      if (buffer.length) return { buffer, contentType: dm[1] || 'video/mp4' };
    }
    return null;
  }
  if (/^https?:\/\//i.test(url)) {
    // SSRF-guarded fetch (audit V-02): https only, public addresses
    // only, redirects re-validated, 15 s ceiling, 200 MB streamed cap.
    // Anything else (including plain http) reads as "media not readable"
    // to the publish paths, exactly like a failed fetch did before.
    return fetchPublicMediaBytes(url);
  }
  return null;
}
// Resumable upload of one video. Returns the YouTube video id.
// The upload status comes from the post (Phase E): privacyStatus is
// the post's ytVisibility and selfDeclaredMadeForKids its
// ytMadeForKids. A 'public' post published ahead of its scheduled
// time uses YouTube's own scheduling instead — privacyStatus
// 'private' + publishAt, and YouTube flips it public at that time.
// 'unlisted'/'private' upload as-is, with no publishAt. Until Google
// approves the app (audit), YouTube forces every upload to Private
// regardless; the chosen visibility takes effect once it passes.
// Posts saved before ytVisibility existed carry no value and keep
// the historical behaviour (private + publishAt) untouched.
async function uploadVideoToYouTube(userId, post, bytes) {
  const token = await youtubeAccessToken(userId);
  if (!token) throw new Error('the YouTube connection needs reconnecting (Connections page)');
  const yt = (post && post.youtube) || {};
  const caption = String(post.caption || '');
  const title = String(yt.title || caption.split('\n')[0] || 'KiluaAI post').trim().slice(0, 100) || 'KiluaAI post';
  const description = [caption, String(post.hashtags || '')].filter((s) => s && s.trim()).join('\n\n').slice(0, 4900);
  const schedMs = new Date(post.scheduleTime || 0).getTime();
  const futurePublishAt = Number.isFinite(schedMs) && schedMs > Date.now() + 60000 ? new Date(schedMs).toISOString() : '';
  const status = { privacyStatus: 'private', selfDeclaredMadeForKids: post.ytMadeForKids === true };
  if (!YT_VISIBILITIES.includes(post.ytVisibility)) {
    // Legacy post (no visibility stored): private + publishAt, as before.
    if (futurePublishAt) status.publishAt = futurePublishAt;
  } else if (post.ytVisibility === 'public') {
    if (futurePublishAt) status.publishAt = futurePublishAt; // stays 'private' until publishAt
    else status.privacyStatus = 'public';
  } else {
    status.privacyStatus = post.ytVisibility; // 'unlisted' | 'private', no publishAt
  }
  const metadata = { snippet: { title, description }, status };
  const init = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': bytes.contentType || 'video/mp4',
      'X-Upload-Content-Length': String(bytes.buffer.length),
    },
    body: JSON.stringify(metadata),
  });
  if (!init.ok) {
    const j = await init.json().catch(() => null);
    const reason = (j && j.error && j.error.message) || ('HTTP ' + init.status);
    throw new Error('YouTube upload was refused: ' + String(reason).slice(0, 200));
  }
  const location = init.headers.get('location');
  if (!location) throw new Error('YouTube did not start the upload session');
  const put = await fetch(location, {
    method: 'PUT',
    headers: { 'Content-Type': bytes.contentType || 'video/mp4', 'Content-Length': String(bytes.buffer.length) },
    body: bytes.buffer,
  });
  const pj = await put.json().catch(() => null);
  if (!put.ok || !pj || !pj.id) {
    const reason = (pj && pj.error && pj.error.message) || ('HTTP ' + put.status);
    throw new Error('YouTube upload failed: ' + String(reason).slice(0, 200));
  }
  return String(pj.id);
}

// ---------- Instagram import (profile + existing media) ----------
// Runs as a background job so the UI can poll progress. Fetches the profile
// (username, picture, bio, media count) and pages through the account's
// media, saving media into the library and each item into the queue as a
// published post with its original caption and permalink. Followers and DMs
// are NOT imported — Meta does not allow it.
// Jobs are persisted in MongoDB (not memory), so polling survives Vercel
// serverless cold starts. If a run stalls (container frozen), the next
// poll resumes it.
const runningImports = new Set();
async function runInstagramImport(job) {
  if (runningImports.has(job.id)) return;
  runningImports.add(job.id);
  try {
    const ig = await getInstagramCreds({ userId: job.userId });
    if (!ig.token || !ig.igUserId) throw new Error('Instagram is not connected — connect it first.');
    const base = graphApiBase(ig.tokenHost);
    const profile = await graphGet(base + '/' + encodeURIComponent(ig.igUserId) + '?fields=username,profile_picture_url,biography,media_count&access_token=' + encodeURIComponent(ig.token));
    if (!profile || profile.error) throw new Error(friendlyGraphError(profile, 'Instagram rejected the request. The connection may lack permission — reconnect Instagram in Settings and try again.'));
    job.profile = {
      username: profile.username || '',
      profilePictureUrl: profile.profile_picture_url || '',
      biography: profile.biography || '',
      mediaCount: profile.media_count || 0,
    };
    job.updatedAt = new Date().toISOString();
    await db.saveImportJob(job);
    const stored = await db.getInstagram(job.userId);
    await db.saveInstagram(job.userId, { ...stored, username: profile.username || stored.username || '', profile: job.profile, importedAt: new Date().toISOString() });
    const settings = await db.getSettings(job.userId);
    if (profile.username && !settings.instagramHandle) { settings.instagramHandle = profile.username; await db.saveSettings(job.userId, settings); }

    let nextUrl = base + '/' + encodeURIComponent(ig.igUserId) + '/media?fields=id,caption,media_type,media_url,thumbnail_url,timestamp,permalink&limit=50&access_token=' + encodeURIComponent(ig.token);
    let pages = 0;
    // Load the user's existing library + queue ONCE, then dedupe in memory
    // (Sets) — the old code re-read both full lists on every page of 50.
    const existingMedia = await db.listMedia(job.userId, { all: true });
    const existingPosts = await db.listPosts(job.userId, { all: true });
    const seenMediaIds = new Set(existingMedia.map((m) => m.instagramId).filter(Boolean));
    const seenMediaUrls = new Set(existingMedia.map((m) => m.url).filter(Boolean));
    const seenPostIds = new Set(existingPosts.map((p) => p.instagramId).filter(Boolean));
    const seenPostLinks = new Set(existingPosts.map((p) => p.liveUrl).filter(Boolean));
    while (nextUrl && pages < 10) {
      pages++;
      const page = await graphGet(nextUrl);
      if (!page || page.error) throw new Error(friendlyGraphError(page, 'Instagram stopped the import. The token may lack permission.'));
      const items = Array.isArray(page.data) ? page.data : [];
      job.fetched += items.length;
      const newMedia = [];
      const newPosts = [];
      for (const item of items) {
        const mediaUrl = item.media_url || item.thumbnail_url || '';
        const isVideo = item.media_type === 'VIDEO';
        const kind = isVideo ? 'video' : 'image';
        const alreadyMedia = seenMediaIds.has(item.id) || (mediaUrl && seenMediaUrls.has(mediaUrl));
        if (!alreadyMedia && mediaUrl) {
          newMedia.push({
            id: uid('media'), userId: job.userId, url: mediaUrl, title: (item.caption || '').slice(0, 80) || `${item.media_type || 'Post'} ${item.id}`,
            kind, size: 0, duration: 0, folder: 'Instagram import',
            tags: [], favorite: false, usedCount: 0,
            instagramId: item.id, permalink: item.permalink || '', createdAt: item.timestamp || new Date().toISOString(),
          });
          job.importedMedia++;
          seenMediaIds.add(item.id);
          if (mediaUrl) seenMediaUrls.add(mediaUrl);
        }
        const alreadyPost = seenPostIds.has(item.id) || (item.permalink && seenPostLinks.has(item.permalink));
        if (!alreadyPost) {
          newPosts.push({
            id: uid('post'), userId: job.userId,
            mediaUrl, mediaType: kind,
            caption: item.caption || '', hashtags: '', cta: '',
            platform: 'Instagram',
            scheduleTime: item.timestamp || new Date().toISOString(),
            status: 'published', format: isVideo ? 'REELS' : 'FEED',
            liveUrl: item.permalink || '', instagramId: item.id,
            createdAt: new Date().toISOString(),
          });
          job.importedPosts++;
          seenPostIds.add(item.id);
          if (item.permalink) seenPostLinks.add(item.permalink);
        }
      }
      if (newMedia.length) await db.saveMediaBulk(newMedia);
      if (newPosts.length) await db.savePostsBulk(newPosts);
      job.updatedAt = new Date().toISOString();
      await db.saveImportJob(job);
      nextUrl = page.paging && page.paging.next ? page.paging.next : null;
    }
    job.status = 'done';
    job.done = true;
    job.updatedAt = new Date().toISOString();
    job.message = job.fetched === 0
      ? 'No media found on this Instagram account yet — nothing to import.'
      : `Imported ${job.importedMedia} media item${job.importedMedia === 1 ? '' : 's'} and ${job.importedPosts} post${job.importedPosts === 1 ? '' : 's'} from Instagram.`;
  } catch (e) {
    job.status = 'error';
    job.done = true;
    job.updatedAt = new Date().toISOString();
    job.error = e.message || 'Import failed.';
  } finally {
    runningImports.delete(job.id);
    try { await db.saveImportJob(job); } catch { /* job state already saved best-effort */ }
  }
}
app.post('/api/instagram/import', ah(async (req, res) => {
  const ig = await getInstagramCreds(req);
  if (!ig.token || !ig.igUserId) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — connect it first (Settings, or step 1 of the setup wizard).' });
  }
  const job = { id: uid('job'), userId: req.userId, status: 'running', done: false, fetched: 0, importedMedia: 0, importedPosts: 0, profile: null, error: null, message: null, startedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await db.saveImportJob(job);
  runInstagramImport(job); // async — poll GET /api/instagram/import/:jobId
  res.json({ ok: true, jobId: job.id });
}));
app.get('/api/instagram/import/:jobId', ah(async (req, res) => {
  const job = await db.getImportJob(req.userId, req.params.jobId);
  if (!job) return res.status(404).json({ ok: false, error: 'Import job not found — it may have been started before the last redeploy. Start a new import.' });
  // Resume a stalled run: on serverless the container that started the
  // import can freeze after the response; the next poll picks it back up.
  if (job.status === 'running' && !runningImports.has(job.id)) {
    const updatedAt = job.updatedAt ? new Date(job.updatedAt).getTime() : 0;
    if (!updatedAt || Date.now() - updatedAt > 25000) runInstagramImport(job);
  }
  res.json({ ok: true, job });
}));

// ---------- posts ----------
const STATUSES = ['scheduled', 'draft', 'published', 'failed', 'partial'];
const FORMATS = ['REELS', 'FEED', 'STORY'];
const PLATFORMS = ['Instagram', 'YouTube', 'Facebook', 'TikTok'];
function validPostInput(b, { requireMedia = true } = {}) {
  // Field values must be plain strings — an object/array value used to be
  // cast to a string by the database layer and corrupt the saved post.
  const STR_FIELDS = ['mediaUrl', 'mediaType', 'caption', 'hashtags', 'cta', 'platform', 'scheduleTime', 'status', 'format', 'liveUrl', 'posterUrl', 'firstComment'];
  for (const k of STR_FIELDS) if (b[k] !== undefined && typeof b[k] !== 'string') return 'One of the fields in that post is not valid — please try again.';
  // Length caps (production-ready pass, 22 Nov 2026): every other text
  // surface already caps its fields (names 80, template text 2,200, AI
  // topics 600) — post fields were the outlier, accepting a
  // 100,000-character caption in testing. Caps sit at or above the
  // platforms' real limits (YouTube description 5,000, Instagram
  // caption 2,200), so no legitimate post is affected. Link fields are
  // capped only in their http(s) form: data: media is bounded by the
  // 15 MB body limit instead.
  if (b.caption && b.caption.length > 5000) return 'Captions can be at most 5,000 characters — shorten it and try again.';
  if (b.hashtags && b.hashtags.length > 2000) return 'Hashtags can be at most 2,000 characters — remove some and try again.';
  if (b.cta && b.cta.length > 500) return 'The call-to-action can be at most 500 characters — shorten it and try again.';
  if (b.firstComment && b.firstComment.length > 2200) return 'The first comment can be at most 2,200 characters — shorten it and try again.';
  if (b.mediaUrl && /^https?:\/\//i.test(b.mediaUrl) && b.mediaUrl.length > 4096) return 'That media link is too long — paste a shorter link and try again.';
  if (b.posterUrl && /^https?:\/\//i.test(b.posterUrl) && b.posterUrl.length > 4096) return 'That poster link is too long — paste a shorter link and try again.';
  if (b.liveUrl && b.liveUrl.length > 4096) return 'That live link is too long — paste a shorter link and try again.';
  // Drafts are plans: they may be saved without media or a time yet, and
  // the media is added later in Studio. Scheduled posts must have media.
  const needsMedia = requireMedia && (b.status || 'scheduled') !== 'draft';
  if (needsMedia && !b.mediaUrl) return 'Add a media link first — a post needs a video or image URL.';
  if (b.mediaUrl && typeof b.mediaUrl !== 'string') return 'That media link is not valid.';
  if (b.mediaUrl && !/^(https?:\/\/|data:image\/|data:video\/)/i.test(b.mediaUrl)) return 'That media link is not valid — paste a full https:// link to a video or image.';
  // liveUrl is rendered as a clickable href in the UI — only web links,
  // never javascript:/data: payloads.
  if (b.liveUrl && !/^https?:\/\//i.test(b.liveUrl)) return 'That live link is not valid — paste a full https:// link.';
  if (b.status && !STATUSES.includes(b.status)) return 'That post status is not valid.';
  if (b.format && !FORMATS.includes(b.format)) return 'That format is not valid — use REELS, FEED or STORY.';
  if (b.platform && !PLATFORMS.includes(b.platform)) return 'That platform is not valid.';
  if (b.scheduleTime) {
    const d = new Date(b.scheduleTime);
    if (Number.isNaN(d.getTime())) return 'That date/time is not valid — pick a date and time from the calendar picker.';
  }
  if (b.hashtags && b.hashtags.split(/[\s,]+/).filter((t) => t.replace(/^#/, '').trim()).length > 30) return 'Instagram allows at most 30 hashtags per post — remove some and try again.';
  // YouTube cross-post setting (Phase B): a small object, never a
  // string/array; the title is capped at YouTube's 100 characters.
  if (b.youtube !== undefined) {
    if (!b.youtube || typeof b.youtube !== 'object' || Array.isArray(b.youtube)) return 'That YouTube setting is not valid.';
    if (b.youtube.title !== undefined && typeof b.youtube.title !== 'string') return 'That YouTube title is not valid.';
    if (b.youtube.title && b.youtube.title.length > 100) return 'YouTube titles can be at most 100 characters — shorten it and try again.';
  }
  // YouTube visibility + Made for Kids (Phase E): visibility must be
  // one of YouTube's three privacy states; madeForKids a real boolean.
  if (b.ytVisibility !== undefined && !YT_VISIBILITIES.includes(b.ytVisibility)) return 'That YouTube visibility is not valid — use Public, Unlisted or Private.';
  if (b.ytMadeForKids !== undefined && typeof b.ytMadeForKids !== 'boolean') return 'That Made for Kids choice is not valid — answer Yes or No.';
  // First comment (Phase C2): plain text, capped at Instagram's
  // comment length.
  if (b.firstComment && b.firstComment.length > 2200) return 'The first comment is too long — keep it under 2,200 characters.';
  // Platform picker (Phase B revision): at least one platform must
  // be ticked. Checked on create/bulk (full object present); PATCH
  // sends partial bodies, so it is not enforced there.
  if (requireMedia && b.igEnabled === false && !(b.youtube && b.youtube.enabled)) return 'Tick at least one platform — Instagram, YouTube, or both.';
  // Multi-target picker: igTargets is the list of ticked Instagram
  // accounts. It must be a short array of account ids (strings, or
  // { igUserId } objects); an explicitly empty list with no other
  // platform ticked is the same "tick at least one" error.
  if (b.igTargets !== undefined) {
    if (!Array.isArray(b.igTargets) || b.igTargets.length > 10) return 'That Instagram account selection is not valid.';
    for (const t of b.igTargets) {
      const id = typeof t === 'string' ? t : (t && typeof t === 'object' ? (t.igUserId || t.id) : null);
      if (typeof id !== 'string' || !id) return 'That Instagram account selection is not valid.';
    }
    if (requireMedia && b.igTargets.length === 0 && b.igEnabled !== true && !(b.youtube && b.youtube.enabled)) return 'Tick at least one platform — Instagram, YouTube, or both.';
  }
  // Recurrence (Phase C1): only weekly exists in v1.
  if (b.repeat !== undefined && b.repeat !== '' && b.repeat !== 'weekly') return 'That repeat setting is not valid — only weekly repeats are supported.';
  return null;
}
// Normalized YouTube cross-post setting stored on a post.
function normalizeYouTubeSetting(y) {
  if (!y || typeof y !== 'object' || Array.isArray(y)) return { enabled: false, title: '' };
  return { enabled: !!y.enabled, title: typeof y.title === 'string' ? y.title.slice(0, 100) : '' };
}
// YouTube visibility (Phase E): the three privacy states YouTube
// accepts. A post carries ytVisibility + ytMadeForKids; the user's
// settings carry ytDefaultVisibility, which pre-fills new posts.
// Anything unrecognized falls back to 'public' (the user's chosen
// default) — except in the publish leg, where a post saved before
// this feature existed keeps the historical private upload.
const YT_VISIBILITIES = ['public', 'unlisted', 'private'];
function ytVisibilityOf(v) { return YT_VISIBILITIES.includes(v) ? v : 'public'; }
// Which Instagram account a new/edited post targets. An explicitly
// requested account must be one of the user's connected accounts —
// scheduling to an account that is not connected is rejected here, at
// save time, instead of failing mysteriously at publish time. No
// request (the common case) targets the user's DEFAULT account, so
// every post records where it will publish; posts saved before
// multi-account support carry no target and publish via the default.
async function postTargetResolver(userId) {
  const { accounts, defaultIgUserId } = await db.getInstagramAccounts(userId);
  const byId = new Map(accounts.filter((a) => a.igUserId).map((a) => [String(a.igUserId), a]));
  const def = byId.get(String(defaultIgUserId || '')) || accounts.find((a) => a.igUserId) || null;
  const resolveOne = (requested) => {
    if (requested) {
      const a = byId.get(String(requested));
      if (!a) return { error: 'That Instagram account is not connected — connect it in Settings first, or choose a connected account.' };
      return { igAccountId: a.igUserId || '', igAccountUsername: a.username || '' };
    }
    return def ? { igAccountId: def.igUserId || '', igAccountUsername: def.username || '' } : { igAccountId: '', igAccountUsername: '' };
  };
  return {
    resolve: resolveOne,
    // Multi-target: resolve a list of ticked account ids. Every id
    // must be connected (same save-time rule, applied per account);
    // duplicates collapse. An empty array is a valid answer — it
    // means Instagram is unticked for this post.
    resolveMany(requested) {
      const out = [];
      const seen = new Set();
      for (const r of requested || []) {
        const id = typeof r === 'string' ? r : (r && (r.igUserId || r.id)) || '';
        if (!id || seen.has(String(id))) continue;
        const one = resolveOne(id);
        if (one.error) return { error: one.error };
        seen.add(String(id));
        out.push(one);
      }
      return { targets: out };
    },
    // The create/bulk entry point: an igTargets array wins; the
    // legacy single igAccountId (older clients, Bulk's one-account
    // selector) becomes a one-element list; no account field at all
    // targets the default account, exactly as before.
    resolveForBody(b) {
      if (Array.isArray((b || {}).igTargets)) return this.resolveMany(b.igTargets);
      const one = resolveOne((b || {}).igAccountId);
      if (one.error) return { error: one.error };
      return { targets: [one] };
    },
  };
}
// ---------- multi-target post state ----------
// A post publishes to a LIST of Instagram accounts (igTargets). Each
// target carries its own publish state, so one account can be live
// while another is still retrying — and the media bridge copy may
// only be deleted once EVERY target is terminal (see
// maybeDeleteServerCopy). The legacy fields stay mirrored from the
// list (first target -> igAccountId/igAccountUsername, first
// published target -> liveUrl) so older code paths keep working.
function freshTarget(t) {
  return {
    igUserId: (t && (t.igAccountId || t.igUserId)) || '',
    username: (t && (t.igAccountUsername || t.username)) || '',
    status: 'pending', liveUrl: '', error: '', publishedAt: '',
    // igMediaId (batch 3 foundation for #11/#14): the Instagram media
    // id returned by media_publish — the key any future insights /
    // engagement collection must join on. Recorded at publish time;
    // engagement numbers themselves are NOT fetched yet (they need
    // Meta App Review), so nothing downstream may invent them.
    igMediaId: '',
    retryCount: 0, retryPending: false, retryAt: '', containerId: null,
    firstCommentPosted: false,
  };
}
function normalizeTarget(t) {
  const base = freshTarget(t || {});
  if (!t) return base;
  if (['pending', 'publishing', 'published', 'failed'].includes(t.status)) base.status = t.status;
  base.liveUrl = typeof t.liveUrl === 'string' ? t.liveUrl : '';
  base.error = typeof t.error === 'string' ? t.error : '';
  base.publishedAt = typeof t.publishedAt === 'string' ? t.publishedAt : '';
  base.igMediaId = typeof t.igMediaId === 'string' ? t.igMediaId : '';
  base.retryCount = Number.isFinite(t.retryCount) ? t.retryCount : 0;
  base.retryPending = !!t.retryPending;
  base.retryAt = typeof t.retryAt === 'string' ? t.retryAt : '';
  base.containerId = t.containerId || null;
  base.firstCommentPosted = !!t.firstCommentPosted;
  return base;
}
// The post's target list, always as normalized target objects. A
// legacy post (saved before multi-target support) reads as a
// one-element list built from its stored single target + outcome.
function targetsOf(post) {
  if (!post) return [];
  if (Array.isArray(post.igTargets) && post.igTargets.length) return post.igTargets.map(normalizeTarget);
  const status = post.status === 'published' ? 'published' : post.status === 'failed' ? 'failed' : 'pending';
  return [{
    igUserId: post.igAccountId || '', username: post.igAccountUsername || '',
    status,
    liveUrl: status === 'published' ? (post.liveUrl || '') : '',
    error: status === 'failed' ? (post.lastPublishError || '') : '',
    publishedAt: status === 'published' ? (post.publishedAt || '') : '',
    igMediaId: '',
    retryCount: post.retryCount || 0, retryPending: !!post.retryPending, retryAt: post.retryAt || '',
    containerId: post.containerId || null, firstCommentPosted: !!post.firstCommentPosted,
  }];
}
function targetTerminal(t) {
  return t.status === 'published' || (t.status === 'failed' && !t.retryPending);
}
// The post-level status the queue shows, derived from its targets:
// all live -> published; all permanently failed -> failed; a mix of
// live and permanently failed (or live with more still to go) ->
// partial; failures with a retry still armed read as failed, exactly
// as single-account posts always have.
function computeOverallStatus(post, targets) {
  if (!targets.length) return (post && post.status) || 'scheduled';
  const pub = targets.filter((t) => t.status === 'published').length;
  const termFail = targets.filter((t) => t.status === 'failed' && !t.retryPending).length;
  const anyFail = targets.some((t) => t.status === 'failed');
  if (pub === targets.length) return 'published';
  if (termFail === targets.length) return 'failed';
  if (pub > 0 && termFail > 0 && pub + termFail === targets.length) return 'partial';
  if (pub > 0) return 'partial';
  if (anyFail) return 'failed';
  return post && post.status === 'draft' ? 'draft' : 'scheduled';
}
// The full post-level patch for a target list: the list itself, the
// legacy mirrors, and the derived status/retry summary.
function summarizeTargets(post, targets) {
  const first = targets[0] || { igUserId: '', username: '', containerId: null };
  const firstPub = targets.find((t) => t.status === 'published');
  const firstFail = targets.find((t) => t.status === 'failed');
  const retrying = targets
    .filter((t) => t.retryPending && t.retryAt)
    .sort((a, b) => new Date(a.retryAt) - new Date(b.retryAt))[0];
  return {
    igTargets: targets,
    igAccountId: first.igUserId || '',
    igAccountUsername: first.username || '',
    containerId: first.containerId || null,
    liveUrl: firstPub ? (firstPub.liveUrl || '') : ((post && post.liveUrl) || ''),
    // Post-level publish time (batch 3 foundation for #11/#14): the
    // first target's publish moment; once set it is never cleared by
    // later edits, so best-time/analytics data stays truthful.
    publishedAt: firstPub ? (firstPub.publishedAt || (post && post.publishedAt) || '') : ((post && post.publishedAt) || ''),
    lastPublishError: firstFail ? (firstFail.error || '') : '',
    failedAt: firstFail ? ((post && post.failedAt) || new Date().toISOString()) : ((post && post.failedAt) || ''),
    retryPending: !!retrying,
    retryAt: retrying ? retrying.retryAt : '',
    retryCount: targets.reduce((m, t) => Math.max(m, t.retryCount || 0), 0),
    firstCommentPosted: targets.some((t) => t.firstCommentPosted) || !!((post && post.firstCommentPosted)),
    status: computeOverallStatus(post, targets),
  };
}
// ---------- plans (batch 2) ----------
// The four plans from the 2026-11-21 report (§7 item 5), as data.
// accounts = total connected accounts covered (Instagram + YouTube);
// igAccounts = Instagram accounts covered. Free is 2 connected
// accounts with at most 1 Instagram (+ 1 YouTube). fullBridge plans
// (Max/Ultra) get their whole queue's media bridged to the server
// ahead of time and priority in the publish queue; Free/Pro bridge
// only the NEXT due post (the refined server rule, report §3).
const PLANS = {
  free: { id: 'free', name: 'Free', priceInr: 0, accounts: 2, igAccounts: 1, postsPerDay: 2, postsPerMonth: 30, fullBridge: false, aiPerDay: 5 },
  pro: { id: 'pro', name: 'Pro', priceInr: 249, accounts: 3, igAccounts: 3, postsPerDay: Infinity, postsPerMonth: 100, fullBridge: false, aiPerDay: 25 },
  max: { id: 'max', name: 'Max', priceInr: 499, accounts: 10, igAccounts: 10, postsPerDay: Infinity, postsPerMonth: Infinity, fullBridge: true, aiPerDay: 100 },
  ultra: { id: 'ultra', name: 'Ultra', priceInr: 999, accounts: Infinity, igAccounts: Infinity, postsPerDay: Infinity, postsPerMonth: Infinity, fullBridge: true, aiPerDay: Infinity },
};
// Upgrade pricing rule (owner, 2026-11-21) — the ONE place plan
// prices and upgrade math live, so the future Razorpay wiring charges
// exactly what the upgrade screen displays:
//   upgrade   = pay only the difference, max(0, new − current); the
//               upgraded plan starts fresh from the upgrade day (a
//               full new month of the higher plan).
//   downgrade = no refund, no mid-cycle cut; the current higher plan
//               runs to its expiry, then the lower plan begins.
function upgradeQuote(user) {
  const cur = effectivePlanOf(user);
  const prices = {};
  for (const p of Object.values(PLANS)) prices[p.id] = p.priceInr;
  const ser = (n) => (Number.isFinite(n) ? n : null);
  const options = Object.values(PLANS).map((p) => ({
    plan: p.id, name: p.name, priceInr: p.priceInr,
    kind: p.id === cur.id ? 'current' : (PLAN_RANK[p.id] > PLAN_RANK[cur.id] ? 'upgrade' : 'downgrade'),
    chargeInr: Math.max(0, p.priceInr - cur.priceInr),
    // Batch 4: the Pricing tab renders its comparison from this same
    // config, so the limits a visitor reads are the limits the server
    // enforces (null = unlimited, same serialization as planInfoOf).
    limits: { accounts: ser(p.accounts), igAccounts: ser(p.igAccounts), postsPerDay: ser(p.postsPerDay), postsPerMonth: ser(p.postsPerMonth) },
    fullBridge: !!p.fullBridge,
    aiPerDay: ser(p.aiPerDay),
  }));
  return { current: cur.id, currentName: cur.name, currentPriceInr: cur.priceInr, prices, options };
}
const PLAN_RANK = { free: 0, pro: 1, max: 2, ultra: 3 };
// Standing instruction from the owner (2026-11-21): his own app
// accounts are permanent Ultra comps — for testing, no expiry, no
// payment. Keyed by EMAIL so the grant applies to the account
// whenever it exists (an account created later with one of these
// emails is Ultra from its first minute), and the plan system never
// downgrades them: the check runs before plan/expiry/comp-flag logic.
// All THREE of the owner's own addresses are listed: astuugoyal@ is
// his main email, goyaldhiman00@ runs @kiluaai.app, and
// goyalkumar3407@ runs @kiluaai.web + @kiluaai.pro — the last one was
// missing at first, so that login honestly showed Free (fix verified
// by scripts/batch2-test.js owner-comp checks, 2026-11-21).
const OWNER_COMP_EMAILS = ['astuugoyal@gmail.com', 'goyaldhiman00@gmail.com', 'goyalkumar3407@gmail.com'];
const OWNER_COMP_CANONICAL = new Set(OWNER_COMP_EMAILS.map((e) => canonicalEmail(e)));
function isOwnerCompEmail(user) {
  return !!user && OWNER_COMP_CANONICAL.has(canonicalEmail(user.email));
}
// The effective plan for a user doc: the account OWNER is never plan-
// limited (he operates the app; his stored plan field is untouched),
// a comp grant is full Ultra forever, an expired paid plan falls back
// to Free, and anything unknown is Free — the migration-safe default
// for every existing user (their already-queued posts still publish;
// limits bite only on NEW schedules).
function effectivePlanOf(user) {
  if (!user) return PLANS.free;
  if (user.role === 'owner') return PLANS.ultra;
  if (isOwnerCompEmail(user)) return PLANS.ultra;
  if (user.comp) return PLANS.ultra;
  const raw = PLANS[user.plan] ? user.plan : 'free';
  if (raw !== 'free' && user.planExpiresAt && new Date(user.planExpiresAt).getTime() <= Date.now()) return PLANS.free;
  return PLANS[raw];
}
// Plan limits with the owner's per-user override applied: a positive
// postLimitOverride replaces the plan's monthly post cap.
function planLimitsOf(user) {
  const plan = effectivePlanOf(user);
  const limits = { accounts: plan.accounts, igAccounts: plan.igAccounts, postsPerDay: plan.postsPerDay, postsPerMonth: plan.postsPerMonth, fullBridge: plan.fullBridge };
  const o = user ? Number(user.postLimitOverride) : 0;
  if (Number.isFinite(o) && o > 0) limits.postsPerMonth = Math.floor(o);
  return limits;
}
function planInfoOf(user) {
  const plan = effectivePlanOf(user);
  const limits = planLimitsOf(user);
  const ser = (n) => (Number.isFinite(n) ? n : null);
  return {
    plan: plan.id, planName: plan.name,
    basePlan: user && PLANS[user.plan] ? user.plan : 'free',
    comp: !!(user && (user.comp || isOwnerCompEmail(user))),
    planExpiresAt: (user && user.planExpiresAt) || '',
    limits: { accounts: ser(limits.accounts), igAccounts: ser(limits.igAccounts), postsPerDay: ser(limits.postsPerDay), postsPerMonth: ser(limits.postsPerMonth) },
  };
}
// Persist an owner's-email comp grant the first time such an account
// is seen (signup, login, or /me): sets the comp flag, clears any
// expiry, and writes the audit-log entry the owner asked for. The
// effective plan is Ultra via isOwnerCompEmail either way — this only
// makes the grant visible and permanent in the stored record.
async function applyOwnerComp(user) {
  if (!user || !isOwnerCompEmail(user) || user.comp) return user;
  await db.updateUser(user.id, { comp: true, planExpiresAt: '' }).catch(() => null);
  await writeAdminAudit({ id: 'system' }, 'comp-grant', user, 'Owner comp grant — standing instruction: permanent Ultra, no expiry');
  return { ...user, comp: true, planExpiresAt: '' };
}
// ---------- one-time Gmail-alias duplicate cleanup ----------
// Owner-approved (22 Nov 2026): before canonicalization shipped, one
// inbox could hold two accounts — the real one plus an empty +alias
// spelling of it. This cleanup removes ONLY that exact shape, and
// only when every guard holds for a colliding PAIR sharing one
// canonical identity:
//   keeper    — stored address IS the canonical form, and the
//               account HAS content (posts, media or connections);
//   duplicate — stored address is NOT the canonical form, the
//               account is completely EMPTY (zero posts, zero media,
//               zero connections), and it is not the owner account
//               (neither role 'owner' nor the resolved owner id).
// Any other shape — both empty, both with content, no canonical
// keeper, an owner duplicate, 3+ accounts on one identity — is a
// no-op with a log line. The deletion goes through the standard
// deleteUserData cascade and is written to the admin audit log.
// Idempotent by construction: once the empty duplicate is gone the
// collision no longer exists, so every later run finds nothing.
async function userContentCounts(userId) {
  const [posts, media, ig, yt] = await Promise.all([
    db.listPosts(userId, { all: true }).catch(() => []),
    db.listMedia(userId, { all: true }).catch(() => []),
    db.getInstagramAccounts(userId).catch(() => ({ accounts: [] })),
    db.getYouTube(userId).catch(() => null),
  ]);
  return {
    posts: Array.isArray(posts) ? posts.length : 0,
    media: Array.isArray(media) ? media.length : 0,
    connections: ((ig && ig.accounts) ? ig.accounts.length : 0) + (yt ? 1 : 0),
  };
}
async function runGmailAliasCleanup() {
  const users = await db.listUsers();
  const groups = new Map();
  for (const u of users) {
    const c = canonicalEmail(u.email);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(u);
  }
  const ownerId = await db.ownerId().catch(() => null);
  for (const [canon, group] of groups) {
    if (group.length < 2) continue;
    if (group.length > 2) {
      console.log(`[alias-cleanup] ${group.length} accounts share the canonical identity ${canon} — ambiguous, leaving all of them untouched.`);
      continue;
    }
    const [a, b] = group;
    const tryPair = async (keeper, dup) => {
      if (String(keeper.email || '') !== canon) return false;
      if (String(dup.email || '') === canon) return false;
      if (dup.role === 'owner' || (ownerId && dup.id === ownerId)) return false;
      const kc = await userContentCounts(keeper.id);
      if (kc.posts + kc.media + kc.connections <= 0) return false;
      const dc = await userContentCounts(dup.id);
      if (dc.posts + dc.media + dc.connections > 0) return false;
      await db.deleteUserData(dup.id);
      console.log(`[alias-cleanup] Removed empty Gmail-alias duplicate ${dup.email} — canonical identity ${canon} belongs to ${keeper.email} (${kc.posts} posts, ${kc.media} media, ${kc.connections} connections kept).`);
      await writeAdminAudit({ id: 'system' }, 'gmail-alias-cleanup', dup, `Removed empty Gmail-alias duplicate account ${dup.email}; canonical identity ${canon} kept on ${keeper.email}.`);
      return true;
    };
    const done = (await tryPair(a, b)) || (await tryPair(b, a));
    if (!done) console.log(`[alias-cleanup] Canonical collision at ${canon} does not match the guarded empty-duplicate shape — leaving both accounts untouched.`);
  }
}
// Runs at most once per process (the first /api request awaits it);
// on failure the promise resets so a later request can retry — a
// successful run is one-time in effect because the guarded shape no
// longer exists afterwards.
let aliasCleanupPromise = null;
function ensureAliasCleanup() {
  if (!aliasCleanupPromise) {
    aliasCleanupPromise = runGmailAliasCleanup().catch((e) => {
      console.error('[alias-cleanup] check failed:', String((e && e.message) || e).slice(0, 200));
      aliasCleanupPromise = null;
    });
  }
  return aliasCleanupPromise;
}
// ---------- one-time cleanup: the 22 Nov test broadcast ----------
// Owner-approved removal (22 Nov 2026): a Batch-6-era test broadcast
// ("New update bhai" / "Hih") created one announcement notification
// per user at 2026-11-22T07:32:11.5Z. There is no notification-delete
// endpoint, so this guarded boot cleanup removes ONLY records that
// match ALL of: type 'announcement', that exact title, that exact
// message, and a createdAt inside 07:32:00–07:33:00Z that day. It
// fires once — a marker in globalsettings (cleanups
// .testBroadcast20261122) is written after the run, together with ONE
// admin-audit entry carrying the actual deleted count — and it can
// never fire again. Any other shape is left untouched.
async function runTestBroadcastCleanup() {
  const settings = await db.getGlobalSettings();
  if (settings.cleanups && settings.cleanups.testBroadcast20261122) return;
  const lo = Date.parse('2026-11-22T07:32:00.000Z');
  const hi = Date.parse('2026-11-22T07:33:00.000Z');
  const all = await db.listAllNotifications();
  const matches = all.filter((n) => {
    if (!n || n.type !== 'announcement') return false;
    if (n.title !== 'New update bhai' || n.message !== 'Hih') return false;
    const ts = Date.parse(n.createdAt || '');
    return Number.isFinite(ts) && ts >= lo && ts < hi;
  });
  let deleted = 0;
  if (matches.length) deleted = await db.deleteNotificationsByIds(matches.map((n) => n.id));
  console.log(`[broadcast-cleanup] Removed ${deleted} test-broadcast notification(s) (expected 10).`);
  await writeAdminAudit({ id: 'system' }, 'test-broadcast-cleanup', null,
    `Removed ${deleted} test-broadcast notification(s) — title "New update bhai", message "Hih", created 2026-11-22 07:32 UTC window.`);
  await db.saveGlobalSettings({
    cleanups: { ...((settings && settings.cleanups) || {}), testBroadcast20261122: new Date().toISOString() },
  });
  bustGlobalSettingsCache();
}
let broadcastCleanupPromise = null;
function ensureTestBroadcastCleanup() {
  if (!broadcastCleanupPromise) {
    broadcastCleanupPromise = runTestBroadcastCleanup().catch((e) => {
      console.error('[broadcast-cleanup] check failed:', String((e && e.message) || e).slice(0, 200));
      broadcastCleanupPromise = null;
    });
  }
  return broadcastCleanupPromise;
}
// ---------- team / agency foundation (batch 3, Ultra) ----------
// An Ultra workspace owner invites people by email with a limited
// role. An invite binds to the account with that email (at invite
// time if the account exists, otherwise at its next signup/login) —
// and since batch 6 the invite is also EMAILED to that address when
// a sender is configured (the invite API answers emailed: true/false
// honestly). Access is resolved PER REQUEST by the workspace
// middleware below: the member sends an x-workspace-id header naming
// the owner, the server swaps the data scope to the owner's, and the
// role gate decides what the request may do. Roles are enforced
// server-side only — the UI hiding buttons is decoration.
const TEAM_ROLES = ['scheduler', 'viewer'];
const TEAM_MEMBER_CAP = 25;
async function bindTeamInvites(user) {
  if (!user || !user.email) return;
  // Match the invite by the account's stored address AND by its
  // canonical identity, so an invite written to any Gmail spelling of
  // the inbox binds to the one account that inbox owns.
  const emails = new Set([String(user.email || '').trim().toLowerCase(), canonicalEmail(user.email)]);
  for (const em of emails) {
    const invites = await db.listTeamInvitesByEmail(em);
    for (const inv of invites) {
      if (inv.status === 'invited' && !inv.memberUserId) {
        await db.updateTeamInvite(inv.id, { memberUserId: user.id, status: 'active', boundAt: new Date().toISOString() });
      }
    }
  }
}
// How many Instagram accounts the plan covers for THIS user: the
// total-accounts cap minus the YouTube slot when a channel is
// connected, and never more than the Instagram cap.
function igAllowanceOf(limits, ytConnected) {
  const byTotal = Number.isFinite(limits.accounts) ? Math.max(0, limits.accounts - (ytConnected ? 1 : 0)) : Infinity;
  return Math.min(limits.igAccounts, byTotal);
}
async function igAccountContext(userId) {
  const { accounts } = await db.getInstagramAccounts(userId);
  const sorted = [...accounts].sort((a, b) => String(a.connectedAt || '').localeCompare(String(b.connectedAt || '')));
  const yt = await db.getYouTube(userId).catch(() => null);
  return { accounts: sorted, ytConnected: !!yt };
}
// Non-draft posts already counting against the day/month that a new
// post is being scheduled into (counted by the post's own scheduled
// time, so filling next month never eats this month's quota).
async function planUsageCounts(userId, when, { excludePostId = '', extraPosts = [] } = {}) {
  const posts = await db.listPosts(userId, { all: true });
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  let day = 0; let month = 0;
  const consider = (p) => {
    if (!p || p.status === 'draft' || !p.scheduleTime) return;
    if (excludePostId && p.id === excludePostId) return;
    const t = new Date(p.scheduleTime);
    if (Number.isNaN(t.getTime())) return;
    if (monthKey(t) === monthKey(when)) month++;
    if (dayKey(t) === dayKey(when)) day++;
  };
  posts.forEach(consider);
  extraPosts.forEach(consider);
  return { day, month };
}
const UPGRADE_HINT = 'To upgrade, ask the app owner — online payment is coming soon.';
// One schedule-time plan check shared by create, bulk, edit,
// reschedule and the pre-flight endpoint. candidate = {
// scheduleTime, status, igEnabled, targets: [{igAccountId|igUserId}],
// excludePostId }. Returns { ok:true, plan } or { ok:false, error,
// kind, plan } — the error always names the limit and the way out
// (satisfaction rule: never a dead end).
async function planScheduleCheck(userId, candidate, { extraPosts = [] } = {}) {
  const user = await db.getUserById(userId);
  const plan = effectivePlanOf(user);
  const limits = planLimitsOf(user);
  const info = planInfoOf(user);
  const fail = (error, kind) => ({ ok: false, error, kind, plan: info });
  if (candidate.igEnabled !== false) {
    const targetIds = [...new Set((candidate.targets || []).map((t) => String((t && (t.igAccountId || t.igUserId)) || '')).filter(Boolean))];
    if (targetIds.length) {
      const { accounts, ytConnected } = await igAccountContext(userId);
      const igCap = igAllowanceOf(limits, ytConnected);
      if (targetIds.length > igCap) {
        return fail(`Your ${plan.name} plan covers up to ${igCap} Instagram account${igCap === 1 ? '' : 's'} per post, but this post targets ${targetIds.length}. Untick the extra accounts, or upgrade for more (Pro covers 3 accounts, Max 10, Ultra unlimited). ${UPGRADE_HINT}`, 'accounts');
      }
      const covered = new Set(accounts.slice(0, Number.isFinite(igCap) ? igCap : accounts.length).map((a) => String(a.igUserId)));
      const outside = targetIds.find((id) => !covered.has(id));
      if (outside) {
        const acc = accounts.find((a) => String(a.igUserId) === outside);
        return fail(`@${(acc && acc.username) || outside} is not covered by your ${plan.name} plan — it covers your first ${igCap === Infinity ? 'connected accounts (all of them)' : `${igCap} connected Instagram account${igCap === 1 ? '' : 's'}`}. Post to a covered account, disconnect an account you no longer use, or upgrade your plan. ${UPGRADE_HINT}`, 'accounts');
      }
    }
  }
  if (candidate.status !== 'draft' && candidate.scheduleTime) {
    const when = new Date(candidate.scheduleTime);
    if (!Number.isNaN(when.getTime())) {
      const counts = await planUsageCounts(userId, when, { excludePostId: candidate.excludePostId || '', extraPosts });
      if (Number.isFinite(limits.postsPerDay) && counts.day >= limits.postsPerDay) {
        return fail(`Your ${plan.name} plan allows ${limits.postsPerDay} posts on one day, and that day already has ${counts.day}. Move this post to another day, or upgrade — Pro has no daily cap (100 posts a month) and Max/Ultra are unlimited. ${UPGRADE_HINT}`, 'daily');
      }
      if (Number.isFinite(limits.postsPerMonth) && counts.month >= limits.postsPerMonth) {
        return fail(`Your ${plan.name} plan allows ${limits.postsPerMonth} posts in a month, and that month already has ${counts.month}. Move this post to another month, or upgrade — Pro allows 100 posts a month and Max/Ultra are unlimited. ${UPGRADE_HINT}`, 'monthly');
      }
    }
  }
  return { ok: true, plan: info };
}
function planDeny(res, check) {
  return res.status(403).json({ ok: false, code: 'PLAN_LIMIT', error: check.error, plan: check.plan });
}
// Server-rule bridge preparation (report §3): a scheduled post whose
// media still lives in an inline data: URL has no server copy yet.
// Max/Ultra queues are bridged in full ahead of time; Free/Pro bridge
// only the single next-due post, so the server holds almost nothing
// for free users. Runs inside the existing cron passes (no new
// infrastructure); publishing itself re-checks at publish time, so a
// post that was never pre-bridged still publishes.
async function prepareBridges(userId, base) {
  const user = await db.getUserById(userId).catch(() => null);
  const plan = effectivePlanOf(user);
  const posts = await db.listPosts(userId, { all: true });
  const pending = posts
    .filter((p) => p.status === 'scheduled' && typeof p.mediaUrl === 'string' && p.mediaUrl.startsWith('data:'))
    .sort((a, b) => new Date(a.scheduleTime || 0) - new Date(b.scheduleTime || 0));
  const chosen = planLimitsOf(user).fullBridge ? pending : pending.slice(0, 1);
  for (const p of chosen) await ensurePublishableMedia(userId, p, base).catch(() => null);
  return chosen.length;
}

function buildPost(b, userId, targets = [], ytDefaultVisibility = '') {
  // Status and liveUrl are server-owned: a post becomes "published"
  // only through the publish flow, which also sets the real liveUrl
  // from Instagram. A client-supplied status/liveUrl is ignored, so a
  // post can never be created straight into a fake "published" state
  // (the only client choice kept is draft vs scheduled, as in Studio).
  const status = b.status === 'draft' ? 'draft' : 'scheduled';
  const igTargets = (targets || []).map(freshTarget);
  return {
    id: uid('post'), userId,
    mediaUrl: b.mediaUrl,
    mediaType: b.mediaType || 'video',
    caption: b.caption || '',
    hashtags: b.hashtags || '',
    cta: b.cta || '',
    platform: b.platform || 'Instagram',
    // The Instagram accounts this post will publish to (multi-
    // target): resolved server-side from the composer's ticks or the
    // default. The first target stays mirrored onto the legacy
    // single-account fields for older code paths.
    igTargets,
    igAccountId: igTargets.length ? igTargets[0].igUserId : '',
    igAccountUsername: igTargets.length ? igTargets[0].username : '',
    // Drafts may have no time yet; scheduled posts default to now.
    scheduleTime: b.scheduleTime || (status === 'draft' ? '' : new Date().toISOString()),
    status,
    format: b.format || 'REELS',
    liveUrl: '',
    // Poster frame for video posts (captured client-side at upload).
    // Only app-served or web URLs are kept — anything else is dropped.
    posterUrl: typeof b.posterUrl === 'string' && b.posterUrl.length <= 2000 && /^(\/|https?:\/\/)/i.test(b.posterUrl) ? b.posterUrl : '',
    // YouTube cross-post (Phase B): { enabled, title } + outcome fields
    // the publish leg fills in (youtubeVideoId / youtubeStatus /
    // youtubeError start empty).
    youtube: normalizeYouTubeSetting(b.youtube),
    youtubeVideoId: '', youtubeStatus: '', youtubeError: '',
    // YouTube visibility + Made for Kids (Phase E): an explicit choice
    // on the post wins; otherwise the user's saved default applies
    // (ytVisibilityOf falls back to 'public'). Made for Kids defaults
    // to No — YouTube asks for every video, story videos are not
    // made for kids.
    ytVisibility: b.ytVisibility !== undefined ? ytVisibilityOf(b.ytVisibility) : ytVisibilityOf(ytDefaultVisibility),
    ytMadeForKids: b.ytMadeForKids === true,
    // Platform picker (Phase B revision): Instagram is ticked unless
    // explicitly unticked; a YouTube-only post publishes straight to
    // YouTube with no Instagram leg. With the multi-target picker an
    // explicitly empty tick list also means Instagram is unticked.
    igEnabled: b.igEnabled === false ? false : (Array.isArray(b.igTargets) ? igTargets.length > 0 : true),
    // First comment (Phase C2): posted as a comment right after a
    // successful publish; firstCommentPosted records that it landed.
    firstComment: typeof b.firstComment === 'string' ? b.firstComment.slice(0, 2200) : '',
    firstCommentPosted: false,
    // Recurrence (Phase C1): 'weekly' or ''. seriesId links the
    // occurrences; nextOccurrenceId on a published occurrence guards
    // against ever spawning twice (retries included).
    repeat: b.repeat === 'weekly' ? 'weekly' : '',
    seriesId: '', nextOccurrenceId: '',
    createdAt: new Date().toISOString(),
  };
}
app.get('/api/posts', ah(async (req, res) => {
  const posts = await db.listPosts(req.userId, { limit: req.query.limit, offset: req.query.offset });
  // Legacy posts whose media is still an inline data: URL are migrated
  // to the media-file store on first read (same one-time migration the
  // publish path performs), so the Queue stops re-downloading whole
  // files as base64 on every load.
  const base = publicBase(req);
  const out = [];
  for (const p of posts) {
    if (typeof p.mediaUrl === 'string' && p.mediaUrl.startsWith('data:') && p.mediaUrl.length >= LEGACY_DATA_URL_MIN) {
      out.push(await ensurePublishableMedia(req.userId, p, base));
    } else out.push(p);
  }
  res.json({ ok: true, posts: out });
}));
app.post('/api/posts', ah(async (req, res) => {
  const b = req.body || {};
  const err = validPostInput(b);
  if (err) return res.status(400).json({ ok: false, error: err });
  const resolver = await postTargetResolver(req.userId);
  const resolved = resolver.resolveForBody(b);
  if (resolved.error) return res.status(400).json({ ok: false, error: resolved.error });
  const mediaErr = await deadStoredMediaError(req.userId, b.mediaUrl);
  if (mediaErr) return res.status(400).json({ ok: false, error: mediaErr });
  // Plan limits (batch 2): enforced at schedule time with the reason
  // and the way out in the message — never a dead-end error.
  const planCheck = await planScheduleCheck(req.userId, {
    scheduleTime: b.scheduleTime || new Date().toISOString(),
    status: b.status === 'draft' ? 'draft' : 'scheduled',
    igEnabled: b.igEnabled === false ? false : (Array.isArray(b.igTargets) ? resolved.targets.length > 0 : true),
    targets: resolved.targets,
  });
  if (!planCheck.ok) return planDeny(res, planCheck);
  const settings = await db.getSettings(req.userId);
  const post = buildPost(b, req.userId, resolved.targets, settings && settings.ytDefaultVisibility);
  await db.savePost(post);
  res.json({ ok: true, post });
}));
// Pre-flight check (batch 2, improvement #2): one pass BEFORE saving —
// connection healthy? media present and alive? within plan limits? —
// so the Studio can show green/red with the exact problem and its fix
// instead of the user discovering trouble at publish time. Advisory:
// saving still re-runs the real enforcement.
app.post('/api/posts/preflight', ah(async (req, res) => {
  const b = req.body || {};
  const checks = [];
  const resolver = await postTargetResolver(req.userId);
  const resolved = resolver.resolveForBody(b);
  const igEnabled = b.igEnabled === false ? false : (Array.isArray(b.igTargets) ? (resolved.targets || []).length > 0 : true);
  const ytEnabled = !!(b.youtube && b.youtube.enabled);
  // --- connection ---
  if (resolved.error) {
    checks.push({ id: 'connection', ok: false, message: resolved.error, fix: 'Connect that account on the Connections page, then check again.' });
  } else if (!igEnabled && !ytEnabled) {
    checks.push({ id: 'connection', ok: false, message: 'No platform is ticked for this post.', fix: 'Tick Instagram or YouTube in Step 3.' });
  } else {
    let connOk = true; let connMsg = ''; let connFix = '';
    if (igEnabled) {
      const { accounts } = await db.getInstagramAccounts(req.userId);
      if (!accounts.length) { connOk = false; connMsg = 'Instagram is not connected yet.'; connFix = 'Connect Instagram on the Connections page, then check again.'; }
      else {
        const ids = [...new Set((resolved.targets || []).map((t) => String(t.igAccountId || '')).filter(Boolean))];
        const broken = ids.map((id) => accounts.find((a) => String(a.igUserId) === id)).find((a) => a && a.tokenRefreshError === 'revoked-or-expired');
        if (broken) { connOk = false; connMsg = `The connection for @${broken.username || ''} is broken — posts to it cannot publish.`; connFix = 'Reconnect that account on the Connections page (one tap), then check again.'; }
        else connMsg = 'Instagram connection is healthy.';
      }
    }
    if (connOk && ytEnabled) {
      const yt = await db.getYouTube(req.userId).catch(() => null);
      if (!yt) { connOk = false; connMsg = 'YouTube is not connected yet.'; connFix = 'Connect YouTube on the Connections page, then check again.'; }
      else connMsg = connMsg ? `${connMsg} YouTube is connected.` : 'YouTube is connected.';
    }
    checks.push({ id: 'connection', ok: connOk, message: connMsg, fix: connFix });
  }
  // --- media ---
  if (!b.mediaUrl) {
    checks.push({ id: 'media', ok: false, message: 'No media added yet.', fix: 'Pick a file or paste a link in Step 1.' });
  } else {
    const dead = await deadStoredMediaError(req.userId, b.mediaUrl);
    if (dead) checks.push({ id: 'media', ok: false, message: dead, fix: 'Upload the file again in Media Library, then pick the fresh copy.' });
    else if (String(b.mediaUrl).startsWith('data:')) checks.push({ id: 'media', ok: true, message: 'Media is ready — a server copy is made before publishing.' });
    else checks.push({ id: 'media', ok: true, message: 'Media is ready.' });
  }
  // --- plan ---
  const status = b.status === 'draft' ? 'draft' : 'scheduled';
  const user = await db.getUserById(req.userId);
  const info = planInfoOf(user);
  if (status === 'draft') {
    checks.push({ id: 'plan', ok: true, message: 'Drafts do not count towards plan limits.' });
  } else {
    const chk = await planScheduleCheck(req.userId, {
      scheduleTime: b.scheduleTime || new Date().toISOString(),
      status,
      igEnabled,
      targets: resolved.targets || [],
      excludePostId: typeof b.excludePostId === 'string' ? b.excludePostId : '',
    });
    if (chk.ok) {
      const when = new Date(b.scheduleTime || Date.now());
      const counts = await planUsageCounts(req.userId, when, { excludePostId: typeof b.excludePostId === 'string' ? b.excludePostId : '' });
      const lim = info.limits.postsPerMonth;
      checks.push({ id: 'plan', ok: true, message: `Within your ${info.planName} plan — ${counts.month}${lim ? ` of ${lim}` : ''} posts already in that month.` });
    } else {
      checks.push({ id: 'plan', ok: false, message: chk.error, fix: 'Move the post to another day or month, or upgrade your plan.' });
    }
  }
  res.json({ ok: checks.every((c) => c.ok), checks, plan: info });
}));
// My Plan data (batch 2): the caller's effective plan + live usage —
// posts today/this month (same counting the limits enforce, so the
// meters always agree with enforcement) and connected accounts.
app.get('/api/plan/usage', ah(async (req, res) => {
  const user = await db.getUserById(req.userId);
  const counts = await planUsageCounts(req.userId, new Date());
  const { accounts, ytConnected } = await igAccountContext(req.userId);
  const aiCap = effectivePlanOf(user).aiPerDay;
  const aiUsed = aiUsageOf(user).count;
  res.json({
    ok: true,
    plan: planInfoOf(user),
    ai: { perDay: Number.isFinite(aiCap) ? aiCap : null, usedToday: aiUsed, remaining: Number.isFinite(aiCap) ? Math.max(0, aiCap - aiUsed) : null },
    pricing: upgradeQuote(user),
    usage: {
      postsToday: counts.day,
      postsThisMonth: counts.month,
      instagramConnected: accounts.length,
      youtubeConnected: ytConnected,
      accountsConnected: accounts.length + (ytConnected ? 1 : 0),
    },
  });
}));
// Bulk import: one request for many rows instead of one request per row
// (a 100-row CSV used to take 100 round trips and often timed out).
app.post('/api/posts/bulk', ah(async (req, res) => {
  const rows = Array.isArray(req.body?.posts) ? req.body.posts : null;
  if (!rows) return res.status(400).json({ ok: false, error: 'Send a list of posts to import.' });
  if (rows.length > 500) return res.status(400).json({ ok: false, error: 'Import at most 500 posts at a time.' });
  const valid = [];
  const errors = [];
  const resolver = await postTargetResolver(req.userId);
  const settings = await db.getSettings(req.userId);
  for (let i = 0; i < rows.length; i++) {
    const b = rows[i];
    const err = validPostInput(b || {});
    if (err) { errors.push(`Row ${i + 1}: ${err}`); continue; }
    const resolved = resolver.resolveForBody(b || {});
    if (resolved.error) { errors.push(`Row ${i + 1}: ${resolved.error}`); continue; }
    const mediaErr = await deadStoredMediaError(req.userId, (b || {}).mediaUrl);
    if (mediaErr) { errors.push(`Row ${i + 1}: ${mediaErr}`); continue; }
    // Plan limits per row, counted cumulatively over the rows this
    // import has already accepted (batch 2).
    const planCheck = await planScheduleCheck(req.userId, {
      scheduleTime: b.scheduleTime || new Date().toISOString(),
      status: b.status === 'draft' ? 'draft' : 'scheduled',
      igEnabled: b.igEnabled === false ? false : (Array.isArray(b.igTargets) ? resolved.targets.length > 0 : true),
      targets: resolved.targets,
    }, { extraPosts: valid });
    if (!planCheck.ok) { errors.push(`Row ${i + 1}: ${planCheck.error}`); continue; }
    valid.push(buildPost(b, req.userId, resolved.targets, settings && settings.ytDefaultVisibility));
  }
  if (valid.length) await db.savePostsBulk(valid);
  res.json({ ok: true, imported: valid.length, failed: rows.length - valid.length, errors: errors.slice(0, 10) });
}));
app.patch('/api/posts/:id', ah(async (req, res) => {
  const b = req.body || {};
  const err = validPostInput(b, { requireMedia: false });
  if (err) return res.status(400).json({ ok: false, error: err });
  // liveUrl is deliberately NOT editable here (see buildPost): it is
  // set only by a real publish. Status may move between draft and
  // scheduled (the Studio edit), never into published/failed — those
  // belong to the publish flow alone.
  const allowed = ['mediaUrl', 'mediaType', 'caption', 'hashtags', 'cta', 'platform', 'scheduleTime', 'format', 'posterUrl', 'firstComment'];
  const patch = {};
  for (const k of allowed) if (b[k] !== undefined) patch[k] = b[k];
  if (b.youtube !== undefined) patch.youtube = normalizeYouTubeSetting(b.youtube);
  if (b.ytVisibility !== undefined) patch.ytVisibility = ytVisibilityOf(b.ytVisibility);
  if (b.ytMadeForKids !== undefined) patch.ytMadeForKids = b.ytMadeForKids === true;
  if (b.repeat !== undefined) patch.repeat = b.repeat === 'weekly' ? 'weekly' : '';
  if (b.igEnabled !== undefined) patch.igEnabled = b.igEnabled === false ? false : true;
  // Multi-target edit: the Studio sends the ticked account list.
  // Existing targets keep their publish state (a live account stays
  // live); newly ticked accounts start pending; unticked ones drop
  // off. The post-level fields are re-derived from the list.
  if (b.igTargets !== undefined) {
    const current = await db.getPost(req.params.id);
    if (!current || current.userId !== req.userId) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted. Refresh the queue.' });
    const resolver = await postTargetResolver(req.userId);
    const resolved = resolver.resolveMany(b.igTargets);
    if (resolved.error) return res.status(400).json({ ok: false, error: resolved.error });
    const existing = targetsOf(current);
    const merged = resolved.targets.map((r) => {
      const prev = existing.find((t) => t.igUserId === r.igAccountId);
      return prev ? { ...prev, username: r.igAccountUsername || prev.username } : freshTarget(r);
    });
    Object.assign(patch, summarizeTargets(current, merged));
    if (b.igEnabled === undefined) patch.igEnabled = merged.length > 0;
  }
  // Retargeting a post to another connected account (multi-account):
  // the account must be connected; an empty value clears the target
  // (the post then publishes via the default account). The legacy
  // field also rewrites the target list so the two stay in step.
  if (b.igAccountId !== undefined) {
    if (!b.igAccountId) { patch.igAccountId = ''; patch.igAccountUsername = ''; patch.igTargets = [freshTarget({})]; }
    else {
      const resolver = await postTargetResolver(req.userId);
      const target = resolver.resolve(b.igAccountId);
      if (target.error) return res.status(400).json({ ok: false, error: target.error });
      patch.igAccountId = target.igAccountId;
      patch.igAccountUsername = target.igAccountUsername;
      patch.igTargets = [freshTarget(target)];
    }
  }
  if (b.status === 'draft' || b.status === 'scheduled') patch.status = b.status;
  // Same poster rule as buildPost: only app-served or web URLs survive.
  if (patch.posterUrl !== undefined && !/^(\/|https?:\/\/)/i.test(patch.posterUrl || '')) patch.posterUrl = '';
  // Pointing a post at a stored copy that is already gone (removed
  // after its first publish) would only fail later at publish time —
  // refuse it here with the reason.
  if (patch.mediaUrl !== undefined) {
    const mediaErr = await deadStoredMediaError(req.userId, patch.mediaUrl);
    if (mediaErr) return res.status(400).json({ ok: false, error: mediaErr });
  }
  // Plan limits (batch 2): an edit that leaves the post scheduled —
  // newly scheduled, moved, or retargeted — is checked against the
  // plan, excluding the post itself. Quiet edits to an already-
  // scheduled post (caption only) are not re-checked.
  const touchesSchedule = patch.status !== undefined || patch.scheduleTime !== undefined || patch.igTargets !== undefined || patch.igAccountId !== undefined;
  if (touchesSchedule) {
    const current = await db.getPost(req.userId, req.params.id);
    if (!current) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted. Refresh the queue.' });
    const nextStatus = patch.status !== undefined ? patch.status : current.status;
    if (nextStatus === 'scheduled') {
      const nextTargets = patch.igTargets !== undefined ? patch.igTargets : targetsOf(current);
      const planCheck = await planScheduleCheck(req.userId, {
        scheduleTime: patch.scheduleTime !== undefined ? patch.scheduleTime : current.scheduleTime,
        status: 'scheduled',
        igEnabled: patch.igEnabled !== undefined ? patch.igEnabled : current.igEnabled,
        targets: nextTargets,
        excludePostId: current.id,
      });
      if (!planCheck.ok) return planDeny(res, planCheck);
    }
  }
  const updated = await db.updatePost(req.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted. Refresh the queue.' });
  res.json({ ok: true, post: updated });
}));
app.delete('/api/posts/:id', ah(async (req, res) => {
  const ok = await db.deletePost(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'That post no longer exists.' });
  res.json({ ok: true });
}));
// Duplicate a post: a fresh copy, saved as a draft, "(copy)" in the caption.
// The copy must not carry the original's Instagram identity or publish
// container, or it would confuse imports and re-publishes.
app.post('/api/posts/:id/duplicate', ah(async (req, res) => {
  const orig = await db.getPost(req.userId, req.params.id);
  if (!orig) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  // A copy of a post whose stored media was removed after publishing
  // could never publish — say so now instead of creating a doomed draft.
  const dupMediaErr = await deadStoredMediaError(req.userId, orig.mediaUrl);
  if (dupMediaErr) return res.status(400).json({ ok: false, error: dupMediaErr });
  const copy = {
    ...orig,
    id: uid('post'),
    userId: req.userId,
    caption: `${orig.caption || ''} (copy)`.trim(),
    status: 'draft',
    liveUrl: '',
    instagramId: undefined,
    containerId: undefined,
    createdAt: new Date().toISOString(),
  };
  // Same accounts as the original, but every target starts fresh —
  // the copy has published nothing yet.
  copy.igTargets = targetsOf(orig).map(freshTarget);
  delete copy.instagramId;
  delete copy.containerId;
  await db.savePost(copy);
  res.json({ ok: true, post: copy });
}));
// Reschedule: { scheduleTime } or { addDays } (e.g. +1 day).
app.post('/api/posts/:id/reschedule', ah(async (req, res) => {
  const post = await db.getPost(req.userId, req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  let next;
  if (req.body && req.body.scheduleTime) {
    next = new Date(req.body.scheduleTime);
  } else if (req.body && Number.isFinite(Number(req.body.addDays))) {
    const base = post.scheduleTime ? new Date(post.scheduleTime) : new Date();
    next = new Date(base.getTime() + Number(req.body.addDays) * 86400000);
  } else {
    return res.status(400).json({ ok: false, error: 'Give a new date/time, or a number of days to move it by.' });
  }
  if (Number.isNaN(next.getTime())) return res.status(400).json({ ok: false, error: 'That date/time is not valid — pick a date and time from the calendar picker.' });
  const patch = { scheduleTime: next.toISOString() };
  // Plan limits (batch 2): moving a scheduled post — or reviving a
  // finished one — into a new slot is checked against the plan,
  // excluding the post itself.
  if (post.status === 'scheduled' || post.status === 'published' || post.status === 'failed' || post.status === 'partial') {
    const planCheck = await planScheduleCheck(req.userId, {
      scheduleTime: patch.scheduleTime,
      status: 'scheduled',
      igEnabled: post.igEnabled,
      targets: targetsOf(post),
      excludePostId: post.id,
    });
    if (!planCheck.ok) return planDeny(res, planCheck);
  }
  // A published/failed/partial post moved to a new time goes back to
  // the queue, with every target reset so it publishes again.
  if (post.status === 'published' || post.status === 'failed' || post.status === 'partial') {
    // Reviving a post whose stored media copy is gone can never
    // publish — refuse with the reason instead of re-queueing a dud.
    const mediaErr = await deadStoredMediaError(req.userId, post.mediaUrl);
    if (mediaErr) return res.status(400).json({ ok: false, error: mediaErr });
    patch.status = 'scheduled';
    patch.liveUrl = '';
    patch.igTargets = targetsOf(post).map(freshTarget);
  }
  const updated = await db.updatePost(req.userId, req.params.id, patch);
  res.json({ ok: true, post: updated });
}));
// Next free 7:00 PM slot, computed from the user's own saved posts only:
// the first day in the next 14 days with no scheduled/draft post at 7pm
// (server local time; the Studio UI recomputes the same in browser time).
app.get('/api/next-best-time', ah(async (req, res) => {
  const posts = await getPosts(req);
  const taken = new Set();
  for (const p of posts) {
    if (!p.scheduleTime || (p.status !== 'scheduled' && p.status !== 'draft')) continue;
    const d = new Date(p.scheduleTime);
    if (Number.isNaN(d.getTime())) continue;
    taken.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`);
  }
  const now = new Date();
  for (let day = 0; day < 14; day++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, 19, 0, 0, 0);
    if (cand.getTime() <= now.getTime()) continue;
    const key = `${cand.getFullYear()}-${cand.getMonth()}-${cand.getDate()}-19`;
    if (!taken.has(key)) {
      return res.json({ ok: true, suggestedTime: cand.toISOString(), reason: 'Next free 7:00 PM slot in your own schedule — no post is scheduled then.' });
    }
  }
  return res.json({ ok: true, suggestedTime: null, reason: 'No free 7:00 PM slot in the next 14 days.' });
}));

// ---------- Instagram publish (Graph API) ----------
// media_type "REELS" (NOT "REEL"), container -> FINISHED -> media_publish.
// Vercel Hobby functions stop at 60s, so polling is capped at ~45s and the
// container id is saved on the post: if publishing is still processing,
// pressing Publish again resumes the same container instead of making a
// duplicate. FEED videos use media_type VIDEO and Stories use STORIES —
// sending a video as an image container was a publish failure.
async function graph(path, method, body, base) {
  const url = `${base || 'https://graph.facebook.com/v27.0'}${path}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  return res.json().catch(() => null);
}
function publishContainerBody(post, token) {
  const isReel = (post.format || 'REELS') === 'REELS';
  const isStory = post.format === 'STORY';
  const isVideo = post.mediaType !== 'image';
  const caption = [post.caption, post.hashtags ? post.hashtags.split(/[\s,]+/).filter(Boolean).map((h) => (h.startsWith('#') ? h : '#' + h)).join(' ') : ''].filter(Boolean).join('\n');
  if (isReel) return { media_type: 'REELS', video_url: post.mediaUrl, caption, access_token: token };
  if (isStory) return isVideo
    ? { media_type: 'STORIES', video_url: post.mediaUrl, caption, access_token: token }
    : { media_type: 'STORIES', image_url: post.mediaUrl, caption, access_token: token };
  return isVideo
    ? { media_type: 'VIDEO', video_url: post.mediaUrl, caption, access_token: token }
    : { image_url: post.mediaUrl, caption, access_token: token };
}
// In-app notification (publish success/failure). Best-effort by
// design: a notification write must never break a publish.
async function notifyUser(userId, type, postId, message) {
  try {
    await db.saveNotification({
      id: uid('ntf'), userId, type, postId: postId || '',
      message: String(message || '').slice(0, 300), createdAt: new Date().toISOString(),
    });
  } catch { /* notifications are a nicety */ }
}
const AUTO_RETRY_DELAY_MS = 15 * 60 * 1000;
// Mark a post failed after a publish attempt. The FIRST failure arms
// the one automatic retry (~15 minutes later, run by publish-due /
// cron): retryPending + retryAt are set here, duePostsFor picks the
// post up when retryAt passes, and retryCount records how many
// automatic retries have been consumed so a post can never loop. A
// failure of the automatic retry itself (isAutoRetry) is final.
// Plain-language failure explanations (Phase C5): map the raw
// publish error strings the pipeline produces onto a human reason.
// Returns '' when nothing matches (callers then show the raw error).
// The frontend carries the same mapping for Queue rows
// (frontend/src/components/shared.jsx — keep the two in step).
function friendlyFailureText(error) {
  const s = String(error || '');
  if (/not connected|no longer connected|connect Instagram/i.test(s)) return 'The Instagram account for this post is not connected. Reconnect it on the Connections page, then publish again.';
  if (/token|session|OAuth|expired|revoked|authoriz/i.test(s)) return 'Instagram ended the login for this account. Reconnect Instagram on the Connections page, then publish again.';
  if (/permission|scope|not authorized|does not have/i.test(s)) return 'Instagram did not give this app permission for that action. Reconnect Instagram on the Connections page and approve all permissions, then publish again.';
  if (/rate|too many|throttl|limit/i.test(s)) return 'Instagram is rate-limiting right now. Wait a while, then publish again.';
  if (/could not be prepared|not reachable|unreachable|fetch|network|reach Instagram|media.*(not|un)/i.test(s)) return 'The media file could not be reached or prepared. Re-upload it from the Media Library, then publish again.';
  if (/format|process this media|H\.264|codec/i.test(s)) return 'Instagram could not process this media file. A standard MP4 (H.264) video or JPG image works best.';
  return '';
}
async function markFailed(userId, post, error, { isAutoRetry = false } = {}) {
  const short = String(error || 'Publish failed.').slice(0, 200);
  const retriesUsed = (post.retryCount || 0) + (isAutoRetry ? 1 : 0);
  const patch = {
    status: 'failed', containerId: null,
    lastPublishError: short, failedAt: new Date().toISOString(),
    retryCount: retriesUsed, retryPending: false, retryAt: '',
  };
  if (retriesUsed < 1) {
    patch.retryPending = true;
    patch.retryAt = new Date(Date.now() + AUTO_RETRY_DELAY_MS).toISOString();
  }
  await db.updatePost(userId, post.id, patch);
  const friendly = friendlyFailureText(short);
  await notifyUser(userId, 'publish-failure', post.id,
    `Publish failed: ${friendly ? `${friendly} (Details: ${short})` : short}${patch.retryPending ? ' It will be retried automatically in about 15 minutes.' : ''}`);
  return short;
}
// Per-target failure (multi-target publish): marks ONE target failed,
// arms that target's single automatic retry (+15 min), and re-derives
// the post-level state. The failure notification keeps the exact
// single-target wording when the post has one target; with several
// targets it names the account that failed.
async function markTargetFailed(userId, post, targets, target, error, { isRetryAttempt = false } = {}) {
  const short = String(error || 'Publish failed.').slice(0, 200);
  target.status = 'failed';
  target.containerId = null;
  target.error = short;
  if (isRetryAttempt) target.retryCount = (target.retryCount || 0) + 1;
  target.retryPending = (target.retryCount || 0) < 1;
  target.retryAt = target.retryPending ? new Date(Date.now() + AUTO_RETRY_DELAY_MS).toISOString() : '';
  await db.updatePost(userId, post.id, summarizeTargets(post, targets));
  const friendly = friendlyFailureText(short);
  const who = targets.length > 1 && target.username ? ` for @${target.username}` : '';
  await notifyUser(userId, 'publish-failure', post.id,
    `Publish failed${who}: ${friendly ? `${friendly} (Details: ${short})` : short}${target.retryPending ? ' It will be retried automatically in about 15 minutes.' : ''}`);
  return short;
}
// Persist a target list mid-publish (state changes between Graph
// calls) and return the fresh post row.
async function persistTargets(userId, post, targets) {
  await db.updatePost(userId, post.id, summarizeTargets(post, targets));
  return db.getPost(userId, post.id);
}
// Is this URL one of OUR stored copies, and is the copy still there?
// Returns null for anything that is not a stored copy (link media,
// external URLs, data: URLs — each handled elsewhere), otherwise
// { fileId, item, alive }. A database copy is alive while its file row
// exists; an OCI copy is alive while its library item is not marked
// serverCopyRemoved (the post-publish delete is what sets that mark,
// and a failed delete leaves the mark unset — see maybeDeleteServerCopy).
async function storedMediaState(userId, url) {
  if (typeof url !== 'string' || !url) return null;
  const library = await db.listMedia(userId, { all: true }).catch(() => []);
  const itemByUrl = library.find((x) => x.url === url) || null;
  if (itemByUrl && itemByUrl.storage === 'oci' && itemByUrl.objectName) {
    return { fileId: itemByUrl.objectName, item: itemByUrl, alive: !itemByUrl.serverCopyRemoved };
  }
  const m = /\/media\/(f[0-9a-f]{32})$/.exec(url.trim());
  if (!m) return null;
  const fileId = m[1];
  const item = itemByUrl || library.find((x) => x.fileId === fileId) || null;
  if (item && item.serverCopyRemoved) return { fileId, item, alive: false };
  const file = await db.getMediaFile(fileId).catch(() => null);
  return { fileId, item, alive: !!file };
}
// The one clear message every reuse path gives when the stored copy is
// gone (the "Band Mandir" lesson: a post reusing an already-published
// library item used to sail through scheduling and then die at publish
// time with Instagram's opaque fetch error). The bytes are deleted by
// design, so no retry can heal this — the only fix is a fresh upload.
const MEDIA_GONE_ERROR = 'That media’s server copy was removed after it was published — KiluaAI keeps only a temporary copy to save space. Upload the file again in Media Library, then schedule it.';
async function deadStoredMediaError(userId, url) {
  const st = await storedMediaState(userId, url).catch(() => null);
  return st && !st.alive ? MEDIA_GONE_ERROR : '';
}
// Server-copy auto-delete (the owner's storage model: the server is
// only a bridge — Instagram has the post now, so the uploaded bytes do
// not need to live here). After a successful publish, delete the stored
// binary behind the post's /media/<id> URL and mark the library item
// "serverCopyRemoved" — UNLESS the user opted to keep copies
// (keepServerCopyAfterPublish setting, default off), the media is a
// link (not ours), or another unpublished post still references the
// same file. Best-effort: cleanup never fails a publish.
async function maybeDeleteServerCopy(userId, post) {
  const url = post && post.mediaUrl;
  if (typeof url !== 'string') return;
  const library = await db.listMedia(userId, { all: true }).catch(() => []);
  const itemByUrl = library.find((x) => x.url === url) || null;
  // An OCI-backed copy is recognised by its library item; a database
  // copy by the /media/<id> shape of the post URL, exactly as before.
  const ociItem = itemByUrl && itemByUrl.storage === 'oci' && itemByUrl.objectName ? itemByUrl : null;
  const m = /\/media\/(f[0-9a-f]{32})$/.exec(url.trim());
  if (!ociItem && !m) return; // link media or an external URL — not stored here
  const fileId = ociItem ? ociItem.objectName : m[1];
  const settings = await db.getSettings(userId).catch(() => ({}));
  if (settings && settings.keepServerCopyAfterPublish === true) return;
  // Multi-target rule (the 2026-11-19 lesson: a library copy deleted
  // after its first publish 404'd the second account's post): this
  // post's own copy goes only once EVERY ticked Instagram target is
  // terminal — published or permanently failed. A target still
  // pending, publishing, or armed for its retry still needs the file.
  if (post.igEnabled !== false) {
    const targets = targetsOf(post);
    if (targets.length && !targets.every(targetTerminal)) return;
  }
  const posts = await db.listPosts(userId, { all: true }).catch(() => []);
  const stillNeeded = posts.some((p) => p.id !== post.id && p.mediaUrl === url
    && ['scheduled', 'draft', 'failed', 'partial'].includes(p.status));
  if (stillNeeded) return;
  let removed = true;
  if (ociItem) removed = await ociDeleteObject(ociItem.objectName);
  else await db.deleteMediaFile(fileId);
  // If the storage delete failed (already logged with its cause), the
  // copy is still out there — do NOT mark the item removed; the queue
  // state must stay honest about what actually happened.
  if (!removed) return;
  const item = ociItem || library.find((x) => x.fileId === fileId || x.url === url);
  if (item && !item.serverCopyRemoved) {
    await db.updateMedia(userId, item.id, { serverCopyRemoved: true, serverCopyRemovedAt: new Date().toISOString() });
  }
}
// Instagram can only publish media it can download from a public URL.
// Posts whose media is still a data: URL (library items uploaded before
// uploads were stored server-side, or posts created straight from a
// file) are migrated here, once, at publish time: the bytes are stored
// as a media file, and the post — plus the library item it came from,
// when there is one — is rewritten to the public /media/<id> URL, so
// every later publish (and the queue) uses the URL directly. Returns
// the (possibly updated) post; a data: URL that cannot be decoded is
// left untouched and the caller reports it.
async function ensurePublishableMedia(userId, post, base) {
  const url = post && post.mediaUrl;
  if (typeof url !== 'string' || !url.startsWith('data:')) return post;
  const parsed = parseDataUrl(url);
  if (!parsed) return post;
  let libraryItem = null;
  let fileId = '';
  try {
    const library = await db.listMedia(userId, { all: true });
    libraryItem = library.find((m) => m.url === url) || null;
    if (libraryItem && libraryItem.fileId) fileId = libraryItem.fileId;
  } catch { /* the migration still works without the library lookup */ }
  if (!fileId) {
    fileId = newMediaFileId();
    await db.saveMediaFile({ id: fileId, userId, contentType: parsed.contentType, buffer: parsed.buffer });
  }
  const publicUrl = `${base}/media/${fileId}`;
  await db.updatePost(userId, post.id, { mediaUrl: publicUrl });
  post.mediaUrl = publicUrl;
  if (libraryItem && libraryItem.url !== publicUrl) {
    try { await db.updateMedia(userId, libraryItem.id, { url: publicUrl, fileId }); } catch { /* nicety — the post itself is already migrated */ }
  }
  return post;
}
// The same migration, run lazily by the Media Library list: a legacy
// item whose url is still an inline data: URL ships its whole file as
// base64 inside every list response — a single pre-fix video upload
// made the Queue/Library payload megabytes and timed the app out on
// slow connections. Moving the bytes to the media-file store (once)
// and rewriting the item to its public /media/<id> URL makes every
// later list light. Small inline images are harmless and left alone;
// any failure leaves the item exactly as it was.
const LEGACY_DATA_URL_MIN = 32 * 1024;
async function migrateLegacyMediaItem(userId, item, base) {
  const url = item && item.url;
  if (typeof url !== 'string' || !url.startsWith('data:') || url.length < LEGACY_DATA_URL_MIN) return item;
  const parsed = parseDataUrl(url);
  if (!parsed) return item;
  try {
    let fileId = item.fileId || '';
    if (!fileId) {
      fileId = newMediaFileId();
      await db.saveMediaFile({ id: fileId, userId, contentType: parsed.contentType, buffer: parsed.buffer });
    }
    const publicUrl = `${base}/media/${fileId}`;
    await db.updateMedia(userId, item.id, { url: publicUrl, fileId });
    return { ...item, url: publicUrl, fileId };
  } catch { return item; }
}
// Publish one post via the Graph API. Reusable by the manual Publish
// button, by /api/publish-due and by the cron endpoint — the logic lives
// here once. Returns { ok, liveUrl, mediaId } on success,
// { ok:false, retry:true, containerId, error } when Instagram is still
// processing (press Publish again to resume the same container), or
// { ok:false, error } on a hard failure (post is marked failed).
// In-flight guard: two overlapping publish triggers for the same post
// (the cron pinger firing while the user taps Publish in the app, or a
// double-tap on Publish) must never create two Instagram posts.
// attemptPublish claims the post in-process for the duration of one
// attempt; a second caller gets the "still processing" answer instead.
// (On multi-instance serverless this narrows the race to near-zero in
// practice — the saved containerId resume below is the second line of
// defence — but a same-process duplicate is now impossible.)
const publishInFlight = new Set();
// Recurrence (Phase C1): a weekly post that just published spawns its
// next occurrence (+7 days, same time) as a fresh scheduled post in
// the same series. Guarded by nextOccurrenceId on the published post,
// so the one automatic retry — or any repeated success path — can
// never spawn twice. Deleting an occurrence never touches the others;
// clearing "repeat" on an occurrence stops the chain from there.
// Shared by the Instagram path and the YouTube-only path.
async function spawnNextOccurrence(userId, post) {
  if (!post || post.repeat !== 'weekly' || post.nextOccurrenceId) return;
  try {
    const seriesId = post.seriesId || post.id;
    let nextMs = new Date(post.scheduleTime || Date.now()).getTime() + 7 * 86400000;
    if (!Number.isFinite(nextMs)) nextMs = Date.now() + 7 * 86400000;
    while (nextMs <= Date.now()) nextMs += 7 * 86400000; // a very late publish still lands on a future slot
    const occurrence = {
      id: uid('post'), userId,
      mediaUrl: post.mediaUrl, mediaType: post.mediaType || 'video',
      caption: post.caption || '', hashtags: post.hashtags || '', cta: post.cta || '',
      platform: post.platform || 'Instagram',
      igAccountId: post.igAccountId || '', igAccountUsername: post.igAccountUsername || '',
      // The next occurrence targets the same accounts, each starting
      // fresh — nothing has published from it yet.
      igTargets: targetsOf(post).map(freshTarget),
      igEnabled: post.igEnabled !== false,
      scheduleTime: new Date(nextMs).toISOString(),
      status: 'scheduled', format: post.format || 'REELS', liveUrl: '',
      posterUrl: post.posterUrl || '',
      youtube: normalizeYouTubeSetting(post.youtube),
      youtubeVideoId: '', youtubeStatus: '', youtubeError: '',
      ytVisibility: YT_VISIBILITIES.includes(post.ytVisibility) ? post.ytVisibility : 'public',
      ytMadeForKids: post.ytMadeForKids === true,
      firstComment: post.firstComment || '', firstCommentPosted: false,
      repeat: 'weekly', seriesId, nextOccurrenceId: '',
      createdAt: new Date().toISOString(),
    };
    await db.savePost(occurrence);
    await db.updatePost(userId, post.id, { seriesId, nextOccurrenceId: occurrence.id });
  } catch { /* recurrence never fails a publish */ }
}
// YouTube-only publish (Phase B platform picker: Instagram unticked).
// No Instagram leg at all — the same media goes straight to YouTube.
// Failures go through markFailed, so the exactly-one-retry rule and
// the failure notifications behave exactly like an Instagram failure.
async function attemptYouTubeOnlyPublish(userId, post) {
  const isAutoRetry = !!(post && post._autoRetry);
  const fail = async (err) => {
    try { await markFailed(userId, post, err, { isAutoRetry }); } catch { /* post may be gone */ }
    return { ok: false, error: err };
  };
  try {
    await db.updatePost(userId, post.id, { publishAttempts: (post.publishAttempts || 0) + 1 });
    if (post.youtubeVideoId) {
      // Already uploaded by an earlier attempt — just mark it live.
      const liveUrl = 'https://www.youtube.com/watch?v=' + post.youtubeVideoId;
      await db.updatePost(userId, post.id, { status: 'published', liveUrl, publishedAt: post.publishedAt || new Date().toISOString(), containerId: null, lastPublishError: '', retryPending: false, retryAt: '' });
      return { ok: true, liveUrl, mediaId: post.youtubeVideoId };
    }
    if (!post.youtube || !post.youtube.enabled) return fail('This post has no platform ticked — tick Instagram or YouTube and publish again.');
    if ((post.mediaType || 'video') === 'image') return fail('YouTube accepts videos only — this post is an image. Tick Instagram as well, or use a video.');
    const bytes = await fetchPostMediaBytes(post);
    if (!bytes) return fail('This post\u2019s media could not be read for the YouTube upload — upload the file again from the Media Library, then publish.');
    const videoId = await uploadVideoToYouTube(userId, post, bytes);
    const liveUrl = 'https://www.youtube.com/watch?v=' + videoId;
    await db.updatePost(userId, post.id, { status: 'published', liveUrl, publishedAt: new Date().toISOString(), youtubeVideoId: videoId, youtubeStatus: 'uploaded', youtubeError: '', containerId: null, lastPublishError: '', retryPending: false, retryAt: '' });
    await notifyUser(userId, 'publish-success', post.id, `Published to YouTube (private): \u201C${String(post.caption || 'Untitled post').slice(0, 80)}\u201D`);
    await spawnNextOccurrence(userId, post);
    try { await maybeDeleteServerCopy(userId, post); } catch { /* cleanup never fails a publish */ }
    return { ok: true, liveUrl, mediaId: videoId };
  } catch (e) {
    return fail('YouTube upload failed: ' + String((e && e.message) || e).slice(0, 240));
  }
}
async function attemptPublish(userId, post, ig, publicBaseUrl) {
  const lockKey = `${userId}:${post && post.id}`;
  if (publishInFlight.has(lockKey)) {
    return { ok: false, retry: true, containerId: (post && post.containerId) || null, error: 'This post is already being published — wait a moment, then check the queue. Nothing was published twice.' };
  }
  publishInFlight.add(lockKey);
  try {
    return await attemptPublishLocked(userId, post, ig, publicBaseUrl);
  } finally {
    publishInFlight.delete(lockKey);
  }
}
// Publish ONE Instagram target of a post, with THAT target account's
// own credentials — the container -> FINISHED -> media_publish ->
// permalink flow, plus that target's first comment. Mutates the
// target object and returns { ok, liveUrl, mediaId } /
// { retry: true, containerId, error } / { error }; the caller owns
// persistence and the post-level state (summarizeTargets).
async function publishOneTarget(userId, post, targets, target, publicBaseUrl) {
  const resolved = await resolvePublishCreds(userId, target.igUserId ? { igAccountId: target.igUserId } : {});
  if (resolved.missing) return { error: missingAccountError(resolved), missing: true };
  const ig = resolved.ig || {};
  if (!ig.token || !ig.igUserId) return { error: 'Instagram is not connected — connect Instagram in Settings to publish from here.', missing: true };
  const token = ig.token;
  const igId = ig.igUserId;
  const base = graphApiBase(ig.tokenHost);
  let containerId = target.containerId || null;
  if (containerId) {
    // Resume a container from an earlier attempt instead of duplicating it.
    const s = await graph('/' + containerId + '?fields=status_code&access_token=' + encodeURIComponent(token), 'GET', undefined, base);
    if (s && s.error) containerId = null; // container gone — make a fresh one
    else if (s && s.status_code === 'ERROR') containerId = null;
    else if (s && s.status_code === 'FINISHED') { /* fall through to publish */ }
    else if (s) {
      return { retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' };
    }
  }
  if (!containerId) {
    const created = await graph(`/${igId}/media`, 'POST', publishContainerBody(post, token), base);
    if (!created || created.error) {
      return { error: friendlyGraphError(created, 'Instagram could not create this post. Check the media link is a public video/image and try again.') };
    }
    containerId = created.id;
    target.containerId = containerId;
    target.status = 'publishing';
    await persistTargets(userId, post, targets);
  }
  // Poll container status until FINISHED (max ~45s elapsed: Vercel stops
  // at 60s, so the loop is capped by wall-clock, not just iterations).
  let status = '';
  const pollStarted = Date.now();
  for (let i = 0; i < 9 && Date.now() - pollStarted < 45000; i++) {
    const s = await graph('/' + containerId + '?fields=status_code&access_token=' + encodeURIComponent(token), 'GET', undefined, base);
    status = (s && s.status_code) || '';
    if (status === 'FINISHED') break;
    if (status === 'ERROR' || (s && s.error)) {
      return { error: 'Instagram could not process this media — the file may be in a format Instagram does not accept. Try a standard MP4 (H.264) or JPG and publish again.' };
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (status !== 'FINISHED') {
    return { retry: true, containerId, error: 'Instagram is still processing this video — wait a minute, then press Publish again. Nothing was published yet and nothing was duplicated.' };
  }
  const published = await graph(`/${igId}/media_publish`, 'POST', { creation_id: containerId, access_token: token }, base);
  if (!published || published.error) {
    return { error: friendlyGraphError(published, 'Instagram could not publish this post.') };
  }
  const media = await graph('/' + published.id + '?fields=permalink,media_type&access_token=' + encodeURIComponent(token), 'GET', undefined, base);
  target.status = 'published';
  target.igMediaId = published.id || '';
  target.liveUrl = (media && media.permalink) || '';
  target.error = '';
  target.containerId = null;
  target.retryPending = false;
  target.retryAt = '';
  target.publishedAt = new Date().toISOString();
  // First comment (Phase C2): post the prepared comment (usually the
  // hashtags) on THIS target's just-created media. A comment failure
  // is soft — the post is live either way; the user is notified.
  if (post.firstComment && String(post.firstComment).trim()) {
    try {
      const c = await graph('/' + published.id + '/comments', 'POST', { message: String(post.firstComment).slice(0, 2200), access_token: token }, base);
      if (!c || c.error) throw new Error(friendlyGraphError(c, 'Instagram refused the comment'));
      target.firstCommentPosted = true;
    } catch (e) {
      try { await notifyUser(userId, 'comment-failed', post.id, `Your post “${String(post.caption || 'Untitled post').slice(0, 80)}” is live, but its first comment could not be added (${String((e && e.message) || e).slice(0, 160)}). You can add the comment manually on Instagram.`); } catch { /* notifications never fail a publish */ }
    }
  }
  return { ok: true, liveUrl: target.liveUrl, mediaId: published.id };
}
// YouTube cross-post (Phase B): upload the same video alongside the
// Instagram publish. A YouTube failure NEVER fails or duplicates the
// Instagram side: it is recorded on the post and reported through the
// normal notification path. A post that already has a youtubeVideoId
// is never uploaded twice. Images skip softly (YouTube is video-only).
async function runYouTubeCrossPost(userId, post) {
  const ytLabel = String(post.caption || 'Untitled post').slice(0, 80);
  try {
    if ((post.mediaType || 'video') === 'image') {
      await db.updatePost(userId, post.id, { youtubeStatus: 'skipped', youtubeError: '' });
      await notifyUser(userId, 'youtube-skipped', post.id, `YouTube cross-post skipped for “${ytLabel}” — YouTube accepts videos only, and this post is an image. The Instagram post is live.`);
    } else {
      const bytes = await fetchPostMediaBytes(post);
      if (!bytes) throw new Error('the media file could not be read for the YouTube upload');
      const videoId = await uploadVideoToYouTube(userId, post, bytes);
      await db.updatePost(userId, post.id, { youtubeVideoId: videoId, youtubeStatus: 'uploaded', youtubeError: '' });
      await notifyUser(userId, 'youtube-success', post.id, `Also posted to YouTube (private): “${ytLabel}”`);
    }
  } catch (e) {
    const reason = String((e && e.message) || e || 'unknown error').slice(0, 300);
    try { await db.updatePost(userId, post.id, { youtubeStatus: 'failed', youtubeError: reason }); } catch { /* post may be gone */ }
    try { await notifyUser(userId, 'youtube-failed', post.id, `Instagram posted fine, but the YouTube upload failed for “${ytLabel}”: ${reason}. The Instagram post is live — nothing was duplicated.`); } catch { /* notifications never fail a publish */ }
  }
}
async function attemptPublishLocked(userId, post, ig, publicBaseUrl) {
  // Platform picker (Phase B revision): Instagram unticked means a
  // YouTube-only post — no Instagram leg runs at all.
  if (post && post.igEnabled === false) return attemptYouTubeOnlyPublish(userId, post);
  const isAutoRetry = !!(post && post._autoRetry); // set by duePostsFor for the one automatic retry
  try {
    await db.updatePost(userId, post.id, { publishAttempts: (post.publishAttempts || 0) + 1 });
    // Uploaded files must reach Instagram as a public URL: migrate a
    // data: media URL to a stored file + /media/<id> URL first (no-op
    // for link media, which is already public).
    await ensurePublishableMedia(userId, post, publicBaseUrl || 'https://social-scheduler-one-sandy.vercel.app');
    let targets = targetsOf(post);
    if (typeof post.mediaUrl === 'string' && post.mediaUrl.startsWith('data:')) {
      const err = 'This post’s media could not be prepared for publishing — upload the file again from the Media Library, then publish.';
      for (const t of targets) {
        if (t.status === 'pending' || t.status === 'publishing' || t.status === 'failed') {
          await markTargetFailed(userId, post, targets, t, err, { isRetryAttempt: isAutoRetry });
        }
      }
      return { ok: false, error: err };
    }
    // Stored copy already gone (removed after an earlier publish of
    // the same library item): fail every attemptable target with the
    // clear re-upload reason instead of letting Instagram fetch a 404
    // and blaming the media format.
    const goneErr = await deadStoredMediaError(userId, post.mediaUrl);
    if (goneErr) {
      for (const t of targets) {
        if (t.status === 'pending' || t.status === 'publishing' || t.status === 'failed') {
          await markTargetFailed(userId, post, targets, t, goneErr, { isRetryAttempt: isAutoRetry });
        }
      }
      return { ok: false, error: goneErr };
    }
    // Which targets this attempt may touch: pending/publishing ones
    // always; a failed target only on its armed automatic retry (due
    // sweep) or a manual publish press. Published targets are never
    // re-published — no duplicates, ever.
    const now = Date.now();
    const attemptable = targets.filter((t) => t.status === 'pending' || t.status === 'publishing'
      || (t.status === 'failed' && (!isAutoRetry || (t.retryPending && t.retryAt && new Date(t.retryAt).getTime() <= now))));
    let anyPublished = false;
    let anyProcessing = false;
    let firstError = '';
    let firstMediaId = '';
    const errors = [];
    let missingFailures = 0;
    for (const target of attemptable) {
      const r = await publishOneTarget(userId, post, targets, target, publicBaseUrl);
      if (r.ok) {
        anyPublished = true;
        if (!firstMediaId) firstMediaId = r.mediaId || '';
        const who = targets.length > 1 && target.username ? ` (@${target.username})` : '';
        await notifyUser(userId, 'publish-success', post.id, `Published to Instagram${who}: “${String(post.caption || 'Untitled post').slice(0, 80)}”`);
      } else if (r.retry) {
        anyProcessing = true;
        target.status = 'publishing';
        target.containerId = r.containerId || target.containerId || null;
        if (!firstError) firstError = r.error || '';
      } else {
        errors.push(r.error || '');
        if (r.missing) missingFailures++;
        if (!firstError) firstError = r.error || '';
        await markTargetFailed(userId, post, targets, target, r.error, { isRetryAttempt: isAutoRetry });
      }
      await persistTargets(userId, post, targets);
    }
    if (anyPublished) {
      // The library item this came from has now been used once.
      try {
        const library = await db.listMedia(userId, { all: true });
        const item = library.find((m) => m.url && post.mediaUrl && m.url === post.mediaUrl);
        if (item) await db.updateMedia(userId, item.id, { usedCount: (item.usedCount || 0) + 1 });
      } catch { /* usedCount is a nicety, never fail a publish over it */ }
      // YouTube cross-post (Phase B): after the Instagram legs and
      // BEFORE the server-copy cleanup below, which may delete the
      // very bytes the upload needs.
      if (post.youtube && post.youtube.enabled && !post.youtubeVideoId) {
        await runYouTubeCrossPost(userId, post);
      }
    }
    const allTerminal = targets.length > 0 && targets.every(targetTerminal);
    const allPublished = targets.length > 0 && targets.every((t) => t.status === 'published');
    // Recurrence (Phase C1): spawn the next weekly occurrence BEFORE
    // the server-copy cleanup below, so the new occurrence keeps the
    // bridge copy alive. Re-read the post so the nextOccurrenceId
    // guard sees the freshest state (never spawn twice).
    if (allTerminal && targets.some((t) => t.status === 'published')) {
      const fresh = await db.getPost(userId, post.id).catch(() => null);
      if (fresh && !fresh.nextOccurrenceId) await spawnNextOccurrence(userId, fresh);
    }
    // The server was only a bridge for uploaded media: the stored
    // copy is dropped once EVERY target is terminal (the cleanup
    // itself enforces that), unless the user keeps copies or another
    // unpublished post still needs the file.
    if (anyPublished || allTerminal) {
      try {
        const fresh = await db.getPost(userId, post.id).catch(() => null);
        if (fresh) await maybeDeleteServerCopy(userId, fresh);
      } catch { /* cleanup never fails a publish */ }
    }
    const pubTarget = targets.find((t) => t.status === 'published');
    if (allPublished) return { ok: true, liveUrl: pubTarget ? (pubTarget.liveUrl || '') : '', mediaId: firstMediaId };
    if (anyPublished) return { ok: true, partial: true, liveUrl: pubTarget ? (pubTarget.liveUrl || '') : '', mediaId: firstMediaId, error: firstError };
    if (anyProcessing) {
      const busy = targets.find((t) => t.containerId);
      return { ok: false, retry: true, containerId: busy ? busy.containerId : null, error: firstError };
    }
    return { ok: false, error: firstError, missingAll: errors.length > 0 && missingFailures === errors.length };
  } catch (e) {
    // A failed publish attempt — including a network failure reaching
    // Instagram — marks the post's outstanding targets failed so it is
    // visible in the Queue as needing attention, instead of silently
    // staying "scheduled".
    try {
      const targets = targetsOf(post);
      for (const t of targets) {
        if (t.status === 'pending' || t.status === 'publishing' || t.status === 'failed') {
          await markTargetFailed(userId, post, targets, t, 'Could not reach Instagram — check your connection and try publishing again in a minute.', { isRetryAttempt: isAutoRetry });
        }
      }
    } catch { /* post may have been deleted; the error below still stands */ }
    return { ok: false, error: 'Could not reach Instagram — check your connection and try publishing again in a minute.' };
  }
}
app.post('/api/posts/:id/publish', ah(async (req, res) => {
  const post = await db.getPost(req.userId, req.params.id);
  if (!post) return res.status(404).json({ ok: false, error: 'That post no longer exists — it may have been deleted.' });
  // Status guard: an already-published post must never run another
  // publish attempt — with a real token that would create a duplicate
  // Instagram post, and a failed attempt would flip the good post to
  // "failed". (A post publishing right now is covered by the in-flight
  // lock inside attemptPublish.)
  if (post.status === 'published') {
    return res.status(409).json({ ok: false, error: 'This post is already published — it cannot be published again. Duplicate it if you want to post it again.' });
  }
  // Multi-target: each ticked account publishes with its OWN token
  // inside attemptPublish; a target whose account was disconnected
  // fails only itself (failure notification included) — the post is
  // never silently published from a different account. YouTube-only
  // posts (Instagram unticked) skip Instagram entirely.
  const result = await attemptPublish(req.userId, post, {}, publicBase(req));
  if (result.ok && result.partial) return res.json({ ok: true, partial: true, liveUrl: result.liveUrl, mediaId: result.mediaId, error: result.error });
  if (result.ok) return res.json({ ok: true, liveUrl: result.liveUrl, mediaId: result.mediaId });
  if (result.retry) return res.json({ ok: false, retry: true, containerId: result.containerId, error: result.error });
  // Nothing could publish because no target account is connected:
  // a client-side fix (connect the account), not a server error.
  if (result.missingAll || /no longer connected|not connected/.test(result.error || '')) return res.status(400).json({ ok: false, error: result.error });
  return res.status(502).json({ ok: false, error: result.error });
}));
// One-tap retry (batch 3, improvement #3): a failed (or partly
// failed) post goes through the SAME checks as the Studio pre-flight
// first — connection, media, plan — and only re-arms when they all
// pass, so a retry never walks into the same wall silently. Failed
// targets reset to pending (published ones are never touched), the
// post is made due now, and the normal publish machinery runs it
// immediately; its result is reported exactly like a Publish press.
// One-tap retry core (batch 3), shared since batch 6 by the user
// route below and the owner console's admin retry — one machinery,
// two doors. Returns { status, body } instead of touching res.
async function retryPostForUser(userId, postId, base) {
  const post = await db.getPost(userId, postId);
  if (!post) return { status: 404, body: { ok: false, error: 'That post no longer exists — it may have been deleted.' } };
  if (post.status === 'published') return { status: 409, body: { ok: false, error: 'This post is already published — there is nothing to retry. Duplicate it if you want to post it again.' } };
  if (post.status !== 'failed' && post.status !== 'partial') return { status: 409, body: { ok: false, error: 'Only a failed post can be retried — this one has not failed.' } };
  const targets = targetsOf(post);
  const checks = [];
  // --- connection ---
  if (post.igEnabled === false) {
    const yt = await db.getYouTube(userId).catch(() => null);
    checks.push(yt
      ? { id: 'connection', ok: true, message: 'YouTube is connected.' }
      : { id: 'connection', ok: false, message: 'YouTube is not connected.', fix: 'Connect YouTube on the Connections page, then retry.' });
  } else {
    const { accounts } = await db.getInstagramAccounts(userId);
    const pending = targets.filter((t) => t.status !== 'published');
    const missing = pending.find((t) => t.igUserId && !accounts.some((a) => String(a.igUserId) === String(t.igUserId)));
    const broken = pending.map((t) => accounts.find((a) => String(a.igUserId) === String(t.igUserId))).find((a) => a && a.tokenRefreshError === 'revoked-or-expired');
    if (!accounts.length) checks.push({ id: 'connection', ok: false, message: 'Instagram is not connected.', fix: 'Connect Instagram on the Connections page, then retry.' });
    else if (missing) checks.push({ id: 'connection', ok: false, message: `The account @${missing.username || ''} is no longer connected.`, fix: 'Reconnect that account on the Connections page, then retry.' });
    else if (broken) checks.push({ id: 'connection', ok: false, message: `The connection for @${broken.username || ''} is broken — posts to it cannot publish.`, fix: 'Reconnect that account on the Connections page (one tap), then retry.' });
    else checks.push({ id: 'connection', ok: true, message: 'Instagram connection is healthy.' });
  }
  // --- media ---
  if (!post.mediaUrl) checks.push({ id: 'media', ok: false, message: 'This post has no media.', fix: 'Edit the post and add a photo or video, then retry.' });
  else {
    const dead = await deadStoredMediaError(userId, post.mediaUrl);
    if (dead) checks.push({ id: 'media', ok: false, message: dead, fix: 'Upload the file again in Media Library, then schedule a fresh post with it.' });
    else checks.push({ id: 'media', ok: true, message: 'Media is ready.' });
  }
  // --- plan (the post itself is excluded — it already holds its slot) ---
  const chk = await planScheduleCheck(userId, {
    scheduleTime: new Date().toISOString(), status: 'scheduled',
    igEnabled: post.igEnabled !== false,
    targets: targets.map((t) => ({ igAccountId: t.igUserId })),
    excludePostId: post.id,
  });
  checks.push(chk.ok
    ? { id: 'plan', ok: true, message: 'Within your plan limits.' }
    : { id: 'plan', ok: false, message: chk.error, fix: 'Upgrade your plan, or delete some scheduled posts, then retry.' });
  const failed = checks.find((c) => !c.ok);
  if (failed) return { status: 422, body: { ok: false, error: failed.message, checks } };
  // --- re-arm + publish now through the normal machinery ---
  const reset = targets.map((t) => (t.status === 'published' ? t : freshTarget(t)));
  const patch = {
    ...summarizeTargets(post, reset),
    scheduleTime: new Date().toISOString(),
    lastPublishError: '', failedAt: '',
    retryCount: 0, retryPending: false, retryAt: '',
    ...(post.igEnabled === false ? { youtubeStatus: '', youtubeError: '' } : {}),
  };
  await db.updatePost(userId, post.id, patch);
  const fresh = await db.getPost(userId, post.id);
  const result = await attemptPublish(userId, fresh, {}, base);
  if (result.ok && result.partial) return { status: 200, body: { ok: true, retried: true, partial: true, liveUrl: result.liveUrl, mediaId: result.mediaId, error: result.error } };
  if (result.ok) return { status: 200, body: { ok: true, retried: true, liveUrl: result.liveUrl, mediaId: result.mediaId } };
  if (result.retry) return { status: 200, body: { ok: false, retried: true, retry: true, containerId: result.containerId, error: result.error } };
  if (result.missingAll || /no longer connected|not connected/.test(result.error || '')) return { status: 400, body: { ok: false, retried: true, error: result.error } };
  return { status: 502, body: { ok: false, retried: true, error: result.error } };
}
app.post('/api/posts/:id/retry', ah(async (req, res) => {
  const r = await retryPostForUser(req.userId, req.params.id, publicBase(req));
  return res.status(r.status).json(r.body);
}));
// Posts that are due for one user: scheduled posts whose time has passed
// (uploaded-file posts are included — attemptPublish migrates their
// media to a public URL first), plus failed/partial posts with at
// least one target whose ONE automatic retry is due (retryAt passed —
// markTargetFailed sets it ~15 minutes after the first failure). Due
// retries are tagged _autoRetry in memory only, so attemptPublish
// knows a failure there is final for that target.
async function duePostsFor(userId, max) {
  const now = Date.now();
  const posts = await db.listPosts(userId, { all: true });
  const retryDue = (p) => {
    if (p.igEnabled === false) {
      return p.retryPending && p.retryAt && new Date(p.retryAt).getTime() <= now && (p.retryCount || 0) < 1;
    }
    return targetsOf(p).some((t) => t.status === 'failed' && t.retryPending && t.retryAt
      && new Date(t.retryAt).getTime() <= now && (t.retryCount || 0) < 1);
  };
  const due = posts
    .filter((p) => p.mediaUrl && p.scheduleTime && new Date(p.scheduleTime).getTime() <= now)
    .filter((p) => p.status === 'scheduled'
      || ((p.status === 'failed' || p.status === 'partial') && retryDue(p)))
    .sort((a, b) => new Date(a.scheduleTime) - new Date(b.scheduleTime));
  return due.slice(0, max).map((p) => (p.status === 'failed' || p.status === 'partial' ? { ...p, _autoRetry: true } : p));
}
// Publish everything that is due for the signed-in user, right now.
// This is what the Dashboard/Queue "Publish due" button calls, and what a
// cron job should call on a schedule (see /api/cron/publish-due).
app.post('/api/publish-due', ah(async (req, res) => {
  // Renew the token first if it is inside the window, so a due publish
  // never fails just because the token aged out.
  await ensureInstagramTokenFresh(req.userId).catch(() => null);
  const { accounts } = await db.getInstagramAccounts(req.userId);
  const defaultIg = await getInstagramCreds(req.userId);
  // Full-bridge plans (Max/Ultra) may drain more per tap — their
  // media is already server-side (batch 2).
  const me = await db.getUserById(req.userId).catch(() => null);
  const due = await duePostsFor(req.userId, planLimitsOf(me).fullBridge ? 10 : 5);
  // The not-connected guard only applies when something due actually
  // needs Instagram — a queue of YouTube-only posts publishes fine
  // without any Instagram connection.
  if ((!defaultIg.token || !defaultIg.igUserId) && accounts.length === 0 && due.some((p) => p.igEnabled !== false)) {
    return res.status(400).json({ ok: false, error: 'Instagram is not connected — connect Instagram in Settings to publish from here.' });
  }
  const published = [];
  const failed = [];
  const retrying = [];
  for (const post of due) {
    // Per-target connections (multi-target): the keeper runs for each
    // distinct target account first, then every target publishes with
    // its OWN token inside attemptPublish. A disconnected target
    // fails only itself — never a silent publish from another account.
    if (post.igEnabled !== false) {
      const ids = new Set(targetsOf(post).map((t) => t.igUserId).filter(Boolean));
      for (const id of ids) await ensureInstagramTokenFresh(req.userId, { igUserId: id }).catch(() => null);
    }
    const result = await attemptPublish(req.userId, post, {}, publicBase(req));
    if (result.ok) published.push({ id: post.id, liveUrl: result.liveUrl });
    else if (result.retry) retrying.push({ id: post.id, error: result.error });
    else failed.push({ id: post.id, error: result.error });
  }
  res.json({ ok: true, due: due.length, published, failed, retrying });
}));
// Cron endpoint: publishes due posts for EVERY user. Guarded by a bearer
// token (CRON_SECRET env var) instead of a login cookie, so Vercel Cron
// (or any cron) can call it: POST /api/cron/publish-due with header
// "Authorization: Bearer <CRON_SECRET>". Without CRON_SECRET set, the
// endpoint refuses to run. Max 3 posts per user per run, so a bad token or
// a stuck queue can never publish a flood.
// Vercel Cron invokes with GET (not POST) and automatically sends the
// CRON_SECRET bearer when that env var exists in the project, so the same
// handler is registered for GET and POST (see vercel.json "crons").
const cronPublishDue = ah(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Auto-publish is not configured — set CRON_SECRET in the server environment variables.' });
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(secret, 'utf8');
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Not authorised.' });
  }
  const users = await db.listUsers();
  // Publish priority (batch 2): Max/Ultra queues are worked first,
  // then Pro, then Free.
  users.sort((a, b) => (PLAN_RANK[effectivePlanOf(b).id] || 0) - (PLAN_RANK[effectivePlanOf(a).id] || 0));
  const summary = [];
  for (const user of users) {
    await ensureInstagramTokenFresh(user.id).catch(() => null);
    const { accounts } = await db.getInstagramAccounts(user.id);
    const defaultIg = await getInstagramCreds(user.id);
    // Server rule: pre-bridge media before publishing — the whole
    // queue for Max/Ultra, just the next due post for Free/Pro. The
    // per-run cap follows the same split.
    await prepareBridges(user.id, publicBase(req)).catch(() => null);
    const due = await duePostsFor(user.id, planLimitsOf(user).fullBridge ? 10 : 3);
    // Skip only when nothing due can publish: YouTube-only posts do
    // not need an Instagram connection.
    if ((!defaultIg.token || !defaultIg.igUserId) && accounts.length === 0 && !due.some((p) => p.igEnabled === false)) { summary.push({ userId: user.id, skipped: 'instagram-not-connected' }); continue; }
    let published = 0; let failed = 0;
    for (const post of due) {
      // Per-target connections (multi-target): keeper per distinct
      // target account, then attemptPublish runs every target with
      // its own token; a disconnected target fails only itself.
      if (post.igEnabled !== false) {
        const ids = new Set(targetsOf(post).map((t) => t.igUserId).filter(Boolean));
        for (const id of ids) await ensureInstagramTokenFresh(user.id, { igUserId: id }).catch(() => null);
      }
      const result = await attemptPublish(user.id, post, {}, publicBase(req));
      if (result.ok) published++;
      else if (!result.retry) failed++;
    }
    summary.push({ userId: user.id, due: due.length, published, failed });
  }
  res.json({ ok: true, ranAt: new Date().toISOString(), summary });
});
app.get('/api/cron/publish-due', cronPublishDue);
app.post('/api/cron/publish-due', cronPublishDue);

// Cron endpoint: run the token keeper for EVERY user (check + renew).
// Same CRON_SECRET guard as publish-due. The keeper also runs on its own
// whenever Settings is opened, a publish is attempted, or /api/db-status
// is hit — this endpoint exists so an external cron can guarantee a daily
// run even if nobody opens the app. Returns health metadata only.
// Registered for GET and POST for Vercel Cron (see cronPublishDue above
// and vercel.json "crons").
const cronTokenRefresh = ah(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret) return res.status(503).json({ ok: false, error: 'Cron endpoints are not configured — set CRON_SECRET in the server environment variables.' });
  const auth = req.get('authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(secret, 'utf8');
  if (!given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: 'Not authorised.' });
  }
  const users = await db.listUsers();
  const summary = [];
  for (const user of users) {
    // The keeper runs per connection: check the default account (the
    // historical summary field) AND every other connected account.
    const health = await ensureInstagramTokenFresh(user.id).catch(() => null);
    const { accounts, defaultIgUserId } = await db.getInstagramAccounts(user.id);
    const accountHealths = [];
    for (const a of accounts) {
      if (!a.igUserId || a.igUserId === defaultIgUserId) continue;
      const h = await ensureInstagramTokenFresh(user.id, { igUserId: a.igUserId }).catch(() => null);
      accountHealths.push({ igUserId: a.igUserId, username: a.username || '', instagram: h });
    }
    // Server-rule bridge prep rides along with the token pass
    // (batch 2): full queue for Max/Ultra, next due post otherwise.
    await prepareBridges(user.id, publicBase(req)).catch(() => null);
    summary.push({ userId: user.id, instagram: health, accounts: accountHealths });
  }
  res.json({ ok: true, ranAt: new Date().toISOString(), summary });
});
app.get('/api/cron/token-refresh', cronTokenRefresh);
app.post('/api/cron/token-refresh', cronTokenRefresh);

// ---------- uploaded media files (public, by unguessable id) ----------
// Serves the binaries stored by /api/media/upload. Deliberately NOT
// under /api and NOT authenticated: Instagram's fetcher must download
// the file without logging in. The 128-bit random id is the only access
// control; there is no listing endpoint and nothing about the owner is
// exposed — just the media bytes, their type, and immutable caching
// (content at an id never changes). Range requests are supported
// because video fetchers (and browsers previewing a Reel) ask for them.
app.get('/media/:id', ah(async (req, res) => {
  const file = await db.getMediaFile(req.params.id);
  if (!file) {
    // OCI-backed uploads never enter the database file store — their
    // canonical URL is the object read URL. Redirect an app-shaped
    // /media/<id> request for one to it; the object read answers 404
    // itself when the id names no object.
    if (ociEnabled() && /^f[0-9a-f]{32}$/.test(req.params.id)) {
      return res.redirect(302, ociReadUrl(req.params.id));
    }
    return res.status(404).json({ ok: false, error: 'That media file no longer exists.' });
  }
  const buf = file.buffer;
  res.setHeader('Content-Type', file.contentType);
  // Uploaded bytes are user content served from the app's own origin:
  // pin them down so they can never be reinterpreted as a document.
  // The sandbox CSP makes any script-bearing payload (e.g. a legacy
  // SVG) inert even on a direct top-level visit; nosniff stops type
  // guessing. Subresource loads (<img>/<video>, Instagram's fetcher)
  // are unaffected by either header.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  const range = typeof req.headers.range === 'string' ? /^bytes=(\d*)-(\d*)$/.exec(req.headers.range.trim()) : null;
  if (range && (range[1] || range[2])) {
    let start; let end;
    if (range[1] === '') { // suffix range: the last N bytes
      const suffix = Number(range[2]);
      if (!Number.isFinite(suffix) || suffix <= 0) { res.setHeader('Content-Range', `bytes */${buf.length}`); return res.status(416).end(); }
      start = Math.max(buf.length - suffix, 0); end = buf.length - 1;
    } else {
      start = Number(range[1]);
      end = range[2] === '' ? buf.length - 1 : Math.min(Number(range[2]), buf.length - 1);
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= buf.length) {
      res.setHeader('Content-Range', `bytes */${buf.length}`);
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Content-Length', String(end - start + 1));
    return res.end(buf.subarray(start, end + 1));
  }
  res.setHeader('Content-Length', String(buf.length));
  return res.end(buf);
}));

// ---------- media library ----------
app.get('/api/media', ah(async (req, res) => {
  const media = await db.listMedia(req.userId, { limit: req.query.limit, offset: req.query.offset });
  const base = publicBase(req);
  const out = [];
  for (const m of media) out.push(await migrateLegacyMediaItem(req.userId, m, base));
  res.json({ ok: true, media: out });
}));
app.post('/api/media', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.url) return res.status(400).json({ ok: false, error: 'Paste a media link first.' });
  if (typeof b.url !== 'string' || (b.title !== undefined && typeof b.title !== 'string') || (b.folder !== undefined && typeof b.folder !== 'string')) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (b.tags !== undefined && (!Array.isArray(b.tags) || b.tags.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'Tags must be plain text — please try again.' });
  if (b.size !== undefined && (typeof b.size !== 'number' || !Number.isFinite(b.size) || b.size < 0)) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (!/^https?:\/\//i.test(b.url)) return res.status(400).json({ ok: false, error: 'That media link is not valid — paste a full https:// link to a video or image.' });
  const item = {
    id: uid('media'), userId: req.userId, url: b.url, title: b.title || 'Untitled',
    kind: b.kind || (/\.(mp4|mov|webm)$/i.test(b.url) ? 'video' : 'image'),
    size: b.size || 0, duration: Number.isFinite(Number(b.duration)) ? Number(b.duration) : 0,
    width: Number.isFinite(Number(b.width)) ? Number(b.width) : 0,
    height: Number.isFinite(Number(b.height)) ? Number(b.height) : 0,
    folder: b.folder || 'General', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.saveMedia(item);
  res.json({ ok: true, media: item });
}));
// Upload: the frontend sends base64 in JSON (no multipart parser).
// POST /api/media/upload { name, dataUrl, folder, tags }.
// The binary is stored server-side (db mediafiles — or OCI Object
// Storage when the MEDIA_OCI_* env vars are set) and the library item
// gets a public URL served for it — Instagram can only
// publish media it can download from a public URL, so uploads must not
// stay as data: URLs. Limits: Vercel serverless requests cap at ~4.5 MB,
// and one MongoDB document caps at 16 MB — so on the live site a file
// upload must stay small. Anything bigger: add it by public link instead.
// Optional client-captured poster frame for a video upload: a small
// image data URL sent alongside the file. The binary goes into the
// SAME mediafiles store as uploads, and the library item points at it
// via posterUrl so Queue/Media can show a real frame without loading
// the video itself. Anything invalid is ignored — a poster is
// decoration, never a reason to fail an upload.
async function storePosterFile(req, posterDataUrl) {
  const empty = { posterUrl: '', posterFileId: '' };
  if (typeof posterDataUrl !== 'string' || !posterDataUrl) return empty;
  const parsed = parseDataUrl(posterDataUrl);
  if (!parsed || !/^image\//.test(parsed.contentType) || parsed.buffer.length > 2 * 1024 * 1024) return empty;
  const posterFileId = newMediaFileId();
  if (ociEnabled()) {
    await ociPutObject(posterFileId, parsed.buffer, parsed.contentType);
    return { posterUrl: ociReadUrl(posterFileId), posterFileId };
  }
  await db.saveMediaFile({ id: posterFileId, userId: req.userId, contentType: parsed.contentType, buffer: parsed.buffer });
  return { posterUrl: `${publicBase(req)}/media/${posterFileId}`, posterFileId };
}
function validPosterDataUrl(s) {
  if (typeof s !== 'string' || !s || s.length > 3 * 1024 * 1024) return '';
  const parsed = parseDataUrl(s);
  if (!parsed || !/^image\//.test(parsed.contentType) || parsed.buffer.length > 2 * 1024 * 1024) return '';
  return s;
}
app.post('/api/media/upload', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.dataUrl || !b.name) return res.status(400).json({ ok: false, error: 'Choose a file to upload first.' });
  if (!/^data:(image|video)\//i.test(b.dataUrl)) return res.status(400).json({ ok: false, error: 'That file does not look like an image or video — choose an MP4, MOV, JPG, PNG or WebP file.' });
  const parsed = parseDataUrl(b.dataUrl);
  if (!parsed) return res.status(400).json({ ok: false, error: 'That file does not look like an image or video — choose an MP4, MOV, JPG, PNG or WebP file.' });
  const mongoMode = db.isMongo();
  const maxBytes = mongoMode ? 9 * 1024 * 1024 : 60 * 1024 * 1024;
  if (parsed.buffer.length > maxBytes) {
    return res.status(413).json({ ok: false, error: mongoMode
      ? 'That file is too big to store in the database (about 9 MB max). Add it by public link instead (Media Library → Add by link), or use a smaller file.'
      : 'That file is over the 60 MB limit — use a smaller file, or add it by link.' });
  }
  const fileId = newMediaFileId();
  const useOci = ociEnabled();
  if (useOci) await ociPutObject(fileId, parsed.buffer, parsed.contentType);
  else await db.saveMediaFile({ id: fileId, userId: req.userId, contentType: parsed.contentType, buffer: parsed.buffer });
  const poster = await storePosterFile(req, b.posterDataUrl);
  const item = {
    id: uid('media'), userId: req.userId, url: useOci ? ociReadUrl(fileId) : `${publicBase(req)}/media/${fileId}`, fileId,
    ...(useOci ? { storage: 'oci', objectName: fileId } : {}), title: b.name,
    kind: /\.(mp4|mov|webm)$/i.test(b.name) ? 'video' : 'image',
    size: parsed.buffer.length, duration: Number.isFinite(Number(b.duration)) ? Number(b.duration) : 0,
    width: Number.isFinite(Number(b.width)) ? Number(b.width) : 0,
    height: Number.isFinite(Number(b.height)) ? Number(b.height) : 0,
    posterUrl: poster.posterUrl, posterFileId: poster.posterFileId,
    folder: b.folder || 'Uploads', tags: Array.isArray(b.tags) ? b.tags : [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.saveMedia(item);
  res.json({ ok: true, media: item });
}));
// Chunked upload — for files too big for one request. Vercel caps a
// single request at ~4.5 MB, which used to make even a 14 MB Reel fail
// outright. The UI splits the file into 3 MB binary chunks (≈4 MB as
// base64 JSON), sends init → chunk(s) → complete, and the server
// assembles the chunks into the SAME store as a small upload (db
// mediafiles, or OCI Object Storage when the MEDIA_OCI_* env vars are
// set), so the result is the identical public URL contract.
// Sessions expire after 2 hours; expired/aborted sessions are deleted
// with all their chunks, so an abandoned upload leaves nothing behind.
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;
const UPLOAD_SESSION_TTL_MS = 2 * 3600 * 1000;
function mimeFromFileName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif' }[ext] || '';
}
function parseBase64Chunk(dataUrl) {
  if (typeof dataUrl !== 'string') return null;
  const i = dataUrl.indexOf('base64,');
  if (i < 0) return null;
  try { return Buffer.from(dataUrl.slice(i + 7), 'base64'); } catch { return null; }
}
app.post('/api/media/upload/init', ah(async (req, res) => {
  const b = req.body || {};
  const name = typeof b.name === 'string' ? b.name.slice(0, 200) : '';
  const size = Number(b.size);
  if (!name) return res.status(400).json({ ok: false, error: 'Choose a file to upload first.' });
  if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ ok: false, error: 'That file looks empty — choose another file.' });
  if (size > UPLOAD_MAX_BYTES) return res.status(413).json({ ok: false, error: `That file is too big — the limit is ${Math.round(UPLOAD_MAX_BYTES / 1048576)} MB per file. Try a shorter or smaller video.` });
  const contentType = SAFE_MEDIA_TYPES.has(b.contentType) ? b.contentType : mimeFromFileName(name);
  if (!SAFE_MEDIA_TYPES.has(contentType)) return res.status(400).json({ ok: false, error: 'That file does not look like an image or video — choose an MP4, MOV, JPG, PNG or WebP file.' });
  await db.deleteExpiredUploadSessions().catch(() => 0);
  const now = Date.now();
  const session = {
    id: 'up-' + crypto.randomBytes(12).toString('hex'), userId: req.userId,
    name, contentType, size: Math.round(size),
    folder: typeof b.folder === 'string' ? b.folder.slice(0, 60) : 'Uploads',
    tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === 'string').slice(0, 20) : [],
    width: Number.isFinite(Number(b.width)) ? Number(b.width) : 0,
    height: Number.isFinite(Number(b.height)) ? Number(b.height) : 0,
    duration: Number.isFinite(Number(b.duration)) ? Number(b.duration) : 0,
    // Poster frame captured client-side; stored as a file at /complete.
    posterDataUrl: validPosterDataUrl(b.posterDataUrl),
    chunkCount: Math.ceil(size / UPLOAD_CHUNK_BYTES), received: 0,
    createdAt: new Date(now).toISOString(), expiresAt: new Date(now + UPLOAD_SESSION_TTL_MS).toISOString(),
  };
  await db.createUploadSession(session);
  res.json({ ok: true, uploadId: session.id, chunkSize: UPLOAD_CHUNK_BYTES, chunkCount: session.chunkCount, maxBytes: UPLOAD_MAX_BYTES });
}));
app.post('/api/media/upload/chunk', ah(async (req, res) => {
  const b = req.body || {};
  const session = await db.getUploadSession(req.userId, b.uploadId);
  if (!session) return res.status(404).json({ ok: false, error: 'That upload session is gone — start the upload again.' });
  if (session.expiresAt && session.expiresAt <= new Date().toISOString()) {
    await db.deleteUploadSession(session.id).catch(() => {});
    return res.status(410).json({ ok: false, error: 'That upload took too long and expired — start the upload again.' });
  }
  const index = Number(b.index);
  if (!Number.isInteger(index) || index < 0 || index >= session.chunkCount) return res.status(400).json({ ok: false, error: 'That upload piece is out of range — start the upload again.' });
  const buffer = parseBase64Chunk(b.dataUrl);
  if (!buffer || !buffer.length) return res.status(400).json({ ok: false, error: 'A piece of that upload arrived empty — start the upload again.' });
  if (buffer.length > UPLOAD_CHUNK_BYTES) return res.status(413).json({ ok: false, error: 'A piece of that upload was too big — start the upload again.' });
  const received = await db.saveUploadChunk(req.userId, session.id, index, buffer);
  res.json({ ok: true, received, chunkCount: session.chunkCount });
}));
app.post('/api/media/upload/complete', ah(async (req, res) => {
  const b = req.body || {};
  const session = await db.getUploadSession(req.userId, b.uploadId);
  if (!session) return res.status(404).json({ ok: false, error: 'That upload session is gone — start the upload again.' });
  // Complete enforces the SAME session expiry as chunk: an expired
  // session is deleted and answered 410, never assembled into media.
  if (session.expiresAt && session.expiresAt <= new Date().toISOString()) {
    await db.deleteUploadSession(session.id).catch(() => {});
    return res.status(410).json({ ok: false, error: 'That upload took too long and expired — start the upload again.' });
  }
  const chunks = await db.getUploadChunks(session.id, session.chunkCount);
  if (!chunks) return res.status(400).json({ ok: false, error: 'Some pieces of that upload are missing — try uploading the file again.' });
  const buffer = Buffer.concat(chunks);
  if (buffer.length !== session.size) {
    await db.deleteUploadSession(session.id).catch(() => {});
    return res.status(400).json({ ok: false, error: 'That upload arrived incomplete — try uploading the file again.' });
  }
  // Magic-byte verification (audit L-02): the assembled bytes must
  // match the session's declared type — the declared MIME alone is
  // not trusted, exactly as in the direct-upload parser.
  if (!mediaSignatureOk(session.contentType, buffer)) {
    await db.deleteUploadSession(session.id).catch(() => {});
    return res.status(400).json({ ok: false, error: 'That file\u2019s contents do not match its type — upload the real image or video file.' });
  }
  const fileId = newMediaFileId();
  const useOci = ociEnabled();
  if (useOci) await ociPutObject(fileId, buffer, session.contentType);
  else await db.saveMediaFile({ id: fileId, userId: req.userId, contentType: session.contentType, buffer });
  const poster = await storePosterFile(req, session.posterDataUrl);
  const item = {
    id: uid('media'), userId: req.userId, url: useOci ? ociReadUrl(fileId) : `${publicBase(req)}/media/${fileId}`, fileId,
    ...(useOci ? { storage: 'oci', objectName: fileId } : {}), title: session.name,
    kind: /\.(mp4|mov|webm)$/i.test(session.name) ? 'video' : 'image',
    size: buffer.length, duration: session.duration || 0,
    width: session.width || 0, height: session.height || 0,
    posterUrl: poster.posterUrl, posterFileId: poster.posterFileId,
    folder: session.folder || 'Uploads', tags: session.tags || [], favorite: false, usedCount: 0,
    createdAt: new Date().toISOString(),
  };
  await db.saveMedia(item);
  await db.deleteUploadSession(session.id).catch(() => {});
  res.json({ ok: true, media: item });
}));
app.delete('/api/media/upload/:id', ah(async (req, res) => {
  const session = await db.getUploadSession(req.userId, req.params.id);
  if (!session) return res.status(404).json({ ok: false, error: 'That upload session is gone.' });
  await db.deleteUploadSession(session.id);
  res.json({ ok: true });
}));
app.patch('/api/media/:id', ah(async (req, res) => {
  const allowed = ['title', 'folder', 'tags', 'favorite', 'usedCount', 'posterUrl'];
  const patch = {};
  for (const k of allowed) if (req.body && req.body[k] !== undefined) patch[k] = req.body[k];
  if (patch.posterUrl !== undefined && (typeof patch.posterUrl !== 'string' || patch.posterUrl.length > 2000 || (patch.posterUrl && !/^(\/|https?:\/\/)/i.test(patch.posterUrl)))) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if ((patch.title !== undefined && typeof patch.title !== 'string') || (patch.folder !== undefined && typeof patch.folder !== 'string')) return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (patch.tags !== undefined && (!Array.isArray(patch.tags) || patch.tags.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'Tags must be plain text — please try again.' });
  if (patch.favorite !== undefined && typeof patch.favorite !== 'boolean') return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  if (patch.usedCount !== undefined && typeof patch.usedCount !== 'number') return res.status(400).json({ ok: false, error: 'That media entry is not valid — please try again.' });
  const updated = await db.updateMedia(req.userId, req.params.id, patch);
  if (!updated) return res.status(404).json({ ok: false, error: 'That media file no longer exists — it may have been deleted.' });
  res.json({ ok: true, media: updated });
}));
app.delete('/api/media/:id', ah(async (req, res) => {
  // Look the item up first: for an OCI-backed item the object (and its
  // poster object) must be deleted from object storage too — the
  // database delete below only knows the database file store.
  const library = await db.listMedia(req.userId, { all: true }).catch(() => []);
  const item = library.find((x) => x.id === req.params.id) || null;
  const ok = await db.deleteMedia(req.userId, req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: 'That media file no longer exists.' });
  let ociCleanupFailed = false;
  if (item && item.storage === 'oci') {
    if (item.objectName && !(await ociDeleteObject(item.objectName))) ociCleanupFailed = true;
    if (item.posterFileId && !(await ociDeleteObject(item.posterFileId))) ociCleanupFailed = true;
  }
  // The library item is gone either way (that was the user's action),
  // but a failed storage delete is surfaced, never hidden behind a
  // bare ok — the orphaned object is also logged server-side.
  if (ociCleanupFailed) {
    return res.json({ ok: true, warning: 'Removed from your library, but the stored file copy could not be deleted from object storage — the failure has been logged.' });
  }
  res.json({ ok: true });
}));

// ---------- templates ----------
const SEED_TEMPLATES = [
  { id: 'tpl-1', name: 'New post', text: 'Something new is here! Follow for more updates. #newpost' },
  { id: 'tpl-2', name: 'Behind the scenes', text: 'A little behind the scenes from today. What do you want to see next?' },
  { id: 'tpl-3', name: 'Question post', text: 'Quick question for you all — drop your answer in the comments!' },
];
// KiluaAI caption pack (Phase D9): built-in starter templates for
// Gulf businesses, appended for EVERY user alongside their own (or
// the seeds). Flagged pack:'kiluaai' with pack-* ids — built-ins are
// never stored per-user and cannot be deleted. English copy plus one
// Arabic line each; honest and generic — no invented offers or claims.
const KILUAAI_PACK = [
  { id: 'pack-salon', pack: 'kiluaai', name: 'Salon — fresh look', text: 'Fresh cut, fresh confidence. Book your chair today — walk-ins welcome!\nتصفيف شعر جديد يمنحك ثقة جديدة. احجز موعدك اليوم!' },
  { id: 'pack-realestate', pack: 'kiluaai', name: 'Real estate — new listing', text: 'New listing just in — bright, spacious and ready to view. DM us to book a viewing this week.\nعقار جديد متاح الآن — احجز موعدك للمعاينة هذا الأسبوع.' },
  { id: 'pack-restaurant', pack: 'kiluaai', name: 'Restaurant — today\u2019s special', text: 'Today\u2019s special is on the pass and smelling incredible. Come hungry, leave happy!\nطبق اليوم جاهز الآن — تفضلوا بزيارتنا!' },
  { id: 'pack-garage', pack: 'kiluaai', name: 'Garage — service day', text: 'Engine light on? Strange noise? Bring your car in for a check-up — honest advice, fair prices.\nهل سيارتك تحتاج إلى صيانة؟ تفضل بزيارتنا لفحص شامل.' },
  { id: 'pack-cleaning', pack: 'kiluaai', name: 'Cleaning — sparkle day', text: 'Deep clean day! Homes, offices and move-ins — we leave every corner sparkling. Message us for a free quote.\nتنظيف عميق للمنازل والمكاتب — راسلنا للحصول على عرض سعر مجاني.' },
];
// ---------- notifications (publish successes/failures) ----------
app.get('/api/notifications', ah(async (req, res) => {
  const [notifications, unread] = await Promise.all([
    db.listNotifications(req.userId, { limit: req.query.limit }),
    db.countUnreadNotifications(req.userId),
  ]);
  res.json({ ok: true, notifications, unread });
}));
app.post('/api/notifications/read', ah(async (req, res) => {
  await db.markNotificationsRead(req.userId);
  res.json({ ok: true, unread: 0 });
}));

app.get('/api/templates', ah(async (req, res) => {
  const t = await getTemplates(req);
  const base = t.length ? t : SEED_TEMPLATES;
  res.json({ ok: true, templates: [...base, ...KILUAAI_PACK] });
}));
app.post('/api/templates', ah(async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.text) return res.status(400).json({ ok: false, error: 'Give the template a name and some text first.' });
  if (typeof b.name !== 'string' || typeof b.text !== 'string') return res.status(400).json({ ok: false, error: 'That template is not valid — please try again.' });
  if (b.name.trim().length > 80) return res.status(400).json({ ok: false, error: 'Template names can be at most 80 characters.' });
  if (b.text.length > 2200) return res.status(400).json({ ok: false, error: 'Template text can be at most 2,200 characters (the Instagram caption limit).' });
  // Caption library (batch 3): a saved set may carry its hashtags and
  // CTA too, so one tap restores the whole caption block.
  if (b.hashtags !== undefined && typeof b.hashtags !== 'string') return res.status(400).json({ ok: false, error: 'That template is not valid — please try again.' });
  if (b.cta !== undefined && typeof b.cta !== 'string') return res.status(400).json({ ok: false, error: 'That template is not valid — please try again.' });
  if ((b.hashtags || '').length > 500) return res.status(400).json({ ok: false, error: 'Template hashtags can be at most 500 characters.' });
  if ((b.cta || '').length > 300) return res.status(400).json({ ok: false, error: 'Template CTA can be at most 300 characters.' });
  const t = { id: uid('tpl'), userId: req.userId, name: b.name.trim(), text: b.text, hashtags: (b.hashtags || '').trim(), cta: (b.cta || '').trim() };
  await db.saveTemplate(t);
  res.json({ ok: true, template: t });
}));
app.delete('/api/templates/:id', ah(async (req, res) => {
  if (String(req.params.id || '').startsWith('pack-')) return res.status(400).json({ ok: false, error: 'KiluaAI pack templates are built in and cannot be deleted.' });
  const removed = await db.deleteTemplate(req.userId, String(req.params.id || ''));
  if (!removed) return res.status(404).json({ ok: false, error: 'That template does not exist.' });
  res.json({ ok: true });
}));

// ---------- drafts library (named composer drafts, Phase C3) ----------
// Distinct from draft-status posts: a named snapshot of the composer
// the user loads back into the Studio. Loading never schedules.
app.get('/api/drafts', ah(async (req, res) => {
  const drafts = await db.listDrafts(req.userId);
  res.json({ ok: true, drafts });
}));
app.post('/api/drafts', ah(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name !== 'string' || !b.name.trim()) return res.status(400).json({ ok: false, error: 'Give the draft a name first.' });
  if (b.name.trim().length > 80) return res.status(400).json({ ok: false, error: 'Draft names can be at most 80 characters.' });
  const STR = ['caption', 'hashtags', 'cta', 'mediaUrl', 'mediaType', 'posterUrl', 'platform', 'format', 'igAccountId', 'igAccountUsername', 'firstComment'];
  for (const k of STR) if (b[k] !== undefined && typeof b[k] !== 'string') return res.status(400).json({ ok: false, error: 'That draft is not valid — please try again.' });
  if (b.youtube !== undefined && (!b.youtube || typeof b.youtube !== 'object' || Array.isArray(b.youtube))) return res.status(400).json({ ok: false, error: 'That draft is not valid — please try again.' });
  if (b.ytVisibility !== undefined && !YT_VISIBILITIES.includes(b.ytVisibility)) return res.status(400).json({ ok: false, error: 'That YouTube visibility is not valid — use Public, Unlisted or Private.' });
  if (b.ytMadeForKids !== undefined && typeof b.ytMadeForKids !== 'boolean') return res.status(400).json({ ok: false, error: 'That draft is not valid — please try again.' });
  if (b.repeat !== undefined && b.repeat !== '' && b.repeat !== 'weekly') return res.status(400).json({ ok: false, error: 'That repeat setting is not valid.' });
  if (b.igTargets !== undefined && (!Array.isArray(b.igTargets) || b.igTargets.length > 10 || b.igTargets.some((t) => typeof t !== 'string'))) return res.status(400).json({ ok: false, error: 'That draft is not valid — please try again.' });
  const existing = await db.listDrafts(req.userId);
  if (existing.length >= 100) return res.status(400).json({ ok: false, error: 'You have 100 saved drafts — delete some before saving more.' });
  const d = {
    id: uid('draft'), userId: req.userId, name: b.name.trim(),
    caption: (b.caption || '').slice(0, 2200), hashtags: (b.hashtags || '').slice(0, 500), cta: (b.cta || '').slice(0, 300),
    mediaUrl: (b.mediaUrl || '').slice(0, 2000), mediaType: b.mediaType || 'video', posterUrl: (b.posterUrl || '').slice(0, 2000),
    platform: b.platform || 'Instagram', format: b.format || 'REELS',
    igAccountId: b.igAccountId || '', igAccountUsername: b.igAccountUsername || '',
    igTargets: Array.isArray(b.igTargets) ? b.igTargets.slice(0, 10) : [],
    igEnabled: b.igEnabled === false ? false : true,
    youtube: normalizeYouTubeSetting(b.youtube),
    ytVisibility: b.ytVisibility !== undefined ? ytVisibilityOf(b.ytVisibility) : 'public',
    ytMadeForKids: b.ytMadeForKids === true,
    firstComment: (b.firstComment || '').slice(0, 2200),
    repeat: b.repeat === 'weekly' ? 'weekly' : '',
    createdAt: new Date().toISOString(),
  };
  await db.saveDraft(d);
  res.json({ ok: true, draft: d });
}));
app.delete('/api/drafts/:id', ah(async (req, res) => {
  const removed = await db.deleteDraft(req.userId, String(req.params.id || ''));
  if (!removed) return res.status(404).json({ ok: false, error: 'That draft does not exist.' });
  res.json({ ok: true });
}));

// ---------- hashtag groups (composer hashtag bank) ----------
app.get('/api/hashtag-groups', ah(async (req, res) => {
  const groups = await db.listHashtagGroups(req.userId);
  res.json({ ok: true, hashtagGroups: groups });
}));
app.post('/api/hashtag-groups', ah(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name !== 'string' || typeof b.tags !== 'string' || !b.name.trim() || !b.tags.trim()) {
    return res.status(400).json({ ok: false, error: 'Give the group a name and at least one hashtag.' });
  }
  if (b.name.trim().length > 60) return res.status(400).json({ ok: false, error: 'Group names can be at most 60 characters.' });
  if (b.tags.length > 2000) return res.status(400).json({ ok: false, error: 'A hashtag group can be at most 2,000 characters.' });
  const existing = await db.listHashtagGroups(req.userId);
  if (existing.length >= 50) return res.status(400).json({ ok: false, error: 'You can save at most 50 hashtag groups — delete one first.' });
  const g = { id: uid('tag'), userId: req.userId, name: b.name.trim(), tags: b.tags.trim(), createdAt: new Date().toISOString() };
  await db.saveHashtagGroup(g);
  res.json({ ok: true, hashtagGroup: g });
}));
app.delete('/api/hashtag-groups/:id', ah(async (req, res) => {
  const removed = await db.deleteHashtagGroup(req.userId, String(req.params.id || ''));
  if (!removed) return res.status(404).json({ ok: false, error: 'That hashtag group does not exist.' });
  res.json({ ok: true });
}));

// ---------- team / agency (batch 3, Ultra foundation) ----------
// Owner side: list / invite / remove. Member side: memberships +
// context. Access itself is enforced by the workspace middleware —
// these endpoints only manage the invite records.
function publicInvite(inv) {
  return {
    id: inv.id, email: inv.email, role: inv.role, status: inv.status,
    memberUserId: inv.memberUserId || '', createdAt: inv.createdAt || '',
    boundAt: inv.boundAt || '',
  };
}
async function requireUltraOwner(req, res) {
  const user = await db.getUserById(req.userId);
  if (!user || effectivePlanOf(user).id !== 'ultra') {
    res.status(403).json({ ok: false, error: 'Team members are an Ultra plan feature. Upgrade to Ultra to invite your team.' });
    return null;
  }
  return user;
}
app.get('/api/team', ah(async (req, res) => {
  const user = await requireUltraOwner(req, res);
  if (!user) return;
  const invites = await db.listTeamInvites(req.userId);
  res.json({ ok: true, members: invites.map(publicInvite) });
}));
app.post('/api/team/invite', ah(async (req, res) => {
  const user = await requireUltraOwner(req, res);
  if (!user) return;
  const b = req.body || {};
  const typedEmail = String(b.email || '').trim().toLowerCase();
  const role = TEAM_ROLES.includes(b.role) ? b.role : '';
  if (!validEmail(typedEmail)) return res.status(400).json({ ok: false, error: 'Enter a valid email address for your team member.' });
  if (!role) return res.status(400).json({ ok: false, error: 'Pick a role: Scheduler (can create and schedule posts) or Viewer (can only look).' });
  // Invites are stored under the canonical identity, so any Gmail
  // spelling of the member's inbox resolves to the same invite.
  const email = canonicalEmail(typedEmail);
  if (!validEmail(email)) return res.status(400).json({ ok: false, error: 'Enter a valid email address for your team member.' });
  if (email === canonicalEmail(user.email)) return res.status(400).json({ ok: false, error: 'That is your own email — you already own this workspace.' });
  const invites = await db.listTeamInvites(req.userId);
  const existing = invites.find((i) => i.email === email && i.status !== 'removed');
  const liveCount = invites.filter((i) => i.status === 'invited' || i.status === 'active').length;
  if (!existing && liveCount >= TEAM_MEMBER_CAP) return res.status(400).json({ ok: false, error: `Your team can have at most ${TEAM_MEMBER_CAP} members — remove someone first.` });
  // If the invited email already has an account, the invite binds
  // right away; otherwise it binds at that account's next login.
  const account = await findUserForEmail(email).catch(() => null);
  if (existing) {
    const patch = { role };
    if (account && !existing.memberUserId) { patch.memberUserId = account.id; patch.status = 'active'; patch.boundAt = new Date().toISOString(); }
    const updated = await db.updateTeamInvite(existing.id, patch);
    return res.json({ ok: true, member: publicInvite(updated || { ...existing, ...patch }) });
  }
  const removed = invites.find((i) => i.email === email && i.status === 'removed');
  if (removed) {
    const patch = { role, status: account ? 'active' : 'invited', memberUserId: account ? account.id : (removed.memberUserId || ''), boundAt: account ? new Date().toISOString() : (removed.boundAt || ''), removedAt: '' };
    const updated = await db.updateTeamInvite(removed.id, patch);
    const member = updated || { ...removed, ...patch };
    const emailed = await sendTeamInviteEmail(user, member, publicBase(req));
    return res.json({ ok: true, member: publicInvite(member), emailed });
  }
  const inv = {
    id: uid('team'), ownerId: req.userId, email, role,
    status: account ? 'active' : 'invited',
    memberUserId: account ? account.id : '',
    createdAt: new Date().toISOString(),
    boundAt: account ? new Date().toISOString() : '',
  };
  await db.saveTeamInvite(inv);
  const emailed = await sendTeamInviteEmail(user, inv, publicBase(req));
  res.json({ ok: true, member: publicInvite(inv), emailed });
}));
app.delete('/api/team/:id', ah(async (req, res) => {
  const user = await requireUltraOwner(req, res);
  if (!user) return;
  const invites = await db.listTeamInvites(req.userId);
  const inv = invites.find((i) => i.id === String(req.params.id || ''));
  if (!inv) return res.status(404).json({ ok: false, error: 'That team member does not exist.' });
  if (inv.status !== 'removed') await db.updateTeamInvite(inv.id, { status: 'removed', removedAt: new Date().toISOString() });
  res.json({ ok: true });
}));
app.get('/api/team/memberships', ah(async (req, res) => {
  const selfId = req.selfId || req.userId;
  const mine = await db.listMemberships(selfId);
  const out = [];
  for (const inv of mine) {
    if (inv.status !== 'active') continue;
    const owner = await db.getUserById(inv.ownerId).catch(() => null);
    out.push({ ownerId: inv.ownerId, ownerEmail: (owner && owner.email) || '', role: inv.role });
  }
  res.json({ ok: true, memberships: out });
}));
app.get('/api/team/context', ah(async (req, res) => {
  if (!req.teamRole) return res.json({ ok: true, inWorkspace: false });
  const owner = await db.getUserById(req.userId).catch(() => null);
  res.json({ ok: true, inWorkspace: true, ownerEmail: (owner && owner.email) || '', role: req.teamRole });
}));

// ---------- AI caption assistant (batch 3, #10) ----------
// Suggests ONE caption + hashtag set + CTA from the user's own topic
// text, via Google Gemini. Suggestion only — the user edits before
// anything is used, and nothing is ever auto-posted. Abuse controls:
// a per-user DAILY cap from the plan config (PLANS.aiPerDay), counted
// on the user record and charged BEFORE the call so retry loops
// cannot drain the shared key; the ONLY thing sent to Gemini is the
// topic text the user typed for this suggestion (plus our fixed
// instruction) — no account data, no tokens, no post history.
// The key comes from the GEMINI_API_KEY env var (the app's own free
// Google AI Studio key). Without it the feature answers AI_OFF and
// scheduling carries on untouched — AI must never block a post.
function aiUsageOf(user) {
  const today = new Date().toISOString().slice(0, 10);
  const u = (user && user.aiUsage) || {};
  return { day: today, count: u.day === today && Number.isFinite(u.count) ? u.count : 0 };
}
app.post('/api/ai/caption', ah(async (req, res) => {
  const b = req.body || {};
  const topic = typeof b.topic === 'string' ? b.topic.trim() : '';
  if (topic.length < 3) return res.status(400).json({ ok: false, error: 'Write a few words about your post first — what is it about?' });
  if (topic.length > 600) return res.status(400).json({ ok: false, error: 'That description is too long — keep it under 600 characters.' });
  const user = await db.getUserById(req.userId);
  const plan = effectivePlanOf(user);
  const cap = plan.aiPerDay;
  const usage = aiUsageOf(user);
  if (Number.isFinite(cap) && usage.count >= cap) {
    return res.status(429).json({ ok: false, code: 'AI_CAP', error: `You have used today's ${cap} AI suggestions on the ${plan.name} plan. More unlock tomorrow — or on a bigger plan.` });
  }
  const key = process.env.GEMINI_API_KEY || '';
  if (!key) return res.status(503).json({ ok: false, code: 'AI_OFF', error: 'The AI caption assistant is not switched on yet. You can still write your caption as usual — nothing is blocked.' });
  await db.updateUser(req.userId, { aiUsage: { day: usage.day, count: usage.count + 1 } }).catch(() => null);
  const base = (process.env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  const model = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  const prompt = [
    'You help an Indian creator write ONE Instagram post caption.',
    'Reply with ONLY a JSON object, no markdown, no extra text:',
    '{"caption":"...","hashtags":"#tag1 #tag2","cta":"..."}',
    'Rules: caption at most 280 characters, warm and catchy, in the same language style as the topic (English or Hinglish); 8 to 15 relevant hashtags; cta is one short line asking for a like, comment, save or follow; no profanity, no hate, no medical or money claims.',
    `Topic: ${topic}`,
  ].join('\n');
  let data = null;
  try {
    const r = await fetch(`${base}/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 500 } }),
      signal: AbortSignal.timeout(20000),
    });
    data = await r.json().catch(() => null);
    if (!r.ok || !data) throw new Error('gemini http ' + r.status);
  } catch {
    return res.status(502).json({ ok: false, code: 'AI_ERROR', error: 'The AI assistant could not answer just now — try again in a moment, or write your caption as usual.' });
  }
  const text = (((data.candidates || [])[0] || {}).content || {}).parts?.map((p) => p.text || '').join('') || '';
  let parsed = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch { parsed = null; }
  if (!parsed || typeof parsed.caption !== 'string' || !parsed.caption.trim()) {
    return res.status(502).json({ ok: false, code: 'AI_ERROR', error: 'The AI assistant gave an unusable answer — try again, or write your caption as usual.' });
  }
  const hashtags = Array.isArray(parsed.hashtags)
    ? parsed.hashtags.map((h) => String(h || '').trim()).filter(Boolean).map((h) => (h.startsWith('#') ? h : `#${h}`)).join(' ')
    : String(parsed.hashtags || '');
  res.json({
    ok: true,
    caption: parsed.caption.trim().slice(0, 2200),
    hashtags: hashtags.slice(0, 500),
    cta: typeof parsed.cta === 'string' ? parsed.cta.trim().slice(0, 300) : '',
    remaining: Number.isFinite(cap) ? Math.max(0, cap - (usage.count + 1)) : null,
  });
}));

// ---------- my basic stats (batch 3, #14 foundation) ----------
// Counts from KiluaAI's OWN publish records only — posts published,
// how many finished posts went fully live, and per-account totals.
// Views/likes are NOT here: Instagram insights need Meta App Review,
// and this section never invents numbers.
app.get('/api/my-stats', ah(async (req, res) => {
  const posts = await db.listPosts(req.userId, { all: true });
  const counts = { total: posts.length, published: 0, partial: 0, failed: 0, scheduled: 0, drafts: 0 };
  const perAccount = new Map();
  const bump = (name, kind) => {
    const key = name || 'Unknown account';
    const row = perAccount.get(key) || { account: key, published: 0, failed: 0 };
    row[kind] += 1;
    perAccount.set(key, row);
  };
  const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const nowMonth = monthKey(new Date());
  let publishedThisMonth = 0;
  for (const p of posts) {
    if (p.status === 'published') counts.published++;
    else if (p.status === 'partial') counts.partial++;
    else if (p.status === 'failed') counts.failed++;
    else if (p.status === 'draft') counts.drafts++;
    else counts.scheduled++;
    if (p.publishedAt && monthKey(new Date(p.publishedAt)) === nowMonth) publishedThisMonth++;
    if (p.igEnabled === false) {
      if (p.status === 'published') bump('YouTube', 'published');
      else if (p.status === 'failed') bump('YouTube', 'failed');
      continue;
    }
    for (const t of targetsOf(p)) {
      if (t.status === 'published') bump(t.username ? `@${t.username}` : (t.igUserId || 'Instagram'), 'published');
      else if (t.status === 'failed' && !t.retryPending) bump(t.username ? `@${t.username}` : (t.igUserId || 'Instagram'), 'failed');
    }
  }
  const finished = counts.published + counts.partial + counts.failed;
  res.json({
    ok: true,
    stats: {
      ...counts,
      finished,
      successRate: finished ? Math.round((counts.published / finished) * 1000) / 10 : null,
      publishedThisMonth,
      perAccount: [...perAccount.values()].sort((a, b) => (b.published + b.failed) - (a.published + a.failed)),
    },
    note: 'Basic stats counted from your own posts in KiluaAI. Instagram views and likes will appear here after Meta App Review — they are not estimated.',
  });
}));

// ---------- Phase D: referral, link-in-bio, preview link ----------
// Referral (D11): the signed-in user's invite code + link + how many
// friends joined through it. Codes are minted at signup; accounts
// from before referrals get one lazily here. No rewards are promised
// anywhere — invites are tracked, rewards arrive with Pro.
app.get('/api/referral', ah(async (req, res) => {
  let user = await db.getUserById(req.userId);
  if (!user) return res.status(404).json({ ok: false, error: 'Account not found.' });
  if (!user.referralCode) {
    let code = '';
    do { code = 'K' + crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6); }
    while (await db.getUserByReferralCode(code));
    await db.updateUser(user.id, { referralCode: code });
    user = { ...user, referralCode: code };
  }
  const count = await db.countReferrals(user.referralCode);
  res.json({ ok: true, code: user.referralCode, link: `${publicBase(req)}/?ref=${user.referralCode}`, count });
}));
// Link-in-bio (D6): the owner's own config (session-authenticated).
app.get('/api/bio', ah(async (req, res) => {
  const bio = await db.getBio(req.userId).catch(() => null);
  res.json({ ok: true, bio: bio ? { slug: bio.slug || '', enabled: !!bio.enabled, links: Array.isArray(bio.links) ? bio.links : [] } : { slug: '', enabled: false, links: [] } });
}));
app.post('/api/bio', ah(async (req, res) => {
  const b = req.body || {};
  const slug = typeof b.slug === 'string' ? b.slug.trim().toLowerCase() : '';
  if (slug && !/^[a-z0-9-]{3,30}$/.test(slug)) return res.status(400).json({ ok: false, error: 'Your page name must be 3–30 characters: lowercase letters, numbers and dashes only.' });
  if (b.enabled !== undefined && typeof b.enabled !== 'boolean') return res.status(400).json({ ok: false, error: 'That bio setting is not valid.' });
  if (b.enabled && !slug) return res.status(400).json({ ok: false, error: 'Pick a page name (slug) before switching the page on.' });
  if (!Array.isArray(b.links) || b.links.length > 10) return res.status(400).json({ ok: false, error: 'Add at most 10 links.' });
  const links = [];
  for (const l of b.links) {
    if (!l || typeof l.title !== 'string' || typeof l.url !== 'string') return res.status(400).json({ ok: false, error: 'Each link needs a title and a URL.' });
    const title = l.title.trim().slice(0, 60);
    const url = l.url.trim().slice(0, 500);
    if (!title || !/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'Each link needs a title and a full https:// URL.' });
    links.push({ title, url });
  }
  if (slug) {
    const taken = await db.getBioBySlug(slug).catch(() => null);
    if (taken && taken.userId !== req.userId) return res.status(409).json({ ok: false, error: 'That page name is taken — pick another one.' });
  }
  const doc = { userId: req.userId, slug, enabled: !!b.enabled, links, updatedAt: new Date().toISOString() };
  await db.saveBio(doc);
  res.json({ ok: true, bio: { slug: doc.slug, enabled: doc.enabled, links: doc.links }, url: slug ? `${publicBase(req)}/bio/${slug}` : '' });
}));
// Preview/approval link (D8): a signed, revocable, read-only link
// listing upcoming scheduled posts. The token binds the user id to
// the user's current previewTokenId (stored in settings); rotating
// the id kills every previously shared link.
function previewTokenFor(userId, tokenId) {
  const payload = Buffer.from(`preview.${userId}`, 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`preview.${userId}.${tokenId}`).digest('hex');
  return `${payload}.${sig}`;
}
async function userIdFromPreviewToken(token) {
  try {
    if (!token || typeof token !== 'string') return '';
    const dot = token.lastIndexOf('.');
    if (dot < 0) return '';
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const parts = payload.split('.');
    if (parts.length !== 2 || parts[0] !== 'preview' || !parts[1]) return '';
    const userId = parts[1];
    const settings = await db.getSettings(userId).catch(() => null);
    if (!settings || !settings.previewTokenId) return '';
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`preview.${userId}.${settings.previewTokenId}`).digest('hex');
    const a = Buffer.from(token.slice(dot + 1), 'utf8'); const b2 = Buffer.from(expected, 'utf8');
    if (a.length !== b2.length || !crypto.timingSafeEqual(a, b2)) return '';
    return userId;
  } catch { return ''; }
}
app.get('/api/preview-link', ah(async (req, res) => {
  const settings = await db.getSettings(req.userId).catch(() => ({}));
  const url = settings.previewTokenId ? `${publicBase(req)}/preview/${previewTokenFor(req.userId, settings.previewTokenId)}` : '';
  res.json({ ok: true, url });
}));
app.post('/api/preview-link', ah(async (req, res) => {
  const settings = await db.getSettings(req.userId);
  if (!settings.previewTokenId) {
    settings.previewTokenId = crypto.randomBytes(12).toString('hex');
    await db.saveSettings(req.userId, settings);
  }
  res.json({ ok: true, url: `${publicBase(req)}/preview/${previewTokenFor(req.userId, settings.previewTokenId)}` });
}));
app.post('/api/preview-link/regenerate', ah(async (req, res) => {
  const settings = await db.getSettings(req.userId);
  settings.previewTokenId = crypto.randomBytes(12).toString('hex');
  await db.saveSettings(req.userId, settings);
  res.json({ ok: true, url: `${publicBase(req)}/preview/${previewTokenFor(req.userId, settings.previewTokenId)}` });
}));
// Public pages (no login): link-in-bio + preview. Everything rendered
// is escaped; only public data (published posts / scheduled times)
// is ever shown.
function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function publicPageShell(title, inner) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)} — KiluaAI</title></head>
<body style="margin:0;font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0e1325;color:#f5f1e6;min-height:100vh;padding:32px 20px;box-sizing:border-box">
<main style="max-width:520px;margin:0 auto">${inner}
<p style="text-align:center;font-size:12px;opacity:.55;margin-top:36px">Powered by <b>KiluaAI</b></p>
</main></body></html>`;
}
app.get('/bio/:slug', ah(async (req, res) => {
  const slug = String(req.params.slug || '').toLowerCase();
  const bio = await db.getBioBySlug(slug).catch(() => null);
  if (!bio || !bio.enabled) {
    return res.status(404).type('html').send(publicPageShell('Page not found', '<h1 style="text-align:center;font-size:22px;margin:24px 0 8px">This page is not available</h1><p style="text-align:center;opacity:.75">The link may be wrong, or the creator has switched this page off.</p>'));
  }
  const user = await db.getUserById(bio.userId).catch(() => null);
  const displayName = (user && user.name) || 'KiluaAI creator';
  const initial = displayName.trim().charAt(0).toUpperCase() || 'K';
  const posts = (await db.listPosts(bio.userId, { all: true }).catch(() => []))
    .filter((p) => p.status === 'published' && p.liveUrl)
    .sort((a, b2) => new Date(b2.scheduleTime || b2.createdAt || 0) - new Date(a.scheduleTime || a.createdAt || 0))
    .slice(0, 6);
  const linksHtml = (Array.isArray(bio.links) ? bio.links : []).map((l) => `<a href="${escHtml(l.url)}" style="display:block;background:#1a2140;color:#f5f1e6;text-decoration:none;font-weight:600;padding:13px 18px;border-radius:12px;margin:10px 0;text-align:center;border:1px solid #2b3560">${escHtml(l.title)}</a>`).join('');
  const postsHtml = posts.length ? `<h2 style="font-size:16px;margin:28px 0 10px;color:#e8c268">Latest posts</h2><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px">${posts.map((p) => {
    const thumb = p.posterUrl || (p.mediaType === 'image' ? p.mediaUrl : '');
    const img = thumb && /^(https?:\/\/|\/)/i.test(thumb) ? `<img src="${escHtml(thumb)}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">` : '<span style="font-size:11px;opacity:.7;padding:8px;text-align:center">View post</span>';
    return `<a href="${escHtml(p.liveUrl)}" style="display:flex;align-items:center;justify-content:center;aspect-ratio:4/5;background:#1a2140;border-radius:10px;overflow:hidden;text-decoration:none;color:#f5f1e6">${img}</a>`;
  }).join('')}</div>` : '';
  return res.type('html').send(publicPageShell(displayName, `
<div style="text-align:center">
<div style="width:76px;height:76px;border-radius:50%;background:#e8c268;color:#0e1325;font-size:32px;font-weight:800;display:flex;align-items:center;justify-content:center;margin:6px auto 12px">${escHtml(initial)}</div>
<h1 style="font-size:24px;margin:0 0 6px">${escHtml(displayName)}</h1>
<p style="opacity:.7;margin:0 0 18px;font-size:14px">Creator on KiluaAI</p>
</div>
${linksHtml}
${postsHtml}`));
}));
app.get('/preview/:token', ah(async (req, res) => {
  const userId = await userIdFromPreviewToken(String(req.params.token || ''));
  if (!userId) {
    return res.status(404).type('html').send(publicPageShell('Link not valid', '<h1 style="text-align:center;font-size:22px;margin:24px 0 8px">This preview link is not valid</h1><p style="text-align:center;opacity:.75">It may have been replaced by a newer link — ask the creator for the current one.</p>'));
  }
  const now = Date.now();
  const posts = (await db.listPosts(userId, { all: true }).catch(() => []))
    .filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() >= now - 3600000)
    .sort((a, b2) => new Date(a.scheduleTime) - new Date(b2.scheduleTime))
    .slice(0, 20);
  const rows = posts.length ? posts.map((p) => {
    const thumb = p.posterUrl || (p.mediaType === 'image' ? p.mediaUrl : '');
    const img = thumb && /^(https?:\/\/|\/)/i.test(thumb) ? `<img src="${escHtml(thumb)}" alt="" style="width:64px;height:80px;object-fit:cover;border-radius:8px;flex:none">` : '<span style="width:64px;height:80px;background:#1a2140;border-radius:8px;flex:none"></span>';
    const when = new Date(p.scheduleTime).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
    return `<div style="display:flex;gap:12px;align-items:flex-start;background:#1a2140;border:1px solid #2b3560;border-radius:12px;padding:12px;margin:10px 0">${img}<div><div style="font-weight:700;color:#e8c268;font-size:13px">${escHtml(when)} · ${escHtml(p.format || 'REELS')}</div><p style="margin:6px 0 0;font-size:14px;line-height:1.45">${escHtml(p.caption || '(no caption)')}</p>${p.hashtags ? `<p style="margin:4px 0 0;font-size:13px;opacity:.7">${escHtml(p.hashtags)}</p>` : ''}</div></div>`;
  }).join('') : '<p style="text-align:center;opacity:.75">Nothing is scheduled right now.</p>';
  return res.type('html').send(publicPageShell('Upcoming posts — preview', `
<h1 style="font-size:22px;margin:8px 0 4px">Upcoming posts</h1>
<p style="opacity:.7;margin:0 0 14px;font-size:14px">A read-only preview shared for approval. Times are UTC.</p>
${rows}`));
}));

// ---------- owner console (batch 2) ----------
// A server-rendered admin page + JSON API under the non-obvious
// ADMIN_SLUG path. Hard rules: (1) nothing in the client app links to
// or mentions it; (2) every route resolves the session server-side
// and answers with the app's plain 404 unless the caller is the OWNER
// account — a 403 or a login redirect would admit it exists; (3) the
// data endpoints additionally require a short-lived unlock token.
// The token is issued for the correct PIN, or — batch 6, at the
// owner's request — directly to a request that already carries the
// OWNER's own app session (he is already authenticated; any other
// session, or none, still gets the plain 404 everywhere).
const ADMIN_TOKEN_TTL_MS = 30 * 60 * 1000;
const adminPinAttempts = new Map();
function adminPinBlocked() {
  const rec = adminPinAttempts.get('pin');
  if (!rec) return false;
  if (Date.now() > rec.resetAt) { adminPinAttempts.delete('pin'); return false; }
  return rec.count >= 5;
}
function adminPinFail() {
  const rec = adminPinAttempts.get('pin') || { count: 0, resetAt: Date.now() + 10 * 60 * 1000 };
  rec.count += 1;
  adminPinAttempts.set('pin', rec);
}
function signAdminToken(userId) {
  const payload = `${userId}.${Date.now() + ADMIN_TOKEN_TTL_MS}`;
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(`admin.${payload}`).digest('hex');
  return `${Buffer.from(payload).toString('base64url')}.${sig}`;
}
function verifyAdminToken(token, userId) {
  try {
    if (!token || typeof token !== 'string') return false;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = Buffer.from(token.slice(0, dot), 'base64url').toString('utf8');
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`admin.${payload}`).digest('hex');
    const a = Buffer.from(token.slice(dot + 1)); const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    const cut = payload.lastIndexOf('.');
    if (payload.slice(0, cut) !== userId) return false;
    return Number(payload.slice(cut + 1)) > Date.now();
  } catch { return false; }
}
const adminApi404 = (res) => res.status(404).json({ ok: false, error: 'That API route does not exist.' });
async function adminOwner(req) {
  const me = await getAuthUser(req).catch(() => null);
  if (!me) return null;
  const owner = await db.ownerId().catch(() => null);
  return owner && me.id === owner ? me : null;
}
// Owner + valid PIN-unlock token, or the plain API 404.
async function requireAdminApi(req, res) {
  const me = await adminOwner(req);
  if (!me) { adminApi404(res); return null; }
  if (!verifyAdminToken(req.get('x-admin-token') || '', me.id)) { adminApi404(res); return null; }
  return me;
}
async function writeAdminAudit(admin, action, target, summary) {
  await db.addAdminAudit({
    id: uid('audit'), at: new Date().toISOString(), adminId: admin.id,
    action, targetUserId: target ? target.id : '', targetEmail: target ? target.email : '', summary,
  }).catch(() => null);
}
function adminFailedRow(u, p) {
  const t = targetsOf(p).find((x) => x.status === 'failed');
  const reason = p.lastPublishError || (t && t.error) || '';
  return {
    userEmail: u.email, postId: p.id, caption: String(p.caption || '').slice(0, 80),
    failedAt: p.failedAt || '', status: p.status, reason,
    friendly: friendlyFailureText(reason),
  };
}
async function adminOverviewData() {
  const users = await db.listUsers();
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const weekAgo = now.getTime() - 7 * 86400000;
  const ts = (iso) => { const x = new Date(iso || '').getTime(); return Number.isNaN(x) ? 0 : x; };
  let postsTotal = 0; let postsToday = 0; let postsMonth = 0;
  let published = 0; let failed = 0; let partial = 0; let scheduled = 0;
  let pubToday = 0; let pubWeek = 0; let failToday = 0; let failWeek = 0;
  const failedList = []; const perUserMonth = [];
  const byPlan = { free: 0, pro: 0, max: 0, ultra: 0 };
  let igTotal = 0; let igBroken = 0; let ytTotal = 0;
  for (const u of users) {
    const eff = effectivePlanOf(u).id;
    byPlan[eff] = (byPlan[eff] || 0) + 1;
    const posts = await db.listPosts(u.id, { all: true }).catch(() => []);
    let monthCount = 0;
    for (const p of posts) {
      postsTotal++;
      const c = ts(p.createdAt);
      if (c >= startToday) postsToday++;
      if (c >= startMonth) { postsMonth++; monthCount++; }
      if (p.status === 'published') published++;
      else if (p.status === 'failed') { failed++; failedList.push(adminFailedRow(u, p)); }
      else if (p.status === 'partial') { partial++; failedList.push(adminFailedRow(u, p)); }
      else if (p.status === 'scheduled') scheduled++;
      const pubT = ts(p.publishedAt); if (pubT >= startToday) pubToday++; if (pubT >= weekAgo) pubWeek++;
      const failT = ts(p.failedAt); if (failT >= startToday) failToday++; if (failT >= weekAgo) failWeek++;
    }
    perUserMonth.push({ email: u.email, count: monthCount });
    const { accounts } = await db.getInstagramAccounts(u.id).catch(() => ({ accounts: [] }));
    igTotal += accounts.length;
    igBroken += accounts.filter((a) => a.tokenRefreshError === 'revoked-or-expired').length;
    const yt = await db.getYouTube(u.id).catch(() => null);
    if (yt) ytTotal++;
  }
  failedList.sort((a, b) => String(b.failedAt || '').localeCompare(String(a.failedAt || '')));
  perUserMonth.sort((a, b) => b.count - a.count);
  const decided = published + failed;
  return {
    ok: true, generatedAt: now.toISOString(),
    users: {
      total: users.length,
      today: users.filter((u) => ts(u.createdAt) >= startToday).length,
      week: users.filter((u) => ts(u.createdAt) >= weekAgo).length,
      month: users.filter((u) => ts(u.createdAt) >= startMonth).length,
      byPlan,
    },
    posts: {
      total: postsTotal, today: postsToday, month: postsMonth,
      published, failed, partial, scheduled,
      publishedToday: pubToday, publishedWeek: pubWeek,
      failedToday: failToday, failedWeek: failWeek,
      successPct: decided ? Math.round((published / decided) * 100) : null,
    },
    recentSignups: [...users]
      .sort((a, b) => ts(b.createdAt) - ts(a.createdAt))
      .slice(0, 8)
      .map((u) => ({ email: u.email, name: u.name || '', createdAt: u.createdAt || '', plan: planInfoOf(u).planName })),
    failedPosts: failedList.slice(0, 25),
    mostActive: perUserMonth.filter((x) => x.count > 0).slice(0, 10),
    accounts: { instagram: igTotal, instagramBroken: igBroken, youtube: ytTotal },
  };
}
async function adminUserRow(u) {
  const posts = await db.listPosts(u.id, { all: true }).catch(() => []);
  const startMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const monthCount = posts.filter((p) => { const t = new Date(p.createdAt || '').getTime(); return !Number.isNaN(t) && t >= startMonth; }).length;
  const { accounts } = await db.getInstagramAccounts(u.id).catch(() => ({ accounts: [] }));
  const yt = await db.getYouTube(u.id).catch(() => null);
  return {
    id: u.id, email: u.email, name: u.name || '', role: u.role || 'member', createdAt: u.createdAt,
    plan: planInfoOf(u),
    postLimitOverride: Number(u.postLimitOverride) || 0,
    postsTotal: posts.length, postsThisMonth: monthCount,
    accounts: accounts.map((a) => ({ username: a.username || '', broken: a.tokenRefreshError === 'revoked-or-expired' })),
    youtubeConnected: !!yt,
  };
}

app.get(`/api/${ADMIN_SLUG}/status`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me) return adminApi404(res);
  res.json({
    ok: true,
    pinSet: !!me.adminPinHash,
    unlocked: verifyAdminToken(req.get('x-admin-token') || '', me.id),
    pinBlocked: adminPinBlocked(),
  });
}));
app.post(`/api/${ADMIN_SLUG}/set-pin`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me || me.adminPinHash) return adminApi404(res);
  const pin = String((req.body || {}).pin || '');
  if (pin.length < 4 || pin.length > 64) return res.status(400).json({ ok: false, error: 'Choose a PIN of at least 4 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  await db.updateUser(me.id, { adminPinHash: hashPassword(pin, salt), adminPinSalt: salt });
  await writeAdminAudit(me, 'pin-set', me, 'Console PIN set');
  res.json({ ok: true, adminToken: signAdminToken(me.id) });
}));
app.post(`/api/${ADMIN_SLUG}/change-pin`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const pin = String((req.body || {}).pin || '');
  if (pin.length < 4 || pin.length > 64) return res.status(400).json({ ok: false, error: 'Choose a PIN of at least 4 characters.' });
  const salt = crypto.randomBytes(16).toString('hex');
  await db.updateUser(me.id, { adminPinHash: hashPassword(pin, salt), adminPinSalt: salt });
  await writeAdminAudit(me, 'pin-change', me, 'Console PIN changed');
  res.json({ ok: true, adminToken: signAdminToken(me.id) });
}));
app.post(`/api/${ADMIN_SLUG}/unlock`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me || !me.adminPinHash) return adminApi404(res);
  if (adminPinBlocked()) return adminApi404(res);
  const pin = String((req.body || {}).pin || '');
  const attempt = hashPassword(pin, me.adminPinSalt || '');
  const a = Buffer.from(attempt); const b = Buffer.from(me.adminPinHash || '');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { adminPinFail(); return adminApi404(res); }
  adminPinAttempts.delete('pin');
  await writeAdminAudit(me, 'console-unlock', me, 'Console unlocked via PIN');
  res.json({ ok: true, adminToken: signAdminToken(me.id) });
}));
// Batch 6 (owner: "make admin access easy for me" + "jb admin bali ho
// tbhi open ho"): opening the console URL in a browser that holds a
// valid OWNER app session unlocks it without the PIN — adminOwner()
// resolves the session and only the owner account passes; every other
// session and every anonymous request gets the plain 404, exactly
// like the rest of the console. The PIN path above stays for browsers
// without an owner session, with its attempt limits untouched.
app.post(`/api/${ADMIN_SLUG}/session-unlock`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me) return adminApi404(res);
  await writeAdminAudit(me, 'console-unlock', me, 'Console unlocked via owner app session');
  res.json({ ok: true, adminToken: signAdminToken(me.id) });
}));
app.get(`/api/${ADMIN_SLUG}/overview`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  res.json(await adminOverviewData());
}));
// Shared pagination for the console lists (batch 6): page/pageSize
// query params, pageSize clamped to 1..100 (console pages ask for 50).
function adminPaginate(req, items, defaultSize = 50) {
  const total = items.length;
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || defaultSize, 1), 100);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(Number(req.query.page) || 1, 1), pages);
  return { page, pageSize, pages, total, slice: items.slice((page - 1) * pageSize, page * pageSize) };
}
// One console-shaped post row, whoever owns the post.
function adminPostRow(u, p) {
  const t = targetsOf(p);
  const failedT = t.find((x) => x.status === 'failed');
  const reason = p.lastPublishError || (failedT && failedT.error) || p.youtubeError || '';
  return {
    userId: u.id, userEmail: u.email, postId: p.id,
    caption: String(p.caption || '').slice(0, 120),
    status: p.status, format: p.format || '',
    platforms: [...(p.igEnabled === false ? [] : ['instagram']), ...(p.youtubeEnabled ? ['youtube'] : [])],
    accounts: t.map((x) => x.username || '').filter(Boolean),
    scheduleTime: p.scheduleTime || '', createdAt: p.createdAt || '',
    publishedAt: p.publishedAt || '', failedAt: p.failedAt || '',
    reason, friendly: friendlyFailureText(reason),
  };
}
async function adminAllPosts() {
  const users = await db.listUsers();
  const out = [];
  for (const u of users) {
    const posts = await db.listPosts(u.id, { all: true }).catch(() => []);
    for (const p of posts) out.push({ u, p });
  }
  return out;
}
const adminTs = (iso) => { const x = new Date(iso || '').getTime(); return Number.isNaN(x) ? 0 : x; };

app.get(`/api/${ADMIN_SLUG}/users`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const q = String(req.query.q || '').trim().toLowerCase();
  let users = await db.listUsers();
  if (q) users = users.filter((u) => String(u.email || '').toLowerCase().includes(q) || String(u.name || '').toLowerCase().includes(q));
  users = [...users].sort((a, b) => adminTs(b.createdAt) - adminTs(a.createdAt));
  const pg = adminPaginate(req, users);
  const rows = [];
  for (const u of pg.slice) rows.push(await adminUserRow(u));
  res.json({ ok: true, users: rows, total: pg.total, page: pg.page, pages: pg.pages, pageSize: pg.pageSize });
}));
app.get(`/api/${ADMIN_SLUG}/users/:id`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const target = await db.getUserById(req.params.id);
  if (!target) return adminApi404(res);
  const row = await adminUserRow(target);
  const posts = (await db.listPosts(target.id, { all: true }).catch(() => []))
    .sort((a, b) => adminTs(b.createdAt) - adminTs(a.createdAt))
    .slice(0, 50)
    .map((p) => adminPostRow(target, p));
  const audit = (await db.listAdminAudit({ limit: 500 }))
    .filter((e) => e.targetUserId === target.id)
    .slice(0, 20);
  res.json({ ok: true, user: row, posts, audit });
}));
app.patch(`/api/${ADMIN_SLUG}/users/:id`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const target = await db.getUserById(req.params.id);
  if (!target) return adminApi404(res);
  const b = req.body || {};
  const patch = {}; const changes = [];
  if (b.plan !== undefined) {
    if (!PLANS[b.plan]) return res.status(400).json({ ok: false, error: 'Unknown plan.' });
    if ((target.plan || 'free') !== b.plan) { patch.plan = b.plan; changes.push(['plan-change', `Plan: ${target.plan || 'free'} → ${b.plan}`]); }
  }
  if (b.planExpiresAt !== undefined) {
    const v = b.planExpiresAt === null ? '' : String(b.planExpiresAt);
    if (v && Number.isNaN(new Date(v).getTime())) return res.status(400).json({ ok: false, error: 'That expiry date is not valid.' });
    if ((target.planExpiresAt || '') !== v) { patch.planExpiresAt = v; changes.push(['plan-expiry', v ? `Plan expiry set to ${v.slice(0, 10)}` : 'Plan expiry cleared']); }
  }
  if (b.comp !== undefined) {
    const v = b.comp === true;
    if (!!target.comp !== v) { patch.comp = v; changes.push([v ? 'comp-grant' : 'comp-revoke', v ? 'Comp granted — full Ultra, free forever' : 'Comp removed']); }
  }
  if (b.postLimitOverride !== undefined) {
    if (b.postLimitOverride === null || b.postLimitOverride === '') {
      if (Number(target.postLimitOverride) > 0) { patch.postLimitOverride = 0; changes.push(['limit-override', 'Monthly post limit override cleared']); }
    } else {
      const n = Math.floor(Number(b.postLimitOverride));
      if (!Number.isFinite(n) || n < 1 || n > 100000) return res.status(400).json({ ok: false, error: 'The limit override must be a whole number between 1 and 100000.' });
      if (Number(target.postLimitOverride || 0) !== n) { patch.postLimitOverride = n; changes.push(['limit-override', `Monthly post limit override set to ${n}`]); }
    }
  }
  if (Object.keys(patch).length) await db.updateUser(target.id, patch);
  for (const [action, summary] of changes) await writeAdminAudit(me, action, target, summary);
  const updated = await db.getUserById(target.id);
  res.json({ ok: true, user: await adminUserRow(updated) });
}));
app.get(`/api/${ADMIN_SLUG}/audit`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const all = await db.listAdminAudit({ limit: 500 });
  const pg = adminPaginate(req, all);
  res.json({ ok: true, entries: pg.slice, total: pg.total, page: pg.page, pages: pg.pages, pageSize: pg.pageSize });
}));
app.get(`/api/${ADMIN_SLUG}/posts`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const status = String(req.query.status || '').trim();
  const q = String(req.query.q || '').trim().toLowerCase();
  const userId = String(req.query.userId || '').trim();
  const from = adminTs(req.query.from || '');
  const to = req.query.to ? adminTs(req.query.to) : 0;
  let items = (await adminAllPosts()).map(({ u, p }) => adminPostRow(u, p));
  if (status) items = items.filter((r) => r.status === status);
  if (userId) items = items.filter((r) => r.userId === userId);
  if (q) items = items.filter((r) => r.caption.toLowerCase().includes(q) || r.userEmail.toLowerCase().includes(q));
  if (from) items = items.filter((r) => adminTs(r.createdAt) >= from);
  if (to) items = items.filter((r) => adminTs(r.createdAt) <= to);
  items.sort((a, b) => adminTs(b.createdAt) - adminTs(a.createdAt));
  const pg = adminPaginate(req, items);
  res.json({ ok: true, posts: pg.slice, total: pg.total, page: pg.page, pages: pg.pages, pageSize: pg.pageSize });
}));
app.get(`/api/${ADMIN_SLUG}/failures`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  let items = (await adminAllPosts())
    .filter(({ p }) => p.status === 'failed' || p.status === 'partial')
    .map(({ u, p }) => adminPostRow(u, p));
  items.sort((a, b) => (adminTs(b.failedAt) || adminTs(b.createdAt)) - (adminTs(a.failedAt) || adminTs(a.createdAt)));
  const pg = adminPaginate(req, items);
  res.json({ ok: true, posts: pg.slice, total: pg.total, page: pg.page, pages: pg.pages, pageSize: pg.pageSize });
}));
// Admin retry: the SAME one-tap retry core the user route uses,
// aimed at another user's post. Always audit-logged with the outcome.
app.post(`/api/${ADMIN_SLUG}/posts/:userId/:postId/retry`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const target = await db.getUserById(req.params.userId);
  if (!target) return adminApi404(res);
  const post = await db.getPost(target.id, req.params.postId).catch(() => null);
  if (!post) return adminApi404(res);
  const r = await retryPostForUser(target.id, post.id, publicBase(req));
  const outcome = r.body && r.body.ok
    ? (r.body.partial ? 'retried — partly published' : 'retried — published')
    : `retry did not publish (${(r.body && r.body.error) || r.status})`;
  await writeAdminAudit(me, 'post-retry', target, `Retry of post ${post.id} for ${target.email}: ${outcome}`);
  return res.status(r.status).json(r.body);
}));
app.get(`/api/${ADMIN_SLUG}/plans`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const users = await db.listUsers();
  const usersPerPlan = { free: 0, pro: 0, max: 0, ultra: 0 };
  for (const u of users) { const id = effectivePlanOf(u).id; usersPerPlan[id] = (usersPerPlan[id] || 0) + 1; }
  const ser = (n) => (Number.isFinite(n) ? n : null);
  res.json({
    ok: true,
    // Honest state (batch 6): checkout is not wired yet, so no money
    // is collected anywhere — never show revenue numbers we do not have.
    paymentsLive: false,
    paymentsNote: 'Payments are not live yet — nobody can pay inside the app today. Plans are granted by hand from the Users page, and no revenue figures exist to show.',
    usersPerPlan,
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, priceInr: p.priceInr,
      limits: { accounts: ser(p.accounts), igAccounts: ser(p.igAccounts), postsPerDay: ser(p.postsPerDay), postsPerMonth: ser(p.postsPerMonth), aiPerDay: ser(p.aiPerDay) },
      fullBridge: !!p.fullBridge,
    })),
  });
}));
app.get(`/api/${ADMIN_SLUG}/connections`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const users = await db.listUsers();
  const rows = []; const disconnected = [];
  for (const u of users) {
    const { accounts } = await db.getInstagramAccounts(u.id).catch(() => ({ accounts: [] }));
    const yt = await db.getYouTube(u.id).catch(() => null);
    const ig = accounts.map((a) => {
      const broken = a.tokenRefreshError === 'revoked-or-expired';
      if (broken) disconnected.push({ userId: u.id, userEmail: u.email, platform: 'instagram', username: a.username || '' });
      return { username: a.username || '', broken };
    });
    rows.push({ userId: u.id, email: u.email, instagram: ig, youtube: !!yt, brokenCount: ig.filter((a) => a.broken).length });
  }
  res.json({ ok: true, rows, disconnected });
}));
// Broadcast: an in-app announcement to EVERY user through the normal
// notifications system (Dashboard bell/list). The confirm flag is
// required server-side — the console's checkbox alone is not the
// guard — and the send is audit-logged with its recipient count.
app.post(`/api/${ADMIN_SLUG}/broadcast`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const b = req.body || {};
  const title = String(b.title || '').trim().slice(0, 120);
  const body = String(b.body || '').trim().slice(0, 1000);
  if (!title || !body) return res.status(400).json({ ok: false, error: 'Write both a title and a message for the announcement.' });
  if (b.confirm !== true) return res.status(400).json({ ok: false, error: 'Confirm the broadcast first — it goes to every user.' });
  const users = await db.listUsers();
  const at = new Date().toISOString();
  let sent = 0;
  for (const u of users) {
    await db.saveNotification({
      id: uid('ntf'), userId: u.id, type: 'announcement',
      title, message: body, createdAt: at,
    }).then(() => { sent++; }).catch(() => null);
  }
  await writeAdminAudit(me, 'broadcast', null, `Broadcast to ${sent} users: ${title}`);
  res.json({ ok: true, sent });
}));
app.get(`/api/${ADMIN_SLUG}/settings`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const ser = (n) => (Number.isFinite(n) ? n : null);
  res.json({
    ok: true,
    settings: await db.getGlobalSettings(),
    // Plan prices/limits are READ-ONLY here on purpose: they live in
    // exactly one place (the PLANS config in the app code) so the
    // app, the pricing page and this console can never disagree.
    plansNote: 'Plan prices and limits live in one place in the app code (the PLANS config) so the app and this console can never show different numbers. They are read-only here — changing them is a code change, never a second source of truth.',
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, priceInr: p.priceInr,
      limits: { accounts: ser(p.accounts), postsPerDay: ser(p.postsPerDay), postsPerMonth: ser(p.postsPerMonth), aiPerDay: ser(p.aiPerDay) },
    })),
  });
}));
app.patch(`/api/${ADMIN_SLUG}/settings`, ah(async (req, res) => {
  const me = await requireAdminApi(req, res);
  if (!me) return;
  const b = req.body || {};
  const before = await db.getGlobalSettings();
  const patch = {}; const changes = [];
  if (b.signupOpen !== undefined) {
    const v = b.signupOpen === true;
    if (!!before.signupOpen !== v) { patch.signupOpen = v; changes.push(v ? 'Signups opened' : 'Signups paused'); }
  }
  if (b.maintenance !== undefined) {
    const v = b.maintenance === true;
    if (!!before.maintenance !== v) { patch.maintenance = v; changes.push(v ? 'Maintenance mode ON' : 'Maintenance mode OFF'); }
  }
  if (b.maintenanceMessage !== undefined) {
    const v = String(b.maintenanceMessage || '').trim().slice(0, 300);
    if (String(before.maintenanceMessage || '') !== v) { patch.maintenanceMessage = v; changes.push('Maintenance message updated'); }
  }
  if (Object.keys(patch).length) {
    await db.saveGlobalSettings(patch);
    bustGlobalSettingsCache();
    await writeAdminAudit(me, 'settings-change', null, changes.join('; ') || 'Settings updated');
  }
  res.json({ ok: true, settings: await db.getGlobalSettings() });
}));

// Owner backup export: the app-side replacement for the blocked
// mongodump plan. The production MONGODB_URI is a write-only Vercel
// Secret — nothing outside this process can ever read the database
// back — so the app exports ITSELF and the owner's backup server pulls
// the result. Gated by a dedicated env token (BACKUP_TOKEN) sent as
// the `x-backup-token` header, NOT by the console session/PIN: the
// caller is a machine, not a browser. Doctrine matches the console:
// EVERY failure — env var unset, header missing, token wrong — is the
// plain API 404, so the route's existence is never admitted. The
// export is full-fidelity (password hashes and connection tokens
// included — a backup without them cannot be restored) and read-only.
app.get(`/api/${ADMIN_SLUG}/backup-export`, ah(async (req, res) => {
  const expected = process.env.BACKUP_TOKEN || '';
  const given = req.get('x-backup-token') || '';
  const a = Buffer.from(given, 'utf8'); const b = Buffer.from(expected, 'utf8');
  if (!expected || !given || a.length !== b.length || !crypto.timingSafeEqual(a, b)) return adminApi404(res);
  const collections = await db.exportDatabase();
  res.json({ exportedAt: new Date().toISOString(), app: 'kiluaai', collections });
}));

// The console page itself: served ONLY to the owner's session; every
// other visitor gets the plain 404 below. All data loads through the
// PIN-gated API above — the page shell alone contains nothing about
// any user. Plain numbers and simple bars, no chart library (house
// rule: fast and ₹0).
const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Owner Console — KiluaAI</title>
<style>
body{margin:0;background:#0e1325;color:#f5f1e6;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 18px;padding-top:calc(14px + env(safe-area-inset-top,0px));border-bottom:1px solid #2b3560;background:#1a2140;position:sticky;top:0;z-index:5}
#hdrSearch{width:220px;min-height:44px}
header b{color:#e8c268}
main{max-width:1180px;margin:0 auto;padding:16px}
.card{background:#1a2140;border:1px solid #2b3560;border-radius:16px;padding:16px;margin:0 0 14px}
h2{margin:0 0 10px;font-size:17px}
.muted{opacity:.72;font-size:13px}
.err{color:#ff9a9a;font-size:14px;min-height:18px}
.okmsg{color:#8fe3b0;font-size:14px;min-height:18px}
label{display:block;font-size:13px;opacity:.8;margin:10px 0 4px}
input,select,textarea{background:#0e1325;border:1px solid #2b3560;border-radius:12px;color:#f5f1e6;padding:10px 11px;font-size:14px;width:100%;box-sizing:border-box;font-family:inherit;min-height:44px}
input[type=date]{width:auto}
input[type=checkbox]{width:auto;min-height:0}
.btn{background:#1a2140;border:1px solid #2b3560;color:#f5f1e6;border-radius:12px;padding:8px 14px;font-size:14px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;min-height:44px;box-sizing:border-box}
.btn.primary{background:#e8c268;border-color:#e8c268;color:#191204;font-weight:700}
.btn.small{padding:8px 12px;font-size:13px;min-height:44px}
.btn.active{background:#e8c268;border-color:#e8c268;color:#191204;font-weight:700}
.btn:disabled{opacity:.45;cursor:default}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:10px}
.stat{background:#0e1325;border:1px solid #2b3560;border-radius:12px;padding:11px}
.stat b{display:block;font-size:21px;color:#e8c268}
.stat span{font-size:12px;opacity:.75}
.secttl{font-size:12.5px;text-transform:uppercase;letter-spacing:.07em;opacity:.65;margin:16px 0 8px}
.secttl:first-of-type{margin-top:2px}
.conseq{font-size:12.5px;opacity:.65;margin:-4px 0 12px 27px}
.preview{border:1px dashed #2b3560;border-radius:12px;padding:11px 13px;background:#0e1325;margin-top:10px}
.pfchip{cursor:pointer;background:transparent;color:#f5f1e6;min-height:44px;display:inline-flex;align-items:center}
.pfchip.active{background:#e8c268;border-color:#e8c268;color:#191204;font-weight:700}
.chips{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}
.chip{border:1px solid #2b3560;border-radius:999px;padding:5px 12px;font-size:13px}
.row{border-top:1px solid #2b3560;padding:11px 0;overflow-wrap:anywhere}
.row:first-of-type{border-top:none}
.bar{height:8px;background:#2b3560;border-radius:99px;overflow:hidden;margin-top:5px}
.bar i{display:block;height:100%;background:#e8c268}
.uhead{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;align-items:baseline}
.uemail{font-weight:700}
.badge{font-size:12px;border:1px solid #2b3560;border-radius:999px;padding:2px 9px}
.badge.bad{border-color:#a03d3d;color:#ff9a9a}
.controls{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px}
.controls input{width:auto}
.klabel{font-size:12px;opacity:.7;width:100%}
.layout{display:flex;gap:14px;align-items:flex-start}
nav.side{flex:0 0 178px;background:#1a2140;border:1px solid #2b3560;border-radius:16px;padding:10px;position:sticky;top:74px}
nav.side button{display:block;width:100%;text-align:left;background:transparent;border:1px solid transparent;color:#f5f1e6;border-radius:12px;padding:11px;font-size:14px;cursor:pointer;margin:2px 0;min-height:44px}
nav.side button:hover{border-color:#2b3560}
nav.side button.active{background:#e8c268;color:#191204;font-weight:700}
.views{flex:1;min-width:0}
.view{display:none}
.view.on{display:block}
.pager{display:flex;gap:8px;align-items:center;margin-top:10px;flex-wrap:wrap}
.filters{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-bottom:6px}
.filters>div{flex:1;min-width:140px}
.filters label{margin-top:0}
.toggle{display:flex;gap:9px;align-items:center;cursor:pointer;margin:12px 0;min-height:44px}
.toggle input{width:18px;height:18px;flex:none}
.banner{border:1px solid #a03d3d;background:#2a1420;border-radius:12px;padding:11px 13px;margin:0 0 12px;font-size:14px}
.banner.info{border-color:#2b3560;background:#1a2140}
table{width:100%;border-collapse:collapse;font-size:14px}
td,th{padding:7px 8px;border-top:1px solid #2b3560;text-align:left;vertical-align:top}
tr:first-child td,tr:first-child th{border-top:none}
input:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid #e8c268;outline-offset:1px}
.btn:focus-visible,nav.side button:focus-visible{outline:2px solid #e8c268;outline-offset:2px}
@media (max-width:760px){.layout{flex-direction:column}nav.side{flex:none;width:100%;position:static;display:flex;flex-wrap:nowrap;overflow-x:auto;gap:4px;padding:8px}nav.side button{width:auto;flex:0 0 auto}#hdrSearch{width:100%;margin-bottom:6px}}
</style></head>
<body>
<header><b>KiluaAI — Owner Console</b>
<span id="hdrBtns" hidden>
<input id="hdrSearch" type="search" placeholder="Jump to user by email…" aria-label="Jump to user by email">
<a class="btn small" href="/" style="text-decoration:none">Switch to User Panel</a>
<button class="btn small" id="refreshBtn">Refresh</button>
<button class="btn small" id="lockBtn">Lock</button>
</span></header>
<main>
<section class="card" id="gate">
<h2>Console locked</h2>
<p class="muted" id="gateMsg">Checking…</p>
<div id="setPinForm" hidden>
<label for="pin1">New PIN (at least 4 characters)</label>
<input id="pin1" type="password" autocomplete="new-password">
<label for="pin2">Repeat the PIN</label>
<input id="pin2" type="password" autocomplete="new-password">
<p style="margin-top:12px"><button class="btn primary" id="setPinBtn">Set PIN and open</button></p>
</div>
<div id="unlockForm" hidden>
<label for="pinU">PIN</label>
<input id="pinU" type="password" autocomplete="current-password">
<p style="margin-top:12px"><button class="btn primary" id="unlockBtn">Unlock</button></p>
</div>
<p class="err" id="gateErr"></p>
</section>
<div id="app" hidden>
<div class="layout">
<nav class="side" id="sideNav">
<button data-nav="dashboard" class="active">Dashboard</button>
<button data-nav="users">Users</button>
<button data-nav="userdetail" id="navUserDetail" hidden>User Detail</button>
<button data-nav="posts">Posts</button>
<button data-nav="plans">Plans</button>
<button data-nav="connections">Connections</button>
<button data-nav="failures">Failures</button>
<button data-nav="broadcast">Broadcast</button>
<button data-nav="audit">Audit Log</button>
<button data-nav="settings">Settings</button>
</nav>
<div class="views">
<section class="view on" id="view-dashboard">
<div id="attention"></div>
<div class="card"><h2>Dashboard</h2>
<h3 class="secttl">Users</h3><div class="grid" id="statsUsers"></div>
<div class="chips" id="planDist"></div>
<h3 class="secttl">Posts</h3><div class="grid" id="statsPosts"></div>
<h3 class="secttl">Reliability</h3><div class="grid" id="statsRel"></div>
<p class="muted" id="acctHealth" style="margin-top:10px"></p></div>
<div class="card"><h2>Recent signups</h2><div id="signups"></div></div>
<div class="card"><h2>Most active this month</h2><div id="active"></div></div>
</section>
<section class="view" id="view-users">
<div class="card"><h2>Users</h2>
<input id="search" type="search" placeholder="Search by email or name">
<div class="chips" id="planFilter" style="margin:10px 0 2px">
<button class="chip pfchip active" data-pf="all">All plans</button>
<button class="chip pfchip" data-pf="free">Free</button>
<button class="chip pfchip" data-pf="pro">Pro</button>
<button class="chip pfchip" data-pf="max">Max</button>
<button class="chip pfchip" data-pf="ultra">Ultra</button>
</div>
<div id="users" style="margin-top:8px"></div>
<div class="pager" id="usersPager"></div></div>
</section>
<section class="view" id="view-userdetail">
<div class="card"><button class="btn small" data-act="back-users">← Back to Users</button>
<h2 style="margin-top:12px">User Detail</h2><div id="udetail"></div></div>
<div class="card"><h2>Actions</h2><div id="udActions"></div><p class="okmsg" id="udMsg"></p></div>
<div class="card"><h2>Their posts (latest 50)</h2><div id="udetailPosts"></div></div>
<div class="card"><h2>Audit entries for this user</h2><div id="udetailAudit"></div></div>
</section>
<section class="view" id="view-posts">
<div class="card"><h2>Posts — all users</h2>
<div class="filters">
<div><label for="postStatus">Status</label><select id="postStatus">
<option value="">All statuses</option><option value="scheduled">Scheduled</option>
<option value="published">Published</option><option value="failed">Failed</option>
<option value="partial">Partly published</option><option value="draft">Draft</option>
</select></div>
<div><label for="postQ">Search caption or email</label><input id="postQ" type="search" placeholder="Search…"></div>
</div>
<div id="posts"></div>
<div class="pager" id="postsPager"></div></div>
</section>
<section class="view" id="view-plans">
<div class="card"><h2>Plans</h2><div id="plansNote"></div><div id="plans"></div></div>
</section>
<section class="view" id="view-connections">
<div class="card"><h2>Disconnected accounts</h2><div id="disconnected"></div></div>
<div class="card"><h2>Connections by user</h2><div id="connections"></div></div>
</section>
<section class="view" id="view-failures">
<div class="card"><h2>Failed posts — newest first</h2><div id="failures"></div>
<div class="pager" id="failuresPager"></div></div>
</section>
<section class="view" id="view-broadcast">
<div class="card"><h2>Broadcast — in-app announcement</h2>
<p class="muted">Goes to every user's in-app notifications (the bell on their Dashboard). It is not an email.</p>
<label for="bcTitle">Title</label>
<input id="bcTitle" type="text" maxlength="120" placeholder="e.g. New: best-time suggestions are live">
<label for="bcBody">Message</label>
<textarea id="bcBody" rows="4" maxlength="1000" placeholder="Write the announcement…"></textarea>
<div class="preview" id="bcPreview"></div>
<label class="toggle"><input type="checkbox" id="bcConfirm"> <span>Yes — send this to ALL users now <span class="muted" id="bcCount"></span></span></label>
<p><button class="btn primary" id="bcSend" disabled>Send broadcast</button></p>
<p class="okmsg" id="bcMsg"></p><p class="err" id="bcErr"></p></div>
</section>
<section class="view" id="view-audit">
<div class="card"><h2>Audit log</h2>
<div class="filters">
<div><label for="auditAction">Action</label><select id="auditAction"><option value="">All actions</option></select></div>
<div><label for="auditTarget">Target user</label><select id="auditTarget"><option value="">All users</option></select></div>
</div>
<p class="muted">Filters apply to the entries on this page.</p>
<div id="audit"></div>
<div class="pager" id="auditPager"></div></div>
</section>
<section class="view" id="view-settings">
<div class="card"><h2>Settings — global toggles</h2>
<label class="toggle"><input type="checkbox" id="setSignup"> <span><b>Signups open</b> — when off, new accounts cannot be created (existing users log in as usual)</span></label>
<p class="conseq">Off karne se naye users account nahi bana payenge — jo pehle se hain, woh login karke sab use kar sakte hain.</p>
<label class="toggle"><input type="checkbox" id="setMaint"> <span><b>Maintenance mode</b> — when on, posting and other changes pause for regular users; reading and login still work, and you (the owner) are never blocked</span></label>
<p class="conseq">On karne se regular users ke posts aur changes ruk jayenge — sirf dekhna aur login chalega; aap (owner) kabhi block nahi hote.</p>
<label for="setMaintMsg">Maintenance message (shown to users while maintenance is on)</label>
<textarea id="setMaintMsg" rows="2" maxlength="300" placeholder="e.g. Back in 10 minutes — fixing something quick."></textarea>
<p style="margin-top:12px"><button class="btn primary" id="setSave">Save settings</button> <span class="muted" id="setMsg"></span></p></div>
<div class="card"><h2>Plan prices &amp; limits (read-only)</h2><p class="muted" id="plansNote2"></p><div id="plansReadonly"></div></div>
<div class="card"><h2>Change PIN</h2>
<input id="newPin" type="password" placeholder="New PIN (at least 4 characters)" autocomplete="new-password">
<p style="margin-top:10px"><button class="btn" id="changePinBtn">Change PIN</button> <span class="muted" id="pinMsg"></span></p></div>
</section>
</div>
</div>
</div>
</main>
<script src="/api/${ADMIN_SLUG}/app.js"></script>
</body></html>
`;
const ADMIN_PAGE_JS = `
var BASE = location.pathname.slice(0, location.pathname.lastIndexOf('/'));
var token = sessionStorage.getItem('oc-token') || '';
function el(id){ return document.getElementById(id); }
function esc(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function when(iso){ var d = new Date(iso || ''); return isNaN(d.getTime()) ? '' : d.toLocaleString(); }
function post(path, body){ return fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-admin-token': token }, body: JSON.stringify(body || {}) }); }
function api(path, opts){
  opts = opts || {};
  opts.headers = { 'Content-Type': 'application/json', 'x-admin-token': token };
  return fetch(BASE + path, opts).then(function(r){
    if (r.status === 404) { lock('Locked — enter the PIN again.'); throw new Error('locked'); }
    return r.json();
  });
}
function lock(msg){
  token = ''; sessionStorage.removeItem('oc-token');
  el('app').hidden = true; el('hdrBtns').hidden = true; el('gate').hidden = false;
  el('gateErr').textContent = msg || '';
  gateForms();
}
function gateForms(){
  fetch(BASE + '/status', { headers: { 'x-admin-token': token } }).then(function(r){ return r.json(); }).then(function(s){
    el('setPinForm').hidden = !!s.pinSet;
    el('unlockForm').hidden = !s.pinSet;
    el('gateMsg').textContent = s.pinSet ? 'Enter your PIN to open the console.' : 'First visit: set a PIN for this console. Only your account can open this page at all; the PIN is a second lock on top.';
    if (s.pinBlocked) el('gateErr').textContent = 'Too many wrong PIN tries — wait 10 minutes, then try again.';
  }).catch(function(){ el('gateMsg').textContent = 'Could not check the console status.'; });
}
function openApp(){ el('gate').hidden = true; el('app').hidden = false; el('hdrBtns').hidden = false; showView(startView(), true); }
function boot(){
  if (!token) { trySessionUnlock(); return; }
  fetch(BASE + '/status', { headers: { 'x-admin-token': token } }).then(function(r){ return r.json(); }).then(function(s){
    if (s.unlocked) openApp(); else trySessionUnlock();
  }).catch(function(){ trySessionUnlock(); });
}
// Batch 6: if this browser already holds the owner's app session, the
// server hands back an unlock token and no PIN is needed. Any other
// session (or none) answers 404 and we fall through to the PIN gate.
function trySessionUnlock(){
  fetch(BASE + '/session-unlock', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then(function(r){
    if (r.status !== 200) throw new Error('no owner session');
    return r.json();
  }).then(function(d){
    if (d && d.adminToken) { token = d.adminToken; sessionStorage.setItem('oc-token', token); el('gateErr').textContent = ''; openApp(); }
    else gateForms();
  }).catch(function(){ gateForms(); });
}
el('setPinBtn').addEventListener('click', function(){
  var p1 = el('pin1').value, p2 = el('pin2').value;
  if (p1.length < 4) { el('gateErr').textContent = 'The PIN needs at least 4 characters.'; return; }
  if (p1 !== p2) { el('gateErr').textContent = 'The two PINs do not match.'; return; }
  post('/set-pin', { pin: p1 }).then(function(r){ return r.json().then(function(d){ return { s: r.status, d: d }; }); }).then(function(x){
    if (x.s === 200 && x.d.adminToken) { token = x.d.adminToken; sessionStorage.setItem('oc-token', token); openApp(); }
    else el('gateErr').textContent = (x.d && x.d.error) || 'Could not set the PIN.';
  }).catch(function(){ el('gateErr').textContent = 'Could not set the PIN.'; });
});
el('unlockBtn').addEventListener('click', function(){
  post('/unlock', { pin: el('pinU').value }).then(function(r){ return r.json().then(function(d){ return { s: r.status, d: d }; }); }).then(function(x){
    if (x.s === 200 && x.d.adminToken) { token = x.d.adminToken; sessionStorage.setItem('oc-token', token); el('gateErr').textContent = ''; openApp(); }
    else el('gateErr').textContent = 'That PIN did not work.';
  }).catch(function(){ el('gateErr').textContent = 'That PIN did not work.'; });
});
el('lockBtn').addEventListener('click', function(){ lock(''); });
el('refreshBtn').addEventListener('click', function(){ loadAll(); });
el('changePinBtn').addEventListener('click', function(){
  var p = el('newPin').value;
  if (p.length < 4) { el('pinMsg').textContent = 'At least 4 characters.'; return; }
  api('/change-pin', { method: 'POST', body: JSON.stringify({ pin: p }) }).then(function(d){
    if (d.adminToken) { token = d.adminToken; sessionStorage.setItem('oc-token', token); }
    el('pinMsg').textContent = 'PIN changed.'; el('newPin').value = '';
  }).catch(function(){});
});

// ---------- views / router ----------
var currentView = 'dashboard';
var currentUserId = '';
var pageState = { users: 1, posts: 1, failures: 1, audit: 1 };
var VIEWS = ['dashboard','users','userdetail','posts','plans','connections','failures','broadcast','audit','settings'];
function startView(){
  var h = String(location.hash || '').replace('#/', '');
  if (h.indexOf('user/') === 0) { currentUserId = h.slice(5); return 'userdetail'; }
  return VIEWS.indexOf(h) >= 0 && h !== 'userdetail' ? h : 'dashboard';
}
function showView(name, force){
  if (name === 'userdetail' && !currentUserId) name = 'users';
  currentView = name;
  VIEWS.forEach(function(v){ el('view-' + v).classList.toggle('on', v === name); });
  var btns = el('sideNav').querySelectorAll('[data-nav]');
  btns.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-nav') === name); });
  el('navUserDetail').hidden = !currentUserId;
  var want = name === 'userdetail' ? '#/user/' + currentUserId : '#/' + name;
  if (location.hash !== want) { try { history.replaceState(null, '', want); } catch (e) { /* file:// etc. */ } }
  loadView(name, force);
}
function loadAll(){ loadView(currentView, true); }
function loadView(name, force){
  if (name === 'dashboard') loadDashboard();
  else if (name === 'users') loadUsers();
  else if (name === 'userdetail') openUser(currentUserId, true);
  else if (name === 'posts') loadPosts();
  else if (name === 'plans') loadPlans();
  else if (name === 'connections') loadConnections();
  else if (name === 'failures') loadFailures();
  else if (name === 'broadcast') loadBroadcast();
  else if (name === 'audit') loadAudit();
  else if (name === 'settings') loadSettings();
}
el('sideNav').addEventListener('click', function(ev){
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-nav]') : null;
  if (b) showView(b.getAttribute('data-nav'));
});
function pagerHtml(list, page, pages, total, label){
  return '<button class="btn small" data-act="page" data-list="' + list + '" data-dir="-1"' + (page <= 1 ? ' disabled' : '') + '>← Prev</button>'
    + '<span class="muted">Page ' + page + ' of ' + pages + ' · ' + total + ' ' + esc(label) + '</span>'
    + '<button class="btn small" data-act="page" data-list="' + list + '" data-dir="1"' + (page >= pages ? ' disabled' : '') + '>Next →</button>';
}
function stat(label, value){ return '<div class="stat"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>'; }
function loadingInto(id){ var n = el(id); if (n) n.innerHTML = '<p class="muted" aria-busy="true">Loading…</p>'; }

// ---------- dashboard ----------
function loadDashboard(){
  ['statsUsers','statsPosts','statsRel','signups','active','attention'].forEach(loadingInto);
  api('/overview').then(function(o){
    // Needs attention FIRST (owner expansion #2): current failures,
    // partly-published posts and broken connections, with the newest
    // failures listed and a jump into the Failures view.
    var att = '';
    var needN = (o.posts.failed || 0) + (o.posts.partial || 0);
    if (needN > 0 || (o.accounts.instagramBroken || 0) > 0) {
      att = '<div class="banner"><b>Needs attention:</b> ' + esc(o.posts.failed) + ' failed · ' + esc(o.posts.partial) + ' partly published · ' + esc(o.accounts.instagramBroken || 0) + ' broken Instagram connection(s).'
        + ((o.failedPosts && o.failedPosts.length) ? o.failedPosts.slice(0, 5).map(function(f){
            return '<div style="margin-top:7px"><span class="uemail">' + esc(f.userEmail) + '</span> — ' + esc(f.friendly || f.reason || 'Failed') + (f.failedAt ? ' <span class="muted">(' + esc(when(f.failedAt)) + ')</span>' : '') + '</div>';
          }).join('') : '')
        + '<div style="margin-top:9px"><button class="btn small" data-act="goto" data-view="failures">Open Failures</button></div></div>';
    }
    el('attention').innerHTML = att;
    var su = '';
    su += stat('Total users', o.users.total); su += stat('New today', o.users.today); su += stat('New in 7 days', o.users.week); su += stat('New this month', o.users.month);
    el('statsUsers').innerHTML = su;
    var sp = '';
    sp += stat('Posts total', o.posts.total); sp += stat('Posts today', o.posts.today); sp += stat('Published today', o.posts.publishedToday); sp += stat('Published in 7 days', o.posts.publishedWeek); sp += stat('Scheduled now', o.posts.scheduled);
    el('statsPosts').innerHTML = sp;
    var sr = '';
    sr += stat('Failed today', o.posts.failedToday); sr += stat('Failed in 7 days', o.posts.failedWeek);
    sr += stat('Published (all time)', o.posts.published); sr += stat('Failed (all time)', o.posts.failed); sr += stat('Partly published', o.posts.partial);
    sr += stat('Publish success', o.posts.successPct == null ? '—' : o.posts.successPct + '%');
    el('statsRel').innerHTML = sr;
    var bp = o.users.byPlan || {};
    el('planDist').innerHTML = ['free','pro','max','ultra'].map(function(k){ return '<span class="chip">' + esc(k.toUpperCase()) + ' · ' + esc(bp[k] || 0) + ' users</span>'; }).join('');
    el('acctHealth').textContent = 'Connected accounts — Instagram: ' + o.accounts.instagram + ' (' + o.accounts.instagramBroken + ' broken, need reconnect) · YouTube channels: ' + o.accounts.youtube;
    el('signups').innerHTML = (o.recentSignups && o.recentSignups.length) ? o.recentSignups.map(function(u){
      return '<div class="row"><div class="uhead"><span class="uemail">' + esc(u.email) + (u.name ? ' <span class="muted">(' + esc(u.name) + ')</span>' : '') + '</span><span class="badge">' + esc(u.plan) + ' plan</span></div><div class="muted">Joined ' + esc(when(u.createdAt)) + '</div></div>';
    }).join('') : '<p class="muted">No signups yet.</p>';
    var max = 0; (o.mostActive || []).forEach(function(x){ if (x.count > max) max = x.count; });
    el('active').innerHTML = (o.mostActive && o.mostActive.length) ? o.mostActive.map(function(x){
      return '<div class="row"><div style="display:flex;justify-content:space-between;gap:10px"><span>' + esc(x.email) + '</span><b>' + esc(x.count) + ' posts</b></div><div class="bar"><i style="width:' + (max ? Math.round(x.count / max * 100) : 0) + '%"></i></div></div>';
    }).join('') : '<p class="muted">No posts yet this month.</p>';
  }).catch(function(){ el('statsUsers').innerHTML = '<p class="err">Could not load the dashboard — tap Refresh.</p>'; el('attention').innerHTML = ''; });
}

// ---------- header jump-to-user (owner expansion #9) ----------
// Rides the existing Users search endpoint: an exact email (or the
// first match) opens straight in User Detail.
el('hdrSearch').addEventListener('keydown', function(ev){
  if (ev.key !== 'Enter') return;
  var q = el('hdrSearch').value.trim();
  if (!q) return;
  api('/users?page=1&pageSize=5&q=' + encodeURIComponent(q)).then(function(d){
    var rows = d.users || [];
    var hit = rows.find(function(u){ return String(u.email || '').toLowerCase() === q.toLowerCase(); }) || rows[0];
    if (hit) { currentUserId = hit.id; el('hdrSearch').value = ''; showView('userdetail'); }
    else { el('hdrSearch').value = ''; el('hdrSearch').placeholder = 'No user with that email — try the Users search'; }
  }).catch(function(){});
});
el('hdrSearch').addEventListener('focus', function(){ el('hdrSearch').placeholder = 'Jump to user by email…'; });

// ---------- users ----------
el('search').addEventListener('input', function(){ pageState.users = 1; loadUsers(); });
// Plan filter chips (owner expansion #4): the Users endpoint returns
// each row's effective plan, so filtering rides the same endpoint —
// with a filter on, one wide page (100) is loaded and filtered here;
// the pager is replaced by a count note while a filter is active.
var planFilter = 'all';
el('planFilter').addEventListener('click', function(ev){
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-pf]') : null;
  if (!b) return;
  planFilter = b.getAttribute('data-pf') || 'all';
  el('planFilter').querySelectorAll('[data-pf]').forEach(function(x){ x.classList.toggle('active', x.getAttribute('data-pf') === planFilter); });
  pageState.users = 1;
  loadUsers();
});
function effectivePlanKey(u){ return u.plan && u.plan.comp ? 'ultra' : (u.plan ? u.plan.plan : 'free'); }
function loadUsers(){
  loadingInto('users');
  var q = el('search').value.trim();
  if (planFilter !== 'all') {
    api('/users?page=1&pageSize=100' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function(d){
      var rows = (d.users || []).filter(function(u){ return effectivePlanKey(u) === planFilter; });
      renderUsers(rows);
      el('usersPager').innerHTML = '<span class="muted">' + rows.length + ' user(s) on the ' + esc(planFilter.toUpperCase()) + ' plan'
        + ((d.total || 0) > (d.users || []).length ? ' (filter over the first 100 users)' : ' (filter over the full list)') + '</span>';
    }).catch(function(){});
    return;
  }
  api('/users?page=' + pageState.users + '&pageSize=50' + (q ? '&q=' + encodeURIComponent(q) : '')).then(function(d){
    pageState.users = d.page || 1;
    renderUsers(d.users || []);
    el('usersPager').innerHTML = pagerHtml('users', d.page || 1, d.pages || 1, d.total || 0, 'users');
  }).catch(function(){});
}
function planChips(u){
  if (u.role === 'owner') return '<span class="badge">OWNER — always Ultra</span>';
  var activeKey = u.plan.comp ? u.plan.basePlan : u.plan.plan;
  var chips = ['free','pro','max','ultra'].map(function(k){
    return '<button class="btn small' + (activeKey === k ? ' active' : '') + '" data-act="plan" data-id="' + u.id + '" data-plan="' + k + '">' + k.toUpperCase() + '</button>';
  }).join('');
  return (u.plan.comp ? '<span class="badge">COMP — Ultra free forever</span> ' : '') + chips;
}
function renderUsers(rows){
  if (!rows.length) { el('users').innerHTML = '<p class="muted">No users match.</p>'; return; }
  el('users').innerHTML = rows.map(function(u){
    var accts = (u.accounts || []).map(function(a){ return '@' + esc(a.username || '?') + (a.broken ? ' <span class="badge bad">BROKEN</span>' : ''); }).join(', ');
    return '<div class="row"><div class="uhead"><span class="uemail" data-act="open-user" data-id="' + u.id + '" style="cursor:pointer" title="Open user detail">' + esc(u.email) + (u.name ? ' <span class="muted">(' + esc(u.name) + ')</span>' : '') + '</span>'
      + '<span><span class="badge">' + esc(u.plan.planName) + ' plan</span> <button class="btn small" data-act="open-user" data-id="' + u.id + '">Open</button></span></div>'
      + '<div class="muted">Joined ' + esc(when(u.createdAt)) + ' · Posts: ' + esc(u.postsTotal) + ' total, ' + esc(u.postsThisMonth) + ' this month · Instagram: ' + (accts || 'none') + ' · YouTube: ' + (u.youtubeConnected ? 'connected' : 'no') + '</div>'
      + '<div class="controls"><span class="klabel">Plan (one tap)</span>' + planChips(u) + '</div></div>';
  }).join('');
}
function patchUser(id, body, after){
  api('/users/' + id, { method: 'PATCH', body: JSON.stringify(body) }).then(function(){
    // Owner expansion #5: every completed action says so, with the
    // audit-log note, right inside the Actions card.
    var m = el('udMsg'); if (m) m.textContent = 'Saved ✓ — this action is recorded in the Audit Log.';
    if (after) after();
    if (currentView === 'users') loadUsers();
    if (currentView === 'userdetail' && currentUserId === id) openUser(id, true);
  }).catch(function(){ var m = el('udMsg'); if (m) m.textContent = 'That change did not save — try again.'; });
}

// ---------- user detail ----------
function openUser(id, stay){
  if (!id) return;
  currentUserId = id;
  if (!stay) { showView('userdetail'); return; }
  el('navUserDetail').hidden = false;
  loadingInto('udetail'); loadingInto('udetailPosts'); loadingInto('udetailAudit');
  api('/users/' + id).then(function(d){
    var u = d.user;
    var accts = (u.accounts || []).map(function(a){ return '@' + esc(a.username || '?') + (a.broken ? ' <span class="badge bad">BROKEN</span>' : ''); }).join(', ');
    var h = '<div class="uhead"><span class="uemail">' + esc(u.email) + (u.name ? ' <span class="muted">(' + esc(u.name) + ')</span>' : '') + '</span>'
      + '<span class="badge">' + esc(u.plan.planName) + ' plan</span></div>'
      + '<div class="muted">Joined ' + esc(when(u.createdAt)) + ' · Role: ' + esc(u.role) + ' · Posts: ' + esc(u.postsTotal) + ' total, ' + esc(u.postsThisMonth) + ' this month</div>'
      + '<div class="muted">Instagram: ' + (accts || 'none') + ' · YouTube: ' + (u.youtubeConnected ? 'connected' : 'not connected') + '</div>';
    el('udetail').innerHTML = h;
    // Owner expansion #5: all owner actions live in ONE labelled
    // Actions card; every save confirms there with its audit note.
    var ah = '<div class="controls"><span class="klabel">Plan (one tap)</span>' + planChips(u) + '</div>';
    if (u.role !== 'owner') {
      ah += '<div class="controls"><span class="klabel">Paid-plan expiry (blank = no expiry)</span>'
        + '<input type="date" id="exp-' + u.id + '" value="' + esc((u.plan.planExpiresAt || '').slice(0, 10)) + '">'
        + '<button class="btn small" data-act="expiry" data-id="' + u.id + '">Save expiry</button>'
        + '<button class="btn small" data-act="expiry-clear" data-id="' + u.id + '">Clear</button></div>'
        + '<div class="controls"><span class="klabel">Comp (free Ultra forever, for friends)</span>'
        + (u.plan.comp
          ? '<button class="btn small" data-act="comp-off" data-id="' + u.id + '">Remove comp</button>'
          : '<button class="btn small" data-act="comp-on" data-id="' + u.id + '">Grant comp</button>') + '</div>'
        + '<div class="controls"><span class="klabel">Monthly post limit override (blank = plan default)</span>'
        + '<input type="number" min="1" max="100000" id="ovr-' + u.id + '" value="' + (u.postLimitOverride ? esc(u.postLimitOverride) : '') + '" placeholder="e.g. 500">'
        + '<button class="btn small" data-act="override" data-id="' + u.id + '">Save override</button>'
        + '<button class="btn small" data-act="override-clear" data-id="' + u.id + '">Clear</button></div>';
    }
    el('udActions').innerHTML = ah;
    el('udetailPosts').innerHTML = (d.posts && d.posts.length) ? d.posts.map(postRowHtml).join('') : '<p class="muted">No posts yet.</p>';
    el('udetailAudit').innerHTML = (d.audit && d.audit.length) ? d.audit.map(auditRowHtml).join('') : '<p class="muted">No admin actions on this user yet.</p>';
  }).catch(function(){});
}

// ---------- posts / failures ----------
function postRowHtml(r){
  var h = '<div class="row"><div class="uhead"><span class="uemail">' + esc(r.userEmail) + '</span><span class="badge">' + esc(r.status) + '</span></div>'
    + '<div>' + esc(r.caption || '(no caption)') + '</div>'
    + '<div class="muted">' + esc((r.platforms || []).join(' + ')) + (r.accounts && r.accounts.length ? ' · @' + esc(r.accounts.join(', @')) : '')
    + ' · Created ' + esc(when(r.createdAt)) + (r.scheduleTime ? ' · Scheduled ' + esc(when(r.scheduleTime)) : '')
    + (r.publishedAt ? ' · Published ' + esc(when(r.publishedAt)) : '') + (r.failedAt ? ' · Failed ' + esc(when(r.failedAt)) : '') + '</div>';
  if (r.status === 'failed' || r.status === 'partial') {
    h += '<div style="color:#ff9a9a">' + esc(r.friendly || r.reason || 'Failed') + '</div>'
      + (r.reason && r.reason !== r.friendly ? '<div class="muted">' + esc(r.reason) + '</div>' : '')
      + '<div class="controls"><button class="btn small" data-act="retry" data-user="' + esc(r.userId) + '" data-id="' + esc(r.postId) + '">Retry this post</button> <button class="btn small" data-act="open-user" data-id="' + esc(r.userId) + '">Open user</button> <span class="muted" id="retry-' + esc(r.postId) + '"></span></div>';
  }
  return h + '</div>';
}
el('postStatus').addEventListener('change', function(){ pageState.posts = 1; loadPosts(); });
el('postQ').addEventListener('input', function(){ pageState.posts = 1; loadPosts(); });
function loadPosts(){
  loadingInto('posts');
  var st = el('postStatus').value, q = el('postQ').value.trim();
  api('/posts?page=' + pageState.posts + '&pageSize=50' + (st ? '&status=' + encodeURIComponent(st) : '') + (q ? '&q=' + encodeURIComponent(q) : '')).then(function(d){
    pageState.posts = d.page || 1;
    el('posts').innerHTML = (d.posts && d.posts.length) ? d.posts.map(postRowHtml).join('') : '<p class="muted">No posts match.</p>';
    el('postsPager').innerHTML = pagerHtml('posts', d.page || 1, d.pages || 1, d.total || 0, 'posts');
  }).catch(function(){});
}
function loadFailures(){
  loadingInto('failures');
  api('/failures?page=' + pageState.failures + '&pageSize=50').then(function(d){
    pageState.failures = d.page || 1;
    el('failures').innerHTML = (d.posts && d.posts.length) ? d.posts.map(postRowHtml).join('') : '<p class="muted">No failed posts. </p>';
    el('failuresPager').innerHTML = pagerHtml('failures', d.page || 1, d.pages || 1, d.total || 0, 'failed posts');
  }).catch(function(){});
}
function retryPost(userId, postId, btn){
  var slot = el('retry-' + postId);
  if (btn) btn.disabled = true;
  if (slot) slot.textContent = 'Retrying…';
  api('/posts/' + userId + '/' + postId + '/retry', { method: 'POST', body: '{}' }).then(function(d){
    if (slot) slot.textContent = d.ok ? 'Published ✓' : ('Still failed: ' + (d.error || 'unknown'));
    setTimeout(function(){
      if (currentView === 'failures') loadFailures();
      else if (currentView === 'posts') loadPosts();
      else if (currentView === 'userdetail') openUser(currentUserId, true);
    }, 900);
  }).catch(function(){ if (slot) slot.textContent = 'Retry failed to run.'; if (btn) btn.disabled = false; });
}

// ---------- plans ----------
function planCardsHtml(plans, perPlan){
  return (plans || []).map(function(p){
    var lim = p.limits || {};
    var f = function(v){ return v == null ? 'Unlimited' : v; };
    return '<div class="row"><div class="uhead"><span class="uemail">' + esc(p.name) + ' — ₹' + esc(p.priceInr) + '/month</span><span class="badge">' + esc(perPlan && perPlan[p.id] != null ? perPlan[p.id] : 0) + ' users</span></div>'
      + '<div class="muted">Accounts: ' + f(lim.accounts) + ' · Posts/day: ' + f(lim.postsPerDay) + ' · Posts/month: ' + f(lim.postsPerMonth) + (lim.aiPerDay !== undefined ? ' · AI captions/day: ' + f(lim.aiPerDay) : '') + (p.fullBridge ? ' · Whole queue server-ready' : ' · Next post server-ready') + '</div></div>';
  }).join('');
}
function loadPlans(){
  loadingInto('plans');
  api('/plans').then(function(d){
    el('plansNote').innerHTML = d.paymentsLive ? '' : '<div class="banner">' + esc(d.paymentsNote || '') + '</div>';
    el('plans').innerHTML = planCardsHtml(d.plans, d.usersPerPlan);
  }).catch(function(){});
}

// ---------- connections ----------
function loadConnections(){
  loadingInto('disconnected'); loadingInto('connections');
  api('/connections').then(function(d){
    el('disconnected').innerHTML = (d.disconnected && d.disconnected.length) ? d.disconnected.map(function(x){
      return '<div class="row"><span class="uemail">' + esc(x.userEmail) + '</span> — Instagram @' + esc(x.username || '?') + ' <span class="badge bad">DISCONNECTED</span><div class="muted">Their posts to this account cannot publish until they reconnect.</div></div>';
    }).join('') : '<p class="muted">No disconnected accounts — every connection is healthy.</p>';
    el('connections').innerHTML = (d.rows || []).map(function(r){
      var ig = (r.instagram || []).map(function(a){ return '@' + esc(a.username || '?') + (a.broken ? ' <span class="badge bad">BROKEN</span>' : ''); }).join(', ');
      return '<div class="row"><div class="uhead"><span class="uemail">' + esc(r.email) + '</span>' + (r.brokenCount ? '<span class="badge bad">' + esc(r.brokenCount) + ' broken</span>' : '<span class="badge">healthy</span>') + '</div>'
        + '<div class="muted">Instagram: ' + (ig || 'none') + ' · YouTube: ' + (r.youtube ? 'connected' : 'no') + '</div></div>';
    }).join('') || '<p class="muted">No users yet.</p>';
  }).catch(function(){});
}

// ---------- broadcast ----------
function renderBcPreview(){
  var title = el('bcTitle').value.trim(), body = el('bcBody').value.trim();
  el('bcPreview').innerHTML = '<div class="muted" style="margin-bottom:5px">Preview — this is how it lands in each user\u2019s notifications:</div>'
    + '<b>' + esc(title || '(no title yet)') + '</b><div class="muted">' + esc(body || '(no message yet)') + '</div>';
}
el('bcTitle').addEventListener('input', renderBcPreview);
el('bcBody').addEventListener('input', renderBcPreview);
function loadBroadcast(){
  renderBcPreview();
  api('/overview').then(function(o){ el('bcCount').textContent = '— it will go to ' + o.users.total + ' users.'; }).catch(function(){});
}
el('bcConfirm').addEventListener('change', function(){ el('bcSend').disabled = !el('bcConfirm').checked; });
el('bcSend').addEventListener('click', function(){
  var title = el('bcTitle').value.trim(), body = el('bcBody').value.trim();
  el('bcMsg').textContent = ''; el('bcErr').textContent = '';
  if (!title || !body) { el('bcErr').textContent = 'Write both a title and a message first.'; return; }
  el('bcSend').disabled = true;
  api('/broadcast', { method: 'POST', body: JSON.stringify({ title: title, body: body, confirm: true }) }).then(function(d){
    el('bcMsg').textContent = 'Sent to ' + d.sent + ' users.';
    el('bcTitle').value = ''; el('bcBody').value = ''; el('bcConfirm').checked = false;
  }).catch(function(){ el('bcErr').textContent = 'The broadcast did not go out — try again.'; el('bcSend').disabled = false; });
});

// ---------- audit ----------
function auditRowHtml(e){
  return '<div class="row"><div class="uhead"><span><b>' + esc(e.action) + '</b> · ' + esc(e.targetEmail || '') + '</span><span class="muted">' + esc(when(e.at)) + '</span></div><div class="muted">' + esc(e.summary || '') + '</div></div>';
}
// Audit filters (owner expansion #7): client-side over the entries
// the endpoint already returned for this page — by action type and
// by target user. (Entries record the acting admin's id only; the
// owner is the sole actor today, so the target is the useful axis.)
var auditCache = [];
function fillAuditFilter(sel, values, allLabel){
  var cur = sel.value;
  sel.innerHTML = '<option value="">' + esc(allLabel) + '</option>' + values.map(function(v){ return '<option value="' + esc(v) + '">' + esc(v) + '</option>'; }).join('');
  sel.value = values.indexOf(cur) >= 0 ? cur : '';
}
function renderAudit(){
  var a = el('auditAction').value, tg = el('auditTarget').value;
  var rows = auditCache.filter(function(e){ return (!a || e.action === a) && (!tg || (e.targetEmail || '') === tg); });
  el('audit').innerHTML = rows.length ? rows.map(auditRowHtml).join('') : '<p class="muted">No entries match those filters on this page.</p>';
}
el('auditAction').addEventListener('change', renderAudit);
el('auditTarget').addEventListener('change', renderAudit);
function loadAudit(){
  loadingInto('audit');
  api('/audit?page=' + pageState.audit + '&pageSize=50').then(function(d){
    pageState.audit = d.page || 1;
    auditCache = d.entries || [];
    var actions = [], targets = [];
    auditCache.forEach(function(e){
      if (e.action && actions.indexOf(e.action) < 0) actions.push(e.action);
      if (e.targetEmail && targets.indexOf(e.targetEmail) < 0) targets.push(e.targetEmail);
    });
    fillAuditFilter(el('auditAction'), actions.sort(), 'All actions');
    fillAuditFilter(el('auditTarget'), targets.sort(), 'All users');
    if (auditCache.length) renderAudit();
    else el('audit').innerHTML = '<p class="muted">No admin actions yet.</p>';
    el('auditPager').innerHTML = pagerHtml('audit', d.page || 1, d.pages || 1, d.total || 0, 'entries');
  }).catch(function(){});
}

// ---------- settings ----------
function loadSettings(){
  api('/settings').then(function(d){
    el('setSignup').checked = d.settings.signupOpen !== false;
    el('setMaint').checked = !!d.settings.maintenance;
    el('setMaintMsg').value = d.settings.maintenanceMessage || '';
    el('plansNote2').textContent = d.plansNote || '';
    el('plansReadonly').innerHTML = planCardsHtml(d.plans, null);
    el('setMsg').textContent = '';
  }).catch(function(){});
}
el('setSave').addEventListener('click', function(){
  api('/settings', { method: 'PATCH', body: JSON.stringify({
    signupOpen: el('setSignup').checked,
    maintenance: el('setMaint').checked,
    maintenanceMessage: el('setMaintMsg').value.trim(),
  }) }).then(function(){ el('setMsg').textContent = 'Saved.'; }).catch(function(){ el('setMsg').textContent = 'Could not save — try again.'; });
});

// ---------- delegated actions ----------
function setPlan(id, plan){ patchUser(id, { plan: plan }); }
function setComp(id, comp){ patchUser(id, { comp: comp }); }
function saveExpiry(id){ var n = el('exp-' + id); if (n) patchUser(id, { planExpiresAt: n.value ? new Date(n.value + 'T23:59:59').toISOString() : '' }); }
function clearExpiry(id){ patchUser(id, { planExpiresAt: '' }); }
function saveOverride(id){ var n = el('ovr-' + id); if (n) patchUser(id, { postLimitOverride: n.value === '' ? '' : Number(n.value) }); }
function clearOverride(id){ patchUser(id, { postLimitOverride: '' }); }
document.addEventListener('click', function(ev){
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
  if (!b) return;
  var id = b.getAttribute('data-id');
  var act = b.getAttribute('data-act');
  if (act === 'plan') setPlan(id, b.getAttribute('data-plan'));
  else if (act === 'expiry') saveExpiry(id);
  else if (act === 'expiry-clear') clearExpiry(id);
  else if (act === 'comp-on') setComp(id, true);
  else if (act === 'comp-off') setComp(id, false);
  else if (act === 'override') saveOverride(id);
  else if (act === 'override-clear') clearOverride(id);
  else if (act === 'open-user') { currentUserId = id; var um = el('udMsg'); if (um) um.textContent = ''; showView('userdetail'); }
  else if (act === 'goto') showView(b.getAttribute('data-view'));
  else if (act === 'back-users') showView('users');
  else if (act === 'retry') retryPost(b.getAttribute('data-user'), id, b);
  else if (act === 'page') {
    var list = b.getAttribute('data-list'), dir = Number(b.getAttribute('data-dir') || 0);
    pageState[list] = Math.max(1, (pageState[list] || 1) + dir);
    if (list === 'users') loadUsers();
    else if (list === 'posts') loadPosts();
    else if (list === 'failures') loadFailures();
    else if (list === 'audit') loadAudit();
  }
});
boot();
`;
// The console lives under /api/ on purpose: on the production host
// only /api/* (plus media/bio/preview) reaches this app — every other
// path is served the SPA — and the site-wide CSP allows only
// same-origin scripts, so the page's JS is served as its own
// owner-gated file rather than inline. Both routes answer with the
// plain API 404 for anyone who is not the owner.
app.get(`/api/${ADMIN_SLUG}/console`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me) return adminApi404(res);
  return res.type('html').send(ADMIN_PAGE_HTML);
}));
app.get(`/api/${ADMIN_SLUG}/app.js`, ah(async (req, res) => {
  const me = await adminOwner(req);
  if (!me) return adminApi404(res);
  return res.type('application/javascript').send(ADMIN_PAGE_JS);
}));

// Unknown /api routes — and method mismatches on known ones — answer
// in the API's JSON error shape, not Express's default HTML 404 page.
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, error: 'That API route does not exist.' });
});

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const index = path.join(DIST, 'index.html');
  if (fs.existsSync(index)) return res.sendFile(index);
  return res.json({ ok: true, service: 'social-scheduler', note: 'Frontend not built yet — run npm run build in frontend/.' });
});

// Plain-words errors: a too-big upload says so, bad JSON says so, and
// nothing ever leaks a credential or connection string.
app.use((err, req, res, next) => {
  console.error(err && err.message ? err.message : err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: 'That upload is too big for the live site (about 4 MB max per request). Add the file by public link instead (Media Library → Add by link), or use a smaller file.' });
  }
  if (err instanceof SyntaxError) {
    return res.status(400).json({ ok: false, error: 'That request was not valid — please try again.' });
  }
  res.status(500).json({ ok: false, error: 'Something went wrong on the server — please try again in a minute.' });
});

if (require.main === module) {
  const server = app.listen(PORT, () => console.log(`Social Scheduler listening on ${PORT}`));
  const shutdown = () => {
    console.log('Shutting down…');
    server.close(() => {
      try { const mongoose = require('mongoose'); mongoose.disconnect().finally(() => process.exit(0)); } catch { process.exit(0); }
    });
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
module.exports = app;
