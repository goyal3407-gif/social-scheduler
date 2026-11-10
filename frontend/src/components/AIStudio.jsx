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
  ['writer', 'Reel Writer'],
  ['weekly', 'Weekly Plan'],
  ['audit', 'Profile Audit'],
  ['viral', 'Viral Ideas'],
  ['replies', 'Reply Helper'],
]

export default function AIStudio({ posts, settings, onSendToStudio, onSaveDraft, onSaveDrafts }) {
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
      setPlanMsg(`Added ${res?.imported ?? plan.length} draft${(res?.imported ?? plan.length) === 1 ? '' : 's'} to your Queue — open each one in Studio to add its video.`)
    } catch (e) {
      setPlanMsg(e.message || 'Could not add the plan to the Queue.')
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
      setViralMsg('Saved as a draft — find it in your Queue, then add its video in Studio.')
    } catch (e) { setViralMsg(e.message || 'Could not save the draft.') }
  }

  const makeReplies = () => {
    if (!comment.trim()) { setReplies(null); return }
    setReplies(replyOptions(comment, replyTone))
  }

  return (
    <div>
      <h2 className="section-title">AI Studio</h2>
      <p className="section-sub">Writing help built from your niche and your own posts. Nothing here publishes or sends anything — every idea is a draft until you say so.</p>
      <div className="tabs mb" role="tablist">
        {TOOLS.map(([id, label]) => (
          <button key={id} type="button" className={`tab ${tool === id ? 'active' : ''}`} onClick={() => setTool(id)}>{label}</button>
        ))}
      </div>
      {copied && <div className="alert success">Copied: {copied}</div>}

      {tool === 'writer' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <section className="card">
            <h2>Reel Writer</h2>
            <p className="muted small mb">Pick a topic, get hooks, a full script outline, caption and hashtags — then send it to Studio.</p>
            <label htmlFor="aiNiche">Your niche</label>
            <input id="aiNiche" placeholder="e.g. Europe jobs" value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <label htmlFor="aiTopic" style={{ marginTop: 12 }}>Topic for this Reel</label>
            <input id="aiTopic" placeholder="e.g. How to get a work visa for Poland" value={topic} onChange={(e) => setTopic(e.target.value)} />
            <div className="two-col" style={{ marginTop: 12 }}>
              <div>
                <label htmlFor="aiTone">Tone</label>
                <select id="aiTone" value={tone} onChange={(e) => setTone(e.target.value)}>
                  {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label htmlFor="aiLen">Video length</label>
                <select id="aiLen" value={lengthSec} onChange={(e) => setLengthSec(Number(e.target.value))}>
                  <option value={30}>30 seconds</option>
                  <option value={60}>60 seconds</option>
                  <option value={90}>90 seconds</option>
                </select>
              </div>
            </div>
            <button type="button" className="btn primary mt" onClick={makeScript}>Write my Reel</button>
            <p className="muted small mt">Hooks and scripts are written from templates + your topic. Edit them in your own words before posting.</p>
          </section>

          <section className="card">
            <h2>Your script</h2>
            {!script ? <p className="muted mt">Fill in a topic on the left and press “Write my Reel”.</p> : (
              <div className="mt">
                <h3>Hooks — pick one</h3>
                {script.hooks.slice(0, 10).map((h) => (
                  <div key={h} className="hook-item"><div className="row"><span>“{h}”</span><button type="button" className="copy-btn" onClick={() => copyText(h, setCopied)}>Copy</button></div></div>
                ))}
                <h3 style={{ marginTop: 18 }}>Script outline</h3>
                {script.outline.map((b) => (
                  <p key={b.label + b.time} className="muted small" style={{ marginTop: 6 }}><b style={{ color: 'var(--ink)' }}>{b.time} · {b.label}:</b> {b.text}</p>
                ))}
                <h3 style={{ marginTop: 18 }}>Caption</h3>
                <div className="hook-item" style={{ whiteSpace: 'pre-wrap' }}>{script.caption}</div>
                <p className="muted small mt">{script.hashtags}</p>
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary" onClick={() => onSendToStudio && onSendToStudio({ text: script.caption, hashtags: script.hashtags, cta: '', mediaType: 'video' })}>Send to Studio →</button>
                  <button type="button" className="btn ghost" onClick={() => copyText(`${script.caption}\n\n${script.hashtags}`, setCopied)}>Copy caption + hashtags</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tool === 'weekly' && (
        <div>
          <section className="card">
            <h2>Weekly Plan — 7 days, one post idea per day</h2>
            <p className="muted small mb">One idea per day at 7:00 PM, built from your niche. “Add all to Queue” saves them as drafts — you add each video in Studio when you are ready.</p>
            <label htmlFor="aiWeekNiche">Your niche</label>
            <input id="aiWeekNiche" placeholder="e.g. Europe jobs" value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
              <button type="button" className="btn primary" onClick={makePlan}>Generate my week</button>
              {plan && <button type="button" className="btn ghost" disabled={planBusy} onClick={addPlanToQueue}>{planBusy ? 'Adding…' : 'Add all 7 to Queue (as drafts)'}</button>}
            </div>
            {planMsg && <div className="alert success mt">{planMsg}</div>}
          </section>
          {plan && (
            <section className="card section">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Day</th><th>Format</th><th>Idea</th><th>Hook</th><th /></tr></thead>
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
                              setPlanMsg(`Added “${d.label} — ${d.format}” to your Queue as a draft.`)
                            } catch (e) { setPlanMsg(e.message || 'Could not add the draft.') } finally { setPlanBusy(false) }
                          }}>+ Draft</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small mt">Drafts have no video yet — open each one in Studio, add its video, and it is ready to schedule.</p>
            </section>
          )}
        </div>
      )}

      {tool === 'audit' && (
        <div>
          <section className="card">
            <h2>Profile Audit</h2>
            <p className="muted small mb">
              From your {audit.connected ? 'connected Instagram profile' : 'saved posts'} — {audit.total} post{audit.total === 1 ? '' : 's'} in your queue
              ({audit.published} published · {audit.scheduled} scheduled · {audit.drafts} drafts{audit.failed ? ` · ${audit.failed} failed` : ''}).
              Follower and like numbers are never shown here — Instagram does not share them with this app, so nothing is guessed.
            </p>
            {audit.profile && (
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, padding: 12, border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface-2)' }}>
                {audit.profile.profilePictureUrl && <img src={audit.profile.profilePictureUrl} alt="" style={{ width: 52, height: 52, borderRadius: '50%', objectFit: 'cover' }} />}
                <div>
                  <b>@{audit.profile.username}</b>
                  {audit.profile.biography && <p className="muted small">{audit.profile.biography}</p>}
                  <p className="muted small">{audit.profile.mediaCount} posts on Instagram</p>
                </div>
              </div>
            )}
            <div className="mt">
              {audit.checks.map((c) => (
                <div key={c.label} className={`warn ${c.status === 'ok' ? 'green' : c.status === 'warn' ? 'amber' : 'blue'}`} style={{ marginTop: 10 }}>
                  <div>
                    <b>{c.label}:</b> {c.detail}
                    {c.fix && <div style={{ marginTop: 4 }}><b>Fix:</b> {c.fix}</div>}
                  </div>
                </div>
              ))}
            </div>
            <p className="muted small mt">This audit only reads your data — it changes nothing. Work through the fixes in Studio and the Queue.</p>
          </section>
        </div>
      )}

      {tool === 'viral' && (
        <div className="two-col" style={{ alignItems: 'start' }}>
          <section className="card">
            <h2>Viral Ideas</h2>
            <p className="muted small mb">Trending formats, rewritten for your niche. Pick one, make it yours, save it as a draft.</p>
            <label htmlFor="aiViralNiche">Your niche</label>
            <input id="aiViralNiche" placeholder="e.g. Europe jobs" value={niche} onChange={(e) => saveNiche(e.target.value)} />
            <label htmlFor="aiViralTone" style={{ marginTop: 12 }}>Tone</label>
            <select id="aiViralTone" value={tone} onChange={(e) => setTone(e.target.value)}>
              {TONES.map((t) => <option key={t} value={t}>{t}</option>)}
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
                      {viralFormat === f.name ? 'Selected' : 'Select'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" className="btn primary mt" onClick={makeViralMine}>Make it mine →</button>
          </section>
          <section className="card">
            <h2>Your version</h2>
            {!viralDraft ? <p className="muted mt">Select a format on the left and press “Make it mine”.</p> : (
              <div className="mt">
                <p className="muted small"><b style={{ color: 'var(--ink)' }}>Format:</b> {viralDraft.formatName} · <b style={{ color: 'var(--ink)' }}>Tone:</b> {tone}</p>
                <div className="hook-item mt" style={{ whiteSpace: 'pre-wrap' }}>{viralDraft.caption}</div>
                <p className="muted small mt">{viralDraft.hashtags}</p>
                {viralMsg && <div className="alert success mt">{viralMsg}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
                  <button type="button" className="btn primary" onClick={saveViralDraft}>Save as draft</button>
                  <button type="button" className="btn ghost" onClick={() => onSendToStudio && onSendToStudio({ text: viralDraft.caption, hashtags: viralDraft.hashtags, cta: '', mediaType: 'video' })}>Send to Studio →</button>
                  <button type="button" className="btn ghost" onClick={() => copyText(`${viralDraft.caption}\n\n${viralDraft.hashtags}`, setCopied)}>Copy</button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {tool === 'replies' && (
        <section className="card" style={{ maxWidth: 720 }}>
          <h2>Reply Helper</h2>
          <p className="muted small mb">Paste a comment, get 3 reply drafts. <b style={{ color: 'var(--ink)' }}>Drafts only — nothing is ever sent, commented or liked from here.</b> Copy a reply and paste it in Instagram yourself.</p>
          <label htmlFor="aiComment">Their comment</label>
          <textarea id="aiComment" rows={3} placeholder="e.g. This helped me so much, thank you!" value={comment} onChange={(e) => setComment(e.target.value)} />
          <label htmlFor="aiReplyTone" style={{ marginTop: 12 }}>Tone</label>
          <select id="aiReplyTone" value={replyTone} onChange={(e) => setReplyTone(e.target.value)}>
            {['Friendly', 'Professional', 'Playful', 'Grateful'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <button type="button" className="btn primary mt" disabled={!comment.trim()} onClick={makeReplies}>Draft 3 replies</button>
          {replies && (
            <div className="mt">
              <label>Your reply options — pick one, edit it in your own voice</label>
              {replies.map((r, i) => (
                <div key={i} className="hook-item" style={{ marginTop: 8 }}>
                  <div className="row"><span>{r}</span><button type="button" className="copy-btn" onClick={() => copyText(r, setCopied)}>Copy</button></div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <p className="muted small mt">AI Studio writes from templates and your niche — it does not use your followers' data, and it never posts, comments, likes or follows for you.</p>
    </div>
  )
}
