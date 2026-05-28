# RemoteDeck

RemoteDeck is a cross-platform desktop **tabbed remote connection manager** inspired
by mRemoteNG. It is a Vite + React 19 application packaged as an Electron app, with
a bundled Node.js SSH bridge that turns SSH tabs into real interactive terminals
(xterm.js) talking to actual remote servers.

## Features

- Native desktop app for **macOS, Windows, and Linux** (Electron)
- Browser/dev mode also supported (`npm run dev`)
- Real, interactive **SSH sessions** via the bundled in-process SSH bridge
- **xterm.js** terminal with proper resize / PTY support
- Tabbed multi-session UI (right-click a tab: duplicate, close, close others)
- Right-click a connection in the sidebar to instantly duplicate it
- Create, edit, duplicate, delete and search remote server connection settings
- **Folder management** with collapse / expand and "delete" safety confirmation
- **Resizable side panels** (drag the gutters; double-click to reset)
- Hideable right inspector with auto-reopen on edit / new / duplicate
- Compact **hamburger menu** for app actions (saves vertical space for the terminal)
- Hover action chip with **Open / Dup / Del** that overlays the connection name
- Import **mRemoteNG** XML (`confCons.xml`) and RemoteDeck JSON
- Export all connections as JSON or mRemoteNG-style XML
- Persisted in `localStorage` (folders, collapsed state, panel widths, etc.)
- SSH auth chain: SSH agent → user-provided private key → all `~/.ssh/` defaults
  → saved password → interactive password / keyboard-interactive
- TCP reachability probe and rich error messages before SSH attempts

## Run in development

```bash
npm install
npm run dev          # Vite frontend + SSH bridge together
# or, in two terminals:
npm run dev:web      # frontend only (http://localhost:5173)
npm run server       # SSH bridge only (ws://localhost:3001/ssh)
```

## Run as a desktop app (development)

```bash
npm run electron:dev
```

This starts Vite + the SSH bridge and launches the Electron shell pointing at the
local dev server with hot-reload of the renderer.

## Build a distributable

```bash
npm run electron:build           # current platform
npm run electron:build:mac       # macOS (dmg/zip)
npm run electron:build:win       # Windows (nsis)
npm run electron:build:linux     # Linux (AppImage)
```

Built artifacts land in `release/`.

## Keep the Desktop launcher in sync with your code

The `.app` on your Desktop is a packaged build — it does **not** auto-update
when you edit code. Two helpers handle that:

```bash
npm run deploy:desktop     # one-shot: rebuild + replace ~/Desktop/RemoteDeck.app
npm run watch:desktop      # watch src/electron/server and auto-deploy on save
```

`watch:desktop` debounces changes (default 1500ms) so a rebuild only kicks off
after you stop typing, and queues a follow-up rebuild if you save again
during the in-flight build — so the Desktop icon always ends up reflecting
your latest commit. Each rebuild takes ~10-15 seconds.

For tighter inner-loop iteration while actively coding, prefer
`npm run electron:dev` — it runs the same Electron window against the live
Vite dev server with hot reload (sub-second updates, no repackaging).

## How the SSH terminal works

- Each SSH tab renders an xterm.js terminal.
- Clicking **Connect** opens a WebSocket to the local SSH bridge.
- The bridge uses [`ssh2`](https://github.com/mscdex/ssh2) to open a real SSH
  shell to the target server using the connection's host, port, username and
  password (or saved/typed private key + optional passphrase).
- All keystrokes, terminal output, and window resizes flow over the WebSocket.
- The bridge is hosted *inside the Electron main process* in production, so the
  packaged app needs no external Node.

> Non-SSH protocols (RDP, VNC, etc.) display the launch command that you can
> run with your OS's native client (e.g. `mstsc`, `vncviewer`). Embedding RDP
> or VNC in the browser would require additional services such as Apache
> Guacamole.

## Repository layout

```
electron/        Electron main process (CommonJS)
server/          Node SSH bridge (express + ws + ssh2)
src/             React 19 frontend (Vite + TypeScript)
build/           Icon used for all platforms
release/         Built artifacts (gitignored)
dist/            Vite build output (gitignored)
```

## Logs

In the packaged app, errors are written to:

- macOS: `~/Library/Application Support/RemoteDeck/remotedeck.log`
- Windows: `%APPDATA%/RemoteDeck/remotedeck.log`
- Linux: `~/.config/RemoteDeck/remotedeck.log`

Set `REMOTEDECK_DEVTOOLS=1` in the environment before launching to auto-open
Chrome DevTools.

## Notes

- mRemoteNG encrypted passwords are imported as stored in the XML file. They
  are not decrypted by RemoteDeck. Save the password again in the inspector
  if you want SSH auth to succeed.
- The SSH bridge listens only on `localhost:3001` (override with
  `REMOTEDECK_BRIDGE_PORT`). Do not expose this port to other networks.
