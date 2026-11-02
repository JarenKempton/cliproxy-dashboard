// Sends this machine's raw transcripts to the dashboard every minute, so
// agents anywhere can search what was tried on other machines.
//
// Installed by the connect and import scripts as a systemd user timer (Linux)
// or a launchd agent (macOS). The dashboard address, proxy key and any custom
// harness homes go to ~/.config/cliproxy/history.json (mode 600), whose path
// the scheduler passes to the script; the bytes the dashboard has
// acknowledged go to ~/.local/state/cliproxy/history-offsets.json. Only new
// bytes are sent, and re-sending changes nothing on the dashboard.

const PUSH_PY = `import base64, json, os, sys, tempfile, urllib.error, urllib.request

home = os.path.expanduser("~")
config_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "cliproxy", "history.json")
config = json.load(open(config_path))
os.environ.update(config.get("env", {}))
state_dir = os.path.join(os.environ.get("XDG_STATE_HOME") or os.path.join(home, ".local", "state"), "cliproxy")
state_path = os.path.join(state_dir, "history-offsets.json")
try:
    state = json.load(open(state_path))
except (OSError, ValueError):
    state = {}

CHUNK = 4 << 20
BATCH = 8 << 20
claude = [os.environ["CLAUDE_CONFIG_DIR"]] if os.environ.get("CLAUDE_CONFIG_DIR") else [os.path.join(home, ".claude"), os.path.join(home, ".config", "claude")]
roots = [(os.path.join(d, "projects"), ".claude/projects") for d in claude]
roots.append((os.path.join(os.environ.get("CODEX_HOME") or os.path.join(home, ".codex"), "sessions"), ".codex/sessions"))
roots.append((os.path.join(os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(home, ".pi", "agent"), "sessions"), ".pi/agent/sessions"))

def transcripts():
    for local, remote in roots:
        for folder, _, names in os.walk(local):
            for name in sorted(names):
                if name.endswith(".jsonl"):
                    full = os.path.join(folder, name)
                    yield full, remote + "/" + os.path.relpath(full, local).replace(os.sep, "/")

def save():
    os.makedirs(state_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=state_dir)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, state_path)

def send(batch):
    body = json.dumps({"files": batch}).encode()
    req = urllib.request.Request(config["url"] + "/history/push", data=body, headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["key"]})
    try:
        res = json.load(urllib.request.urlopen(req, timeout=120))
    except urllib.error.HTTPError as e:
        sys.exit("History push failed: HTTP %d %s" % (e.code, e.read().decode(errors="replace")[:200]))
    except urllib.error.URLError as e:
        sys.exit("Couldn't reach the dashboard: %s" % e.reason)
    for f in res["files"]:
        state[f["path"]] = f["size"]
    save()
    return res["machine"]

batch, pending, sent, machine = [], 0, 0, None
for full, path in transcripts():
    try:
        total = os.path.getsize(full)
    except OSError:
        continue
    offset = state.get(path, 0)
    if total <= offset:
        continue
    with open(full, "rb") as f:
        f.seek(offset)
        while offset < total:
            data = f.read(min(CHUNK, total - offset))
            if not data:
                break
            batch.append({"path": path, "offset": offset, "data": base64.b64encode(data).decode()})
            offset += len(data)
            pending += len(data)
            sent += len(data)
            if pending >= BATCH:
                machine = send(batch)
                batch, pending = [], 0
if batch:
    machine = send(batch)
if sent:
    print("Sent %d bytes of history as %s" % (sent, machine))`

const LABEL = 'com.cliproxy.history-push'
const UNIT = 'cliproxy-history-push'

// Shell function: installs and schedules the push for $CLIPROXY_DASHBOARD and $CLIPROXY_KEY.
export const INSTALL_HISTORY_PUSH = `install_history_push() {
  python3 -c pass 2>/dev/null || { echo "History sharing skipped: python3 is required" >&2; return 0; }
  cfg="\${XDG_CONFIG_HOME:-$HOME/.config}/cliproxy"
  share="$HOME/.local/share/cliproxy"
  mkdir -p "$cfg" "$share"
  (umask 077; python3 -c 'import json, os; print(json.dumps({"url": os.environ["CLIPROXY_DASHBOARD"], "key": os.environ["CLIPROXY_KEY"], "env": {k: os.environ[k] for k in ("CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "XDG_STATE_HOME") if os.environ.get(k)}}))' > "$cfg/history.json")
  cat > "$share/history-push.py" <<'CLIPROXY_PUSH'
${PUSH_PY}
CLIPROXY_PUSH
  py=$(python3 -c 'import sys; print(sys.executable)')
  if [ "$(uname)" = Darwin ]; then
    plist="$HOME/Library/LaunchAgents/${LABEL}.plist"
    mkdir -p "$(dirname "$plist")" "$HOME/Library/Logs"
    cat > "$plist" <<CLIPROXY_PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>$py</string><string>$share/history-push.py</string><string>$cfg/history.json</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/cliproxy-history-push.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/cliproxy-history-push.log</string>
</dict></plist>
CLIPROXY_PLIST
    launchctl bootout "gui/$(id -u)" "$plist" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  elif systemctl --user show-environment >/dev/null 2>&1; then
    units="\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
    mkdir -p "$units"
    printf '[Unit]\\nDescription=Send transcripts to the CLIProxy dashboard\\n\\n[Service]\\nType=oneshot\\nExecStart=%s %s %s\\n' "$py" "$share/history-push.py" "$cfg/history.json" > "$units/${UNIT}.service"
    printf '[Unit]\\nDescription=Send transcripts to the CLIProxy dashboard every minute\\n\\n[Timer]\\nOnActiveSec=10s\\nOnUnitActiveSec=60s\\n\\n[Install]\\nWantedBy=timers.target\\n' > "$units/${UNIT}.timer"
    systemctl --user daemon-reload
    systemctl --user enable --now ${UNIT}.timer >/dev/null
    loginctl enable-linger "$(id -un)" 2>/dev/null || echo "Couldn't keep the history timer running after logout (loginctl enable-linger)." >&2
  else
    echo "History sharing skipped: no systemd user session or launchd here. Run $py $share/history-push.py $cfg/history.json on a schedule." >&2
    return 0
  fi
  echo "✓ History → $CLIPROXY_DASHBOARD every minute"
}`

export const UNDO_HISTORY_PUSH = `if [ "$(uname)" = Darwin ]; then
  launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/${LABEL}.plist" 2>/dev/null
  rm -f "$HOME/Library/LaunchAgents/${LABEL}.plist"
elif command -v systemctl >/dev/null; then
  systemctl --user disable --now ${UNIT}.timer 2>/dev/null
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${UNIT}.service" "\${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/${UNIT}.timer"
fi
if [ -f "\${XDG_CONFIG_HOME:-$HOME/.config}/cliproxy/history.json" ]; then
  rm -f "\${XDG_CONFIG_HOME:-$HOME/.config}/cliproxy/history.json" "$HOME/.local/share/cliproxy/history-push.py"
  echo "stopped sending history"
fi`
