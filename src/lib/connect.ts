// Shell scripts that point Claude Code, Codex and/or Muse Code at the proxy
// by editing their per-user config files in place. Muse points at the
// dashboard instead of the proxy: the dashboard serves the /muse-code/*
// catalog routes Muse needs and passes /v1 through (see muse-relay.ts).
//
// - Works from any directory: paths are resolved from $HOME.
// - The first run backs up every file it touches (next to the original, as
//   <file>.cliproxy-backup, or <file>.cliproxy-backup.absent if there was no
//   file). Re-runs keep that original backup; UNDO restores it exactly.
// - Existing settings are merged, not replaced. Invalid JSON aborts.
// - No dependencies: macOS runs the merge with the built-in JavaScript for
//   Automation (osascript); other systems use python3.

export type Tool = 'claude' | 'codex' | 'muse'

const CLAUDE_FILE = '"$HOME/.claude/settings.json"'
const CODEX_FILE = '"$HOME/.codex/config.toml"'
const MUSE_DIR = '"${XDG_CONFIG_HOME:-$HOME/.config}/muse"'

// Same transforms in both engines. Claude: set env.ANTHROPIC_BASE_URL and
// env.ANTHROPIC_AUTH_TOKEN. Codex: drop any old [model_providers.cliproxy]
// table, set top-level model_provider, append a fresh table.
const JXA = `ObjC.import('Foundation')
const env = $.NSProcessInfo.processInfo.environment
const get = (k) => { const v = env.objectForKey(k); return v.isNil() ? '' : v.js }
const read = (p) => { const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null); return s.isNil() ? '' : s.js }
const write = (p, t) => { $.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError($(p).stringByDeletingLastPathComponent, true, $(), null); $(t).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null) }
const url = get('CLIPROXY_URL'), key = get('CLIPROXY_KEY'), tools = get('CLIPROXY_TOOLS').split(' '), home = get('HOME'), dash = get('CLIPROXY_DASHBOARD'), xdg = get('XDG_CONFIG_HOME') || home + '/.config'
if (tools.includes('claude')) {
  const p = home + '/.claude/settings.json', raw = read(p).trim()
  let cfg
  try { cfg = raw ? JSON.parse(raw) : {} } catch (e) { throw new Error(p + ' is not valid JSON; left unchanged') }
  cfg.env = Object.assign({}, cfg.env, { ANTHROPIC_BASE_URL: url, ANTHROPIC_AUTH_TOKEN: key })
  write(p, JSON.stringify(cfg, null, 2) + '\\n')
}
if (tools.includes('muse')) {
  const p = xdg + '/muse/settings.json', raw = read(p).trim()
  let cfg
  try { cfg = raw ? JSON.parse(raw) : {} } catch (e) { throw new Error(p + ' is not valid JSON; left unchanged') }
  cfg.endpoint_transport = Object.assign({}, cfg.endpoint_transport, { base_url: dash + '/v1', auth: 'bearer' })
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
dash, xdg = os.environ['CLIPROXY_DASHBOARD'], os.environ.get('XDG_CONFIG_HOME') or home + '/.config'
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
if 'muse' in tools:
    p = xdg + '/muse/settings.json'
    raw = read(p).strip()
    try:
        cfg = json.loads(raw) if raw else {}
    except ValueError:
        raise SystemExit(p + ' is not valid JSON; left unchanged')
    cfg['endpoint_transport'] = {**cfg.get('endpoint_transport', {}), 'base_url': dash + '/v1', 'auth': 'bearer'}
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

// Backs up (first run only) and edits the files for $CLIPROXY_TOOLS, using
// $CLIPROXY_URL and $CLIPROXY_KEY. Shared by the served script and tests.
const APPLY = `backup() {
  f="$1"
  [ -e "$f.cliproxy-backup" ] || [ -e "$f.cliproxy-backup.absent" ] && return
  if [ -f "$f" ]; then cp "$f" "$f.cliproxy-backup"; else mkdir -p "$(dirname "$f")"; : > "$f.cliproxy-backup.absent"; fi
}
for t in $CLIPROXY_TOOLS; do
  case "$t" in
    claude) backup ${CLAUDE_FILE};;
    codex) backup ${CODEX_FILE};;
    muse) backup ${MUSE_DIR}/settings.json; backup ${MUSE_DIR}/auth.json;;
  esac
