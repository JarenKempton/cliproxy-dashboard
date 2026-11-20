import { createHash } from 'node:crypto'
import { isAlias, isMap, isNode, isSeq, parseDocument, visit } from 'yaml'

const json = (value: unknown) => isNode(value) ? value.toJSON() : value

export const UPSTREAM_LISTS = ['claude-api-key', 'codex-api-key', 'openai-compatibility'] as const
export type UpstreamList = (typeof UPSTREAM_LISTS)[number]
export type UpstreamKey = Record<string, unknown> & {
  'api-key'?: string
  'base-url'?: string
  'api-key-entries'?: { 'api-key'?: string }[]
  'excluded-models'?: string[]
  disabled?: boolean
}
export type UpstreamRoute = { list: UpstreamList; path: (string | number)[]; entry: UpstreamKey; occurrence?: number }
export type PauseSnapshot = { present: boolean; value?: unknown }
const FAMILY = { 'claude-api-key': 'claude', 'codex-api-key': 'codex', 'openai-compatibility': 'openai-compatibility' }
export const gatewayOf = (e: UpstreamKey) => e['base-url']?.trim().match(/^(.*)\/pool(?:\/v1)?\/?$/)?.[1]
export const pausedField = (list: UpstreamList) => list === 'openai-compatibility' ? 'disabled' : 'excluded-models'
export const isPaused = ({ list, entry }: UpstreamRoute) => list === 'openai-compatibility' ? entry.disabled === true : (entry['excluded-models'] ?? []).includes('*')
export const routeId = ({ list, entry, occurrence = 0 }: UpstreamRoute) => createHash('sha256').update(JSON.stringify([
  list, entry['base-url']?.trim(), list === 'openai-compatibility' ? entry.name : undefined, entry.prefix, entry['proxy-url'], entry['api-key'], entry['api-key-entries']?.map((k) => k['api-key']), occurrence,
])).digest('hex')

export class UpstreamConfig {
  readonly doc: ReturnType<typeof parseDocument>

  constructor(readonly text: string) {
    this.doc = parseDocument(text, { merge: true })
    if (this.doc.errors.length || !isMap(this.doc.contents)) throw new Error('The proxy returned invalid config.yaml')
    const resolved = this.doc.toJS()
    for (const list of UPSTREAM_LISTS) {
      for (const path of [[list], ['api-keys', FAMILY[list]]]) {
        const node = this.doc.getIn(path)
        let aliased = false
        if (isNode(node)) visit(node, (_, value) => {
          if (isAlias(value) || (isMap(value) && value.items.some((pair) => isNode(pair.key) && String(json(pair.key)).includes('<<')))) aliased = true
        })
        if (aliased) {
          const value = path.reduce((value, key) => value?.[key], resolved)
          this.doc.setIn(path, this.doc.createNode(value))
        }
      }
    }
    if (this.doc.get('config-version') === 8 && isSeq(this.doc.get('api-keys'))) {
      if (!this.doc.hasIn(['access', 'api-keys'])) this.doc.setIn(['access', 'api-keys'], this.doc.createNode(json(this.doc.get('api-keys'))))
      this.doc.delete('api-keys')
    }
    if (isMap(this.doc.get('api-keys')) || this.doc.get('config-version') === 8) {
      for (const list of UPSTREAM_LISTS) {
        if (!this.doc.has(list)) continue
        const path = ['api-keys', FAMILY[list]]
        if (!this.doc.hasIn(path)) {
          const entries = json(this.doc.get(list))
          if (!Array.isArray(entries)) throw new Error(`The proxy returned an invalid ${list} list`)
          const groups = entries.map((entry: UpstreamKey, i: number) => {
            if (list === 'openai-compatibility') {
              const { 'api-key-entries': keys = [], ...group } = entry
              return { ...group, keys }
            }
            const { 'base-url': base, ...key } = entry
            return { name: `${FAMILY[list]}-${i + 1}`, 'base-url': base, keys: [key] }
          })
          this.doc.setIn(path, this.doc.createNode(groups))
        }
        this.doc.delete(list)
      }
    }
  }

