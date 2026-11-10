import { useMemo, useState } from 'react'
import { parseCsv, fmtDateTime } from '../api.js'

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

export default function Bulk({ onImport }) {
  const [tab, setTab] = useState('csv')
  const [text, setText] = useState('')
  const [links, setLinks] = useState('')
  const [linkTime, setLinkTime] = useState('')
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  const parsed = useMemo(() => {
    if (!text.trim()) return []
    try { return normaliseRows(parseCsv(text)) } catch { return [] }
  }, [text])
  const linkRows = useMemo(() => links.split(/\s+/).filter(Boolean).map((url) => ({
    mediaUrl: url, caption: '', hashtags: '', cta: '', platform: 'Instagram',
    mediaType: /\.(png|jpe?g|gif|webp|avif)(\?|$)/i.test(url) ? 'image' : 'video',
    format: 'REELS', status: linkTime ? 'scheduled' : 'draft',
    scheduleTime: linkTime ? new Date(linkTime).toISOString() : ''
  })), [links, linkTime])

  const rows = tab === 'csv' ? parsed : linkRows
  const valid = rows.filter((r) => r.mediaUrl)

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

  return (
    <div>
      <h2 className="section-title">Bulk scheduling</h2>
      <p className="section-sub">Schedule a whole week at once — paste links, or import a CSV. Columns: Media, Caption, Hashtags, CTA, Platform, Schedule Time.</p>

      <div className="tabs mb">
        <button type="button" className={`tab ${tab === 'csv' ? 'active' : ''}`} onClick={() => setTab('csv')}>CSV import</button>
        <button type="button" className={`tab ${tab === 'links' ? 'active' : ''}`} onClick={() => setTab('links')}>Paste links</button>
      </div>

      {tab === 'csv' ? (
        <div className="card">
          <div className="card-head">
            <div><h2>CSV import</h2><p>First row is the header. Quoted fields and commas inside captions are handled.</p></div>
            <button type="button" className="btn ghost small" onClick={() => setText(SAMPLE)}>Load sample</button>
          </div>
          <label htmlFor="csvText">Paste your CSV</label>
          <textarea id="csvText" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder={'Media,Caption,Hashtags,CTA,Platform,Schedule Time\nhttps://…/video.mp4,Your caption,"#a #b",Comment below,Instagram,2026-11-12T19:00:00'} />
          <p className="muted small mt">Tip: export from a spreadsheet as CSV, then paste it here. Schedule Time accepts ISO (2026-11-12T19:00:00) or a readable date like “12 Nov 2026 7pm”.</p>
        </div>
      ) : (
        <div className="card">
          <h2>Paste links</h2>
          <p className="muted small mb">One media link per line or separated by spaces. Add captions later in the Queue — or leave them as drafts.</p>
          <label htmlFor="links">Media links</label>
          <textarea id="links" rows={6} value={links} onChange={(e) => setLinks(e.target.value)} placeholder={'https://…/video1.mp4\nhttps://…/video2.mp4'} />
          <label htmlFor="linkTime" style={{ marginTop: 14 }}>Schedule time for all links <span className="muted">(optional — leave empty to save as drafts)</span></label>
          <input id="linkTime" type="datetime-local" value={linkTime} onChange={(e) => setLinkTime(e.target.value)} />
        </div>
      )}

      <section className="card section">
        <div className="card-head">
          <div><h2>Preview — {rows.length} row{rows.length === 1 ? '' : 's'} parsed, {valid.length} valid</h2><p>Only valid rows (with a media link) will be imported.</p></div>
          <button type="button" className="btn primary" disabled={!valid.length || importing} onClick={doImport}>{importing ? 'Importing…' : `Import ${valid.length} post${valid.length === 1 ? '' : 's'}`}</button>
        </div>
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
                    <td>{r.mediaUrl ? <a href={r.mediaUrl} target="_blank" rel="noreferrer">{r.mediaUrl.slice(0, 42)}</a> : <span style={{ color: 'var(--red)' }}>Missing media</span>}</td>
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
    </div>
  )
}
