import { ClaudeLogo, OpenAILogo } from './ProviderLogos'

// Accepts a provider ('claude', 'codex') or a tool ('claude-code', 'codex').
export function ProviderMark({ of, size = 14 }: { of: string; size?: number }) {
  const provider = of === 'claude-code' ? 'claude' : of
  if (provider === 'claude') return <ClaudeLogo className="mark mark-claude" width={size} height={size} />
  if (provider === 'codex') return <OpenAILogo className="mark mark-codex" width={size} height={size} />
  return <span className="dot" />
}
