import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { fmtDate, fromLocalInputValue } from '../api.js'
import { Skeleton, Empty, ErrorBox, MediaVisual } from './shared.jsx'
import { IconHeart, IconTrash, IconSearch } from './icons.jsx'
import { isNativeApp, importDeviceFile, listDeviceLibrary, readDeviceFile, deleteDeviceItem, loadPendingSchedules, removePendingSchedule } from '../localMedia.js'
import { scheduleFromDevice } from '../autoBridge.js'

const PAGE_SIZE = 24

// Probe a file or URL for its real dimensions/duration (stored with the
// media item so Studio's reel-safety check never needs hand-typed sizes).
function probeUrl(url, isVideo) {
  return new Promise((resolve) => {
    const done = (meta) => resolve(meta)
    const timer = setTimeout(() => done({}), 2500)
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

function fmtSize(bytes) {
  if (!bytes) return '—'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// The on-device library (app only — this section renders solely inside
// the Android app; in a plain browser there is no device library and the
// section is hidden, while the web Upload / Add-by-link / library above
// work exactly as always). Importing stores the original on the phone
// and uploads NOTHING. Scheduling uploads one disposable copy in the
// background (autoBridge.js); the original stays on the phone. Offline
// schedule requests wait in the pending list below with a visible
// status and finish themselves when the app is back online.
function DeviceLibrary({ onUploaded, onUpload }) {
  const [items, setItems] = useState([])
  const [pending, setPending] = useState([])
  const [importing, setImporting] = useState(false)
  const [busyId, setBusyId] = useState('')
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [schedId, setSchedId] = useState('')
  const [caption, setCaption] = useState('')
  const [hashtags, setHashtags] = useState('')
  const [format, setFormat] = useState('REELS')
  const [when, setWhen] = useState('')
  const devFileRef = useRef(null)

  const refresh = useCallback(async () => {
    try { setItems(await listDeviceLibrary()) } catch { setItems([]) }
    try { setPending(await loadPendingSchedules()) } catch { setPending([]) }
  }, [])
  useEffect(() => { refresh() }, [refresh])
  // The app-level auto-bridge runner can change a waiting entry's
  // status in the background (scheduled / posted late / failed because
  // the file was deleted). Poll the local state while this section is
  // mounted so those status changes appear without a remount.
  useEffect(() => {
    const t = setInterval(() => { refresh() }, 15000)
    return () => clearInterval(t)
  }, [refresh])

  const pick = async (files) => {
    const list = [...(files || [])]
    if (!list.length) return
    setErr(''); setMsg(''); setImporting(true)
    let ok = 0
    for (const f of list) {
      if (f.size > 200 * 1024 * 1024) { setErr(`"${f.name}" is over the 200 MB per-file limit and was skipped.`); continue }
      try { await importDeviceFile(f); ok++ } catch (e) { setErr(e.message || 'Could not save that file on this device.') }
    }
    setImporting(false)
    if (ok) setMsg(`Saved ${ok} file${ok === 1 ? '' : 's'} on this phone — nothing was uploaded.`)
    refresh()
  }

  const uploadCopy = async (item) => {
    setErr(''); setMsg(''); setBusyId(item.id)
    try {
      const file = await readDeviceFile(item)
      await onUpload(file, { folder: 'Uploads', title: item.title })
      setMsg('Copy uploaded to your library — the original stays on this phone.')
    } catch (e) { setErr(e.message || 'Upload failed — the original is still on this phone.') }
    setBusyId('')
  }

  const remove = async (item) => {
    setErr(''); setMsg('')
    try { await deleteDeviceItem(item.id); await refresh() } catch (e) { setErr(e.message || 'Could not remove that file.') }
  }

  const schedule = async (item) => {
    if (!when) { setErr('Pick a date and time for the post first.'); return }
    setErr(''); setMsg(''); setBusyId(item.id)
    try {
      const res = await scheduleFromDevice(item, { caption, hashtags, format, scheduleTime: fromLocalInputValue(when) })
      if (res.outcome === 'scheduled') setMsg('Scheduled ✓ — find it in your Queue. One copy is on the server; your original stays on this phone.')
      else if (res.outcome === 'posted-late') setMsg('That time had already passed, so the post was created to publish right away — find it in your Queue.')
      else if (res.outcome === 'missing') setErr('That file is no longer on this phone, so the post could not be created.')
      else setMsg('Waiting for network — it will upload and schedule itself automatically when you are back online. You can close the app.')
      setSchedId(''); setCaption(''); setHashtags(''); setWhen('')
      await refresh()
      if (onUploaded) onUploaded()
    } catch (e) { setErr(e.message || 'Could not schedule that post.') }
    setBusyId('')
  }

  const dismiss = async (p) => {
    try { await removePendingSchedule(p.id); await refresh() } catch { /* list refreshes next open */ }
  }

  return (
    <div className="card mt2">
      <div className="card-head">
        <div>
          <h2>On this phone</h2>
          <p>Videos and photos stored inside the app on your phone. Importing uploads nothing — scheduling sends one copy to the server in the background, and your original always stays here.</p>
        </div>
        <span className="pill">{items.length} on device</span>
      </div>
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
      <div className="drop" onClick={() => devFileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') devFileRef.current?.click() }}>
        <b>{importing ? 'Saving…' : 'Add videos or photos to this phone'}</b>
        <p className="small">Stored in the app only — no cloud storage used until you schedule a post.</p>
        <input ref={devFileRef} type="file" multiple accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => { pick(e.target.files); e.target.value = '' }} />
      </div>
      {items.length > 0 && (
        <div className="mt">
          {items.map((item) => (
            <div key={item.id}>
              <div className="device-row">
                {item.posterUrl
                  ? <img src={item.posterUrl} alt="" style={{ width: 44, height: 58, objectFit: 'cover', borderRadius: 8, flex: 'none' }} />
                  : item.kind === 'image' && item.url
                    ? <img src={item.url} alt="" style={{ width: 44, height: 58, objectFit: 'cover', borderRadius: 8, flex: 'none' }} />
                    : <div style={{ width: 44, height: 58, borderRadius: 8, flex: 'none', background: 'var(--surface-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }} aria-hidden="true">{item.kind === 'image' ? '🖼' : '🎬'}</div>}
                <div style={{ minWidth: 0, flex: 1 }}>
                  <b title={item.title}>{item.title}</b>
                  <span className="muted small">{fmtSize(item.size)} · {item.kind}{item.width && item.height ? ` · ${item.width}×${item.height}` : ''} · on this phone</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 'none', flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary small" disabled={busyId === item.id} onClick={() => { setSchedId(schedId === item.id ? '' : item.id); setErr(''); setMsg('') }}>Schedule</button>
                  <button type="button" className="btn ghost small" disabled={busyId === item.id} onClick={() => uploadCopy(item)}>{busyId === item.id ? 'Working…' : 'Upload copy'}</button>
                  <button type="button" className="btn danger small" disabled={busyId === item.id} onClick={() => remove(item)}>Remove</button>
                </div>
              </div>
              {schedId === item.id && (
                <div style={{ border: '1px solid var(--line-2)', borderRadius: 10, padding: 12, margin: '4px 0 10px', background: 'var(--surface-2)' }}>
                  <label htmlFor={`devCap-${item.id}`}>Caption</label>
                  <textarea id={`devCap-${item.id}`} rows={3} placeholder="Write your caption…" value={caption} onChange={(e) => setCaption(e.target.value)} />
                  <label htmlFor={`devTags-${item.id}`} style={{ marginTop: 10 }}>Hashtags <span className="muted">(space or comma separated)</span></label>
                  <input id={`devTags-${item.id}`} placeholder="#reels #daily" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
                  <div className="two-col" style={{ marginTop: 10 }}>
                    <div>
                      <label htmlFor={`devFmt-${item.id}`}>Format</label>
                      <select id={`devFmt-${item.id}`} value={format} onChange={(e) => setFormat(e.target.value)}>
                        <option value="REELS">REELS</option>
                        <option value="FEED">FEED</option>
                        <option value="STORY">STORY</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`devWhen-${item.id}`}>Schedule time</label>
                      <input id={`devWhen-${item.id}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                    </div>
                  </div>
                  <p className="muted small" style={{ marginTop: 10 }}>Scheduling uploads one copy to the server in the background — your original stays on this phone, and the server copy is deleted after the post publishes. If you are offline, the request waits below and finishes itself when you are back online.</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn primary small" disabled={busyId === item.id} onClick={() => schedule(item)}>{busyId === item.id ? 'Working…' : 'Schedule post'}</button>
                    <button type="button" className="btn ghost small" onClick={() => setSchedId('')}>Cancel</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="mt">
          <h3 style={{ margin: '6px 0 4px' }}>Waiting to finish</h3>
          {pending.map((p) => (
            <div key={p.id} className="device-row">
              <div style={{ minWidth: 0 }}>
                <b title={p.title}>{p.title}</b>
                <span className="muted small">{p.scheduleTime ? `For ${new Date(p.scheduleTime).toLocaleString()}` : 'No time set'} · {p.status === 'failed' ? 'Not created' : 'Waiting for network'}</span>
                {p.note && <span className="small" style={{ display: 'block', color: p.status === 'failed' ? 'var(--red)' : 'var(--muted)' }}>{p.note}</span>}
              </div>
              {p.status === 'failed' && <button type="button" className="btn ghost small" style={{ flex: 'none' }} onClick={() => dismiss(p)}>Dismiss</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function MediaLibrary({ media, loading, error, onRetry, onAddLink, onUpload, onToggleFav, onDelete, onUse, searchSeed, searchNonce }) {
  const [q, setQ] = useState('')
  // D3: global search seed from the top nav / drawer.
  useEffect(() => {
    if (searchNonce) setQ(searchSeed || '')
  }, [searchNonce]) // eslint-disable-line react-hooks/exhaustive-deps
  const [folder, setFolder] = useState('all')
  const [onlyFav, setOnlyFav] = useState(false)
  const [url, setUrl] = useState('')
  const [title, setTitle] = useState('')
  const [tags, setTags] = useState('')
  const [newFolder, setNewFolder] = useState('')
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [progress, setProgress] = useState(null) // { name, frac } for the file currently uploading
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const fileRef = useRef(null)

  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [q, folder, onlyFav])

  const folders = useMemo(() => {
    const set = new Set((media || []).map((m) => m.folder).filter(Boolean))
    return ['all', ...[...set].sort()]
  }, [media])

  const filtered = useMemo(() => {
    let list = [...(media || [])].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    if (folder !== 'all') list = list.filter((m) => m.folder === folder)
    if (onlyFav) list = list.filter((m) => m.favorite)
    if (q.trim()) {
      const n = q.toLowerCase()
      list = list.filter((m) => `${m.title || ''} ${m.url || ''} ${(m.tags || []).join(' ')} ${m.folder || ''}`.toLowerCase().includes(n))
    }
    return list
  }, [media, folder, onlyFav, q])

  const handleFiles = async (files) => {
    setErr(''); setMsg('')
    const list = [...(files || [])]
    if (!list.length) return
    setBusy(true)
    let ok = 0
    for (const f of list) {
      // Big files upload in pieces (chunked upload in api.js) — the
      // only hard stop now is the 200 MB per-file cap.
      if (f.size > 200 * 1024 * 1024) { setErr(`"${f.name}" is over the 200 MB per-file limit and was skipped.`); continue }
      try {
        const isVideo = /^video\//.test(f.type) || /\.(mp4|mov|webm)$/i.test(f.name)
        const meta = await probeUrl(URL.createObjectURL(f), isVideo)
        setProgress({ name: f.name, frac: 0 })
        await onUpload(f, { folder: newFolder || undefined, ...meta }, (frac) => setProgress({ name: f.name, frac }))
        ok++
      } catch (e) { setErr(e.message || 'Upload failed.') }
      setProgress(null)
    }
    setBusy(false)
    if (ok) setMsg(`Uploaded ${ok} file${ok === 1 ? '' : 's'}.`)
  }

  const addLink = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (!url.trim()) { setErr('Paste a media URL first.'); return }
    setBusy(true)
    try {
      const isVideo = !/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url.trim())
      const meta = await probeUrl(url.trim(), isVideo)
      await onAddLink({ url: url.trim(), title: title.trim() || url.trim(), folder: newFolder || undefined, tags: tags.split(',').map((t) => t.trim()).filter(Boolean), ...meta })
      setMsg('Link added to your library.')
      setUrl(''); setTitle(''); setTags('')
    } catch (e2) { setErr(e2.message || 'Could not add link.') }
    setBusy(false)
  }

  return (
    <div>
      <h2 className="section-title">Media Library</h2>
      <p className="section-sub">Upload videos and images (up to 200 MB per file — big files upload in pieces automatically) or save links. Organise with folders, tags and favourites.</p>

      {error && <ErrorBox error={error} onRetry={onRetry} />}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="two-col" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>Upload</h2>
          <p className="muted small mb">Drag files here, or choose from your device.</p>
          <div
            className={`drop ${drag ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files) }}
            onClick={() => fileRef.current?.click()}
            role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click() }}
          >
            <b>{busy ? 'Uploading…' : 'Drop files here, or click to browse'}</b>
            <p className="small">MP4, MOV, JPG, PNG, WebP — up to 200 MB per file (big files upload in pieces)</p>
            <input ref={fileRef} type="file" multiple accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
          </div>
          {progress && (
            <div className="mt">
              <div className="small muted" style={{ marginBottom: 4 }}>Uploading {progress.name} — {Math.round(progress.frac * 100)}%</div>
              <div className="pbar"><span style={{ width: `${Math.round(progress.frac * 100)}%` }} /></div>
            </div>
          )}
          <label htmlFor="upFolder" style={{ marginTop: 14 }}>Folder for uploads</label>
          <input id="upFolder" placeholder="e.g. Reels, Tutorials, B-roll" value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
        </div>

        <form className="card" onSubmit={addLink}>
          <h2>Add by link</h2>
          <p className="muted small mb">Save a direct media URL without uploading the file.</p>
          <label htmlFor="linkUrl">Media URL</label>
          <input id="linkUrl" type="url" placeholder="https://…/video.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label htmlFor="linkTitle" style={{ marginTop: 12 }}>Title</label>
          <input id="linkTitle" placeholder="e.g. Street interview — part 1" value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="linkTags" style={{ marginTop: 12 }}>Tags <span className="muted">(comma separated)</span></label>
          <input id="linkTags" placeholder="reels, tutorial" value={tags} onChange={(e) => setTags(e.target.value)} />
          <button type="submit" className="btn primary mt" disabled={busy}>{busy ? 'Adding…' : 'Add to library'}</button>
        </form>
      </div>

      {isNativeApp() ? <DeviceLibrary onUploaded={onRetry} onUpload={onUpload} /> : null}

      <div className="toolbar mt2">
        <div style={{ position: 'relative', flex: 2, minWidth: 180 }}>
          <input type="search" placeholder="Search title, tag, folder…" value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} aria-label="Search media" />
          <span style={{ position: 'absolute', left: 11, top: 11, color: 'var(--muted)' }}><IconSearch size={16} /></span>
        </div>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Filter by folder">
          {folders.map((f) => <option key={f} value={f}>{f === 'all' ? 'All folders' : f}</option>)}
        </select>
        <button type="button" className={`tab ${onlyFav ? 'active' : ''}`} onClick={() => setOnlyFav(!onlyFav)} aria-pressed={onlyFav}>♥ Favourites only</button>
        <span className="pill">{filtered.length} file{filtered.length === 1 ? '' : 's'}</span>
      </div>

      {loading ? <Skeleton variant="media" rows={3} /> : filtered.length === 0 ? (
        <div className="card"><Empty title="Library is empty" body={q || folder !== 'all' || onlyFav ? 'Nothing matches those filters — try clearing them.' : 'Upload your first video or image, or add one by link, and it will live here ready for Studio.'} action={q || folder !== 'all' || onlyFav ? undefined : <button type="button" className="btn primary small" onClick={() => fileRef.current?.click()}>Upload media</button>} /></div>
      ) : (
        <div>
          <div className="media-grid">
            {filtered.slice(0, visibleCount).map((m) => (
              <article key={m.id} className="media-card">
                {m.serverCopyRemoved ? (
                  <div className="media-removed"><b>Published ✓</b><span>Server copy removed to save space — the post is live on Instagram. Upload the file again to reuse it.</span></div>
                ) : <MediaVisual url={m.url} kind={m.kind} posterUrl={m.posterUrl} />}
                <div className="mc-body">
                  <b title={m.title || m.url}>{m.title || 'Untitled'}</b>
                  <span className="muted small">{m.folder || 'Unsorted'} · {fmtDate(m.createdAt)}{m.usedCount ? ` · Used ${m.usedCount}×` : ''}{m.width && m.height ? ` · ${m.width}×${m.height}` : ''}</span>
                  {(m.tags || []).length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>{m.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
                  <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                    {!m.serverCopyRemoved && <button type="button" className="btn primary small" onClick={() => onUse(m)}>Use in Studio</button>}
                    <button type="button" className="btn ghost small" aria-label={m.favorite ? 'Remove favourite' : 'Mark favourite'} onClick={() => onToggleFav(m)}><span className={m.favorite ? 'heart' : ''}><IconHeart size={15} filled={Boolean(m.favorite)} /></span></button>
                    <button type="button" className="btn danger small" aria-label="Delete media" onClick={() => onDelete(m)}><IconTrash size={15} /></button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {filtered.length > visibleCount && (
            <div style={{ textAlign: 'center', marginTop: 18 }}>
              <button type="button" className="btn ghost" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>Load more ({filtered.length - visibleCount} remaining)</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
