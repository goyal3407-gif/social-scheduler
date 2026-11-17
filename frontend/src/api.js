// API client for Social Scheduler.
// Base is relative so Vite's dev proxy (/api -> http://localhost:3000) and
// the production deployment (same-origin /api) both work with no config.
// Assumed response shapes (per the server contract):
//   GET  /api/posts     -> array of posts, or { posts: [...] }
//   GET  /api/media     -> array of media,  or { media: [...] }
//   GET  /api/templates -> array,            or { templates: [...] }
//   GET  /api/settings  -> object
//   GET  /api/stats     -> { scheduled, published, failed, drafts, mediaCount }
//   POST /api/posts/:id/publish -> { ok, liveUrl } | { ok: false, error }
// All list helpers normalise either shape so the UI never breaks on a
// wrapped response.

async function reqOnce(path, options = {}) {
  // 30 s timeout: a hung request used to hang the UI forever.
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 30000)
  let res
  try {
    res = await fetch(path, {
      credentials: 'include', // send the httpOnly session cookie
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: ctrl.signal,
      ...options
    })
  } catch (e) {
    clearTimeout(timer)
    if (e && e.name === 'AbortError') { const err = new Error('The server took too long to answer — please try again.'); err.status = 0; throw err }
    throw e
  } finally { clearTimeout(timer) }
  let data = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `Request failed (${res.status})`
    const err = new Error(msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function req(path, options = {}) {
  try {
    return await reqOnce(path, options)
  } catch (e) {
    // One automatic retry for safe (GET) requests that failed on a
    // timeout or a network error: on a slow mobile connection a single
    // stalled request used to surface as the "server took too long"
    // banner even though an immediate retry succeeds — so the banner
    // now only appears when the retry also fails. Non-GET requests are
    // never retried: they may already have taken effect server-side.
    const method = String(options.method || 'GET').toUpperCase()
    const transient = e && (e.status === 0 || e.name === 'TypeError')
    if (method !== 'GET' || !transient) throw e
    await new Promise((r) => setTimeout(r, 900))
    return reqOnce(path, options)
  }
}

/**
 * Capture a poster frame from a video File, entirely client-side:
 * an offscreen <video> seeks to ~1s (or 10% of the duration) and the
 * frame is drawn to a canvas and exported as a JPEG data URL (~480px
 * wide). Returns null on ANY failure (codec, timeout, tainted canvas)
 * — a poster is decoration and must never block or fail an upload.
 */
export async function captureVideoPoster(file) {
  try {
    if (!file || !(/^video\//.test(file.type || '') || /\.(mp4|mov|webm)$/i.test(file.name || ''))) return null
    const blob = await new Promise((resolve) => {
      const url = URL.createObjectURL(file)
      const video = document.createElement('video')
      let settled = false
      const done = (b) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { video.removeAttribute('src'); video.load() } catch { /* noop */ }
        URL.revokeObjectURL(url)
        resolve(b || null)
      }
      const timer = setTimeout(() => done(null), 8000)
      const draw = () => {
        try {
          const w = video.videoWidth || 0
          const h = video.videoHeight || 0
          if (!w || !h) { done(null); return }
          const canvas = document.createElement('canvas')
          canvas.width = 480
          canvas.height = Math.max(2, Math.round(480 * h / w))
          const ctx = canvas.getContext('2d')
          if (!ctx) { done(null); return }
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          if (canvas.toBlob) canvas.toBlob((b) => done(b), 'image/jpeg', 0.82)
          else done(null)
        } catch { done(null) }
      }
      video.muted = true
      video.playsInline = true
      video.preload = 'auto'
      video.addEventListener('loadedmetadata', () => {
        const d = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
        let t = d ? Math.min(1, d * 0.1) : 1
        if (d && t >= d) t = d / 2
        try { video.currentTime = t } catch { draw() }
      })
      video.addEventListener('seeked', draw)
      video.addEventListener('error', () => done(null))
      video.src = url
    })
    if (!blob) return null
    return await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error('Could not read poster'))
      r.readAsDataURL(blob)
    }).catch(() => null)
  } catch { return null }
}

