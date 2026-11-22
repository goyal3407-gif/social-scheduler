import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.js'
import MyStats from './MyStats.jsx'
import { Skeleton } from './shared.jsx'

const PLAN_BLURBS = { free: 'blurbFree', pro: 'blurbPro', max: 'blurbMax', ultra: 'blurbUltra' }

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
  const [failed, setFailed] = useState(false)
  const [period, setPeriod] = useState('monthly')
  const load = () => {
    setFailed(false)
    api.getPlanUsage().then((d) => setData(d)).catch(() => setFailed(true))
  }
  useEffect(() => {
    let live = true
    api.getPlanUsage().then((d) => { if (live) setData(d) }).catch(() => { if (live) setFailed(true) })
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

  // Phase 3 (Batch D, M-04): never a blank tab — skeleton while the
  // plan loads, an honest message + Retry if it failed.
  if (!data || !plan) {
    return failed ? (
      <div className="card">
        <p className="muted">{t('pricingLoadFailed')}</p>
        <button type="button" className="btn ghost" onClick={load}>{t('retry')}</button>
      </div>
    ) : (
      <div aria-busy="true"><Skeleton rows={3} /><Skeleton rows={4} /></div>
    )
  }
  const lim = plan.limits || {}
  const meter = (label, used, limit) => (
    <div key={label} className="meter">
      <div className="meter-head">
        <span className="muted small">{label}</span>
        <b className="small">{limit == null ? `${used} · ${t('unlimitedWord')}` : `${used} / ${limit}`}</b>
      </div>
      <div className="meter-track">
        <div className="meter-fill" style={{ width: limit == null ? '100%' : `${Math.min(100, limit ? Math.round((used / limit) * 100) : 0)}%` }} />
      </div>
    </div>
  )
  const features = (o) => {
    const lim2 = o.limits || {}
    const out = []
    out.push(lim2.accounts == null ? t('featAccountsUnlimited') : t('featAccounts').replace('{n}', lim2.accounts) + (lim2.igAccounts === 1 ? t('featIgYtNote') : ''))
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

      <section className="card pricing-myplan" aria-label={t('myPlan')}>
        <div className="plan-head-row">
          <h2>{t('myPlan')} — {plan.planName}</h2>
          {rec && rec.planId === plan.plan && <span className="badge brand">{t('bestForYou')}</span>}
        </div>
        <p className="muted small plan-sub-line">{PLAN_BLURBS[plan.plan] ? t(PLAN_BLURBS[plan.plan]) : ''}</p>
        {plan.comp
          ? <p className="small plan-sub-line"><b>{t('lifetime')}</b></p>
          : plan.planExpiresAt
            ? <p className="muted small plan-sub-line">{t('activeUntil')} {new Date(plan.planExpiresAt).toLocaleDateString()}</p>
            : null}
        <div className="plan-meters">
          {meter(t('postsToday'), usage.postsToday || 0, lim.postsPerDay)}
          {meter(t('postsThisMonth'), usage.postsThisMonth || 0, lim.postsPerMonth)}
          {meter(t('accountsConnected'), usage.accountsConnected || 0, lim.accounts)}
          {data.ai && meter(t('aiCaptionsToday'), data.ai.usedToday || 0, data.ai.perDay)}
        </div>
        {rec && (
          <p className="small plan-rec-note" role="status">
            <b>{t('bestForYou')}:</b> {rec.msg}
          </p>
        )}
      </section>

      <div className="billing-row" role="group" aria-label={t('billingPeriod')}>
        <button type="button" className={`btn small ${period === 'monthly' ? 'primary' : 'ghost'}`} onClick={() => setPeriod('monthly')}>{t('monthly')}</button>
        <button type="button" className={`btn small ${period === 'yearly' ? 'primary' : 'ghost'}`} onClick={() => setPeriod('yearly')}>{t('yearly')}</button>
        {period === 'yearly' && <span className="badge badge-gold">{t('twoMonthsFree')}</span>}
      </div>

      <div className="plan-grid">
        {pricing.options.map((o) => {
          const isCurrent = o.kind === 'current'
          const isRec = rec && rec.planId === o.plan && !isCurrent
          // Round 3 (B7): single-winner hierarchy — the recommended
          // plan is the ONLY card with a strong treatment (brand
          // outline + brand badge; if it is also Max, its
          // "Most popular" badge may stay gold). Every other
          // "Most popular" showing is a quiet neutral badge with
          // no gold border, so the two markers never shout at once.
          const maxStrong = o.plan === 'max' && isRec
          return (
            <section key={o.plan} className={`card plan-card${isRec ? ' plan-card-rec' : ''}`} aria-label={`${o.name} plan`}>
              <div className="plan-badges">
                {o.plan === 'max' && <span className={`badge${maxStrong ? ' badge-gold' : ' neutral'}`}>{t('mostPopular')}</span>}
                {isCurrent && <span className="badge">{t('currentPlan')}</span>}
                {isRec && <span className="badge brand">{t('bestForYou')}</span>}
              </div>
              <h3 className="plan-name">{o.name}</h3>
              <p className="plan-price-line"><b className="plan-price-num">{inr(o.priceInr * factor)}</b> <span className="muted small">{period === 'yearly' ? t('perYear') : t('perMonth')}</span></p>
              <ul className="small plan-features">
                {features(o).map((f) => <li key={f}>{f}</li>)}
              </ul>
              {o.kind === 'upgrade' && (period === 'yearly'
                ? <p className="small plan-note">{t('upgradeYearlyLine').replace('{name}', o.name).replace('{charge}', Number(o.chargeInr * factor).toLocaleString('en-IN'))}</p>
                : pricing.currentPriceInr > 0
                  ? <p className="small plan-note">{t('alreadyPaidLine').replace('{paid}', inr(pricing.currentPriceInr)).replace('{cur}', pricing.currentName).replaceAll('{name}', o.name).replace('{charge}', inr(o.chargeInr)).replace('{period}', periodWord)}</p>
                  : <p className="small plan-note">{t('startsFreshLine').replace('{name}', o.name).replace('{period}', periodWord)}</p>)}
              {o.kind === 'downgrade' && <p className="small plan-note">{t('downgradeLine').replace('{cur}', pricing.currentName).replace('{name}', o.name)}</p>}
              {!isCurrent && <button type="button" className="btn ghost small plan-cta" disabled title={t('paymentSoon')}>{o.kind === 'upgrade' ? t('payComingSoon').replace('{amount}', inr(o.chargeInr * factor)) : t('comingSoon')}</button>}
            </section>
          )
        })}
      </div>
      <p className="muted small pricing-foot">{t('paymentSoon')}. {t('pricingFootNote')}</p>

      <div className="pricing-stats">
        <MyStats tr={t} />
      </div>
    </div>
  )
}
