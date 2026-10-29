import type { AuthFile } from '../lib/api'
import { cooldownUntil } from '../lib/status'
import { accountName, useStore } from '../lib/store'
import { toast } from './ui'

export function ClearCooldown({ file }: { file: AuthFile }) {
  const { now, busy, clearCooldown } = useStore()
  if (file.disabled || !cooldownUntil(file, now)) return null

  const clear = async () => {
    try {
      await clearCooldown(file)
      toast(`Cooldown cleared for ${accountName(file)}`)
    } catch (err) {
      toast(`Couldn’t clear the cooldown: ${(err as Error).message}`)
    }
  }

  return (
    <button
      className="btn btn-small cooldown-clear"
      disabled={busy.has(file.auth_index)}
      title="Let the proxy use this account again now. If the limit is real, the next request puts it back on cooldown."
      onClick={clear}
    >
      Clear cooldown
    </button>
  )
}
