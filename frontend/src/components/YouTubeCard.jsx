import { useCallback, useEffect, useState } from 'react'
import { api, openYouTubeConnect } from '../api.js'

// The YouTube connection card (Phase B) — lives on the Connections
// page. "Connect YouTube" is a CHANNEL connection through Google's own
// OAuth page; it is not app sign-in (the app login stays
// email/password). When the server has no Google client configured,
// the card says so plainly and offers no connect button.
export default function YouTubeCard() {
  const [status, setStatus] = useState(null)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setStatus(await api.youtubeStatus()) } catch { setStatus({ configured: false, connected: false }) }
  }, [])

  useEffect(() => { load() }, [load])

  // The Google login finishes in the system browser / another tab —
  // refresh the state when the user comes back to this screen.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', load)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', load)
    }
  }, [load])

  const startConnect = async () => {
    setErr(''); setMsg('')
    setBusy(true)
    try {
      await openYouTubeConnect()
      setMsg('Google login opened — pick the account that owns your YouTube channel and approve access, then come back here. This screen updates itself when you return.')
    } catch (e) {
      setErr(e.message || 'Could not open the Google login.')
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setErr(''); setMsg('')
    setBusy(true)
    try {
      await api.disconnectYouTube()
      setMsg('YouTube disconnected. Posts already published stay on YouTube; scheduled posts will simply skip the YouTube copy.')
      await load()
    } catch (e) {
      setErr(e.message || 'Could not disconnect YouTube.')
    } finally { setBusy(false) }
  }

  const connected = Boolean(status?.connected)
  const configured = Boolean(status?.configured)

  return (
    <div className="card">
      <h2>YouTube</h2>
      {!status ? (
        <p className="muted small" style={{ marginTop: 8 }}>Checking YouTube connection…</p>
      ) : !configured ? (
        <>
          <p className="muted small" style={{ marginTop: 8 }}>
            Status: <b style={{ color: 'var(--ink)' }}>Not configured</b>
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            YouTube is coming soon — the server does not have the Google setup finished yet, so connecting is not available right now. Instagram scheduling works exactly as before.
          </p>
        </>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 8 }}>
            Status: <b style={{ color: 'var(--ink)' }}>{connected ? `Connected${status.channelTitle ? ` — ${status.channelTitle}` : ''}` : 'Not connected'}</b>
          </p>
          {connected && status.channelThumb && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
              <img src={status.channelThumb} alt="" width="36" height="36" style={{ borderRadius: '50%' }} />
              <span className="small"><b style={{ color: 'var(--ink)' }}>{status.channelTitle || 'YouTube channel'}</b><br /><span className="muted">Cross-posting is on — tick “Also post to YouTube” in the Studio.</span></span>
            </div>
          )}
          <p className="muted small" style={{ marginTop: 12 }}>
            Connect your YouTube channel once with Google&apos;s own login page. After that, any video you schedule can also go to YouTube at the same time. Until Google approves the app, YouTube posts land as <b style={{ color: 'var(--ink)' }}>Private</b> (or scheduled-private) — one tap in YouTube Studio makes them public.
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {connected ? (
              <>
                <button type="button" className="btn ghost" disabled={busy} onClick={startConnect}>{busy ? 'Opening…' : 'Reconnect YouTube'}</button>
                <button type="button" className="btn danger" disabled={busy} onClick={disconnect}>{busy ? 'Working…' : 'Disconnect'}</button>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={startConnect}>{busy ? 'Opening Google login…' : 'Connect YouTube'}</button>
            )}
          </div>
        </>
      )}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
    </div>
  )
}
