// Usage records from Claude Code and Codex transcript lines, for importing
// history from before the proxy collector existed.
//
// Ported from T3 Code (MIT, (c) 2026 T3 Tools Inc.),
// apps/server/src/usage/usageTranscripts.ts, trimmed to what we store.

export type TranscriptRecord = {
  tool: 'claude-code' | 'codex'
  timestampMs: number
  model: string
  sessionId: string
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  // Stable across re-imports, so importing twice stores each record once.
  key: string
}

const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0)
const timestampOf = (v: unknown) => (typeof v === 'string' ? Date.parse(v) || null : null)
const obj = (v: unknown) => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null)

function parseJson(line: string) {
  try {
    return obj(JSON.parse(line))
  } catch {
    return null
  }
}

// --- Claude Code -----------------------------------------------------------------
// Each assistant message can span several lines that repeat the same usage;
// callers must keep only the first record per key (≈2.4× overcount otherwise).

export function parseClaudeLine(line: string): TranscriptRecord | null {
  const record = parseJson(line)
  if (record?.type !== 'assistant') return null
  const message = obj(record.message)
  const usage = obj(message?.usage)
  const timestampMs = timestampOf(record.timestamp)
  const model = typeof message?.model === 'string' ? message.model : ''
  if (!usage || timestampMs === null || !model) return null

  const messageId = typeof message?.id === 'string' ? message.id : null
  const requestId = typeof record.requestId === 'string' ? record.requestId : null
  if (!messageId && !requestId) return null

  return {
    tool: 'claude-code',
    timestampMs,
    model,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : '',
    uncached: int(usage.input_tokens),
    cacheRead: int(usage.cache_read_input_tokens),
    cacheWrite: int(usage.cache_creation_input_tokens),
    output: int(usage.output_tokens),
    reasoning: 0, // folded into output by Anthropic
    key: `${messageId ?? ''}:${requestId ?? ''}`,
  }
}

// --- Codex -------------------------------------------------------------------------
// token_count events carry no model, so it's carried from the latest
// turn_context. Forked/subagent rollouts start with a burst of copied parent
// events (already counted from the parent's file), which is skipped.

const FORK_COPY_MAX_GAP_MS = 1000

export type CodexState = {
  model: string
  sessionId: string
  lastSignature: string | null
  sawSessionMeta: boolean
  suppressingForkCopies: boolean
  forkAnchorMs: number
}

export const newCodexState = (): CodexState => ({
  model: '',
  sessionId: '',
  lastSignature: null,
  sawSessionMeta: false,
  suppressingForkCopies: false,
  forkAnchorMs: 0,
})

function isFork(meta: Record<string, unknown>) {
  if (typeof meta.forked_from_id === 'string') return true
  const spawn = obj(obj(obj(meta.source)?.subagent)?.thread_spawn)
  return typeof spawn?.parent_thread_id === 'string'
}

export function parseCodexLine(line: string, state: CodexState): TranscriptRecord | null {
  const record = parseJson(line)
  const payload = obj(record?.payload)
  if (!record || !payload) return null

  if (record.type === 'session_meta') {
    // Only the first meta is this file's own session; forks repeat ancestors' metas.
    if (state.sawSessionMeta) return null
    state.sawSessionMeta = true
    const id = payload.id ?? payload.session_id
    if (typeof id === 'string') state.sessionId = id
    const at = timestampOf(record.timestamp)
    if (at !== null && isFork(payload)) {
      state.suppressingForkCopies = true
      state.forkAnchorMs = at
    }
    return null
  }

  if (record.type === 'turn_context') {
    if (typeof payload.model === 'string') state.model = payload.model
    return null
  }

  if (payload.type !== 'token_count') return null
  const last = obj(obj(payload.info)?.last_token_usage)
  const timestampMs = timestampOf(record.timestamp)
  if (!last || timestampMs === null || !state.model) return null

  // Codex re-emits unchanged token_count events on some stream boundaries.
  const signature = JSON.stringify(last)
  if (signature === state.lastSignature) return null
  state.lastSignature = signature

  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkAnchorMs = timestampMs
      return null
    }
    state.suppressingForkCopies = false
  }

  const input = int(last.input_tokens)
  const cacheRead = int(last.cached_input_tokens)
  const cacheWrite = int(last.cache_write_input_tokens)
  const output = int(last.output_tokens)
  const uncached = Math.max(0, input - cacheRead - cacheWrite) // Codex input includes cached
  if (uncached + cacheRead + cacheWrite + output === 0) return null

  return {
    tool: 'codex',
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    uncached,
    cacheRead,
    cacheWrite,
    output,
    reasoning: Math.min(output, int(last.reasoning_output_tokens)),
    key: `${state.sessionId}:${timestampMs}:${signature}`,
  }
}
