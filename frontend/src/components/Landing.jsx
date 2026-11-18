import Auth from './Auth.jsx'

// Public landing page (Phase F) — what a logged-out visitor sees at
// the root: a real page about KiluaAI around the login/sign-up form.
// It exists so anyone (including Google's OAuth reviewer) can see
// what the app does without an account. Every feature named here is
// live today; no user counts, no testimonials, no pricing promises,
// no app-store claims. Logged-in users never see this — App.jsx only
// renders it in the signed-out branch. The form is the existing Auth
// component in `bare` mode (its own branding head would duplicate
// the hero below).

const FEATURES = [
  ['Reels, Posts & Stories', 'Schedule every Instagram format from one composer, with a live Instagram-style preview before anything posts.'],
  ['Bulk scheduling', 'Queue a whole batch of Reels at once and spread them across the days ahead in minutes.'],
  ['YouTube cross-posting', 'Tick both platforms and one upload publishes to Instagram and to your YouTube channel.'],
  ['Recurring weekly posts', 'Set a post to repeat every week — a series keeps its slot without being scheduled again.'],
  ['Drafts', 'Save ideas as drafts and turn them into scheduled posts when they are ready.'],
  ['Calendar view', 'See the whole month at a glance, and drag a post to a different day when plans change.'],
  ['Link-in-bio page', 'A simple public page that gathers your links under one KiluaAI address.'],
  ['Templates & hashtag bank', 'Save captions and hashtag groups once, then reuse them in every post.'],
]

const STEPS = [
  ['Connect Instagram', 'Sign in and link the Instagram account you want to post to — the connection runs through Meta\u2019s official login.'],
  ['Add media', 'Upload photos and videos on the web, or pick them from your phone\u2019s library in the Android app.'],
  ['Pick a time', 'Write the caption, choose the day and time, and KiluaAI publishes the post for you — exactly on time.'],
]

export default function Landing({ onAuth }) {
  return (
    <div className="landing">
      <header className="landing-hero">
        <div className="logo-mark auth-logo" aria-hidden="true"><img src="/icon-192.png" alt="" width="52" height="52" /></div>
        <h1 className="landing-name">KiluaAI</h1>
        <p className="landing-line">An Instagram scheduler for Reels, Posts and Stories — with YouTube cross-posting.</p>
        <p className="landing-sub muted">Plan your posts once, and KiluaAI publishes them for you at the exact time you choose — on the web and in the Android app.</p>
      </header>

      <Auth onAuth={onAuth} bare />

      <section className="landing-sec">
        <h2>What it does</h2>
        <p>Connect your Instagram account, add your photos and videos, and pick a time. KiluaAI then publishes each post automatically at the exact time you set — no reminders, and no opening Instagram at the right moment. The media library is phone-first: in the Android app your originals stay on your phone, and a copy is uploaded only when you schedule a post, so scheduled posts still go out on time even if the phone is off.</p>
      </section>

      <section className="landing-sec">
        <h2>Features</h2>
        <div className="feat-grid">
          {FEATURES.map(([title, text]) => (
            <div className="feat-card" key={title}>
              <b>{title}</b>
              <span>{text}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-sec">
        <h2>How it works</h2>
        <ol className="steps">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="step-n" aria-hidden="true">{i + 1}</span>
              <span><b>{title}.</b> {text}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-sec">
        <h2>YouTube, too</h2>
        <p>KiluaAI uses YouTube API Services to upload videos to your own YouTube channel. Tick YouTube next to Instagram in the composer, set the title, the visibility (Public, Unlisted or Private) and whether the video is made for kids, and the same video is published to both platforms at the scheduled time. Until Google approves the app, YouTube keeps new uploads Private — the visibility you chose applies automatically once that approval passes.</p>
      </section>

      <footer className="landing-foot">
        <nav>
          <a href="/privacy.html">Privacy Policy</a>
          <a href="/terms.html">Terms of Service</a>
          <a href="/contact.html">Contact</a>
        </nav>
        <p className="muted small">KiluaAI — schedule once, post on time.</p>
      </footer>
    </div>
  )
}
