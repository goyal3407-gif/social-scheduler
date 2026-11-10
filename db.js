// Social Scheduler — database layer
// MongoDB Atlas (free M0) via mongoose when MONGODB_URI is set, otherwise
// local JSON files in data/ (local dev only).
//
// The scheduler uses its OWN database ("social_scheduler") inside the same
// Atlas cluster as PureNest — set with the `dbName` connect option, so the
// database name inside MONGODB_URI never matters and the two apps can never
// mix collections. Never put the connection string in the repo: it lives
// ONLY in Vercel env vars as MONGODB_URI.
//
// Pattern follows PureNest (~/workspace/purenest-clean-co/db.js): one cached
// connect promise, one retry, 30s between failed attempts, IPv4 forced
// (Atlas free tier has no IPv6), errors sanitised so a URI/credential can
// never leak into a log or API response.
//
// Collections: users, sessions, posts, media, templates, settings,
// instagram (one doc per user), importjobs. Data is scoped per user
// (userId); docs saved before per-user scoping (no userId) belong to the
// first/owner account. The Instagram token is encrypted at rest
// (AES-256-GCM, key from TOKEN_ENCRYPTION_KEY or SESSION_SECRET env vars);
// without either env var it is stored unencrypted and db-status says so.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const DATA = path.join(__dirname, 'data');
try { fs.mkdirSync(DATA, { recursive: true }); } catch { /* read-only fs on Vercel */ }

const DB_NAME = 'social_scheduler';

// ---------- JSON fallback (local dev only — Vercel's filesystem is ephemeral) ----------
function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, name), 'utf8')); } catch { return fallback; }
}
function save(name, data) {
  try { fs.writeFileSync(path.join(DATA, name), JSON.stringify(data, null, 2)); } catch { /* read-only fs */ }
}
const JSON_FILES = {
  users: 'users.json', sessions: 'sessions.json', posts: 'posts.json',
  media: 'media.json', templates: 'templates.json', settings: 'settings.json',
  instagram: 'instagram.json', importJobs: 'import-jobs.json',
};

// ---------- Mongoose models ----------
const userSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  email: { type: String, unique: true, index: true },
  salt: String, passwordHash: String,
  role: { type: String, default: 'member' }, createdAt: String,
}, { strict: false });
const sessionSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true }, expiresAt: Date,
  revoked: { type: Boolean, default: false }, createdAt: String,
});
const postSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  mediaUrl: String, mediaType: String, caption: String, hashtags: String,
  cta: String, platform: String, scheduleTime: String,
  status: { type: String, default: 'scheduled' }, format: String,
  liveUrl: String, instagramId: String, containerId: String, createdAt: String,
}, { strict: false });
const mediaSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  url: String, title: String, kind: String, size: Number, duration: Number,
  folder: String, tags: [String], favorite: Boolean, usedCount: Number,
  instagramId: String, permalink: String, createdAt: String,
}, { strict: false });
const templateSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true }, name: String, text: String,
});
const settingsSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
});
const instagramSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  tokenEnc: String, encrypted: { type: Boolean, default: false },
  igUserId: String, username: String,
  profile: { type: mongoose.Schema.Types.Mixed, default: null },
  connectedAt: String, importedAt: String,
});
const importJobSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  status: String, done: Boolean, fetched: Number,
  importedMedia: Number, importedPosts: Number,
  profile: { type: mongoose.Schema.Types.Mixed, default: null },
  error: String, message: String, startedAt: String, updatedAt: String,
}, { strict: false });