  private grouped(list: UpstreamList) {
    return this.doc.hasIn(['api-keys', FAMILY[list]]) || (!this.doc.has(list) && (isMap(this.doc.get('api-keys')) || (this.doc.get('config-version') === 8 && !isSeq(this.doc.get('api-keys')))))
  }

  routes(): UpstreamRoute[] {
    const occurrences = new Map<string, number>()
    return UPSTREAM_LISTS.flatMap((list): UpstreamRoute[] => {
      const path = this.grouped(list) ? ['api-keys', FAMILY[list]] : [list]
      const nodes = json(this.doc.getIn(path)) ?? []
      if (!Array.isArray(nodes)) throw new Error(`The proxy returned an invalid ${list} list`)
      return nodes.flatMap((group: UpstreamKey & { keys?: UpstreamKey[] }, i: number) => {
        if (!this.grouped(list)) return [{ list, path: [...path, i], entry: group }]
        if (!Array.isArray(group.keys)) throw new Error(`The proxy returned invalid keys for ${list}`)
        if (list === 'openai-compatibility') return [{ list, path: [...path, i], entry: { ...group, 'api-key-entries': group.keys } }]
        return group.keys.map((key, k) => ({ list, path: [...path, i, 'keys', k], entry: { ...group, ...Object.fromEntries(Object.entries(key).filter(([, value]) => value != null)) } }))
      })
    }).map((route) => {
      const id = routeId(route)
      const occurrence = occurrences.get(id) ?? 0
      occurrences.set(id, occurrence + 1)
      return { ...route, occurrence }
    })
  }

  snapshot(route: UpstreamRoute): PauseSnapshot {
    const path = [...route.path, pausedField(route.list)]
    return { present: this.doc.hasIn(path), value: json(this.doc.getIn(path)) }
  }

  pause(route: UpstreamRoute) {
    const value = route.list === 'openai-compatibility' ? true : [...new Set([...(route.entry['excluded-models'] ?? []), '*'])]
    this.doc.setIn([...route.path, pausedField(route.list)], this.doc.createNode(value))
  }

  restore(route: UpstreamRoute, snapshot: PauseSnapshot) {
    const path = [...route.path, pausedField(route.list)]
    if (snapshot.present) this.doc.setIn(path, this.doc.createNode(snapshot.value))
    else this.doc.deleteIn(path)
  }

  replace(route: UpstreamRoute, replacement: UpstreamKey) {
    const next = { ...replacement }
    if (this.grouped(route.list)) {
      if (route.list === 'openai-compatibility') {
        next.keys = next['api-key-entries']
        delete next['api-key-entries']
      } else {
        delete next.keys
        delete next.name
        delete next['base-url']
      }
    }
    const node = this.doc.getIn(route.path)
    if (!isMap(node)) throw new Error('The upstream route disappeared from config.yaml')
    for (const [key, value] of Object.entries(next)) if (value !== undefined) node.set(key, this.doc.createNode(value))
    return this.routes().find((r) => JSON.stringify(r.path) === JSON.stringify(route.path))!
  }

  add(list: UpstreamList, entry: UpstreamKey) {
    const grouped = this.grouped(list)
    const path = grouped ? ['api-keys', FAMILY[list]] : [list]
    const entries = json(this.doc.getIn(path)) ?? []
    const next = { ...entry }
    if (grouped) {
      if (list === 'openai-compatibility') {
        next.keys = next['api-key-entries']
        delete next['api-key-entries']
      } else {
        next.name = `pool-${FAMILY[list]}-${entries.length + 1}`
        next.keys = [{ 'api-key': entry['api-key'] }]
        delete next['api-key']
      }
    }
    if (!isSeq(this.doc.getIn(path))) this.doc.setIn(path, this.doc.createNode([]))
    this.doc.addIn(path, this.doc.createNode(next))
    return this.routes().filter((route) => route.list === list).at(-1)!
  }

  remove(route: UpstreamRoute) {
    this.doc.deleteIn(route.path)
  }

  toString() {
    return this.doc.toString({ lineWidth: 0 })
  }
}
