import { useEffect, useState } from 'react'
import { api } from '../api.js'

const PLAN_BLURBS = {
  free: '2 connected accounts (1 Instagram + 1 YouTube) · 2 posts a day · 30 posts a month',
  pro: '3 connected accounts · 100 posts a month · no daily cap',
  max: '10 connected accounts · unlimited posts · whole queue server-ready · priority publishing',
  ultra: 'Unlimited accounts · unlimited posts · whole queue server-ready · priority publishing · agency mode',
}

// My Plan (batch 2): the user's own plan, live usage meters that use
// the same counting the limits enforce, and the upgrade comparison.
// Prices and upgrade differences come from the server (one pricing
// config), so what is displayed is exactly what will be charged when
// payments go live: upgrades pay only the difference and start fresh
// from the upgrade day; downgrades run the current plan to its expiry
// with no refund.
export default function PlanCard() {
  const [data, setData] = useState(null)
  const [showPlans, setShowPlans] = useState(false)
  useEffect(() => {
    let live = true
    api.getPlanUsage().then((d) => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!data || !data.plan) return null
  const plan = data.plan
  const usage = data.usage || {}
  const lim = plan.limits || {}
  const pricing = data.pricing || { options: [] }
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
  return (
    <section className="card" aria-label="My plan" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>My Plan — {plan.planName}</h2>
        <button type="button" className="btn primary small" onClick={() => setShowPlans((s) => !s)}>{showPlans ? 'Hide plans' : 'Upgrade'}</button>
      </div>
      <p className="muted small" style={{ margin: '6px 0 0' }}>{PLAN_BLURBS[plan.plan] || ''}</p>
      {plan.comp
        ? <p className="small" style={{ margin: '6px 0 0' }}><b>Lifetime</b> — comp plan, free forever. No expiry.</p>
        : plan.planExpiresAt
          ? <p className="muted small" style={{ margin: '6px 0 0' }}>Active until {new Date(plan.planExpiresAt).toLocaleDateString()}</p>
          : null}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
        {meter('Posts today', usage.postsToday || 0, lim.postsPerDay)}
        {meter('Posts this month', usage.postsThisMonth || 0, lim.postsPerMonth)}
        {meter('Accounts connected', usage.accountsConnected || 0, lim.accounts)}
      </div>
      {showPlans && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line)', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {pricing.options.map((o) => (
            <div key={o.plan} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap', border: '1px solid var(--line)', borderRadius: 12, padding: '10px 14px' }}>
              <div>
                <b>{o.name}</b> <span className="muted small">₹{o.priceInr}/month</span>
                <div className="muted small">{PLAN_BLURBS[o.plan] || ''}</div>
                {o.kind === 'upgrade' && (pricing.currentPriceInr > 0
                  ? <div className="small">You already paid ₹{pricing.currentPriceInr} for {pricing.currentName} — for {o.name} you pay only <b>₹{o.chargeInr} more</b>. {o.name} starts fresh from the upgrade day — a full new month.</div>
                  : <div className="small">{o.name} starts fresh from the upgrade day — a full new month.</div>)}
                {o.kind === 'downgrade' && <div className="small">Downgrade: no refund and no mid-cycle cut — your {pricing.currentName} plan runs till its expiry, then {o.name} begins automatically.</div>}
                {o.kind === 'current' && <div className="small">Your current plan.</div>}
              </div>
              {o.kind === 'current'
                ? <span className="badge">Current plan</span>
                : <button type="button" className="btn ghost small" disabled title="Online payment is not live yet">{o.kind === 'upgrade' ? `Pay ₹${o.chargeInr} — coming soon` : 'Coming soon'}</button>}
            </div>
          ))}
          <p className="muted small">Online payment is not live yet. To change your plan today, ask the app owner — they can switch it instantly while payments are being set up.</p>
        </div>
      )}
    </section>
  )
}

