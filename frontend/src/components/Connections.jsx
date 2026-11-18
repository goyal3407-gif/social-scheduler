import InstagramCard from './InstagramCard.jsx'
import YouTubeCard from './YouTubeCard.jsx'

// Connections — the single home for account linking. Instagram and
// YouTube are live; Facebook and TikTok are honest placeholders only
// (disabled, "Coming soon") — no connect behaviour is wired for them.
export default function Connections({ settings, onInstagramChanged }) {
  return (
    <div className="settings-col">
      <h2 className="section-title">Connections</h2>
      <p className="section-sub">Link the accounts KiluaAI publishes to — all in one place.</p>

      <div style={{ marginBottom: 16 }}>
        <InstagramCard settings={settings} onInstagramChanged={onInstagramChanged} />
      </div>

      <div style={{ marginBottom: 16 }}>
        <YouTubeCard />
      </div>

      <div className="card" style={{ marginBottom: 16 }} aria-disabled="true">
        <h2>Facebook <span className="badge" style={{ marginLeft: 8 }}>Coming soon</span></h2>
        <p className="muted small" style={{ marginTop: 8 }}>
          Facebook Page posting is planned but not available yet. Nothing to connect here for now.
        </p>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost" disabled>Connect Facebook</button>
        </div>
      </div>

      <div className="card" aria-disabled="true">
        <h2>TikTok <span className="badge" style={{ marginLeft: 8 }}>Coming soon</span></h2>
        <p className="muted small" style={{ marginTop: 8 }}>
          TikTok posting is planned but not available yet. Nothing to connect here for now.
        </p>
        <div style={{ marginTop: 14 }}>
          <button type="button" className="btn ghost" disabled>Connect TikTok</button>
        </div>
      </div>
    </div>
  )
}
