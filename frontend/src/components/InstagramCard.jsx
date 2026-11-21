import { useEffect, useState } from 'react'
import { api, openInstagramConnect, openInstagramDirectConnect } from '../api.js'

// The full Instagram connection card — the single home for the
// connect / set-default / disconnect logic. Rendered on the
// Connections page; Settings shows only a summary + link here so the
// logic exists exactly once.
export default function InstagramCard({ settings, onInstagramChanged }) {
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
      setMsg('Instagram login opened — approve access there, then come back here. This screen updates itself when you return.')
    } finally { setConnectBusy(false) }
  }

  const startFacebookConnect = async () => {
    setErr(''); setMsg('')
    setConnectBusy(true)
    try {
      await openInstagramConnect()
      setMsg('Facebook login opened — approve access there, then come back here. This screen updates itself when you return.')
    } finally { setConnectBusy(false) }
  }

  const disconnect = async (igUserId, uname) => {
    setErr(''); setMsg('')
    setDisconnecting(true)
    try {
      const res = await api.disconnectInstagram(igUserId)
      setMsg(res.instagramConnected
        ? `@${uname || 'That account'} disconnected. Your other Instagram accounts stay connected.`
        : 'Instagram disconnected.')
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || 'Could not disconnect.')
    } finally { setDisconnecting(false) }
  }

  const makeDefault = async (igUserId) => {
    setErr(''); setMsg('')
    try {
      await api.setDefaultInstagramAccount(igUserId)
      setMsg('Default Instagram account updated — new posts will use it.')
      if (onInstagramChanged) onInstagramChanged()
    } catch (e2) {
      setErr(e2.message || 'Could not set the default account.')
    }
  }

  return (
    <div className="card">
      <h2>Instagram</h2>
      <p className="muted small" style={{ marginTop: 8 }}>
        Status: <b style={{ color: 'var(--ink)' }}>{connected ? `Connected${username ? ` as @${username}` : ''}` : 'Not connected'}</b>
      </p>
      {connected && health && !health.needsReconnect && (
        <p className="muted small" style={{ marginTop: 8 }}>
          {health.tokenNeverExpires
            ? 'This connection does not expire — no renewal needed, ever.'
            : healthUntil
              ? <>Valid until <b style={{ color: 'var(--ink)' }}>{healthUntil}</b>{health.daysRemaining !== null ? ` (${health.daysRemaining} days)` : ''} — and it <b style={{ color: 'var(--ink)' }}>renews itself automatically</b> before that date. You never need to reconnect.</>
              : 'This connection renews itself automatically — you never need to reconnect.'}
          {healthRenewed ? ` Last auto-renewed ${healthRenewed}.` : ''}
        </p>
      )}
      {connected && health?.needsReconnect && (
        <div className="alert error" style={{ marginTop: 12 }}><b>Instagram ended this connection.</b> Meta revoked it (for example a password change, or access removed in your Meta settings), so automatic renewal can&apos;t save it. Use the Connect Instagram button below to log in again — that&apos;s the only time you ever need to reconnect.</div>
      )}
      {connected && health?.refreshBlocked && !health.needsReconnect && (
        <div className="warn amber" style={{ marginTop: 12 }}><div><b>Automatic renewal could not run for this connection.</b> The app will keep checking, but if it reaches its expiry date you will need to reconnect once with the button below.{(health.lastDebugError || health.lastRefreshError) ? <> Meta&apos;s reason: <i>{health.lastRefreshError || health.lastDebugError}</i></> : ''}</div></div>
      )}
      <p className="muted small" style={{ marginTop: 14 }}>
        One login with Instagram. Instagram opens its own login page, you approve access once, and from then on the connection <b style={{ color: 'var(--ink)' }}>renews itself automatically</b>. Your Instagram must be a Business or Creator account — no Facebook account needed.
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
        <button type="button" className="btn primary" disabled={connectBusy} onClick={startConnect}>
          {connectBusy ? 'Opening Instagram login…' : connected ? 'Connect another Instagram account' : 'Connect Instagram'}
        </button>
        <button type="button" className="btn ghost" disabled={connectBusy} onClick={startFacebookConnect}>
          or connect via Facebook
        </button>
      </div>
      <p className="muted small" style={{ marginTop: 10 }}>
        Connecting via Facebook uses Meta&apos;s Facebook login instead, and needs your Instagram linked to a Facebook Page.
      </p>
      {igAccounts.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <h3 style={{ marginBottom: 8 }}>Connected accounts</h3>
          {igAccounts.map((a) => {
            const broken = !!a.health?.needsReconnect
            return (
            <div key={a.igUserId} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--line)', ...(broken ? { background: 'var(--red-soft)', borderRadius: 10, padding: '10px 12px', borderTop: 'none', marginTop: 6 } : {}) }}>
              <b style={{ color: 'var(--ink)' }}>@{a.username || a.igUserId}</b>
              {a.isDefault
                ? <span className="badge brand">Default</span>
                : <button type="button" className="btn ghost small" onClick={() => makeDefault(a.igUserId)}>Set as default</button>}
              {broken
                ? <span className="small" style={{ color: 'var(--red)', fontWeight: 700 }}>Connection broken — posts for this account can&apos;t publish</span>
                : <span className="muted small">{a.health?.tokenNeverExpires ? 'Never expires' : 'Auto-renews'}</span>}
              {broken && <button type="button" className="btn primary small" disabled={connectBusy} onClick={startConnect}>{connectBusy ? 'Opening…' : 'Reconnect'}</button>}
              <button type="button" className="btn danger small" disabled={disconnecting} onClick={() => disconnect(a.igUserId, a.username)} style={{ marginLeft: 'auto' }}>
                {disconnecting ? 'Disconnecting…' : 'Disconnect'}
              </button>
            </div>
            )
          })}
          <p className="muted small" style={{ marginTop: 8 }}>Each post publishes to the account you pick in the Studio. Disconnecting one account never touches the others — posts scheduled for a disconnected account fail with a clear message instead of posting to the wrong profile.</p>
        </div>
      )}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
    </div>
  )
}
