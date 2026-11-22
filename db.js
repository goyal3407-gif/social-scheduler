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
// Collections: users, sessions, posts, media, mediafiles (uploaded
// binaries), templates, settings, instagram (one doc per user),
// importjobs. Data is scoped per user
// (userId); docs saved before per-user scoping (no userId) belong to the
// first/owner account. The Instagram token is encrypted at rest
// (AES-256-GCM, key from TOKEN_ENCRYPTION_KEY or SESSION_SECRET env vars);
// without either env var it is stored unencrypted and db-status says so.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
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
  media: 'media.json', mediaFiles: 'media-files.json', templates: 'templates.json', settings: 'settings.json',
  hashtagGroups: 'hashtag-groups.json',
  passwordResets: 'password-resets.json',
  appCodes: 'app-codes.json',
  youtube: 'youtube.json',
  drafts: 'drafts.json',
  bios: 'bios.json',
  instagram: 'instagram.json', importJobs: 'import-jobs.json',
  notifications: 'notifications.json', uploadSessions: 'upload-sessions.json',
  adminAudit: 'admin-audit.json',
  teamInvites: 'team-invites.json',
  globalSettings: 'global-settings.json',
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
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // expired sessions self-clean
const postSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  mediaUrl: String, mediaType: String, caption: String, hashtags: String,
  cta: String, platform: String, scheduleTime: String,
  status: { type: String, default: 'scheduled' }, format: String,
  liveUrl: String, posterUrl: String, instagramId: String, containerId: String, createdAt: String,
}, { strict: false });
postSchema.index({ userId: 1, status: 1, scheduleTime: 1 });
postSchema.index({ userId: 1, instagramId: 1 }, { unique: true, sparse: true, partialFilterExpression: { instagramId: { $exists: true } } });
const mediaSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  url: String, title: String, kind: String, size: Number, duration: Number,
  posterUrl: String, posterFileId: String,
  folder: String, tags: [String], favorite: Boolean, usedCount: Number,
  instagramId: String, permalink: String, createdAt: String,
}, { strict: false });
mediaSchema.index({ userId: 1, createdAt: -1 });
mediaSchema.index({ userId: 1, instagramId: 1 }, { unique: true, sparse: true, partialFilterExpression: { instagramId: { $exists: true } } });
// Uploaded media binaries, kept apart from the media library metadata:
// the library doc holds only a public /media/<id> URL, the bytes live
// here so Instagram's fetcher can download them from the app itself.
// One doc per file (uploads are capped well under MongoDB's 16 MB
// document limit by the upload endpoint).
const mediaFileSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  contentType: String, size: Number, data: Buffer,
  createdAt: String,
}, { strict: false });
const templateSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true }, name: String, text: String,
  // Caption library (batch 3): a saved set is caption + hashtags + CTA,
  // inserted into the composer in one tap. Older templates have only
  // text; the new fields are simply empty for them.
  hashtags: String, cta: String,
}, { strict: false });
// Drafts library (Phase C3): NAMED composer drafts — distinct from
// draft-status posts. A snapshot of the composer (media ref, caption,
// hashtags, format/account, YouTube setting, first comment, repeat)
// the user can load back into the Studio. Per-user, like templates.
const draftSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true }, name: String,
  caption: String, hashtags: String, cta: String,
  mediaUrl: String, mediaType: String, posterUrl: String,
  platform: String, format: String,
  igAccountId: String, igAccountUsername: String,
  youtube: { type: mongoose.Schema.Types.Mixed, default: null },
  firstComment: String, repeat: String,
  createdAt: String,
}, { strict: false });
// Hashtag groups (the composer's hashtag bank): a named bundle of
// hashtags the user appends to a caption in one tap. Per-user, like
// templates.
const hashtagGroupSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true }, name: String, tags: String,
  createdAt: String,
});
// Password reset tokens: only the SHA-256 hash of the token is stored,
// never the token itself. One doc per issued link; a successful reset
// deletes every outstanding doc for the user (single-use + revoke-all).
const passwordResetSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  tokenHash: { type: String, index: true },
  expiresAt: String, createdAt: String,
}, { strict: false });
// In-app Google sign-in return codes: one-time, short-lived (5 min)
// codes issued after a verified Google sign-in in the system browser
// and exchanged by the app for a normal session. Only the SHA-256
// hash of the code is stored, never the code itself; a successful
// exchange deletes the doc (single-use).
const appCodeSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  codeHash: { type: String, index: true },
  expiresAt: String, createdAt: String,
}, { strict: false });
// Link-in-bio page (Phase D6): one per user, addressed publicly by a
// unique slug. links is a small [{title, url}] list (Mixed).
const bioSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  slug: { type: String, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  links: { type: mongoose.Schema.Types.Mixed, default: [] },
  updatedAt: String,
}, { strict: false });
// YouTube connection (Phase B cross-post): one per user. The OAuth
// refresh token is stored encrypted (refreshTokenEnc); access tokens
// are minted server-side on demand and never stored.
const youtubeSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  channelId: String, channelTitle: String, channelThumb: String,
  refreshTokenEnc: String, refreshTokenEncrypted: { type: Boolean, default: false },
  connectedAt: String, updatedAt: String,
}, { strict: false });
const settingsSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
});
const instagramSchema = new mongoose.Schema({
  userId: { type: String, unique: true, index: true },
  tokenEnc: String, encrypted: { type: Boolean, default: false },
  igUserId: String, username: String, pageId: String,
  profile: { type: mongoose.Schema.Types.Mixed, default: null },
  connectedAt: String, importedAt: String,
  // Token health (self-renewing connection): expiry learned from Meta's
  // debug_token, plus when the keeper last checked / last renewed it.
  // tokenRefreshError is '' when healthy, 'revoked-or-expired' when Meta
  // says the token is dead, 'auto-refresh-unavailable' when no renewal
  // path exists for this token type yet.
  tokenExpiresAt: String, tokenNeverExpires: { type: Boolean, default: false },
  tokenType: String, tokenHost: String,
  lastTokenCheckAt: String, lastRefreshAt: String, tokenRefreshError: String,
  lastDebugError: String, lastRefreshError: String,
  // Multi-account support (additive): `accounts` holds EVERY connected
  // Instagram account for this user, each entry shaped like the legacy
  // single-connection fields above (its own tokenEnc included). The
  // top-level fields remain as a live mirror of the DEFAULT account
  // (defaultIgUserId), so older code — and a rollback to it — keeps
  // reading exactly the connection it always read. A doc without an
  // `accounts` array is a legacy single-connection doc; the account
  // list is derived from the top-level fields on read (lazy migration)
  // and materialised on the next write.
  accounts: { type: [mongoose.Schema.Types.Mixed], default: undefined },
  defaultIgUserId: String,
});
const importJobSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  status: String, done: Boolean, fetched: Number,
  importedMedia: Number, importedPosts: Number,
  profile: { type: mongoose.Schema.Types.Mixed, default: null },
  error: String, message: String, startedAt: String, updatedAt: String,
}, { strict: false });
// In-app notifications (publish successes/failures). One doc per event.
const notificationSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  type: String, postId: String, message: String,
  read: { type: Boolean, default: false }, createdAt: String,
}, { strict: false });
notificationSchema.index({ userId: 1, createdAt: -1 });
// Chunked-upload sessions: metadata here, chunk bytes in uploadchunks
// (one doc per chunk, each well under the 16 MB document limit). A
// session is created by /api/media/upload/init, filled chunk by chunk,
// and deleted by /complete, /abort, or the expiry sweep.
const uploadSessionSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  userId: { type: String, index: true },
  name: String, contentType: String, size: Number, folder: String,
  tags: [String], width: Number, height: Number, duration: Number,
  posterDataUrl: String,
  chunkCount: Number, received: { type: Number, default: 0 },
  createdAt: String, expiresAt: String,
}, { strict: false });
const uploadChunkSchema = new mongoose.Schema({
  sessionId: { type: String, index: true },
  userId: String, index: Number, data: Buffer,
}, { strict: false });
uploadChunkSchema.index({ sessionId: 1, index: 1 }, { unique: true });
// Owner admin-panel audit log (batch 2): one doc per admin action —
// plan change, comp grant/revoke, expiry change, limit override, PIN
// set/change. Global (not per-user): written by the owner, read only
// by the owner, and kept even if the target user is later deleted.
const adminAuditSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  at: String, adminId: String, action: String,
  targetUserId: String, targetEmail: String, summary: String,
}, { strict: false });
adminAuditSchema.index({ at: -1 });
// Team invites (batch 3, agency foundation for Ultra): one doc per
// invited email. ownerId = the workspace owner; memberUserId is set
// when the invited email belongs to a registered account (bound at
// invite time if the account already exists, otherwise at that
// account's next login). status: 'invited' (no account yet — grants
// nothing), 'active' (bound — grants the role), 'removed' (revoked;
// the row stays so the history is visible). role: 'scheduler' |
// 'viewer', enforced server-side on every request.
const teamInviteSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
  ownerId: { type: String, index: true },
  email: { type: String, index: true },
  role: String, status: String,
  memberUserId: { type: String, index: true },
  createdAt: String, boundAt: String, removedAt: String,
}, { strict: false });
teamInviteSchema.index({ ownerId: 1, email: 1 });
// Global app settings (batch 6): ONE doc (id 'global') holding the
// owner console's safe global toggles — signup open/closed and the
// maintenance switch + message. Defaults live in GLOBAL_SETTINGS_DEFAULTS
// below; this doc only ever stores what the owner changed.
const globalSettingsSchema = new mongoose.Schema({
  id: { type: String, unique: true, index: true },
}, { strict: false });

