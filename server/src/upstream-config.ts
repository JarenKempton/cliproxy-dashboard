import { createHash } from 'node:crypto'
import { isAlias, isMap, isNode, isSeq, parseDocument, visit, YAMLMap, YAMLSeq } from 'yaml'

import { expandAliases } from './yaml-aliases'

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
  private readonly v8: boolean

  constructor(readonly text: string) {
    this.doc = parseDocument(text, { merge: true })
    if (this.doc.errors.length || !isMap(this.doc.contents)) throw new Error('The proxy returned invalid config.yaml')
    let aliased = false
    visit(this.doc, (_, node) => { if (isAlias(node)) aliased = true })
    if (aliased) expandAliases(this.doc)
    const roots = ['models', 'config-version', 'server', 'management', 'access', 'credentials', 'requests', 'oauth', 'upstream', 'multimedia', 'observability']
    this.v8 = roots.some((root) => this.doc.has(root)) || isMap(this.doc.get('api-keys')) || ['retry', 'cooldown', 'force-model-prefix'].some((key) => this.doc.hasIn(['routing', key])) || ['client', 'providers'].some((root) => this.doc.hasIn([root, 'codex', 'optimize-multi-agent-v2']))
    if (this.v8 && isSeq(this.doc.get('api-keys'))) {
      if (!this.doc.hasIn(['access', 'api-keys'])) this.doc.setIn(['access', 'api-keys'], this.doc.get('api-keys', true)!.clone())
      this.doc.delete('api-keys')
    }
    if (this.v8) {
      for (const list of UPSTREAM_LISTS) {
        if (!this.doc.has(list)) continue
        const path = ['api-keys', FAMILY[list]]
        if (!this.doc.hasIn(path)) {
          const entries = this.doc.get(list)
          if (!isSeq(entries)) throw new Error(`The proxy returned an invalid ${list} list`)
          const groups = new YAMLSeq(this.doc.schema)
          for (const [i, entry] of entries.items.entries()) {
            if (!isMap(entry)) throw new Error(`The proxy returned an invalid ${list} entry`)
            if (list === 'openai-compatibility') {
              const group = entry.clone() as YAMLMap
              group.set('keys', group.get('api-key-entries', true) ?? this.doc.createNode([]))
              group.delete('api-key-entries')
              groups.add(group)
            } else {
              const key = entry.clone() as YAMLMap
              const group = new YAMLMap(this.doc.schema)
              group.set('name', `${FAMILY[list]}-${i + 1}`)
              const base = key.get('base-url', true)
              if (base !== undefined) group.set('base-url', base)
              key.delete('base-url')
              const keys = new YAMLSeq(this.doc.schema)
              keys.add(key)
              group.set('keys', keys)
              groups.add(group)
            }
          }
          this.doc.setIn(path, groups)
        }
        this.doc.delete(list)
      }
    }
  }

  private grouped(list: UpstreamList) {
    return this.doc.hasIn(['api-keys', FAMILY[list]]) || (!this.doc.has(list) && this.v8)
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
