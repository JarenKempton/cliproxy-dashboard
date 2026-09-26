// Imports this machine's Claude Code and Codex history:
//   bun server/src/import/local.ts
// Safe to re-run; only history from before live collection is imported.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/client'
import { env } from '../env'
import { PriceBook } from '../usage/pricing'
import { importTranscripts, type TranscriptFile } from './importer'

// Claude Code uses ~/.claude, or ~/.config/claude on newer installs; reading both
// is safe because duplicates are dropped on import.
const claudeDirs = process.env.CLAUDE_CONFIG_DIR
  ? [process.env.CLAUDE_CONFIG_DIR]
  : [join(homedir(), '.claude'), join(homedir(), '.config/claude')]

const SOURCES: { tool: TranscriptFile['tool']; dir: string }[] = [
  ...claudeDirs.map((dir) => ({ tool: 'claude-code' as const, dir: join(dir, 'projects') })),
  { tool: 'codex', dir: join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions') },
]

function readTranscripts(tool: TranscriptFile['tool'], dir: string): TranscriptFile[] {
  const paths = [...new Bun.Glob('**/*.jsonl').scanSync({ cwd: dir, absolute: true, onlyFiles: true })].sort()
  return paths.map((path) => ({ tool, lines: readFileSync(path, 'utf8').split('\n').filter(Boolean) }))
}

const db = openDb(env.databasePath)
const prices = new PriceBook(db, env.priceCachePath)
await prices.start()

const files = SOURCES.flatMap(({ tool, dir }) => {
  try {
    return readTranscripts(tool, dir)
  } catch {
    console.log(`skipping ${dir} (not found)`)
    return []
  }
})

// Loopback resolves to this machine's name, like its own proxy traffic.
const result = importTranscripts(db, prices, files, '127.0.0.1')
console.log(
  `Imported ${result.imported} requests from ${files.length} files` +
    ` (${result.alreadyImported} already imported, ${result.afterCutoff} after live collection began ${new Date(result.cutoffMs).toLocaleString()}).`,
)
process.exit(0)
