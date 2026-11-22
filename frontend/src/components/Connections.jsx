import { useEffect, useState } from 'react'
import { api } from '../api.js'
import InstagramCard from './InstagramCard.jsx'
import YouTubeCard from './YouTubeCard.jsx'
import { StatusChip } from './shared.jsx'

// Connections — the single home for account linking. Only Instagram
// and YouTube are shown as platform cards (Round 3 Addendum §4);
// other platforms get one quiet "More platforms later" line.
export default function Connections({ settings, onInstagramChanged, tr }) {
  const t = tr || ((k) => k)
  // Round 3 (B7): account status up top as chips — icon + text,
  // never colour-only (B2 StatusChip). Instagram state comes from
  // the settings prop; YouTube state from the same status endpoint
  // the YouTube card and the header chip already use (read-only).
  const [ytStatus, setYtStatus] = useState(null)
  useEffect(() => {
    let live = true
    api.youtubeStatus().then((d) => { if (live) setYtStatus(d) }).catch(() => { if (live) setYtStatus({ connected: false }) })
    return () => { live = false }
  }, [])
  const igState = !settings ? 'checking' : settings.instagramConnected ? 'connected' : 'off'
  const ytState = !ytStatus ? 'checking' : ytStatus.connected ? 'connected' : 'off'
  return (
    <div className="settings-col">
      <h2 className="section-title">{t('connections')}</h2>
      <p className="section-sub">{t('connectionsSub')}</p>

      <div className="conn-status-strip">
        <StatusChip platform="instagram" state={igState} />
        <StatusChip platform="youtube" state={ytState} />
      </div>

      <div className="conn-card-gap">
        <InstagramCard settings={settings} onInstagramChanged={onInstagramChanged} tr={t} />
      </div>

      <div className="conn-card-gap">
        <YouTubeCard tr={t} />
      </div>

      <p className="muted small">{t('morePlatformsLater')}</p>
    </div>
  )
}
