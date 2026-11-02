// History settings, shared by the dashboard and the indexer container.

export const historyEnv = {
  // Raw transcripts, one folder per machine laid out like its home.
  dir: process.env.HISTORY_DIR ?? 'history',
  // Search index; rebuilt from `dir` when deleted or when Quench or the model changes.
  dbPath: process.env.HISTORY_DB_PATH ?? 'data/history.db',
  modelDir: process.env.HISTORY_MODEL_DIR ?? 'models',
  // trash-pro has little free memory and CPU to spare.
  embedThreads: Number(process.env.HISTORY_EMBED_THREADS ?? 2),
  indexIntervalMs: Number(process.env.HISTORY_INDEX_INTERVAL_S ?? 300) * 1000,
  quenchBin: process.env.QUENCH_BIN ?? 'quench',
  // Jev rerank; without a key, search returns the merged order.
  typesafeApiKey: process.env.TYPESAFE_API_KEY || null,
}
