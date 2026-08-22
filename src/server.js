import { createServer as httpServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { EventCollector, MAIN_ID } from './collector.js'
import { scanCatalog } from './scan.js'
import { attachQueueWatcher } from './queue.js'
import { queueFile, portFile, notesFile } from './paths.js'
import { loadOffices, addOffice, removeOffice } from './offices.js'
import { installHooks, uninstallHooks, installedHooks } from './settings.js'

const readAsset = (name) => {
  const here = dirname(fileURLToPath(import.meta.url))
  return readFileSync(join(here, '..', 'dashboard', name), 'utf8')
}

const STATIC = {
  '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/map.js': { file: 'map.js', type: 'text/javascript; charset=utf-8' }
}

const SDK_DESKS = ['d1', 'd2', 'd3', 'd4', 'd5']
const MAIN_DESK = 'maindesk'
const SDK_PERMISSION = process.env.AGENTWATCH_PERMISSION || 'bypassPermissions'
const STALE_MS = 3 * 60 * 1000

function appendEvent(root, event) {
  const file = queueFile(root)
  try {
    mkdirSync(dirname(file), { recursive: true })
  } catch {}
  appendFileSync(file, JSON.stringify(event) + '\n')
}

function officeHtml(prefix) {
  let html = readAsset('index.html')
  if (prefix) {
    html = html
      .replace('href="/style.css"', `href="${prefix}/style.css"`)
      .replace('src="/app.js"', `src="${prefix}/app.js"`)
  }
  return html.replace('</head>', `<script>window.AGW_PREFIX=${JSON.stringify(prefix)}</script></head>`)
}

function mapHtml() {
  return readAsset('map.html')
}

function json(res, code, data) {
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024
const MAX_TRANSCRIPT_MESSAGES = 500

const MAX_NOTES = 50
const NOTE_TITLE_MAX = 120
const NOTE_TEXT_MAX = 4000
const OFFICE_W = 960
const OFFICE_H = 540

const clampNum = (v, min, max) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, Math.round(n)))
}

function readNotes(project) {
  try {
    const data = JSON.parse(readFileSync(notesFile(project), 'utf8'))
    return Array.isArray(data.notes) ? data.notes : []
  } catch {
    return []
  }
}

function writeNotes(project, notes) {
  try {
    mkdirSync(dirname(notesFile(project)), { recursive: true })
    writeFileSync(notesFile(project), JSON.stringify({ notes }, null, 2))
  } catch {}
}

const cap = (s, n) => {
  s = String(s ?? '')
  return s.length > n ? s.slice(0, n) + '…' : s
}

function transcriptBlocks(content, toolById) {
  const blocks = []
  if (typeof content === 'string') {
    const t = content.trim()
    if (t) blocks.push({ type: 'text', text: cap(t, 10000) })
    return blocks
  }
  for (const b of Array.isArray(content) ? content : []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: cap(b.text, 10000) })
    else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: cap(b.thinking, 400) })
    else if (b.type === 'tool_use' && b.name) {
      blocks.push({ type: 'tool_use', id: b.id, name: b.name, input: cap(JSON.stringify(b.input ?? {}), 2000) })
      if (b.id) toolById.set(b.id, b.name)
    } else if (b.type === 'tool_result') {
      const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '')
      blocks.push({ type: 'tool_result', toolName: toolById.get(b.tool_use_id) || null, content: cap(raw, 2000) })
    }
  }
  return blocks
}

async function readTranscript(path, pending) {
  try {
    const st = await stat(path)
    if (st.size > MAX_TRANSCRIPT_BYTES) return { found: false, error: 'transcript too large' }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        found: false,
        error: pending
          ? 'transcript not available yet — it appears once the agent starts writing its first message'
          : 'no transcript recorded for this agent — it may have ended before writing one, or its session file may have moved'
      }
    }
    return { found: false, error: 'unreadable transcript' }
  }
  let data
  try {
    data = await readFile(path, 'utf8')
  } catch {
    return { found: false, error: 'unreadable transcript' }
  }
  const messages = []
  const toolById = new Map()
  for (const line of data.split('\n')) {
    if (!line.trim()) continue
    let entry
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!entry || typeof entry !== 'object' || entry.isMeta === true) continue
    const type = entry.type
    const msg = entry.message || {}
    if (type === 'user') {
      const blocks = transcriptBlocks(msg.content, toolById)
      const pure = blocks.filter((b) => b.type !== 'tool_result')
      if (pure.length) messages.push({ role: 'user', blocks: pure })
      for (const r of blocks.filter((b) => b.type === 'tool_result')) {
        messages.push({ role: 'tool_result', toolName: r.toolName, content: r.content })
      }
    } else if (type === 'assistant') {
      const blocks = transcriptBlocks(msg.content, toolById)
      if (blocks.length) messages.push({ role: 'assistant', blocks })
    }
  }
  if (messages.length > MAX_TRANSCRIPT_MESSAGES) messages.splice(0, messages.length - MAX_TRANSCRIPT_MESSAGES)
  return { found: true, path, messages }
}

