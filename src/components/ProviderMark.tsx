import { ClaudeLogo, OpenAILogo } from './ProviderLogos'

// Accepts usage vendors, upstream account providers, or client tools.
export function ProviderMark({ of, size = 14 }: { of: string; size?: number }) {
  const provider = of === 'claude-code' ? 'claude' : of
  if (provider === 'claude' || provider === 'anthropic') return <ClaudeLogo className="mark mark-claude" width={size} height={size} />
  if (provider === 'codex' || provider === 'openai') return <OpenAILogo className="mark mark-codex" width={size} height={size} />
  return <span className="dot" />
}