done
if [ "\${CLIPROXY_ENGINE:-$(uname)}" = Darwin ]; then
osascript -l JavaScript >/dev/null <<'CLIPROXY_JS'
${JXA}
CLIPROXY_JS
else
python3 - <<'CLIPROXY_PY'
${PYTHON}
CLIPROXY_PY
fi`

// Served at <dashboard>/connect. Run as: curl -fsSL <url> | sh -s -- CODE
// The code is single-use and short-lived; the script trades it for the proxy
// address and key, so the key never appears in the command or shell history.
export function connectScript(dashboardOrigin: string): string {
  return `#!/bin/sh
# CLIProxy connect: points Claude Code, Codex and/or Muse Code on this machine at the proxy.
# Edits ~/.claude/settings.json, ~/.codex/config.toml and Muse's settings.json/auth.json, backing each up first.
# Undo: curl -fsSL ${dashboardOrigin}/connect/undo | sh
set -e
code="\${1:-}"
[ -n "$code" ] || { echo "Missing setup code. Copy the full command from the dashboard." >&2; exit 1; }
resp=$(curl -fs "${dashboardOrigin}/connect/claim/$code") || { echo "That setup code is invalid, expired, or already used. Make a new one in the dashboard." >&2; exit 1; }
field() { printf '%s\\n' "$resp" | sed -n "s/^$1=//p"; }
CLIPROXY_URL=$(field url) CLIPROXY_KEY=$(field key) CLIPROXY_TOOLS=$(field tools) CLIPROXY_DASHBOARD="${dashboardOrigin}"
export CLIPROXY_URL CLIPROXY_KEY CLIPROXY_TOOLS CLIPROXY_DASHBOARD
${APPLY}
for t in $CLIPROXY_TOOLS; do
  case "$t" in
    claude) echo "✓ Claude Code → $CLIPROXY_URL";;
    codex) echo "✓ Codex → $CLIPROXY_URL";;
    muse)
      if command -v muse >/dev/null; then
        printf %s "$CLIPROXY_KEY" | muse auth set --api-key-stdin >/dev/null
        echo "✓ Muse Code → $CLIPROXY_DASHBOARD (via the dashboard relay)"
      else
        echo "Muse Code settings updated, but the muse CLI isn't on PATH. Install it, then run this connect command again so the proxy key gets stored." >&2
      fi;;
  esac
done
echo "Restart any open sessions to pick this up."
`
}

// Served at <dashboard>/connect/undo: restores the original files.
export function undoScript(): string {
  return `#!/bin/sh
# CLIProxy disconnect: restores the files the connect script backed up.
for f in ${CLAUDE_FILE} ${CODEX_FILE} ${MUSE_DIR}/settings.json ${MUSE_DIR}/auth.json; do
  if [ -f "$f.cliproxy-backup" ]; then mv "$f.cliproxy-backup" "$f"; echo "restored $f"
  elif [ -f "$f.cliproxy-backup.absent" ]; then rm -f "$f" "$f.cliproxy-backup.absent"; echo "removed $f"
  fi
done
`
}

// Python that collects this machine's Claude Code and Codex usage into `files`,
// keeping only usage fields (timestamps, model, session id, token counts),
// never prompts or code. Shared by the import and export scripts.
const COLLECT_USAGE_PY = `import json, os, sys, urllib.error, urllib.request

def keep_claude(r):
    m = r.get("message") or {}
    if r.get("type") != "assistant" or "usage" not in m:
        return None
    return {"type": "assistant", "timestamp": r.get("timestamp"), "requestId": r.get("requestId"), "sessionId": r.get("sessionId"),
            "message": {"id": m.get("id"), "model": m.get("model"), "usage": m.get("usage")}}

