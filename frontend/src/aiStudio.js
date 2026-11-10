// AI Studio — pure content helpers (no network, no AI API).
// Everything here is template-based: hooks, scripts, plans and replies are
// assembled from the user's own topic/niche and tone, plus their own saved
// posts where a number is shown. Nothing is invented: follower/like counts
// are never generated, and nothing here publishes or sends anything —
// every result is a draft the user reviews first.
export const TONES = ['Direct', 'Friendly', 'Motivational']

const NICHE_TAGS = {
  'europe jobs': ['#europejobs', '#workineurope', '#europevisa', '#jobsinEurope', '#workabroad'],
  jobs: ['#jobs', '#jobsearch', '#career', '#workabroad', '#hiring'],
  travel: ['#travel', '#wanderlust', '#travelreels', '#explore'],
  fitness: ['#fitness', '#workout', '#gymlife', '#fitlife'],
  food: ['#foodie', '#recipes', '#foodreels', '#cooking'],
  business: ['#business', '#entrepreneur', '#smallbusiness', '#marketing'],
  creator: ['#contentcreator', '#creatorlife', '#reelsinstagram', '#growoninstagram'],
}
export function nicheHashtags(niche) {
  const key = String(niche || '').trim().toLowerCase()
  for (const [k, tags] of Object.entries(NICHE_TAGS)) {
    if (key.includes(k)) return tags
  }
  return ['#reels', '#contentcreator', '#growoninstagram', '#viralreels']
}

const GENERIC_TAGS = ['#reelsinstagram', '#contentcreator', '#learnontiktok']

/** 10+ hook formulas with the user's topic filled in. */
export function hookFormulas(topic, niche) {
  const t = (topic || niche || 'this topic').trim()
  return [
    `Stop scrolling — ${t} changes everything.`,
    `Nobody talks about ${t}, but they should.`,
    `I wish someone told me this about ${t} sooner.`,
    `3 mistakes you are making with ${t} (and how to fix them).`,
    `POV: you finally figured out ${t}.`,
    `The truth about ${t} that no one will tell you.`,
    `Save this — you will need it for ${t}.`,
    `Watch until the end — the last tip about ${t} is the best one.`,
    `If you are struggling with ${t}, this is for you.`,
    `Day 1 of ${t} — follow along.`,
    `${t} in 60 seconds — let's go.`,
    `Don't start ${t} until you watch this.`,
  ]
}

const TONE_OPENERS = {
  Direct: (t) => `Here's the truth about ${t}:`,
  Friendly: (t) => `Okay, let's talk about ${t} — honestly and simply.`,
  Motivational: (t) => `You can do this. Let's break down ${t} together.`,
}
const TONE_CTAS = {
  Direct: 'Comment GUIDE and I will send you the steps.',
  Friendly: 'Let me know in the comments what you would like to see next!',
  Motivational: 'Save this, share it with someone who needs it, and start today.',
}

/** Full Reel script outline + caption + hashtags for a topic. */
export function reelScript({ topic, niche = '', tone = 'Direct', lengthSec = 60 }) {
  const t = (topic || niche || 'your topic').trim()
  const n = (niche || '').trim()
  const opener = (TONE_OPENERS[tone] || TONE_OPENERS.Direct)(t)
  const cta = TONE_CTAS[tone] || TONE_CTAS.Direct
  const hook = hookFormulas(t, n)[0]
  const beats = Math.max(2, Math.round(lengthSec / 15))
  const outline = [
    { time: '0–3s', label: 'Hook', text: hook },
    { time: '3–10s', label: 'Problem', text: `${opener} Most people get stuck on the same 2–3 things.` },
    ...Array.from({ length: beats }, (_, i) => ({
      time: `${10 + i * 15}–${25 + i * 15}s`,
      label: `Point ${i + 1}`,
      text: `Point ${i + 1}: one clear, practical step about ${t} — show it, don't just say it.`,
    })),
    { time: `${10 + beats * 15}s+`, label: 'Proof', text: 'Show a real example or result from your own experience.' },
    { time: 'Last 5s', label: 'Call to action', text: cta },
  ]
  const caption = `${hook}\n\n${opener}\n\nIn this Reel I break down ${t} into simple steps you can actually follow.\n\n${cta}\n\nFollow for more on ${n || 'this topic'}.`
  const hashtags = [...new Set([...nicheHashtags(n), ...GENERIC_TAGS])].join(' ')
  return { hooks: hookFormulas(t, n), outline, caption, hashtags }
}

