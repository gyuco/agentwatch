#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { findProjectRoot, queueFile, portFile, settingsLocalFile, agentwatchDir } from './paths.js'
import { scanCatalog } from './scan.js'
import { EventCollector } from './collector.js'
import { startServer, startHubServer } from './server.js'
import { installHooks, uninstallHooks, installedHooks, HOOK_EVENTS } from './settings.js'
import { attachQueueWatcher, ingestExisting } from './queue.js'
import { loadOffices, addOffice, removeOffice, hubPortFile, registryFile } from './offices.js'

const HELP = `agentwatch — live dashboard for Claude Code agents, subagents and skills

Usage:
  agentwatch [--port N] [--no-open] [--no-hooks]
  agentwatch serve [--port N] [--no-open] [--no-hooks]
  agentwatch hub [--port N] [--no-open] [--no-hooks]
  agentwatch project [--port N] [--no-open] [--no-hooks] [--project DIR]
  agentwatch hub stop
  agentwatch hub status
  agentwatch office add <path> [--name NAME] [--no-hooks]
  agentwatch office remove <id|path>
  agentwatch office list
  agentwatch stop
  agentwatch status
  agentwatch hooks
  agentwatch help

Commands:
  hub      (default) start the multi-office hub: a map of all registered offices,
           each with its own dashboard at /office/<id>
  serve    alias for hub
  project  scan agents/skills, install hooks, start dashboard for one project
  hub stop     uninstall hooks from all offices and stop the hub
  hub status   list registered offices and hub state
  office add   register a folder as an office (creates it, installs hooks)
  office remove  unregister an office (uninstalls its hooks)
  office list  show registered offices
  stop     uninstall hooks and stop the running dashboard
  status   show what is currently monitored
  hooks    show installed hook configuration
  help     show this help

Options:
  --port N      port for the dashboard/hub (default 4579)
  --no-open     do not open the browser automatically
  --no-hooks    do not install hooks (view only)
  --project DIR scan/install relative to DIR instead of the detected root
  --name NAME   name for the new office (default: folder name)
`

const args = process.argv.slice(2)
const opts = { port: 4579, open: true, hooks: true, project: null, name: null }

function parseArgs() {
  const positional = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--port') opts.port = Number(args[++i])
    else if (a === '--no-open') opts.open = false
    else if (a === '--no-hooks') opts.hooks = false
    else if (a === '--project') opts.project = args[++i]
    else if (a === '--name') opts.name = args[++i]
    else if (a === '--help' || a === '-h') positional.push('help')
    else if (a.startsWith('--')) {
      process.stderr.write(`unknown option: ${a}\n`)
      process.exit(2)
    } else positional.push(a)
  }
  return positional
}

function runnerPath() {
  return join(import.meta.dirname, 'run-hook.js')
}

function askRunnerPath() {
  return join(import.meta.dirname, 'ask-hook.js')
}

function readPortFile(file) {
  try {
    return Number(readFileSync(file, 'utf8').trim())
  } catch {
    return null
  }
}

