import { useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { PostRow, Skeleton, Empty, StatusBadge, PlatformBadge } from './shared.jsx'

const STATUSES = ['scheduled', 'draft', 'published', 'failed']
const LABELS = { scheduled: 'Scheduled', draft: 'Drafts', published: 'Published', failed: 'Failed' }

export default function Queue({ posts, loading, onEdit, onDelete, onPublish, publishingId, onCreate, onDuplicate, onReschedule, onRescheduleNextBest }) {
  const [view, setView] = useState('list')
  const [filter, setFilter] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [q, setQ] = useState('')

  const filtered = useMemo(() => {
    let list = [...(posts || [])].sort((a, b) => new Date(a.scheduleTime || 0) - new Date(b.scheduleTime || 0))
    if (filter !== 'all') list = list.filter((p) => p.status === filter)
    if (platform !== 'all') list = list.filter((p) => p.platform === platform)
    if (q.trim()) {
      const needle = q.toLowerCase()
      list = list.filter((p) => `${p.caption || ''} ${p.hashtags || ''} ${p.cta || ''}`.toLowerCase().includes(needle))
    }
    return list
  }, [posts, filter, platform, q])

  return (
    <div>
      <h2 className="section-title">Queue</h2>
      <p className="section-sub">Everything you&apos;ve planned — drag-free, but organised. Switch to Kanban to see it by status.</p>

      <div className="toolbar">
        <div className="tabs" role="tablist" aria-label="Queue view">
          <button type="button" className={`tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>List</button>
          <button type="button" className={`tab ${view === 'kanban' ? 'active' : ''}`} onClick={() => setView('kanban')}>Kanban</button>
        </div>
        <select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter by status">
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
        </select>
        <select value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Filter by platform">
          <option value="all">All platforms</option>
          {['Instagram', 'YouTube', 'Facebook', 'TikTok'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input type="search" placeholder="Search captions, hashtags…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search queue" />
        <button type="button" className="btn primary" onClick={onCreate}>+ New post</button>
      </div>

      {loading ? <div className="card"><Skeleton rows={4} /></div> : filtered.length === 0 ? (
        <div className="card"><Empty title="Nothing matches" body="Try clearing a filter, or create a post — scheduled posts land here first." action={<button type="button" className="btn primary small" onClick={onCreate}>Create a post</button>} /></div>
      ) : view === 'list' ? (
        <div className="card">
          {filtered.map((p) => <PostRow key={p.id} post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} onDuplicate={onDuplicate} onReschedule={onReschedule} onRescheduleNextBest={onRescheduleNextBest} />)}
        </div>
      ) : (
        <div className="kanban">
          {STATUSES.map((status) => {
            const col = filtered.filter((p) => p.status === status)
            return (
              <div key={status} className="kan-col">
                <h3><span>{LABELS[status]}</span><span className="badge neutral">{col.length}</span></h3>
                {col.length === 0 && <p className="muted small">No {LABELS[status].toLowerCase()}.</p>}
                {col.map((p) => (
                  <article key={p.id} className="kan-card">
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 7 }}>
                      <StatusBadge status={p.status} />
                      <PlatformBadge platform={p.platform} />
                    </div>
                    <p>{p.caption || 'No caption'}</p>
                    <div className="post-meta"><span>{fmtDateTime(p.scheduleTime)}</span></div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                      {p.status !== 'published' && <button type="button" className="btn primary small" disabled={publishingId === p.id} onClick={() => onPublish(p)}>Publish</button>}
                      {onDuplicate && <button type="button" className="btn ghost small" onClick={() => onDuplicate(p)}>Duplicate</button>}
                      {onReschedule && p.status !== 'published' && <button type="button" className="btn ghost small" onClick={() => onReschedule(p, { addDays: 1 })}>+1 day</button>}
                      {onRescheduleNextBest && p.status !== 'published' && <button type="button" className="btn ghost small" onClick={() => onRescheduleNextBest(p)} title="Move to the next free 7:00 PM slot in your schedule">Next best time</button>}
                      <button type="button" className="btn ghost small" onClick={() => onEdit(p)}>Edit</button>
                      <button type="button" className="btn danger small" onClick={() => onDelete(p)}>Delete</button>
                    </div>
                  </article>
                ))}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