const WEEK_FORMATS = [
  { format: 'Quick tip', idea: (n) => `One quick tip about ${n} that most people miss.`, hook: (n) => `One ${n} tip in 30 seconds.` },
  { format: 'Myth vs reality', idea: (n) => `A common myth about ${n} — then the reality, with one example.`, hook: (n) => `Stop believing this myth about ${n}.` },
  { format: 'Tutorial', idea: (n) => `Teach one ${n} skill in under 60 seconds, step by step.`, hook: (n) => `How to start with ${n} — step by step.` },
  { format: 'Behind the scenes', idea: (n) => `Show the real work behind ${n} — the setup, the outtakes, the messy middle.`, hook: (n) => `The messy truth behind ${n}.` },
  { format: 'Q&A', idea: (n) => `Answer the question about ${n} you get asked the most.`, hook: (n) => `You keep asking me about ${n} — here is the answer.` },
  { format: 'Story', idea: (n) => `Your own story with ${n}: where you started vs where you are now.`, hook: (n) => `My ${n} story — from zero to here.` },
  { format: 'Call to action', idea: (n) => `End the week with one clear ask: comment, save, or follow for more ${n}.`, hook: (n) => `If ${n} matters to you, do this one thing.` },
]

/** 7-day plan: one post idea per day from a start date, 7:00 PM each day. */
export function weeklyPlan({ niche = '', startDate = null }) {
  const n = (niche || 'your niche').trim()
  const start = startDate ? new Date(startDate) : new Date()
  start.setHours(0, 0, 0, 0)
  return WEEK_FORMATS.map((f, i) => {
    const d = new Date(start.getTime() + i * 86400000)
    d.setHours(19, 0, 0, 0)
    return {
      date: d,
      label: d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }),
      format: f.format,
      idea: f.idea(n),
      hook: f.hook(n),
      scheduleTime: d.toISOString(),
    }
  })
}

export const VIRAL_FORMATS = [
  { name: '3 mistakes', format: 'List', why: 'People stay to check they are not making mistake #3.', example: (n) => `3 mistakes everyone makes with ${n} — #3 costs the most.` },
  { name: 'POV', format: 'POV', why: 'Puts the viewer inside the story in one second.', example: (n) => `POV: you finally understand ${n}.` },
  { name: 'Day X of…', format: 'Series', why: 'A series gives people a reason to follow for the next part.', example: (n) => `Day 1 of learning ${n} from scratch.` },
  { name: 'Myth vs reality', format: 'Debunk', why: 'Surprise keeps people watching to the reveal.', example: (n) => `Myth: ${n} is only for experts. Reality: watch this.` },
  { name: 'Stop doing X', format: 'Warning', why: 'A warning creates urgency to keep watching.', example: (n) => `Stop doing this with ${n} — do this instead.` },
  { name: 'Nobody talks about…', format: 'Insider', why: 'Feels like a secret the viewer is now part of.', example: (n) => `Nobody talks about this part of ${n}.` },
  { name: 'Before / after', format: 'Transformation', why: 'Progress stories are the easiest to root for.', example: (n) => `${n}: before vs after — the difference is one habit.` },
  { name: 'Teach it in 60 seconds', format: 'Tutorial', why: 'A small, complete win earns a save.', example: (n) => `${n} in 60 seconds — save this.` },
  { name: 'Q&A', format: 'Q&A', why: 'Answers a real question, so comments write themselves.', example: (n) => `Your most-asked question about ${n}, answered.` },
  { name: 'Storytime', format: 'Story', why: 'Stories hold attention longer than tips alone.', example: (n) => `Storytime: the day ${n} changed everything for me.` },
]