const User = mongoose.models.SsUser || mongoose.model('SsUser', userSchema, 'users');
const Session = mongoose.models.SsSession || mongoose.model('SsSession', sessionSchema, 'sessions');
const Post = mongoose.models.SsPost || mongoose.model('SsPost', postSchema, 'posts');
const Media = mongoose.models.SsMedia || mongoose.model('SsMedia', mediaSchema, 'media');
const MediaFile = mongoose.models.SsMediaFile || mongoose.model('SsMediaFile', mediaFileSchema, 'mediafiles');
const Template = mongoose.models.SsTemplate || mongoose.model('SsTemplate', templateSchema, 'templates');
const Draft = mongoose.models.SsDraft || mongoose.model('SsDraft', draftSchema, 'drafts');
const HashtagGroup = mongoose.models.SsHashtagGroup || mongoose.model('SsHashtagGroup', hashtagGroupSchema, 'hashtaggroups');
const PasswordReset = mongoose.models.SsPasswordReset || mongoose.model('SsPasswordReset', passwordResetSchema, 'passwordresets');
const AppCode = mongoose.models.SsAppCode || mongoose.model('SsAppCode', appCodeSchema, 'appcodes');
const YouTube = mongoose.models.SsYouTube || mongoose.model('SsYouTube', youtubeSchema, 'youtube');
const Bio = mongoose.models.SsBio || mongoose.model('SsBio', bioSchema, 'bios');
const SettingsDoc = mongoose.models.SsSettings || mongoose.model('SsSettings', settingsSchema, 'settings');
const InstagramDoc = mongoose.models.SsInstagram || mongoose.model('SsInstagram', instagramSchema, 'instagram');
const ImportJob = mongoose.models.SsImportJob || mongoose.model('SsImportJob', importJobSchema, 'importjobs');
const Notification = mongoose.models.SsNotification || mongoose.model('SsNotification', notificationSchema, 'notifications');
const UploadSession = mongoose.models.SsUploadSession || mongoose.model('SsUploadSession', uploadSessionSchema, 'uploadsessions');
const UploadChunk = mongoose.models.SsUploadChunk || mongoose.model('SsUploadChunk', uploadChunkSchema, 'uploadchunks');
const AdminAudit = mongoose.models.SsAdminAudit || mongoose.model('SsAdminAudit', adminAuditSchema, 'adminaudits');
const TeamInvite = mongoose.models.SsTeamInvite || mongoose.model('SsTeamInvite', teamInviteSchema, 'teaminvites');
const GlobalSettings = mongoose.models.SsGlobalSettings || mongoose.model('SsGlobalSettings', globalSettingsSchema, 'globalsettings');

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
// The owner is always the FIRST user and can never change, so a resolved
// owner id is cached: listUsers() is a full scan and ownerId() runs on
// nearly every list/update — this keeps hot read paths cheap.
let ownerCache = { id: null, at: 0 };
async function ownerId() {
  if (ownerCache.id && Date.now() - ownerCache.at < 60000) return ownerCache.id;
  const users = await listUsers();
  // Audit fix (2026-11-22): resolve the owner DETERMINISTICALLY as the
  // earliest-registered account. listUsers() is an unsorted find({}) and
  // MongoDB natural order is not a guaranteed ordering, so users[0] could
  // silently become the wrong account after deletions or restores — and
  // every privileged gate follows this id (admin console, maintenance
  // bypass, legacy-doc ownership). Array.prototype.sort is stable, so
  // accounts created in the same millisecond keep their list order and
  // today's resolution is unchanged.
  const sorted = [...users].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const id = sorted.length ? sorted[0].id : null;
  if (id) ownerCache = { id, at: Date.now() };
  return id;
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
async function updateUser(id, patch) {
  await ensureMongo();
  if (isMongo()) { const u = await User.findOneAndUpdate({ id }, patch, { new: true }).lean(); return u ? strip(u) : null; }
  const list = jsonList('users');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('users', list); return item;
}
// Delete a user and every document that belongs to them (posts, media,
// templates, settings, Instagram connection, import jobs, sessions).
async function deleteUserData(userId) {
  await ensureMongo();
  if (isMongo()) {
    await Promise.all([
      User.deleteOne({ id: userId }),
      Session.deleteMany({ userId }),
      Post.deleteMany({ userId }),
      Media.deleteMany({ userId }),
      MediaFile.deleteMany({ userId }),
      Template.deleteMany({ userId }),
      Draft.deleteMany({ userId }),
      HashtagGroup.deleteMany({ userId }),
      PasswordReset.deleteMany({ userId }),
      AppCode.deleteMany({ userId }),
      YouTube.deleteOne({ userId }),
      Bio.deleteOne({ userId }),
      SettingsDoc.deleteOne({ userId }),
      InstagramDoc.deleteOne({ userId }),
      ImportJob.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      UploadSession.deleteMany({ userId }),
      UploadChunk.deleteMany({ userId }),
      TeamInvite.deleteMany({ ownerId: userId }),
      TeamInvite.deleteMany({ memberUserId: userId }),
    ]);
    return;
  }
  jsonSave('users', jsonList('users').filter((x) => x.id !== userId));
  jsonSave('sessions', jsonList('sessions').filter((x) => x.userId !== userId));
  jsonSave('posts', jsonList('posts').filter((x) => x.userId !== userId));
  jsonSave('media', jsonList('media').filter((x) => x.userId !== userId));
  jsonSave('mediaFiles', jsonList('mediaFiles').filter((x) => x.userId !== userId));
  jsonSave('templates', jsonList('templates').filter((x) => x.userId !== userId));
  jsonSave('drafts', jsonList('drafts').filter((x) => x.userId !== userId));
  jsonSave('hashtagGroups', jsonList('hashtagGroups').filter((x) => x.userId !== userId));
  jsonSave('passwordResets', jsonList('passwordResets').filter((x) => x.userId !== userId));
  jsonSave('appCodes', jsonList('appCodes').filter((x) => x.userId !== userId));
  const yt = load(JSON_FILES.youtube, {});
  if (yt && typeof yt === 'object') { delete yt[userId]; save(JSON_FILES.youtube, yt); }
  const bioMap = load(JSON_FILES.bios, {});
  if (bioMap && typeof bioMap === 'object') { delete bioMap[userId]; save(JSON_FILES.bios, bioMap); }
  const settings = load(JSON_FILES.settings, {});
  if (settings && typeof settings === 'object') { delete settings[userId]; save(JSON_FILES.settings, settings); }
  const ig = load(JSON_FILES.instagram, {});
  if (ig && typeof ig === 'object') { delete ig[userId]; save(JSON_FILES.instagram, ig); }
  jsonSave('importJobs', jsonList('importJobs').filter((x) => x.userId !== userId));
  jsonSave('teamInvites', jsonList('teamInvites').filter((x) => x.ownerId !== userId && x.memberUserId !== userId));
  jsonSave('notifications', jsonList('notifications').filter((x) => x.userId !== userId));
  for (const s of jsonList('uploadSessions').filter((x) => x.userId === userId)) deleteUploadChunkFiles(s.id);
  jsonSave('uploadSessions', jsonList('uploadSessions').filter((x) => x.userId !== userId));
}
async function countUsers() {
  await ensureMongo();
  if (isMongo()) return User.countDocuments({});
  return jsonList('users').length;
}

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
async function listSessions() {
  await ensureMongo();
  if (isMongo()) return stripAll(await Session.find({}).lean());
  return jsonList('sessions');
}

// Mongo filter that returns only docs visible to this user: their own docs,
// plus (for the owner only) legacy docs saved before per-user scoping that
// have no userId. Used by every list/update/delete so the database — not
// in-memory filtering — enforces isolation.
function scopeFilter(userId, owner) {
  if (userId && userId === owner) return { $or: [{ userId }, { userId: { $exists: false } }] };
  return { userId };
}
function pageSlice(list, opts) {
  if (opts?.all) return list;
  const limit = Math.min(Math.max(Number(opts?.limit) || 200, 1), 500);
  const offset = Math.max(Number(opts?.offset) || 0, 0);
  return list.slice(offset, offset + limit);
}

// ---------- posts ----------
async function listPosts(userId, opts = {}) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) {
    const q = Post.find(scopeFilter(userId, owner)).sort({ createdAt: 1 });
    if (!opts.all) {
      const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
      const offset = Math.max(Number(opts.offset) || 0, 0);
      q.skip(offset).limit(limit);
    }
    return stripAll(await q.lean());
  }
  return pageSlice(visibleTo(jsonList('posts'), userId, owner), opts);
}
async function getPost(userId, id) {
  const all = await listPosts(userId, { all: true });
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
  if (isMongo()) {
    const owner = await ownerId();
    const filter = { $and: [{ id }, scopeFilter(userId, owner)] };
    const p = await Post.findOneAndUpdate(filter, patch, { new: true }).lean();
    return p ? strip(p) : null;
  }
  const list = jsonList('posts');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('posts', list); return item;
}
async function deletePost(userId, id) {
  await ensureMongo();
  const existing = await getPost(userId, id);
  if (!existing) return false;
  if (isMongo()) {
    const owner = await ownerId();
    await Post.deleteOne({ $and: [{ id }, scopeFilter(userId, owner)] });
    return true;
  }
  jsonSave('posts', jsonList('posts').filter((x) => x.id !== id)); return true;
}

