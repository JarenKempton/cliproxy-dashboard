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

// `NAME=value`, `NAME: value` and `"name": "value"`, at any JSON-escaping depth. A name
// starts after a non-name character or after an escaped `\n`, `\t` or `\r`.
const NAME = /(?:(?<=\\[ntr])|(?<![\w.\\-]))(\\*["']?)([A-Za-z_][A-Za-z0-9_.-]*)\1(\s*[:=]\s*)/g
const OPEN_QUOTE = /(\\*)(["'])/y
const ALWAYS_SECRET = new Set(['password', 'passwd', 'pwd', 'secret', 'apikey', 'authkey'])
const SECRET_SUFFIX = new Set(['token', 'pass', 'auth', 'credential', 'credentials'])
const SECRET_KEY_KIND = new Set(['api', 'secret', 'private', 'access', 'client', 'master', 'signing', 'encryption', 'auth', 'license', 'deploy', 'service', 'management'])
const LOOKS_SECRET = /^(?=.*[A-Za-z])(?=.*\d)\S{16,}$/
const LITERAL = /^(true|false|null|none|undefined)$/i
const REFERENCE = /^(\$[A-Z_][A-Z0-9_]*|\$\{[A-Z_][A-Z0-9_]*\}|\[REDACTED:[a-z-]+\])$/

// Whether `name = value` assigns a secret: decided by the name's words, and for a
// bare `token`, `key` or `auth` by whether the value looks like one. Only a whole
// value can be a literal or a variable reference.
function secretAssignment(name: string, value: string, whole: string) {
  const bare = whole.trim().replace(/^\\*["']|\\*["']$/g, '')
  if (LITERAL.test(bare) || REFERENCE.test(bare)) return false
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[_.-]+/)
  const last = words.at(-1) ?? ''
  if (ALWAYS_SECRET.has(last)) return true
  if (words.length === 1) return (SECRET_SUFFIX.has(last) || last === 'key') && LOOKS_SECRET.test(value)
  return SECRET_SUFFIX.has(last) || (last === 'key' && SECRET_KEY_KIND.has(words.at(-2) ?? ''))
}

export type RedactionCounts = Record<string, number>

export function redact(text: string, counts: RedactionCounts): string {
  text = redactAssignments(text, counts)
  for (const [pattern, replacement] of SECRETS) {
    const kind = replacement.slice(replacement.indexOf(':') + 1, -1)
    text = text.replace(pattern, (...match) => {
      counts[kind] = (counts[kind] ?? 0) + 1
      return replacement.replace('$1', match[1] ?? '')
    })
  }
  return text
}

// Just past the closing quote: the first same-kind quote with exactly as many
// backslashes before it as the opening one, across lines. Any other run may be an
// escaped quote under some enclosing escaping. Without one, the rest of the text.
function quotedEnd(text: string, from: number, depth: number, quote: string) {
  for (let i = from; i < text.length; i++) {
    if (text[i] !== quote) continue
    let run = 0
    while (i - run - 1 >= from && text[i - run - 1] === '\\') run++
    if (run === depth) return i + 1
  }
  return text.length
}

// A secret value runs to the end of its logical line: quoted segments (which may span
// lines) and backslash-escaped characters, including escaped newlines, carry it on.
// The first quoted segment, or the first word, decides whether it is a secret.
function valueExtent(text: string, start: number) {
  let decide: string | null = null
  let i = start
  while (i < text.length && text[i] !== '\n') {
    OPEN_QUOTE.lastIndex = i
    const open = OPEN_QUOTE.exec(text)
    if (open) {
      const end = quotedEnd(text, i + open[0].length, open[1].length, open[2])
      if (i === start) decide = text.slice(i + open[0].length, Math.max(i + open[0].length, end - open[0].length))
      i = end
    } else i += text[i] === '\\' ? 2 : 1
  }
  return { decide: decide ?? text.slice(start).match(/^\S*/)![0], end: Math.min(i, text.length) }
}

// Where the same value ends under shell rules, where a backslash inside single quotes
// is literal. Escaping can't be told apart from text, so the longer reading wins.
function shellEnd(text: string, start: number) {
  let i = start
  while (i < text.length && text[i] !== '\n') {
    if (text[i] === "'") {
      const close = text.indexOf("'", i + 1)
      i = close === -1 ? text.length : close + 1
    } else if (text[i] === '"') {
      i++
      while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
      i++
    } else i += text[i] === '\\' ? 2 : 1
  }
  return Math.min(i, text.length)
}

// A value goes on over following lines that are blank or indented deeper than the
// line its name is on, as YAML block, folded and plain multi-line scalars do.
function continuationEnd(text: string, nameAt: number, end: number) {
  const lineStart = text.lastIndexOf('\n', nameAt - 1) + 1
  const indent = text.slice(lineStart).match(/^[ \t]*/)![0].length
  while (end < text.length) {
    const next = text.indexOf('\n', end + 1)
    const line = text.slice(end + 1, next === -1 ? text.length : next)
    if (line.trim() && line.match(/^[ \t]*/)![0].length <= indent) break
    end = next === -1 ? text.length : next
  }
  return end
}

function redactAssignments(text: string, counts: RedactionCounts) {
  let out = ''
  let copied = 0
  NAME.lastIndex = 0
  for (let m = NAME.exec(text); m; m = NAME.exec(text)) {
    const start = m.index + m[0].length
    if (start >= text.length || text[start] === '\n') continue
    const extent = valueExtent(text, start)
    const decide = extent.decide
    const end = continuationEnd(text, m.index, Math.max(extent.end, shellEnd(text, start)))
    const whole = text.slice(start, end)
    if (!whole.trim() || !secretAssignment(m[2], decide || whole, whole)) continue
    counts.env = (counts.env ?? 0) + 1
    out += `${text.slice(copied, start)}[REDACTED:env]`
    copied = end
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
