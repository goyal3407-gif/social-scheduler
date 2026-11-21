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
function DeviceLibrary({ onUploaded, onUpload, tr }) {
  const t = tr || ((k) => k)
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
      if (f.size > 200 * 1024 * 1024) { setErr(t('errOverLimit').replace('{name}', f.name)); continue }
      try { await importDeviceFile(f); ok++ } catch (e) { setErr(e.message || t('devErrSave')) }
    }
    setImporting(false)
    if (ok) setMsg(t(ok === 1 ? 'devMsgSavedOne' : 'devMsgSavedMany').replace('{n}', ok))
    refresh()
  }

  const uploadCopy = async (item) => {
    setErr(''); setMsg(''); setBusyId(item.id)
    try {
      const file = await readDeviceFile(item)
      await onUpload(file, { folder: 'Uploads', title: item.title })
      setMsg(t('devMsgUploaded'))
    } catch (e) { setErr(e.message || t('devErrUpload')) }
    setBusyId('')
  }

  const remove = async (item) => {
    setErr(''); setMsg('')
    try { await deleteDeviceItem(item.id); await refresh() } catch (e) { setErr(e.message || t('devErrRemove')) }
  }

  const schedule = async (item) => {
    if (!when) { setErr(t('devErrPickTime')); return }
    setErr(''); setMsg(''); setBusyId(item.id)
    try {
      const res = await scheduleFromDevice(item, { caption, hashtags, format, scheduleTime: fromLocalInputValue(when) })
      if (res.outcome === 'scheduled') setMsg(t('devMsgScheduled'))
      else if (res.outcome === 'posted-late') setMsg(t('devMsgPostedLate'))
      else if (res.outcome === 'missing') setErr(t('devErrMissing'))
      else setMsg(t('devMsgWaiting'))
      setSchedId(''); setCaption(''); setHashtags(''); setWhen('')
      await refresh()
      if (onUploaded) onUploaded()
    } catch (e) { setErr(e.message || t('devErrSchedule')) }
    setBusyId('')
  }

  const dismiss = async (p) => {
    try { await removePendingSchedule(p.id); await refresh() } catch { /* list refreshes next open */ }
  }

  return (
    <div className="card mt2">
      <div className="card-head">
        <div>
          <h2>{t('devTitle')}</h2>
          <p>{t('devSub')}</p>
        </div>
        <span className="pill">{t('devCount').replace('{n}', items.length)}</span>
      </div>
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
      <div className="drop" onClick={() => devFileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') devFileRef.current?.click() }}>
        <b>{importing ? t('devSaving') : t('devAddTitle')}</b>
        <p className="small">{t('devAddSub')}</p>
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
                  <span className="muted small">{fmtSize(item.size)} · {item.kind}{item.width && item.height ? ` · ${item.width}×${item.height}` : ''} · {t('devOnPhone')}</span>
                </div>
                <div style={{ display: 'flex', gap: 6, flex: 'none', flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary small" disabled={busyId === item.id} onClick={() => { setSchedId(schedId === item.id ? '' : item.id); setErr(''); setMsg('') }}>{t('devSchedule')}</button>
                  <button type="button" className="btn ghost small" disabled={busyId === item.id} onClick={() => uploadCopy(item)}>{busyId === item.id ? t('devWorking') : t('devUploadCopy')}</button>
                  <button type="button" className="btn danger small" disabled={busyId === item.id} onClick={() => remove(item)}>{t('devRemove')}</button>
                </div>
              </div>
              {schedId === item.id && (
                <div style={{ border: '1px solid var(--line-2)', borderRadius: 10, padding: 12, margin: '4px 0 10px', background: 'var(--surface-2)' }}>
                  <label htmlFor={`devCap-${item.id}`}>{t('captionLabel')}</label>
                  <textarea id={`devCap-${item.id}`} rows={3} placeholder={t('captionPh')} value={caption} onChange={(e) => setCaption(e.target.value)} />
                  <label htmlFor={`devTags-${item.id}`} style={{ marginTop: 10 }}>{t('hashtagsLabel')} <span className="muted">{t('hashtagsNote')}</span></label>
                  <input id={`devTags-${item.id}`} placeholder="#reels #daily" value={hashtags} onChange={(e) => setHashtags(e.target.value)} />
                  <div className="two-col" style={{ marginTop: 10 }}>
                    <div>
                      <label htmlFor={`devFmt-${item.id}`}>{t('formatLabel')}</label>
                      <select id={`devFmt-${item.id}`} value={format} onChange={(e) => setFormat(e.target.value)}>
                        <option value="REELS">REELS</option>
                        <option value="FEED">FEED</option>
                        <option value="STORY">STORY</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor={`devWhen-${item.id}`}>{t('scheduleTimeLabel')}</label>
                      <input id={`devWhen-${item.id}`} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
                    </div>
                  </div>
                  <p className="muted small" style={{ marginTop: 10 }}>{t('devSchedNote')}</p>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button type="button" className="btn primary small" disabled={busyId === item.id} onClick={() => schedule(item)}>{busyId === item.id ? t('devWorking') : t('devSchedulePost')}</button>
                    <button type="button" className="btn ghost small" onClick={() => setSchedId('')}>{t('cancel')}</button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {pending.length > 0 && (
        <div className="mt">
          <h3 style={{ margin: '6px 0 4px' }}>{t('devWaitingTitle')}</h3>
          {pending.map((p) => (
            <div key={p.id} className="device-row">
              <div style={{ minWidth: 0 }}>
                <b title={p.title}>{p.title}</b>
                <span className="muted small">{p.scheduleTime ? t('devForTime').replace('{time}', new Date(p.scheduleTime).toLocaleString()) : t('devNoTime')} · {p.status === 'failed' ? t('devNotCreated') : t('devWaitingNetwork')}</span>
                {p.note && <span className="small" style={{ display: 'block', color: p.status === 'failed' ? 'var(--red)' : 'var(--muted)' }}>{p.note}</span>}
              </div>
              {p.status === 'failed' && <button type="button" className="btn ghost small" style={{ flex: 'none' }} onClick={() => dismiss(p)}>{t('dismiss')}</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function MediaLibrary({ media, loading, error, onRetry, onAddLink, onUpload, onToggleFav, onDelete, onUse, searchSeed, searchNonce, tr }) {
  const t = tr || ((k) => k)
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
      if (f.size > 200 * 1024 * 1024) { setErr(t('errOverLimit').replace('{name}', f.name)); continue }
      try {
        const isVideo = /^video\//.test(f.type) || /\.(mp4|mov|webm)$/i.test(f.name)
        const meta = await probeUrl(URL.createObjectURL(f), isVideo)
        setProgress({ name: f.name, frac: 0 })
        await onUpload(f, { folder: newFolder || undefined, ...meta }, (frac) => setProgress({ name: f.name, frac }))
        ok++
      } catch (e) { setErr(e.message || t('errUploadFailed')) }
      setProgress(null)
    }
    setBusy(false)
    if (ok) setMsg(t(ok === 1 ? 'msgUploadedOne' : 'msgUploadedMany').replace('{n}', ok))
  }

  const addLink = async (e) => {
    e.preventDefault()
    setErr(''); setMsg('')
    if (!url.trim()) { setErr(t('errPasteUrl')); return }
    setBusy(true)
    try {
      const isVideo = !/\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url.trim())
      const meta = await probeUrl(url.trim(), isVideo)
      await onAddLink({ url: url.trim(), title: title.trim() || url.trim(), folder: newFolder || undefined, tags: tags.split(',').map((tg) => tg.trim()).filter(Boolean), ...meta })
      setMsg(t('msgLinkAdded'))
      setUrl(''); setTitle(''); setTags('')
    } catch (e2) { setErr(e2.message || t('errAddLink')) }
    setBusy(false)
  }

  return (
    <div>
      <h2 className="section-title">{t('mediaTitle')}</h2>
      <p className="section-sub">{t('mediaSub')}</p>

      {error && <ErrorBox error={error} onRetry={onRetry} />}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}

      <div className="two-col" style={{ alignItems: 'start' }}>
        <div className="card">
          <h2>{t('uploadTitle')}</h2>
          <p className="muted small mb">{t('uploadSub')}</p>
          <div
            className={`drop ${drag ? 'drag' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => { e.preventDefault(); setDrag(false); handleFiles(e.dataTransfer.files) }}
            onClick={() => fileRef.current?.click()}
            role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') fileRef.current?.click() }}
          >
            <b>{busy ? t('uploadingWord') : t('dropHere')}</b>
            <p className="small">{t('dropFormats')}</p>
            <input ref={fileRef} type="file" multiple accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
          </div>
          {progress && (
            <div className="mt">
              <div className="small muted" style={{ marginBottom: 4 }}>{t('uploadingPct').replace('{name}', progress.name).replace('{pct}', Math.round(progress.frac * 100))}</div>
              <div className="pbar"><span style={{ width: `${Math.round(progress.frac * 100)}%` }} /></div>
            </div>
          )}
          <label htmlFor="upFolder" style={{ marginTop: 14 }}>{t('folderForUploads')}</label>
          <input id="upFolder" placeholder={t('folderPh')} value={newFolder} onChange={(e) => setNewFolder(e.target.value)} />
        </div>

        <form className="card" onSubmit={addLink}>
          <h2>{t('addByLink')}</h2>
          <p className="muted small mb">{t('addByLinkSub')}</p>
          <label htmlFor="linkUrl">{t('mediaUrlLabel')}</label>
          <input id="linkUrl" type="url" placeholder="https://…/video.mp4" value={url} onChange={(e) => setUrl(e.target.value)} />
          <label htmlFor="linkTitle" style={{ marginTop: 12 }}>{t('titleLabel')}</label>
          <input id="linkTitle" placeholder={t('linkTitlePh')} value={title} onChange={(e) => setTitle(e.target.value)} />
          <label htmlFor="linkTags" style={{ marginTop: 12 }}>{t('tagsLabel')} <span className="muted">{t('tagsNote')}</span></label>
          <input id="linkTags" placeholder={t('tagsPh')} value={tags} onChange={(e) => setTags(e.target.value)} />
          <button type="submit" className="btn primary mt" disabled={busy}>{busy ? t('addingWord') : t('addToLibrary')}</button>
        </form>
      </div>

      {isNativeApp() ? <DeviceLibrary onUploaded={onRetry} onUpload={onUpload} tr={t} /> : null}

      <div className="toolbar mt2">
        <div style={{ position: 'relative', flex: 2, minWidth: 180 }}>
          <input type="search" placeholder={t('searchMediaPh')} value={q} onChange={(e) => setQ(e.target.value)} style={{ paddingLeft: 36 }} aria-label={t('searchMediaAria')} />
          <span style={{ position: 'absolute', left: 11, top: 11, color: 'var(--muted)' }}><IconSearch size={16} /></span>
        </div>
        <select value={folder} onChange={(e) => setFolder(e.target.value)} aria-label={t('filterFolderAria')}>
          {folders.map((f) => <option key={f} value={f}>{f === 'all' ? t('allFolders') : f}</option>)}
        </select>
        <button type="button" className={`tab ${onlyFav ? 'active' : ''}`} onClick={() => setOnlyFav(!onlyFav)} aria-pressed={onlyFav}>{t('favOnly')}</button>
        <span className="pill">{t(filtered.length === 1 ? 'filesCountOne' : 'filesCountMany').replace('{n}', filtered.length)}</span>
      </div>

      {loading ? <Skeleton variant="media" rows={3} /> : filtered.length === 0 ? (
        <div className="card"><Empty title={t('libraryEmpty')} body={q || folder !== 'all' || onlyFav ? t('libraryNoMatch') : t('libraryEmptyBody')} action={q || folder !== 'all' || onlyFav ? undefined : <button type="button" className="btn primary small" onClick={() => fileRef.current?.click()}>{t('uploadMediaBtn')}</button>} /></div>
      ) : (
        <div>
          <div className="media-grid">
            {filtered.slice(0, visibleCount).map((m) => (
              <article key={m.id} className="media-card">
                {m.serverCopyRemoved ? (
                  <div className="media-removed"><b>{t('removedTitle')}</b><span>{t('removedBody')}</span></div>
                ) : <MediaVisual url={m.url} kind={m.kind} posterUrl={m.posterUrl} />}
                <div className="mc-body">
                  <b title={m.title || m.url}>{m.title || t('untitledMedia')}</b>
                  <span className="muted small">{m.folder || t('unsortedWord')} · {fmtDate(m.createdAt)}{m.usedCount ? ` · ${t('usedTimes').replace('{n}', m.usedCount)}` : ''}{m.width && m.height ? ` · ${m.width}×${m.height}` : ''}</span>
                  {(m.tags || []).length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>{m.tags.map((tg) => <span key={tg} className="chip">{tg}</span>)}</div>}
                  <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                    {!m.serverCopyRemoved && <button type="button" className="btn primary small" onClick={() => onUse(m)}>{t('useInStudio')}</button>}
                    <button type="button" className="btn ghost small" aria-label={m.favorite ? t('favRemoveAria') : t('favAddAria')} onClick={() => onToggleFav(m)}><span className={m.favorite ? 'heart' : ''}><IconHeart size={15} filled={Boolean(m.favorite)} /></span></button>
                    <button type="button" className="btn danger small" aria-label={t('deleteMediaAria')} onClick={() => onDelete(m)}><IconTrash size={15} /></button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          {filtered.length > visibleCount && (
            <div style={{ textAlign: 'center', marginTop: 18 }}>
              <button type="button" className="btn ghost" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>{t('loadMore').replace('{n}', filtered.length - visibleCount)}</button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
