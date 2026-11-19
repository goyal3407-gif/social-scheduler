import { useEffect, useRef, useState } from 'react'
import { fmtDateTime } from '../api.js'
import { IconPlay } from './icons.jsx'

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

export function Skeleton({ rows = 3, variant = 'rows' }) {
  if (variant === 'posts') {
    return (
      <div aria-hidden="true">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="skel-post">
            <div className="skel" style={{ width: 56, height: 76, flex: 'none' }} />
            <div className="skel-lines">
              <div className="skel" style={{ height: 14, width: '38%' }} />
              <div className="skel" style={{ height: 14, width: '82%' }} />
              <div className="skel" style={{ height: 12, width: '55%' }} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (variant === 'calendar') {
    return (
      <div className="skel-cal" aria-hidden="true">
        {Array.from({ length: 35 }).map((_, i) => <div key={i} className="skel" />)}
      </div>
    )
  }
  if (variant === 'media') {
    return (
      <div className="media-grid" aria-hidden="true">
        {Array.from({ length: rows * 2 }).map((_, i) => <div key={i} className="skel skel-media" />)}
      </div>
    )
  }
  return (
    <div aria-hidden="true">
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
      <div className="empty-art" aria-hidden="true"><img src="/icon-192.png" alt="" width="42" height="42" /></div>
      <b>{title}</b>
      <p style={{ maxWidth: 420, margin: '0 auto' }}>{body}</p>
      {action && <div style={{ marginTop: 14 }}>{action}</div>}
    </div>
  )
}

/**
 * One-line progress for a post, derived only from its stored fields:
 * scheduled/draft sit on step 1; a publish attempt in flight (the
 * caller is publishing it, a container is processing, or an automatic
 * retry is pending) lights step 2; published completes all three and
 * links out. A failed post with no retry pending shows a failed state
 * instead of pretending to progress.
 */
// Plain-language failure explanations (Phase C5) — the same mapping
// the server applies to failure notifications (friendlyFailureText in
// server.js; keep the two in step). fix: 'reconnect' when reconnecting
// Instagram is the remedy.
export function friendlyFailure(error) {
  const s = String(error || '')
  if (/not connected|no longer connected|connect Instagram/i.test(s)) return { text: 'The Instagram account for this post is not connected.', fix: 'reconnect' }
  if (/token|session|OAuth|expired|revoked|authoriz/i.test(s)) return { text: 'Instagram ended the login for this account.', fix: 'reconnect' }
  if (/permission|scope|not authorized|does not have/i.test(s)) return { text: 'Instagram did not give this app permission for that action.', fix: 'reconnect' }
  if (/rate|too many|throttl|limit/i.test(s)) return { text: 'Instagram is rate-limiting right now — wait a while, then publish again.', fix: '' }
  if (/could not be prepared|not reachable|unreachable|fetch|network|reach Instagram/i.test(s)) return { text: 'The media file could not be reached or prepared — re-upload it from the Media Library.', fix: '' }
  if (/format|process this media|H\.264|codec/i.test(s)) return { text: 'Instagram could not process this media file — a standard MP4 (H.264) or JPG works best.', fix: '' }
  return { text: '', fix: '' }
}

/**
 * A post's Instagram targets as the UI reads them: the stored
 * igTargets list when present, else a one-element list synthesized
 * from the legacy single-account fields (older posts).
 */
export function targetsOfPost(post) {
  if (!post) return []
  if (Array.isArray(post.igTargets) && post.igTargets.length) return post.igTargets
  return [{
    igUserId: post.igAccountId || '', username: post.igAccountUsername || '',
    status: post.status === 'published' ? 'published' : post.status === 'failed' ? 'failed' : 'pending',
    liveUrl: post.liveUrl || '', retryPending: !!post.retryPending,
  }]
}

export function StatusTracker({ post, publishing, onReconnect }) {
  if (!post) return null
  if (post.status === 'failed' && !post.retryPending) {
    const friendly = friendlyFailure(post.lastPublishError)
    return (
      <div className="post-tracker failed">
        <span className="trk-fail-dot" aria-hidden="true" />
        <span>
          Failed{friendly.text ? ` — ${friendly.text}` : ''}
          {friendly.fix === 'reconnect' && onReconnect && (
            <button type="button" className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => onReconnect()}>Reconnect Instagram</button>
          )}
          {post.lastPublishError && (
            <details style={{ display: 'inline-block', marginLeft: 8 }}>
              <summary className="small" style={{ cursor: 'pointer', display: 'inline' }}>Details</summary>
              <span className="small" style={{ display: 'block', marginTop: 4 }}>{post.lastPublishError}</span>
            </details>
          )}
        </span>
      </div>
    )
  }
  const published = post.status === 'published'
  const inFlight = Boolean(publishing || post.containerId || post.retryPending)
  const step = published ? 3 : inFlight ? 2 : 1
  const steps = ['Scheduled', 'Publishing', 'Live']
  // The wording follows the platforms the post actually used: a
  // YouTube-only post (Instagram unticked) went live on YouTube — its
  // liveUrl IS the watch URL — so it gets YouTube wording and no
  // "also on YouTube" side note; with Instagram ticked, the main line
  // stays Instagram and YouTube rides along as the side note.
  const ytOnly = post.igEnabled === false
  const ytOn = Boolean(post.youtube && post.youtube.enabled)
  const ytNote = ytOn && !ytOnly ? (
    <span className="trk-note" title={post.youtubeError || undefined}>
      {post.youtubeStatus === 'uploaded' && post.youtubeVideoId
        ? <>· also on YouTube: <a className="trk-live" href={`https://www.youtube.com/watch?v=${post.youtubeVideoId}`} target="_blank" rel="noreferrer">watch (private)</a></>
        : post.youtubeStatus === 'failed'
          ? '· YouTube: upload failed — Instagram is live'
          : post.youtubeStatus === 'skipped'
            ? '· YouTube: skipped (videos only)'
            : '· also on YouTube: posting'}
    </span>
  ) : null
  // Partial (multi-target): live on some ticked accounts, failed on
  // others. Name both sides so the owner sees exactly what happened;
  // single-account posts never take this branch.
  const targets = targetsOfPost(post)
  if (post.status === 'partial' && targets.length > 1) {
    const live = targets.filter((t) => t.status === 'published')
    const failedT = targets.filter((t) => t.status === 'failed')
    const retrying = failedT.some((t) => t.retryPending)
    const names = (list) => list.map((t) => `@${t.username || t.igUserId || 'account'}`).join(', ')
    return (
      <div className="post-tracker" aria-label="Status: live on some accounts">
        <span className="trk done"><span className="trk-dot" aria-hidden="true" />Live</span>
        <span className="trk-note">
          Partial — live on {names(live)}; failed on {names(failedT)}{retrying ? ' — auto-retry pending for the failed account.' : ''}
        </span>
        {live[0]?.liveUrl && <a className="trk-live" href={live[0].liveUrl} target="_blank" rel="noreferrer">View on Instagram</a>}
        {ytNote}
      </div>
    )
  }
  return (
    <div className="post-tracker" aria-label={`Status: ${published ? (ytOnly ? 'live on YouTube' : 'live on Instagram') : inFlight ? 'publishing' : 'scheduled'}`}>
      {steps.map((label, i) => {
        const n = i + 1
        const cls = n < step || published ? 'done' : n === step ? 'now' : ''
        return (
          <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {i > 0 && <span className={`trk-line ${n <= step || published ? 'done' : ''}`} aria-hidden="true" />}
            <span className={`trk ${cls}`}><span className="trk-dot" aria-hidden="true" />{label}</span>
          </span>
        )
      })}
      {post.status === 'failed' && post.retryPending && <span className="trk-note">auto-retry pending</span>}
      {published && post.liveUrl && <a className="trk-live" href={post.liveUrl} target="_blank" rel="noreferrer">{ytOnly ? 'View on YouTube' : 'View on Instagram'}</a>}
      {ytNote}
    </div>
  )
}

export function PostRow({ post, onEdit, onDelete, onPublish, publishing, onDuplicate, onPostAgain, onReschedule, onRescheduleNextBest, onReconnect }) {
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
  const hasMenu = Boolean(onDuplicate || onPostAgain || onReschedule || onRescheduleNextBest || onEdit || onDelete)
  // One chip per ticked Instagram account (multi-target posts only):
  // @name ✓ live / ✗ failed / … publishing / • waiting.
  const targets = targetsOfPost(post)
  return (
    <div className="post-row">
      <Thumb post={post} />
      <div className="post-body">
        <div className="post-badges">
          <StatusBadge status={post.status} />
          <PlatformBadge platform={post.platform} />
          <span className="badge brand">{post.format || 'REELS'}</span>
          {post.repeat === 'weekly' && <span className="badge neutral" title="This post repeats weekly — publishing it schedules the next one automatically">Repeats weekly</span>}
          {post.liveUrl && <a className="badge neutral" href={post.liveUrl} target="_blank" rel="noreferrer">Live ↗</a>}
          {targets.length > 1 && targets.map((t) => {
            const mark = t.status === 'published' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'publishing' ? '…' : '•'
            const label = `@${t.username || t.igUserId || 'account'} ${mark}`
            return t.status === 'published' && t.liveUrl
              ? <a key={t.igUserId || label} className="badge neutral" href={t.liveUrl} target="_blank" rel="noreferrer">{label}</a>
              : <span key={t.igUserId || label} className="badge neutral">{label}</span>
          })}
        </div>
        <p>{post.caption || <span className="muted">No caption</span>}</p>
        <div className="post-meta">
          <span>{fmtDateTime(post.scheduleTime)}</span>
          {post.hashtags && <span>{post.hashtags}</span>}
          {post.cta && <span>CTA: {post.cta}</span>}
        </div>
        <StatusTracker post={post} publishing={publishing} onReconnect={onReconnect} />
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
                  {onPostAgain && <button type="button" role="menuitem" onClick={act(onPostAgain)}>Post again</button>}
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
