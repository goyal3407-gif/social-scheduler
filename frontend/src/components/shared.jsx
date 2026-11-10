import { fmtDateTime } from '../api.js'
import { IconPlay, IconMedia } from './icons.jsx'

export function StatusBadge({ status }) {
  return <span className={`badge ${status || 'draft'}`}>{status || 'draft'}</span>
}

export function PlatformBadge({ platform }) {
  return <span className="badge neutral">{platform || 'Instagram'}</span>
}

export function Thumb({ post }) {
  if (post?.mediaUrl) {
    if (post.mediaType === 'image') return <img className="thumb" src={post.mediaUrl} alt="" loading="lazy" />
    return <video className="thumb" src={post.mediaUrl} muted playsInline preload="metadata" />
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

export function PostRow({ post, onEdit, onDelete, onPublish, publishing }) {
  return (
    <div className="post-row">
      <Thumb post={post} />
      <div className="post-body">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
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
      </div>
      <div className="post-actions">
        {post.status !== 'published' && (
          <button type="button" className="btn primary small" disabled={publishing} onClick={() => onPublish && onPublish(post)}>
            {publishing ? 'Publishing…' : 'Publish now'}
          </button>
        )}
        <button type="button" className="btn ghost small" onClick={() => onEdit && onEdit(post)}>Edit</button>
        <button type="button" className="btn danger small" onClick={() => onDelete && onDelete(post)}>Delete</button>
      </div>
    </div>
  )
}
