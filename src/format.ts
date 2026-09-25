export function formatWhen(ms: number, now = Date.now()): string {
  const diff = ms - now
  const time = new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (diff > 0 && diff < 12 * 3600e3) {
    const h = Math.floor(diff / 3600e3)
    const m = Math.round((diff % 3600e3) / 60e3)
    return h ? `in ${h}h ${m}m` : `in ${m}m`
  }
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString()
  if (sameDay) return `today ${time}`
  return `${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${time}`
}

export function formatAgo(ms: number, now = Date.now()): string {
  const s = Math.round((now - ms) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
}
