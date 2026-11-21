import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import MyStats from './MyStats.jsx'

const PLAN_BLURBS = {
  free: '2 connected accounts (1 Instagram + 1 YouTube) · 2 posts a day · 30 posts a month',
  pro: '3 connected accounts · 100 posts a month · no daily cap',
  max: '10 connected accounts · unlimited posts · whole queue server-ready · priority publishing',
  ultra: 'Unlimited accounts · unlimited posts · whole queue server-ready · priority publishing · agency mode',
}

// Extra feature lines that are not numeric limits (the numeric ones
// are rendered from the server's own plan config, so the comparison
// can never drift from what the server enforces).
const PLAN_EXTRAS = {
  free: [],
  pro: ['featCrossPostBulk'],
  max: ['featPriority', 'featMultiAccount'],
  ultra: ['featPriority', 'featMultiAccount', 'featTeam', 'featAnalytics', 'featSupportFirst'],
}

// Pricing tab (batch 4): its ONE job is the plan — the user's current
// plan + live usage at the top, an honest "best for you" marker
// computed from that usage, and the full comparison below. Prices,
// limits and upgrade differences all come from the server (one
// pricing config), so what is displayed is exactly what will be
// charged when payments go live: upgrades pay only the difference
// and start fresh; downgrades run the current plan to its expiry.
// Yearly = 10 × monthly (2 months free), display only — Razorpay is
// not wired yet, so purchase buttons stay in their "coming soon"
// state, exactly as the old My Plan card had them.
export default function Pricing({ tr }) {
  const t = tr || ((k) => k)
  const [data, setData] = useState(null)
  const [period, setPeriod] = useState('monthly')
  useEffect(() => {
    let live = true
    api.getPlanUsage().then((d) => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [])

  const plan = data?.plan
  const usage = data?.usage || {}
  const pricing = data?.pricing || { options: [] }
  const factor = period === 'yearly' ? 10 : 1
  const periodWord = t('perMonth').replace('/', '')
  // Indian digit grouping (₹4,990 not ₹4990) — the yearly prices
  // cross a thousand and must stay easy to read at a glance.
  const inr = (n) => `₹${Number(n).toLocaleString('en-IN')}`

  // "Tumhare liye best": read the user's REAL usage against their
  // REAL limits. Hitting a limit (≥100%) or closing in on one (≥80%)
  // points at the next plan up; anything else honestly says the
  // current plan is enough — a plan is never pushed that the data
  // does not justify (the satisfaction rule).
  const rec = useMemo(() => {
    if (!plan || !pricing.options.length) return null
    const lim = plan.limits || {}
    const ratios = []
    if (lim.postsPerMonth) ratios.push((usage.postsThisMonth || 0) / lim.postsPerMonth)
    if (lim.postsPerDay) ratios.push((usage.postsToday || 0) / lim.postsPerDay)
    if (lim.accounts) ratios.push((usage.accountsConnected || 0) / lim.accounts)
    const top = ratios.length ? Math.max(...ratios) : 0
    const nextUp = pricing.options.find((o) => o.kind === 'upgrade')
    if (plan.comp) return { planId: plan.plan, msg: t('recComp') }
    if (!nextUp) return { planId: plan.plan, msg: t('recTop') }
    if (top >= 1) return { planId: nextUp.plan, msg: t('recHitting').replace('{plan}', nextUp.name) }
    if (top >= 0.8) return { planId: nextUp.plan, msg: t('recNear').replace('{plan}', nextUp.name) }
    return { planId: plan.plan, msg: t('recFits') }
  }, [plan, pricing, usage, t])

  if (!data || !plan) return null
  const lim = plan.limits || {}
  const meter = (label, used, limit) => (
    <div key={label} style={{ minWidth: 150, flex: '1 1 150px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <span className="muted small">{label}</span>
        <b className="small">{limit == null ? `${used} · Unlimited` : `${used} / ${limit}`}</b>
      </div>
      <div style={{ height: 7, background: 'var(--line)', borderRadius: 99, overflow: 'hidden', marginTop: 4 }}>
        <div style={{ height: '100%', width: limit == null ? '100%' : `${Math.min(100, limit ? Math.round((used / limit) * 100) : 0)}%`, background: '#e8c268' }} />
      </div>
    </div>
  )
  const features = (o) => {
    const lim2 = o.limits || {}
    const out = []
    out.push(lim2.accounts == null ? t('featAccountsUnlimited') : t('featAccounts').replace('{n}', lim2.accounts) + (lim2.igAccounts === 1 ? ' (1 Instagram + 1 YouTube)' : ''))
    if (lim2.postsPerDay != null) out.push(t('featPostsDay').replace('{n}', lim2.postsPerDay))
    out.push(lim2.postsPerMonth == null ? t('featPostsMonthUnlimited') : t('featPostsMonth').replace('{n}', lim2.postsPerMonth))
    out.push(o.fullBridge ? t('featServerReadyAll') : t('featServerReadyNext'))
    out.push(o.aiPerDay == null ? t('featAiUnlimited') : t('featAi').replace('{n}', o.aiPerDay))
    for (const k of PLAN_EXTRAS[o.plan] || []) out.push(t(k))
    return out
  }

  return (
    <div>
      <h2 className="section-title">{t('pricing')}</h2>
      <p className="section-sub">{t('pricingSub')}</p>

      <section className="card" aria-label={t('myPlan')} style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0 }}>{t('myPlan')} — {plan.planName}</h2>
          {rec && rec.planId === plan.plan && <span className="badge" style={{ background: 'var(--gold)', color: '#191204' }}>{t('bestForYou')}</span>}
        </div>
        <p className="muted small" style={{ margin: '6px 0 0' }}>{PLAN_BLURBS[plan.plan] || ''}</p>
        {plan.comp
          ? <p className="small" style={{ margin: '6px 0 0' }}><b>{t('lifetime')}</b></p>
          : plan.planExpiresAt
            ? <p className="muted small" style={{ margin: '6px 0 0' }}>{t('activeUntil')} {new Date(plan.planExpiresAt).toLocaleDateString()}</p>
            : null}
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
          {meter(t('postsToday'), usage.postsToday || 0, lim.postsPerDay)}
          {meter(t('postsThisMonth'), usage.postsThisMonth || 0, lim.postsPerMonth)}
          {meter(t('accountsConnected'), usage.accountsConnected || 0, lim.accounts)}
          {data.ai && meter(t('aiCaptionsToday'), data.ai.usedToday || 0, data.ai.perDay)}
        </div>
        {rec && (
          <p className="small" role="status" style={{ margin: '12px 0 0', padding: '9px 12px', borderRadius: 10, background: 'var(--surface-2)', border: '1px solid var(--gold, #e8c268)' }}>
            <b>{t('bestForYou')}:</b> {rec.msg}
          </p>
        )}
      </section>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', margin: '18px 0 12px' }} role="group" aria-label="Billing period">
        <button type="button" className={`btn small ${period === 'monthly' ? 'primary' : 'ghost'}`} onClick={() => setPeriod('monthly')}>{t('monthly')}</button>
        <button type="button" className={`btn small ${period === 'yearly' ? 'primary' : 'ghost'}`} onClick={() => setPeriod('yearly')}>{t('yearly')}</button>
        {period === 'yearly' && <span className="badge" style={{ background: 'var(--gold)', color: '#191204' }}>{t('twoMonthsFree')}</span>}
      </div>

      <div className="plan-grid">
        {pricing.options.map((o) => {
          const isCurrent = o.kind === 'current'
          const isRec = rec && rec.planId === o.plan && !isCurrent
          return (
            <section key={o.plan} className="card" aria-label={`${o.name} plan`}
              style={{ display: 'flex', flexDirection: 'column', gap: 8, ...(o.plan === 'max' ? { border: '2px solid var(--gold, #e8c268)' } : {}), ...(isRec ? { outline: '2px solid var(--gold, #e8c268)', outlineOffset: 2 } : {}) }}>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', minHeight: 22 }}>
                {o.plan === 'max' && <span className="badge" style={{ background: 'var(--gold)', color: '#191204' }}>{t('mostPopular')}</span>}
                {isCurrent && <span className="badge">{t('currentPlan')}</span>}
                {isRec && <span className="badge" style={{ background: 'var(--gold)', color: '#191204' }}>{t('bestForYou')}</span>}
              </div>
              <h3 style={{ margin: 0, fontSize: 19 }}>{o.name}</h3>
              <p style={{ margin: 0 }}><b style={{ fontSize: 24 }}>{inr(o.priceInr * factor)}</b> <span className="muted small">{period === 'yearly' ? t('perYear') : t('perMonth')}</span></p>
              <ul className="small" style={{ margin: '2px 0 0', paddingLeft: 17, lineHeight: 1.75, flex: 1 }}>
                {features(o).map((f) => <li key={f}>{f}</li>)}
              </ul>
              {o.kind === 'upgrade' && (period === 'yearly'
                ? <p className="small" style={{ margin: 0 }}>{t('upgradeYearlyLine').replace('{name}', o.name).replace('{charge}', Number(o.chargeInr * factor).toLocaleString('en-IN'))}</p>
                : pricing.currentPriceInr > 0
                  ? <p className="small" style={{ margin: 0 }}>You already paid {inr(pricing.currentPriceInr)} for {pricing.currentName} — for {o.name} you pay only <b>{inr(o.chargeInr)} more</b>. {o.name} starts fresh from the upgrade day — a full new {periodWord}.</p>
                  : <p className="small" style={{ margin: 0 }}>{o.name} starts fresh from the upgrade day — a full new {periodWord}.</p>)}
              {o.kind === 'downgrade' && <p className="small" style={{ margin: 0 }}>Downgrade: no refund and no mid-cycle cut — your {pricing.currentName} plan runs till its expiry, then {o.name} begins automatically.</p>}
              {isCurrent
                ? <span className="badge" style={{ alignSelf: 'flex-start' }}>{t('currentPlan')}</span>
                : <button type="button" className="btn ghost small" disabled title={t('paymentSoon')} style={{ alignSelf: 'flex-start' }}>{o.kind === 'upgrade' ? `Pay ${inr(o.chargeInr * factor)} — coming soon` : 'Coming soon'}</button>}
            </section>
          )
        })}
      </div>
      <p className="muted small" style={{ marginTop: 12 }}>{t('paymentSoon')}. To change your plan today, ask the app owner — they can switch it instantly while payments are being set up.</p>

      <div style={{ marginTop: 18 }}>
        <MyStats tr={t} />
      </div>
    </div>
  )
}
