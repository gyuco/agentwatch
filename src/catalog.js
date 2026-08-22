import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SETUP_MANIFEST = 'agentwatch.setup.json'

const here = dirname(fileURLToPath(import.meta.url))
const catalogRoot = join(here, '..', 'catalog')

function readJson(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

export function loadCatalog() {
  const catalog = readJson(join(catalogRoot, 'catalog.json'))
  if (!catalog || !Array.isArray(catalog.packs)) throw new Error('bundled catalog is invalid')
  return catalog
}

function itemMap(items) {
  return new Map(items.map((item) => [item.id, item]))
}

function projectLooksLikeSoftware(root) {
  const markers = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pubspec.yaml', 'pom.xml', 'build.gradle']
  return markers.some((name) => existsSync(join(root, name))) || ['src', 'test', 'tests'].some((name) => existsSync(join(root, name)))
}

export function workflowConfig(catalog, workflowId) {
  const workflow = catalog.workflows.find((item) => item.id === workflowId)
  if (!workflow) throw new Error(`unknown workflow: ${workflowId}`)
  return {
    version: 1,
    paths: workflow.paths,
    statuses: workflow.statuses,
    defaultStatus: workflow.defaultStatus
  }
}

export function resolveCatalogSelection(catalog, selection = {}) {
  const pack = catalog.packs.find((item) => item.id === selection.pack)
  const values = {
    pack: pack ? pack.id : 'custom',
    agents: Array.isArray(selection.agents) ? selection.agents : (pack ? pack.agents : []),
    skills: Array.isArray(selection.skills) ? selection.skills : (pack ? pack.skills : []),
    mcps: Array.isArray(selection.mcps) ? selection.mcps : (pack ? pack.mcps : []),
    workflow: String(selection.workflow || (pack && pack.workflow) || 'simple-tasks')
  }
  for (const [kind, all] of [['agents', catalog.agents], ['skills', catalog.skills], ['mcps', catalog.mcps]]) {
    const known = new Set(all.map((item) => item.id))
    values[kind] = [...new Set(values[kind].map((id) => String(id)))].filter((id) => {
      if (!known.has(id)) throw new Error(`unknown catalog ${kind.slice(0, -1)}: ${id}`)
      return true
    })
  }
  const agents = itemMap(catalog.agents)
  for (const id of values.agents) {
    for (const skill of (agents.get(id).requires && agents.get(id).requires.skills) || []) {
      if (!values.skills.includes(skill)) values.skills.push(skill)
    }
  }
  if (!catalog.workflows.some((item) => item.id === values.workflow)) throw new Error(`unknown workflow: ${values.workflow}`)
  return values
}

export function inspectCatalog(root) {
  const project = resolve(root)
  const catalog = loadCatalog()
  const recommendedPack = projectLooksLikeSoftware(project) ? 'development' : 'minimal'
  const conflicts = []
  for (const kind of ['agents', 'skills']) {
    for (const item of catalog[kind]) {
      if (existsSync(join(project, ...item.target.split('/')))) conflicts.push({ type: kind.slice(0, -1), id: item.id, path: item.target })
    }
  }
  return {
    catalog,
    recommendedPack,
    conflicts,
    setup: readJson(join(project, SETUP_MANIFEST), null)
  }
}

function installFile(project, item) {
  const target = join(project, ...item.target.split('/'))
  if (existsSync(target)) return { id: item.id, path: item.target, status: 'existing' }
  const source = join(catalogRoot, ...item.source.split('/'))
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(source, 'utf8'))
  return { id: item.id, path: item.target, status: 'created' }
}

export function installCatalogSelection(root, rawSelection) {
  const project = resolve(root)
  const catalog = loadCatalog()
  const selection = resolveCatalogSelection(catalog, rawSelection)
  const agents = itemMap(catalog.agents)
  const skills = itemMap(catalog.skills)
  const mcps = itemMap(catalog.mcps)
  const results = { agents: [], skills: [], mcps: [], warnings: [] }

  for (const id of selection.agents) results.agents.push(installFile(project, agents.get(id)))
  for (const id of selection.skills) results.skills.push(installFile(project, skills.get(id)))
  for (const id of selection.mcps) {
    const item = mcps.get(id)
    results.mcps.push({ id, status: item.installable === false ? 'manual' : 'selected', note: item.note || '' })
    if (item.installable === false) results.warnings.push(`${item.name}: ${item.note}`)
  }

  const installed = { agents: {}, skills: {}, mcps: {} }
  for (const kind of ['agents', 'skills']) {
    const source = kind === 'agents' ? agents : skills
    for (const result of results[kind]) {
      if (result.status === 'created') installed[kind][result.id] = source.get(result.id).version
    }
  }
  for (const result of results.mcps) installed.mcps[result.id] = result.status
  const previous = readJson(join(project, SETUP_MANIFEST), {}) || {}
  const manifest = {
    ...previous,
    catalogVersion: catalog.version,
    pack: selection.pack,
    workflow: selection.workflow,
    installed: {
      agents: { ...(previous.installed && previous.installed.agents), ...installed.agents },
      skills: { ...(previous.installed && previous.installed.skills), ...installed.skills },
      mcps: { ...(previous.installed && previous.installed.mcps), ...installed.mcps }
    },
    updatedAt: new Date().toISOString()
  }
  writeFileSync(join(project, SETUP_MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
  return { selection, results, manifest, created: [...results.agents, ...results.skills].filter((item) => item.status === 'created').map((item) => relative(project, join(project, item.path))) }
}
