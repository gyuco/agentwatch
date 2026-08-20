import { homedir } from 'node:os'
import { join, resolve, basename } from 'node:path'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { installHooks, uninstallHooks } from './settings.js'

export function agentwatchHome() {
  return process.env.AGENTWATCH_HOME || join(homedir(), '.agentwatch')
}

export function registryFile() {
  return join(agentwatchHome(), 'offices.json')
}

export function hubPortFile() {
  return join(agentwatchHome(), 'hub.port')
}

export function loadOffices() {
  try {
    const data = JSON.parse(readFileSync(registryFile(), 'utf8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

export function saveOffices(list) {
  mkdirSync(agentwatchHome(), { recursive: true })
  writeFileSync(registryFile(), JSON.stringify(list, null, 2) + '\n')
}

export function slugify(s) {
  const slug = String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'office'
}

export function findOffice(arg) {
  const key = String(arg || '').toLowerCase()
  const want = resolve(String(arg || ''))
  return loadOffices().find(
    (o) => o.id === key || resolve(o.path) === want || String(o.name || '').toLowerCase() === key
  ) || null
}

export function addOffice({ name, path, runnerPath, askRunnerPath }) {
  const root = resolve(path)
  if (loadOffices().some((o) => resolve(o.path) === root)) {
    throw new Error(`office already registered: ${root}`)
  }
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills'), { recursive: true })
  if (runnerPath) installHooks(root, runnerPath, askRunnerPath)

  const base = slugify(name || basename(root))
  const taken = new Set(loadOffices().map((o) => o.id))
  let id = base
  let n = 2
  while (taken.has(id)) id = `${base}-${n++}`

  const entry = { id, name: name || basename(root), path: root, createdAt: Date.now() }
  const list = loadOffices()
  list.push(entry)
  saveOffices(list)
  return entry
}

export function removeOffice(arg, runnerPath) {
  const entry = findOffice(arg)
  if (!entry) return null
  if (runnerPath) uninstallHooks(entry.path, runnerPath)
  saveOffices(loadOffices().filter((o) => o.id !== entry.id))
  return entry
}