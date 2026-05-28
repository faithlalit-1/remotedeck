#!/usr/bin/env node
/**
 * Watches RemoteDeck source files and auto-rebuilds + redeploys the Desktop
 * app whenever you change code. Each rebuild takes ~10-15s, so changes are
 * coalesced with a debounce window (default 1500ms) to avoid kicking off a
 * new build on every keystroke. A new change during a running build queues a
 * follow-up build so you always end up on the latest code.
 *
 * Tip: for a much tighter inner loop while you're actively coding, prefer
 *      `npm run electron:dev` which uses hot reload against the Vite dev
 *      server — no repackaging needed. Use this watcher only when you want
 *      the *Desktop icon* (~/Desktop/RemoteDeck.app) to always stay fresh.
 */
import chokidar from 'chokidar'
import path from 'node:path'
import { deploy } from './deploy-desktop.mjs'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const WATCH_PATHS = [
  'src',
  'electron',
  'server',
  'public',
  'index.html',
  'vite.config.ts',
  'tsconfig.app.json',
  'tsconfig.json',
  'tsconfig.node.json',
  'package.json',
].map((p) => path.join(projectRoot, p))

const IGNORED = [
  /(^|[\\/])\.[^\\/]/, // dotfiles (.DS_Store, .git, etc.)
  /node_modules/,
  /dist/,
  /release/,
  /\.log$/,
]

const DEBOUNCE_MS = Number(process.env.REMOTEDECK_WATCH_DEBOUNCE || 1500)

function ts() {
  return new Date().toLocaleTimeString()
}
function log(msg) {
  console.log(`\x1b[35m[watch ${ts()}]\x1b[0m ${msg}`)
}
function err(msg) {
  console.error(`\x1b[31m[watch ${ts()}]\x1b[0m ${msg}`)
}

let pendingTimer = null
let building = false
let rebuildQueued = false
let changedSinceLastBuild = new Set()

async function runBuild() {
  if (building) {
    rebuildQueued = true
    return
  }
  building = true
  const files = Array.from(changedSinceLastBuild)
  changedSinceLastBuild.clear()
  log(`Change detected (${files.length} file${files.length === 1 ? '' : 's'}). Rebuilding...`)
  files.slice(0, 5).forEach((f) => log(`  • ${path.relative(projectRoot, f)}`))
  if (files.length > 5) log(`  • ...and ${files.length - 5} more`)
  try {
    await deploy()
  } catch (e) {
    err(`Build failed: ${e.message}`)
  } finally {
    building = false
    if (rebuildQueued) {
      rebuildQueued = false
      log('Detected more changes during build, rebuilding again...')
      runBuild()
    } else {
      log('Watching for changes... (Ctrl-C to stop)')
    }
  }
}

function scheduleBuild(filePath) {
  changedSinceLastBuild.add(filePath)
  if (pendingTimer) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    runBuild()
  }, DEBOUNCE_MS)
}

const watcher = chokidar.watch(WATCH_PATHS, {
  ignored: IGNORED,
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 60 },
})

watcher.on('ready', () => {
  log(`Watching ${WATCH_PATHS.length} paths (debounce ${DEBOUNCE_MS}ms).`)
  log('Press Ctrl-C to stop. Save any file to trigger a Desktop rebuild.')
})

watcher.on('add', scheduleBuild)
watcher.on('change', scheduleBuild)
watcher.on('unlink', scheduleBuild)
watcher.on('error', (e) => err(`Watcher error: ${e.message}`))

const shutdown = () => {
  log('Stopping watcher.')
  watcher.close().finally(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
