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

async function req(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })
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

function asArray(data, key) {
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data[key])) return data[key]
  if (data && Array.isArray(data.items)) return data.items
  if (data && Array.isArray(data.data)) return data.data
  return []
}

export const api = {
  health: () => req('/api/health'),

  getStats: () => req('/api/stats'),

  getPosts: async () => asArray(await req('/api/posts'), 'posts'),
  createPost: (post) => req('/api/posts', { method: 'POST', body: JSON.stringify(post) }),
  updatePost: (id, patch) => req(`/api/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deletePost: (id) => req(`/api/posts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  publishPost: (id) => req(`/api/posts/${encodeURIComponent(id)}/publish`, { method: 'POST', body: JSON.stringify({}) }),

  getMedia: async () => asArray(await req('/api/media'), 'media'),
  createMedia: (media) => req('/api/media', { method: 'POST', body: JSON.stringify(media) }),
  uploadMedia: async (file, extra = {}) => {
    // Server accepts base64 JSON (no multipart parser on the server).
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result)
      r.onerror = () => reject(new Error('Could not read file'))
      r.readAsDataURL(file)
    })
    return req('/api/media/upload', { method: 'POST', body: JSON.stringify({ name: extra.title || file.name, dataUrl, folder: extra.folder || 'Uploads', tags: extra.tags || [] }) })
  },
  updateMedia: (id, patch) => req(`/api/media/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteMedia: (id) => req(`/api/media/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getTemplates: async () => asArray(await req('/api/templates'), 'templates'),
  createTemplate: (tpl) => req('/api/templates', { method: 'POST', body: JSON.stringify(tpl) }),

  getSettings: () => req('/api/settings'),
  saveSettings: (settings) => req('/api/settings', { method: 'POST', body: JSON.stringify(settings) })
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
