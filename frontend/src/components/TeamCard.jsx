import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.js'

// Team (batch 3, agency foundation — Ultra only): the workspace
// owner invites members by email with a limited role and can remove
// them at any time (access ends on their very next request — the
// server checks membership on every call). Since batch 6 the invite
// is also emailed by the app when a sender is configured — the API
// answers emailed: true/false and this card says which happened.
// The invite binds automatically when that email signs in. The card
// renders nothing for non-Ultra plans.
export default function TeamCard({ tr }) {
  const t = tr || ((k) => k)
  const [plan, setPlan] = useState('')
  const [members, setMembers] = useState(null)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState('scheduler')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const usage = await api.getPlanUsage()
      const p = (usage && usage.plan && usage.plan.plan) || ''
      setPlan(p)
      if (p !== 'ultra') { setMembers([]); return }
      const d = await api.getTeam()
      setMembers((d && d.members) || [])
    } catch { setMembers([]) }
  }, [])
  useEffect(() => { load() }, [load])

  if (plan !== 'ultra') return null
  const live = (members || []).filter((m) => m.status !== 'removed')
  const invite = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await api.inviteTeamMember(email.trim(), role)
      setEmail('')
      setMsg(r && r.emailed ? t('teamInvitedEmailed') : t('teamInvited'))
      await load()
    } catch (e) { setMsg(e.message || t('teamInviteFail')) }
    finally { setBusy(false) }
  }
  const remove = async (m) => {
    setBusy(true); setMsg('')
    try { await api.removeTeamMember(m.id); await load() }
    catch (e) { setMsg(e.message || t('teamRemoveFail')) }
    finally { setBusy(false) }
  }
  return (
    <section className="card" aria-label={t('team')} style={{ marginTop: 14 }}>
      <h3 style={{ marginTop: 0 }}>{t('team')}</h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        {t('teamIntro')}
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@example.com" aria-label="Team member email" style={{ flex: '1 1 220px' }} />
        <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
          <option value="scheduler">{t('roleScheduler')}</option>
          <option value="viewer">{t('roleViewer')}</option>
        </select>
        <button type="button" className="btn primary small" disabled={busy || !email.trim()} onClick={invite}>{t('invite')}</button>
      </div>
      {msg && <p className="small" role="status" style={{ marginBottom: 0 }}>{msg}</p>}
      {members === null
        ? <p className="muted small">{t('loading')}</p>
        : live.length === 0
          ? <p className="muted small">{t('teamNone')}</p>
          : (
            <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {live.map((m) => (
                <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, border: '1px solid var(--line)', borderRadius: 10, padding: '8px 12px', flexWrap: 'wrap' }}>
                  <span><b>{m.email}</b> <span className="muted small">· {m.role === 'viewer' ? t('roleViewerShort') : t('roleSchedulerShort')} · {m.status === 'active' ? t('memberActive') : t('memberInvited')}</span></span>
                  <button type="button" className="btn ghost small" disabled={busy} onClick={() => remove(m)}>{t('remove')}</button>
                </div>
              ))}
            </div>
          )}
    </section>
  )
}
