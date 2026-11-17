// localMedia.js — on-device video storage for the Goyal Kumar app.
//
// Flow (implemented, web layer):
//   pick a video -> savePickedVideo() stores it in app-private storage
//   (Capacitor Filesystem, Directory.Data / "pending-uploads") ->
//   listPendingUploads() shows what is waiting on the device ->
//   uploadPendingUpload() sends it to the SAME backend endpoint the normal
//   upload uses (POST /api/media/upload, base64 JSON, session cookie) ->
//   on success the caller deletes the local copy with deletePendingUpload(),
//   so posted videos do not pile up on the phone.
//
// Inside the Android app this is real device storage. In a desktop/mobile
// browser the Filesystem plugin falls back to browser storage (IndexedDB),
// so the same flow works there too, within browser quotas.
//
// NOT implemented (needs a native step, see mobile/MOBILE.md): uploading
// while the app is fully closed. Uploads happen while the app is open.

import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'

const PENDING_DIR = 'pending-uploads'

export function isNativeApp() {
  try { return Capacitor.isNativePlatform() } catch { return false }
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

async function ensureDir() {
  try {
    await Filesystem.mkdir({ path: PENDING_DIR, directory: Directory.Data, recursive: true })
  } catch (e) {
    if (!/exist/i.test(String((e && e.message) || ''))) throw e
  }
}

/** Store a picked video file on the device. Returns { name, size, savedAt }. */
export async function savePickedVideo(file) {
  if (!file) throw new Error('No file given')
  await ensureDir()
  const safeName = `${Date.now()}-${String(file.name || 'video.mp4').replace(/[^\w.\-]+/g, '_')}`
  const data = await fileToBase64(file)
  await Filesystem.writeFile({ path: `${PENDING_DIR}/${safeName}`, data, directory: Directory.Data })
  return { name: safeName, size: file.size || 0, savedAt: new Date().toISOString() }
}

/** List videos stored on the device, newest first: [{ name, size }]. */
export async function listPendingUploads() {
  await ensureDir()
  const res = await Filesystem.readdir({ path: PENDING_DIR, directory: Directory.Data })
  const files = (res.files || []).map((f) => (typeof f === 'string' ? { name: f } : f))
  const out = []
  for (const f of files) {
    if (!f.name || f.type === 'directory') continue
    let size = f.size || 0
    if (!size) {
      try { const st = await Filesystem.stat({ path: `${PENDING_DIR}/${f.name}`, directory: Directory.Data }); size = st.size || 0 } catch { /* size stays 0 */ }
    }
    out.push({ name: f.name, size })
  }
  return out.sort((a, b) => b.name.localeCompare(a.name))
}

function mimeFor(name) {
  if (/\.png$/i.test(name)) return 'image/png'
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg'
  if (/\.webp$/i.test(name)) return 'image/webp'
  if (/\.mov$/i.test(name)) return 'video/quicktime'
  if (/\.webm$/i.test(name)) return 'video/webm'
  return 'video/mp4'
}

/**
 * Upload one stored video to the media library using the app's normal
 * upload contract (base64 JSON + session cookie). Returns the created
 * media object. Throws on HTTP errors like the rest of api.js.
 */
export async function uploadPendingUpload(name, { folder = 'Uploads', tags = [] } = {}) {
  const read = await Filesystem.readFile({ path: `${PENDING_DIR}/${name}`, directory: Directory.Data })
  const base64 = String(read.data || '')
  const displayName = name.replace(/^\d+-/, '')
  const res = await fetch('/api/media/upload', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: displayName, dataUrl: `data:${mimeFor(name)};base64,${base64}`, folder, tags })
  })
  let data = null
  try { data = await res.json() } catch { data = null }
  if (!res.ok) throw new Error((data && (data.error || data.message)) || `Upload failed (${res.status})`)
  return data.media || data
}

/** Remove a stored video from the device (call after a successful upload). */
export async function deletePendingUpload(name) {
  await Filesystem.deleteFile({ path: `${PENDING_DIR}/${name}`, directory: Directory.Data })
}