function asArray(data, key) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[key])) return data[key]
  if (data && Array.isArray(data.items)) return data.items
  if (data && Array.isArray(data.data)) return data.data
  return []
}

export const api = {
  health: () => req('/api/health'),
  dbStatus: () => req('/api/db-status'),

  // Auth (session cookie is httpOnly; the frontend never sees a token)
  signup: (email, password) => req('/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password }) }),
  login: (email, password) => req('/api/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  me: () => req('/api/auth/me'),
  logout: () => req('/api/auth/logout', { method: 'POST', body: JSON.stringify({}) }),
  changePassword: (currentPassword, newPassword) => req('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  deleteAccount: () => req('/api/auth/account', { method: 'DELETE' }),
  exportData: () => req('/api/export'),

  getStats: () => req('/api/stats'),

  getPosts: async () => asArray(await req('/api/posts?limit=500'), 'posts'),
  // Single-object endpoints return the object itself (not the {ok, post}
  // wrapper) so callers can use it directly — returning the wrapper used
  // to insert a broken post with no id into the queue until a reload.
  createPost: async (post) => (await req('/api/posts', { method: 'POST', body: JSON.stringify(post) })).post,
  createPostsBulk: (posts) => req('/api/posts/bulk', { method: 'POST', body: JSON.stringify({ posts }) }),
  updatePost: async (id, patch) => (await req(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).post,
  deletePost: (id) => req(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  duplicatePost: async (id) => (await req(`/api/posts/${encodeURIComponent(id)}/duplicate`, { method: 'POST', body: JSON.stringify({}) })).post,
  reschedulePost: async (id, patch) => (await req(`/api/posts/${encodeURIComponent(id)}/reschedule`, { method: 'POST', body: JSON.stringify(patch) })).post,
  getNextBestTime: () => req('/api/next-best-time'),
  publishPost: (id) => req(`/api/posts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({}) }),
  publishDue: () => req('/api/publish-due', { method: 'POST', body: JSON.stringify({}) }),

  getMedia: async () => asArray(await req('/api/media?limit=500'), 'media'),
  createMedia: async (media) => (await req('/api/media', { method: 'POST', body: JSON.stringify(media) })).media,
  // Upload a file to the Media Library. Small files go in one request;
  // bigger ones are split into 3 MB pieces (init → chunk(s) →
  // complete) because a single request is capped at ~4.5 MB on the
  // host — a 14 MB Reel used to fail outright. onProgress(frac) is
  // called with 0..1 as the upload advances. The server enforces a
  // 200 MB per-file cap and returns the same /media/<id> item either
  // way, so callers cannot tell the two paths apart.
  uploadMedia: async (file, extra = {}, onProgress) => {
    const readAsDataUrl = (blob) => new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error('Could not read file'))
      r.readAsDataURL(blob)
    })
    const name = extra.title || file.name
    const meta = { folder: extra.folder || 'Uploads', tags: extra.tags || [], width: extra.width || 0, height: extra.height || 0, duration: extra.duration || 0 }
    // Poster frame for videos, captured from the file itself before the
    // upload starts; the server stores it in the media-file store and
    // sets posterUrl on the item. Null (capture failed) just means the
    // item has no poster — display falls back to the video's first frame.
    const posterDataUrl = await captureVideoPoster(file).catch(() => null)
    if (posterDataUrl) meta.posterDataUrl = posterDataUrl
    const CHUNK = 3 * 1024 * 1024
    if (file.size <= CHUNK) {
      const dataUrl = await readAsDataUrl(file)
      const d = await req('/api/media/upload', { method: 'POST', body: JSON.stringify({ name, dataUrl, ...meta }) })
      if (onProgress) onProgress(1)
      return d.media || d
    }
    const init = await req('/api/media/upload/init', { method: 'POST', body: JSON.stringify({ name, size: file.size, contentType: file.type || '', ...meta }) })
    const uploadId = init.uploadId
    const chunkSize = init.chunkSize || CHUNK
    const chunkCount = init.chunkCount || Math.ceil(file.size / chunkSize)
    try {
      for (let i = 0; i < chunkCount; i++) {
        const blob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize))
        const dataUrl = await readAsDataUrl(blob)
        await req('/api/media/upload/chunk', { method: 'POST', body: JSON.stringify({ uploadId, index: i, dataUrl }) })
        if (onProgress) onProgress((i + 1) / chunkCount)
      }
      const d = await req('/api/media/upload/complete', { method: 'POST', body: JSON.stringify({ uploadId }) })
      return d.media || d
    } catch (e) {
      // Tell the server to drop the partial upload so no orphan pieces
      // or library items are left behind.
      try { await req(`/api/media/upload/${encodeURIComponent(uploadId)}`, { method: 'DELETE' }) } catch { /* best effort */ }
      throw e
    }
  },
  getNotifications: () => req('/api/notifications'),
  markNotificationsRead: () => req('/api/notifications/read', { method: 'POST', body: JSON.stringify({}) }),
  updateMedia: async (id, patch) => (await req(`/api/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })).media,
  deleteMedia: (id) => req(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getTemplates: async () => asArray(await req('/api/templates'), 'templates'),
  createTemplate: async (tpl) => (await req('/api/templates', { method: 'POST', body: JSON.stringify(tpl) })).template,

  getSettings: () => req('/api/settings'),
  saveSettings: (settings) => req('/api/settings', { method: 'POST', body: JSON.stringify(settings) }),
  instagramConnectLink: () => req('/api/instagram/connect-link', { method: 'POST', body: JSON.stringify({}) }),
  instagramIgConnectLink: () => req('/api/instagram/ig-connect-link', { method: 'POST', body: JSON.stringify({}) }),
  disconnectInstagram: (igUserId) => req('/api/instagram/disconnect', { method: 'POST', body: JSON.stringify(igUserId ? { igUserId } : {}) }),
  setDefaultInstagramAccount: (igUserId) => req('/api/instagram/default', { method: 'POST', body: JSON.stringify({ igUserId }) }),
  startInstagramImport: () => req('/api/instagram/import', { method: 'POST', body: JSON.stringify({}) }),
  getInstagramImport: (jobId) => req(`/api/instagram/import/${encodeURIComponent(jobId)}`)
}

/**
 * Start a "Connect Instagram" login. Asks the server (with the
 * session) for a signed one-time connect link, then opens it: in the
 * Android app in the system browser (window.open '_system'), which is
 * where the login dialog belongs — the browser has no session cookie,
 * and the signed link is what authorises it — and in a normal browser
 * by navigating this tab. If the link request itself fails, falls back
 * to the plain session-based connect URL.
 */
async function openConnect(linkRequest, fallbackUrl) {
  let url = fallbackUrl
  try {
    const res = await linkRequest()
    if (res && res.url) url = res.url
  } catch { /* keep the fallback URL */ }
  let native = false
  try {
    const { Capacitor } = await import('@capacitor/core')
    native = !!Capacitor.isNativePlatform()
  } catch { native = false }
  if (native) window.open(url, '_system')
  else window.location.href = url
}

/** Direct Instagram Login (Meta's "Instagram API with Instagram
 *  Login") — the primary connect flow: Instagram's own login page, no
 *  Facebook account or Page needed. */
export async function openInstagramDirectConnect() {
  return openConnect(() => api.instagramIgConnectLink(), '/api/instagram/ig-connect')
}

/** Facebook Login for Business — the secondary connect flow, for
 *  accounts whose Instagram is linked to a Facebook Page. */
export async function openInstagramConnect() {
  return openConnect(() => api.instagramConnectLink(), '/api/instagram/connect')
}

/**
 * Next free 7:00 PM slot (browser local time), computed from the user's own
 * saved posts only: the first day in the next 14 days with no scheduled or
 * draft post at 7pm. Returns an ISO string, or null if none is free.
 * This is a suggestion from the user's own schedule — not audience data.
 */
export function nextBestTime(posts) {
  const taken = new Set()
  for (const p of posts || []) {
    if (!p.scheduleTime || (p.status !== 'scheduled' && p.status !== 'draft')) continue
    const d = new Date(p.scheduleTime)
    if (Number.isNaN(d.getTime())) continue
    taken.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}-${d.getHours()}`)
  }
  const now = new Date()
  for (let day = 0; day < 14; day++) {
    const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate() + day, 19, 0, 0, 0)
    if (cand.getTime() <= now.getTime()) continue
    if (!taken.has(`${cand.getFullYear()}-${cand.getMonth()}-${cand.getDate()}-19`)) return cand.toISOString()
  }
  return null
}

/** Daily plan: for each of the next `days` days (from today), the count of
 * scheduled posts that day, from real saved posts only. */
export function dailyPlan(posts, days = 8) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const out = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000)
    const key = d.toDateString()
    const count = (posts || []).filter((p) => {
      if (!p.scheduleTime || p.status !== 'scheduled') return false
      const pd = new Date(p.scheduleTime)
      return !Number.isNaN(pd.getTime()) && pd.toDateString() === key
    }).length
    out.push({ date: d, label: i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), count })
  }
  return out
}

export function formatCountdown(targetIso) {
  if (!targetIso) return null
  const diff = new Date(targetIso).getTime() - Date.now()
  if (Number.isNaN(diff)) return null
  if (diff <= 0) return 'due now'
  const m = Math.floor(diff / 60000)
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const min = m % 60
  if (d > 0) return `${d}d ${h}h ${min}m`
  if (h > 0) return `${h}h ${min}m`
  return `${min}m`
}

export function fmtDateTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export function toLocalInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromLocalInputValue(v) {
  if (!v) return ''
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString()
}

/** Count hashtags in a string like "#a #b" or "a, b". */
export function countHashtags(text) {
  if (!text) return 0
  return text.split(/[\s,]+/).filter((t) => t.replace(/^#/, '').trim().length > 0).length
}

/** Caption score 0-100: length, hook, CTA, hashtags, question. */
export function captionScore(caption, hashtags, cta) {
  let s = 0
  const len = (caption || '').trim().length
  if (len >= 40) s += 25
  else if (len >= 15) s += 15
  else if (len > 0) s += 5
  if (/[?!]/.test((caption || '').slice(0, 80))) s += 15
  if (/\?/.test(caption || '')) s += 10
  if (cta && cta.trim()) s += 20
  const n = countHashtags(hashtags)
  if (n >= 3 && n <= 30) s += 20
  else if (n > 0) s += 8
  if (/(link|comment|follow|save|share|dm|tap)/i.test(`${caption || ''} ${cta || ''}`)) s += 10
  return Math.min(100, s)
}

/**
 * Parse CSV text with columns Media,Caption,Hashtags,CTA,Platform,Schedule Time.
 * Handles quoted fields, embedded commas and newlines. Header row is matched
 * case-insensitively; unknown/missing columns yield empty strings.
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let cur = ''
  let inQuotes = false
  const src = String(text || '').replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cur += '"'; i++ } else { inQuotes = false }
      } else { cur += ch }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(cur); cur = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(cur); cur = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else {
      cur += ch
    }
  }
  if (cur !== '' || row.length) { row.push(cur); if (row.some((c) => c.trim() !== '')) rows.push(row) }
  if (!rows.length) return []
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z]/g, '')
  const header = rows[0].map(norm)
  const find = (...names) => {
    for (const n of names) {
      const i = header.indexOf(norm(n))
      if (i >= 0) return i
    }
    return -1
  }
  const idx = {
    media: find('media', 'mediaurl', 'url', 'video', 'link'),
    caption: find('caption', 'text', 'description'),
    hashtags: find('hashtags', 'hashtag', 'tags'),
    cta: find('cta', 'calltoaction'),
    platform: find('platform', 'channel'),
    scheduleTime: find('scheduletime', 'schedule', 'time', 'datetime', 'publishat')
  }
  return rows.slice(1).map((r) => {
    const get = (i) => (i >= 0 && r[i] != null ? String(r[i]).trim() : '')
    return {
      mediaUrl: get(idx.media),
      caption: get(idx.caption),
      hashtags: get(idx.hashtags),
      cta: get(idx.cta),
      platform: get(idx.platform) || 'Instagram',
      scheduleTime: get(idx.scheduleTime),
      mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(get(idx.media)) ? 'image' : 'video',
      format: 'REELS',
      status: 'scheduled'
    }
  }).filter((r) => r.mediaUrl || r.caption)
}
