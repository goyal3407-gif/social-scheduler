import { useEffect, useRef, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { IconPlay, IconMedia } from './icons.jsx'

export function StatusBadge({ status }) {
  return <span className={`badge ${status || 'draft'}`}>{status || 'draft'}</span>
}

export function PlatformBadge({ platform }) {
  return <span className="badge neutral">{platform || 'Instagram'}</span>
}

/** True when a media URL is served by this app itself (/media/<id>) —
 *  those support Range requests, so a <video preload="metadata"> can
 *  show a real first frame cheaply. */
export function isOwnMediaUrl(url) {
  if (!url || typeof url !== 'string') return false
  try { return new URL(url, 'http://app.invalid').pathname.startsWith('/media/') } catch { return false }
}

/**
 * The visual for a media item or post: the captured poster image when
 * there is one; an <img> for images; for app-served videos without a
 * poster, a metadata-only <video> pinned at t=1s so the browser paints
 * a real first frame; external videos keep the old no-preload element.
 */
export function MediaVisual({ url, kind, posterUrl, className }) {
  if (posterUrl) return <img className={className} src={posterUrl} alt="" loading="lazy" decoding="async" />
  if (!url) return null
  if (kind === 'image') return <img className={className} src={url} alt="" loading="lazy" decoding="async" />
  if (isOwnMediaUrl(url)) return <video className={className} src={`${url}#t=1`} muted playsInline preload="metadata" />
  return <video className={className} src={url} muted playsInline preload="none" />
}

export function Thumb({ post }) {
  if (post?.mediaUrl || post?.posterUrl) {
    return <MediaVisual url={post.mediaUrl} kind={post.mediaType} posterUrl={post.posterUrl} className="thumb" />
  }
  return <div className="thumb-ph"><IconPlay size={22} /></div>
}

export function Skeleton({ rows = 3 }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skel" style={{ height: 74, marginBottom: 10 }} />
      ))}
    </div>
  )
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null
  return (
    <div className="alert error" role="alert">
      <span style={{ flex: 'none', marginTop: 1, fontWeight: 800 }}>!</span>
      <div style={{ flex: 1 }}>
        <b>Couldn&apos;t load this.</b> {String(error.message || error)}
        {onRetry && <div style={{ marginTop: 8 }}><button type="button" className="btn ghost small" onClick={onRetry}>Retry</button></div>}
      </div>
    </div>
  )
}

export function Empty({ title, body, action }) {
  return (
    <div className="empty">
      <div style={{ display: 'grid', placeItems: 'center', marginBottom: 10, color: 'var(--brand)' }}><IconMedia size={30} /></div>
      <b>{title}</b>
      <p style={{ maxWidth: 420, margin: '0 auto' }}>{body}</p>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

export function PostRow({ post, onEdit, onDelete, onPublish, publishing, onDuplicate, onReschedule, onRescheduleNextBest }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  useEffect(() => {
    if (!menuOpen) return undefined
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false) }
    const onDoc = (e) => { if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDoc)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDoc)
    }
  }, [menuOpen])
  const act = (fn, arg) => () => { setMenuOpen(false); if (fn) fn(post, arg) }
  const hasMenu = Boolean(onDuplicate || onReschedule || onRescheduleNextBest || onEdit || onDelete)
  return (
    <div className="post-row">
      <Thumb post={post} />
      <div className="post-body">
        <div className="post-badges">
          <StatusBadge status={post.status} />
          <PlatformBadge platform={post.platform} />
          <span className="badge brand">{post.format || 'REELS'}</span>
          {post.liveUrl && <a className="badge neutral" href={post.liveUrl} target="_blank" rel="noreferrer">Live ↗</a>}
        </div>
        <p>{post.caption || <span className="muted">No caption</span>}</p>
        <div className="post-meta">
          <span>{fmtDateTime(post.scheduleTime)}</span>
          {post.hashtags && <span>{post.hashtags}</span>}
          {post.cta && <span>CTA: {post.cta}</span>}
        </div>
        <div className="post-foot">
          {post.status !== 'published' && (
            <button type="button" className="btn primary small" disabled={publishing} onClick={() => onPublish && onPublish(post)}>
              {publishing ? 'Publishing…' : 'Publish now'}
            </button>
          )}
          {hasMenu && (
            <div className="post-menu-wrap" ref={menuRef}>
              <button type="button" className="btn ghost small post-menu-btn" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>⋯</button>
              {menuOpen && (
                <div className="post-menu" role="menu">
                  {onDuplicate && <button type="button" role="menuitem" onClick={act(onDuplicate)}>Duplicate</button>}
                  {onReschedule && post.status !== 'published' && <button type="button" role="menuitem" onClick={act(onReschedule, { addDays: 1 })}>+1 day</button>}
                  {onRescheduleNextBest && post.status !== 'published' && <button type="button" role="menuitem" onClick={act(onRescheduleNextBest)}>Next best time</button>}
                  {onEdit && <button type="button" role="menuitem" onClick={act(onEdit)}>Edit</button>}
                  {onDelete && <button type="button" role="menuitem" className="danger" onClick={act(onDelete)}>Delete</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
