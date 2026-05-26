import type { ChangeEvent, FormEvent } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { SshTerminal } from './SshTerminal'
import { PasswordField } from './PasswordField'
import './App.css'

type ActiveDrag = { kind: 'sidebar' | 'inspector'; startX: number; startWidth: number } | null
let activeDrag: ActiveDrag = null

type Protocol = 'SSH' | 'RDP' | 'VNC' | 'Telnet' | 'HTTP' | 'HTTPS' | 'Custom'

type Connection = {
  id: string
  name: string
  group: string
  protocol: Protocol
  hostname: string
  port: string
  username: string
  password: string
  privateKey: string
  passphrase: string
  domain: string
  description: string
  color: string
  updatedAt: string
}

type ConnectionTab = {
  id: string
  connectionId: string
  title: string
  openedAt: string
  status: 'ready' | 'connected'
}

type DraftConnection = Omit<Connection, 'id' | 'updatedAt'>

type ContextMenuState = {
  tabId: string
  x: number
  y: number
} | null

const STORAGE_KEY = 'remotedeck.connections'
const FOLDERS_STORAGE_KEY = 'remotedeck.folders'
const DEFAULT_FOLDERS = ['General', 'Linux', 'Windows']

const DEFAULT_DRAFT: DraftConnection = {
  name: '',
  group: 'General',
  protocol: 'SSH',
  hostname: '',
  port: '22',
  username: '',
  password: '',
  privateKey: '',
  passphrase: '',
  domain: '',
  description: '',
  color: '#2f80ed',
}

const DEMO_CONNECTIONS: Connection[] = [
  {
    id: 'demo-ssh',
    name: 'Proxy Server',
    group: 'Linux',
    protocol: 'SSH',
    hostname: '10.0.4.130',
    port: '22',
    username: 'root',
    password: '',
    privateKey: '',
    passphrase: '',
    domain: '',
    description: 'Imported-style Linux jump host',
    color: '#31a354',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'demo-rdp-1',
    name: 'Exchange 1',
    group: 'Windows',
    protocol: 'RDP',
    hostname: 'exchange-01.local',
    port: '3389',
    username: 'administrator',
    password: '',
    privateKey: '',
    passphrase: '',
    domain: 'CORP',
    description: 'Remote desktop connection',
    color: '#2f80ed',
    updatedAt: new Date().toISOString(),
  },
  {
    id: 'demo-rdp-2',
    name: 'Exchange 2',
    group: 'Windows',
    protocol: 'RDP',
    hostname: 'exchange-02.local',
    port: '3389',
    username: 'administrator',
    password: '',
    privateKey: '',
    passphrase: '',
    domain: 'CORP',
    description: 'Second remote desktop target',
    color: '#9b51e0',
    updatedAt: new Date().toISOString(),
  },
]

