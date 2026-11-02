// Raw transcripts pushed by machines, stored untouched under
// <HISTORY_DIR>/<machine>/<path>, where <path> follows the harness layout in a
// home folder (.claude/projects/…, .codex/sessions/…, .pi/agent/sessions/…).
//
// A push names a byte offset. Bytes the server already has are skipped and
// a gap is refused, so re-sending the same bytes changes nothing. The reply
// is the server's size for each file, which the machine resumes from.

import { appendFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const HARNESS_ROOTS = ['.claude/projects/', '.codex/sessions/', '.pi/agent/sessions/']

export type PushedFile = { path: string; offset: number; data: string }

export function validPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    HARNESS_ROOTS.some((root) => path.startsWith(root)) &&
    path.endsWith('.jsonl') &&
    !path.includes('\0') &&
    !path.includes('\\') &&
    path.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  )
}

// Machine names become folder names.
export function machineFolder(name: string) {
  const folder = name.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '')
  return folder || null
}

const sizeOf = (file: string) => (existsSync(file) ? statSync(file).size : 0)

export function appendAt(root: string, machine: string, file: PushedFile): number {
  const target = join(root, machine, file.path)
  const size = sizeOf(target)
  if (file.offset > size) return size
  const data = Buffer.from(file.data, 'base64')
  const skip = size - file.offset
  if (skip >= data.length) return size
  mkdirSync(dirname(target), { recursive: true })
  appendFileSync(target, data.subarray(skip))
  return size + data.length - skip
}
