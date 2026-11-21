import { useEffect, useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { queueOrder } from '../queueOrder.js'
import { PostRow, Skeleton, Empty, StatusBadge, PlatformBadge, Thumb } from './shared.jsx'

const STATUSES = ['scheduled', 'draft', 'published', 'partial', 'failed']

export default function Queue({ posts, loading, onEdit, onDelete, onPublish, publishingId, onCreate, onDuplicate, onPostAgain, onReschedule, onRescheduleNextBest, overdue, onPublishDue, onDeleteMany, onReconnect, tr, searchSeed, searchNonce, onRetry, retryingId }) {
  const t = tr || ((k) => k)
  const LABELS = { scheduled: t('scheduled'), draft: t('drafts'), published: t('published'), partial: t('partial'), failed: t('failed') }
  const [view, setView] = useState('list')
  const [filter, setFilter] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [selected, setSelected] = useState(new Set())

  useEffect(() => {
    const t2 = setTimeout(() => setQDebounced(q), 150)
    return () => clearTimeout(t2)
  }, [q])

  // D3: a global search from the top nav / drawer lands here as a seed.
  useEffect(() => {
    if (searchNonce) setQ(searchSeed || '')
  }, [searchNonce]) // eslint-disable-line react-hooks/exhaustive-deps

  // D5: touch swipe on a queue row — left deletes (optimistic + Undo),
  // right moves to the next best time. Only clearly-horizontal swipes
  // count, so vertical scrolling is never hijacked.
  const swipeRef = useState(() => ({ x: 0, y: 0, id: null }))[0]
  const swipeStart = (e, p) => {
    const touch = e.touches && e.touches[0]
    if (!touch) return
    swipeRef.x = touch.clientX; swipeRef.y = touch.clientY; swipeRef.id = p.id
  }
  const swipeEnd = (e, p) => {
    const touch = e.changedTouches && e.changedTouches[0]
    if (!touch || swipeRef.id !== p.id) return
    const dx = touch.clientX - swipeRef.x
    const dy = touch.clientY - swipeRef.y
    swipeRef.id = null
    if (Math.abs(dx) < 70 || Math.abs(dx) < Math.abs(dy) * 1.5) return
    if (dx < 0) onDelete && onDelete(p)
    else if (p.status === 'scheduled') onRescheduleNextBest && onRescheduleNextBest(p)
  }

  const filtered = useMemo(() => {
    let list = [...(posts || [])]
    if (filter !== 'all') list = list.filter((p) => p.status === filter)
    if (platform !== 'all') list = list.filter((p) => p.platform === platform)
    if (qDebounced.trim()) {
      const needle = qDebounced.toLowerCase()
      list = list.filter((p) => `${p.caption || ''} ${p.hashtags || ''} ${p.cta || ''}`.toLowerCase().includes(needle))
    }
    // Scheduled first (soonest at the top), everything else after —
    // the kanban columns below inherit this order within each status.
    return queueOrder(list)
  }, [posts, filter, platform, qDebounced])

  const exportCsv = () => {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`
    const lines = [['Media', 'Caption', 'Hashtags', 'CTA', 'Platform', 'Schedule Time', 'Status', 'Format', 'Live URL'].join(',')]
    for (const p of filtered) lines.push([p.mediaUrl, p.caption, p.hashtags, p.cta, p.platform, p.scheduleTime, p.status, p.format, p.liveUrl].map(esc).join(','))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'social-scheduler-queue.csv'
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const toggleSelect = (id) => setSelected((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const selectedItems = filtered.filter((p) => selected.has(p.id))

  return (
    <div>
      <h2 className="section-title">{t('queue')}</h2>
      <p className="section-sub">Everything you&apos;ve planned — drag-free, but organised. Switch to Kanban to see it by status.</p>

      {overdue && overdue.length > 0 && (
        <div className="alert error" role="alert" style={{ marginTop: 0 }}>
          <div style={{ flex: 1 }}><b>{overdue.length} overdue</b> — scheduled time passed. Publish them now or move them.</div>
          <button type="button" className="btn primary small" disabled={publishingId === 'due'} onClick={onPublishDue}>{publishingId === 'due' ? 'Publishing…' : 'Publish due'}</button>
        </div>
      )}

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
        <button type="button" className="btn ghost" onClick={exportCsv}>Export CSV</button>
        <button type="button" className="btn primary" onClick={onCreate}>+ New post</button>
      </div>

      {selected.size > 0 && (
        <div className="toolbar" role="region" aria-label="Bulk actions">
          <span className="pill">{selected.size} selected</span>
          <button type="button" className="btn ghost small" onClick={async () => { if (!onReschedule) return; const items = selectedItems.filter((p) => p.status === 'scheduled'); for (const p of items) { await onReschedule(p, { addDays: 1 }) } setSelected(new Set()) }}>Move +1 day</button>
          <button type="button" className="btn danger small" onClick={() => { onDeleteMany && onDeleteMany(selectedItems); setSelected(new Set()) }}>Delete selected</button>
          <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>Clear selection</button>
        </div>
      )}

      {loading ? <div className="card"><Skeleton variant="posts" rows={4} /></div> : filtered.length === 0 ? (
        (posts || []).length === 0 ? (
          <div className="card"><Empty title="Nothing scheduled yet" body="Your queue is empty. Schedule your first post and it will appear here, soonest first." action={<button type="button" className="btn primary small" onClick={onCreate}>Schedule your first post</button>} /></div>
        ) : (
          <div className="card"><Empty title="Nothing matches" body="Try clearing a filter, or create a post — scheduled posts land here first." action={<button type="button" className="btn primary small" onClick={onCreate}>Create a post</button>} /></div>
        )
      ) : view === 'list' ? (
        <div className="card">
          <label className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 10, cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 16, height: 16 }} checked={filtered.length > 0 && filtered.every((p) => selected.has(p.id))} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((p) => p.id)) : new Set())} />
            Select all {filtered.length} shown
          </label>
          {filtered.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
              onTouchStart={(e) => swipeStart(e, p)} onTouchEnd={(e) => swipeEnd(e, p)}>
              <input type="checkbox" aria-label={`Select post: ${(p.caption || 'No caption').slice(0, 40)}`} checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} style={{ width: 18, height: 18, marginTop: 16, flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0 }}><PostRow post={p} onEdit={onEdit} onDelete={onDelete} onPublish={onPublish} publishing={publishingId === p.id} onDuplicate={onDuplicate} onPostAgain={onPostAgain} onReschedule={onReschedule} onRescheduleNextBest={onRescheduleNextBest} onReconnect={onReconnect} onRetry={onRetry} retrying={retryingId === p.id} /></div>
            </div>
          ))}
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
                    {(p.mediaUrl || p.posterUrl) && <div className="kan-thumb"><Thumb post={p} /></div>}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 7 }}>
                      <StatusBadge status={p.status} />
                      <PlatformBadge platform={p.platform} />
                    </div>
                    <p>{p.caption || 'No caption'}</p>
                    <div className="post-meta"><span>{fmtDateTime(p.scheduleTime)}</span></div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                      {p.status !== 'published' && <button type="button" className="btn primary small" disabled={publishingId === p.id} onClick={() => onPublish(p)}>Publish</button>}
                      {onRetry && (p.status === 'failed' || p.status === 'partial') && <button type="button" className="btn ghost small" disabled={retryingId === p.id} onClick={() => onRetry(p)} title="Re-checks the connection, media and plan first, then publishes again">{retryingId === p.id ? t('retrying') : t('retry')}</button>}
                      {onPostAgain && <button type="button" className="btn ghost small" onClick={() => onPostAgain(p)}>Post again</button>}
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
