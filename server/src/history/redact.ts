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

// `NAME=value`, `NAME: value` and `"name": "value"`, at any JSON-escaping depth.
const NAME = /(\\*["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)/g
const OPEN_QUOTE = /(\\*)(["'])/y
const UNQUOTED = /[^\s"'`,;)}\]]+/y
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
  return redactAssignments(text, counts)
}

// Where a quoted value ends. Its opening quote has `depth` backslashes (0, 1, 3, 7… as
// JSON escaping nests); a closing quote has the same count plus an even number of
// escaped backslashes at that depth. Without one, the value runs to the end of the line.
function quotedValueEnd(text: string, from: number, depth: number, quote: string) {
  const lineEnd = text.indexOf('\n', from) === -1 ? text.length : text.indexOf('\n', from)
  for (let i = from; i < lineEnd; i++) {
    if (text[i] !== quote) continue
    let run = 0
    while (i - run - 1 >= from && text[i - run - 1] === '\\') run++
    if (run >= depth && (run - depth) % (2 * (depth + 1)) === 0) return { innerEnd: i - depth, end: i + 1 }
  }
  return { innerEnd: lineEnd, end: lineEnd }
}

function redactAssignments(text: string, counts: RedactionCounts) {
  let out = ''
  let copied = 0
  NAME.lastIndex = 0
  for (let m = NAME.exec(text); m; m = NAME.exec(text)) {
    const valueStart = m.index + m[0].length
    OPEN_QUOTE.lastIndex = UNQUOTED.lastIndex = valueStart
    const open = OPEN_QUOTE.exec(text)
    let innerStart = valueStart
    let innerEnd: number
    let end: number
    if (open) {
      innerStart = valueStart + open[0].length
      ;({ innerEnd, end } = quotedValueEnd(text, innerStart, open[1].length, open[2]))
    } else if (UNQUOTED.exec(text)) {
      innerEnd = end = UNQUOTED.lastIndex
    } else continue
    const inner = text.slice(innerStart, innerEnd)
    if (!inner || inner.startsWith('[REDACTED') || inner.startsWith('$') || PLAIN_VALUE.test(inner) || !secretAssignment(m[2], inner)) continue
    counts.env = (counts.env ?? 0) + 1
    out += `${text.slice(copied, innerStart)}[REDACTED:env]`
    copied = innerEnd
    NAME.lastIndex = end
  }
  return out + text.slice(copied)
}

// Every string anywhere inside a JSON value.
export function redactDeep<T>(value: T, counts: RedactionCounts): T {
  if (typeof value === 'string') return redact(value, counts) as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, counts)) as T
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, counts)])) as T
  return value
}
