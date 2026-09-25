// Masks secret-looking values before they are rendered on screen.

const SENSITIVE_KEY = /key|secret|token|password|authorization|cookie|credential/i
const SECRET_VALUE = /^(sk-|AIza|ya29\.|eyJ)|^[A-Fa-f0-9]{32,}$/

function maskString(s: string): string {
  if (s.length <= 8) return '••••'
  return `${s.slice(0, 4)}••••${s.slice(-4)}`
}

export function mask(value: unknown, sensitive = false): unknown {
  if (typeof value === 'string') {
    return sensitive || SECRET_VALUE.test(value) ? maskString(value) : value
  }
  if (Array.isArray(value)) return value.map((v) => mask(v, sensitive))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mask(v, sensitive || SENSITIVE_KEY.test(k))]),
    )
  }
  return value
}
