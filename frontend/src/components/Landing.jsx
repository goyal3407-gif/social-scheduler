import { useEffect, useState } from 'react'
import { api } from '../api.js'
import { openExternalUrl } from '../openExternal.js'
import { trFor, dictSync, loadDict } from '../i18n.js'
import { Logo } from './shared.jsx'

// Static pages (privacy/terms/contact): inside the app they open in
// the system browser so the user is never stranded away from the
// shell (Phase 3 Batch C — audit H-05); on the web they navigate
// normally (the pages carry their own way back — Batch D).
const staticLink = (path) => ({
  href: path,
  onClick: (e) => { if (openExternalUrl(new URL(path, window.location.origin).href)) e.preventDefault() },
})

// Public landing page (Phase F) — what a logged-out visitor sees at
// the root: a real page about KiluaAI. It exists so anyone
// (including Google's OAuth reviewer) can see what the app does
// without an account. Every feature named here is live today; no
// user counts, no testimonials, no pricing promises, no app-store
// claims. Logged-in users never see this — App.jsx only renders it
// in the signed-out branch.
//
// Login split (Prompt-4, 22 Nov 2026 — supersedes the earlier
// compact arrangement that embedded the form here): the marketing
// lives on this page; the login/sign-up form lives on its OWN clean
// screen, reached from the buttons under the brand row. Nothing was
// deleted: the copy, sections and footer links are all still here
// for first-visit info and SEO.
//
// Round 3 (B4): every user-visible string on this page renders
// through the dictionary (land* keys in i18n-dict.js, EN+HI), wired
// exactly like Auth — persisted language + loadDict() gate — and
// the brand mark is B3's shared <Logo/>.

// Feature list — each item verified against the product code in B4:
//  formats: Studio FORMATS = REELS/FEED/STORY + live preview;
//  bulk: components/Bulk.jsx; YouTube: Studio youtubeEnabled +
//  server upload; recurring: Studio repeatWeekly + server weekly
//  chain (scheduleWeeklyNext); drafts: post status 'draft';
//  calendar + drag: CalendarView onChipDragStart/draggable/onDrop;
//  link-in-bio: server GET /bio/:slug; templates/hashtags: Studio
//  caption library + hashtag bank.
const FEATURE_KEYS = [
  ['landFeatFormatsTitle', 'landFeatFormatsText'],
  ['landFeatBulkTitle', 'landFeatBulkText'],
  ['landFeatYtTitle', 'landFeatYtText'],
  ['landFeatRecurTitle', 'landFeatRecurText'],
  ['landFeatDraftsTitle', 'landFeatDraftsText'],
  ['landFeatCalendarTitle', 'landFeatCalendarText'],
  ['landFeatBioTitle', 'landFeatBioText'],
  ['landFeatTemplatesTitle', 'landFeatTemplatesText'],
]

const STEP_KEYS = [
  ['landStep1Title', 'landStep1Text'],
  ['landStep2Title', 'landStep2Text'],
  ['landStep3Title', 'landStep3Text'],
]

export default function Landing({ onShowAuth }) {
  // Pricing strip (Phase 3 Batch D, L-02): plan names + prices come
  // from the server's single PLANS config via the public app-status
  // endpoint — the strip simply does not render if that fetch fails.
  const [plans, setPlans] = useState([])
  useEffect(() => {
    let live = true
    api.getAppStatus().then((d) => { if (live && Array.isArray(d.plans)) setPlans(d.plans) }).catch(() => {})
    return () => { live = false }
  }, [])
  // Dictionary wiring — the same pattern Auth uses.
  const [lang] = useState(() => { try { return localStorage.getItem('ss-lang') || 'en' } catch { return 'en' } })
  const [dict, setDict] = useState(() => dictSync())
  useEffect(() => {
    let live = true
    loadDict().then((d) => { if (live) setDict(d) })
    return () => { live = false }
  }, [])
  const tr = trFor(lang, dict)
  if (!dict) {
    return (
      <div className="boot-load" role="status">
        <Logo size={52} />
        <span className="boot-spinner" aria-hidden="true" />
        <span className="muted small">{trFor(lang, null)('loading')}</span>
      </div>
    )
  }
  return (
    <div className="landing">
      <header className="landing-hero">
        <Logo size={34} />
        <h1 className="landing-name">KiluaAI</h1>
      </header>
      <p className="landing-line landing-hero-line">{tr('landHeroLine')}</p>

      <div className="landing-cta">
        <button type="button" className="btn primary" onClick={() => onShowAuth && onShowAuth('signup')}>{tr('landCreateBtn')}</button>
        <button type="button" className="btn" onClick={() => onShowAuth && onShowAuth('login')}>{tr('landLoginBtn')}</button>
      </div>

      <div className="landing-below">
      <section className="landing-sec">
        <h2>{tr('landWhatTitle')}</h2>
        <p>{tr('landWhatBody')}</p>
        <p className="landing-sub muted">{tr('landWhatSub')}</p>
      </section>

      <section className="landing-sec">
        <h2>{tr('landFeaturesTitle')}</h2>
        <div className="feat-grid">
          {FEATURE_KEYS.map(([titleKey, textKey]) => (
            <div className="feat-card" key={titleKey}>
              <b>{tr(titleKey)}</b>
              <span>{tr(textKey)}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-sec">
        <h2>{tr('landHowTitle')}</h2>
        <ol className="how-steps">
          {STEP_KEYS.map(([titleKey, textKey], i) => (
            <li key={titleKey}>
              <span className="how-step-n" aria-hidden="true">{i + 1}</span>
              <span><b>{tr(titleKey)}.</b> {tr(textKey)}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-sec">
        <h2>{tr('landYtTitle')}</h2>
        <p>{tr('landYtBody')}</p>
      </section>

      {plans.length > 0 && (
        <section className="landing-sec">
          <h2>{tr('landPricingTitle')}</h2>
          <div className="feat-grid">
            {plans.map((p) => (
              <div className="feat-card" key={p.id}>
                <b>{p.name}</b>
                <span>{p.priceInr === 0 ? tr('landFreeLine') : tr('landPaidLine').replace('{price}', Number(p.priceInr).toLocaleString('en-IN'))}</span>
              </div>
            ))}
          </div>
          <p className="muted small landing-pricing-note">{tr('landPricingNote')}</p>
        </section>
      )}

      <footer className="landing-foot">
        <nav>
          <a {...staticLink('/privacy.html')}>{tr('landPrivacy')}</a>
          <a {...staticLink('/terms.html')}>{tr('landTerms')}</a>
          <a {...staticLink('/contact.html')}>{tr('landContact')}</a>
        </nav>
        <p className="muted small">{tr('landFootLine')}</p>
      </footer>
      </div>
    </div>
  )
}
