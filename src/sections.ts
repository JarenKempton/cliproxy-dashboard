// Throwaway prototype: one tab per area of the management API, so you can
// decide what the real dashboard keeps. Everything here is a read-only GET.

export type Section = {
  id: string
  title: string
  blurb: string
  endpoints: string[]
}

export const SECTIONS: Section[] = [
  {
    id: 'overview',
    title: 'Overview',
    blurb: 'Version, key runtime toggles and routing strategy.',
    endpoints: ['/latest-version', '/routing/strategy', '/debug', '/request-log', '/logging-to-file', '/usage-statistics-enabled'],
  },
  {
    id: 'accounts',
    title: 'Accounts',
    blurb: 'OAuth credentials (Claude, Codex, Gemini, …) with status, errors and counters.',
    endpoints: ['/auth-files'],
  },
  {
    id: 'traffic',
    title: 'Traffic',
    blurb: 'Success/failure counts per provider key over the last ~3 hours.',
    endpoints: ['/api-key-usage'],
  },
  {
    id: 'proxy-keys',
    title: 'Proxy keys',
    blurb: 'Keys your own projects use to call this proxy.',
    endpoints: ['/api-keys'],
  },
  {
    id: 'providers',
    title: 'Provider keys',
    blurb: 'Upstream API keys and OpenAI-compatible providers.',
    endpoints: [
      '/claude-api-key',
      '/codex-api-key',
      '/gemini-api-key',
      '/openai-compatibility',
      '/vertex-api-key',
      '/xai-api-key',
      '/interactions-api-key',
    ],
  },
  {
    id: 'models',
    title: 'Models',
    blurb: 'Model aliases and blocked models for OAuth accounts.',
    endpoints: ['/oauth-model-alias', '/oauth-excluded-models'],
  },
  {
    id: 'logs',
    title: 'Logs',
    blurb: 'Recent server log lines and saved request error logs.',
    endpoints: ['/logs?limit=200', '/request-error-logs'],
  },
  {
    id: 'plugins',
    title: 'Plugins',
    blurb: 'Installed plugins and the plugin store.',
    endpoints: ['/plugins', '/plugin-store'],
  },
  {
    id: 'config',
    title: 'Raw config',
    blurb: 'The full runtime config (secrets masked). Everything else is a slice of this.',
    endpoints: ['/config'],
  },
]