async function fetchJson(port, path, method = 'GET') {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function openBrowser(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else if (process.platform === 'linux') {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    process.stderr.write(`open ${url}\n`)
  }
}

async function cmdServe() {
  const root = opts.project ? findProjectRoot(opts.project) : findProjectRoot()
  const catalog = scanCatalog(root)
  const collector = new EventCollector()

  const queue = queueFile(root)
  mkdirSync(agentwatchDir(root), { recursive: true })
  try {
    writeFileSync(queue, '', { flag: 'a' })
  } catch {}
  ingestExisting(collector, queue)

  const server = startServer({
    collector,
    project: root,
    catalog,
    onRescan: () => scanCatalog(root),
    onStop: () => {
      if (opts.hooks) {
        const removed = uninstallHooks(root, [runnerPath(), askRunnerPath()])
        process.stdout.write(`hooks uninstalled: ${removed.removed.join(', ') || 'none'}\n`)
      }
      server.close().then(() => {
        process.stdout.write('dashboard stopped\n')
        process.exit(0)
      })
    },
    defaultPort: opts.port
  })

  await server.listen()
  writeFileSync(portFile(root), String(server.port()))

  const queueWatcher = attachQueueWatcher({
    queuePath: queue,
    collector,
    onRecord: (record) => server.notifyEvent(record)
  })

  let hooksResult = { changed: [] }
  if (opts.hooks) {
    hooksResult = installHooks(root, runnerPath(), askRunnerPath())
  }

  const url = `http://127.0.0.1:${server.port()}`
  process.stdout.write(
    [
      `agentwatch dashboard: ${url}`,
      `project: ${root}`,
      `agents: ${catalog.agents.length}  skills: ${catalog.skills.length}`,
      `hooks: ${opts.hooks ? (hooksResult.changed.length ? `installed for ${hooksResult.changed.join(', ')}` : 'already installed') : 'disabled'}`,
      `queue: ${queue}`,
      ''
    ].join('\n')
  )

  if (opts.open) openBrowser(url)

  const shutdown = () => {
    try {
      queueWatcher.close()
    } catch {}
    server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => {
    process.stdout.write('\nstopping dashboard (hooks left installed — run "agentwatch stop" to remove them)\n')
    shutdown()
  })
  process.on('SIGTERM', shutdown)
}

async function cmdStop() {
  const root = opts.project ? findProjectRoot(opts.project) : findProjectRoot()
  const paths = installedHooks(root)
  let removed = { removed: [] }
  for (const p of paths) {
    const r = uninstallHooks(root, p)
    removed.removed = [...removed.removed, ...r.removed]
  }
  if (paths.length === 0) {
    removed = uninstallHooks(root, [runnerPath(), askRunnerPath()])
  }
  const port = readPortFile(portFile(root))
  process.stdout.write(`hooks uninstalled from ${settingsLocalFile(root)}: ${removed.removed.join(', ') || 'none'}\n`)
  if (port) {
    try {
      await fetchJson(port, '/api/stop', 'POST')
      process.stdout.write(`dashboard on port ${port} stopped\n`)
    } catch {
      process.stdout.write(`no dashboard running on port ${port}\n`)
    }
  }
}

async function cmdStatus() {
  const root = opts.project ? findProjectRoot(opts.project) : findProjectRoot()
  const catalog = scanCatalog(root)
  const port = readPortFile(root)
  process.stdout.write(
    [
      `project: ${root}`,
      `agents: ${catalog.agents.map((a) => a.name).join(', ') || '—'}`,
      `skills: ${catalog.skills.map((s) => s.name).join(', ') || '—'}`,
      `installed hook paths: ${installedHooks(root).join(', ') || '—'}`
    ].join('\n') + '\n'
  )
  if (port) {
    try {
      const state = await fetchJson(port, '/api/state')
      const running = state.collector.running
      process.stdout.write(
        `dashboard: http://127.0.0.1:${port}\n` +
          `running agents: ${running.length ? running.join(', ') : 'none'}\n` +
          `events seen: ${state.collector.events.length}\n`
      )
      return
    } catch {}
  }
  process.stdout.write('dashboard: not running\n')
}

function cmdHooks() {
  const root = opts.project ? findProjectRoot(opts.project) : findProjectRoot()
  const file = settingsLocalFile(root)
  if (!existsSync(file)) {
    process.stdout.write('no .claude/settings.local.json\n')
    return
  }
  let settings = {}
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    process.stdout.write('unparseable settings file\n')
    return
  }
  const hooks = settings.hooks || {}
  const enabled = HOOK_EVENTS.filter((ev) => Array.isArray(hooks[ev]) && hooks[ev].length)
  process.stdout.write(`file: ${file}\n`)
  process.stdout.write(`hook events configured: ${enabled.join(', ') || 'none'}\n`)
}

async function cmdHub() {
  const offices = loadOffices()
  const server = startHubServer({
    runnerPath: runnerPath(),
    askRunnerPath: askRunnerPath(),
    hooksEnabled: opts.hooks,
    defaultPort: opts.port,
    onStop: () => {
      server.close().then(() => {
        process.stdout.write('hub stopped\n')
        process.exit(0)
      })
    }
  })

  await server.listen()
  writeFileSync(hubPortFile(), String(server.port()))
  for (const office of offices) {
    try {
      writeFileSync(portFile(office.path), String(server.port()))
    } catch {}
  }

  const url = `http://127.0.0.1:${server.port()}`
  process.stdout.write(
    [
      `agentwatch hub: ${url}`,
      `offices: ${offices.length}  registry: ${registryFile()}`,
      `hooks: ${opts.hooks ? 'enabled (install on office add)' : 'disabled'}`,
      ''
    ].join('\n')
  )

  if (opts.open) openBrowser(url)

  const shutdown = () => {
    server.close().then(() => process.exit(0))
  }
  process.on('SIGINT', () => {
    process.stdout.write('\nstopping hub (hooks left installed — run "agentwatch hub stop" to remove them)\n')
    shutdown()
  })
  process.on('SIGTERM', shutdown)
}

