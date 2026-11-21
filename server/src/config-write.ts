const pending = new Map<string, Promise<unknown>>()

export function withConfigWrite<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const key = target.replace(/\/+$/, '')
  const result = (pending.get(key) ?? Promise.resolve()).then(operation)
  const settled = result.then(() => {}, () => {})
  pending.set(key, settled)
  void settled.then(() => { if (pending.get(key) === settled) pending.delete(key) })
  return result
}
