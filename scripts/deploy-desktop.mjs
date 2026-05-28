#!/usr/bin/env node
/**
 * Rebuilds RemoteDeck (Vite + electron-builder) and refreshes the .app on the
 * user's Desktop. Used by both `npm run deploy:desktop` (one-shot) and by
 * `scripts/watch-deploy.mjs` (auto-deploy on file change).
 */
import { spawn } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const desktopApp = path.join(os.homedir(), 'Desktop', 'RemoteDeck.app')
const builtApp = path.join(projectRoot, 'release', 'mac-arm64', 'RemoteDeck.app')

function ts() {
  return new Date().toLocaleTimeString()
}
function log(msg) {
  console.log(`\x1b[36m[deploy ${ts()}]\x1b[0m ${msg}`)
}
function warn(msg) {
  console.warn(`\x1b[33m[deploy ${ts()}]\x1b[0m ${msg}`)
}
function err(msg) {
  console.error(`\x1b[31m[deploy ${ts()}]\x1b[0m ${msg}`)
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      cwd: projectRoot,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
      ...opts,
    })
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
    child.on('error', reject)
  })
}

async function killRunningApp() {
  return new Promise((resolve) => {
    const child = spawn('pkill', ['-f', 'RemoteDeck.app/Contents'], { stdio: 'ignore' })
    child.on('exit', () => resolve())
    child.on('error', () => resolve())
  })
}

export async function deploy({ skipBuild = false } = {}) {
  const started = Date.now()
  if (!skipBuild) {
    log('Building Vite frontend...')
    await run('npm', ['run', 'build'])
    log('Packaging Electron app (electron-builder --mac --dir)...')
    await run('npx', ['electron-builder', '--mac', '--dir'])
  }

  if (!existsSync(builtApp)) {
    throw new Error(`Packaged app not found at ${builtApp}`)
  }

  log('Stopping any running RemoteDeck instance...')
  await killRunningApp()
  // Give launch services a beat to release file locks
  await new Promise((r) => setTimeout(r, 400))

  log(`Replacing ${desktopApp}...`)
  await fs.rm(desktopApp, { recursive: true, force: true })
  await run('ditto', [builtApp, desktopApp])
  await run('xattr', ['-dr', 'com.apple.quarantine', desktopApp]).catch(() => {
    warn('xattr cleanup failed (non-fatal)')
  })

  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  log(`✅ Desktop app refreshed in ${elapsed}s.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deploy().catch((e) => {
    err(e.message)
    process.exit(1)
  })
}
