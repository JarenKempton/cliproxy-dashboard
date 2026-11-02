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

// `NAME=value`, `NAME: value` and `"name": "value"` where the name's last word says it holds a secret.
const ASSIGNMENT = /(["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)(["']?)([^\s"'`,;)}\]]{6,})/g
const SECRET_WORDS = new Set(['key', 'apikey', 'token', 'secret', 'password', 'passwd', 'pwd', 'pass', 'auth', 'credential', 'credentials'])

function secretName(name: string) {
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/)
  return SECRET_WORDS.has(words.at(-1) ?? '')
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
  return text.replace(ASSIGNMENT, (match, quote, name, separator, valueQuote, value: string) => {
    if (!secretName(name) || value.startsWith('[REDACTED') || value.startsWith('$')) return match
    counts.env = (counts.env ?? 0) + 1
    return `${quote}${name}${quote}${separator}${valueQuote}[REDACTED:env]`
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
