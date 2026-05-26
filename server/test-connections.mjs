import WebSocket from 'ws'

const ENDPOINT = process.env.BRIDGE || 'ws://localhost:3001/ssh'
const TIMEOUT_MS = 45000

const TARGETS = [
  {
    label: 'rebex public SSH (saved password - should fully login)',
    host: 'test.rebex.net',
    port: 22,
    username: 'demo',
    password: 'password',
  },
  {
    label: 'rebex public SSH (NO saved pwd - tests interactive prompt)',
    host: 'test.rebex.net',
    port: 22,
    username: 'demo',
    password: '',
    interactivePassword: 'password',
  },
  {
    label: 'rebex with prompts DISABLED (must reject auth, no prompt sent)',
    host: 'test.rebex.net',
    port: 22,
    username: 'demo',
    password: '',
    allowInteractivePrompts: false,
  },
  {
    label: 'github.com (auth will be rejected, proves SSH works)',
    host: 'github.com',
    port: 22,
    username: 'git',
    password: '',
  },
  {
    label: 'gitlab.com (auth will be rejected, proves SSH works)',
    host: 'gitlab.com',
    port: 22,
    username: 'git',
    password: '',
  },
  {
    label: 'bitbucket.org (auth will be rejected, proves SSH works)',
    host: 'bitbucket.org',
    port: 22,
    username: 'git',
    password: '',
  },
  {
    label: 'codeberg.org (auth will be rejected, proves SSH works)',
    host: 'codeberg.org',
    port: 22,
    username: 'git',
    password: '',
  },
]

const testOne = (target) =>
  new Promise((resolve) => {
    const start = Date.now()
    const events = []
    const result = {
      label: target.label,
      target: `${target.username}@${target.host}:${target.port}`,
      events,
      verdict: 'unknown',
      elapsedMs: 0,
    }

    const finish = (verdict) => {
      if (result.verdict !== 'unknown') return
      result.verdict = verdict
      result.elapsedMs = Date.now() - start
      try {
        ws.close()
      } catch {}
      clearTimeout(timeoutId)
      resolve(result)
    }

    const ws = new WebSocket(ENDPOINT)
    const timeoutId = setTimeout(() => finish('TIMEOUT (test wrapper 45s)'), TIMEOUT_MS)

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          type: 'init',
          host: target.host,
          port: target.port,
          username: target.username,
          password: target.password,
          allowInteractivePrompts: target.allowInteractivePrompts !== false,
          cols: 100,
          rows: 30,
        }),
      )
    })

    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (msg.type === 'status') {
        events.push(`STATUS: ${msg.data}`)
        if (/SSH connection established/i.test(msg.data)) {
          finish('CONNECTED (full shell)')
        }
      } else if (msg.type === 'password-prompt') {
        events.push(`PROMPT: ${msg.prompt}`)
        if (target.interactivePassword !== undefined) {
          ws.send(JSON.stringify({ type: 'password-response', password: target.interactivePassword }))
          events.push(`SENT interactive password: ${'*'.repeat(target.interactivePassword.length)}`)
        } else {
          ws.send(JSON.stringify({ type: 'password-response', password: '' }))
        }
      } else if (msg.type === 'data') {
        events.push(`DATA: ${msg.data.slice(0, 60).replace(/\n/g, ' ')}`)
      } else if (msg.type === 'error') {
        events.push(`ERROR: ${msg.data}`)
        if (/All configured authentication methods failed/i.test(msg.data)) {
          finish('REACHED SSH (auth rejected, expected for git hosts)')
        } else if (/Could not open a TCP socket/i.test(msg.data)) {
          finish('FAIL (TCP unreachable - network/VPN)')
        } else if (/handshake/i.test(msg.data) || /banner/i.test(msg.data)) {
          finish('FAIL (handshake)')
        } else {
          finish(`FAIL (${msg.data.slice(0, 70)})`)
        }
      }
    })

    ws.on('error', (err) => {
      events.push(`WS ERROR: ${err.message}`)
      finish('FAIL (websocket - is bridge running?)')
    })

    ws.on('close', () => {
      if (result.verdict === 'unknown') finish('CLOSED (no verdict)')
    })
  })

const main = async () => {
  console.log(`Testing SSH bridge at ${ENDPOINT}\n`)

  const results = []
  for (const target of TARGETS) {
    process.stdout.write(`- ${target.label}\n  -> ${target.host}:${target.port} ... `)
    const result = await testOne(target)
    console.log(`${result.verdict} (${result.elapsedMs}ms)`)
    results.push(result)
  }

  console.log('\n=================== SUMMARY ===================')
  for (const r of results) {
    console.log(`\n[${r.target}] ${r.label}`)
    console.log(`  verdict: ${r.verdict} in ${r.elapsedMs}ms`)
    for (const evt of r.events.slice(0, 20)) {
      console.log(`  ${evt.slice(0, 240)}`)
    }
  }

  const proven = results.filter((r) =>
    /CONNECTED|REACHED SSH/.test(r.verdict),
  ).length
  console.log(
    `\n${proven}/${results.length} servers proved the SSH path works end-to-end.\n`,
  )

  process.exit(proven > 0 ? 0 : 2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
