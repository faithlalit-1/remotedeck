import http from 'node:http'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import { Client as SSHClient } from 'ssh2'

const DEFAULT_KEY_CANDIDATES = [
  'id_ed25519',
  'id_ecdsa',
  'id_ecdsa_sk',
  'id_ed25519_sk',
  'id_rsa',
  'id_dsa',
]

const loadAllDefaultPrivateKeys = () => {
  const sshDir = path.join(os.homedir(), '.ssh')
  const found = []
  for (const filename of DEFAULT_KEY_CANDIDATES) {
    const candidate = path.join(sshDir, filename)
    try {
      if (fs.existsSync(candidate)) {
        found.push({ path: candidate, contents: fs.readFileSync(candidate) })
      }
    } catch {
      // ignore unreadable candidate
    }
  }
  return found
}

const detectSshAgent = () => {
  const sock = process.env.SSH_AUTH_SOCK
  if (sock && sock.length > 0) {
    try {
      if (fs.existsSync(sock)) return sock
    } catch {
      // ignore
    }
  }
  return null
}

const describeSshError = (err, tried = []) => {
  const msg = err?.message || String(err)
  const methods = tried.length ? ` (methods tried: ${tried.join(', ')})` : ''
  if (/All configured authentication methods failed/i.test(msg)) {
    return `${msg}${methods}. The server rejected every authentication method we tried. If \`ssh ${tried.includes('agent') ? '' : '-i ~/.ssh/id_rsa '}user@host\` works from your terminal, the same key/agent should work here. Otherwise set the correct Password or paste the Private key that the server trusts and click Save changes.`
  }
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) {
    return `${msg}. The hostname could not be resolved. Check DNS and that you are on the right network/VPN.`
  }
  if (/ECONNREFUSED/i.test(msg)) {
    return `${msg}. The host refused the connection. Check the port and that sshd is running.`
  }
  if (/Timed out while waiting for handshake/i.test(msg)) {
    return `${msg}. We could reach the port but did not receive an SSH banner in time. Common causes: you are not on the right VPN, a firewall is silently dropping packets, the host is not running sshd on this port, or another service is listening here. Try a different port, confirm VPN connectivity, or test reachability from a terminal: nc -vz <host> <port>.`
  }
  if (/ETIMEDOUT|timed out/i.test(msg)) {
    return `${msg}. The connection timed out. Check VPN / firewall rules.`
  }
  return msg
}

const probeTcp = (host, port, timeoutMs = 5000) =>
  new Promise((resolve) => {
    const socket = new net.Socket()
    const started = Date.now()
    let settled = false

    const done = (result) => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        // ignore
      }
      resolve({ ...result, elapsedMs: Date.now() - started })
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done({ ok: true }))
    socket.once('timeout', () => done({ ok: false, reason: `TCP connect timed out after ${timeoutMs}ms` }))
    socket.once('error', (err) => done({ ok: false, reason: err.message }))

    try {
      socket.connect(Number(port) || 22, host)
    } catch (err) {
      done({ ok: false, reason: err.message })
    }
  })

const PORT = Number(process.env.PORT) || 3001

const app = express()
app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'remotedeck-ssh-bridge', pid: process.pid })
})

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ssh' })

const safeSend = (ws, payload) => {
  if (ws.readyState !== ws.OPEN) return
  try {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
  } catch (error) {
    console.error('ws send failed:', error)
  }
}