// ---------- media ----------
async function listMedia(userId, opts = {}) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) {
    const q = Media.find(scopeFilter(userId, owner)).sort({ createdAt: -1 });
    if (!opts.all) {
      const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
      const offset = Math.max(Number(opts.offset) || 0, 0);
      q.skip(offset).limit(limit);
    }
    return stripAll(await q.lean());
  }
  return pageSlice(visibleTo(jsonList('media'), userId, owner), opts);
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
  const all = await listMedia(userId, { all: true });
  if (!all.some((m) => m.id === id)) return null;
  if (isMongo()) {
    const owner = await ownerId();
    const m = await Media.findOneAndUpdate({ $and: [{ id }, scopeFilter(userId, owner)] }, patch, { new: true }).lean();
    return m ? strip(m) : null;
  }
  const list = jsonList('media');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('media', list); return item;
}
async function deleteMedia(userId, id) {
  await ensureMongo();
  const all = await listMedia(userId, { all: true });
  const item = all.find((m) => m.id === id);
  if (!item) return false;
  if (isMongo()) {
    const owner = await ownerId();
    await Media.deleteOne({ $and: [{ id }, scopeFilter(userId, owner)] });
  } else {
    jsonSave('media', jsonList('media').filter((x) => x.id !== id));
  }
  // Remove the stored binary too, so deleted uploads do not linger
  // behind their (now-dead) public URL.
  if (item.fileId) { try { await deleteMediaFile(item.fileId); } catch { /* metadata is gone either way */ } }
  if (item.posterFileId) { try { await deleteMediaFile(item.posterFileId); } catch { /* metadata is gone either way */ } }
  return true;
}

// ---------- media files (uploaded binaries behind /media/<id>) ----------
async function saveMediaFile(file) {
  await ensureMongo();
  const doc = {
    id: file.id, userId: file.userId, contentType: file.contentType || 'application/octet-stream',
    size: file.buffer ? file.buffer.length : 0, createdAt: new Date().toISOString(),
  };
  if (isMongo()) { await MediaFile.create({ ...doc, data: file.buffer }); return doc; }
  const list = jsonList('mediaFiles');
  list.push({ ...doc, dataB64: file.buffer ? file.buffer.toString('base64') : '' });
  jsonSave('mediaFiles', list);
  return doc;
}
async function getMediaFile(id) {
  await ensureMongo();
  if (!id || typeof id !== 'string') return null;
  if (isMongo()) {
    const d = await MediaFile.findOne({ id }).lean();
    if (!d) return null;
    const raw = d.data;
    const buffer = Buffer.isBuffer(raw) ? raw : (raw && raw.buffer ? Buffer.from(raw.buffer) : Buffer.from(raw || []));
    return { id: d.id, contentType: d.contentType || 'application/octet-stream', size: d.size || buffer.length, buffer };
  }
  const f = jsonList('mediaFiles').find((x) => x.id === id);
  if (!f) return null;
  const buffer = Buffer.from(f.dataB64 || '', 'base64');
  return { id: f.id, contentType: f.contentType || 'application/octet-stream', size: f.size || buffer.length, buffer };
}
async function deleteMediaFile(id) {
  await ensureMongo();
  if (!id) return;
  if (isMongo()) { await MediaFile.deleteOne({ id }); return; }
  jsonSave('mediaFiles', jsonList('mediaFiles').filter((x) => x.id !== id));
}

