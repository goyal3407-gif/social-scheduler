import { useEffect, useMemo, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { queueOrder } from '../queueOrder.js'
import { PostRow, Skeleton, Empty, StatusBadge, PlatformBadge, Thumb, Segmented, FilterSheet } from './shared.jsx'

const STATUSES = ['scheduled', 'draft', 'published', 'partial', 'failed']

export default function Queue({ posts, loading, onEdit, onDelete, onPublish, publishingId, onCreate, onDuplicate, onPostAgain, onReschedule, onRescheduleNextBest, overdue, onPublishDue, onDeleteMany, onReconnect, tr, searchSeed, searchNonce, onRetry, retryingId }) {
  const t = tr || ((k) => k)
  const LABELS = { scheduled: t('scheduled'), draft: t('drafts'), published: t('published'), partial: t('partial'), failed: t('failed') }
  const [swipeHintSeen, setSwipeHintSeen] = useState(() => { try { return localStorage.getItem('ss-swipe-hint') === '1' } catch { return true } })
  const [view, setView] = useState('list')
  const [filter, setFilter] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [q, setQ] = useState('')
  const [qDebounced, setQDebounced] = useState('')
  const [selected, setSelected] = useState(new Set())
  // Round 3 (B6): the toolbar carries only the List/Kanban
  // Segmented, search and ONE Filters button — the status and
  // platform selects AND Export CSV all live inside the B2
  // FilterSheet. Filter behaviour/values are unchanged.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const filtersActive = filter !== 'all' || platform !== 'all'

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
  // Round 3 (B6): while an empty state (with its own single CTA) is
  // showing, the toolbar's "+ New post" button is hidden so the
  // screen carries exactly ONE primary CTA.
  const showEmpty = !loading && filtered.length === 0

  return (
    <div>
      <h2 className="section-title">{t('queue')}</h2>
      <p className="section-sub">{t('queueSub')}</p>

      {overdue && overdue.length > 0 && (
        <div className="alert error" role="alert" style={{ marginTop: 0 }}>
          <div style={{ flex: 1 }}><b>{t('queueOverdueTitle').replace('{n}', overdue.length)}</b> — {t('queueOverdueBody')}</div>
          <button type="button" className="btn primary small" disabled={publishingId === 'due'} onClick={onPublishDue}>{publishingId === 'due' ? t('publishingWord') : t('publishDue')}</button>
        </div>
      )}

      {!swipeHintSeen && !loading && filtered.length > 0 && (
        <p className="swipe-hint">
          <span>{t('swipeHint')}</span>
          <button type="button" className="update-close" aria-label={t('dismiss')} onClick={() => { setSwipeHintSeen(true); try { localStorage.setItem('ss-swipe-hint', '1') } catch { /* private mode */ } }}>✕</button>
        </p>
      )}

      <div className="toolbar">
        <Segmented ariaLabel="Queue view" value={view} onChange={setView} options={[{ value: 'list', label: t('listView') }, { value: 'kanban', label: t('kanbanView') }]} />
        <input type="search" placeholder={t('searchQueuePh')} value={q} onChange={(e) => setQ(e.target.value)} aria-label={t('ariaSearchPosts')} />
        <button type="button" className={`btn ghost${filtersActive ? ' is-on' : ''}`} aria-pressed={filtersActive} onClick={() => setFiltersOpen(true)}>{t('queueFilters')}{filtersActive ? ' •' : ''}</button>
        {!showEmpty && <button type="button" className="btn primary" onClick={onCreate}>{t('newPostBtn')}</button>}
      </div>

      <FilterSheet open={filtersOpen} title={t('queueFilters')} onClose={() => setFiltersOpen(false)} onClear={filtersActive ? () => { setFilter('all'); setPlatform('all') } : undefined}>
        <label htmlFor="qFilterStatus">{t('statusLabel')}</label>
        <select id="qFilterStatus" value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="all">{t('allStatuses')}</option>
          {STATUSES.map((s) => <option key={s} value={s}>{LABELS[s]}</option>)}
        </select>
        <label htmlFor="qFilterPlatform" style={{ marginTop: 14 }}>{t('platformLabel')}</label>
        <select id="qFilterPlatform" value={platform} onChange={(e) => setPlatform(e.target.value)}>
          <option value="all">{t('allPlatforms')}</option>
          {['Instagram', 'YouTube'].map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <button type="button" className="btn ghost block" style={{ marginTop: 18 }} onClick={exportCsv}>{t('exportCsv')}</button>
      </FilterSheet>

      {selected.size > 0 && (
        <div className="toolbar" role="region" aria-label="Bulk actions">
          <span className="pill">{t('selectedCount').replace('{n}', selected.size)}</span>
          <button type="button" className="btn ghost small" onClick={async () => { if (!onReschedule) return; const items = selectedItems.filter((p) => p.status === 'scheduled'); for (const p of items) { await onReschedule(p, { addDays: 1 }) } setSelected(new Set()) }}>{t('movePlusDay')}</button>
          <button type="button" className="btn danger small" onClick={() => { onDeleteMany && onDeleteMany(selectedItems); setSelected(new Set()) }}>{t('deleteSelected')}</button>
          <button type="button" className="btn ghost small" onClick={() => setSelected(new Set())}>{t('clearSelection')}</button>
        </div>
      )}

      {loading ? <div className="card" aria-busy="true"><span className="sr-only">{t('loading')}</span><Skeleton variant="posts" rows={4} /></div> : filtered.length === 0 ? (
        (posts || []).length === 0 ? (
          <div className="card"><Empty title={t('emptyQueueTitle')} body={t('emptyQueueBody')} action={<button type="button" className="btn primary small" onClick={onCreate}>{t('scheduleFirstPost')}</button>} /></div>
        ) : (
          <div className="card"><Empty title={t('noMatchTitle')} body={t('noMatchBody')} action={<button type="button" className="btn primary small" onClick={onCreate}>{t('createAPost')}</button>} /></div>
        )
      ) : view === 'list' ? (
        <div className="card">
          <label className="small muted queue-select-all">
            <input type="checkbox" style={{ width: 16, height: 16 }} checked={filtered.length > 0 && filtered.every((p) => selected.has(p.id))} onChange={(e) => setSelected(e.target.checked ? new Set(filtered.map((p) => p.id)) : new Set())} />
            {t('selectAllShown').replace('{n}', filtered.length)}
          </label>
          {filtered.map((p) => (
            <div key={p.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}
              onTouchStart={(e) => swipeStart(e, p)} onTouchEnd={(e) => swipeEnd(e, p)}>
              {/* Round 3 (B6): the label wrapper gives the row
                  checkbox a 44px hit area; the box itself stays
                  small. Swipe actions (left = delete, right =
                  next best time) are also in the row menu. */}
              <label className="queue-check">
                <input type="checkbox" aria-label={t('selectPostAria').replace('{caption}', (p.caption || t('noCaption')).slice(0, 40))} checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} style={{ width: 18, height: 18, flex: 'none' }} />
              </label>
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
                {col.length === 0 && <p className="muted small">{t('noColPosts')}</p>}
                {col.map((p) => (
                  <article key={p.id} className="kan-card">
                    {(p.mediaUrl || p.posterUrl) && <div className="kan-thumb"><Thumb post={p} /></div>}
                    <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 7 }}>
                      <StatusBadge status={p.status} />
                      <PlatformBadge platform={p.platform} />
                    </div>
                    <p>{p.caption || t('noCaption')}</p>
                    <div className="post-meta"><span>{fmtDateTime(p.scheduleTime)}</span></div>
                    <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
                      {p.status !== 'published' && !(onRetry && (p.status === 'failed' || p.status === 'partial')) && <button type="button" className="btn primary small" disabled={publishingId === p.id} onClick={() => onPublish(p)}>{t('publish')}</button>}
                      {onRetry && (p.status === 'failed' || p.status === 'partial') && <button type="button" className="btn primary small" disabled={retryingId === p.id} onClick={() => onRetry(p)} title={t('retryTitle')}>{retryingId === p.id ? t('retrying') : t('retry')}</button>}
                      {onPostAgain && <button type="button" className="btn ghost small" onClick={() => onPostAgain(p)}>{t('postAgain')}</button>}
                      {onDuplicate && <button type="button" className="btn ghost small" onClick={() => onDuplicate(p)}>{t('duplicate')}</button>}
                      {onReschedule && p.status !== 'published' && <button type="button" className="btn ghost small" onClick={() => onReschedule(p, { addDays: 1 })}>{t('plusOneDay')}</button>}
                      {onRescheduleNextBest && p.status !== 'published' && <button type="button" className="btn ghost small" onClick={() => onRescheduleNextBest(p)} title={t('nextBestTitle')}>{t('nextBestTimeBtn')}</button>}
                      <button type="button" className="btn ghost small" onClick={() => onEdit(p)}>{t('edit')}</button>
                      <button type="button" className="btn danger small" onClick={() => onDelete(p)}>{t('delete')}</button>
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