const User = mongoose.models.SsUser || mongoose.model('SsUser', userSchema, 'users');
const Session = mongoose.models.SsSession || mongoose.model('SsSession', sessionSchema, 'sessions');
const Post = mongoose.models.SsPost || mongoose.model('SsPost', postSchema, 'posts');
const Media = mongoose.models.SsMedia || mongoose.model('SsMedia', mediaSchema, 'media');
const Template = mongoose.models.SsTemplate || mongoose.model('SsTemplate', templateSchema, 'templates');
const SettingsDoc = mongoose.models.SsSettings || mongoose.model('SsSettings', settingsSchema, 'settings');
const InstagramDoc = mongoose.models.SsInstagram || mongoose.model('SsInstagram', instagramSchema, 'instagram');
const ImportJob = mongoose.models.SsImportJob || mongoose.model('SsImportJob', importJobSchema, 'importjobs');

// ---------- connect (cached promise + one retry, PureNest pattern) ----------
let mongoReady = false;
let lastError = null; // error MESSAGE only — never the URI or password
let connectPromise = null;
let lastAttemptAt = 0;
const CONNECT_OPTS = {
  dbName: DB_NAME,
  serverSelectionTimeoutMS: 15000,
  connectTimeoutMS: 15000,
  socketTimeoutMS: 30000,
  family: 4, // Atlas free tier has no IPv6; force IPv4
};
function sanitizeError(e) {
  let m = String((e && e.message) || e || 'Unknown MongoDB error');
  m = m.replace(/mongodb(\+srv)?:\/\/[^\s'"]+/gi, 'mongodb://[redacted]');
  return m.slice(0, 500);
}
async function tryConnectOnce() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return false;
  if (mongoose.connection.readyState === 2 || mongoose.connection.readyState === 3) {
    try { await mongoose.disconnect(); } catch { /* ignore */ }
  }
  await mongoose.connect(uri, CONNECT_OPTS);
  mongoReady = true;
  lastError = null;
  console.log('MongoDB: connected to Atlas, database "' + DB_NAME + '"');
  return true;
}
async function connect() {
  if (isMongo()) return true;
  if (connectPromise) return connectPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    if (!connect._noUriLogged) { connect._noUriLogged = true; console.log('MongoDB: MONGODB_URI not set — using local JSON storage in data/ (dev only; data does NOT survive redeploys on Vercel)'); }
    return false;
  }
  if (Date.now() - lastAttemptAt < 60000 && lastError) return false;
  lastAttemptAt = Date.now();
  connectPromise = (async () => {
    try {
      return await tryConnectOnce();
    } catch (e) {
      lastError = sanitizeError(e);
      mongoReady = false;
      console.log('MongoDB: connection attempt 1 failed, retrying once:', lastError);
      try {
        await new Promise((r) => setTimeout(r, 1000));
        return await tryConnectOnce();
      } catch (e2) {
        lastError = sanitizeError(e2);
        mongoReady = false;
        console.log('MongoDB: connection failed, falling back to local JSON storage:', lastError);
        return false;
      }
    } finally {
      connectPromise = null;
      // Stamp the guard AFTER the attempt finishes: one attempt takes
      // ~30s (15s timeout + retry), so stamping it before would let the
      // very next call in the same request start a second full cycle.
      lastAttemptAt = Date.now();
    }
  })();
  return connectPromise;
}
async function ensureMongo() {
  if (isMongo()) return true;
  try { return await connect(); } catch { return false; }
}
function isMongo() { return mongoReady && mongoose.connection.readyState === 1; }
function getStatus() {
  return {
    db: isMongo() ? 'mongodb' : 'json',
    database: isMongo() ? DB_NAME : null,
    mongoReady: isMongo(),
    readyState: mongoose.connection.readyState,
    uriConfigured: !!process.env.MONGODB_URI,
    sessionSecretFromEnv: !!process.env.SESSION_SECRET,
    tokenEncryptionAvailable: isTokenEncryptionAvailable(),
    lastError,
  };
}

