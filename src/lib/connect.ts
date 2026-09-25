// Generates a paste-anywhere shell command that points Claude Code and/or
// Codex at the proxy by editing their per-user config files in place.
//
// - Works from any directory: paths are resolved from $HOME.
// - The first run backs up every file it touches (next to the original, as
//   <file>.cliproxy-backup, or <file>.cliproxy-backup.absent if there was no
//   file). Re-runs keep that original backup; UNDO restores it exactly.
// - Existing settings are merged, not replaced. Invalid JSON aborts.
// - No dependencies: macOS runs the merge with the built-in JavaScript for
//   Automation (osascript); other systems use python3.

export type Tool = 'claude' | 'codex'

const CLAUDE_FILE = '"$HOME/.claude/settings.json"'
const CODEX_FILE = '"$HOME/.codex/config.toml"'

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

// Same transforms in both engines. Claude: set env.ANTHROPIC_BASE_URL and
// env.ANTHROPIC_AUTH_TOKEN. Codex: drop any old [model_providers.cliproxy]
// table, set top-level model_provider, append a fresh table.
const JXA = `ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const get = (k) => { const v = env.objectForKey(k); return v.isNil() ? '' : v.js }
const read = (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? '' : s.js }
const write = (p, t) => { $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(p).stringByDeletingLastPathComponent, true, $(), null); $(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null) }
const url = get('CLIPROXY_URL'), key = get('CLIPROXY_KEY'), tools = get('CLIPROXY_TOOLS').split(' '), home = get('HOME')
if (tools.includes('claude')) {
  const p = home + '/.claude/settings.json', raw = read(p).trim()
  let cfg
  try { cfg = raw ? JSON.parse(raw) : {} } catch (e) { throw new Error(p + ' is not valid JSON; left unchanged') }
  cfg.env = Object.assign({}, cfg.env, { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key })
  write(p, JSON.stringify(cfg, null, 2) + '\\n')
}
if (tools.includes('codex')) {
  const p = home + '/.codex/config.toml'
  const out = [], lines = read(p).split('\\n')
  let skip = false, top = true, set = false
  for (const line of lines) {
    if (/^\\s*\\[/.test(line)) { top = false; skip = /^\\s*\\[model_providers\\.cliproxy\\]\\s*$/.test(line) }
    if (skip) continue
    if (top && /^\\s*model_provider\\s*=/.test(line)) { out.push('model_provider = "cliproxy"'); set = true; continue }
    out.push(line)
  }
  if (!set) out.unshift('model_provider = "cliproxy"')
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  out.push('', '[model_providers.cliproxy]', 'name = "CLIProxy"', 'base_url = ' + JSON.stringify(url + '/v1'), 'wire_api = "responses"', 'experimental_bearer_token = ' + JSON.stringify(key), '')
  write(p, out.join('\\n'))
}`

const PYTHON = `import json, os, re
url, key, tools, home = os.environ['CLIPROXY_URL'], os.environ['CLIPROXY_KEY'], os.environ['CLIPROXY_TOOLS'].split(), os.environ['HOME']
def read(p):
    try:
        return open(p).read()
    except FileNotFoundError:
        return ''
def write(p, t):
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(t)
if 'claude' in tools:
    p = home + '/.claude/settings.json'
    raw = read(p).strip()
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        raise SystemExit(p + ' is not valid JSON; left unchanged')
    cfg['env'] = {**cfg.get('env', {}), 'ANTHROPIC_BASE_URL': url, 'ANTHROPIC_AUTH_TOKEN': key}
    write(p, json.dumps(cfg, indent=2) + '\\n')
if 'codex' in tools:
    p = home + '/.codex/config.toml'
    out, skip, top, found = [], False, True, False
    for line in read(p).split('\\n'):
        if re.match(r'\\s*\\[', line):
            top = False
            skip = re.match(r'\\s*\\[model_providers\\.cliproxy\\]\\s*$', line) is not None
        if skip:
            continue
        if top and re.match(r'\\s*model_provider\\s*=', line):
            out.append('model_provider = "cliproxy"')
            found = True
            continue
        out.append(line)
    if not found:
        out.insert(0, 'model_provider = "cliproxy"')
    while out and not out[-1].strip():
        out.pop()
    out += ['', '[model_providers.cliproxy]', 'name = "CLIProxy"', 'base_url = ' + json.dumps(url + '/v1'), 'wire_api = "responses"', 'experimental_bearer_token = ' + json.dumps(key), '']
    write(p, '\\n'.join(out))`

function files(tools: Tool[]) {
  return [tools.includes('claude') && CLAUDE_FILE, tools.includes('codex') && CODEX_FILE].filter(Boolean) as string[]
}

export function setupCommand(url: string, key: string, tools: Tool[]): string {
  const list = files(tools).join(' ')
  return `# CLIProxy: point ${tools.map((t) => (t === 'claude' ? 'Claude Code' : 'Codex')).join(' + ')} at ${url}
(
set -e
export CLIPROXY_URL=${sq(url)} CLIPROXY_KEY=${sq(key)} CLIPROXY_TOOLS=${sq(tools.join(' '))}
for f in ${list}; do
  [ -e "$f.cliproxy-backup" ] || [ -e "$f.cliproxy-backup.absent" ] && continue
  if [ -f "$f" ]; then cp "$f" "$f.cliproxy-backup"; else mkdir -p "$(dirname "$f")"; : > "$f.cliproxy-backup.absent"; fi
done
if [ "\${CLIPROXY_ENGINE:-$(uname)}" = Darwin ]; then
osascript -l JavaScript >/dev/null <<'CLIPROXY_JS'
${JXA}
CLIPROXY_JS
else
python3 - <<'CLIPROXY_PY'
${PYTHON}
CLIPROXY_PY
fi
echo "CLIProxy connected. Backups saved next to: ${files(tools).map((f) => f.replace(/"/g, '').replace('$HOME', '~')).join(', ')}"
)`
}

export function undoCommand(tools: Tool[]): string {
  return `for f in ${files(tools).join(' ')}; do if [ -f "$f.cliproxy-backup" ]; then mv "$f.cliproxy-backup" "$f"; echo "restored $f"; elif [ -f "$f.cliproxy-backup.absent" ]; then rm -f "$f" "$f.cliproxy-backup.absent"; echo "removed $f"; fi; done`
}

export const CHANGED_FILES: Record<Tool, { path: string; what: string }> = {
  claude: { path: '~/.claude/settings.json', what: 'env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN' },
  codex: { path: '~/.codex/config.toml', what: 'model_provider, [model_providers.cliproxy]' },
}
