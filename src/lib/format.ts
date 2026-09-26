const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
const weekdayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' })
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

const startOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0)

// A moment in plain words, 12-hour clock: "Today 9:27 PM", "Tomorrow 4:00 PM",
// "Thu 4:00 PM" within the week around now, otherwise "Oct 3, 4:00 PM".
export function formatStamp(ms: number, now = Date.now()): string {
  const time = timeFmt.format(ms)
  const days = Math.round((startOfDay(ms) - startOfDay(now)) / 86400e3)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Tomorrow ${time}`
  if (days === -1) return `Yesterday ${time}`
  if (Math.abs(days) < 6) return `${weekdayFmt.format(ms)} ${time}`
  return `${dateFmt.format(ms)}, ${time}`
}

// "in 3h 12m", "in 2d 4h", "12m ago"
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now
  // Round once, then split, so 59.6 minutes never shows as "60m".
  const mins = Math.round(Math.abs(diff) / 60e3)
  const d = Math.floor(mins / 1440)
  const h = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const text = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
  return diff >= 0 ? `in ${text}` : `${text} ago`
}

export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

export function maskKey(key: string): string {
  return key.length <= 10 ? '••••••' : `${key.slice(0, 4)}••••••${key.slice(-4)}`
}