// ---------- templates ----------
async function listTemplates(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await Template.find(scopeFilter(userId, owner)).lean());
  return visibleTo(jsonList('templates'), userId, owner);
}
async function saveTemplate(tpl) {
  await ensureMongo();
  if (isMongo()) { await Template.create(tpl); return tpl; }
  const list = jsonList('templates'); list.push(tpl); jsonSave('templates', list); return tpl;
}
async function deleteTemplate(userId, id) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) {
    const r = await Template.deleteOne({ id, ...scopeFilter(userId, owner) });
    return r.deletedCount > 0;
  }
  const list = jsonList('templates');
  const kept = list.filter((x) => !(x.id === id && visibleTo([x], userId, owner).length));
  if (kept.length === list.length) return false;
  jsonSave('templates', kept);
  return true;
}

// ---------- drafts library (named composer drafts, Phase C3) ----------
async function listDrafts(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await Draft.find(scopeFilter(userId, owner)).lean());
  return visibleTo(jsonList('drafts'), userId, owner);
}
async function saveDraft(draft) {
  await ensureMongo();
  if (isMongo()) { await Draft.create(draft); return draft; }
  const list = jsonList('drafts'); list.push(draft); jsonSave('drafts', list); return draft;
}
async function deleteDraft(userId, id) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) {
    const r = await Draft.deleteOne({ id, ...scopeFilter(userId, owner) });
    return r.deletedCount > 0;
  }
  const list = jsonList('drafts');
  const kept = list.filter((x) => !(x.id === id && visibleTo([x], userId, owner).length));
  if (kept.length === list.length) return false;
  jsonSave('drafts', kept);
  return true;
}

// ---------- hashtag groups (composer hashtag bank) ----------
async function listHashtagGroups(userId) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) return stripAll(await HashtagGroup.find(scopeFilter(userId, owner)).lean());
  return visibleTo(jsonList('hashtagGroups'), userId, owner);
}
async function saveHashtagGroup(group) {
  await ensureMongo();
  if (isMongo()) { await HashtagGroup.create(group); return group; }
  const list = jsonList('hashtagGroups'); list.push(group); jsonSave('hashtagGroups', list); return group;
}
async function deleteHashtagGroup(userId, id) {
  await ensureMongo();
  const owner = await ownerId();
  if (isMongo()) {
    const r = await HashtagGroup.deleteOne({ id, ...scopeFilter(userId, owner) });
    return r.deletedCount > 0;
  }
  const list = jsonList('hashtagGroups');
  const kept = list.filter((x) => !(x.id === id && visibleTo([x], userId, owner).length));
  if (kept.length === list.length) return false;
  jsonSave('hashtagGroups', kept);
  return true;
}

// ---------- password resets (hashed tokens, single-use) ----------
async function createPasswordReset(doc) {
  await ensureMongo();
  if (isMongo()) { await PasswordReset.create(doc); return doc; }
  const list = jsonList('passwordResets'); list.push(doc); jsonSave('passwordResets', list); return doc;
}
async function getPasswordResetByHash(tokenHash) {
  await ensureMongo();
  if (!tokenHash) return null;
  if (isMongo()) { const d = await PasswordReset.findOne({ tokenHash }).lean(); return d ? strip(d) : null; }
  return jsonList('passwordResets').find((x) => x.tokenHash === tokenHash) || null;
}
async function listPasswordResetsForUser(userId) {
  await ensureMongo();
  if (isMongo()) return stripAll(await PasswordReset.find({ userId }).lean());
  return jsonList('passwordResets').filter((x) => x.userId === userId);
}
async function deletePasswordResetsForUser(userId) {
  await ensureMongo();
  if (isMongo()) { await PasswordReset.deleteMany({ userId }); return; }
  jsonSave('passwordResets', jsonList('passwordResets').filter((x) => x.userId !== userId));
}

// ---------- app sign-in codes (one live doc per user; see schema) ----------
async function createAppCode(doc) {
  await ensureMongo();
  if (isMongo()) { await AppCode.create(doc); return doc; }
  const list = jsonList('appCodes'); list.push(doc); jsonSave('appCodes', list); return doc;
}
async function getAppCodeByHash(codeHash) {
  await ensureMongo();
  if (isMongo()) { const d = await AppCode.findOne({ codeHash }).lean(); return d ? strip(d) : null; }
  return jsonList('appCodes').find((x) => x.codeHash === codeHash) || null;
}
async function deleteAppCodeByHash(codeHash) {
  await ensureMongo();
  if (isMongo()) { await AppCode.deleteOne({ codeHash }); return; }
  jsonSave('appCodes', jsonList('appCodes').filter((x) => x.codeHash !== codeHash));
}
async function deleteAppCodesForUser(userId) {
  await ensureMongo();
  if (isMongo()) { await AppCode.deleteMany({ userId }); return; }
  jsonSave('appCodes', jsonList('appCodes').filter((x) => x.userId !== userId));
}

// ---------- youtube connection (one doc per user; JSON = keyed map) ----------
async function getYouTube(userId) {
  await ensureMongo();
  if (!userId) return null;
  if (isMongo()) {
    const d = await YouTube.findOne({ userId }).lean();
    return d ? strip(d) : null;
  }
  const all = load(JSON_FILES.youtube, {});
  return (all && typeof all === 'object' && all[userId]) || null;
}
async function saveYouTube(doc) {
  await ensureMongo();
  if (isMongo()) {
    await YouTube.replaceOne({ userId: doc.userId }, { ...doc }, { upsert: true });
    return doc;
  }
  const all = load(JSON_FILES.youtube, {});
  const map = (all && typeof all === 'object') ? all : {};
  map[doc.userId] = doc;
  save(JSON_FILES.youtube, map);
  return doc;
}
async function deleteYouTube(userId) {
  await ensureMongo();
  if (isMongo()) { await YouTube.deleteOne({ userId }); return; }
  const all = load(JSON_FILES.youtube, {});
  if (all && typeof all === 'object' && all[userId]) { delete all[userId]; save(JSON_FILES.youtube, all); }
}

// ---------- link-in-bio (one doc per user; JSON = keyed map) ----------
async function getBio(userId) {
  await ensureMongo();
  if (!userId) return null;
  if (isMongo()) {
    const d = await Bio.findOne({ userId }).lean();
    return d ? strip(d) : null;
  }
  const all = load(JSON_FILES.bios, {});
  return (all && typeof all === 'object' && all[userId]) || null;
}
async function getBioBySlug(slug) {
  await ensureMongo();
  if (!slug) return null;
  if (isMongo()) {
    const d = await Bio.findOne({ slug }).lean();
    return d ? strip(d) : null;
  }
  const all = load(JSON_FILES.bios, {});
  if (!all || typeof all !== 'object') return null;
  return Object.values(all).find((b) => b && b.slug === slug) || null;
}
async function saveBio(doc) {
  await ensureMongo();
  if (isMongo()) {
    await Bio.replaceOne({ userId: doc.userId }, { ...doc }, { upsert: true });
    return doc;
  }
  const all = load(JSON_FILES.bios, {});
  const map = (all && typeof all === 'object') ? all : {};
  map[doc.userId] = doc;
  save(JSON_FILES.bios, map);
  return doc;
}

