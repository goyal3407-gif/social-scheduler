import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react'
import { registerOverlayCloser } from '../overlayRegistry.js'
import { openExternalUrl } from '../openExternal.js'
import { fmtDateTime } from '../api.js'
import { trFor, dictSync } from '../i18n.js'
import { IconInstagram, IconPlay, IconQueue, IconWarn, IconYouTube } from './icons.jsx'
import BottomSheet from './BottomSheet.jsx'

// These shared pieces receive no tr prop (they render inside Queue,
// Calendar and Dashboard alike), so they translate from the same
// sources App uses: the persisted language + the lazily loaded full
// dictionary (dictSync is warm by the time any row renders; the CORE
// set covers the badge words even before it lands).
// Published-post links (Phase 3 Batch C — audit H-05): inside the
// app they open in the system browser; on the web they keep
// their normal new-tab behaviour.
const extLink = (url) => ({
  href: url, target: '_blank', rel: 'noreferrer',
  onClick: (e) => { if (openExternalUrl(url)) e.preventDefault() },
})

function localTr() {
  let lang = 'en'
  try { lang = localStorage.getItem('ss-lang') || 'en' } catch { /* storage unavailable */ }
  return trFor(lang, dictSync())
}

const STATUS_KEYS = { scheduled: 'scheduled', draft: 'drafts', published: 'published', partial: 'partial', failed: 'failed' }

export function Logo({ size = 40, className = '' }) {
  return (
    <span className={`logo-wrap${className ? ` ${className}` : ''}`} aria-hidden="true">
      <img src="/logo-mark.png" alt="" className="logo-img-light" style={{ height: size, width: 'auto' }} />
      <img src="/logo-mark-dark.png" alt="" className="logo-img-dark" style={{ height: size, width: 'auto' }} />
    </span>
  )
}

export function Badge({ tone = 'neutral', icon, children, className = '' }) {
  return <span className={`badge ${tone}${className ? ` ${className}` : ''}`}>{icon}{children}</span>
}

export function StatusBadge({ status, icon }) {
  const t = localTr()
  const s = status || 'draft'
  return <span className={`badge ${s}`}>{icon}{STATUS_KEYS[s] ? t(STATUS_KEYS[s]) : s}</span>
}

export function PlatformBadge({ platform, icon }) {
  return <span className="badge neutral">{icon}{platform || 'Instagram'}</span>
}

export function StatusChip({ platform = 'instagram', state = 'off', label }) {
  const t = localTr()
  const isYt = platform === 'youtube'
  const PlatformIcon = isYt ? IconYouTube : IconInstagram
  const stateWord = state === 'connected' ? t('connected') : state === 'checking' ? t('checkingWord') : t('notConnected')
  const text = label || `${isYt ? 'YouTube' : 'Instagram'} · ${stateWord}`
  return (
    <span className={`conn-chip status-chip ${state}`}>
      <PlatformIcon size={15} />
      <span>{text}</span>
      {state !== 'checking' && <span className={`dot${state === 'connected' ? '' : ' off'}`} aria-hidden="true" />}
    </span>
  )
}

export function Button({ variant = 'secondary', size, loading = false, disabled = false, reason, className = '', children, type = 'button', ...rest }) {
  const variantClass = variant === 'primary' ? ' primary' : variant === 'danger' || variant === 'danger-fill' ? ' danger-fill' : variant === 'tertiary' ? ' tertiary' : variant === 'ghost' ? ' ghost' : ''
  const btn = (
    <button type={type} className={`btn${variantClass}${size === 'small' ? ' small' : ''}${className ? ` ${className}` : ''}`} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading && <span className="btn-spinner" aria-hidden="true" />}
      {children}
    </button>
  )
  if (disabled && reason) return <span className="btn-wrap">{btn}<span className="btn-reason">{reason}</span></span>
  return btn
}

export function Card({ children, className = '', ...rest }) {
  return <div className={`card${className ? ` ${className}` : ''}`} {...rest}>{children}</div>
}

