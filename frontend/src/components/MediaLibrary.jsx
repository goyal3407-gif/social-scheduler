import { useMemo, useRef, useState } from 'react'
import { fmtDate } from '../api.js'
import { Skeleton, Empty, ErrorBox } from './shared.jsx'
import { IconHeart, IconTrash, IconSearch } from './icons.jsx'

export default function MediaLibrary({ media, loading, error, onRetry, onAddLink, onUpload, onToggleFav, onDelete, onUse }) {
  const [q, setQ] = useState('')
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
  const fileRef = useRef(null)

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
      // The live site (Vercel serverless) accepts about 4 MB per request —
      // bigger files fail there even though local dev allows 60 MB.
      if (f.size > 4.5 * 1024 * 1024) { setErr(`"${f.name}" is over the live site's ~4 MB upload limit and was skipped — add it by public link instead (Add by link, on the right).`); continue }
      try { await onUpload(f, { folder: newFolder || undefined }); ok++ } catch (e) { setErr(e.message || 'Upload failed.') }
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
      await onAddLink({ url: url.trim(), title: title.trim() || url.trim(), folder: newFolder || undefined, tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })
      setMsg('Link added to your library.')
      setUrl(''); setTitle(''); setTags('')
    } catch (e2) { setErr(e2.message || 'Could not add link.') }
    setBusy(false)
  }

  return (
    <div>
      <h2 className="section-title">Media Library</h2>
      <p className="section-sub">Upload videos and images (about 4 MB max per upload on the live site — bigger files: add by link) or save links. Organise with folders, tags and favourites.</p>

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
            <p className="small">MP4, MOV, JPG, PNG, WebP — max ~4 MB per file on the live site</p>
            <input ref={fileRef} type="file" multiple accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />
          </div>
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

      {loading ? <Skeleton rows={3} /> : filtered.length === 0 ? (
        <div className="card"><Empty title="Library is empty" body={q || folder !== 'all' || onlyFav ? 'Nothing matches those filters — try clearing them.' : 'Upload your first video or image, or add one by link, and it will live here ready for Studio.'} /></div>
      ) : (
        <div className="media-grid">
          {filtered.map((m) => (
            <article key={m.id} className="media-card">
              {m.kind === 'image' ? <img src={m.url} alt={m.title || ''} loading="lazy" /> : <video src={m.url} muted preload="metadata" />}
              <div className="mc-body">
                <b title={m.title || m.url}>{m.title || 'Untitled'}</b>
                <span className="muted small">{m.folder || 'Unsorted'} · {fmtDate(m.createdAt)}{m.usedCount ? ` · Used ${m.usedCount}×` : ''}</span>
                {(m.tags || []).length > 0 && <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 6 }}>{m.tags.map((t) => <span key={t} className="chip">{t}</span>)}</div>}
                <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary small" onClick={() => onUse(m)}>Use in Studio</button>
                  <button type="button" className="btn ghost small" aria-label={m.favorite ? 'Remove favourite' : 'Mark favourite'} onClick={() => onToggleFav(m)}><span className={m.favorite ? 'heart' : ''}><IconHeart size={15} filled={Boolean(m.favorite)} /></span></button>
                  <button type="button" className="btn danger small" aria-label="Delete media" onClick={() => onDelete(m)}><IconTrash size={15} /></button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
