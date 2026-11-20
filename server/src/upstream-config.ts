import { createHash } from 'node:crypto'
import { isMap, isNode, isSeq, parseDocument } from 'yaml'

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
export type UpstreamRoute = { list: UpstreamList; path: (string | number)[]; entry: UpstreamKey }
export type PauseSnapshot = { present: boolean; value?: unknown }
const FAMILY = { 'claude-api-key': 'claude', 'codex-api-key': 'codex', 'openai-compatibility': 'openai-compatibility' }
export const gatewayOf = (e: UpstreamKey) => e['base-url']?.match(/^(.*)\/pool(?:\/v1)?\/?$/)?.[1]
export const pausedField = (list: UpstreamList) => list === 'openai-compatibility' ? 'disabled' : 'excluded-models'
export const isPaused = ({ list, entry }: UpstreamRoute) => list === 'openai-compatibility' ? entry.disabled === true : (entry['excluded-models'] ?? []).includes('*')
export const routeId = ({ list, entry }: UpstreamRoute) => createHash('sha256').update(JSON.stringify([
  list, entry['base-url'], entry.name, entry.prefix, entry['api-key'], entry['api-key-entries']?.map((k) => k['api-key']),
])).digest('hex')

export class UpstreamConfig {
  readonly doc

  constructor(readonly text: string) {
    this.doc = parseDocument(text)
    if (this.doc.errors.length || !isMap(this.doc.contents)) throw new Error('The proxy returned invalid config.yaml')
  }

  private grouped(list: UpstreamList) {
    return this.doc.hasIn(['api-keys', FAMILY[list]]) || (!this.doc.has(list) && (this.doc.get('config-version') === 8 || isMap(this.doc.get('api-keys'))))
  }

  routes(): UpstreamRoute[] {
    return UPSTREAM_LISTS.flatMap((list): UpstreamRoute[] => {
      const path = this.grouped(list) ? ['api-keys', FAMILY[list]] : [list]
      const nodes = json(this.doc.getIn(path)) ?? []
      if (!Array.isArray(nodes)) throw new Error(`The proxy returned an invalid ${list} list`)
      return nodes.flatMap((group: UpstreamKey & { keys?: UpstreamKey[] }, i: number) => {
        if (!this.grouped(list)) return [{ list, path: [...path, i], entry: group }]
        if (!Array.isArray(group.keys)) throw new Error(`The proxy returned invalid keys for ${list}`)
        if (list === 'openai-compatibility') return [{ list, path: [...path, i], entry: { ...group, 'api-key-entries': group.keys } }]
        return group.keys.map((key, k) => ({ list, path: [...path, i, 'keys', k], entry: { ...group, ...key } }))
      })
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
