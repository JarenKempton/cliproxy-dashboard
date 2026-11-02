// Copied from ResponsiBid/responsi-brain@1f17ff4 src/search/v2/rerank.ts.
// Changes: candidates are generic instead of Brain chunk rows, and Brain's
// lifecycle `historicalFactor` is dropped (history has no superseded docs).

import { errorName, inputOrder, orderByScore, type RerankCandidate, type Reranker, type RerankResult, type RerankWarning } from './jev'

export const RERANK_POOL = 25
export const RERANK_DEADLINE_MS = 350

interface RerankOutcome {
  readonly order: readonly number[]
  readonly scores?: readonly number[]
  readonly warning?: RerankWarning
}

function withinDeadline(pending: Promise<RerankResult>): Promise<RerankResult> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<RerankResult>((resolve) => {
    timer = setTimeout(() => resolve({ order: [], scores: [], warning: { code: 'rerank_timeout' } }), RERANK_DEADLINE_MS)
  })
  return Promise.race([pending, deadline]).finally(() => clearTimeout(timer))
}

function isPermutation(order: readonly number[] | undefined, count: number): order is readonly number[] {
  return (
    Array.isArray(order) &&
    order.length === count &&
    new Set(order).size === count &&
    order.every((index) => Number.isInteger(index) && index >= 0 && index < count)
  )
}

function isScored(scores: readonly number[] | undefined, count: number): scores is readonly number[] {
  return Array.isArray(scores) && scores.length === count && scores.every((score) => Number.isFinite(score) && score >= 0)
}

async function rerankResult(reranker: Reranker, query: string, candidates: readonly RerankCandidate[]): Promise<RerankResult> {
  try {
    return await withinDeadline(reranker.rerank(query, candidates, { deadlineMs: RERANK_DEADLINE_MS }))
  } catch (error) {
    return { order: [], scores: [], warning: { code: 'rerank_failed', errorName: errorName(error) } }
  }
}

export async function rerankRows(
  reranker: Reranker | null,
  query: string,
  candidates: readonly RerankCandidate[],
): Promise<RerankOutcome> {
  if (candidates.length === 0) return { order: [] }
  const unreranked = (warning: RerankWarning): RerankOutcome => ({ order: inputOrder(candidates.length), warning })
  if (!reranker) return unreranked({ code: 'rerank_unavailable' })
  const result = await rerankResult(reranker, query, candidates)
  if (result?.warning) return unreranked(result.warning)
  if (!isPermutation(result?.order, candidates.length) || !isScored(result?.scores, candidates.length)) {
    return unreranked({ code: 'rerank_invalid_result' })
  }
  return { order: orderByScore(result.scores), scores: result.scores }
}
