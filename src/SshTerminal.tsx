import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'

type IncomingMessage =
  | { type: 'data'; data: string }
  | { type: 'status'; data: string }
  | { type: 'error'; data: string }
  | { type: 'password-prompt'; prompt: string }
  | { type: 'tcp-check-result'; ok: boolean; reason?: string; elapsedMs: number; host: string; port: number }

type SshTerminalProps = {
  sessionKey: string
  host: string
  port: string
  username: string
  password: string
  privateKey?: string
  passphrase?: string
  endpoint?: string
  onPasswordTyped?: (password: string) => void
}

type Status = 'idle' | 'connecting' | 'connected' | 'error' | 'closed'

const DEFAULT_ENDPOINT = 'ws://localhost:3001/ssh'

export function SshTerminal({
  sessionKey,
  host,
  port,
  username,
  password,
  privateKey,
  passphrase,
  endpoint = DEFAULT_ENDPOINT,
  onPasswordTyped,
}: SshTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const onDataDisposableRef = useRef<{ dispose: () => void } | null>(null)
  const [status, setStatus] = useState<Status>('idle')
  const [statusText, setStatusText] = useState('Ready to connect.')
  const [elapsedMs, setElapsedMs] = useState(0)
  const elapsedTimerRef = useRef<number | null>(null)
  const passwordPromptRef = useRef<{ buffer: string; active: boolean }>({ buffer: '', active: false })
  const lastTypedPasswordRef = useRef<string>('')
  const [allowInteractivePrompts, setAllowInteractivePrompts] = useState(true)
  const allowInteractivePromptsRef = useRef(true)
  useEffect(() => {
    allowInteractivePromptsRef.current = allowInteractivePrompts
  }, [allowInteractivePrompts])

  const stopElapsedTimer = () => {
    if (elapsedTimerRef.current !== null) {
      window.clearInterval(elapsedTimerRef.current)
      elapsedTimerRef.current = null
    }
  }

  const startElapsedTimer = () => {
    stopElapsedTimer()
    setElapsedMs(0)
    const startedAt = Date.now()
    elapsedTimerRef.current = window.setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)
  }

  useEffect(() => {
    if (!hostRef.current) return

    const term = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      fontSize: 13,
      theme: {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#22c55e',
      },
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new WebLinksAddon())
    term.open(hostRef.current)
    fit.fit()

    terminalRef.current = term
    fitRef.current = fit

    const handleResize = () => {
      try {
        fit.fit()
        if (wsRef.current?.readyState === WebSocket.OPEN && terminalRef.current) {
          wsRef.current.send(
            JSON.stringify({
              type: 'resize',
              cols: terminalRef.current.cols,
              rows: terminalRef.current.rows,
            }),
          )
        }
      } catch {
        // ignore resize failures
      }
    }
    window.addEventListener('resize', handleResize)

    let resizeObserver: ResizeObserver | null = null
    const hostElement = hostRef.current
    if (typeof ResizeObserver !== 'undefined' && hostElement) {
      resizeObserver = new ResizeObserver(() => {
        handleResize()
      })
      resizeObserver.observe(hostElement)
    }

    return () => {
      window.removeEventListener('resize', handleResize)
      resizeObserver?.disconnect()
      stopElapsedTimer()
      try {
        onDataDisposableRef.current?.dispose()
      } catch {
        // ignore
      }
      try {
        wsRef.current?.close()
      } catch {
        // ignore socket close errors
      }
      onDataDisposableRef.current = null
      term.dispose()
      terminalRef.current = null
      fitRef.current = null
      wsRef.current = null
    }
  }, [sessionKey])

  const connect = () => {
    const term = terminalRef.current
    if (!term) return

    try {
      onDataDisposableRef.current?.dispose()
    } catch {
      // ignore
    }
    onDataDisposableRef.current = null
    try {
      wsRef.current?.close()
    } catch {
      // ignore close errors when reconnecting
    }

    setStatus('connecting')
    setStatusText(`Connecting to ${username}@${host}:${port || 22}...`)
    startElapsedTimer()
    lastTypedPasswordRef.current = ''
    term.clear()
    term.writeln(`\x1b[36mConnecting to ${username}@${host}:${port || 22}...\x1b[0m`)

    let ws: WebSocket
    try {
      ws = new WebSocket(endpoint)
    } catch (error) {
      setStatus('error')
      setStatusText(error instanceof Error ? error.message : 'WebSocket failed')
      return
    }

    wsRef.current = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          type: 'init',
          host,
          port: Number(port) || 22,
          username,
          password,
          privateKey: privateKey || '',
          passphrase: passphrase || '',
          cols: term.cols,
          rows: term.rows,
          allowInteractivePrompts: allowInteractivePromptsRef.current,
        }),
      )
    }

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as IncomingMessage
        if (message.type === 'data') {
          term.write(message.data)
        } else if (message.type === 'status') {
          term.writeln(`\x1b[33m${message.data}\x1b[0m`)
          if (message.data.toLowerCase().includes('established')) {
            stopElapsedTimer()
            setStatus('connected')
            setStatusText('Connected')
            if (lastTypedPasswordRef.current && onPasswordTyped) {
              const typed = lastTypedPasswordRef.current
              lastTypedPasswordRef.current = ''
              onPasswordTyped(typed)
            }
          }
        } else if (message.type === 'error') {
          term.writeln(`\x1b[31m${message.data}\x1b[0m`)
          stopElapsedTimer()
          setStatus('error')
          setStatusText(message.data)
        } else if (message.type === 'password-prompt') {
          if (!allowInteractivePromptsRef.current) {
            term.writeln(`\r\n\x1b[31mPassword prompt blocked: 'Password input' toggle is OFF. Click it in the toolbar to enable, then reconnect.\x1b[0m`)
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'password-response', password: '' }))
            }
            return
          }
          passwordPromptRef.current = { buffer: '', active: true }
          term.write(`\r\n\x1b[36m${message.prompt}\x1b[0m`)
          term.focus()
          setStatusText('Awaiting password (type in the terminal and press Enter)...')
        }
      } catch {
        // ignore unparseable messages
      }
    }

    ws.onerror = () => {
      term.writeln('\x1b[31mWebSocket error. Is the SSH bridge running on port 3001?\x1b[0m')
      stopElapsedTimer()
      setStatus('error')
      setStatusText('WebSocket error')
    }

    ws.onclose = () => {
      stopElapsedTimer()
      passwordPromptRef.current = { buffer: '', active: false }
      setStatus((prev) => (prev === 'error' ? 'error' : 'closed'))
      setStatusText((prev) => (status === 'error' ? prev : 'Session closed'))
      term.writeln('\x1b[90m[disconnected]\x1b[0m')
    }

    onDataDisposableRef.current = term.onData((data) => {
      if (passwordPromptRef.current.active) {
        for (const ch of data) {
          const code = ch.charCodeAt(0)
          if (ch === '\r' || ch === '\n') {
            const submitted = passwordPromptRef.current.buffer
            passwordPromptRef.current = { buffer: '', active: false }
            term.write('\r\n')
            term.writeln(`\x1b[90m[password sent, ${submitted.length} chars]\x1b[0m`)
            if (submitted) lastTypedPasswordRef.current = submitted
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'password-response', password: submitted }))
            }
            setStatusText('Password submitted, awaiting server response...')
            return
          }
          if (ch === '\u0003') {
            passwordPromptRef.current = { buffer: '', active: false }
            term.write('^C\r\n')
            lastTypedPasswordRef.current = ''
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'password-response', password: '' }))
            }
            setStatusText('Password prompt cancelled.')
            return
          }
          if (code === 127 || ch === '\b') {
            if (passwordPromptRef.current.buffer.length > 0) {
              passwordPromptRef.current.buffer = passwordPromptRef.current.buffer.slice(0, -1)
            }
            continue
          }
          if (code >= 32) {
            passwordPromptRef.current.buffer += ch
          }
        }
        return
      }

      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }))
      }
    })
  }

  const disconnect = () => {
    stopElapsedTimer()
    try {
      wsRef.current?.close()
    } catch {
      // ignore close errors
    }
    setStatus('closed')
    setStatusText('Disconnected')
  }

  const testReachability = () => {
    const term = terminalRef.current
    if (!term) return

    term.writeln(`\x1b[36mProbing TCP ${host}:${port || 22}...\x1b[0m`)

    const probe = new WebSocket(endpoint)
    probe.onopen = () => {
      probe.send(JSON.stringify({ type: 'tcp-check', host, port: Number(port) || 22 }))
    }
    probe.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string) as IncomingMessage
        if (message.type === 'tcp-check-result') {
          if (message.ok) {
            term.writeln(
              `\x1b[32mReachable. TCP socket opened to ${message.host}:${message.port} in ${message.elapsedMs}ms.\x1b[0m`,
            )
          } else {
            term.writeln(
              `\x1b[31mUnreachable: ${message.reason} (after ${message.elapsedMs}ms)\x1b[0m`,
            )
          }
          probe.close()
        }
      } catch {
        // ignore
      }
    }
    probe.onerror = () => {
      term.writeln('\x1b[31mWebSocket error during reachability check.\x1b[0m')
    }
  }

  const connectingLabel = status === 'connecting' ? `Connecting (${(elapsedMs / 1000).toFixed(1)}s)...` : 'Connect'

  const sshEquivalent = `ssh ${username || '<user>'}@${host || '<host>'}${port && port !== '22' ? ` -p ${port}` : ''}`

  return (
    <div className="ssh-terminal">
      <div className="ssh-terminal-banner">
        <div className="ssh-banner-grid">
          <div>
            <span>Server</span>
            <strong>{host || '—'}</strong>
          </div>
          <div>
            <span>User</span>
            <strong>{username || '—'}</strong>
          </div>
          <div>
            <span>Port</span>
            <strong>{port || '22'}</strong>
          </div>
        </div>
        <code className="ssh-banner-command" title="Equivalent terminal command">
          {sshEquivalent}
        </code>
      </div>
      <div className="ssh-terminal-toolbar">
        <span className={`ssh-status ssh-status-${status}`}>{statusText}</span>
        <div className="ssh-terminal-actions">
          <button
            type="button"
            className={`toggle ${allowInteractivePrompts ? 'toggle-on' : 'toggle-off'}`}
            onClick={() => setAllowInteractivePrompts((current) => !current)}
            title={
              allowInteractivePrompts
                ? 'Interactive password prompts are enabled. Click to disable.'
                : 'Interactive password prompts are disabled. Click to enable.'
            }
          >
            Password input: {allowInteractivePrompts ? 'ON' : 'OFF'}
          </button>
          <button type="button" onClick={testReachability} title="Probe TCP socket to host:port">
            Test reachability
          </button>
          {status === 'connected' ? (
            <button type="button" onClick={disconnect}>
              Disconnect
            </button>
          ) : (
            <button type="button" onClick={connect}>
              {connectingLabel}
            </button>
          )}
        </div>
      </div>
      <div className="ssh-terminal-host" ref={hostRef} />
    </div>
  )
}
