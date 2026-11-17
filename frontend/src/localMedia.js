// localMedia.js — the on-device library for the KiluaAI app (v1.3).
//
// Design (auto-bridge, single flow — no user choices):
//   * Videos/photos the user picks live ONLY in app-private storage
//     (Capacitor Filesystem, Directory.Data / "device-library") with a
//     small JSON index (metadata + a captured poster frame). Importing
//     never uploads anything.
//   * Scheduling from a device item uploads ONE disposable bridge copy
//     to the server in the background (see autoBridge.js) and creates a
//     normal server post; the original on the phone is never touched by
//     scheduling or publishing, and the server deletes its copy after
//     the post publishes.
//   * If the upload cannot happen (offline), the schedule request waits
//     in a local pending list ("pending-schedules.json") and is retried
//     automatically when the app is open and back online.
//
// Inside the Android app this is real device storage. In a plain
// browser the Filesystem plugin falls back to browser storage
// (IndexedDB), but the UI hides the device library there entirely —
// it only exists inside the app.

import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { captureVideoPoster } from './api.js'

const LIB_DIR = 'device-library'
const INDEX_PATH = `${LIB_DIR}/index.json`
const PENDING_PATH = `${LIB_DIR}/pending-schedules.json`

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() } catch { return false }
}

async function ensureDir() {
  try {
    await Filesystem.mkdir({ path: LIB_DIR, directory: Directory.Data, recursive: true })
  } catch (e) {
    if (!/exist/i.test(String((e && e.message) || ''))) throw e
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Could not read file'))
    reader.onload = () => {
      const s = String(reader.result || '')
      resolve(s.slice(s.indexOf(',') + 1))
    }
    reader.readAsDataURL(file)
  })
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

async function readJson(path, fallback) {
  try {
    const res = await Filesystem.readFile({ path, directory: Directory.Data, encoding: Encoding.UTF8 })
    const parsed = JSON.parse(String(res.data || ''))
    return parsed == null ? fallback : parsed
  } catch { return fallback }
}

async function writeJson(path, value) {
  await ensureDir()
  await Filesystem.writeFile({ path, directory: Directory.Data, data: JSON.stringify(value), encoding: Encoding.UTF8 })
}

// Probe a picked file for dimensions/duration using an object URL —
// the same facts Studio's reel-safety check wants, captured once at
// import instead of being typed by hand.
function probeFile(file, isVideo) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const done = (meta) => { URL.revokeObjectURL(url); resolve(meta) }
    const timer = setTimeout(() => done({}), 3000)
    const finish = (meta) => { clearTimeout(timer); done(meta) }
    try {
      if (isVideo) {
        const v = document.createElement('video')
        v.preload = 'metadata'
        v.onloadedmetadata = () => finish({ width: v.videoWidth || 0, height: v.videoHeight || 0, duration: Math.round(v.duration || 0) })
        v.onerror = () => finish({})
        v.src = url
      } else {
        const img = new Image()
        img.onload = () => finish({ width: img.naturalWidth || 0, height: img.naturalHeight || 0 })
        img.onerror = () => finish({})
        img.src = url
      }
    } catch { finish({}) }
  })
}

function mimeFor(name, fallback) {
  if (fallback) return fallback
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  if (/\.webp$/i.test(name)) return 'image/webp'
  if (/\.mov$/i.test(name)) return 'video/quicktime'
  if (/\.webm$/i.test(name)) return 'video/webm'
  return 'video/mp4'
}

// ---------- device library ----------

/**
 * Import a picked file into the on-device library. Stores the original
 * bytes plus (for videos) a captured poster frame, and records the
 * metadata in the index. Nothing is uploaded. Returns the index entry.
 */
