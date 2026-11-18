import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'

// One build id per build: the Vercel git SHA when deployed, else a
// local timestamp. It is baked into the bundle (__BUILD_ID__) and also
// written to dist/build-id.json, so a running client can ask "is there
// a newer build than me?" The update guard in App.jsx compares the two
// and offers a refresh — a stale tab must never sit on hashed chunks
// that a newer deploy has already replaced (that white-paged the app
// once: the page loaded, its script 404'd, nothing rendered).
const BUILD_ID = process.env.VERCEL_GIT_COMMIT_SHA
  || `local-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`

function buildIdFile() {
  return {
    name: 'kiluaai-build-id',
    writeBundle(options) {
      const dir = options.dir || path.resolve(process.cwd(), 'dist')
      try { fs.writeFileSync(path.join(dir, 'build-id.json'), JSON.stringify({ buildId: BUILD_ID }) + '\n') } catch { /* /api/version is the fallback */ }
    }
  }
}

export default defineConfig({
  plugins: [react(), buildIdFile()],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { outDir: 'dist' },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  preview: {
    port: 4173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  }
})
