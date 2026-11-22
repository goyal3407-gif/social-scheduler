// KiluaAI UI language. Two layers (batch 5):
//  - CORE below: the small set the app shell (top bar, nav, account
//    menu) needs before anything else loads — it ships in the main
//    bundle.
//  - DICT in ./i18n-dict.js: the full dictionary for every screen,
//    loaded lazily via loadDict() so the main bundle stays inside
//    its size budget no matter how many strings the screens gain.
// trFor resolves dict -> core -> English dict -> English core -> the
// key itself, so a missing entry degrades to English, never a crash.
// Post content (captions, hashtags) is never translated. The choice
// persists per user (settings.uiLanguage) + locally (ss-lang). Hindi
// here is the easy Roman-Hinglish style, so a first-time Indian
// creator can follow every screen.
export const CORE = {
  en: {
    home: 'Home', create: 'Create', queue: 'Queue', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', pricing: 'Pricing', contact: 'Contact', logout: 'Log out', switchToAdmin: 'Switch to Admin',
    createPost: 'Create Post', workspace: 'Workspace', myWorkspace: 'My workspace',
    loading: 'Loading…', searchPlaceholder: 'Search posts & media…',
    scheduled: 'Scheduled', published: 'Published', failed: 'Failed', partial: 'Partial', drafts: 'Drafts',
    retry: 'Retry', dismiss: 'Dismiss',
    freeForever: 'Free forever',
    igChecking: 'IG checking…', igBrokenShort: 'IG connection broken',
    igConnectedWord: 'connected', igNotConnected: 'IG not connected',
    planBadge: '{name} plan', language: 'Language', switchWord: 'Switch',
    lightTheme: 'Light theme', darkTheme: 'Dark theme',
  },
  hi: {
    home: 'Home', create: 'Banayein', queue: 'Queue List', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', pricing: 'Plans ke daam', contact: 'Contact', logout: 'Log out', switchToAdmin: 'Admin par switch karein',
    createPost: 'Post Banayein', workspace: 'Workspace', myWorkspace: 'Mera workspace',
    loading: 'Load ho raha hai…', searchPlaceholder: 'Posts aur media search karein…',
    scheduled: 'Tay posts', published: 'Publish hue', failed: 'Fail hue', partial: 'Aadhe publish', drafts: 'Drafts',
    retry: 'Dobara koshish', dismiss: 'Hatayein',
    freeForever: 'Hamesha free',
    igChecking: 'IG check ho raha hai…', igBrokenShort: 'IG connection toota hai',
    igConnectedWord: 'juda hua', igNotConnected: 'IG juda nahi hai',
    planBadge: '{name} ka plan', language: 'Bhasha', switchWord: 'Badlein',
    lightTheme: 'Light theme', darkTheme: 'Dark theme',
  },
}

let cachedDict = null
let dictPromise = null
// The loaded full dictionary, or null while it is still in flight
// (shared.jsx reads this for components that receive no tr prop).
export function dictSync() { return cachedDict }
// Loads the full dictionary chunk once; resolves to the dict, or to
// an empty shell if the chunk cannot load (the UI then runs on CORE
// + English fallbacks instead of breaking).
export function loadDict() {
  if (cachedDict) return Promise.resolve(cachedDict)
  if (!dictPromise) {
    dictPromise = import('./i18n-dict.js')
      .then((m) => { cachedDict = m.DICT || { en: {}, hi: {} }; return cachedDict })
      .catch(() => { cachedDict = { en: {}, hi: {} }; return cachedDict })
  }
  return dictPromise
}

export const trFor = (lang, dict) => (key) => {
  const d = dict || cachedDict
  if (lang === 'hi') {
    const v = (d && d.hi && d.hi[key]) || CORE.hi[key]
    if (v) return v
  }
  return (d && d.en && d.en[key]) || CORE.en[key] || key
}
