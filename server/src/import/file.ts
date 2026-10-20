// Imports a usage export made on a machine that can't reach the dashboard:
//   bun server/src/import/file.ts ~/Downloads/cliproxy-usage-export.json --ip 192.168.1.20
// The IP identifies the machine (rename it on the Usage page). Safe to re-run.

import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { openDb } from '../db/client'
import { env } from '../env'
import { PriceBook } from '../usage/pricing'
import { importTranscripts, type TranscriptFile } from './importer'

const { values, positionals } = parseArgs({ options: { ip: { type: 'string' } }, allowPositionals: true })
const [path] = positionals
if (!path || !values.ip) {
  console.error('usage: bun server/src/import/file.ts <export.json> --ip <machine ip>')
  process.exit(1)
}

const { files } = JSON.parse(readFileSync(path, 'utf8')) as { files: TranscriptFile[] }
const db = openDb(env.databasePath)
const prices = new PriceBook(db, env.priceCachePath)
await prices.start()

const result = importTranscripts(db, prices, files, values.ip)
console.log(
  `Imported ${result.imported} requests from ${files.length} files as ${values.ip}` +
    ` (${result.alreadyImported} already imported, ${result.afterCutoff} after live collection began).`,
)
process.exit(0)
