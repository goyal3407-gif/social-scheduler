// KiluaAI UI language: a dictionary for the app UI — nav, main
// screens (Home, Queue, Studio, Media, Calendar, Bulk, Connections,
// Settings), plan + stats cards, the first-run guide and the team
// screens. Post content (captions, hashtags) is never translated.
// Default EN; the choice persists per user (settings.uiLanguage) +
// locally. Hindi here is the easy Hinglish style the app already
// used, so a first-time Indian creator can follow every screen.
export const STRINGS = {
  en: {
    home: 'Home', create: 'Create', queue: 'Queue', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', contact: 'Contact', logout: 'Log out', createPost: 'Create Post',
    scheduled: 'Scheduled', published: 'Published', totalPosts: 'Total posts', upNext: 'Up next',
    searchPlaceholder: 'Search posts & media…',
    homeSearchPlaceholder: 'Search posts, media…',
    goodMorning: 'Good morning', goodAfternoon: 'Good afternoon', goodEvening: 'Good evening',
    // Queue + post rows (batch 3)
    failed: 'Failed', partial: 'Partial', drafts: 'Drafts', all: 'All',
    retry: 'Retry', publish: 'Publish', edit: 'Edit', delete: 'Delete',
    duplicate: 'Duplicate', reschedule: 'Reschedule', publishDue: 'Publish due',
    retrying: 'Retrying…', retryDone: 'Retried — check the post status.',
    // Studio (batch 3)
    captionLibrary: 'Caption library', saveCaptionSet: 'Save caption as a set',
    useSet: 'Use', aiAssistant: 'AI caption assistant', aiSuggest: 'Suggest a caption',
    aiTopicHint: 'What is this post about?',
    // Dashboard cards + guide (batch 3)
    yourNumbers: 'Your numbers', basicStats: 'Basic stats',
    gettingStarted: 'Getting started', guideTitle: 'Your first post in 2 minutes',
    next: 'Next', back: 'Back', skip: 'Skip', finish: 'Done',
    successRate: 'Went fully live', perAccount: 'Per account',
    // Team (batch 3)
    team: 'Team', inviteMember: 'Invite a team member', invite: 'Invite',
    roleScheduler: 'Scheduler — can create & schedule posts',
    roleViewer: 'Viewer — can only look',
    remove: 'Remove', workspace: 'Workspace', myWorkspace: 'My workspace',
    // Common
    save: 'Save', cancel: 'Cancel', close: 'Close', loading: 'Loading…',
  },
  hi: {
    home: 'Home', create: 'Banayein', queue: 'Queue List', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', contact: 'Contact', logout: 'Log out', createPost: 'Post Banayein',
    scheduled: 'Tay posts', published: 'Publish hue', totalPosts: 'Kul posts', upNext: 'Aane wale posts',
    searchPlaceholder: 'Posts aur media search karein…',
    homeSearchPlaceholder: 'Posts, media search karein…',
    goodMorning: 'Suprabhat', goodAfternoon: 'Namaskar', goodEvening: 'Shubh sandhya',
    failed: 'Fail hue', partial: 'Aadhe publish', drafts: 'Drafts', all: 'Sab',
    retry: 'Dobara koshish', publish: 'Publish karein', edit: 'Badlein', delete: 'Hatayein',
    duplicate: 'Copy banayein', reschedule: 'Samay badlein', publishDue: 'Due posts publish karein',
    retrying: 'Koshish ho rahi hai…', retryDone: 'Dobara koshish ho gayi — post ka status dekhein.',
    captionLibrary: 'Caption library', saveCaptionSet: 'Caption set ki tarah save karein',
    useSet: 'Use karein', aiAssistant: 'AI caption sahayak', aiSuggest: 'Caption sujhayein',
    aiTopicHint: 'Ye post kis baare mein hai?',
    yourNumbers: 'Aapke numbers', basicStats: 'Basic stats',
    gettingStarted: 'Shuruaat karein', guideTitle: 'Pehli post sirf 2 minute mein',
    next: 'Aage', back: 'Peeche', skip: 'Skip karein', finish: 'Ho gaya',
    successRate: 'Poori tarah live hue', perAccount: 'Har account ke hisaab se',
    team: 'Team', inviteMember: 'Team member ko bulayein', invite: 'Bulayein',
    roleScheduler: 'Scheduler — post bana aur schedule kar sakta hai',
    roleViewer: 'Viewer — sirf dekh sakta hai',
    remove: 'Hatayein', workspace: 'Workspace', myWorkspace: 'Mera workspace',
    save: 'Save karein', cancel: 'Cancel', close: 'Band karein', loading: 'Load ho raha hai…',
  },
}
export const trFor = (lang) => (key) => (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key