// ---------- referrals (Phase D11): codes live on the user doc ----------
async function getUserByReferralCode(code) {
  await ensureMongo();
  if (!code) return null;
  if (isMongo()) { const u = await User.findOne({ referralCode: code }).lean(); return u ? strip(u) : null; }
  return jsonList('users').find((u) => u.referralCode === code) || null;
}
async function countReferrals(code) {
  await ensureMongo();
  if (!code) return 0;
  if (isMongo()) return User.countDocuments({ referredBy: code });
  return jsonList('users').filter((u) => u.referredBy === code).length;
}

// ---------- settings (one doc per user) ----------
async function getSettings(userId) {
  await ensureMongo();
  if (isMongo()) {
    const doc = await SettingsDoc.findOne({ userId }).lean();
    return (doc && doc.data) || {};
  }
  const all = load(JSON_FILES.settings, {});
  if (!all || typeof all !== 'object' || Array.isArray(all)) return {};
  if (all[userId] && typeof all[userId] === 'object') return all[userId];
  if (all[userId]) return {}; // non-object entry: not valid settings
  // No per-user entry. A legacy FLAT settings object (values are simple
  // settings, saved before per-user storage) belongs to the owner only —
  // never hand one user's settings (or the whole per-user map) to
  // another user.
  const looksPerUserMap = Object.values(all).some((v) => v && typeof v === 'object');
  if (!looksPerUserMap) {
    const owner = await ownerId();
    if (userId && owner && userId === owner) return all;
  }
  return {};
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
function instagramHealthFields(doc) {
  return {
    tokenExpiresAt: doc.tokenExpiresAt || '', tokenNeverExpires: !!doc.tokenNeverExpires,
    tokenType: doc.tokenType || '', tokenHost: doc.tokenHost || '', lastTokenCheckAt: doc.lastTokenCheckAt || '',
    lastRefreshAt: doc.lastRefreshAt || '', tokenRefreshError: doc.tokenRefreshError || '',
    lastDebugError: doc.lastDebugError || '', lastRefreshError: doc.lastRefreshError || '',
  };
}
// ---------- multi-account view of an instagram doc ----------
// The stored fields of ONE connection (everything except userId). An
// account entry in doc.accounts carries exactly these fields (plus its
// own tokenEnc/encrypted), so an entry and a legacy doc are
// interchangeable everywhere below.
const IG_CONN_FIELDS = ['igUserId', 'username', 'pageId', 'profile', 'connectedAt', 'importedAt',
  'tokenExpiresAt', 'tokenNeverExpires', 'tokenType', 'tokenHost', 'lastTokenCheckAt', 'lastRefreshAt',
  'tokenRefreshError', 'lastDebugError', 'lastRefreshError'];
function legacyEntryFromDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (!doc.token && !doc.tokenEnc && !doc.igUserId) return null;
  const e = {};
  for (const k of IG_CONN_FIELDS) if (doc[k] !== undefined) e[k] = doc[k];
  if (doc.token !== undefined) e.token = doc.token;
  if (doc.tokenEnc !== undefined) e.tokenEnc = doc.tokenEnc;
  if (doc.encrypted !== undefined) e.encrypted = doc.encrypted;
  return e;
}
// Raw stored account entries for a doc: the materialised list when
// present, else the legacy single connection as a one-entry list (the
// lazy migration — nothing is rewritten until the next save).
function rawAccountsOf(doc) {
  if (!doc || typeof doc !== 'object') return [];
  if (Array.isArray(doc.accounts) && doc.accounts.length) {
    const list = doc.accounts.filter((a) => a && typeof a === 'object' && (a.igUserId || a.token || a.tokenEnc));
    if (list.length) return list;
  }
  const legacy = legacyEntryFromDoc(doc);
  return legacy ? [legacy] : [];
}
function defaultRawAccount(doc) {
  const list = rawAccountsOf(doc);
  if (!list.length) return null;
  if (doc && doc.defaultIgUserId) {
    const m = list.find((a) => String(a.igUserId || '') === String(doc.defaultIgUserId));
    if (m) return m;
  }
  return list[0];
}
// The top-level mirror patch for one raw entry: the legacy fields a
// pre-multi-account reader expects to find on the doc itself.
function topLevelPatchFromEntry(entry) {
  const p = {};
  if (!entry) return p;
  for (const k of IG_CONN_FIELDS) if (entry[k] !== undefined) p[k] = entry[k];
  if (entry.tokenEnc !== undefined) { p.tokenEnc = entry.tokenEnc; p.encrypted = !!entry.encrypted; }
  else if (entry.token !== undefined) { p.token = entry.token; p.encrypted = false; }
  return p;
}
// Load the raw stored doc for one user (Mongo lean doc or the JSON
// object), or null. The JSON legacy FLAT doc (connection fields at the
// top level of the whole file) belongs to the owner only — same rule
// as the original getInstagram().
async function loadInstagramRaw(userId) {
  await ensureMongo();
  if (isMongo()) {
    const doc = await InstagramDoc.findOne({ userId }).lean();
    return doc || null;
  }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  let doc = obj[userId];
  if (!doc) {
    const looksFlat = !!(obj.token || obj.tokenEnc || obj.igUserId);
    if (looksFlat) {
      const owner = await ownerId();
      if (userId && owner && userId === owner) doc = obj;
    }
  }
  return (doc && typeof doc === 'object') ? doc : null;
}
// Persist the full account list for one user: stores `accounts`,
// records the default, and mirrors the default entry onto the legacy
// top-level fields so older code (and a rollback to it) keeps working.
// An empty list removes the doc entirely (== fully disconnected).
async function persistInstagramRaw(userId, entries, defaultIgUserId) {
  const def = entries.find((a) => String(a.igUserId || '') === String(defaultIgUserId || '')) || entries[0] || null;
  const defId = def ? (def.igUserId || '') : '';
  await ensureMongo();
  if (isMongo()) {
    if (!entries.length) { await InstagramDoc.deleteOne({ userId }); return; }
    const patch = { userId, accounts: entries, defaultIgUserId: defId, ...topLevelPatchFromEntry(def) };
    await InstagramDoc.updateOne({ userId }, { $set: patch }, { upsert: true });
    return;
  }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  if (!entries.length) { delete obj[userId]; save(JSON_FILES.instagram, obj); return; }
  const prev = (obj[userId] && typeof obj[userId] === 'object' && !Array.isArray(obj[userId])) ? obj[userId] : {};
  const next = { ...prev, accounts: entries, defaultIgUserId: defId, ...topLevelPatchFromEntry(def) };
  if (def && def.tokenEnc) delete next.token; // encrypted at rest wins over any stale plaintext
  obj[userId] = next;
  // A legacy FLAT doc that was just migrated into obj[userId] must not
  // linger at the file's top level, or listInstagram() would keep
  // reading the stale flat copy as the owner's connection. Strip it
  // ONLY when the flat connection is one of the accounts this persist
  // just wrote for this user — another user's save must never delete
  // the owner's flat connection out from under them.
  const flatId = obj.igUserId || '';
  if ((obj.token || obj.tokenEnc || obj.igUserId)
    && entries.some((e) => String(e.igUserId || '') === String(flatId) && flatId)) {
    for (const k of [...IG_CONN_FIELDS, 'token', 'tokenEnc', 'encrypted']) delete obj[k];
  }
  save(JSON_FILES.instagram, obj);
}
// The user's DEFAULT connection, shaped exactly as this function has
// always returned it — every existing caller keeps working unchanged.
async function getInstagram(userId) {
  const doc = await loadInstagramRaw(userId);
  if (!doc) return {};
  const def = defaultRawAccount(doc);
  if (!def) return {};
  return shapeInstagramDoc(def) || {};
}
// Every connected account for the user (shaped like getInstagram()),
// plus which one is the default. Tokens are included — server-side
// use only; API responses must pick safe fields from these records.
async function getInstagramAccounts(userId) {
  const doc = await loadInstagramRaw(userId);
  if (!doc) return { accounts: [], defaultIgUserId: '' };
  const def = defaultRawAccount(doc);
  return {
    accounts: rawAccountsOf(doc).map((e) => shapeInstagramDoc(e)).filter(Boolean),
    defaultIgUserId: def ? (def.igUserId || '') : '',
  };
}
async function getInstagramAccount(userId, igUserId) {
  if (!igUserId) return null;
  const { accounts } = await getInstagramAccounts(userId);
  return accounts.find((a) => String(a.igUserId || '') === String(igUserId)) || null;
}
function shapeInstagramDoc(doc) {
  if (!doc || typeof doc !== 'object') return null;
  if (doc.token && !doc.tokenEnc) {
    return {
      token: doc.token, igUserId: doc.igUserId || '', username: doc.username || '', pageId: doc.pageId || '',
      profile: doc.profile || null, connectedAt: doc.connectedAt || '', importedAt: doc.importedAt || '',
      encrypted: false, ...instagramHealthFields(doc),
    };
  }
  return {
    token: decryptToken(doc), igUserId: doc.igUserId || '', username: doc.username || '', pageId: doc.pageId || '',
    profile: doc.profile || null, connectedAt: doc.connectedAt || '', importedAt: doc.importedAt || '',
    encrypted: !!doc.encrypted, ...instagramHealthFields(doc),
  };
}
// Every stored Instagram connection in ONE query, shaped like
// getInstagram() plus the owning userId. db-status uses this to find
// the connected account: the old per-user loop cost one sequential
// round trip per account on every call, which made db-status the
// slowest route in the app once a few users had signed up. Each entry
// is the user's DEFAULT connection (as getInstagram returns), plus
// accountsCount — how many accounts that user has connected in total.
async function listInstagram() {
  await ensureMongo();
  if (isMongo()) {
    const docs = await InstagramDoc.find({}).lean();
    return docs.map((doc) => {
      const def = defaultRawAccount(doc);
      const shaped = shapeInstagramDoc(def || doc);
      return shaped ? { userId: doc.userId || '', ...shaped, accountsCount: rawAccountsOf(doc).length } : null;
    }).filter((d) => d && d.token !== undefined);
  }
  const all = load(JSON_FILES.instagram, {});
  const obj = (all && typeof all === 'object' && !Array.isArray(all)) ? all : {};
  const out = [];
  const seen = new Set();
  // In a legacy FLAT file the connection's own field names sit at the
  // top level next to any user keys — never mistake one for a user id.
  const SKIP_KEYS = new Set([...IG_CONN_FIELDS, 'token', 'tokenEnc', 'encrypted', 'accounts', 'defaultIgUserId', 'userId']);
  for (const [userId, doc] of Object.entries(obj)) {
    if (SKIP_KEYS.has(userId)) continue;
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) continue;
    const def = defaultRawAccount(doc);
    const shaped = shapeInstagramDoc(def || doc);
    if (shaped) { out.push({ userId, ...shaped, accountsCount: rawAccountsOf(doc).length }); seen.add(userId); }
  }
  // A legacy FLAT doc (token fields at the top level) is one connection
  // belonging to the owner — same rule as getInstagram(). It counts
  // only when the owner has no keyed doc of their own (a keyed doc is
  // the migrated, current copy).
  const looksFlat = !!(obj.token || obj.tokenEnc || obj.igUserId);
  if (looksFlat) {
    const owner = await ownerId();
    if (owner && !seen.has(owner)) {
      const shaped = shapeInstagramDoc(obj);
      if (shaped) out.push({ userId: owner, ...shaped, accountsCount: rawAccountsOf(obj).length });
    }
  }
  return out;
}
// Patch ONE connection's fields (keeper health updates, token renewals,
// import metadata). Target account: the explicit igUserId argument,
// else the igUserId named in fields, else the default account. The
// legacy top-level mirror is refreshed whenever the DEFAULT account is
// the one patched (persistInstagramRaw handles that). An explicitly
// named account that no longer exists is NOT resurrected — the patch
// is dropped (e.g. a keeper run that raced a disconnect).
async function saveInstagram(userId, fields, igUserId) {
  const doc = await loadInstagramRaw(userId);
  const entries = rawAccountsOf(doc).map((e) => ({ ...e }));
  const { token, ...rest } = fields || {};
  const enc = token !== undefined ? encryptToken(token) : null;
  const explicitId = igUserId !== undefined && igUserId !== null && igUserId !== '' ? String(igUserId) : '';
  let idx = -1;
  if (explicitId) {
    idx = entries.findIndex((e) => String(e.igUserId || '') === explicitId);
    if (idx < 0) return; // account gone — never resurrect it from a stale patch
  } else if (rest.igUserId) {
    idx = entries.findIndex((e) => String(e.igUserId || '') === String(rest.igUserId));
  }
  if (idx < 0) {
    const def = defaultRawAccount(doc);
    idx = def ? entries.findIndex((e) => e === def || String(e.igUserId || '') === String(def.igUserId || '')) : -1;
  }
  if (idx < 0) {
    // No connection stored at all: this save creates the first one.
    const entry = { ...rest };
    if (enc) { entry.tokenEnc = enc.tokenEnc; entry.encrypted = enc.encrypted; }
    entries.push(entry);
    idx = entries.length - 1;
  } else {
    const entry = { ...entries[idx], ...rest };
    if (enc) { entry.tokenEnc = enc.tokenEnc; entry.encrypted = enc.encrypted; delete entry.token; }
    entries[idx] = entry;
  }
  let defId = (doc && doc.defaultIgUserId) || '';
  if (!entries.some((e) => String(e.igUserId || '') === String(defId))) defId = entries.length ? (entries[0].igUserId || '') : '';
  await persistInstagramRaw(userId, entries, defId);
}
// Add a connection, or refresh the existing one for the same Instagram
// account (a reconnect through the OAuth flow). The FIRST account a
// user connects becomes their default; later additions never steal
// the default. Returns the saved account, shaped like getInstagram().
async function saveInstagramAccount(userId, fields) {
  const doc = await loadInstagramRaw(userId);
  const entries = rawAccountsOf(doc).map((e) => ({ ...e }));
  const { token, ...rest } = fields || {};
  const enc = token !== undefined ? encryptToken(token) : null;
  const id = String(rest.igUserId || '');
  const wasEmpty = entries.length === 0;
  let idx = entries.findIndex((e) => String(e.igUserId || '') === id);
  if (idx < 0) { entries.push({ ...rest }); idx = entries.length - 1; }
  else entries[idx] = { ...entries[idx], ...rest };
  if (enc) { entries[idx].tokenEnc = enc.tokenEnc; entries[idx].encrypted = enc.encrypted; delete entries[idx].token; }
  let defId = (doc && doc.defaultIgUserId) || '';
  if (wasEmpty || !entries.some((e) => String(e.igUserId || '') === String(defId))) defId = id || (entries[0] ? entries[0].igUserId || '' : '');
  await persistInstagramRaw(userId, entries, defId);
  return shapeInstagramDoc(entries[idx]);
}
// Remove ONE account. Removing the default promotes the first
// remaining account (and re-mirrors the legacy fields); removing the
// last account deletes the doc (== fully disconnected). Other
// accounts are untouched.
async function removeInstagramAccount(userId, igUserId) {
  const doc = await loadInstagramRaw(userId);
  if (!doc) return { removed: false, accounts: [], defaultIgUserId: '' };
  const entries = rawAccountsOf(doc).map((e) => ({ ...e }));
  const next = entries.filter((e) => String(e.igUserId || '') !== String(igUserId || ''));
  if (next.length === entries.length) {
    const def = defaultRawAccount(doc);
    return { removed: false, accounts: entries.map((e) => shapeInstagramDoc(e)).filter(Boolean), defaultIgUserId: def ? (def.igUserId || '') : '' };
  }
  let defId = (doc && doc.defaultIgUserId) || '';
  if (!next.some((e) => String(e.igUserId || '') === String(defId))) defId = next.length ? (next[0].igUserId || '') : '';
  await persistInstagramRaw(userId, next, defId);
  return { removed: true, accounts: next.map((e) => shapeInstagramDoc(e)).filter(Boolean), defaultIgUserId: defId };
}
// Choose which connected account is the default. The legacy top-level
// mirror follows the new default (via persistInstagramRaw).
async function setDefaultInstagramAccount(userId, igUserId) {
  const doc = await loadInstagramRaw(userId);
  if (!doc) return false;
  const entries = rawAccountsOf(doc).map((e) => ({ ...e }));
  if (!entries.some((e) => String(e.igUserId || '') === String(igUserId || ''))) return false;
  await persistInstagramRaw(userId, entries, String(igUserId));
  return true;
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

// ---------- notifications (publish successes/failures, in-app) ----------
async function saveNotification(n) {
  await ensureMongo();
  const doc = { read: false, ...n };
  if (isMongo()) { await Notification.create(doc); return doc; }
  const list = jsonList('notifications'); list.push(doc); jsonSave('notifications', list); return doc;
}
async function listNotifications(userId, { limit = 50 } = {}) {
  await ensureMongo();
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  if (isMongo()) {
    const docs = await Notification.find({ userId }).sort({ createdAt: -1 }).limit(lim).lean();
    return stripAll(docs);
  }
  return jsonList('notifications')
    .filter((n) => n.userId === userId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, lim);
}
// ---------- admin audit log (batch 2) ----------
async function addAdminAudit(entry) {
  await ensureMongo();
  if (isMongo()) { await AdminAudit.create(entry); return entry; }
  const list = jsonList('adminAudit'); list.push(entry); jsonSave('adminAudit', list); return entry;
}
async function listAdminAudit({ limit = 100 } = {}) {
  await ensureMongo();
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  if (isMongo()) {
    const docs = await AdminAudit.find({}).sort({ at: -1 }).limit(lim).lean();
    return stripAll(docs);
  }
  return jsonList('adminAudit')
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
    .slice(0, lim);
}

// ---------- global app settings (batch 6, owner console) ----------
// One logical record (id 'global'): the safe global toggles the owner
// console may flip — whether new signups are open, and maintenance
// mode with its public message. Anything not stored falls back to
// these defaults, so a fresh install behaves exactly as before.
const GLOBAL_SETTINGS_DEFAULTS = { signupOpen: true, maintenance: false, maintenanceMessage: '' };
async function getGlobalSettings() {
  await ensureMongo();
  if (isMongo()) {
    const doc = await GlobalSettings.findOne({ id: 'global' }).lean();
    const clean = doc ? stripAll([doc])[0] : null;
    return { ...GLOBAL_SETTINGS_DEFAULTS, ...(clean || {}) };
  }
  const doc = jsonList('globalSettings').find((d) => d.id === 'global');
  return { ...GLOBAL_SETTINGS_DEFAULTS, ...(doc || {}) };
}
async function saveGlobalSettings(patch) {
  await ensureMongo();
  const next = { ...(await getGlobalSettings()), ...patch, id: 'global', updatedAt: new Date().toISOString() };
  if (isMongo()) {
    await GlobalSettings.findOneAndUpdate({ id: 'global' }, { $set: next }, { upsert: true });
    return next;
  }
  jsonUpsert('globalSettings', next, 'id');
  return next;
}

// ---------- team invites (batch 3, agency foundation) ----------
async function listTeamInvites(ownerId) {
  await ensureMongo();
  if (isMongo()) return stripAll(await TeamInvite.find({ ownerId }).lean());
  return jsonList('teamInvites').filter((t) => t.ownerId === ownerId);
}
async function listTeamInvitesByEmail(email) {
  await ensureMongo();
  const e = String(email || '').trim().toLowerCase();
  if (isMongo()) return stripAll(await TeamInvite.find({ email: e }).lean());
  return jsonList('teamInvites').filter((t) => t.email === e);
}
async function listMemberships(memberUserId) {
  await ensureMongo();
  if (isMongo()) return stripAll(await TeamInvite.find({ memberUserId }).lean());
  return jsonList('teamInvites').filter((t) => t.memberUserId === memberUserId);
}
async function saveTeamInvite(doc) {
  await ensureMongo();
  if (isMongo()) { await TeamInvite.create(doc); return doc; }
  const list = jsonList('teamInvites'); list.push(doc); jsonSave('teamInvites', list); return doc;
}
async function updateTeamInvite(id, patch) {
  await ensureMongo();
  if (isMongo()) { const d = await TeamInvite.findOneAndUpdate({ id }, patch, { new: true }).lean(); return d ? strip(d) : null; }
  const list = jsonList('teamInvites');
  const item = list.find((x) => x.id === id);
  if (!item) return null;
  Object.assign(item, patch); jsonSave('teamInvites', list); return item;
}

async function countUnreadNotifications(userId) {
  await ensureMongo();
  if (isMongo()) return Notification.countDocuments({ userId, read: { $ne: true } });
  return jsonList('notifications').filter((n) => n.userId === userId && !n.read).length;
}
async function markNotificationsRead(userId) {
  await ensureMongo();
  if (isMongo()) { await Notification.updateMany({ userId, read: { $ne: true } }, { $set: { read: true } }); return; }
  const list = jsonList('notifications');
  let changed = false;
  for (const n of list) if (n.userId === userId && !n.read) { n.read = true; changed = true; }
  if (changed) jsonSave('notifications', list);
}

// ---------- chunked upload sessions ----------
// JSON mode keeps chunk bytes as files (a 200 MB upload must never be
// rewritten into one JSON document per chunk); Mongo mode keeps one
// document per chunk. Session ids are server-generated, but the path
// builder still strips anything that is not a plain id character.
function uploadChunkDir(sessionId) {
  const safe = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(DATA, 'upload-chunks', safe);
}
function deleteUploadChunkFiles(sessionId) {
  try { fs.rmSync(uploadChunkDir(sessionId), { recursive: true, force: true }); } catch { /* dev-only store */ }
}
async function createUploadSession(doc) {
  await ensureMongo();
  if (isMongo()) { await UploadSession.create(doc); return doc; }
  const list = jsonList('uploadSessions'); list.push(doc); jsonSave('uploadSessions', list); return doc;
}
async function getUploadSession(userId, id) {
  await ensureMongo();
  if (!id) return null;
  if (isMongo()) { const s = await UploadSession.findOne({ id }).lean(); return s && s.userId === userId ? strip(s) : null; }
  return jsonList('uploadSessions').find((s) => s.id === id && s.userId === userId) || null;
}
async function saveUploadChunk(userId, sessionId, index, buffer) {
  await ensureMongo();
  if (isMongo()) {
    await UploadChunk.updateOne({ sessionId, index }, { $set: { sessionId, userId, index, data: buffer } }, { upsert: true });
    const received = await UploadChunk.countDocuments({ sessionId });
    await UploadSession.updateOne({ id: sessionId }, { $set: { received } });
    return received;
  }
  const dir = uploadChunkDir(sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${index}.bin`), buffer);
  const received = fs.readdirSync(dir).filter((f) => f.endsWith('.bin')).length;
  const list = jsonList('uploadSessions');
  const s = list.find((x) => x.id === sessionId);
  if (s) { s.received = received; jsonSave('uploadSessions', list); }
  return received;
}
async function getUploadChunks(sessionId, chunkCount) {
  await ensureMongo();
  const out = [];
  if (isMongo()) {
    const docs = await UploadChunk.find({ sessionId }).sort({ index: 1 }).lean();
    const byIndex = new Map(docs.map((d) => [d.index, d]));
    for (let i = 0; i < chunkCount; i++) {
      const d = byIndex.get(i);
      if (!d) return null;
      const raw = d.data;
      out.push(Buffer.isBuffer(raw) ? raw : (raw && raw.buffer ? Buffer.from(raw.buffer) : Buffer.from(raw || [])));
    }
    return out;
  }
  const dir = uploadChunkDir(sessionId);
  for (let i = 0; i < chunkCount; i++) {
    const p = path.join(dir, `${i}.bin`);
    if (!fs.existsSync(p)) return null;
    out.push(fs.readFileSync(p));
  }
  return out;
}
async function deleteUploadSession(sessionId) {
  await ensureMongo();
  if (!sessionId) return;
  if (isMongo()) {
    await UploadChunk.deleteMany({ sessionId });
    await UploadSession.deleteOne({ id: sessionId });
    return;
  }
  deleteUploadChunkFiles(sessionId);
  jsonSave('uploadSessions', jsonList('uploadSessions').filter((x) => x.id !== sessionId));
}
// Sweep sessions whose expiry has passed (abandoned uploads). Called
// opportunistically on init so no cron is needed.
async function deleteExpiredUploadSessions() {
  await ensureMongo();
  const nowIso = new Date().toISOString();
  if (isMongo()) {
    const expired = await UploadSession.find({ expiresAt: { $lte: nowIso } }).lean();
    for (const s of expired) await deleteUploadSession(s.id);
    return expired.length;
  }
  const expired = jsonList('uploadSessions').filter((s) => s.expiresAt && s.expiresAt <= nowIso);
  for (const s of expired) await deleteUploadSession(s.id);
  return expired.length;
}

// ---------- full-database export (owner backup) ----------
// Returns { <collectionName>: <docs> } for the WHOLE app database, for
// the owner backup export endpoint in server.js. Read-only by design:
// it never writes. Mongo mode: enumerate the live database's
// collections and dump every document raw through the native driver —
// full fidelity, including mediafiles Buffers (they JSON-serialise as
// {type:'Buffer',data:[...]} and can be restored from that). JSON mode
// (dev/tests): the same collection names over the JSON stores, so the
// export shape never depends on the backend.
const JSON_COLLECTION_NAMES = {
  users: 'users', sessions: 'sessions', posts: 'posts', media: 'media',
  mediaFiles: 'mediafiles', templates: 'templates', settings: 'settings',
  hashtagGroups: 'hashtaggroups', passwordResets: 'passwordresets',
  appCodes: 'appcodes',
  youtube: 'youtube', drafts: 'drafts', bios: 'bios', instagram: 'instagram',
  importJobs: 'importjobs', notifications: 'notifications',
  uploadSessions: 'uploadsessions', adminAudit: 'adminaudits',
  teamInvites: 'teaminvites', globalSettings: 'globalsettings',
};
async function exportDatabase() {
  if (await ensureMongo()) {
    const native = mongoose.connection.db;
    const cols = await native.listCollections({}, { nameOnly: true }).toArray();
    const out = {};
    for (const c of cols) {
      if (c.name.startsWith('system.')) continue;
      out[c.name] = await native.collection(c.name).find({}).toArray();
    }
    return out;
  }
  const out = {};
  for (const [fileKey, colName] of Object.entries(JSON_COLLECTION_NAMES)) {
    out[colName] = load(JSON_FILES[fileKey], []);
  }
  return out;
}

module.exports = {
  connect, ensureMongo, isMongo, getStatus, getLastError: () => lastError, exportDatabase,
  DB_NAME, load, save,
  encryptToken, decryptToken, isTokenEncryptionAvailable,
  listUsers, getUserByEmail, getUserById, saveUser, updateUser, deleteUserData, countUsers, ownerId,
  createSession, revokeSession, isSessionRevoked, listSessions,
  listPosts, getPost, savePost, savePostsBulk, updatePost, deletePost,
  listMedia, saveMedia, saveMediaBulk, updateMedia, deleteMedia,
  saveMediaFile, getMediaFile, deleteMediaFile,
  listTemplates, saveTemplate, deleteTemplate,
  listDrafts, saveDraft, deleteDraft,
  listHashtagGroups, saveHashtagGroup, deleteHashtagGroup,
  createPasswordReset, getPasswordResetByHash, listPasswordResetsForUser, deletePasswordResetsForUser,
  createAppCode, getAppCodeByHash, deleteAppCodeByHash, deleteAppCodesForUser,
  getYouTube, saveYouTube, deleteYouTube,
  getBio, getBioBySlug, saveBio,
  getUserByReferralCode, countReferrals,
  getSettings, saveSettings,
  getInstagram, listInstagram, saveInstagram, clearInstagram,
  getInstagramAccounts, getInstagramAccount, saveInstagramAccount, removeInstagramAccount, setDefaultInstagramAccount,
  getImportJob, saveImportJob,
  saveNotification, listNotifications, countUnreadNotifications, markNotificationsRead,
  createUploadSession, getUploadSession, saveUploadChunk, getUploadChunks, deleteUploadSession, deleteExpiredUploadSessions,
  addAdminAudit, listAdminAudit,
  getGlobalSettings, saveGlobalSettings,
  listTeamInvites, listTeamInvitesByEmail, listMemberships, saveTeamInvite, updateTeamInvite,
};