wss.on('connection', (ws, req) => {
  console.log(`[ssh-bridge] client connected from ${req.socket.remoteAddress}`)

  let ssh = null
  let stream = null
  let initialized = false
  let pendingPasswordResolve = null

  const cleanup = (reason) => {
    if (pendingPasswordResolve) {
      const resolver = pendingPasswordResolve
      pendingPasswordResolve = null
      resolver(null)
    }
    if (stream) {
      try {
        stream.end()
      } catch {}
      stream = null
    }
    if (ssh) {
      try {
        ssh.end()
      } catch {}
      ssh = null
    }
    if (reason) {
      safeSend(ws, { type: 'status', data: reason })
    }
  }

  const askPasswordFromUser = (prompt) =>
    new Promise((resolve) => {
      pendingPasswordResolve = resolve
      safeSend(ws, { type: 'password-prompt', prompt })
    })

  ws.on('message', async (raw) => {
    let message
    try {
      message = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (message.type === 'password-response') {
      if (pendingPasswordResolve) {
        const resolver = pendingPasswordResolve
        pendingPasswordResolve = null
        resolver(typeof message.password === 'string' ? message.password : '')
      }
      return
    }

    if (message.type === 'tcp-check') {
      const { host, port } = message
      if (!host) {
        safeSend(ws, { type: 'tcp-check-result', ok: false, reason: 'host required' })
        return
      }
      const result = await probeTcp(host, port)
      safeSend(ws, {
        type: 'tcp-check-result',
        ok: result.ok,
        reason: result.reason,
        elapsedMs: result.elapsedMs,
        host,
        port: Number(port) || 22,
      })
      return
    }

    if (message.type === 'init' && !initialized) {
      initialized = true
      const {
        host,
        port,
        username,
        password,
        privateKey,
        passphrase,
        cols,
        rows,
        allowInteractivePrompts = true,
      } = message
      if (!host || !username) {
        safeSend(ws, { type: 'error', data: 'host and username are required' })
        ws.close()
        return
      }

      const agentSock = detectSshAgent()
      const userKey =
        privateKey && privateKey.trim()
          ? { path: 'user-provided key', contents: Buffer.from(privateKey) }
          : null
      const defaultKeys = loadAllDefaultPrivateKeys()

      const authPlan = []
      if (agentSock) authPlan.push({ method: 'agent', label: `agent (${agentSock})`, agent: agentSock })
      if (userKey) authPlan.push({ method: 'publickey', label: `publickey (${userKey.path})`, key: userKey.contents })
      for (const k of defaultKeys) {
        authPlan.push({ method: 'publickey', label: `publickey (${k.path})`, key: k.contents })
      }
      if (password) {
        authPlan.push({ method: 'password', label: 'password (saved)', password })
        authPlan.push({ method: 'keyboard-interactive', label: 'keyboard-interactive (saved)', password })
      }

      if (allowInteractivePrompts) {
        authPlan.push({
          method: 'interactive-password',
          label: 'password (interactive prompt)',
        })
        authPlan.push({
          method: 'interactive-keyboard',
          label: 'keyboard-interactive (interactive prompt)',
        })
      }

      const discoveryLines = [
        `SSH agent: ${agentSock ? agentSock : 'not detected (SSH_AUTH_SOCK not set or socket missing)'}`,
        `User-provided key: ${userKey ? 'yes' : 'no'}`,
        `Default keys discovered in ~/.ssh: ${defaultKeys.length === 0 ? 'NONE FOUND - check ~/.ssh for id_ed25519 / id_rsa / etc.' : defaultKeys.map((k) => path.basename(k.path)).join(', ')}`,
        `Password provided: ${password ? 'yes' : 'no'}`,
        `Interactive password prompts: ${allowInteractivePrompts ? 'ENABLED' : 'DISABLED (toggle in terminal toolbar)'}`,
      ]
      for (const line of discoveryLines) safeSend(ws, { type: 'status', data: line })

      safeSend(ws, {
        type: 'status',
        data: `Connecting to ${username}@${host}:${port || 22}. Auth attempt order: ${authPlan.map((p) => p.label).join(' -> ')}`,
      })

      const authMethodsTried = []

      const reachability = await probeTcp(host, port, 5000)
      if (!reachability.ok) {
        safeSend(ws, {
          type: 'error',
          data: `Could not open a TCP socket to ${host}:${port || 22} (${reachability.reason}). The bridge cannot reach the host. Check VPN, host/port, and firewall before attempting SSH.`,
        })
        ws.close()
        return
      }

      safeSend(ws, {
        type: 'status',
        data: `TCP socket to ${host}:${port || 22} opened in ${reachability.elapsedMs}ms. Starting SSH handshake (timeout 30s)...`,
      })

      ssh = new SSHClient()

      ssh
        .on('ready', () => {
          safeSend(ws, { type: 'status', data: 'SSH connection established.' })
          ssh.shell(
            { term: 'xterm-256color', cols: cols || 80, rows: rows || 24 },
            (err, sh) => {
              if (err) {
                safeSend(ws, { type: 'error', data: `Shell error: ${err.message}` })
                cleanup()
                return
              }
              stream = sh
              stream.on('data', (chunk) => safeSend(ws, { type: 'data', data: chunk.toString('utf-8') }))
              stream.stderr.on('data', (chunk) => safeSend(ws, { type: 'data', data: chunk.toString('utf-8') }))
              stream.on('close', () => {
                safeSend(ws, { type: 'status', data: '\r\n[session closed]\r\n' })
                cleanup()
                ws.close()
              })
            },
          )
        })
        .on('error', (err) => {
          safeSend(ws, { type: 'error', data: `SSH error: ${describeSshError(err, authMethodsTried)}` })
          cleanup()
          ws.close()
        })
        .on('end', () => {
          safeSend(ws, { type: 'status', data: 'SSH connection ended.' })
        })
        .on('close', () => {
          safeSend(ws, { type: 'status', data: 'SSH connection closed.' })
        })
        .on('keyboard-interactive', (_name, _instructions, _lang, _prompts, finish) => {
          finish([password || ''])
        })
        .connect({
          host,
          port: Number(port) || 22,
          username,
          agent: agentSock || undefined,
          agentForward: Boolean(agentSock),
          tryKeyboard: true,
          readyTimeout: 30000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          authHandler: (methodsLeft, _partialSuccess, callback) => {
            const isAllowed = (entry) => {
              if (!methodsLeft || !Array.isArray(methodsLeft)) return true
              if (entry.method === 'agent' || entry.method === 'publickey') return methodsLeft.includes('publickey')
              if (entry.method === 'password' || entry.method === 'interactive-password') return methodsLeft.includes('password')
              if (entry.method === 'keyboard-interactive' || entry.method === 'interactive-keyboard') return methodsLeft.includes('keyboard-interactive')
              return true
            }

            const tryNext = () => {
              while (authPlan.length) {
                const next = authPlan.shift()
                if (!isAllowed(next)) {
                  safeSend(ws, { type: 'status', data: `Skipping ${next.label} (server does not allow this method)` })
                  continue
                }
                authMethodsTried.push(next.label)
                safeSend(ws, { type: 'status', data: `Trying ${next.label}...` })

                if (next.method === 'agent') {
                  return callback({ type: 'agent', username, agent: next.agent })
                }
                if (next.method === 'publickey') {
                  return callback({
                    type: 'publickey',
                    username,
                    key: next.key,
                    passphrase: passphrase || undefined,
                  })
                }
                if (next.method === 'password') {
                  return callback({ type: 'password', username, password: next.password })
                }
                if (next.method === 'keyboard-interactive') {
                  return callback({
                    type: 'keyboard-interactive',
                    username,
                    prompt: (_name, _instructions, _lang, _prompts, finish) => {
                      finish([next.password || ''])
                    },
                  })
                }
                if (next.method === 'interactive-password' || next.method === 'interactive-keyboard') {
                  const promptText =
                    next.method === 'interactive-keyboard'
                      ? `${username}@${host}'s password (keyboard-interactive): `
                      : `${username}@${host}'s password: `
                  askPasswordFromUser(promptText).then((entered) => {
                    if (entered === null || entered === '') {
                      safeSend(ws, { type: 'status', data: 'Interactive prompt cancelled.' })
                      return tryNext()
                    }
                    if (next.method === 'interactive-password') {
                      return callback({ type: 'password', username, password: entered })
                    }
                    return callback({
                      type: 'keyboard-interactive',
                      username,
                      prompt: (_name, _instructions, _lang, _prompts, finish) => {
                        finish([entered])
                      },
                    })
                  })
                  return
                }
              }
              return callback(false)
            }

            tryNext()
          },
        })

      return
    }

    if (message.type === 'input' && stream) {
      stream.write(message.data ?? '')
      return
    }

    if (message.type === 'resize' && stream) {
      const cols = Number(message.cols) || 80
      const rows = Number(message.rows) || 24
      try {
        stream.setWindow(rows, cols, 0, 0)
      } catch (error) {
        console.warn('resize failed:', error)
      }
    }
  })

  ws.on('close', () => {
    console.log('[ssh-bridge] client disconnected')
    cleanup()
  })

  ws.on('error', (error) => {
    console.error('[ssh-bridge] ws error:', error)
    cleanup()
  })
})

server.listen(PORT, () => {
  console.log(`[ssh-bridge] listening on http://localhost:${PORT}`)
  console.log(`[ssh-bridge] websocket endpoint: ws://localhost:${PORT}/ssh`)
})
