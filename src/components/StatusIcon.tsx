export type Status = 'good' | 'warning' | 'critical' | 'neutral'

// Status never rides on color alone: each has its own glyph, and callers
// always render a text label beside it.
const GLYPHS: Record<Status, string> = {
  good: 'M3.5 8.5l3 3 6-7',
  warning: 'M8 2.5l6 11H2z',
  critical: 'M4 4l8 8M12 4l-8 8',
  neutral: 'M3 8h10',
}

export function StatusIcon({ status }: { status: Status }) {
  const filled = status === 'warning'
  return (
    <svg className={`status-icon status-${status}`} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d={GLYPHS[status]}
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth={filled ? 1 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