const DOC_SKIP = new Set(['node_modules', '.git', '.agentwatch', 'dist', 'build', '.next'])
const MAX_DOC_BYTES = 1024 * 1024
const FILE_SKIP = new Set(['node_modules', '.git', '.agentwatch', '.claude', 'dist', 'build', '.next', 'coverage', 'vendor', 'target', 'out'])

async function listDir(project, parts) {
  const dir = join(project, ...parts)
  const entries = []
  let items
  try {
    items = await readdir(dir, { withFileTypes: true })
  } catch {
    return { path: parts.join('/') || '.', parent: parts.slice(0, -1).join('/') || '', entries: [] }
  }
  for (const e of items) {
    if (e.name.startsWith('.')) continue
    if (FILE_SKIP.has(e.name)) continue
    const rel = [...parts, e.name].join('/')
    let size = 0
    if (e.isFile()) {
      try {
        size = (await stat(join(dir, e.name))).size
      } catch {}
    }
    entries.push({
      name: e.name,
      path: rel,
      type: e.isDirectory() ? 'dir' : 'file',
      size
    })
  }
  entries.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  )
  return { path: parts.join('/') || '.', parent: parts.slice(0, -1).join('/') || '', entries }
}

async function listStories(project) {
  const dir = join(project, 'docs', 'stories')
  let files
  try {
    files = await readdir(dir)
  } catch {
    return []
  }
  const stories = []
  for (const name of files) {
    if (!name.endsWith('.md')) continue
    if (name === '_TEMPLATE.md' || name === 'README.md') continue
    const full = join(dir, name)
    let src
    try {
      const st = await stat(full)
      if (st.size > MAX_DOC_BYTES) continue
      src = await readFile(full, 'utf8')
    } catch {
      continue
    }
    const title = src.match(/^#\s+(.+)$/m)
    const status = src.match(/^status:\s*(\S+)/m)
    const lane = src.match(/^lane:\s*(\S+)/m)
    stories.push({
      file: name,
      title: title ? title[1].replace(/^Story:\s*/i, '') : name.replace(/\.md$/, ''),
      status: status ? status[1] : 'unknown',
      lane: lane ? lane[1] : ''
    })
  }
  return stories.sort((a, b) => a.file.localeCompare(b.file))
}

async function findDoc(project, name) {
  const wanted = String(name || '').replace(/\\/g, '/').replace(/^\/+/, '').split('/').filter(Boolean)
  if (!wanted.length || wanted.some((s) => s === '..')) return { found: false, searched: project }
  const target = wanted[wanted.length - 1].toLowerCase()
  const relPath = wanted.join('/')
  const matches = []
  async function walk(dir, depth) {
    if (depth > 6) return
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name.startsWith('.') || DOC_SKIP.has(e.name)) continue
        await walk(full, depth + 1)
      } else if (e.name.toLowerCase() === target) {
        matches.push(full)
      }
    }
  }
  await walk(project, 0)
  const depthOf = (p) => relative(project, p).split(/[\\/]/).length
  const exact = matches.find((p) => relative(project, p).replace(/\\/g, '/') === relPath)
  const file = exact || matches.sort((a, b) => depthOf(a) - depthOf(b))[0]
  if (!file) return { found: false, searched: project }
  try {
    const st = await stat(file)
    if (st.size > MAX_DOC_BYTES) return { found: false, searched: project, error: 'file too large' }
    const content = await readFile(file, 'utf8')
    if (content.includes('\0')) return { found: false, path: relative(project, file), error: 'binary file — no preview' }
    return { found: true, path: relative(project, file), content }
  } catch {
    return { found: false, searched: project }
  }
}

