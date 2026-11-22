import { useMemo, useRef, useState } from 'react'
import { parseCsv, fmtDateTime } from '../api.js'

// Probe a picked file for dimensions/duration (same approach as the
// Media Library) so scheduled posts carry real sizes for Studio checks.
function probeFile(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const timer = setTimeout(() => { URL.revokeObjectURL(url); resolve({}) }, 2500)
    const finish = (meta) => { clearTimeout(timer); URL.revokeObjectURL(url); resolve(meta) }
    try {
      if (/^video\//.test(file.type) || /\.(mp4|mov|webm)$/i.test(file.name)) {
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

const SAMPLE = `Media,Caption,Hashtags,CTA,Platform,Schedule Time
https://example.com/video1.mp4,Your first tip for the week,"#tips #creator",Comment GUIDE,Instagram,2026-11-12T19:00:00
https://example.com/video2.mp4,Behind the scenes today,"#behindthescenes",Follow for more,Instagram,2026-11-12T21:00:00`

function normaliseRows(rows) {
  return rows.map((r) => {
    let t = (r.scheduleTime || '').trim()
    // Accept "2026-11-12 19:00" and "12 Nov 2026 7pm" via Date parsing; keep ISO as-is.
    if (t && !t.endsWith('Z') && !/([+-]\d{2}:?\d{2})$/.test(t)) {
      const d = new Date(t)
      if (!Number.isNaN(d.getTime())) t = d.toISOString()
    }
    const platform = ['Instagram', 'YouTube', 'Facebook', 'TikTok'].includes(r.platform) ? r.platform : 'Instagram'
    return { ...r, platform, scheduleTime: t, status: t ? 'scheduled' : 'draft' }
  })
}

export default function Bulk({ onImport, posts, onUploadFile, igAccounts, defaultIgUserId, hashtagGroups }) {
  const [tab, setTab] = useState('csv')
  // "Upload videos" tab: many files at once, one shared caption, and
  // the queue is spread automatically over the chosen times per day.
  const [videoFiles, setVideoFiles] = useState([])
  const [fAccount, setFAccount] = useState('')
  const [fCaption, setFCaption] = useState('')
  const [fHashtags, setFHashtags] = useState('')
  const [fCta, setFCta] = useState('')
  const [fStart, setFStart] = useState('')
  const [fTimes, setFTimes] = useState('19:00, 21:00')
  const [uploading, setUploading] = useState(false)
  const [fileProgress, setFileProgress] = useState({}) // file name -> 0..1, or -1 for failed
  const [fileResult, setFileResult] = useState(null)
  const bulkFileRef = useRef(null)
  const [text, setText] = useState('')
  const [links, setLinks] = useState('')
  const [linkTime, setLinkTime] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [skipDupes, setSkipDupes] = useState(true)
  const [autoSpace, setAutoSpace] = useState(false)
  const [spaceStart, setSpaceStart] = useState('')

  const existingUrls = useMemo(() => new Set((posts || []).map((p) => p.mediaUrl).filter(Boolean)), [posts])

  const parsed = useMemo(() => {
    if (!text.trim()) return []
    try { return normaliseRows(parseCsv(text)) } catch { return [] }
  }, [text])
  const linkRows = useMemo(() => links.split(/\s+/).filter(Boolean).map((url, i) => {
    let scheduleTime = linkTime ? new Date(linkTime).toISOString() : ''
    // Auto-spacing: one post per day at 7:00 PM from the chosen start date.
    if (autoSpace && spaceStart) {
      const d = new Date(spaceStart)
      d.setDate(d.getDate() + i)
      d.setHours(19, 0, 0, 0)
      scheduleTime = d.toISOString()
    }
    return {
      mediaUrl: url, caption: '', hashtags: '', cta: '', platform: 'Instagram',
      mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url) ? 'image' : 'video',
      format: 'REELS', status: scheduleTime ? 'scheduled' : 'draft',
      scheduleTime
    }
  }), [links, linkTime, autoSpace, spaceStart])

  const rows = tab === 'csv' ? parsed : linkRows
  const valid = rows.filter((r) => r.mediaUrl && (!skipDupes || !existingUrls.has(r.mediaUrl)))
  const dupesSkipped = rows.filter((r) => r.mediaUrl && skipDupes && existingUrls.has(r.mediaUrl)).length

  const loadCsvFile = (file) => {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setText(String(reader.result || ''))
    reader.onerror = () => setError('Could not read that file.')
    reader.readAsText(file)
  }

  const doImport = async () => {
    setError(''); setResult(null)
    if (!valid.length) { setError('Nothing valid to import — check the preview below.'); return }
    setImporting(true)
    try {
      const res = await onImport(valid)
      setResult(res)
      setText(''); setLinks('')
    } catch (e) {
      setError(e.message || 'Import failed.')
    } finally { setImporting(false) }
  }

  // Spread the picked files over the chosen posting times: file i
  // takes times[i % times.length] on day floor(i / times.length) from
  // the start date — e.g. 6 files at "19:00, 21:00" = 2/day for 3 days.
  const fSlots = useMemo(() => {
    const times = fTimes.split(',').map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t))
    if (!videoFiles.length || !fStart || !times.length) return []
    const [y, mo, da] = fStart.split('-').map(Number)
    return videoFiles.map((f, i) => {
      const [hh, mm] = times[i % times.length].split(':').map(Number)
      const d = new Date(y, (mo || 1) - 1, da || 1, hh || 19, mm || 0, 0, 0)
      d.setDate(d.getDate() + Math.floor(i / times.length))
      const base = f.name.replace(/\.[^.]+$/, '')
      return { file: f, when: d, caption: (fCaption || '').split('{filename}').join(base) }
    })
  }, [videoFiles, fStart, fTimes, fCaption])

  const doFiles = async () => {
    setError(''); setFileResult(null)
    if (!onUploadFile) { setError('Uploading is not available in this view.'); return }
    if (!fSlots.length) { setError('Pick at least one file, a start date, and one posting time (like 19:00) first.'); return }
    setUploading(true)
    const rows = []
    const failures = []
    for (const slot of fSlots) {
      const f = slot.file
      try {
        if (f.size > 200 * 1024 * 1024) throw new Error('over the 200 MB per-file limit')
        const meta = await probeFile(f)
        const item = await onUploadFile(f, { folder: 'Uploads', ...meta }, (frac) => setFileProgress((p) => ({ ...p, [f.name]: frac })))
        if (!item || !item.url) throw new Error('the upload did not return a library item')
        setFileProgress((p) => ({ ...p, [f.name]: 1 }))
        rows.push({
          mediaUrl: item.url, caption: slot.caption, hashtags: fHashtags, cta: fCta, platform: 'Instagram',
          mediaType: /\.(png|jpe?g|gif|webp|avif)$/i.test(f.name) ? 'image' : 'video',
          posterUrl: item.posterUrl || '',
          format: 'REELS', status: 'scheduled', scheduleTime: slot.when.toISOString(),
          // Same target field the Studio writes: the one selected
          // account as a one-element tick list.
          ...((fAccount || defaultIgUserId) ? { igTargets: [fAccount || defaultIgUserId] } : {}),
        })
      } catch (e) {
        failures.push(`${f.name}: ${e.message || 'upload failed'}`)
        setFileProgress((p) => ({ ...p, [f.name]: -1 }))
      }
    }
    let imported = 0
    if (rows.length) {
      try { const res = await onImport(rows); imported = res?.imported ?? rows.length } catch (e) { failures.push(e.message || 'Scheduling failed.') }
    }
    setFileResult({ imported, failures })
    setUploading(false)
  }

  return (
    <div>
      <h2 className="section-title">Bulk scheduling</h2>
      <p className="section-sub">Schedule a whole week at once — upload many video files, paste links, or import a CSV. Columns: Media, Caption, Hashtags, CTA, Platform, Schedule Time.</p>

      <div className="tabs mb">
        <button type="button" className={`tab ${tab === 'csv' ? 'active' : ''}`} onClick={() => setTab('csv')}>CSV import</button>
        <button type="button" className={`tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>Paste links</button>
        <button type="button" className={`tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Upload videos</button>
      </div>

      {tab === 'files' ? (
        <div className="card">
          <h2>Upload videos — schedule them all</h2>
          <p className="muted small mb">Pick many video files at once. They upload one by one (big files upload in pieces, up to 200 MB each), then the whole queue is created spread over your posting times.</p>
          <div className="drop" onClick={() => bulkFileRef.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') bulkFileRef.current?.click() }}>
            <b>{videoFiles.length ? `${videoFiles.length} file${videoFiles.length === 1 ? '' : 's'} picked` : 'Choose video files'}</b>
            <p className="small">MP4, MOV, WebP, JPG, PNG — click to browse, you can pick many at once</p>
            <input ref={bulkFileRef} type="file" multiple accept="video/*,image/*" style={{ display: 'none' }} onChange={(e) => { setVideoFiles([...(e.target.files || [])]); setFileProgress({}); setFileResult(null); e.target.value = '' }} />
          </div>
          <label htmlFor="fCaption" style={{ marginTop: 14 }}>Caption for every post <span className="muted">(use {'{filename}'} to insert each file&apos;s name)</span></label>
          <textarea id="fCaption" rows={3} value={fCaption} onChange={(e) => setFCaption(e.target.value)} placeholder={'New video: {filename} — watch till the end!'} />
          <div className="two-col" style={{ marginTop: 4 }}>
            <div>
              <label htmlFor="fHashtags">Hashtags <span className="muted">(shared)</span></label>
              <input id="fHashtags" value={fHashtags} onChange={(e) => setFHashtags(e.target.value)} placeholder="#reels #creator" />
              {Array.isArray(hashtagGroups) && hashtagGroups.length > 0 && (
                <div style={{ marginTop: 6 }}>
                  {hashtagGroups.map((g) => (
                    <button key={g.id} type="button" className="chip" style={{ marginRight: 6, marginBottom: 6, cursor: 'pointer' }} title={g.tags}
                      onClick={() => setFHashtags((prev) => [prev.trim(), String(g.tags || '').trim()].filter(Boolean).join(' '))}>
                      {g.name} +
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div>
              <label htmlFor="fCta">Call to action <span className="muted">(shared, optional)</span></label>
              <input id="fCta" value={fCta} onChange={(e) => setFCta(e.target.value)} placeholder="Follow for more" />
            </div>
          </div>
          <div className="two-col" style={{ marginTop: 4 }}>
            <div>
              <label htmlFor="fStart">Start date</label>
              <input id="fStart" type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} />
            </div>
            <div>
              <label htmlFor="fTimes">Posting times per day <span className="muted">(comma separated, 24h)</span></label>
              <input id="fTimes" value={fTimes} onChange={(e) => setFTimes(e.target.value)} placeholder="19:00, 21:00" />
            </div>
          </div>
          {Array.isArray(igAccounts) && igAccounts.length > 0 && (
            <div style={{ marginTop: 4 }}>
              <label htmlFor="fAccount">Instagram account <span className="muted">(every post in this batch)</span></label>
              <select id="fAccount" value={fAccount || defaultIgUserId || ''} onChange={(e) => setFAccount(e.target.value)}>
                {igAccounts.map((a) => (
                  <option key={a.igUserId} value={a.igUserId}>@{a.username || a.igUserId}{a.isDefault ? ' (default)' : ''}</option>
                ))}
              </select>
            </div>
          )}
          {error && <div className="alert error" style={{ marginTop: 12 }}>{error}</div>}
          {fileResult && (
            <div className={`alert ${fileResult.failures.length ? 'error' : 'success'}`} style={{ marginTop: 12 }}>
              Scheduled {fileResult.imported} post{fileResult.imported === 1 ? '' : 's'}.
              {fileResult.failures.length > 0 && <><br />{fileResult.failures.length} failed:<br />{fileResult.failures.slice(0, 5).join(' · ')}</>}
            </div>
          )}
          {fSlots.length > 0 && (
            <div className="mt">
              {fSlots.map((s, i) => (
                <div key={`${s.file.name}-${i}`} className="device-row">
                  <div style={{ minWidth: 0 }}>
                    <b title={s.file.name}>{s.file.name}</b>
                    <span className="muted small">{fmtDateTime(s.when.toISOString())} · {s.caption ? s.caption.slice(0, 60) : 'No caption'}</span>
                    {uploading && fileProgress[s.file.name] !== undefined && fileProgress[s.file.name] >= 0 && fileProgress[s.file.name] < 1 && (
                      <div className="pbar" style={{ marginTop: 5 }}><span style={{ width: `${Math.round(fileProgress[s.file.name] * 100)}%` }} /></div>
                    )}
                  </div>
                  <span className="pill" style={{ flex: 'none' }}>
                    {fileProgress[s.file.name] === -1 ? 'Failed' : fileProgress[s.file.name] === 1 ? 'Uploaded ✓' : uploading && fileProgress[s.file.name] !== undefined ? `${Math.round(fileProgress[s.file.name] * 100)}%` : 'Waiting'}
                  </span>
                </div>
              ))}
            </div>
          )}
          <button type="button" className="btn primary mt" disabled={uploading || !fSlots.length} onClick={doFiles}>
            {uploading ? 'Uploading & scheduling…' : `Upload & schedule ${fSlots.length} post${fSlots.length === 1 ? '' : 's'}`}
          </button>
        </div>
      ) : tab === 'csv' ? (
        <div className="card">
          <div className="card-head">
            <div><h2>CSV import</h2><p>First row is the header. Quoted fields and commas inside captions are handled.</p></div>
            <button type="button" className="btn ghost small" onClick={() => setText(SAMPLE)}>Load sample</button>
          </div>
          <label htmlFor="csvText">Paste your CSV</label>
          <textarea id="csvText" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Media,Caption,Hashtags,CTA,Platform,Schedule Time\nhttps://…/video.mp4,Your caption,"#a #b",Comment below,Instagram,2026-11-12T19:00:00'} />
          <p className="muted small mt">Tip: export from a spreadsheet as CSV, then paste it here. Schedule Time accepts ISO (2026-11-12T19:00:00) or a readable date like “12 Nov 2026 7pm”.</p>
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 12, cursor: 'pointer' }}>
            <input type="file" accept=".csv,text/csv" style={{ width: 'auto' }} onChange={(e) => loadCsvFile(e.target.files?.[0])} aria-label="Choose a CSV file" />
            Or choose a .csv file from your device
          </label>
        </div>
      ) : (
        <div className="card">
          <h2>Paste links</h2>
          <p className="muted small mb">One media link per line or separated by spaces. Add captions later in the Queue — or leave them as drafts.</p>
          <label htmlFor="links">Media links</label>
          <textarea id="links" rows={6} value={links} onChange={(e) => setLinks(e.target.value)} placeholder={'https://…/video1.mp4\nhttps://…/video2.mp4'} />
          <label htmlFor="linkTime" style={{ marginTop: 14 }}>Schedule time for all links <span className="muted">(optional — leave empty to save as drafts)</span></label>
          <input id="linkTime" type="datetime-local" value={linkTime} onChange={(e) => setLinkTime(e.target.value)} disabled={autoSpace} />
          <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={autoSpace} onChange={(e) => setAutoSpace(e.target.checked)} style={{ width: 16, height: 16 }} />
            Auto-space: one post per day at 7:00 PM
          </label>
          {autoSpace && (
            <div style={{ marginTop: 10 }}>
              <label htmlFor="spaceStart">Start date</label>
              <input id="spaceStart" type="date" value={spaceStart} onChange={(e) => setSpaceStart(e.target.value)} />
            </div>
          )}
        </div>
      )}

      {tab !== 'files' && (
      <section className="card section">
        <div className="card-head">
          <div><h2>Preview — {rows.length} row{rows.length === 1 ? '' : 's'} parsed, {valid.length} valid{dupesSkipped ? `, ${dupesSkipped} duplicate${dupesSkipped === 1 ? '' : 's'} skipped` : ''}</h2><p>Only valid rows (with a media link) will be imported.</p></div>
          <button type="button" className="btn primary" disabled={!valid.length || importing} onClick={doImport}>{importing ? 'Importing…' : `Import ${valid.length} post${valid.length === 1 ? '' : 's'}`}</button>
        </div>
        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 12, cursor: 'pointer' }}>
          <input type="checkbox" checked={skipDupes} onChange={(e) => setSkipDupes(e.target.checked)} style={{ width: 16, height: 16 }} />
          Skip links already in my queue
        </label>
        {error && <div className="alert error">{error}</div>}
        {result && <div className="alert success">Imported {result.imported ?? valid.length} post{result.imported === 1 ? '' : 's'}{result.failed ? ` — ${result.failed} failed.` : '.'}{result.errors && result.errors.length ? ` ${result.errors.slice(0, 3).join(' ')}` : ''}</div>}
        {rows.length === 0 ? (
          <p className="muted">Paste CSV or links above and the preview will appear here.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Media</th><th>Caption</th><th>Hashtags</th><th>CTA</th><th>Platform</th><th>Schedule time</th><th>Status</th></tr></thead>
              <tbody>
                {rows.slice(0, 50).map((r, i) => (
                  <tr key={i} style={!r.mediaUrl ? { opacity: .55 } : undefined}>
                    <td>{r.mediaUrl ? <a href={r.mediaUrl} target="_blank" rel="noreferrer">{r.mediaUrl.slice(0, 42)}</a> : <span style={{ color: 'var(--red-text)' }}>Missing media</span>}</td>
                    <td>{r.caption || '—'}</td>
                    <td>{r.hashtags || '—'}</td>
                    <td>{r.cta || '—'}</td>
                    <td>{r.platform}</td>
                    <td>{r.scheduleTime ? fmtDateTime(r.scheduleTime) : '—'}</td>
                    <td>{r.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 50 && <p className="muted small mt">Showing first 50 of {rows.length} rows — all will be imported.</p>}
          </div>
        )}
      </section>
      )}
    </div>
  )
}
