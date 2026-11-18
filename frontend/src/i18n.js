// KiluaAI UI language (Phase D10): a small dictionary for the app
// CHROME only — nav labels, primary buttons, Home/Queue headings.
// Post content (captions, hashtags) is never translated. Default EN;
// the choice persists per user (settings.uiLanguage) + locally.
export const STRINGS = {
  en: {
    home: 'Home', create: 'Create', queue: 'Queue', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', contact: 'Contact', logout: 'Log out', createPost: 'Create Post',
    scheduled: 'Scheduled', published: 'Published', totalPosts: 'Total posts', upNext: 'Up next',
    searchPlaceholder: 'Search posts & media…',
    goodMorning: 'Good morning', goodAfternoon: 'Good afternoon', goodEvening: 'Good evening',
  },
  hi: {
    home: 'Home', create: 'Banayein', queue: 'Queue List', calendar: 'Calendar', media: 'Media',
    aiStudio: 'AI Studio', bulk: 'Bulk', tools: 'Tools', connections: 'Connections',
    settings: 'Settings', contact: 'Contact', logout: 'Log out', createPost: 'Post Banayein',
    scheduled: 'Tay posts', published: 'Publish hue', totalPosts: 'Kul posts', upNext: 'Aane wale posts',
    searchPlaceholder: 'Posts aur media search karein…',
    goodMorning: 'Suprabhat', goodAfternoon: 'Namaskar', goodEvening: 'Shubh sandhya',
  },
}
export const trFor = (lang) => (key) => (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key