export function Field({ id, label, helper, error, children, className = '', ...inputProps }) {
  const helperId = helper && id ? `${id}-help` : undefined
  const errorId = error && id ? `${id}-err` : undefined
  const describedBy = [helperId, errorId].filter(Boolean).join(' ') || undefined
  const a11y = { id, 'aria-invalid': error ? true : undefined, 'aria-describedby': describedBy }
  const control = isValidElement(children)
    ? cloneElement(children, { ...a11y, id: children.props.id || id })
    : <input {...a11y} {...inputProps} />
  return (
    <div className={`field${error ? ' has-error' : ''}${className ? ` ${className}` : ''}`}>
      {label && <label htmlFor={id}>{label}</label>}
      {control}
      {helper && <p className="field-helper" id={helperId}>{helper}</p>}
      {error && <p className="field-error-msg" id={errorId} role="alert"><IconWarn size={14} /><span>{error}</span></p>}
    </div>
  )
}

export function Segmented({ options = [], value, onChange, ariaLabel }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={`seg-btn${value === o.value ? ' active' : ''}`} onClick={() => onChange && onChange(o.value)}>
          {o.icon}{o.label}
        </button>
      ))}
    </div>
  )
}

export const Sheet = BottomSheet

export function FilterSheet({ open, onClose, title, children, onApply, onClear, applyLabel, clearLabel }) {
  const t = localTr()
  if (!open) return null
  return (
    <BottomSheet title={title} onClose={onClose}>
      {children}
      <div className="filter-sheet-actions">
        {onClear && <button type="button" className="btn ghost" onClick={onClear}>{clearLabel || t('clearFilters')}</button>}
        {onApply && <button type="button" className="btn primary" onClick={onApply}>{applyLabel || t('filterApply')}</button>}
      </div>
    </BottomSheet>
  )
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
  const t = localTr()
  if (!error) return null
  return (
    <div className="alert error" role="alert">
      <span style={{ flex: 'none', marginTop: 1, fontWeight: 800 }}>!</span>
      <div style={{ flex: 1 }}>
        <b>{t('errorBoxTitle')}</b> {String(error.message || error)}
        {onRetry && <div style={{ marginTop: 8 }}><button type="button" className="btn ghost small" onClick={onRetry}>{t('retry')}</button></div>}
      </div>
    </div>
  )
}

