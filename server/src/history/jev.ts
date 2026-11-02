// Copied from ResponsiBid/responsi-brain@1f17ff4 src/adapters/jev.reranker.adapter.ts
// (jev-1.13.0, @typesafe-ai/sdk), with the port types from src/ports/reranker.port.ts
// and errorName from src/ports/telemetry.port.ts inlined. Keep in step with Brain.

import { noul, type Questions, type RequestOptions, type SystemOneRequest, type SystemOneResult } from '@typesafe-ai/sdk'

export const JEV_MODEL = 'jev-1.13.0'
const PASSAGE_CHARS = 4000
const RELEVANCE_QUESTION = 'Is `passage` relevant to `query`: does it contain information the searcher is looking for?'
const RELEVANCE_CRITERIA = {
  true: 'The passage is about what the query is looking for and would help answer it.',
  false: 'The passage is off-topic or only shares words with the query.',
}

export interface RerankCandidate {
  readonly id: string
  readonly source: string
  readonly title: string
  readonly heading: string | null
  readonly text: string
}

export interface RerankOptions {
  readonly deadlineMs: number
  readonly signal?: AbortSignal
}

export type RerankWarningCode = 'rerank_timeout' | 'rerank_aborted' | 'rerank_failed'

export interface RerankWarning {
  readonly code: RerankWarningCode | 'rerank_unavailable' | 'rerank_invalid_result'
  readonly errorName?: string
}

export interface RerankResult {
  readonly order: readonly number[]
  readonly scores: readonly number[]
  readonly warning?: RerankWarning
}

export interface Reranker {
  readonly name: string
  rerank(query: string, candidates: readonly RerankCandidate[], options: RerankOptions): Promise<RerankResult>
}

export function inputOrder(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index)
}

export function orderByScore(scores: readonly number[]): number[] {
  const order = inputOrder(scores.length)
  order.sort((a, b) => (scores[b] ?? 0) - (scores[a] ?? 0) || a - b)
  return order
}

function assertValidDeadline(options: RerankOptions): void {
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs <= 0) {
    throw new RangeError(`deadlineMs must be a positive number (got ${options.deadlineMs}).`)
  }
}

export function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

export interface JevClient {
  systemOne(request: SystemOneRequest, options: RequestOptions): PromiseLike<SystemOneResult<Questions>>
}

class DeadlineExceeded extends Error {
  override readonly name = 'DeadlineExceeded'
}

function passageKey(index: number): string {
  return `p${index}`
}

function relevanceQuestions(candidates: readonly RerankCandidate[]): Questions {
  return Object.fromEntries(
    candidates.map((candidate, index) => [
      passageKey(index),
      noul(
        {
          passage: {
            source: candidate.source,
            title: candidate.title,
            heading: candidate.heading ?? '',
            text: candidate.text.slice(0, PASSAGE_CHARS),
          },
          question: RELEVANCE_QUESTION,
        },
        RELEVANCE_CRITERIA,
      ),
    ]),
  )
}

function relevanceScores(result: SystemOneResult<Questions>, count: number): number[] {
  return inputOrder(count).map((index) => {
    const answer = result.answers[passageKey(index)]
    if (answer?.type !== 'noul' || !Number.isFinite(answer.noul)) {
      throw new TypeError(`Jev returned no relevance answer for passage ${index}.`)
    }
    return answer.noul
  })
}

const NO_RETRIES = { maxRetries: 0 } as const

function warningCode(reason: unknown, signal: AbortSignal | undefined): RerankWarningCode {
  if (reason instanceof DeadlineExceeded) return 'rerank_timeout'
  if (signal?.aborted) return 'rerank_aborted'
  return 'rerank_failed'
}

function abortRejection(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

export class JevReranker implements Reranker {
  readonly name = 'jev'

  constructor(private readonly client: JevClient) {}

  async rerank(query: string, candidates: readonly RerankCandidate[], options: RerankOptions): Promise<RerankResult> {
    assertValidDeadline(options)
    if (candidates.length === 0) return { order: [], scores: [] }

    if (options.signal?.aborted) {
      return { order: inputOrder(candidates.length), scores: [], warning: { code: 'rerank_aborted' } }
    }
    const controller = new AbortController()
    const relayCallerAbort = () => controller.abort(options.signal?.reason)
    options.signal?.addEventListener('abort', relayCallerAbort, { once: true })
    if (options.signal?.aborted) relayCallerAbort()
    const aborted = abortRejection(controller.signal)
    const timer = setTimeout(() => controller.abort(new DeadlineExceeded()), options.deadlineMs)

    try {
      const call = this.client.systemOne(
        { model: JEV_MODEL, state: { query }, questions: relevanceQuestions(candidates) },
        { signal: controller.signal, timeout: options.deadlineMs, retry: NO_RETRIES },
      )
      const result = await Promise.race([call, aborted])
      const scores = relevanceScores(result, candidates.length)
      return { order: orderByScore(scores), scores }
    } catch (err) {
      const deadlineReason: unknown = controller.signal.reason
      return {
        order: inputOrder(candidates.length),
        scores: [],
        warning: { code: warningCode(deadlineReason, options.signal), errorName: errorName(err) },
      }
    } finally {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', relayCallerAbort)
    }
  }
}