async function cmdHubStop() {
  let removed = []
  for (const office of loadOffices()) {
    const r = uninstallHooks(office.path, [runnerPath(), askRunnerPath()])
    removed = [...removed, ...r.removed]
  }
  process.stdout.write(`hooks uninstalled: ${removed.join(', ') || 'none'}\n`)
  const port = readPortFile(hubPortFile())
  if (port) {
    try {
      await fetchJson(port, '/api/hub/stop', 'POST')
      process.stdout.write(`hub on port ${port} stopped\n`)
    } catch {
      process.stdout.write(`no hub running on port ${port}\n`)
    }
  }
}

async function cmdHubStatus() {
  const offices = loadOffices()
  if (!offices.length) process.stdout.write('no offices registered\n')
  for (const o of offices) {
    const catalog = scanCatalog(o.path)
    const hooks = installedHooks(o.path)
    process.stdout.write(
      `${o.id}\t${o.name}\t${o.path}\tagents: ${catalog.agents.length}\tskills: ${catalog.skills.length}\thooks: ${hooks.length ? 'yes' : 'no'}\n`
    )
  }
  const port = readPortFile(hubPortFile())
  if (port) {
    try {
      const state = await fetchJson(port, '/api/offices')
      process.stdout.write(`hub: http://127.0.0.1:${port}  (${state.offices.length} offices)\n`)
    } catch {
      process.stdout.write('hub: not running\n')
    }
  }
}

function cmdOfficeAdd(arg) {
  if (!arg) {
    process.stderr.write('usage: agentwatch office add <path> [--name NAME] [--no-hooks]\n')
    process.exit(2)
  }
  const entry = addOffice({ name: opts.name, path: arg, runnerPath: opts.hooks ? runnerPath() : null, askRunnerPath: opts.hooks ? askRunnerPath() : null })
  process.stdout.write(
    [
      `office added: ${entry.id}`,
      `  name:  ${entry.name}`,
      `  path:  ${entry.path}`,
      `  hooks: ${opts.hooks ? 'installed' : 'skipped'}`,
      `  open with: agentwatch hub`
    ].join('\n') + '\n'
  )
}

function cmdOfficeRemove(arg) {
  if (!arg) {
    process.stderr.write('usage: agentwatch office remove <id|path>\n')
    process.exit(2)
  }
  const entry = removeOffice(arg, opts.hooks ? [runnerPath(), askRunnerPath()] : null)
  if (!entry) {
    process.stderr.write(`office not found: ${arg}\n`)
    process.exit(1)
  }
  process.stdout.write(`office removed: ${entry.id} (${entry.path})\n`)
}

function cmdOfficeList() {
  const offices = loadOffices()
  if (!offices.length) {
    process.stdout.write('no offices registered — add one with "agentwatch office add <path>"\n')
    return
  }
  for (const o of offices) {
    process.stdout.write(`${o.id}\t${o.name}\t${o.path}\n`)
  }
}

async function main() {
  const positional = parseArgs()
  const cmd = positional[0] || 'hub'
  if (cmd === 'hub') {
    const sub = positional[1]
    if (sub === 'stop') return cmdHubStop()
    if (sub === 'status') return cmdHubStatus()
    return cmdHub()
  }
  if (cmd === 'serve') return cmdHub()
  if (cmd === 'office') {
    const sub = positional[1]
    const arg = positional[2]
    if (sub === 'add') return cmdOfficeAdd(arg)
    if (sub === 'remove') return cmdOfficeRemove(arg)
    if (sub === 'list') return cmdOfficeList()
    process.stderr.write(`unknown office command: ${sub || ''}\n\n`)
    process.stderr.write(HELP)
    process.exit(2)
  }
  switch (cmd) {
    case 'project':
      return cmdServe()
    case 'stop':
      return cmdStop()
    case 'status':
      return cmdStatus()
    case 'hooks':
      return cmdHooks()
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP)
      return
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n`)
      process.stderr.write(HELP)
      process.exit(2)
  }
}

main().catch((err) => {
  process.stderr.write(`error: ${err.stack || err.message}\n`)
  process.exit(1)
})
