// autoBridge.js — scheduling from the on-device library (v1.3).
//
// The single flow, with no choices for the user to make:
//   1. The user picks a time + caption for a video that lives on their
//      phone. The request is written to the local pending list FIRST
//      (localMedia.js), so it survives the app being closed.
//   2. processPendingSchedules() — called when scheduling, when the app
//      opens/resumes, when the device comes back online, and on a slow
//      interval while the app is open — uploads ONE disposable bridge
//      copy through the normal chunked upload and creates the normal
//      server post pointing at that copy. The server then publishes on
//      time whether the phone is on or off, and deletes its copy after
//      publishing (the phone original is never touched).
//   3. Offline or upload failure: the request stays in the pending list
//      as "Waiting for network" and step 2 retries it automatically.
//      If the scheduled time has already passed by the time the copy
//      lands, the post is created for immediate publish and the outcome
//      is reported as 'posted-late' — it is never silently dropped.
//   4. If the device original was deleted before its copy could be
//      uploaded, the request is marked 'failed' with a plain-words
//      reason and stays visible in the device library until the user
//      dismisses it.

import { api } from './api.js'
import {
  listDeviceLibrary, readDeviceFile,
  loadPendingSchedules, addPendingSchedule, updatePendingSchedule, removePendingSchedule,
} from './localMedia.js'

/**
 * Schedule a post from a device-library item. Always resolves through
 * the pending list, so online and offline take the exact same path.
 * Returns { outcome, postId? } where outcome is one of:
 * 'scheduled' | 'posted-late' | 'waiting' | 'missing'.
 */
export async function scheduleFromDevice(item, fields) {
  const entry = await addPendingSchedule({
    deviceId: item.id,
    deviceName: item.name,
    title: item.title || item.name,
    mediaType: item.kind === 'image' ? 'image' : 'video',
    caption: fields.caption || '',
    hashtags: fields.hashtags || '',
    cta: fields.cta || '',
    format: fields.format || 'REELS',
    scheduleTime: fields.scheduleTime || '',
  })
  const res = await processPendingSchedules()
  const mine = (res.results || []).find((r) => r.id === entry.id)
  if (mine) return mine
  return { id: entry.id, outcome: 'waiting' }
}

let running = false

/**
 * Work through the pending list once. Safe to call often: a re-entrant
 * call while a pass is already running is a no-op, and each entry's
 * uploaded copy URL is checkpointed on the entry so a retry after a
 * failed post-create never uploads the same file twice.
 */
export async function processPendingSchedules() {
  if (running) return { ran: false, results: [] }
  running = true
  const results = []
  try {
    const pending = await loadPendingSchedules()
    const waiting = pending.filter((p) => p.status === 'waiting')
    if (!waiting.length) return { ran: true, results }
    let library = null
    for (const entry of waiting) {
      if (!entry.mediaUrl) {
        if (!library) library = await listDeviceLibrary()
        const item = library.find((i) => i.id === entry.deviceId || i.name === entry.deviceName)
        if (!item) {
          await updatePendingSchedule(entry.id, {
            status: 'failed',
            note: 'The video was deleted from this phone before it could be uploaded — this post was not created. Re-add the video and schedule it again.',
          })
          results.push({ id: entry.id, outcome: 'missing' })
          continue
        }
        try {
          const file = await readDeviceFile(item)
          const uploaded = await api.uploadMedia(file, { folder: 'Uploads', title: entry.title })
          const media = (uploaded && uploaded.media) || uploaded
          if (!media || !media.url) throw new Error('Upload did not return a media URL')
          await updatePendingSchedule(entry.id, { mediaUrl: media.url, posterUrl: media.posterUrl || '' })
          entry.mediaUrl = media.url
          entry.posterUrl = media.posterUrl || ''
        } catch (e) {
          await updatePendingSchedule(entry.id, {
            attempts: (entry.attempts || 0) + 1,
            note: 'Waiting for network — will upload automatically when you are back online.',
          })
          results.push({ id: entry.id, outcome: 'waiting', error: (e && e.message) || 'Upload failed' })
          continue
        }
      }
      try {
        const late = !entry.scheduleTime || new Date(entry.scheduleTime).getTime() <= Date.now()
        const post = await api.createPost({
          mediaUrl: entry.mediaUrl,
          mediaType: entry.mediaType || 'video',
          posterUrl: entry.posterUrl || '',
          caption: entry.caption || '',
          hashtags: entry.hashtags || '',
          cta: entry.cta || '',
          platform: 'Instagram',
          format: entry.format || 'REELS',
          scheduleTime: late ? new Date().toISOString() : entry.scheduleTime,
          status: 'scheduled',
        })
        await removePendingSchedule(entry.id)
        results.push({ id: entry.id, outcome: late ? 'posted-late' : 'scheduled', postId: (post && post.id) || '' })
      } catch (e) {
        await updatePendingSchedule(entry.id, {
          attempts: (entry.attempts || 0) + 1,
          note: 'Waiting for network — will finish automatically when you are back online.',
        })
        results.push({ id: entry.id, outcome: 'waiting', error: (e && e.message) || 'Could not create the post' })
      }
    }
    return { ran: true, results }
  } catch {
    return { ran: false, results }
  } finally {
    running = false
  }
}
