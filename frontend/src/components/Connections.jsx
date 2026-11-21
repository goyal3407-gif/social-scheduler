import InstagramCard from './InstagramCard.jsx'
import YouTubeCard from './YouTubeCard.jsx'

// Connections — the single home for account linking. Instagram and
// YouTube are live; Facebook and TikTok are honest placeholders only
// (disabled, "Coming soon") — no connect behaviour is wired for them.
export default function Connections({ settings, onInstagramChanged, tr }) {
  const t = tr || ((k) => k)
  return (
    <div className="settings-col">
      <h2 className="section-title">{t('connections')}</h2>
      <p className="section-sub">{t('connectionsSub')}</p>

      <div style={{ marginBottom: 16 }}>
        <InstagramCard settings={settings} onInstagramChanged={onInstagramChanged} tr={t} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <YouTubeCard tr={t} />
      </div>

      <div className="card" style={{ marginBottom: 16 }} aria-disabled="true">
        <h2>Facebook <span className="badge" style={{ marginLeft: 8 }}>{t('comingSoon')}</span></h2>
        <p className="muted small" style={{ marginTop: 8 }}>
          {t('fbBody')}
        </p>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost" disabled>{t('connectFacebook')}</button>
        </div>
      </div>

      <div className="card" aria-disabled="true">
        <h2>TikTok <span className="badge" style={{ marginLeft: 8 }}>{t('comingSoon')}</span></h2>
        <p className="muted small" style={{ marginTop: 8 }}>
          {t('ttBody')}
        </p>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost" disabled>{t('connectTikTok')}</button>
        </div>
      </div>
    </div>
  )
}