const makeId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`

const defaultPortFor = (protocol: Protocol) => {
  switch (protocol) {
    case 'SSH':
      return '22'
    case 'RDP':
      return '3389'
    case 'VNC':
      return '5900'
    case 'Telnet':
      return '23'
    case 'HTTP':
      return '80'
    case 'HTTPS':
      return '443'
    default:
      return ''
  }
}

const normalizeProtocol = (protocol: string | null): Protocol => {
  const normalized = (protocol || 'SSH').toUpperCase()

  if (normalized.includes('SSH')) return 'SSH'
  if (normalized.includes('RDP')) return 'RDP'
  if (normalized.includes('VNC')) return 'VNC'
  if (normalized.includes('TELNET')) return 'Telnet'
  if (normalized === 'HTTP') return 'HTTP'
  if (normalized === 'HTTPS') return 'HTTPS'

  return 'Custom'
}

const connectionToDraft = (connection: Connection): DraftConnection => ({
  name: connection.name,
  group: connection.group,
  protocol: connection.protocol,
  hostname: connection.hostname,
  port: connection.port,
  username: connection.username,
  password: connection.password,
  privateKey: connection.privateKey || '',
  passphrase: connection.passphrase || '',
  domain: connection.domain,
  description: connection.description,
  color: connection.color,
})

const escapeAttribute = (value: string) =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const parseMRemoteNgXml = (xmlText: string): Connection[] => {
  const parser = new DOMParser()
  const xml = parser.parseFromString(xmlText, 'application/xml')

  if (xml.querySelector('parsererror')) {
    throw new Error('The selected XML file could not be parsed.')
  }

  const imported: Connection[] = []

  const visit = (element: Element, path: string[]) => {
    const isNode = element.localName.toLowerCase() === 'node'
    const type = element.getAttribute('Type') || element.getAttribute('type')
    const name = element.getAttribute('Name') || element.getAttribute('name') || 'Connection'
    const nextPath = isNode && type?.toLowerCase() === 'container' ? [...path, name] : path

    if (isNode && type?.toLowerCase() === 'connection') {
      const protocol = normalizeProtocol(element.getAttribute('Protocol'))
      imported.push({
        id: makeId(),
        name,
        group: path.join(' / ') || element.getAttribute('Panel') || 'Imported',
        protocol,
        hostname:
          element.getAttribute('Hostname') ||
          element.getAttribute('Host') ||
          element.getAttribute('Address') ||
          '',
        port: element.getAttribute('Port') || defaultPortFor(protocol),
        username: element.getAttribute('Username') || '',
        password: element.getAttribute('Password') || '',
        privateKey: '',
        passphrase: '',
        domain: element.getAttribute('Domain') || '',
        description: element.getAttribute('Description') || '',
        color: '#2f80ed',
        updatedAt: new Date().toISOString(),
      })
    }

    Array.from(element.children).forEach((child) => visit(child, nextPath))
  }

  visit(xml.documentElement, [])

  return imported
}

const exportMRemoteNgXml = (connections: Connection[]) => {
  const groups = connections.reduce<Record<string, Connection[]>>((currentGroups, connection) => {
    const group = connection.group || 'General'
    currentGroups[group] = currentGroups[group] || []
    currentGroups[group].push(connection)
    return currentGroups
  }, {})

  const nodes = Object.entries(groups)
    .map(([group, groupConnections]) => {
      const children = groupConnections
        .map((connection) => {
          const protocol = connection.protocol === 'SSH' ? 'SSH2' : connection.protocol
          return `    <Node Type="Connection" Name="${escapeAttribute(connection.name)}" Protocol="${escapeAttribute(protocol)}" Hostname="${escapeAttribute(connection.hostname)}" Port="${escapeAttribute(connection.port)}" Username="${escapeAttribute(connection.username)}" Password="${escapeAttribute(connection.password)}" Domain="${escapeAttribute(connection.domain)}" Description="${escapeAttribute(connection.description)}" Panel="${escapeAttribute(connection.group)}" />`
        })
        .join('\n')

      return `  <Node Type="Container" Name="${escapeAttribute(group)}" Expanded="true">\n${children}\n  </Node>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="utf-8"?>\n<Connections Name="Connections" Export="true">\n${nodes}\n</Connections>\n`
}

const buildLaunchCommand = (connection: Connection) => {
  const host = connection.hostname || '<host>'
  const port = connection.port || defaultPortFor(connection.protocol)
  const user = connection.username ? `${connection.username}@` : ''

  switch (connection.protocol) {
    case 'SSH':
      return `ssh ${user}${host}${port ? ` -p ${port}` : ''}`
    case 'RDP':
      return `mstsc /v:${host}${port ? `:${port}` : ''}`
    case 'VNC':
      return `vncviewer ${host}${port ? `:${port}` : ''}`
    case 'Telnet':
      return `telnet ${host}${port ? ` ${port}` : ''}`
    case 'HTTP':
      return `http://${host}${port && port !== '80' ? `:${port}` : ''}`
    case 'HTTPS':
      return `https://${host}${port && port !== '443' ? `:${port}` : ''}`
    default:
      return `${host}${port ? `:${port}` : ''}`
  }
}

const downloadFile = (filename: string, contents: string, type: string) => {
  const blob = new Blob([contents], { type })
  const href = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = href
  link.download = filename
  link.click()
  URL.revokeObjectURL(href)
}