export function Empty({ title, body, action, icon }) {
  const ArtIcon = typeof icon === 'function' ? icon : null
  return (
    <div className="empty">
      <div className="empty-art" aria-hidden="true"><span style={{ color: 'var(--gold-text)', display: 'grid', placeItems: 'center' }}>{ArtIcon ? <ArtIcon size={30} /> : icon || <IconQueue size={30} />}</span></div>
      <b>{title}</b>
      {body && <p style={{ maxWidth: 420, margin: '0 auto' }}>{body}</p>}
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
  const t = localTr()
  const s = String(error || '')
  if (/not connected|no longer connected|connect Instagram/i.test(s)) return { text: t('ffNotConnected'), fix: 'reconnect' }
  if (/token|session|OAuth|expired|revoked|authoriz/i.test(s)) return { text: t('ffLoginEnded'), fix: 'reconnect' }
  if (/permission|scope|not authorized|does not have/i.test(s)) return { text: t('ffPermission'), fix: 'reconnect' }
  if (/rate|too many|throttl|limit/i.test(s)) return { text: t('ffRate'), fix: '' }
  if (/could not be prepared|not reachable|unreachable|fetch|network|reach Instagram/i.test(s)) return { text: t('ffMediaReach'), fix: '' }
  if (/format|process this media|H\.264|codec/i.test(s)) return { text: t('ffFormat'), fix: '' }
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
  const t = localTr()
  if (!post) return null
  if (post.status === 'failed' && !post.retryPending) {
    const friendly = friendlyFailure(post.lastPublishError)
    return (
      <div className="post-tracker failed">
        <span className="trk-fail-dot" aria-hidden="true" />
        <span>
          {t('failed')}{friendly.text ? ` — ${friendly.text}` : ''}
          {friendly.fix === 'reconnect' && onReconnect && (
            <button type="button" className="btn ghost small" style={{ marginLeft: 8 }} onClick={() => onReconnect()}>{t('reconnectInstagram')}</button>
          )}
          {post.lastPublishError && (
            <details style={{ display: 'inline-block', marginLeft: 8 }}>
              <summary className="small" style={{ cursor: 'pointer', display: 'inline' }}>{t('detailsWord')}</summary>
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
  const steps = [t('trkScheduled'), t('trkPublishing'), t('trkLive')]
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
        ? <>{t('ytAlsoOn')} <a className="trk-live" {...extLink(`https://www.youtube.com/watch?v=${post.youtubeVideoId}`)}>{t('ytWatchPrivate')}</a></>
        : post.youtubeStatus === 'failed'
          ? t('ytUploadFailed')
          : post.youtubeStatus === 'skipped'
            ? t('ytSkipped')
            : t('ytPosting')}
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
        <span className="trk done"><span className="trk-dot" aria-hidden="true" />{t('trkLive')}</span>
        <span className="trk-note">
          {t('partialLine').replace('{live}', names(live)).replace('{failed}', names(failedT))}{retrying ? ` ${t('partialRetryNote')}` : ''}
        </span>
        {live[0]?.liveUrl && <a className="trk-live" {...extLink(live[0].liveUrl)}>{t('viewOnInstagram')}</a>}
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
      {post.status === 'failed' && post.retryPending && <span className="trk-note">{t('autoRetryPending')}</span>}
      {published && post.liveUrl && <a className="trk-live" {...extLink(post.liveUrl)}>{ytOnly ? t('viewOnYouTube') : t('viewOnInstagram')}</a>}
      {ytNote}
    </div>
  )
}

export function PostRow({ post, onEdit, onDelete, onPublish, publishing, onDuplicate, onPostAgain, onReschedule, onRescheduleNextBest, onReconnect, onRetry, retrying }) {
  const t = localTr()
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef(null)
  // Phase 3 (Batch B): while this menu is open it is the topmost
  // overlay — the Android back handler closes it before navigating.
  useEffect(() => {
    if (!menuOpen) return undefined
    return registerOverlayCloser(() => setMenuOpen(false))
  }, [menuOpen])
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
          {post.repeat === 'weekly' && <span className="badge neutral" title={t('repeatsWeeklyTitle')}>{t('repeatsWeekly')}</span>}
          {post.liveUrl && <a className="badge neutral" {...extLink(post.liveUrl)}>{t('liveBadge')}</a>}
          {targets.length > 1 && targets.map((t) => {
            const mark = t.status === 'published' ? '✓' : t.status === 'failed' ? '✗' : t.status === 'publishing' ? '…' : '•'
            const label = `@${t.username || t.igUserId || 'account'} ${mark}`
            return t.status === 'published' && t.liveUrl
              ? <a key={t.igUserId || label} className="badge neutral" {...extLink(t.liveUrl)}>{label}</a>
              : <span key={t.igUserId || label} className="badge neutral">{label}</span>
          })}
        </div>
        <p>{post.caption || <span className="muted">{t('noCaption')}</span>}</p>
        <div className="post-meta">
          <span>{fmtDateTime(post.scheduleTime)}</span>
          {post.hashtags && <span>{post.hashtags}</span>}
          {post.cta && <span>CTA: {post.cta}</span>}
        </div>
        <StatusTracker post={post} publishing={publishing} onReconnect={onReconnect} />
        <div className="post-foot">
          {post.status !== 'published' && (
            <button type="button" className="btn primary small" disabled={publishing} onClick={() => onPublish && onPublish(post)}>
              {publishing ? t('publishingWord') : t('publishNow')}
            </button>
          )}
          {onRetry && (post.status === 'failed' || post.status === 'partial') && (
            <button type="button" className="btn ghost small" disabled={retrying} onClick={() => onRetry(post)} title={t('retryTitle')}>
              {retrying ? t('retrying') : t('retry')}
            </button>
          )}
          {hasMenu && (
            <div className="post-menu-wrap" ref={menuRef}>
              <button type="button" className="btn ghost small post-menu-btn" aria-label={t('moreActions')} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>⋯</button>
              {menuOpen && (
                <div className="post-menu" role="menu">
                  {onPostAgain && <button type="button" role="menuitem" onClick={act(onPostAgain)}>{t('postAgain')}</button>}
                  {onDuplicate && <button type="button" role="menuitem" onClick={act(onDuplicate)}>{t('duplicate')}</button>}
                  {onReschedule && post.status !== 'published' && <button type="button" role="menuitem" onClick={act(onReschedule, { addDays: 1 })}>{t('plusOneDay')}</button>}
                  {onRescheduleNextBest && post.status !== 'published' && <button type="button" role="menuitem" onClick={act(onRescheduleNextBest)}>{t('nextBestTimeBtn')}</button>}
                  {onEdit && <button type="button" role="menuitem" onClick={act(onEdit)}>{t('edit')}</button>}
                  {onDelete && <button type="button" role="menuitem" className="danger" onClick={act(onDelete)}>{t('delete')}</button>}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