export async function importDeviceFile(file) {
  if (!file) throw new Error('No file given')
  await ensureDir()
  const kind = /^image\//.test(file.type || '') || /\.(png|jpe?g|gif|webp|avif)$/i.test(file.name || '') ? 'image' : 'video'
  const meta = await probeFile(file, kind === 'video')
  const id = `dev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safeName = String(file.name || (kind === 'image' ? 'photo.jpg' : 'video.mp4')).replace(/[^\w.\-]+/g, '_')
  const name = `${id}-${safeName}`
  const data = await fileToBase64(file)
  await Filesystem.writeFile({ path: `${LIB_DIR}/${name}`, data, directory: Directory.Data })
  let posterName = ''
  if (kind === 'video') {
    try {
      const posterDataUrl = await captureVideoPoster(file)
      if (posterDataUrl) {
        posterName = `${id}-poster.jpg`
        const b64 = String(posterDataUrl).slice(String(posterDataUrl).indexOf(',') + 1)
        await Filesystem.writeFile({ path: `${LIB_DIR}/${posterName}`, data: b64, directory: Directory.Data })
      }
    } catch { posterName = '' /* a poster is decoration — never fail an import over it */ }
  }
  const entry = {
    id, name,
    title: file.name || safeName,
    size: file.size || 0,
    mime: mimeFor(file.name || '', file.type || ''),
    kind,
    width: meta.width || 0, height: meta.height || 0, duration: meta.duration || 0,
    posterName,
    createdAt: new Date().toISOString(),
  }
  const index = await readJson(INDEX_PATH, [])
  index.unshift(entry)
  await writeJson(INDEX_PATH, index)
  return entry
}

async function displayUrl(storedName) {
  if (!storedName) return ''
  try {
    const { uri } = await Filesystem.getUri({ path: `${LIB_DIR}/${storedName}`, directory: Directory.Data })
    return Capacitor.convertFileSrc(uri)
  } catch { return '' }
}

/**
 * List the on-device library, newest first. Entries whose file has
 * disappeared from storage (deleted outside the app) are dropped from
 * the result and pruned from the index. Each entry gains display URLs:
 * `url` for the original and `posterUrl` for the poster frame (either
 * may be '' when the platform cannot serve them).
 */
export async function listDeviceLibrary() {
  await ensureDir()
  const index = await readJson(INDEX_PATH, [])
  const out = []
  let pruned = false
  for (const entry of Array.isArray(index) ? index : []) {
    try {
      await Filesystem.stat({ path: `${LIB_DIR}/${entry.name}`, directory: Directory.Data })
    } catch { pruned = true; continue }
    out.push({ ...entry, url: await displayUrl(entry.name), posterUrl: entry.posterName ? await displayUrl(entry.posterName) : '' })
  }
  if (pruned) await writeJson(INDEX_PATH, out.map(({ url, posterUrl, ...rest }) => rest))
  return out
}

/** Read a library original back as a File (for the bridge upload). */
export async function readDeviceFile(entry) {
  const read = await Filesystem.readFile({ path: `${LIB_DIR}/${entry.name}`, directory: Directory.Data })
  const bytes = typeof read.data === 'string' ? base64ToBytes(read.data) : new Uint8Array(await read.data.arrayBuffer())
  return new File([bytes], entry.title || entry.name, { type: entry.mime || mimeFor(entry.name, '') })
}

/** Delete a library item: original, poster and index entry. */
export async function deleteDeviceItem(id) {
  const index = await readJson(INDEX_PATH, [])
  const entry = (Array.isArray(index) ? index : []).find((x) => x.id === id)
  if (!entry) return
  try { await Filesystem.deleteFile({ path: `${LIB_DIR}/${entry.name}`, directory: Directory.Data }) } catch { /* already gone */ }
  if (entry.posterName) {
    try { await Filesystem.deleteFile({ path: `${LIB_DIR}/${entry.posterName}`, directory: Directory.Data }) } catch { /* already gone */ }
  }
  await writeJson(INDEX_PATH, index.filter((x) => x.id !== id))
}

// ---------- pending schedules (offline auto-bridge queue) ----------
// A schedule request that could not be completed (offline / upload
// failed) waits here with everything needed to finish it later:
// which device item, and the post fields the user chose. Statuses:
// 'waiting' (will retry automatically) and 'failed' (can never be
// completed — e.g. the video was deleted first; shown to the user
// until dismissed, never silently dropped).

export async function loadPendingSchedules() {
  const list = await readJson(PENDING_PATH, [])
  return Array.isArray(list) ? list : []
}

async function savePendingSchedules(list) {
  await writeJson(PENDING_PATH, list)
}

export async function addPendingSchedule(fields) {
  const entry = {
    id: `pend-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'waiting',
    attempts: 0,
    note: '',
    mediaUrl: '', // set once the bridge copy is uploaded, so a retry never uploads twice
    createdAt: new Date().toISOString(),
    ...fields,
  }
  const list = await loadPendingSchedules()
  list.unshift(entry)
  await savePendingSchedules(list)
  return entry
}

export async function updatePendingSchedule(id, patch) {
  const list = await loadPendingSchedules()
  const next = list.map((x) => (x.id === id ? { ...x, ...patch } : x))
  await savePendingSchedules(next)
  return next.find((x) => x.id === id) || null
}

export async function removePendingSchedule(id) {
  const list = await loadPendingSchedules()
  await savePendingSchedules(list.filter((x) => x.id !== id))
}
