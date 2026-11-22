import { useEffect, useState } from 'react'
import { api, openInstagramConnect, openInstagramDirectConnect } from '../api.js'

// The full Instagram connection card — the single home for the
// connect / set-default / disconnect logic. Rendered on the
// Connections page; Settings shows only a summary + link here so the
// logic exists exactly once.
export default function InstagramCard({ settings, onInstagramChanged, tr }) {
  const t = tr || ((k) => k)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [connectBusy, setConnectBusy] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)

  // Connection health comes from the server (instagramHealth): the token's
  // real expiry from Meta, and whether the keeper has renewed it. The app
  // renews the token automatically before it expires — the user only has
  // to act if Meta has actually revoked the connection (needsReconnect).
  const health = settings?.instagramHealth || null
  const healthUntil = health?.tokenExpiresAt ? new Date(health.tokenExpiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null
  const healthRenewed = health?.lastRefreshAt ? new Date(health.lastRefreshAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null

  const connected = Boolean(settings?.instagramConnected)
  const username = settings?.instagramUsername || ''
  const igAccounts = Array.isArray(settings?.instagramAccounts) ? settings.instagramAccounts : []

  // The Meta login finishes in the system browser (in the app) or in
  // this tab's past — either way, when the user comes BACK to this
  // screen, refresh the connection state so it flips to "Connected" on
  // its own, with no manual reload.
  useEffect(() => {
    if (!onInstagramChanged) return undefined
    const refresh = () => { onInstagramChanged() }
    const onVisible = () => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', refresh)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', refresh)
    }
  }, [onInstagramChanged])

  const startConnect = async () => {
    setErr(''); setMsg('')
    setConnectBusy(true)
    try {
      await openInstagramDirectConnect()
      // In the app, the Instagram login is now open in the system
      // browser and this screen stays put; in a web browser this tab
      // has navigated away. The focus/visibility refresh above updates
      // the status when the user returns.
      setMsg(t('msgIgOpened'))
    } finally { setConnectBusy(false) }
  }

  const startFacebookConnect = async () => {
    setErr(''); setMsg('')
    setConnectBusy(true)
    try {
      await openInstagramConnect()
      setMsg(t('msgFbOpened'))
    } finally { setConnectBusy(false) }
  }

  const disconnect = async (igUserId, uname) => {
    setErr(''); setMsg('')
    setDisconnecting(true)
    try {
      const res = await api.disconnectInstagram(igUserId)
      setMsg(res.instagramConnected
        ? t('msgDisconnectedOne').replace('{name}', uname || t('msgDisconnectedThat'))
        : t('msgDisconnected'))
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || t('errDisconnect'))
    } finally { setDisconnecting(false) }
  }

  const makeDefault = async (igUserId) => {
    setErr(''); setMsg('')
    try {
      await api.setDefaultInstagramAccount(igUserId)
      setMsg(t('msgDefaultUpdated'))
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || t('errSetDefault'))
    }
  }

  return (
    <div className="card">
      <h2>Instagram</h2>
      <p className="muted small" style={{ marginTop: 8 }}>
        {t('statusWord')} <b style={{ color: 'var(--ink)' }}>{connected ? (username ? t('statusConnectedAs').replace('{name}', username) : t('connected')) : t('notConnected')}</b>
      </p>
      {connected && health && !health.needsReconnect && (
        <p className="muted small" style={{ marginTop: 8 }}>
          {health.tokenNeverExpires
            ? t('healthNever')
            : healthUntil
              ? <>{t('healthValidUntil')} <b style={{ color: 'var(--ink)' }}>{healthUntil}</b>{health.daysRemaining !== null ? ` ${t('healthDaysPart').replace('{n}', health.daysRemaining)}` : ''} {t('healthRenews')}</>
              : t('healthAuto')}
          {healthRenewed ? ` ${t('healthLastRenewed').replace('{date}', healthRenewed)}` : ''}
        </p>
      )}
      {connected && health?.needsReconnect && (
        <div className="alert error" style={{ marginTop: 12 }}><b>{t('igEndedTitle')}</b> {t('igEndedBody')}</div>
      )}
      {connected && health?.refreshBlocked && !health.needsReconnect && (
        <div className="warn amber" style={{ marginTop: 12 }}><div><b>{t('renewalBlockedTitle')}</b> {t('renewalBlockedBody')}{(health.lastDebugError || health.lastRefreshError) ? <> {t('metaReason')} <i>{health.lastRefreshError || health.lastDebugError}</i></> : ''}</div></div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>
        {t('igExplainA')} <b style={{ color: 'var(--ink)' }}>{t('igExplainBold')}</b>{t('igExplainB')}
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={connectBusy} onClick={startConnect}>
          {connectBusy ? t('openingIgLogin') : connected ? t('connectAnother') : t('checkConnect')}
        </button>
        <button type="button" className="btn ghost" disabled={connectBusy} onClick={startFacebookConnect}>
          {t('connectViaFb')}
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        {t('fbExplain')}
      </p>
      {igAccounts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 8 }}>{t('connectedAccounts')}</h3>
          {igAccounts.map((a) => {
            const broken = !!a.health?.needsReconnect
            return (
            <div key={a.igUserId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--line)', ...(broken ? { background: 'var(--red-soft)', borderRadius: 10, padding: '10px 12px', borderTop: 'none', marginTop: 6 } : {}) }}>
              <b style={{ color: 'var(--ink)' }}>@{a.username || a.igUserId}</b>
              {a.isDefault
                ? <span className="badge brand">{t('defaultBadge')}</span>
                : <button type="button" className="btn ghost small" onClick={() => makeDefault(a.igUserId)}>{t('setAsDefault')}</button>}
              {broken
                ? <span className="small" style={{ color: 'var(--red-text)', fontWeight: 700 }}>{t('accountBrokenNote')}</span>
                : <span className="muted small">{a.health?.tokenNeverExpires ? t('neverExpires') : t('autoRenews')}</span>}
              {broken && <button type="button" className="btn small" disabled={connectBusy} onClick={startConnect}>{connectBusy ? t('openingShort') : t('reconnect')}</button>}
              <button type="button" className="btn danger small" disabled={disconnecting} onClick={() => disconnect(a.igUserId, a.username)} style={{ marginLeft: 'auto' }}>
                {disconnecting ? t('disconnectingWord') : t('disconnectWord')}
              </button>
            </div>
            )
          })}
          <p className="muted small" style={{ marginTop: 8 }}>{t('accountsNote')}</p>
        </div>
      )}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
    </div>
  )
}
