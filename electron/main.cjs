'use strict'

const { app, BrowserWindow, shell, Menu, nativeImage, protocol } = require('electron')
const path = require('node:path')
const net = require('node:net')
const fs = require('node:fs/promises')
const { pathToFileURL } = require('node:url')

const isDev = !app.isPackaged
const SSH_BRIDGE_PORT = Number(process.env.REMOTEDECK_BRIDGE_PORT || 3001)
const APP_SCHEME = 'remotedeck'
const DIST_DIR = path.join(__dirname, '..', 'dist')
let mainWindow = null

const LOG_FILE = path.join(app.getPath('userData'), 'remotedeck.log')
function logToFile(...args) {
  const line = `[${new Date().toISOString()}] ` + args.map((a) => {
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ') + '\n'
  try {
    require('node:fs').appendFileSync(LOG_FILE, line)
  } catch {
    // ignore
  }
  try { console.log(...args) } catch {
    // ignore
  }
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
])

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.txt': 'text/plain',
}

function registerAppProtocol() {
  protocol.handle(APP_SCHEME, async (request) => {
    let relPath = '/'
    try {
      const url = new URL(request.url)
      relPath = decodeURIComponent(url.pathname || '/')
      if (relPath.endsWith('/')) relPath += 'index.html'
      const filePath = path.join(DIST_DIR, relPath)
      if (!filePath.startsWith(DIST_DIR)) {
        logToFile(`protocol forbid ${request.url}`)
        return new Response('Forbidden', { status: 403 })
      }
      const data = await fs.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mime = MIME_TYPES[ext] || 'application/octet-stream'
      logToFile(`protocol ok ${relPath} -> ${filePath} (${data.length}b, ${mime})`)
      return new Response(data, {
        status: 200,
        headers: { 'content-type': mime },
      })
    } catch (err) {
      logToFile(`protocol err ${request.url} relPath=${relPath} err=${err && err.message}`)
      return new Response('Not found', { status: 404 })
    }
  })
}

function getIconPath() {
  if (isDev) {
    return path.join(__dirname, '..', 'build', 'icon.png')
  }
  return path.join(process.resourcesPath, 'build', 'icon.png')
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.end()
      resolve(true)
    })
    socket.on('error', () => resolve(false))
    socket.setTimeout(300, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

async function startSshBridge() {
  if (await isPortListening(SSH_BRIDGE_PORT)) {
    console.log(`[remotedeck] SSH bridge already running on :${SSH_BRIDGE_PORT}`)
    return
  }

  process.env.PORT = String(SSH_BRIDGE_PORT)
  const serverEntry = path.join(__dirname, '..', 'server', 'index.mjs')
  try {
    await import(pathToFileURL(serverEntry).href)
    console.log(`[remotedeck] SSH bridge started in-process on :${SSH_BRIDGE_PORT}`)
  } catch (err) {
    console.error('[remotedeck] failed to start in-process SSH bridge:', err)
  }
}

async function waitForUrl(url, timeoutMs = 20000) {
  const start = Date.now()
  const target = new URL(url)
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise((resolve) => {
      const socket = net.connect(
        { host: target.hostname, port: Number(target.port) || 80 },
        () => {
          socket.end()
          resolve(true)
        },
      )
      socket.on('error', () => resolve(false))
      socket.setTimeout(400, () => {
        socket.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

async function createWindow() {
  const icon = nativeImage.createFromPath(getIconPath())
  if (process.platform === 'darwin' && !icon.isEmpty()) {
    try {
      app.dock?.setIcon(icon)
    } catch {
      // ignore
    }
  }

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0f172a',
    title: 'RemoteDeck',
    icon,
    show: false,
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  const showWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.isVisible()) {
      mainWindow.show()
      mainWindow.focus()
      logToFile('window shown')
    }
  }

  mainWindow.once('ready-to-show', showWindow)
  mainWindow.webContents.once('did-finish-load', () => setTimeout(showWindow, 50))
  setTimeout(showWindow, 1500)

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedURL) => {
    logToFile(`did-fail-load code=${code} description=${description} url=${validatedURL}`)
  })

  mainWindow.webContents.on('did-finish-load', () => {
    logToFile('did-finish-load')
  })

  mainWindow.webContents.on('dom-ready', () => {
    logToFile('dom-ready')
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logToFile('render-process-gone', details)
  })

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    logToFile(`preload-error path=${preloadPath} err=${error && error.message}`)
  })

  mainWindow.webContents.on('console-message', (event) => {
    try {
      const level = event.level
      const message = event.message
      const sourceId = event.sourceId
      const line = event.lineNumber
      logToFile(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    } catch (err) {
      logToFile('console-message handler err:', err && err.message)
    }
  })

  if (process.env.REMOTEDECK_DEVTOOLS === '1') {
    try {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    } catch (err) {
      logToFile('openDevTools err:', err && err.message)
    }
  }

  mainWindow.webContents.once('did-finish-load', async () => {
    try {
      const summary = await mainWindow.webContents.executeJavaScript(
        `({
          url: location.href,
          title: document.title,
          rootChildren: document.getElementById('root')?.children?.length ?? -1,
          bodyHtmlLen: document.body?.innerHTML?.length ?? 0,
        })`,
        true,
      )
      logToFile('renderer summary:', JSON.stringify(summary))
    } catch (err) {
      logToFile('summary err:', err && err.message)
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev) {
    const devUrl = process.env.REMOTEDECK_DEV_URL || 'http://localhost:5173'
    await waitForUrl(devUrl)
    await mainWindow.loadURL(devUrl)
  } else {
    const target = `${APP_SCHEME}://app/index.html`
    logToFile(`loading ${target} (dist=${DIST_DIR})`)
    try {
      await mainWindow.loadURL(target)
      logToFile('loadURL succeeded')
    } catch (err) {
      logToFile('loadURL failed:', err && err.stack ? err.stack : err)
    }
  }
}

function buildAppMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'close' }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  logToFile(`whenReady userData=${app.getPath('userData')}`)
  registerAppProtocol()
  buildAppMenu()
  await startSshBridge()
  await createWindow()

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
