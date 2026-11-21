import { useCallback, useEffect, useState } from 'react'
import { api, openYouTubeConnect } from '../api.js'

// The YouTube connection card (Phase B) — lives on the Connections
// page. "Connect YouTube" is a CHANNEL connection through Google's own
// OAuth page; it is not app sign-in (the app login stays
// email/password). When the server has no Google client configured,
// the card says so plainly and offers no connect button.
export default function YouTubeCard({ tr }) {
  const t = tr || ((k) => k)
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
      setMsg(t('msgYtOpened'))
    } catch (e) {
      setErr(e.message || t('errYtOpen'))
    } finally { setBusy(false) }
  }

  const disconnect = async () => {
    setErr(''); setMsg('')
    setBusy(true)
    try {
      await api.disconnectYouTube()
      setMsg(t('msgYtDisconnected'))
      await load()
    } catch (e) {
      setErr(e.message || t('errYtDisconnect'))
    } finally { setBusy(false) }
  }

  const connected = Boolean(status?.connected)
  const configured = Boolean(status?.configured)

  return (
    <div className="card">
      <h2>YouTube</h2>
      {!status ? (
        <p className="muted small" style={{ marginTop: 8 }}>{t('ytChecking')}</p>
      ) : !configured ? (
        <>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('statusWord')} <b style={{ color: 'var(--ink)' }}>{t('ytNotConfigured')}</b>
          </p>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('ytComingBody')}
          </p>
        </>
      ) : (
        <>
          <p className="muted small" style={{ marginTop: 8 }}>
            {t('statusWord')} <b style={{ color: 'var(--ink)' }}>{connected ? (status.channelTitle ? t('ytConnectedAs').replace('{name}', status.channelTitle) : t('connected')) : t('notConnected')}</b>
          </p>
          {connected && status.channelThumb && (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
              <img src={status.channelThumb} alt="" width="36" height="36" style={{ borderRadius: '50%' }} />
              <span className="small"><b style={{ color: 'var(--ink)' }}>{status.channelTitle || t('ytChannelFallback')}</b><br /><span className="muted">{t('ytCrossNote')}</span></span>
            </div>
          )}
          <p className="muted small" style={{ marginTop: 12 }}>
            {t('ytExplainA')} <b style={{ color: 'var(--ink)' }}>{t('ytExplainBold')}</b> {t('ytExplainB')}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            {connected ? (
              <>
                <button type="button" className="btn ghost" disabled={busy} onClick={startConnect}>{busy ? t('openingShort') : t('ytReconnect')}</button>
                <button type="button" className="btn danger" disabled={busy} onClick={disconnect}>{busy ? t('devWorking') : t('disconnectWord')}</button>
              </>
            ) : (
              <button type="button" className="btn primary" disabled={busy} onClick={startConnect}>{busy ? t('ytOpeningGoogle') : t('connectYouTube')}</button>
            )}
          </div>
        </>
      )}
      {err && <div className="alert error">{err}</div>}
      {msg && <div className="alert success">{msg}</div>}
    </div>
  )
}
