import { useMemo, useState } from 'react'
import { TONES, hookFormulas, reelScript, weeklyPlan, VIRAL_FORMATS, viralRewrite, replyOptions, profileAudit } from '../aiStudio.js'

// AI Studio — template-based writing help from the user's own niche and
// saved posts. No AI API, no invented numbers, and nothing here publishes
// or sends anything: every result is a draft the user reviews, and only
// goes to the Queue or Studio when they tap the button.
function copyText(text, setCopied) {
  const done = () => { setCopied(text); setTimeout(() => setCopied(''), 1600) }
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done))
  else fallbackCopy(text, done)
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea')
  ta.value = text; document.body.appendChild(ta); ta.select()
  try { document.execCommand('copy'); done() } catch { /* clipboard unavailable */ }
  document.body.removeChild(ta)
}

const TOOLS = [
  ['writer', 'aiTabWriter'],
  ['weekly', 'aiTabWeekly'],
  ['audit', 'aiTabAudit'],
  ['viral', 'aiTabViral'],
  ['replies', 'aiTabReplies'],
]

export default function AIStudio({ posts, settings, onSendToStudio, onSaveDraft, onSaveDrafts, tr }) {
  const t = tr || ((k) => k)
  const [tool, setTool] = useState('writer')
  const [niche, setNiche] = useState(() => {
    try { return localStorage.getItem('ss-ai-niche') || settings?.instagramHandle || 'Europe jobs' } catch { return settings?.instagramHandle || 'Europe jobs' }
  })
  const saveNiche = (v) => {
    setNiche(v)
    try { localStorage.setItem('ss-ai-niche', v) } catch { /* storage unavailable */ }
  }
  const [topic, setTopic] = useState('')
  const [tone, setTone] = useState('Direct')
  const [lengthSec, setLengthSec] = useState(60)
  const [script, setScript] = useState(null)
  const [copied, setCopied] = useState('')
  const [plan, setPlan] = useState(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [planMsg, setPlanMsg] = useState('')
  const [viralFormat, setViralFormat] = useState(VIRAL_FORMATS[0].name)
  const [viralDraft, setViralDraft] = useState(null)
  const [viralMsg, setViralMsg] = useState('')
  const [comment, setComment] = useState('')
  const [replyTone, setReplyTone] = useState('Friendly')
  const [replies, setReplies] = useState(null)
  const [draftMsg, setDraftMsg] = useState('')

  const audit = useMemo(() => profileAudit({ settings, posts }), [settings, posts])

  const makeScript = () => {
    setScript(reelScript({ topic: topic.trim() || niche, niche, tone, lengthSec }))
  }

  const makePlan = () => setPlan(weeklyPlan({ niche }))

  const addPlanToQueue = async () => {
    if (!plan || !onSaveDrafts) return
    setPlanBusy(true); setPlanMsg('')
    try {
      const res = await onSaveDrafts(plan.map((d) => ({
        mediaUrl: '', mediaType: 'video',
        caption: `${d.hook}\n\n${d.idea}`,
        hashtags: '', cta: '', platform: 'Instagram',
        scheduleTime: d.scheduleTime, status: 'draft', format: 'REELS',
      })))
      const added = res?.imported ?? plan.length
      setPlanMsg(t(added === 1 ? 'aiPlanAddedOne' : 'aiPlanAddedMany').replace('{n}', added))
    } catch (e) {
      setPlanMsg(e.message || t('aiPlanAddFail'))
    } finally { setPlanBusy(false) }
  }

  const makeViralMine = () => {
    setViralDraft(viralRewrite({ formatName: viralFormat, niche, tone }))
    setViralMsg('')
  }

  const saveViralDraft = async () => {
    if (!viralDraft || !onSaveDraft) return
    setViralMsg('')
    try {
      await onSaveDraft({
        mediaUrl: '', mediaType: 'video', caption: viralDraft.caption,
        hashtags: viralDraft.hashtags, cta: '', platform: 'Instagram',
        scheduleTime: '', status: 'draft', format: 'REELS',
      })
      setViralMsg(t('aiViralSaved'))
    } catch (e) { setViralMsg(e.message || t('aiDraftSaveFail')) }
  }

  const makeReplies = () => {
    if (!comment.trim()) { setReplies(null); return }
    setReplies(replyOptions(comment, replyTone))
  }

  return (
    <div>
      <h2 className="section-title">{t('aiStudio')}</h2>
      <p className="section-sub">{t('aiSub')}</p>
      <div className="tabs mb" role="tablist">
        {TOOLS.map(([id, labelKey]) => (
          <button key={id} type="button" className={`tab ${tool === id ? 'active' : ''}`} onClick={() => setTool(id)}>{t(labelKey)}</button>
        ))}
      </div>
      {copied && <div className="alert success">{t('toolsCopied')}{copied}</div>}

      {tool === 'writer' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <section className="card">
            <h2>{t('aiTabWriter')}</h2>
            <p className="muted small mb">{t('aiWriterSub')}</p>
            <label htmlFor="aiNiche">{t('aiNiche')}</label>
            <input id="aiNiche" placeholder={t('aiNichePh')} value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <label htmlFor="aiTopic" style={{ marginTop: 12 }}>{t('aiTopicLabel')}</label>
            <input id="aiTopic" placeholder={t('aiTopicPh')} value={topic} onChange={(e) => setTopic(e.target.value)} />
            <div className="two-col" style={{ marginTop: 12 }}>
              <div>
                <label htmlFor="aiTone">{t('toolsTone')}</label>
                <select id="aiTone" value={tone} onChange={(e) => setTone(e.target.value)}>
                  {TONES.map((toneName) => <option key={toneName} value={toneName}>{toneName}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="aiLen">{t('aiLenLabel')}</label>
                <select id="aiLen" value={lengthSec} onChange={(e) => setLengthSec(Number(e.target.value))}>
                  <option value={30}>{t('aiSec30')}</option>
                  <option value={60}>{t('aiSec60')}</option>
                  <option value={90}>{t('aiSec90')}</option>
                </select>
              </div>
            </div>
            <button type="button" className="btn primary mt" onClick={makeScript}>{t('aiWriteBtn')}</button>
            <p className="muted small mt">{t('aiWriterNote')}</p>
          </section>

          <section className="card">
            <h2>{t('aiYourScript')}</h2>
            {!script ? <p className="muted mt">{t('aiScriptEmpty')}</p> : (
              <div className="mt">
                <h3>{t('aiHooksPick')}</h3>
                {script.hooks.slice(0, 10).map((h) => (
                  <div key={h} className="hook-item"><div className="row"><span>“{h}”</span><button type="button" className="copy-btn" onClick={() => copyText(h, setCopied)}>{t('toolsCopy')}</button></div></div>
                ))}
                <h3 style={{ marginTop: 18 }}>{t('aiOutline')}</h3>
                {script.outline.map((b) => (
                  <p key={b.label + b.time} className="muted small" style={{ marginTop: 6 }}><b style={{ color: 'var(--ink)' }}>{b.time} · {b.label}:</b> {b.text}</p>
                ))}
                <h3 style={{ marginTop: 18 }}>{t('captionLabel')}</h3>
                <div className="hook-item" style={{ whiteSpace: 'pre-wrap' }}>{script.caption}</div>
                <p className="muted small mt">{script.hashtags}</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary" onClick={() => onSendToStudio && onSendToStudio({ text: script.caption, hashtags: script.hashtags, cta: '', mediaType: 'video' })}>{t('aiSendStudio')}</button>
                  <button type="button" className="btn ghost" onClick={() => copyText(`${script.caption}\n\n${script.hashtags}`, setCopied)}>{t('aiCopyCapTags')}</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tool === 'weekly' && (
        <div>
          <section className="card">
            <h2>{t('aiWeeklyTitle')}</h2>
            <p className="muted small mb">{t('aiWeeklySub')}</p>
            <label htmlFor="aiWeekNiche">{t('aiNiche')}</label>
            <input id="aiWeekNiche" placeholder={t('aiNichePh')} value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" onClick={makePlan}>{t('aiGenerateWeek')}</button>
              {plan && <button type="button" className="btn ghost" disabled={planBusy} onClick={addPlanToQueue}>{planBusy ? t('aiAdding') : t('aiAddAllQueue')}</button>}
            </div>
            {planMsg && <div className="alert success mt">{planMsg}</div>}
          </section>
          {plan && (
            <section className="card section">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>{t('aiDayHead')}</th><th>{t('formatLabel')}</th><th>{t('aiIdeaHead')}</th><th>{t('aiHookHead')}</th><th /></tr></thead>
                  <tbody>
                    {plan.map((d) => (
                      <tr key={d.scheduleTime}>
                        <td><b>{d.label}</b></td>
                        <td>{d.format}</td>
                        <td>{d.idea}</td>
                        <td>{d.hook}</td>
                        <td>
                          <button type="button" className="btn ghost small" disabled={planBusy} onClick={async () => {
                            setPlanBusy(true); setPlanMsg('')
                            try {
                              await onSaveDrafts([{ mediaUrl: '', mediaType: 'video', caption: `${d.hook}\n\n${d.idea}`, hashtags: '', cta: '', platform: 'Instagram', scheduleTime: d.scheduleTime, status: 'draft', format: 'REELS' }])
                              setPlanMsg(t('aiPlanOneAdded').replace('{label}', d.label).replace('{format}', d.format))
                            } catch (e) { setPlanMsg(e.message || t('aiDraftAddFail')) } finally { setPlanBusy(false) }
                          }}>{t('aiAddDraft')}</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small mt">{t('aiWeeklyFoot')}</p>
            </section>
          )}
        </div>
      )}

      {tool === 'audit' && (
        <div>
          <section className="card">
            <h2>{t('aiTabAudit')}</h2>
            <p className="muted small mb">
              {t('aiAuditSub')
                .replace('{source}', t(audit.connected ? 'aiAuditConnected' : 'aiAuditSaved'))
                .replace('{total}', audit.total)
                .replace('{published}', audit.published)
                .replace('{scheduled}', audit.scheduled)
                .replace('{drafts}', audit.drafts)
                .replace('{failedPart}', audit.failed ? t('aiAuditFailedPart').replace('{n}', audit.failed) : '')}
            </p>
            {audit.profile && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-2)' }}>
                {audit.profile.profilePictureUrl && <img src={audit.profile.profilePictureUrl} alt="" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />}
                <div>
                  <b>@{audit.profile.username}</b>
                  {audit.profile.biography && <p className="muted small">{audit.profile.biography}</p>}
                  <p className="muted small">{t('aiAuditPostsOnIg').replace('{n}', audit.profile.mediaCount)}</p>
                </div>
              </div>
            )}
            <div className="mt">
              {audit.checks.map((c) => (
                <div key={c.label} className={`warn ${c.status === 'ok' ? 'green' : c.status === 'warn' ? 'amber' : 'blue'}`} style={{ marginTop: 10 }}>
                  <div>
                    <b>{c.label}:</b> {c.detail}
                    {c.fix && <div style={{ marginTop: 4 }}><b>{t('fixWord')}:</b> {c.fix}</div>}
                  </div>
                </div>
              ))}
            </div>
            <p className="muted small mt">{t('aiAuditFoot')}</p>
          </section>
        </div>
      )}

      {tool === 'viral' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <section className="card">
            <h2>{t('aiTabViral')}</h2>
            <p className="muted small mb">{t('aiViralSub')}</p>
            <label htmlFor="aiViralNiche">{t('aiNiche')}</label>
            <input id="aiViralNiche" placeholder={t('aiNichePh')} value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <label htmlFor="aiViralTone" style={{ marginTop: 12 }}>{t('toolsTone')}</label>
            <select id="aiViralTone" value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((toneName) => <option key={toneName} value={toneName}>{toneName}</option>)}
            </select>
            <div className="mt">
              {VIRAL_FORMATS.map((f) => (
                <div key={f.name} className="bank-item">
                  <div className="row">
                    <div>
                      <b>{f.name}</b> <span className="muted small">· {f.format}</span>
                      <p className="muted small" style={{ marginTop: 4 }}>{f.example(niche)}</p>
                      <p className="muted small">{f.why}</p>
                    </div>
                    <button type="button" className={`btn small ${viralFormat === f.name ? 'primary' : 'ghost'}`} onClick={() => { setViralFormat(f.name); setViralDraft(null); setViralMsg('') }}>
                      {viralFormat === f.name ? t('aiSelected') : t('aiSelect')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="btn primary mt" onClick={makeViralMine}>{t('aiMakeMine')}</button>
          </section>
          <section className="card">
            <h2>{t('aiYourVersion')}</h2>
            {!viralDraft ? <p className="muted mt">{t('aiViralEmpty')}</p> : (
              <div className="mt">
                <p className="muted small"><b style={{ color: 'var(--ink)' }}>{t('formatLabel')}:</b> {viralDraft.formatName} · <b style={{ color: 'var(--ink)' }}>{t('toolsTone')}:</b> {tone}</p>
                <div className="hook-item mt" style={{ whiteSpace: 'pre-wrap' }}>{viralDraft.caption}</div>
                <p className="muted small mt">{viralDraft.hashtags}</p>
                {viralMsg && <div className="alert success mt">{viralMsg}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary" onClick={saveViralDraft}>{t('aiSaveAsDraft')}</button>
                  <button type="button" className="btn ghost" onClick={() => onSendToStudio && onSendToStudio({ text: viralDraft.caption, hashtags: viralDraft.hashtags, cta: '', mediaType: 'video' })}>{t('aiSendStudio')}</button>
                  <button type="button" className="btn ghost" onClick={() => copyText(`${viralDraft.caption}\n\n${viralDraft.hashtags}`, setCopied)}>{t('toolsCopy')}</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tool === 'replies' && (
        <section className="card" style={{ maxWidth: 720 }}>
          <h2>{t('aiTabReplies')}</h2>
          <p className="muted small mb">{t('aiRepliesSubA')} <b style={{ color: 'var(--ink)' }}>{t('aiRepliesSubB')}</b> {t('aiRepliesSubC')}</p>
          <label htmlFor="aiComment">{t('toolsTheirComment')}</label>
          <textarea id="aiComment" rows={3} placeholder={t('toolsCommentPh')} value={comment} onChange={(e) => setComment(e.target.value)} />
          <label htmlFor="aiReplyTone" style={{ marginTop: 12 }}>{t('toolsTone')}</label>
          <select id="aiReplyTone" value={replyTone} onChange={(e) => setReplyTone(e.target.value)}>
            {['Friendly', 'Professional', 'Playful', 'Grateful'].map((toneName) => <option key={toneName} value={toneName}>{toneName}</option>)}
          </select>
          <button type="button" className="btn primary mt" disabled={!comment.trim()} onClick={makeReplies}>{t('aiDraft3')}</button>
          {replies && (
            <div className="mt">
              <label>{t('aiReplyOptionsLabel')}</label>
              {replies.map((r, i) => (
                <div key={i} className="hook-item" style={{ marginTop: 8 }}>
                  <div className="row"><span>{r}</span><button type="button" className="copy-btn" onClick={() => copyText(r, setCopied)}>{t('toolsCopy')}</button></div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <p className="muted small mt">{t('aiFoot')}</p>
    </div>
  )
}