/** "Make it mine": rewrite a viral format in the user's tone + niche. */
export function viralRewrite({ formatName, niche = '', tone = 'Direct' }) {
  const n = (niche || 'your niche').trim()
  const f = VIRAL_FORMATS.find((x) => x.name === formatName) || VIRAL_FORMATS[0]
  const hook = f.example(n)
  const bodies = {
    Direct: `${hook}\n\nHere is the short version: what works, what does not, and the one step to take today.\n\n${TONE_CTAS.Direct}`,
    Friendly: `${hook}\n\nLet me break it down simply, no jargon — just what I would tell a friend starting out.\n\n${TONE_CTAS.Friendly}`,
    Motivational: `${hook}\n\nYou do not need to be perfect. You need to start. Here is the first step.\n\n${TONE_CTAS.Motivational}`,
  }
  return {
    caption: bodies[tone] || bodies.Direct,
    hashtags: [...new Set([...nicheHashtags(n), ...GENERIC_TAGS])].join(' '),
    formatName: f.name,
  }
}

/** 3 reply drafts for a pasted comment. Drafts only — never sent. */
export function replyOptions(comment, tone = 'Friendly') {
  const c = String(comment || '').trim()
  const short = c.length > 60
  const openers = {
    Friendly: 'Thank you so much — really appreciate you watching!',
    Professional: 'Thanks for your comment — glad this was helpful.',
    Playful: 'You get it! This one was fun to make.',
    Grateful: 'Thank you — comments like this keep me going.',
  }
  const base = openers[tone] || openers.Friendly
  return [
    `${base}`,
    `${base} ${short ? 'Great point — I will cover that in a future video.' : 'Let me know what you would like to see next!'}`,
    `${base} ${short ? 'I hear you — what part should I explain more deeply?' : 'What was the most useful part for you?'}`,
  ]
}

/**
 * Profile audit from REAL data only: the connected Instagram profile
 * (username, bio, media count) and the user's own saved posts. Follower and
 * like counts are never invented — the audit says so plainly when they are
 * not available. Each check: { label, status: 'ok'|'warn'|'info', detail, fix }.
 */