// ---------- token encryption at rest (AES-256-GCM) ----------
// Key comes ONLY from env vars (TOKEN_ENCRYPTION_KEY preferred, else
// SESSION_SECRET). Without either, tokens are stored unencrypted and
// getStatus()/db-status reports tokenEncryptionAvailable:false — set
// SESSION_SECRET in Vercel (required anyway for logins) to get encryption.
function encryptionKey() {
  const secret = process.env.TOKEN_ENCRYPTION_KEY || process.env.SESSION_SECRET;
  if (!secret) return null;
  return crypto.scryptSync(String(secret), 'ss-token-enc', 32);
}
function isTokenEncryptionAvailable() { return !!encryptionKey(); }
function encryptToken(token) {
  const key = encryptionKey();
  if (!key) return { tokenEnc: String(token || ''), encrypted: false };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(String(token), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { tokenEnc: Buffer.concat([iv, tag, data]).toString('base64'), encrypted: true };
}
function decryptToken(stored) {
  if (!stored) return '';
  if (!stored.encrypted) return stored.tokenEnc || '';
  const key = encryptionKey();
  if (!key) return ''; // key lost (e.g. SESSION_SECRET changed) — token can't be read; user must reconnect
  try {
    const buf = Buffer.from(stored.tokenEnc, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch { return ''; }
}

// ---------- helpers ----------
const toObj = (d) => (d && typeof d.toObject === 'function' ? d.toObject() : d);
const strip = (d) => { const o = toObj(d); if (o) { delete o._id; delete o.__v; } return o; };
const stripAll = (list) => (list || []).map(strip).filter(Boolean);

// Docs saved before per-user scoping have no userId — they belong to the
// owner (first account). Everyone else only sees their own docs.
async function ownerId() {
  const users = await listUsers();
  return users.length ? users[0].id : null;
}
function visibleTo(docs, userId, owner) {
  return (docs || []).filter((d) => !d || d.userId === userId || (!d.userId && userId === owner));
}
function jsonList(name) { return load(JSON_FILES[name], []); }
function jsonSave(name, list) { save(JSON_FILES[name], list); }
function jsonUpsert(name, doc, matchKey) {
  const list = jsonList(name);
  const i = list.findIndex((d) => d && d[matchKey] === doc[matchKey]);
  if (i >= 0) list[i] = { ...list[i], ...doc }; else list.push(doc);
  jsonSave(name, list);
  return doc;
}

// ---------- users ----------
async function listUsers() {
  await ensureMongo();
  if (isMongo()) return stripAll(await User.find({}).lean());
  return jsonList('users');
}
async function getUserByEmail(email) {
  await ensureMongo();
  if (isMongo()) { const u = await User.findOne({ email }).lean(); return u ? strip(u) : null; }
  return jsonList('users').find((u) => u.email === email) || null;
}
async function getUserById(id) {
  await ensureMongo();
  if (isMongo()) { const u = await User.findOne({ id }).lean(); return u ? strip(u) : null; }
  return jsonList('users').find((u) => u.id === id) || null;
}
async function saveUser(user) {
  await ensureMongo();
  if (isMongo()) { await User.create(user); return user; }
  const list = jsonList('users'); list.push(user); jsonSave('users', list); return user;
}
async function countUsers() { return (await listUsers()).length; }

// ---------- sessions (ledger: login writes one, logout marks it revoked) ----------
// A missing session doc does NOT invalidate a session — logins made while
// the database was down, or before this version, still work from the signed
// cookie alone. Only an explicitly revoked (logged-out) or expired session
// is rejected.
async function createSession(doc) {
  await ensureMongo();
  if (isMongo()) { try { await Session.create(doc); } catch { /* duplicate id: ignore */ } return doc; }
  jsonUpsert('sessions', doc, 'id');
  return doc;
}
async function revokeSession(id) {
  await ensureMongo();
  if (isMongo()) { await Session.updateOne({ id }, { $set: { revoked: true } }); return; }
  const list = jsonList('sessions');
  const s = list.find((x) => x.id === id);
  if (s) { s.revoked = true; jsonSave('sessions', list); }
  else jsonUpsert('sessions', { id, revoked: true, createdAt: new Date().toISOString() }, 'id');
}
async function isSessionRevoked(id) {
  await ensureMongo();
  if (isMongo()) { const s = await Session.findOne({ id }).lean(); return !!(s && s.revoked); }
  const s = jsonList('sessions').find((x) => x.id === id);
  return !!(s && s.revoked);
}

// ---------- posts ----------
async function listPosts(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await Post.find({}).lean()).filter((d) => visibleTo([d], userId, owner).length);
  return visibleTo(jsonList('posts'), userId, owner);
}
async function getPost(userId, id) {
  const all = await listPosts(userId);
  return all.find((p) => p.id === id) || null;
}
async function savePost(post) {
  await ensureMongo();
  if (isMongo()) { await Post.create(post); return post; }
  const list = jsonList('posts'); list.push(post); jsonSave('posts', list); return post;
}
async function savePostsBulk(posts) {
  await ensureMongo();
  if (isMongo()) { if (posts.length) await Post.insertMany(posts, { ordered: false }); return posts; }
  const list = jsonList('posts'); list.push(...posts); jsonSave('posts', list); return posts;
}
async function updatePost(userId, id, patch) {
  await ensureMongo();
  const existing = await getPost(userId, id);
  if (!existing) return null;
  if (isMongo()) { const p = await Post.findOneAndUpdate({ id }, patch, { new: true }).lean(); return p ? strip(p) : null; }
  const list = jsonList('posts');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('posts', list); return item;
}
async function deletePost(userId, id) {
  await ensureMongo();
  const existing = await getPost(userId, id);
  if (!existing) return false;
  if (isMongo()) { await Post.deleteOne({ id }); return true; }
  jsonSave('posts', jsonList('posts').filter((x) => x.id !== id)); return true;
}

// ---------- media ----------
async function listMedia(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await Media.find({}).lean()).filter((d) => visibleTo([d], userId, owner).length);
  return visibleTo(jsonList('media'), userId, owner);
}
async function saveMedia(item) {
  await ensureMongo();
  if (isMongo()) { await Media.create(item); return item; }
  const list = jsonList('media'); list.push(item); jsonSave('media', list); return item;
}
async function saveMediaBulk(items) {
  await ensureMongo();
  if (isMongo()) { if (items.length) await Media.insertMany(items, { ordered: false }); return items; }
  const list = jsonList('media'); list.push(...items); jsonSave('media', list); return items;
}
async function updateMedia(userId, id, patch) {
  await ensureMongo();
  const all = await listMedia(userId);
  if (!all.some((m) => m.id === id)) return null;
  if (isMongo()) { const m = await Media.findOneAndUpdate({ id }, patch, { new: true }).lean(); return m ? strip(m) : null; }
  const list = jsonList('media');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('media', list); return item;
}
async function deleteMedia(userId, id) {
  await ensureMongo();
  const all = await listMedia(userId);
  if (!all.some((m) => m.id === id)) return false;
  if (isMongo()) { await Media.deleteOne({ id }); return true; }
  jsonSave('media', jsonList('media').filter((x) => x.id !== id)); return true;
}

// ---------- templates ----------
async function listTemplates(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await Template.find({}).lean()).filter((d) => visibleTo([d], userId, owner).length);
  return visibleTo(jsonList('templates'), userId, owner);
}
async function saveTemplate(tpl) {
  await ensureMongo();
  if (isMongo()) { await Template.create(tpl); return tpl; }
  const list = jsonList('templates'); list.push(tpl); jsonSave('templates', list); return tpl;
}

