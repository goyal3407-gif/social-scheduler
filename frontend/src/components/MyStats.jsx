import { useEffect, useState } from 'react'
import { api } from '../api.js'

// Basic stats (batch 3, #14 foundation): counts from KiluaAI's OWN
// publish records — how many posts went live, how many failed, the
// share of finished posts that went fully live, and per-account
// totals. The label says plainly what this is and is not: Instagram
// views/likes arrive only after Meta App Review; nothing here is
// estimated.
export default function MyStats({ tr }) {
  const t = tr || ((k) => k)
  const [data, setData] = useState(null)
  useEffect(() => {
    let live = true
    api.getMyStats().then((d) => { if (live) setData(d) }).catch(() => {})
    return () => { live = false }
  }, [])
  if (!data || !data.stats) return null
  const s = data.stats
  const cell = (label, value) => (
    <div key={label} style={{ minWidth: 110, flex: '1 1 110px' }}>
      <div style={{ fontSize: 22, fontWeight: 800 }}>{value}</div>
      <div className="muted small">{label}</div>
    </div>
  )
  return (
    <section className="card" aria-label={t('yourNumbers')} style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <h2 style={{ margin: 0 }}>{t('yourNumbers')}</h2>
        <span className="badge">{t('basicStats')}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginTop: 12 }}>
        {cell(t('published'), s.published)}
        {cell(t('failed'), s.failed)}
        {cell(t('partial'), s.partial)}
        {cell(t('successRate'), s.successRate == null ? '—' : `${s.successRate}%`)}
        {cell(`${t('published')} · ${new Date().toLocaleDateString(undefined, { month: 'long' })}`, s.publishedThisMonth)}
      </div>
      {s.perAccount && s.perAccount.length > 0 && (
        <div style={{ marginTop: 12, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <div className="muted small" style={{ marginBottom: 6 }}>{t('perAccount')}</div>
          {s.perAccount.map((r) => (
            <div key={r.account} style={{ display: 'flex', justifyContent: 'space-between', gap: 10, padding: '3px 0' }}>
              <span>{r.account}</span>
              <span className="small"><b>{r.published}</b> {t('published')} · <b>{r.failed}</b> {t('failed')}</span>
            </div>
          ))}
        </div>
      )}
      <p className="muted small" style={{ margin: '10px 0 0' }}>{data.note}</p>
    </section>
  )
}
