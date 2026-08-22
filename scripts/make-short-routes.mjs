/**
 * Short entry points for the games.
 *
 * The game client is a hash router served from `/lean4game/index.html`, so a
 * shareable path like `/visualNNG` cannot be a route inside it, and GitHub
 * Pages offers no rewrite rules. Each short path is therefore a real directory
 * holding a tiny page that replaces itself with the hash URL.
 *
 * `location.replace` keeps the short link out of the back-button history, so
 * leaving the game returns to wherever the player actually came from.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const SHORT_ROUTES = {
  visualNNG: '/lean4game/index.html#/g/local/NNG4/visual',
  classicNNG: '/lean4game/index.html#/g/local/NNG4',
  pitch: '/lean4game/index.html#/g/local/VisualTest/visual',
}

const page = (target, title) => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="robots" content="noindex" />
    <title>${title}</title>
    <link rel="canonical" href="${target}" />
    <script>location.replace(${JSON.stringify(target)} + location.search)</script>
  </head>
  <body>
    <p>Opening <a href="${target}">${title}</a>&hellip;</p>
  </body>
</html>
`

const titles = {
  visualNNG: 'The Natural Numbers Video Game',
  classicNNG: 'The Natural Numbers Game Classic',
  pitch: 'Visual Lean — Elevator Pitch',
}

export async function writeShortRoutes(publicDir) {
  for (const [route, target] of Object.entries(SHORT_ROUTES)) {
    const directory = path.join(publicDir, route)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, 'index.html'), page(target, titles[route]), 'utf8')
  }
  return Object.keys(SHORT_ROUTES)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const publicDir = path.resolve(import.meta.dirname, '..', 'public')
  const routes = await writeShortRoutes(publicDir)
  console.log(`wrote short routes: ${routes.map(route => `/${route}`).join(', ')}`)
}
