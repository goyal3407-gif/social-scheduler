import { useState } from 'react'

// First-run guide (batch 3, #7): a short 3-step wizard overlay —
// connect an account, add media, schedule the first post — so a new
// user reaches their first post in about 2 minutes. It reads the
// same done-state as the Dashboard checklist, can be skipped at any
// point, and once dismissed (or finished) it never comes back: the
// dismissal is saved to the user's settings.
export default function GuideWizard({ steps, onNavigate, onDismiss, tr }) {
  const t = tr || ((k) => k)
  const firstOpen = Math.max(0, steps.findIndex((s) => !s.done))
  const [idx, setIdx] = useState(firstOpen === -1 ? 0 : firstOpen)
  const step = steps[Math.min(idx, steps.length - 1)]
  if (!step) return null
  const go = () => { if (step.tab) onNavigate && onNavigate(step.tab); onDismiss && onDismiss() }
  return (
    <div role="dialog" aria-modal="true" aria-label={t('guideTitle')} style={{ position: 'fixed', inset: 0, background: 'rgba(5,8,20,.66)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90, padding: 16 }}>
      <div className="card" style={{ maxWidth: 460, width: '100%', padding: 22 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0 }}>{t('guideTitle')}</h2>
          <button type="button" className="btn ghost small" onClick={onDismiss}>{t('skip')}</button>
        </div>
        <div style={{ display: 'flex', gap: 6, margin: '14px 0' }} aria-hidden="true">
          {steps.map((s, i) => (
            <span key={i} style={{ flex: 1, height: 6, borderRadius: 99, background: s.done ? 'var(--gold)' : (i === idx ? 'var(--gold)' : 'var(--line)'), opacity: s.done || i === idx ? 1 : 0.45 }} />
          ))}
        </div>
        <p className="small muted" style={{ margin: '0 0 4px' }}>{idx + 1} / {steps.length}{step.done ? ' ✓' : ''}</p>
        <h3 style={{ margin: '2px 0 6px' }}>{step.title}</h3>
        <p className="muted" style={{ margin: 0 }}>{step.body}</p>
        <div style={{ display: 'flex', gap: 8, marginTop: 18, flexWrap: 'wrap' }}>
          {idx > 0 && <button type="button" className="btn ghost" onClick={() => setIdx(idx - 1)}>{t('back')}</button>}
          {step.done
            ? (idx < steps.length - 1
              ? <button type="button" className="btn primary" onClick={() => setIdx(idx + 1)}>{t('next')}</button>
              : <button type="button" className="btn primary" onClick={onDismiss}>{t('finish')}</button>)
            : <button type="button" className="btn primary" onClick={go}>{step.cta}</button>}
          {!step.done && idx < steps.length - 1 && <button type="button" className="btn ghost" onClick={() => setIdx(idx + 1)}>{t('next')}</button>}
        </div>
      </div>
    </div>
  )
}
