// Inline SVG icons (no emoji in the chrome). stroke="currentColor" so they
// inherit the surrounding text colour.
export function I({ d, size = 18, children, viewBox = '0 0 24 24' }) {
  return (
    <svg width={size} height={size} viewBox={viewBox} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children || <path d={d} />}
    </svg>
  )
}
export const IconHome = (p) => <I {...p} d="M3 10.5 12 3l9 7.5V21h-6v-6h-6v6H3z" />
export const IconCal = (p) => <I {...p} d="M3 5h18v16H3z M3 10h18 M8 3v4 M16 3v4" />
export const IconQueue = (p) => <I {...p}><path d="M4 6h16M4 12h16M4 18h10" /><circle cx="20" cy="18" r="2" /></I>
export const IconPlus = (p) => <I {...p} d="M12 5v14M5 12h14" />
export const IconMedia = (p) => <I {...p}><rect x="3" y="4" width="18" height="16" rx="3" /><circle cx="9" cy="10" r="2" /><path d="m4 18 5-5 3 3 4-4 4 4" /></I>
export const IconBulk = (p) => <I {...p}><path d="M12 3 3 8l9 5 9-5-9-5z" /><path d="m3 12.5 9 5 9-5" /><path d="m3 17 9 5 9-5" /></I>
export const IconCrown = (p) => <I {...p}><path d="m3 8 4.5 4L12 5l4.5 7L21 8l-1.6 9.2H4.6L3 8z" /><path d="M5 20.5h14" /></I>
export const IconChevronRight = (p) => <I {...p} d="m9 6 6 6-6 6" />
export const IconTools = (p) => <I {...p}><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4L14 13l-3-3 3.7-3.7z" /></I>
export const IconSettings = (p) => <I {...p}><circle cx="12" cy="12" r="3" /><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z" /></I>
export const IconSun = (p) => <I {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></I>
export const IconMoon = (p) => <I {...p} d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" />
export const IconPlay = (p) => <I {...p}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none" /></I>
export const IconHeart = ({ filled, ...p }) => <I {...p}><path d="M12 20s-7-4.5-9.5-9A5.5 5.5 0 0 1 12 6.5 5.5 5.5 0 0 1 21.5 11C19 15.5 12 20 12 20z" fill={filled ? 'currentColor' : 'none'} /></I>
export const IconSearch = (p) => <I {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></I>
export const IconTrash = (p) => <I {...p} d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6" />
export const IconCheck = (p) => <I {...p} d="m4 12.5 5 5L20 6.5" />
export const IconWarn = (p) => <I {...p}><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17.5v.5" /></I>
export const IconClock = (p) => <I {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></I>
export const IconLink = (p) => <I {...p} d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7L12.5 19" />
export const IconSend = (p) => <I {...p} d="m3 11 18-8-8 18-2.5-7.5L3 11z" />
export const IconSpark = (p) => <I {...p}><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" /><path d="M19 15l.9 2.6 2.6.9-2.6.9L19 22l-.9-2.6-2.6-.9 2.6-.9L19 15z" /></I>
export const IconEdit = (p) => <I {...p} d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4zM13.5 6.5l4 4" />
export const IconX = (p) => <I {...p} d="M6 6l12 12M18 6 6 18" />
export const IconMenu = (p) => <I {...p} d="M4 7h16M4 12h16M4 17h16" />
export const IconComment = (p) => <I {...p} d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5c-1.5 0-3-.4-4.2-1.1L3 20l1.1-5.3A8.5 8.5 0 1 1 21 11.5z" />
export const IconBookmark = (p) => <I {...p} d="M6 3h12v18l-6-4.5L6 21z" />
export const IconBell = (p) => <I {...p}><path d="M18 9a6 6 0 1 0-12 0c0 6-2.5 7-2.5 7h17S18 15 18 9z" /><path d="M10 20a2.2 2.2 0 0 0 4 0" /></I>
export const IconEye = (p) => <I {...p}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" /><circle cx="12" cy="12" r="3" /></I>
export const IconEyeOff = (p) => <I {...p}><path d="m4 4 16 16" /><path d="M10.6 6.1c.5-.1.9-.1 1.4-.1 6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.5M6.6 6.9A16.6 16.6 0 0 0 2 12s3.5 6 10 6c1.5 0 2.9-.3 4.1-.8" /></I>
export const IconTag = (p) => <I {...p}><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z" /><circle cx="7.5" cy="7.5" r="1.3" /></I>
export const IconInstagram = (p) => <I {...p}><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" /></I>
export const IconYouTube = (p) => <I {...p}><rect x="2.5" y="5" width="19" height="14" rx="4" /><path d="m10 9.5 5 2.5-5 2.5z" fill="currentColor" stroke="none" /></I>