def keep_codex(r):
    t, p = r.get("type"), r.get("payload") or {}
    if t == "session_meta":
        return {"type": t, "timestamp": r.get("timestamp"), "payload": {k: p.get(k) for k in ("id", "session_id", "forked_from_id", "source")}}
    if t == "turn_context":
        return {"type": t, "payload": {"model": p.get("model")}}
    if p.get("type") == "token_count":
        return {"type": t, "timestamp": r.get("timestamp"), "payload": {"type": "token_count", "info": {"last_token_usage": (p.get("info") or {}).get("last_token_usage")}}}
    return None

home = os.path.expanduser("~")
# Claude Code uses ~/.claude, or ~/.config/claude on newer installs; duplicates are
# dropped on import, so reading both is safe.
claude_dirs = [os.environ["CLAUDE_CONFIG_DIR"]] if os.environ.get("CLAUDE_CONFIG_DIR") else [home + "/.claude", home + "/.config/claude"]
codex_home = os.environ.get("CODEX_HOME", home + "/.codex")
sources = [("claude-code", os.path.join(d, "projects"), keep_claude) for d in claude_dirs]
sources += [("codex", os.path.join(codex_home, d), keep_codex) for d in ("sessions", "archived_sessions")]

# Walks folders rather than using a glob pattern: asterisks tend to get eaten
# when this is copied out of chat apps as Markdown.
def jsonl_files(root):
    for folder, _, names in sorted(os.walk(root)):
        for name in sorted(names):
            if name.endswith(".jsonl"):
                yield os.path.join(folder, name)

files = []
for tool, root, keep in sources:
    for path in jsonl_files(root):
        lines = []
        with open(path, errors="replace") as f:
            for line in f:
                try:
                    kept = keep(json.loads(line))
                except ValueError:
                    continue
                if kept:
                    lines.append(json.dumps(kept))
        if lines:
            files.append({"tool": tool, "lines": lines})`

// Served at <dashboard>/connect/import: sends this machine's usage history to
// the dashboard. Over the local network the upload needs a proxy key:
// `| sh -s -- <key>`.
export function importScript(dashboardOrigin: string): string {
  return `#!/bin/sh
# CLIProxy history import: sends Claude Code and Codex usage (token counts only) to the dashboard.
set -e
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }
export CLIPROXY_KEY="\${1:-}"
python3 - <<'CLIPROXY_PY'
${COLLECT_USAGE_PY}

headers = {"Content-Type": "application/json"}
if os.environ.get("CLIPROXY_KEY"):
    headers["Authorization"] = "Bearer " + os.environ["CLIPROXY_KEY"]
req = urllib.request.Request("${dashboardOrigin}/api/import", data=json.dumps({"files": files}).encode(), headers=headers)
try:
    res = json.load(urllib.request.urlopen(req))
except urllib.error.HTTPError as e:
    if e.code == 401:
        sys.exit("The dashboard needs one of your proxy API keys: ... | sh -s -- <key>")
    sys.exit("Import failed: HTTP %d %s" % (e.code, e.read().decode(errors="replace")[:200]))
except urllib.error.URLError as e:
    # Without a key the server refuses before reading the upload, which looks like a dropped connection.
    if not os.environ.get("CLIPROXY_KEY"):
        sys.exit("The dashboard needs one of your proxy API keys: ... | sh -s -- <key>")
    sys.exit("Couldn't reach the dashboard: %s" % e.reason)
print("Imported %d requests from %d files as %s (%d already imported, %d skipped as already collected live)." % (res["imported"], len(files), res["machineIp"], res["alreadyImported"], res["afterCutoff"]))
CLIPROXY_PY
`
}

// For machines that can't reach the dashboard at all: writes the same
// usage-only data to ~/cliproxy-usage-export.json, to copy over and import
// with `bun server/src/import/file.ts`.
export function exportScript(): string {
  return `# CLIProxy usage export: writes Claude Code and Codex usage (token counts only) to ~/cliproxy-usage-export.json
python3 - <<'CLIPROXY_PY'
${COLLECT_USAGE_PY}

out = os.path.join(home, "cliproxy-usage-export.json")
with open(out, "w") as f:
    json.dump({"files": files}, f)
print("Wrote %s (%d files, %d usage lines). Copy it to the dashboard machine to import." % (out, len(files), sum(len(x["lines"]) for x in files)))
CLIPROXY_PY`
}
