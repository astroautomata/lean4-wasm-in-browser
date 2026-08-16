import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const lean4jsRoot = path.resolve(here, '..')
const workspaceRoot = path.resolve(lean4jsRoot, '..')
const lean4gameRoot = path.join(workspaceRoot, 'Lean4Game', 'lean4game')
const outDir = path.join(lean4jsRoot, 'public', 'lean4game')

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

function npmRunArgs(scriptName) {
  return process.platform === 'win32'
    ? ['C:\\Windows\\System32\\cmd.exe', ['/d', '/s', '/c', `npm.cmd run ${scriptName}`]]
    : ['npm', ['run', scriptName]]
}

async function run(cmd, args, options = {}) {
  const childEnv = {
    ...process.env,
    LEAN4GAME_BASE: '/lean4game/',
    NODE_ENV: 'production',
    ...options.env,
  }
  if (process.platform === 'win32') {
    childEnv.npm_config_script_shell = 'C:\\Windows\\System32\\cmd.exe'
  }

  await new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
      ...options,
      env: childEnv,
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))
    })
  })
}

async function copyGameData(gameName) {
  const source = path.join(workspaceRoot, 'Lean4Game', gameName, '.lake', 'gamedata')
  const dest = path.join(outDir, 'data', 'g', 'local', gameName)
  if (!(await exists(source))) {
    throw new Error(`Missing generated game data for ${gameName}: ${source}`)
  }
  await mkdir(dest, { recursive: true })
  await cp(source, dest, { recursive: true, force: true })
}

async function omitNngAlgorithmWorld() {
  const dest = path.join(outDir, 'data', 'g', 'local', 'NNG4')
  const gamePath = path.join(dest, 'game.json')
  const game = JSON.parse(await readFile(gamePath, 'utf8'))

  game.title = 'The Natural Numbers Game'
  if (typeof game.introduction === 'string') {
    game.introduction = game.introduction.replaceAll('The Natural Number Game', 'The Natural Numbers Game')
  }
  delete game.worlds?.nodes?.Algorithm
  if (Array.isArray(game.worlds?.edges)) {
    game.worlds.edges = game.worlds.edges.filter(edge => !edge.includes('Algorithm'))
  }
  delete game.worldSize?.Algorithm
  delete game.skippedLevels?.Algorithm
  if (game.tile) {
    game.tile.worlds = Object.keys(game.worlds?.nodes ?? {}).length
    game.tile.levels = Object.values(game.worldSize ?? {}).reduce((sum, size) => sum + Number(size), 0)
  }

  // The checked-in NNG4 gamedata can lag behind the current Lean source.
  // Keep the completion-neutral final level's release metadata current even
  // when a machine syncing the static site does not have Lake installed.
  game.completionNeutralLevels ??= {}
  game.completionNeutralLevels.Power = Array.from(new Set([
    ...(game.completionNeutralLevels.Power ?? []),
    10,
  ])).sort((left, right) => left - right)
  if (Array.isArray(game.skippedLevels?.Power)) {
    game.skippedLevels.Power = game.skippedLevels.Power.filter(level => level !== 10)
  }

  await writeFile(gamePath, `${JSON.stringify(game)}\n`)
  for (const file of await readdir(dest)) {
    if (file.startsWith('level__Algorithm__') && file.endsWith('.json')) {
      await rm(path.join(dest, file))
    } else if (file.endsWith('.json')) {
      const filePath = path.join(dest, file)
      const contents = await readFile(filePath, 'utf8')
      const normalized = contents.replaceAll('The Natural Number Game', 'The Natural Numbers Game')
      if (normalized !== contents) await writeFile(filePath, normalized)
    }
  }
  const fermatPath = path.join(dest, 'level__Power__10.json')
  if (await exists(fermatPath)) {
    const fermat = JSON.parse(await readFile(fermatPath, 'utf8'))
    fermat.title = "Fermat's Last Theorem ❌"
    fermat.completionNeutral = true
    fermat.visualSkipLevel = false
    fermat.visualGoalInfos = [
      { position: 'below', arrow: false, text: 'Good luck!' },
    ]
    await writeFile(fermatPath, `${JSON.stringify(fermat)}\n`)
  }
}

if (!(await exists(lean4gameRoot))) {
  throw new Error(`Missing Lean4Game client repo: ${lean4gameRoot}`)
}

const [buildClientCmd, buildClientArgs] = npmRunArgs('build:client')
await run(buildClientCmd, buildClientArgs, { cwd: lean4gameRoot })

const dist = path.join(lean4gameRoot, 'client', 'dist')
if (!(await exists(dist))) {
  throw new Error(`Lean4Game client build did not produce ${dist}`)
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await cp(dist, outDir, { recursive: true, force: true })
// Vite fingerprints the fonts that the Monaco/infoview bundle actually loads.
// Lean4Game's public/fonts directory is a second, unreferenced copy (including
// a 23 MiB emoji font), so do not ship it in the release sub-app.
await rm(path.join(outDir, 'fonts'), { recursive: true, force: true })
await copyGameData('NNG4')
await omitNngAlgorithmWorld()
await copyGameData('VisualTest')

console.log(`Synced Lean4Game client to ${path.relative(lean4jsRoot, outDir)}`)
