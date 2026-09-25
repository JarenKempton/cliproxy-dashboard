const pad = (n: number) => String(n).padStart(2, '0')

// "09/26 15:59"
export function formatStamp(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

// "in 3h 12m", "in 2d 4h", "12m ago"
export function formatRelative(ms: number, now = Date.now()): string {
  const diff = ms - now
  const abs = Math.abs(diff)
  const d = Math.floor(abs / 86400e3)
  const h = Math.floor((abs % 86400e3) / 3600e3)
  const m = Math.round((abs % 3600e3) / 60e3)
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
