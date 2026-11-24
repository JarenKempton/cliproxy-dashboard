import { useEffect, useState, type ReactNode } from 'react'

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="mono faint">{sub}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </header>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  className,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={className ? `seg ${className}` : 'seg'} role="group">
      {options.map(([v, label]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

// Minimal toast: one message at a time, auto-dismissed.
let pushToast: (msg: string) => void = () => {}
export const toast = (msg: string) => pushToast(msg)

export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    pushToast = (m) => {
      setMsg(m)
      clearTimeout(timer)
      timer = setTimeout(() => setMsg(null), 3500)
    }
    return () => clearTimeout(timer)
  }, [])
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null
}
