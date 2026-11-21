import { isAlias, isMap, isNode, isScalar, isSeq, type Document } from 'yaml'

export function expandAliases(doc: Document) {
  let remaining = 10000
  const expand = (node: unknown, ancestors: Set<unknown>): unknown => {
    if (!isNode(node)) return node
    if (--remaining < 0 || ancestors.has(node)) throw new Error('The proxy config contains recursive or oversized YAML aliases')
    const next = new Set(ancestors).add(node)
    if (isAlias(node)) {
      const source = node.resolve(doc)
      if (!source) throw new Error('The proxy config contains an unresolved YAML alias')
      const copy = expand(source, next)
      if (isNode(copy)) {
        copy.comment = [copy.comment, node.comment].filter(Boolean).join('\n') || undefined
        copy.commentBefore = [copy.commentBefore, node.commentBefore].filter(Boolean).join('\n') || undefined
      }
      return copy
    }
    const copy = node.clone()
    if (isScalar(copy) || isMap(copy) || isSeq(copy)) delete copy.anchor
    if (isSeq(copy) && isSeq(node)) copy.items = node.items.map((item) => expand(item, next))
    if (isMap(copy) && isMap(node)) {
      const merge = (key: unknown) => isScalar(key) && typeof key.value === 'symbol' && key.value.description === '<<'
      copy.items = node.items.filter((pair) => !merge(pair.key)).map((pair) => {
        const result = pair.clone()
        result.key = expand(pair.key, next)
        result.value = expand(pair.value, next)
        return result
      })
      for (const pair of node.items.filter((pair) => merge(pair.key))) {
        const source = expand(pair.value, next)
        for (const item of isSeq(source) ? source.items : [source]) {
          if (!isMap(item)) throw new Error('The proxy config contains an invalid YAML merge')
          for (const entry of item.items) if (!copy.has(isScalar(entry.key) ? entry.key.value : entry.key)) copy.items.push(entry)
        }
      }
    }
    return copy
  }
  const root = expand(doc.contents, new Set())
  if (!isMap(root)) throw new Error('The proxy config must be a YAML mapping')
  doc.contents = root
}
