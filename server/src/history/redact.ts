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
  [/^([A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH)[A-Z0-9_]*\s*[=:]\s*)\S+/gim, '$1[REDACTED:env]'],
  [/(bearer\s+)[A-Za-z0-9._-]{20,}/gi, '$1[REDACTED:bearer]'],
]

export type RedactionCounts = Record<string, number>

export function redact(text: string, counts: RedactionCounts): string {
  for (const [pattern, replacement] of SECRETS) {
    const kind = replacement.slice(replacement.indexOf(':') + 1, -1)
    text = text.replace(pattern, (...match) => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return replacement.replace('$1', match[1] ?? '')
    })
  }
  return text
}

// Every string anywhere inside a JSON value.
export function redactDeep<T>(value: T, counts: RedactionCounts): T {
  if (typeof value === 'string') return redact(value, counts) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, counts)])) as T
  return value
}
