import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite's HTML fallback treats `/lean4game/` as an application route and serves
// the outer index.html, even though the Lean4Game client is copied to
// public/lean4game/index.html. Rewrite the directory URL before that fallback.
const lean4GameSubApp = {
  name: 'lean4game-sub-app',
  configureServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/lean4game/' || req.url?.startsWith('/lean4game/?')) {
        req.url = `/lean4game/index.html${req.url.slice('/lean4game/'.length)}`
      }
      next()
    })
  },
  configurePreviewServer(server: { middlewares: { use: (handler: (req: { url?: string }, res: unknown, next: () => void) => void) => void } }) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === '/lean4game/' || req.url?.startsWith('/lean4game/?')) {
        req.url = `/lean4game/index.html${req.url.slice('/lean4game/'.length)}`
      }
      next()
    })
  },
}

export default defineConfig({
  plugins: [lean4GameSubApp, react()],
  build: {
    rollupOptions: {
      // Vite only builds index.html unless the extra pages are named here.
      // The completion page is a plain static URL so it stays linkable from
      // the Lean4Game sub-app and from anywhere else.
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        congratulations: resolve(import.meta.dirname, 'congratulations.html'),
      },
    },
  },
})
