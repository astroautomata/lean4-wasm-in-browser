import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The game client owns real URLs now (`/visualNNG`, `/g/local/NNG4/world/...`),
// none of which exist as files. In production GitHub Pages serves 404.html,
// which the sync script writes as a copy of the game shell. The dev and preview
// servers need the same behaviour, or Vite's HTML fallback answers with the
// outer landing page instead of the game.
//
// `/lean4game/` is handled here too: Vite treats the directory URL as an
// application route even though the client is copied to
// public/lean4game/index.html.
const GAME_PATHS = ['/visualNNG', '/classicNNG', '/pitch', '/g/']

type Middleware = (req: { url?: string }, res: unknown, next: () => void) => void
type Server = { middlewares: { use: (handler: Middleware) => void } }

const serveGameShell: Middleware = (req, _res, next) => {
  const url = req.url ?? ''
  const [pathname] = url.split('?')
  if (pathname === '/lean4game/' || url.startsWith('/lean4game/?')) {
    req.url = `/lean4game/index.html${url.slice('/lean4game/'.length)}`
  } else if (GAME_PATHS.some(path => pathname === path || pathname.startsWith(`${path}/`) || pathname.startsWith(path))) {
    // Keep the query; the route itself lives in the path now.
    const query = url.slice(pathname.length)
    req.url = `/lean4game/index.html${query}`
  }
  next()
}

const lean4GameSubApp = {
  name: 'lean4game-sub-app',
  configureServer(server: Server) {
    server.middlewares.use(serveGameShell)
  },
  configurePreviewServer(server: Server) {
    server.middlewares.use(serveGameShell)
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
