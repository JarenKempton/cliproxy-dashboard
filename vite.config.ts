import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Dev server: the usage server (server/) answers /api, /connect and the
// management bridge at /v0/management, so `npm run server` must be running.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ['USAGE_'])
  const server = `http://127.0.0.1:${env.USAGE_SERVER_PORT || 5174}`

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': { target: server },
        '/connect': { target: server },
        '/v0/management': { target: server },
      },
    },
  }
})
