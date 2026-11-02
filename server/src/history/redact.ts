// Removes secrets from transcript text before it is embedded, indexed or
// returned. Counts what it removed by kind.

const SECRETS: [RegExp, string][] = [
  [/(?<![\w-])sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/g, '[REDACTED:api-key]'],
  [/(?<![\w-])gh[pousr]_[A-Za-z0-9]{30,}/g, '[REDACTED:github-token]'],
  [/(?<![\w-])github_pat_[A-Za-z0-9_]{30,}/g, '[REDACTED:github-token]'],
  [/(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED:slack-token]'],
  [/(?<![\w-])AKIA[0-9A-Z]{16}/g, '[REDACTED:aws-key]'],
  [/(?<![\w-])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[REDACTED:jwt]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED:private-key]'],
  [/(bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1[REDACTED:bearer]'],
]

// `NAME=value`, `NAME: value` and `"name": "value"` (also JSON-escaped). Quoted
// values are removed whole.
const ASSIGNMENT =
  /(\\?["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(\\"(?:[^\\\n]|\\\\\\\\|\\\\\\"|\\[^"\\])*\\"|"(?:\\.|[^"\\\n])*"|'[^'\n]*'|[^\s"'`,;)}\]]+)/g
const ALWAYS_SECRET = new Set(['password', 'passwd', 'pwd', 'secret', 'apikey', 'authkey'])
const SECRET_SUFFIX = new Set(['token', 'pass', 'auth', 'credential', 'credentials'])
const SECRET_KEY_KIND = new Set(['api', 'secret', 'private', 'access', 'client', 'master', 'signing', 'encryption', 'auth', 'license', 'deploy', 'service', 'management'])
const LOOKS_SECRET = /^(?=.*[A-Za-z])(?=.*\d)\S{16,}$/
const PLAIN_VALUE = /^(true|false|null|none|undefined|\d+)$/i

// Whether `name = value` assigns a secret: decided by the name's words, and for a
// bare `token`, `key` or `auth` by whether the value looks like one.
function secretAssignment(name: string, value: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/)
  const last = words.at(-1) ?? ''
  if (ALWAYS_SECRET.has(last)) return true
  if (words.length === 1) return (SECRET_SUFFIX.has(last) || last === 'key') && LOOKS_SECRET.test(value)
  return SECRET_SUFFIX.has(last) || (last === 'key' && SECRET_KEY_KIND.has(words.at(-2) ?? ''))
}

export type RedactionCounts = Record<string, number>

export function redact(text: string, counts: RedactionCounts): string {
  for (const [pattern, replacement] of SECRETS) {
    const kind = replacement.slice(replacement.indexOf(':') + 1, -1)
    text = text.replace(pattern, (...match) => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return replacement.replace('$1', match[1] ?? '')
    })
  }
  return text.replace(ASSIGNMENT, (match, nameQuote, name, separator, value: string) => {
    const quote = value.startsWith('\\"') ? '\\"' : /^["']/.test(value) ? value[0] : ''
    const inner = value.slice(quote.length, value.length - quote.length)
    if (!inner || inner.startsWith('[REDACTED') || inner.startsWith('$') || PLAIN_VALUE.test(inner) || !secretAssignment(name, inner)) return match
    counts.env = (counts.env ?? 0) + 1
    return `${nameQuote}${name}${nameQuote}${separator}${quote}[REDACTED:env]${quote}`
  })
}

// Every string anywhere inside a JSON value.
export function redactDeep<T>(value: T, counts: RedactionCounts): T {
  if (typeof value === 'string') return redact(value, counts) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, counts)])) as T
  return value
}