export function profileAudit({ settings, posts }) {
  const list = posts || []
  const profile = settings?.instagramProfile || null
  const connected = !!settings?.instagramConnected
  const checks = []
  const total = list.length
  const published = list.filter((p) => p.status === 'published').length
  const scheduled = list.filter((p) => p.status === 'scheduled').length
  const drafts = list.filter((p) => p.status === 'draft').length
  const failed = list.filter((p) => p.status === 'failed').length
  const noHashtag = list.filter((p) => !(p.hashtags || '').trim()).length
  const shortCaption = list.filter((p) => (p.caption || '').trim().length < 40).length
  const noMedia = list.filter((p) => !p.mediaUrl).length
  const now = Date.now()
  const upcomingWeek = list.filter((p) => p.status === 'scheduled' && p.scheduleTime && new Date(p.scheduleTime).getTime() >= now && new Date(p.scheduleTime).getTime() < now + 7 * 86400000).length
  const lastPublished = list
    .filter((p) => p.status === 'published' && p.scheduleTime)
    .map((p) => new Date(p.scheduleTime).getTime())
    .filter((t) => !Number.isNaN(t))
    .sort((a, b) => b - a)[0]
  const daysSincePublished = lastPublished ? Math.floor((now - lastPublished) / 86400000) : null

  if (!connected) {
    checks.push({ label: 'Instagram connection', status: 'warn', detail: 'Instagram is not connected, so this audit uses only your saved posts.', fix: 'Connect Instagram in Settings (paste your access token) to audit your real profile too.' })
  } else {
    checks.push({ label: 'Instagram connection', status: 'ok', detail: `Connected${settings?.instagramUsername ? ` as @${settings.instagramUsername}` : ''}.`, fix: '' })
  }
  if (profile) {
    if ((profile.biography || '').trim()) {
      checks.push({ label: 'Bio', status: 'ok', detail: `Your bio is filled in: “${profile.biography}”`, fix: '' })
    } else {
      checks.push({ label: 'Bio', status: 'warn', detail: 'No bio was found on your connected profile.', fix: 'Add one line: who you help + what to do next (e.g. “Europe jobs & visas — DM me GUIDE”).' })
    }
    checks.push({ label: 'Posts on Instagram', status: 'info', detail: `${profile.mediaCount ?? '—'} posts on your Instagram account.`, fix: '' })
  }
  checks.push({
    label: 'Follower & like numbers', status: 'info',
    detail: 'Not shown here — Instagram does not share follower or like counts with this app.',
    fix: 'No numbers on this page are guessed. Check them in the Instagram app itself.',
  })
  checks.push({
    label: 'Posting consistency', status: upcomingWeek >= 3 ? 'ok' : 'warn',
    detail: `${upcomingWeek} post${upcomingWeek === 1 ? '' : 's'} scheduled in the next 7 days (${scheduled} scheduled in total).`,
    fix: upcomingWeek >= 3 ? '' : 'Aim for at least 3 posts in the next 7 days — use Weekly Plan in AI Studio to fill the week.',
  })
  if (daysSincePublished === null && published === 0) {
    checks.push({ label: 'Published posts', status: 'warn', detail: 'No published posts in your queue yet.', fix: 'Publish one scheduled post from the Queue, or import your existing Instagram posts from the setup wizard.' })
  } else if (daysSincePublished !== null && daysSincePublished > 14) {
    checks.push({ label: 'Published posts', status: 'warn', detail: `Your last published post was ${daysSincePublished} days ago.`, fix: 'Post something this week — even a simple tip Reel keeps the account active.' })
  } else {
    checks.push({ label: 'Published posts', status: 'ok', detail: `${published} published post${published === 1 ? '' : 's'}${daysSincePublished !== null ? `, most recent ${daysSincePublished} day${daysSincePublished === 1 ? '' : 's'} ago` : ''}.`, fix: '' })
  }
  if (total > 0 && noHashtag / total > 0.3) {
    checks.push({ label: 'Hashtags', status: 'warn', detail: `${noHashtag} of ${total} posts have no hashtags.`, fix: 'Add 3–10 relevant hashtags per post — the Reel Writer adds them for you.' })
  } else if (total > 0) {
    checks.push({ label: 'Hashtags', status: 'ok', detail: 'Most posts have hashtags.', fix: '' })
  }
  if (total > 0 && shortCaption / total > 0.3) {
    checks.push({ label: 'Captions', status: 'warn', detail: `${shortCaption} of ${total} captions are under 40 characters.`, fix: 'Give each caption a hook + one useful line + a call to action — the Reel Writer drafts this for you.' })
  } else if (total > 0) {
    checks.push({ label: 'Captions', status: 'ok', detail: 'Most captions are a good length.', fix: '' })
  }
  if (drafts > 0) {
    checks.push({ label: 'Drafts waiting', status: noMedia > 0 ? 'warn' : 'info', detail: `${drafts} draft${drafts === 1 ? '' : 's'} waiting${noMedia > 0 ? `, ${noMedia} without media yet` : ''}.`, fix: noMedia > 0 ? 'Open each draft in Studio, add its video or image, and schedule it.' : 'Open drafts in Studio and schedule the ones you are happy with.' })
  }
  if (failed > 0) {
    checks.push({ label: 'Failed posts', status: 'warn', detail: `${failed} post${failed === 1 ? '' : 's'} failed to publish.`, fix: 'Open the Queue, check the failed post — usually the media link is not public or the format is wrong (vertical video must be REELS). Fix it and publish again.' })
  }
  return { profile, connected, total, published, scheduled, drafts, failed, checks }
}
