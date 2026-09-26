// Labels for proxy keys, stored by key hash.

import { eq } from 'drizzle-orm'
import type { Db } from './db/client'
import { keyLabels } from './db/schema'

export function listKeyLabels(db: Db): Record<string, string> {
  return Object.fromEntries(db.select().from(keyLabels).all().map((row) => [row.keyHash, row.label]))
}

export function setKeyLabel(db: Db, keyHash: string, label: string) {
  if (!label) {
    db.delete(keyLabels).where(eq(keyLabels.keyHash, keyHash)).run()
    return
  }
  db.insert(keyLabels)
    .values({ keyHash, label })
    .onConflictDoUpdate({ target: keyLabels.keyHash, set: { label } })
    .run()
}
