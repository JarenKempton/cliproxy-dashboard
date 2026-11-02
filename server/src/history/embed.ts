// Local CPU embeddings (bge-small-en-v1.5, 384 dims, 8-bit), with a capped
// thread count. The image ships the model in HISTORY_MODEL_DIR.

import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'
import { historyEnv } from './env'

export const EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5:q8'
export const DIMS = 384
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: '

let loading: Promise<FeatureExtractionPipeline> | null = null

function model() {
  env.cacheDir = historyEnv.modelDir
  loading ??= pipeline('feature-extraction', 'Xenova/bge-small-en-v1.5', {
    dtype: 'q8',
    session_options: { intraOpNumThreads: historyEnv.embedThreads, interOpNumThreads: 1 },
  })
  return loading
}

export async function embedPassages(texts: string[]): Promise<Float32Array[]> {
  const out = await (await model())(texts, { pooling: 'cls', normalize: true })
  const data = out.data as Float32Array
  return texts.map((_, i) => data.slice(i * DIMS, (i + 1) * DIMS))
}

export async function embedQuery(text: string): Promise<Float32Array> {
  const [vector] = await embedPassages([QUERY_PREFIX + text])
  return vector
}

if (import.meta.main) {
  await embedPassages(['warm the model cache'])
  console.log(`[embed] ${EMBEDDING_MODEL} ready in ${historyEnv.modelDir}`)
}