function App() {
  const [connections, setConnections] = useState<Connection[]>(() => {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved ? (JSON.parse(saved) as Connection[]) : DEMO_CONNECTIONS
  })
  const [selectedId, setSelectedId] = useState(connections[0]?.id ?? '')
  const [draft, setDraft] = useState<DraftConnection>(() =>
    connections[0] ? connectionToDraft(connections[0]) : DEFAULT_DRAFT,
  )
  const [isCreating, setIsCreating] = useState(false)
  const [tabs, setTabs] = useState<ConnectionTab[]>([])
  const [activeTabId, setActiveTabId] = useState('')
  const [search, setSearch] = useState('')
  const [notice, setNotice] = useState('Ready')
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<string>('')
  const [deleteConfirmText, setDeleteConfirmText] = useState('')
  const [pendingPasswordSave, setPendingPasswordSave] = useState<{
    connectionId: string
    password: string
  } | null>(null)
  const [folders, setFolders] = useState<string[]>(() => {
    const saved = localStorage.getItem(FOLDERS_STORAGE_KEY)
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as string[]
        if (Array.isArray(parsed)) return parsed
      } catch {
        // fall through
      }
    }
    return DEFAULT_FOLDERS
  })
  const [showNewFolder, setShowNewFolder] = useState(false)
  const [newFolderName, setNewFolderName] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('remotedeck.collapsedFolders')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as string[]
        if (Array.isArray(parsed)) return new Set(parsed)
      } catch {
        // fall through
      }
    }
    return new Set()
  })
  const [deleteFolderName, setDeleteFolderName] = useState<string>('')
  const [deleteFolderConfirmText, setDeleteFolderConfirmText] = useState('')
  const SIDEBAR_MIN = 200
  const SIDEBAR_MAX = 560
  const INSPECTOR_MIN = 280
  const INSPECTOR_MAX = 640
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('remotedeck.sidebarWidth'))
    return Number.isFinite(saved) && saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 288
  })
  const [inspectorWidth, setInspectorWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('remotedeck.inspectorWidth'))
    return Number.isFinite(saved) && saved >= INSPECTOR_MIN && saved <= INSPECTOR_MAX ? saved : 352
  })
  const [inspectorVisible, setInspectorVisible] = useState<boolean>(() => {
    const saved = localStorage.getItem('remotedeck.inspectorVisible')
    return saved === null ? true : saved === 'true'
  })
  const [appMenuOpen, setAppMenuOpen] = useState(false)
  const appMenuToggleRef = useRef<HTMLButtonElement | null>(null)
  const [appMenuPos, setAppMenuPos] = useState<{ top: number; left: number } | null>(null)

  useEffect(() => {
    if (!appMenuOpen) return
    const updatePos = () => {
      const rect = appMenuToggleRef.current?.getBoundingClientRect()
      if (rect) setAppMenuPos({ top: rect.bottom + 6, left: rect.left })
    }
    updatePos()
    window.addEventListener('resize', updatePos)
    window.addEventListener('scroll', updatePos, true)
    return () => {
      window.removeEventListener('resize', updatePos)
      window.removeEventListener('scroll', updatePos, true)
    }
  }, [appMenuOpen])

  useEffect(() => {
    localStorage.setItem('remotedeck.inspectorVisible', String(inspectorVisible))
  }, [inspectorVisible])
  useEffect(() => {
    localStorage.setItem('remotedeck.sidebarWidth', String(sidebarWidth))
  }, [sidebarWidth])

  useEffect(() => {
    localStorage.setItem('remotedeck.inspectorWidth', String(inspectorWidth))
  }, [inspectorWidth])

  useEffect(() => {
    const handleMove = (event: MouseEvent) => {
      if (!activeDrag) return
      const delta = event.clientX - activeDrag.startX
      if (activeDrag.kind === 'sidebar') {
        const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, activeDrag.startWidth + delta))
        setSidebarWidth(next)
      } else {
        const next = Math.min(INSPECTOR_MAX, Math.max(INSPECTOR_MIN, activeDrag.startWidth - delta))
        setInspectorWidth(next)
      }
    }
    const handleUp = () => {
      if (activeDrag) {
        activeDrag = null
        document.body.classList.remove('is-resizing')
      }
    }
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [])

  const startResize = (kind: 'sidebar' | 'inspector') => (event: React.MouseEvent) => {
    event.preventDefault()
    activeDrag = {
      kind,
      startX: event.clientX,
      startWidth: kind === 'sidebar' ? sidebarWidth : inspectorWidth,
    }
    document.body.classList.add('is-resizing')
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(connections))
  }, [connections])

  useEffect(() => {
    localStorage.setItem(FOLDERS_STORAGE_KEY, JSON.stringify(folders))
  }, [folders])

  useEffect(() => {
    localStorage.setItem('remotedeck.collapsedFolders', JSON.stringify(Array.from(collapsedFolders)))
  }, [collapsedFolders])

  useEffect(() => {
    const closeMenu = () => setContextMenu(null)
    window.addEventListener('click', closeMenu)
    return () => window.removeEventListener('click', closeMenu)
  }, [])

  const selectedConnection = useMemo(
    () => connections.find((connection) => connection.id === selectedId),
    [connections, selectedId],
  )

  const activeTab = tabs.find((tab) => tab.id === activeTabId)
  const activeConnection = connections.find((connection) => connection.id === activeTab?.connectionId)

  const visibleConnections = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return connections

    return connections.filter((connection) =>
      [connection.name, connection.group, connection.hostname, connection.protocol]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [connections, search])

  const allFolders = useMemo(() => {
    const seen = new Set<string>()
    const result: string[] = []
    for (const name of folders) {
      const trimmed = name.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
    for (const connection of connections) {
      const trimmed = (connection.group || 'General').trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      result.push(trimmed)
    }
    return result
  }, [folders, connections])

  const groupedConnections = useMemo(() => {
    const groups: Record<string, Connection[]> = {}
    for (const folder of allFolders) groups[folder] = []
    for (const connection of visibleConnections) {
      const key = (connection.group || 'General').trim() || 'General'
      groups[key] = groups[key] || []
      groups[key].push(connection)
    }
    return groups
  }, [visibleConnections, allFolders])

  const toggleFolder = (name: string) => {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(name)) next.delete(name)
      else next.add(name)
      return next
    })
  }

  const expandAllFolders = () => setCollapsedFolders(new Set())
  const collapseAllFolders = () => setCollapsedFolders(new Set(allFolders))

  const createFolder = () => {
    const name = newFolderName.trim()
    if (!name) {
      setNotice('Folder name cannot be empty.')
      return
    }
    if (folders.some((f) => f.trim().toLowerCase() === name.toLowerCase())) {
      setNotice(`Folder "${name}" already exists.`)
      return
    }
    setFolders((current) => [...current, name])
    setShowNewFolder(false)
    setNewFolderName('')
    setNotice(`Folder "${name}" created.`)
  }

  const requestDeleteFolder = (name: string) => {
    setDeleteFolderName(name)
    setDeleteFolderConfirmText('')
  }

  const cancelDeleteFolder = () => {
    setDeleteFolderName('')
    setDeleteFolderConfirmText('')
  }

  const removeFolder = (name: string) => {
    if (deleteFolderConfirmText.trim().toLowerCase() !== 'delete') return
    const usedBy = connections.filter((connection) => (connection.group || 'General') === name).length
    if (usedBy > 0) {
      setNotice(`Cannot delete "${name}" - ${usedBy} connection${usedBy === 1 ? '' : 's'} still use it. Move them first.`)
      cancelDeleteFolder()
      return
    }
    setFolders((current) => current.filter((folder) => folder !== name))
    cancelDeleteFolder()
    setNotice(`Folder "${name}" deleted.`)
  }

  const selectConnection = (connection: Connection) => {
    setSelectedId(connection.id)
    setDraft(connectionToDraft(connection))
    setIsCreating(false)
    setInspectorVisible(true)
  }

  const startNewConnection = () => {
    setSelectedId('')
    setDraft(DEFAULT_DRAFT)
    setIsCreating(true)
    setInspectorVisible(true)
  }

  const updateDraft = (field: keyof DraftConnection, value: string) => {
    setDraft((current) => ({
      ...current,
      [field]: value,
      ...(field === 'protocol' ? { port: defaultPortFor(value as Protocol) } : {}),
    }))
  }

  const saveConnection = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (!draft.name.trim() || !draft.hostname.trim()) {
      setNotice('Name and host are required.')
      return
    }

    const nextConnection: Connection = {
      ...draft,
      id: isCreating ? makeId() : selectedId,
      name: draft.name.trim(),
      group: draft.group.trim() || 'General',
      hostname: draft.hostname.trim(),
      updatedAt: new Date().toISOString(),
    }

    setConnections((current) =>
      isCreating
        ? [...current, nextConnection]
        : current.map((connection) => (connection.id === selectedId ? nextConnection : connection)),
    )
    setSelectedId(nextConnection.id)
    setDraft(connectionToDraft(nextConnection))
    setIsCreating(false)
    setNotice(`${nextConnection.name} saved.`)
  }

  const handlePasswordTyped = (connectionId: string, typedPassword: string) => {
    const target = connections.find((connection) => connection.id === connectionId)
    if (!target || !typedPassword) return
    if (target.password === typedPassword) return
    setPendingPasswordSave({ connectionId, password: typedPassword })
  }

  const confirmSavePassword = () => {
    if (!pendingPasswordSave) return
    const { connectionId, password: newPassword } = pendingPasswordSave
    setConnections((current) =>
      current.map((connection) =>
        connection.id === connectionId
          ? { ...connection, password: newPassword, updatedAt: new Date().toISOString() }
          : connection,
      ),
    )
    setDraft((current) => (selectedId === connectionId ? { ...current, password: newPassword } : current))
    setNotice('Password saved to connection.')
    setPendingPasswordSave(null)
  }

  const dismissSavePassword = () => {
    setPendingPasswordSave(null)
  }

  const requestDeleteConnection = (connectionId: string) => {
    setDeleteTargetId(connectionId)
    setDeleteConfirmText('')
  }

  const cancelDeleteConnection = () => {
    setDeleteTargetId('')
    setDeleteConfirmText('')
  }

  const confirmDeleteConnection = () => {
    const target = connections.find((connection) => connection.id === deleteTargetId)
    if (!target) {
      cancelDeleteConnection()
      return
    }
    if (deleteConfirmText.trim().toLowerCase() !== 'delete') return

    setConnections((current) => current.filter((connection) => connection.id !== target.id))
    setTabs((current) => current.filter((tab) => tab.connectionId !== target.id))
    if (selectedId === target.id) {
      setSelectedId('')
      setDraft(DEFAULT_DRAFT)
      setIsCreating(true)
    }
    setNotice(`${target.name} deleted.`)
    cancelDeleteConnection()
  }

  const deleteTarget = connections.find((connection) => connection.id === deleteTargetId)

  const duplicateConnection = (sourceId: string) => {
    const source = connections.find((connection) => connection.id === sourceId)
    if (!source) return

    const existingCopies = connections.filter((connection) =>
      connection.name.startsWith(`${source.name} (copy`),
    ).length
    const suffix = existingCopies === 0 ? ' (copy)' : ` (copy ${existingCopies + 1})`

    const duplicated: Connection = {
      ...source,
      id: makeId(),
      name: `${source.name}${suffix}`,
      updatedAt: new Date().toISOString(),
    }

    setConnections((current) => [...current, duplicated])
    setSelectedId(duplicated.id)
    setDraft(connectionToDraft(duplicated))
    setIsCreating(false)
    setInspectorVisible(true)
    setNotice(`Duplicated ${source.name}.`)
  }

  const openConnectionTab = (connectionId: string) => {
    const connection = connections.find((item) => item.id === connectionId)
    if (!connection) return

    const sameConnectionCount = tabs.filter((tab) => tab.connectionId === connectionId).length
    const tab: ConnectionTab = {
      id: makeId(),
      connectionId,
      title: sameConnectionCount ? `${connection.name} (${sameConnectionCount + 1})` : connection.name,
      openedAt: new Date().toISOString(),
      status: 'ready',
    }

    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
    setNotice(`${connection.name} opened in a new tab.`)
  }

  const closeTab = (tabId: string) => {
    setTabs((current) => {
      const nextTabs = current.filter((tab) => tab.id !== tabId)
      if (activeTabId === tabId) {
        setActiveTabId(nextTabs.at(-1)?.id ?? '')
      }
      return nextTabs
    })
  }

  const duplicateTab = (tabId: string) => {
    const tab = tabs.find((item) => item.id === tabId)
    if (tab) openConnectionTab(tab.connectionId)
  }

  const closeOtherTabs = (tabId: string) => {
    setTabs((current) => current.filter((tab) => tab.id === tabId))
    setActiveTabId(tabId)
  }

  const importConnections = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      let imported: Connection[]

      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text) as Connection[] | { connections: Connection[] }
        imported = Array.isArray(parsed) ? parsed : parsed.connections
      } else {
        imported = parseMRemoteNgXml(text)
      }

      const cleaned = imported.map((connection) => ({
        ...DEFAULT_DRAFT,
        ...connection,
        id: makeId(),
        port: connection.port || defaultPortFor(connection.protocol),
        color: connection.color || '#2f80ed',
        updatedAt: new Date().toISOString(),
      }))

      setConnections((current) => [...current, ...cleaned])
      setNotice(`Imported ${cleaned.length} connection${cleaned.length === 1 ? '' : 's'} from ${file.name}.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Import failed.')
    } finally {
      event.target.value = ''
    }
  }

  const exportJson = () => {
    downloadFile(
      'connections.json',
      JSON.stringify({ exportedAt: new Date().toISOString(), connections }, null, 2),
      'application/json',
    )
  }

  const exportXml = () => {
    downloadFile('mremote-connections.xml', exportMRemoteNgXml(connections), 'application/xml')
  }

  return (
    <main className="shell">
      {appMenuOpen &&
        createPortal(
          <div
            className="app-menu-backdrop"
            onClick={() => setAppMenuOpen(false)}
            aria-hidden="true"
          />,
          document.body,
        )}

      <section
        className="workspace"
        style={{
          gridTemplateColumns: inspectorVisible
            ? `${sidebarWidth}px 6px minmax(320px, 1fr) 6px ${inspectorWidth}px`
            : `${sidebarWidth}px 6px minmax(320px, 1fr)`,
        }}
      >
        <aside className="sidebar">
          <div className="panel-header">
            <span>Connections</span>
            <div className="panel-header-actions">
              <button
                type="button"
                title="Expand all folders"
                onClick={expandAllFolders}
              >
                Expand
              </button>
              <button
                type="button"
                title="Collapse all folders"
                onClick={collapseAllFolders}
              >
                Collapse
              </button>
              <button type="button" onClick={() => setShowNewFolder(true)} title="Create a new folder">
                + Folder
              </button>
              <span className="panel-count">{connections.length}</span>
            </div>
          </div>
          <input
            className="search"
            placeholder="Search host, name, protocol..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />

          <div className="connection-tree">
            {Object.entries(groupedConnections).map(([group, items]) => {
              const isCollapsed = collapsedFolders.has(group) && !search.trim()
              return (
              <section className="connection-group" key={group}>
                <header className="connection-group-header">
                  <button
                    type="button"
                    className="connection-group-toggle"
                    onClick={() => toggleFolder(group)}
                    title={isCollapsed ? `Expand ${group}` : `Collapse ${group}`}
                    aria-expanded={!isCollapsed}
                  >
                    <span className={`chevron ${isCollapsed ? 'chevron-right' : 'chevron-down'}`} aria-hidden="true" />
                    <h2>{group}</h2>
                  </button>
                  <div className="connection-group-actions">
                    <span className="connection-group-count">{items.length}</span>
                    <button
                      type="button"
                      title={`Add a connection to ${group}`}
                      onClick={() => {
                        setSelectedId('')
                        setDraft({ ...DEFAULT_DRAFT, group })
                        setIsCreating(true)
                        setInspectorVisible(true)
                      }}
                    >
                      +
                    </button>
                    {items.length === 0 && (
                      <button
                        type="button"
                        className="danger"
                        title={`Delete empty folder ${group}`}
                        onClick={() => requestDeleteFolder(group)}
                      >
                        x
                      </button>
                    )}
                  </div>
                </header>
                {!isCollapsed && items.length === 0 && (
                  <p className="connection-group-empty">No connections in this folder yet.</p>
                )}
                {!isCollapsed &&
                  items.map((connection) => (
                    <div
                      className={`connection-item ${selectedId === connection.id ? 'selected' : ''}`}
                      key={connection.id}
                      onClick={() => selectConnection(connection)}
                      onDoubleClick={() => openConnectionTab(connection.id)}
                      onContextMenu={(event) => {
                        event.preventDefault()
                        selectConnection(connection)
                        duplicateConnection(connection.id)
                      }}
                    >
                      <span className="connection-color" style={{ background: connection.color }} />
                      <span className="connection-item-body">
                        <strong>{connection.name}</strong>
                        <small>
                          {connection.protocol} · {connection.hostname || 'No host'}
                        </small>
                      </span>
                      <span className="connection-item-actions">
                        <button
                          type="button"
                          title="Open in new tab"
                          onClick={(event) => {
                            event.stopPropagation()
                            openConnectionTab(connection.id)
                          }}
                        >
                          Open
                        </button>
                        <button
                          type="button"
                          title="Duplicate this connection"
                          onClick={(event) => {
                            event.stopPropagation()
                            duplicateConnection(connection.id)
                          }}
                        >
                          Dup
                        </button>
                        <button
                          type="button"
                          className="danger"
                          title="Delete this connection"
                          onClick={(event) => {
                            event.stopPropagation()
                            requestDeleteConnection(connection.id)
                          }}
                        >
                          Del
                        </button>
                      </span>
                    </div>
                  ))}
              </section>
              )
            })}
          </div>
        </aside>

        <div
          className="resizer resizer-vertical"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize connections panel"
          onMouseDown={startResize('sidebar')}
          onDoubleClick={() => setSidebarWidth(288)}
          title="Drag to resize · double-click to reset"
        />

        <section className="stage">
          <nav className="tab-strip" aria-label="Open connection tabs">
            <div className="app-menu-wrapper">
              <button
                ref={appMenuToggleRef}
                type="button"
                className={`app-menu-toggle ${appMenuOpen ? 'is-open' : ''}`}
                title="Open menu"
                aria-label="Open menu"
                aria-expanded={appMenuOpen}
                onClick={() => setAppMenuOpen((open) => !open)}
              >
                <span />
                <span />
                <span />
              </button>
            </div>
            {appMenuOpen && appMenuPos &&
              createPortal(
                <div
                  className="app-menu"
                  role="menu"
                  style={{ top: appMenuPos.top, left: appMenuPos.left }}
                >
                  <div className="app-menu-brand">
                    <span className="app-menu-eyebrow">REMOTEDECK</span>
                    <span className="app-menu-title">Tabbed Remote Connection Manager</span>
                  </div>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAppMenuOpen(false)
                      startNewConnection()
                    }}
                  >
                    New connection
                  </button>
                  <label className="app-menu-file">
                    Import…
                    <input
                      accept=".json,.xml,.confCons"
                      type="file"
                      onChange={(event) => {
                        setAppMenuOpen(false)
                        importConnections(event)
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAppMenuOpen(false)
                      exportJson()
                    }}
                  >
                    Export JSON
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAppMenuOpen(false)
                      exportXml()
                    }}
                  >
                    Export mRemoteNG XML
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setAppMenuOpen(false)
                      setInspectorVisible((v) => !v)
                    }}
                  >
                    {inspectorVisible ? 'Hide settings panel' : 'Show settings panel'}
                  </button>
                </div>,
                document.body,
              )}
            {tabs.length === 0 ? (
              <span className="empty-tabs">Double-click a connection to open a tab.</span>
            ) : (
              tabs.map((tab) => (
                <button
                  className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTabId(tab.id)}
                  onContextMenu={(event) => {
                    event.preventDefault()
                    setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY })
                  }}
                >
                  <span>{tab.title}</span>
                  <small>{tab.status}</small>
                  <span
                    className="tab-close"
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      event.stopPropagation()
                      closeTab(tab.id)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') closeTab(tab.id)
                    }}
                  >
                    x
                  </span>
                </button>
              ))
            )}
          </nav>

          <div className="session-area">
            {activeConnection && activeTab ? (
              <article className="session-card">
                <div className="session-title">
                  <div>
                    <p className="eyebrow">{activeConnection.protocol} session</p>
                    <h2>{activeConnection.name}</h2>
                  </div>
                  <div className="session-title-actions">
                    <button type="button" onClick={() => duplicateTab(activeTab.id)}>
                      Duplicate tab
                    </button>
                    <button type="button" onClick={() => closeTab(activeTab.id)}>
                      Close tab
                    </button>
                  </div>
                </div>

                {activeConnection.protocol === 'SSH' ? (
                  <SshTerminal
                    sessionKey={activeTab.id}
                    host={activeConnection.hostname}
                    port={activeConnection.port}
                    username={activeConnection.username}
                    password={activeConnection.password}
                    privateKey={activeConnection.privateKey}
                    passphrase={activeConnection.passphrase}
                    onPasswordTyped={(typed) => handlePasswordTyped(activeConnection.id, typed)}
                  />
                ) : (
                  <div className="terminal">
                    <p>
                      Live remote sessions are currently supported for the SSH protocol via the
                      bundled bridge. For {activeConnection.protocol}, use the launch command in
                      your OS's native client:
                    </p>
                    <p className="terminal-command">{buildLaunchCommand(activeConnection)}</p>
                    <p>Host: {activeConnection.hostname}</p>
                    <p>User: {activeConnection.username || 'not configured'}</p>
                    <span className="cursor" />
                  </div>
                )}

              </article>
            ) : (
              <article className="welcome">
                <h2>Open multiple remote tabs</h2>
                <p>
                  Double-click a saved connection to open a tab. Right-click a tab for actions
                  (open another, close, close others). For SSH connections the terminal is fully
                  interactive once the local SSH bridge is running.
                </p>
                <p className="welcome-hint">
                  Start the bridge with <code>npm run dev</code> (runs frontend + SSH bridge
                  together) or <code>npm run server</code> in another terminal.
                </p>
              </article>
            )}
          </div>
        </section>

        {inspectorVisible && (
        <div
          className="resizer resizer-vertical"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize connection settings panel"
          onMouseDown={startResize('inspector')}
          onDoubleClick={() => setInspectorWidth(352)}
          title="Drag to resize · double-click to reset"
        />
        )}

        {inspectorVisible && (
        <aside className="inspector">
          <div className="panel-header">
            <span>{isCreating ? 'New connection' : 'Connection settings'}</span>
            <div className="panel-header-actions">
              {selectedConnection && (
                <>
                  <button type="button" onClick={() => openConnectionTab(selectedConnection.id)}>
                    Open
                  </button>
                  <button type="button" onClick={() => duplicateConnection(selectedConnection.id)}>
                    Duplicate
                  </button>
                </>
              )}
              <button
                type="button"
                className="panel-close"
                title="Hide settings panel"
                aria-label="Hide settings panel"
                onClick={() => setInspectorVisible(false)}
              >
                ×
              </button>
            </div>
          </div>

          <form className="settings-form" onSubmit={saveConnection}>
            <label>
              Name
              <input value={draft.name} onChange={(event) => updateDraft('name', event.target.value)} />
            </label>
            <label>
              Folder
              <div className="folder-picker">
                <select
                  value={allFolders.includes(draft.group) ? draft.group : '__custom__'}
                  onChange={(event) => {
                    const value = event.target.value
                    if (value === '__new__') {
                      setShowNewFolder(true)
                      return
                    }
                    if (value === '__custom__') return
                    updateDraft('group', value)
                  }}
                >
                  {!allFolders.includes(draft.group) && draft.group && (
                    <option value="__custom__">{draft.group} (custom)</option>
                  )}
                  {allFolders.map((folder) => (
                    <option key={folder} value={folder}>
                      {folder}
                    </option>
                  ))}
                  <option value="__new__">+ Create new folder...</option>
                </select>
              </div>
            </label>
            <label>
              Protocol
              <select
                value={draft.protocol}
                onChange={(event) => updateDraft('protocol', event.target.value)}
              >
                <option>SSH</option>
                <option>RDP</option>
                <option>VNC</option>
                <option>Telnet</option>
                <option>HTTP</option>
                <option>HTTPS</option>
                <option>Custom</option>
              </select>
            </label>
            <label>
              Hostname/IP
              <input
                value={draft.hostname}
                onChange={(event) => updateDraft('hostname', event.target.value)}
              />
            </label>
            <label>
              Port
              <input value={draft.port} onChange={(event) => updateDraft('port', event.target.value)} />
            </label>
            <label>
              Username
              <input
                autoComplete="username"
                value={draft.username}
                onChange={(event) => updateDraft('username', event.target.value)}
              />
            </label>
            <label>
              Password
              <PasswordField
                value={draft.password}
                onChange={(value) => updateDraft('password', value)}
                autoComplete="current-password"
              />
            </label>
            <label>
              Private key (optional)
              <textarea
                className="key-input"
                placeholder="Paste OpenSSH private key (-----BEGIN OPENSSH PRIVATE KEY----- ...)"
                value={draft.privateKey}
                onChange={(event) => updateDraft('privateKey', event.target.value)}
              />
            </label>
            <label className="file-button file-button-inline">
              Load key from file
              <input
                accept=".pem,.key,.pub,*"
                type="file"
                onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  try {
                    const text = await file.text()
                    updateDraft('privateKey', text)
                    setNotice(`Loaded private key from ${file.name}.`)
                  } catch {
                    setNotice('Failed to read key file.')
                  } finally {
                    event.target.value = ''
                  }
                }}
              />
            </label>
            <label>
              Key passphrase (optional)
              <PasswordField
                value={draft.passphrase}
                onChange={(value) => updateDraft('passphrase', value)}
                autoComplete="new-password"
              />
            </label>
            <label>
              Domain
              <input value={draft.domain} onChange={(event) => updateDraft('domain', event.target.value)} />
            </label>
            <label>
              Accent color
              <input
                className="color-input"
                type="color"
                value={draft.color}
                onChange={(event) => updateDraft('color', event.target.value)}
              />
            </label>
            <label>
              Description
              <textarea
                value={draft.description}
                onChange={(event) => updateDraft('description', event.target.value)}
              />
            </label>

            <div className="form-actions">
              <button type="submit">{isCreating ? 'Create' : 'Save changes'}</button>
              {!isCreating && selectedConnection && (
                <button
                  className="danger"
                  type="button"
                  onClick={() => requestDeleteConnection(selectedConnection.id)}
                >
                  Delete
                </button>
              )}
            </div>

            <p className="hint">
              mRemoteNG XML imports preserve connection attributes. Encrypted passwords are imported
              as stored and are not decrypted by this browser prototype.
            </p>
          </form>
        </aside>
        )}
      </section>

      <footer className="statusbar">
        <span>{notice}</span>
        <span>{tabs.length} open tab(s)</span>
      </footer>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" onClick={() => duplicateTab(contextMenu.tabId)}>
            Duplicate tab
          </button>
          <button type="button" onClick={() => closeTab(contextMenu.tabId)}>
            Close tab
          </button>
          <button type="button" onClick={() => closeOtherTabs(contextMenu.tabId)}>
            Close other tabs
          </button>
        </div>
      )}

      {showNewFolder && (
        <div className="modal-backdrop" onClick={() => setShowNewFolder(false)}>
          <div
            className="modal modal-info"
            role="dialog"
            aria-modal="true"
            aria-labelledby="new-folder-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="new-folder-title">Create new folder</h2>
            <p>Folders group connections in the left sidebar (for example PA, GA, Linux, Windows).</p>
            <input
              autoFocus
              placeholder="Folder name (e.g. PA, GA, Production)"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') createFolder()
                if (event.key === 'Escape') {
                  setShowNewFolder(false)
                  setNewFolderName('')
                }
              }}
            />
            <div className="modal-actions">
              <button
                type="button"
                onClick={() => {
                  setShowNewFolder(false)
                  setNewFolderName('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="primary"
                disabled={!newFolderName.trim()}
                onClick={createFolder}
              >
                Create folder
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteFolderName && (
        <div className="modal-backdrop" onClick={cancelDeleteFolder}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-folder-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-folder-title">Delete folder</h2>
            <p>
              You are about to permanently delete the folder{' '}
              <strong>{deleteFolderName}</strong>. This action cannot be undone.
            </p>
            <p className="modal-instruction">
              Type <code>delete</code> below to confirm.
            </p>
            <input
              autoFocus
              value={deleteFolderConfirmText}
              onChange={(event) => setDeleteFolderConfirmText(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  deleteFolderConfirmText.trim().toLowerCase() === 'delete'
                ) {
                  removeFolder(deleteFolderName)
                }
                if (event.key === 'Escape') cancelDeleteFolder()
              }}
              placeholder="Type 'delete' to confirm"
            />
            <div className="modal-actions">
              <button type="button" onClick={cancelDeleteFolder}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={deleteFolderConfirmText.trim().toLowerCase() !== 'delete'}
                onClick={() => removeFolder(deleteFolderName)}
              >
                Delete folder permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingPasswordSave && (() => {
        const target = connections.find((c) => c.id === pendingPasswordSave.connectionId)
        if (!target) return null
        return (
          <div className="modal-backdrop" onClick={dismissSavePassword}>
            <div
              className="modal modal-info"
              role="dialog"
              aria-modal="true"
              aria-labelledby="save-password-title"
              onClick={(event) => event.stopPropagation()}
            >
              <h2 id="save-password-title">Save password?</h2>
              <p>
                You connected to <strong>{target.name}</strong>
                {target.hostname ? ` (${target.username}@${target.hostname})` : ''} using a password
                you typed in the terminal. Save it to this connection so future tabs connect
                automatically?
              </p>
              <p className="modal-instruction">
                The password is stored in your browser's local storage (same place as your other
                saved connection settings). It is not encrypted.
              </p>
              <div className="modal-actions">
                <button type="button" onClick={dismissSavePassword}>
                  Not now
                </button>
                <button type="button" className="primary" onClick={confirmSavePassword} autoFocus>
                  Save password
                </button>
              </div>
            </div>
          </div>
        )
      })()}

      {deleteTarget && (
        <div className="modal-backdrop" onClick={cancelDeleteConnection}>
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-modal-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-modal-title">Delete connection</h2>
            <p>
              You are about to permanently delete{' '}
              <strong>{deleteTarget.name}</strong>
              {deleteTarget.hostname ? ` (${deleteTarget.hostname})` : ''}. This action cannot be
              undone.
            </p>
            <p className="modal-instruction">
              Type <code>delete</code> below to confirm.
            </p>
            <input
              autoFocus
              value={deleteConfirmText}
              onChange={(event) => setDeleteConfirmText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && deleteConfirmText.trim().toLowerCase() === 'delete') {
                  confirmDeleteConnection()
                }
                if (event.key === 'Escape') cancelDeleteConnection()
              }}
              placeholder="Type 'delete' to confirm"
            />
            <div className="modal-actions">
              <button type="button" onClick={cancelDeleteConnection}>
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={deleteConfirmText.trim().toLowerCase() !== 'delete'}
                onClick={confirmDeleteConnection}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