const execFileP = promisify(execFile)

const GIT_HEADINGS = {
  'M': 'modified',
  'A': 'added',
  'D': 'deleted',
  'R': 'renamed',
  'C': 'copied',
  'T': 'type changed',
  'U': 'unmerged',
  '?': 'untracked'
}

async function gitStatus(project) {
  try {
    const { stdout } = await execFileP('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: project,
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024
    })
    const files = []
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue
      const code = line.slice(0, 2)
      let path = line.slice(3)
      if (code[0] === 'R' || code[0] === 'C') {
        const m = path.match(/^(.*) -> (.*)$/)
        if (m) path = m[2]
      }
      const key = code[1] === ' ' ? (code[0] || '?') : (code[1] || code[0] || '?')
      files.push({ code, path, kind: GIT_HEADINGS[key] || key })
    }
    return { ok: true, files }
  } catch (err) {
    return { ok: false, error: String((err && err.stderr || err && err.message) || err).trim() }
  }
}

async function repoUrl(project) {
  try {
    const { stdout } = await execFileP('git', ['remote', 'get-url', 'origin'], {
      cwd: project,
      timeout: 5000,
      maxBuffer: 64 * 1024
    })
    let url = stdout.trim().replace(/\.git$/, '')
    if (/^git@/.test(url)) url = url.replace(/^git@([^:]+):/, 'https://$1/')
    else if (url.startsWith('ssh://')) url = url.replace(/^ssh:\/\/([^@]+@)?/, 'https://')
    else if (url.startsWith('git://')) url = url.replace(/^git:\/\//, 'https://')
    return { ok: true, url }
  } catch (err) {
    return { ok: false, error: String((err && err.stderr || err && err.message) || err).trim() }
  }
}

export function startServer({ collector, project, catalog, onRescan, onStop, onGetHooks, defaultPort = 4579 }) {
  const primary = {
    id: 'project',
    name: basename(project) || project,
    project,
    collector,
    catalog,
    seats: new Map(),
    pendingAsks: new Map(),
    clients: new Set(),
    rescan: onRescan || (() => catalog),
    getHooks: onGetHooks || (() => []),
    watcher: null
  }
  return createApp({
    mode: 'single',
    primary,
    onStop,
    defaultPort
  })
}

async function chooseProjectDirectory() {
  if (process.platform !== 'darwin') {
    const err = new Error('directory picker is currently available on macOS only')
    err.code = 'UNSUPPORTED_PLATFORM'
    throw err
  }
  try {
    const { stdout } = await execFileP('osascript', [
      '-e',
      'POSIX path of (choose folder with prompt "Choose the project directory")'
    ], { timeout: 120000, maxBuffer: 64 * 1024 })
    const selected = stdout.trim()
    return selected === '/' ? selected : selected.replace(/\/$/, '')
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || err)
    if (detail.includes('User canceled') || detail.includes('(-128)')) return null
    throw err
  }
}

export function startHubServer({ runnerPath = null, askRunnerPath = null, hooksEnabled = true, onStop = null, defaultPort = 4579, pickDirectory = chooseProjectDirectory } = {}) {
  return createApp({
    mode: 'hub',
    runnerPath,
    askRunnerPath,
    hooksEnabled,
    onStop,
    defaultPort,
    pickDirectory
  })
}

