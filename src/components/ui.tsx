import { useEffect, useRef, useState, type ReactNode } from 'react'

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

export function Switch({ on, onChange, label, disabled }: { on: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button className="switch" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange} />
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

type ConfirmProps = {
  open: boolean
  title: string
  body: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
  children?: ReactNode
  wide?: boolean
}

export function ConfirmDialog({ open, title, body, confirmLabel, danger, onConfirm, onCancel, children, wide }: ConfirmProps) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} className="dialog" style={wide ? { width: 'min(900px, calc(100vw - 32px))' } : undefined} onCancel={onCancel}>
      <div className="dialog-body">
        <h3>{title}</h3>
        <div className="muted">{body}</div>
        {children}
      </div>
      <div className="dialog-foot">
        <button className="btn btn-ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
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

export async function copyText(text: string, what = 'Copied') {
  await navigator.clipboard.writeText(text)
  toast(what)
}