// ---------- settings (one doc per user) ----------
async function getSettings(userId) {
  await ensureMongo();
  if (isMongo()) {
    const doc = await SettingsDoc.findOne({ userId }).lean();
    return (doc && doc.data) || {};
  }
  const all = load(JSON_FILES.settings, {});
  return (all && all[userId]) || (Array.isArray(all) ? {} : all) || {};
}
async function saveSettings(userId, settings) {
  await ensureMongo();
  if (isMongo()) {
    await SettingsDoc.updateOne({ userId }, { $set: { userId, data: settings } }, { upsert: true });
    return settings;
  }
  const all = load(JSON_FILES.settings, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  obj[userId] = settings;
  save(JSON_FILES.settings, obj);
  return settings;
}

// ---------- instagram connection (one doc per user; token encrypted) ----------
async function getInstagram(userId) {
  await ensureMongo();
  if (isMongo()) {
    const doc = await InstagramDoc.findOne({ userId }).lean();
    if (!doc) return {};
    return { token: decryptToken(doc), igUserId: doc.igUserId || '', username: doc.username || '', profile: doc.profile || null, connectedAt: doc.connectedAt || '', importedAt: doc.importedAt || '', encrypted: !!doc.encrypted };
  }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  const doc = obj[userId] || obj;
  if (!doc || typeof doc !== 'object') return {};
  if (doc.token && !doc.tokenEnc) return { token: doc.token, igUserId: doc.igUserId || '', username: doc.username || '', profile: doc.profile || null, connectedAt: doc.connectedAt || '', importedAt: doc.importedAt || '', encrypted: false };
  return { token: decryptToken(doc), igUserId: doc.igUserId || '', username: doc.username || '', profile: doc.profile || null, connectedAt: doc.connectedAt || '', importedAt: doc.importedAt || '', encrypted: !!doc.encrypted };
}
async function saveInstagram(userId, fields) {
  await ensureMongo();
  const { token, ...rest } = fields || {};
  const enc = token !== undefined ? encryptToken(token) : null;
  if (isMongo()) {
    const patch = { userId, ...rest };
    if (enc) { patch.tokenEnc = enc.tokenEnc; patch.encrypted = enc.encrypted; }
    await InstagramDoc.updateOne({ userId }, { $set: patch }, { upsert: true });
    return;
  }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  const prev = obj[userId] || {};
  const next = { ...prev, ...rest };
  if (enc) { next.tokenEnc = enc.tokenEnc; next.encrypted = enc.encrypted; delete next.token; }
  obj[userId] = next;
  save(JSON_FILES.instagram, obj);
}
async function clearInstagram(userId) {
  await ensureMongo();
  if (isMongo()) { await InstagramDoc.deleteOne({ userId }); return; }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  delete obj[userId];
  save(JSON_FILES.instagram, obj);
}

// ---------- import jobs (persisted so polling survives serverless cold starts) ----------
async function getImportJob(userId, id) {
  await ensureMongo();
  if (isMongo()) {
    const j = await ImportJob.findOne({ id }).lean();
    if (!j || (j.userId && j.userId !== userId)) return null;
    return strip(j);
  }
  return jsonList('importJobs').find((j) => j.id === id && (!j.userId || j.userId === userId)) || null;
}
async function saveImportJob(job) {
  await ensureMongo();
  if (isMongo()) {
    await ImportJob.updateOne({ id: job.id }, { $set: job }, { upsert: true });
    return job;
  }
  jsonUpsert('importJobs', job, 'id');
  return job;
}

module.exports = {
  connect, ensureMongo, isMongo, getStatus, getLastError: () => lastError,
  DB_NAME, load, save,
  encryptToken, decryptToken, isTokenEncryptionAvailable,
  listUsers, getUserByEmail, getUserById, saveUser, countUsers, ownerId,
  createSession, revokeSession, isSessionRevoked,
  listPosts, getPost, savePost, savePostsBulk, updatePost, deletePost,
  listMedia, saveMedia, saveMediaBulk, updateMedia, deleteMedia,
  listTemplates, saveTemplate,
  getSettings, saveSettings,
  getInstagram, saveInstagram, clearInstagram,
  getImportJob, saveImportJob,
};
