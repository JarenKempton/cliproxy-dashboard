export type QuotaWindow = {
  id: string
  label: string
  usedPercent: number
  resetAtMs: number | null // null: window hasn't started yet
  periodMs: number
}

export class QuotaUnavailableError extends Error {}