function createApp({ mode, primary = null, runnerPath = null, askRunnerPath = null, hooksEnabled = true, onStop = null, defaultPort = 4579, pickDirectory = null }) {
  const contexts = new Map()
  const usageTicks = new Map()
  let port = defaultPort

  if (mode === 'single' && primary) contexts.set(primary.id, primary)

  const broadcastTo = (ctx, kind, data) => {
    const frame = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`
    for (const client of ctx.clients) {
      try {
        client.write(frame)
      } catch {
        ctx.clients.delete(client)
      }
    }
  }

  const notifyEvent = (record) => {
    const ctx = mode === 'single' ? primary : contexts.get(record && record.officeId)
    if (ctx) broadcastTo(ctx, 'event', record)
  }

  function handleAskCreate(ctx, body, res) {
    const id = String(body.id || '').trim()
    const question = String(body.question || '').trim()
    if (!id || !question) {
      json(res, 400, { error: 'id and question required' })
      return
    }
    const ask = {
      id,
      sessionId: String(body.sessionId || ''),
      agentId: String(body.agentId || 'main'),
      agentType: String(body.agentType || 'main'),
      question,
      header: String(body.header || ''),
      options: Array.isArray(body.options) ? body.options.map(String).slice(0, 5) : [],
      answer: null,
      createdAt: Date.now()
    }
    ctx.pendingAsks.set(id, ask)
    if (ctx.pendingAsks.size > 50) ctx.pendingAsks.delete(ctx.pendingAsks.keys().next().value)
    broadcastTo(ctx, 'ask', { kind: 'asked', ...ask })
    json(res, 200, { ok: true })
  }

  function handleAskPoll(ctx, url, res) {
    const id = url.searchParams.get('id') || ''
    const ask = ctx.pendingAsks.get(id)
    if (!ask || ask.answer == null) {
      json(res, 200, { answered: false })
      return
    }
    json(res, 200, { answered: true, option: ask.answer })
    ctx.pendingAsks.delete(id)
  }

  function handleAskAnswer(ctx, body, res) {
    const id = String(body.id || '').trim()
    const option = String(body.option || '').trim()
    const ask = ctx.pendingAsks.get(id)
    if (!ask) {
      json(res, 404, { error: 'unknown question' })
      return
    }
    if (!option) {
      json(res, 400, { error: 'option required' })
      return
    }
    ask.answer = option
    broadcastTo(ctx, 'ask', { kind: 'answered', id, option })
    json(res, 200, { ok: true })
  }

  function handleNotesSave(ctx, body, res) {
    const notes = readNotes(ctx.project)
    const title = String(body.title ?? '').slice(0, NOTE_TITLE_MAX)
    const text = String(body.text ?? '').slice(0, NOTE_TEXT_MAX)
    const x = clampNum(body.x, 0, OFFICE_W - 40)
    const y = clampNum(body.y, 0, OFFICE_H - 30)
    const id = String(body.id || '').trim()
    let note = id ? notes.find((n) => n.id === id) : null
    if (note) {
      Object.assign(note, { title, text, x, y, updatedAt: Date.now() })
    } else {
      note = {
        id: 'note-' + randomUUID().slice(0, 8),
        title,
        text,
        x,
        y,
        hue: Math.floor(Math.random() * 360),
        createdAt: Date.now(),
        updatedAt: Date.now()
      }
      notes.push(note)
      if (notes.length > MAX_NOTES) notes.splice(0, notes.length - MAX_NOTES)
    }
    writeNotes(ctx.project, notes)
    broadcastTo(ctx, 'notes', { notes })
    json(res, 200, { ok: true, note })
  }

  function handleNotesDelete(ctx, body, res) {
    const id = String(body.id || '').trim()
    if (!id) {
      json(res, 400, { error: 'id required' })
      return
    }
    const notes = readNotes(ctx.project).filter((n) => n.id !== id)
    writeNotes(ctx.project, notes)
    broadcastTo(ctx, 'notes', { notes })
    json(res, 200, { ok: true })
  }

  const ctxForProject = (p) => {
    const want = resolve(String(p || ''))
    for (const ctx of contexts.values()) {
      if (resolve(ctx.project) === want) return ctx
    }
    return null
  }

  function stopContext(ctx) {
    try {
      if (ctx.watcher) ctx.watcher.close()
    } catch {}
    const tick = usageTicks.get(ctx.id)
    if (tick) {
      clearInterval(tick)
      usageTicks.delete(ctx.id)
    }
    for (const client of ctx.clients) {
      try {
        client.end()
      } catch {}
    }
    ctx.clients.clear()
  }

  function buildContext(entry) {
    const root = resolve(entry.path)
    const collector = new EventCollector()
    const ctx = {
      id: entry.id,
      name: entry.name,
      project: root,
      collector,
      catalog: scanCatalog(root),
      seats: new Map(),
      pendingAsks: new Map(),
      clients: new Set(),
      watcher: null,
      rescan: () => {
        ctx.catalog = scanCatalog(root)
        return ctx.catalog
      },
      getHooks: () => installedHooks(root)
    }
    ctx.watcher = attachQueueWatcher({
      queuePath: queueFile(root),
      collector,
      onRecord: (record) => broadcastTo(ctx, 'event', record)
    })
    const tick = setInterval(() => {
      for (const record of collector.pollTranscripts()) {
        broadcastTo(ctx, 'event', record)
      }
      broadcastTo(ctx, 'usage', collector.usageSummary())
    }, 5000)
    tick.unref()
    usageTicks.set(ctx.id, tick)
    return ctx
  }

  function syncOffices() {
    const registered = new Map(loadOffices().map((o) => [o.id, o]))
    for (const [id, ctx] of contexts) {
      if (!registered.has(id)) {
        stopContext(ctx)
        contexts.delete(id)
      }
    }
    for (const [id, entry] of registered) {
      if (!contexts.has(id)) contexts.set(id, buildContext(entry))
    }
  }

  const ensureContext = (id) => {
    if (mode === 'single') return primary
    let ctx = contexts.get(id)
    if (!ctx) {
      const entry = loadOffices().find((o) => o.id === id)
      if (!entry) return null
      ctx = buildContext(entry)
      contexts.set(id, ctx)
    }
    return ctx
  }

  const officeSummary = (ctx) => {
    const evs = ctx.collector.events
    const last = evs.length ? evs[evs.length - 1].ts : null
    return {
      id: ctx.id,
      name: ctx.name,
      path: ctx.project,
      agents: ctx.catalog.agents.length,
      skills: ctx.catalog.skills.length,
      running: ctx.collector.runningAgents().length,
      events: evs.length,
      lastActivity: last,
      hooks: ctx.getHooks().length > 0,
      seats: ctx.seats.size,
      url: `/office/${ctx.id}`
    }
  }

  function serverState(ctx) {
    return {
      project: ctx.project,
      catalog: ctx.catalog,
      collector: ctx.collector.snapshot(),
      seats: [...ctx.seats.values()].map((s) => ({
        sessionKey: s.key,
        agentType: s.agentType,
        desk: s.desk,
        history: s.history,
        contextUsage: s.contextUsage || null
      })),
      asks: [...ctx.pendingAsks.values()].filter((a) => a.answer == null)
    }
  }

  function seatChat(ctx, key, kind, extra = {}) {
    broadcastTo(ctx, 'chat', { sessionKey: key, kind, ...extra })
  }

  async function runSeat(ctx, seat, message) {
    try {
      const { query } = await import('@anthropic-ai/claude-agent-sdk')
      const options = {
        cwd: ctx.project,
        permissionMode: SDK_PERMISSION,
        env: {
          ...process.env,
          AGENTWATCH_SDK: '1',
          AGENTWATCH_SDK_KEY: seat.key,
          AGENTWATCH_SDK_TYPE: seat.agentType
        }
      }
      if (SDK_PERMISSION === 'bypassPermissions') options.allowDangerouslySkipPermissions = true
      if (seat.sessionId) options.resume = seat.sessionId
      const stream = query({ prompt: message, options })
      seat.q = stream
      for await (const msg of stream) {
        if (msg.session_id && !seat.sessionId) seat.sessionId = msg.session_id
        if (msg.type === 'assistant') {
          if (msg.context_usage) {
            seat.contextUsage = msg.context_usage
            seatChat(ctx, seat.key, 'context', { context: msg.context_usage })
          }
          for (const block of (msg.message && msg.message.content) || []) {
            if (block.type === 'text' && block.text) {
              seat.history.push({ role: 'assistant', text: block.text })
              seatChat(ctx, seat.key, 'assistant', { text: block.text })
            } else if (block.type === 'tool_use') {
              seatChat(ctx, seat.key, 'tool', { toolName: block.name })
            }
          }
        } else if (msg.type === 'result') {
          seat.history.push({ role: 'done', text: msg.result })
          seatChat(ctx, seat.key, 'done', { durationMs: msg.duration_ms })
          ctx.collector.addUsage({ costUsd: msg.total_cost_usd, usage: msg.usage, perModel: msg.modelUsage })
          broadcastTo(ctx, 'usage', ctx.collector.usageSummary())
        }
      }
    } catch (err) {
      const message = String((err && err.message) || err)
      seat.history.push({ role: 'error', text: message })
      seatChat(ctx, seat.key, 'error', { error: message })
    } finally {
      seat.busy = false
      seat.q = null
      seatChat(ctx, seat.key, 'idle')
    }
  }

  function handleOfficeRequest(ctx, rest, req, res, url) {
    if (rest === '/' || rest === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(officeHtml(mode === 'single' ? '' : `/office/${ctx.id}`))
      return
    }

    const staticFile = STATIC[rest]
    if (staticFile) {
      try {
        const body = readAsset(staticFile.file)
        res.writeHead(200, { 'content-type': staticFile.type })
        res.end(body)
      } catch {
        json(res, 404, { error: 'not found' })
      }
      return
    }

    if (rest === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      })
      res.write(`event: snapshot\ndata: ${JSON.stringify(serverState(ctx))}\n\n`)
      const keepAlive = setInterval(() => {
        res.write(': ping\n\n')
      }, 25000)
      ctx.clients.add(res)
      req.on('close', () => {
        clearInterval(keepAlive)
        ctx.clients.delete(res)
      })
      return
    }

    if (rest === '/api/state') {
      json(res, 200, serverState(ctx))
      return
    }

    if (rest === '/api/hooks') {
      json(res, 200, { hooks: ctx.getHooks() })
      return
    }

    if (rest === '/api/doc') {
      findDoc(ctx.project, url.searchParams.get('name'))
        .then((doc) => json(res, 200, doc))
        .catch((err) => json(res, 500, { found: false, error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/files') {
      const rel = String(url.searchParams.get('path') || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
      const parts = rel.split('/').filter(Boolean)
      if (parts.some((s) => s === '..' || s === '.')) {
        json(res, 400, { error: 'invalid path' })
        return
      }
      listDir(ctx.project, parts)
        .then((data) => json(res, 200, data))
        .catch((err) => json(res, 500, { error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/git') {
      gitStatus(ctx.project)
        .then((data) => json(res, 200, data))
        .catch((err) => json(res, 500, { ok: false, error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/repo-url') {
      repoUrl(ctx.project)
        .then((data) => json(res, 200, data))
        .catch((err) => json(res, 500, { ok: false, error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/docs-check' && req.method === 'GET') {
      Promise.all([findDoc(ctx.project, 'prd.md'), findDoc(ctx.project, 'architecture.md')])
        .then(([prd, architecture]) => json(res, 200, {
          prd: { found: prd.found, path: prd.path || null },
          architecture: { found: architecture.found, path: architecture.path || null }
        }))
        .catch((err) => json(res, 500, { error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/transcript' && req.method === 'GET') {
      const agentId = String(url.searchParams.get('agent') || '')
      const agent = agentId && ctx.collector.agents.get(agentId)
      let path = agent ? ctx.collector.transcriptPathFor(agentId) : null
      if (!path && agentId && agentId !== MAIN_ID) path = ctx.collector.subagentTranscriptPath(agentId)
      if (!path) {
        if (!agent) {
          json(res, 404, { found: false, error: 'unknown agent — no session data for this id' })
          return
        }
        const pending = agent.status === 'running' || agent.status === 'started'
        json(res, 200, {
          found: false,
          error: pending
            ? 'transcript not available yet — it appears once the agent starts writing its first message'
            : 'no transcript tracked for this agent'
        })
        return
      }
      const pending = agent && (agent.status === 'running' || agent.status === 'started')
      readTranscript(path, pending)
        .then((data) => json(res, 200, data))
        .catch((err) => json(res, 500, { found: false, error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/stories') {
      listStories(ctx.project)
        .then((stories) => json(res, 200, { stories }))
        .catch((err) => json(res, 500, { error: String((err && err.message) || err) }))
      return
    }

    if (rest === '/api/notes' && req.method === 'GET') {
      json(res, 200, { notes: readNotes(ctx.project) })
      return
    }

    if (rest === '/api/notes/save' && req.method === 'POST') {
      readJson(req)
        .then((body) => handleNotesSave(ctx, body, res))
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/notes/delete' && req.method === 'POST') {
      readJson(req)
        .then((body) => handleNotesDelete(ctx, body, res))
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/rescan' && req.method === 'POST') {
      json(res, 200, ctx.rescan())
      return
    }

    if (rest === '/api/agents/clear-stale' && req.method === 'POST') {
      const now = Date.now()
      const cleared = []
      for (const agent of ctx.collector.agents.values()) {
        if (agent.status !== 'running' && agent.status !== 'started') continue
        if (ctx.seats.has(agent.id)) continue
        const at = (agent.lastTool && agent.lastTool.at) || agent.startedAt
        if (typeof at === 'number' && now - at < STALE_MS) continue
        appendEvent(ctx.project, {
          hook_event_name: 'ForceClear',
          agent_id: agent.id,
          agent_type: agent.type,
          session_id: 'manual-clear',
          __ts: now
        })
        cleared.push(agent.id)
      }
      json(res, 200, { ok: true, cleared })
      return
    }

    if (rest === '/api/stop' && req.method === 'POST') {
      json(res, 200, { ok: true })
      if (mode === 'single') {
        if (onStop) onStop()
      } else {
        if (hooksEnabled && runnerPath) uninstallHooks(ctx.project, [runnerPath, askRunnerPath].filter(Boolean))
        stopContext(ctx)
      }
      return
    }

    if (rest === '/api/desk/assign' && req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const agentType = String(body.agentType || '').trim()
          if (!agentType) {
            json(res, 400, { error: 'agentType required' })
            return
          }
          const taken = new Set([...ctx.seats.values()].map((s) => s.desk))
          let desk
          if (body.desk === MAIN_DESK || agentType === MAIN_ID) {
            const mainAgent = ctx.collector.agents.get('main')
            const mainBusy = mainAgent && (mainAgent.status === 'running' || mainAgent.status === 'started')
            if (mainBusy || taken.has(MAIN_DESK)) {
              json(res, 409, { error: 'main desk occupied' })
              return
            }
            desk = MAIN_DESK
          } else {
            desk = SDK_DESKS.find((d) => !taken.has(d))
            if (!desk) {
              json(res, 409, { error: 'no desk available' })
              return
            }
          }
          const key = 'sdk-' + randomUUID().slice(0, 8)
          const seat = { key, agentType, desk, sessionId: null, history: [], busy: false, q: null }
          ctx.seats.set(key, seat)
          seatChat(ctx, key, 'seated', { agentType, desk })
          json(res, 200, { ok: true, sessionKey: key, agentType, desk })
        })
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/desk/send' && req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const seat = ctx.seats.get(String(body.sessionKey || ''))
          const message = String(body.message || '').trim()
          if (!seat) {
            json(res, 404, { error: 'unknown session' })
            return
          }
          if (!message) {
            json(res, 400, { error: 'message required' })
            return
          }
          if (seat.busy) {
            json(res, 409, { error: 'agent is busy' })
            return
          }
          seat.busy = true
          seat.history.push({ role: 'user', text: message })
          seatChat(ctx, seat.key, 'user', { text: message })
          seatChat(ctx, seat.key, 'running')
          json(res, 200, { ok: true })
          runSeat(ctx, seat, message)
        })
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/desk/free' && req.method === 'POST') {
      readJson(req)
        .then((body) => {
          const key = String(body.sessionKey || '')
          const seat = ctx.seats.get(key)
          if (seat && seat.q) {
            try {
              seat.q.close()
            } catch {}
          }
          ctx.seats.delete(key)
          seatChat(ctx, key, 'freed')
          json(res, 200, { ok: true })
        })
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/ask/create' && req.method === 'POST') {
      readJson(req)
        .then((body) => handleAskCreate(ctx, body, res))
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/api/ask/poll' && req.method === 'GET') {
      handleAskPoll(ctx, url, res)
      return
    }

    if (rest === '/api/ask/answer' && req.method === 'POST') {
      readJson(req)
        .then((body) => handleAskAnswer(ctx, body, res))
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    if (rest === '/hook' && req.method === 'POST') {
      readJson(req)
        .then((parsed) => {
          const record = ctx.collector.ingest(parsed)
          json(res, 200, { ok: true, event: record && record.event })
          if (record) broadcastTo(ctx, 'event', record)
        })
        .catch(() => json(res, 400, { error: 'invalid json' }))
      return
    }

    json(res, 404, { error: 'not found' })
  }

  const server = httpServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
    const pathname = url.pathname

    if (mode === 'hub') {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(mapHtml())
        return
      }
      if (pathname === '/style.css' || pathname === '/map.js') {
        const staticFile = STATIC[pathname]
        try {
          res.writeHead(200, { 'content-type': staticFile.type })
          res.end(readAsset(staticFile.file))
        } catch {
          json(res, 404, { error: 'not found' })
        }
        return
      }
      if (pathname === '/api/offices') {
        syncOffices()
        json(res, 200, {
          port,
          offices: [...contexts.values()].map(officeSummary)
        })
        return
      }
      if (pathname === '/api/office/pick-directory' && req.method === 'POST') {
        Promise.resolve()
          .then(() => pickDirectory())
          .then((path) => json(res, 200, path ? { path } : { cancelled: true }))
          .catch((err) => {
            const status = err && err.code === 'UNSUPPORTED_PLATFORM' ? 501 : 500
            json(res, status, { error: String((err && err.message) || err) })
          })
        return
      }
      if (pathname === '/api/office/new' && req.method === 'POST') {
        readJson(req)
          .then((body) => {
            const path = String(body.path || '').trim()
            const name = String(body.name || '').trim()
            if (!path) {
              json(res, 400, { error: 'path required' })
              return
            }
            try {
              const entry = addOffice({ name, path, runnerPath: hooksEnabled ? runnerPath : null, askRunnerPath: hooksEnabled ? askRunnerPath : null })
              const ctx = buildContext(entry)
              contexts.set(entry.id, ctx)
              try {
                writeFileSync(portFile(ctx.project), String(port))
              } catch {}
              json(res, 200, officeSummary(ctx))
            } catch (err) {
              json(res, 400, { error: String((err && err.message) || err) })
            }
          })
          .catch(() => json(res, 400, { error: 'invalid json' }))
        return
      }
      if (pathname === '/api/office/remove' && req.method === 'POST') {
        readJson(req)
          .then((body) => {
            const arg = String(body.id || body.path || '').trim()
            if (!arg) {
              json(res, 400, { error: 'id or path required' })
              return
            }
            const entry = removeOffice(arg, hooksEnabled ? [runnerPath, askRunnerPath].filter(Boolean) : null)
            if (!entry) {
              json(res, 404, { error: 'office not found' })
              return
            }
            const ctx = contexts.get(entry.id)
            if (ctx) {
              stopContext(ctx)
              contexts.delete(entry.id)
            }
            json(res, 200, { ok: true })
          })
          .catch(() => json(res, 400, { error: 'invalid json' }))
        return
      }
      if (pathname === '/api/hub/stop' && req.method === 'POST') {
        json(res, 200, { ok: true })
        if (onStop) onStop()
        return
      }
      if (pathname === '/api/ask/create' && req.method === 'POST') {
        readJson(req)
          .then((body) => {
            const ctx = ctxForProject(body.project)
            if (!ctx) {
              json(res, 404, { error: 'no office for this project' })
              return
            }
            handleAskCreate(ctx, body, res)
          })
          .catch(() => json(res, 400, { error: 'invalid json' }))
        return
      }
      if (pathname === '/api/ask/poll' && req.method === 'GET') {
        const ctx = ctxForProject(url.searchParams.get('project'))
        if (!ctx) {
          json(res, 404, { error: 'no office for this project' })
          return
        }
        handleAskPoll(ctx, url, res)
        return
      }
      const m = pathname.match(/^\/office\/([^/]+)(\/.*)?$/)
      if (m) {
        const ctx = ensureContext(m[1])
        if (!ctx) {
          json(res, 404, { error: 'office not found' })
          return
        }
        handleOfficeRequest(ctx, m[2] || '/', req, res, url)
        return
      }
      json(res, 404, { error: 'not found' })
      return
    }

    if (mode === 'single' && primary) {
      handleOfficeRequest(primary, pathname, req, res, url)
      return
    }

    json(res, 404, { error: 'not found' })
  })

  const listen = () =>
    new Promise((resolve, reject) => {
      const tryListen = (p) => {
        server.once('error', (err) => {
          if (err.code === 'EADDRINUSE' && p < defaultPort + 20) {
            server.removeAllListeners('error')
            tryListen(p + 1)
          } else {
            reject(err)
          }
        })
        server.listen(p, '127.0.0.1', () => {
          port = p
          resolve(port)
        })
      }
      tryListen(defaultPort)
    })

  const close = () =>
    new Promise((resolve) => {
      for (const ctx of contexts.values()) stopContext(ctx)
      contexts.clear()
      server.close(() => resolve())
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
    })

  return { server, listen, close, notifyEvent, port: () => port }
}
