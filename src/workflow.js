import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { parseFrontmatter } from './scan.js'

export const WORKFLOW_CONFIG = 'agentwatch.tasks.json'

export const DEFAULT_WORKFLOW = Object.freeze({
  version: 1,
  paths: ['tasks'],
  statuses: ['todo', 'in-progress', 'done'],
  defaultStatus: 'todo'
})

const MAX_TASK_BYTES = 1024 * 1024
const SKIP_DIRS = new Set(['node_modules', '.git', '.agentwatch', 'dist', 'build', '.next', 'coverage', 'vendor', 'target', 'out'])
const SKIP_FILES = new Set(['readme.md', '_template.md'])

const WORK_PLANNER = `---
name: work-planner
description: Plan and maintain the project's Markdown work items using agentwatch.tasks.json.
tools:
  - Read
  - Glob
  - Grep
  - Write
  - Edit
---

# Work planner

Plan work using the workflow declared in \`agentwatch.tasks.json\` at the project root.

- Read the configuration before discovering or creating work items.
- Use only the configured paths and preserve the configured status values.
- Treat every item as a generic work item. Do not assume Scrum, epics, stories, or sprints.
- Add a \`type\` or \`parent\` only when the project already uses them or hierarchy is genuinely useful.
- Check existing items before creating new ones and avoid duplicates.
- Do not change an item's status without an explicit request or verifiable evidence.
- Follow the \`work-items\` skill for the Markdown contract.
`

const WORK_ITEMS_SKILL = `---
name: work-items
description: Read, create, or update Agentwatch Markdown work items and their configurable workflow.
---

# Work items

1. Read \`agentwatch.tasks.json\` from the project root.
2. Discover Markdown files only below its \`paths\`.
3. Use YAML frontmatter with at least \`title\` and \`status\` for new items.
4. Use only a status listed in \`statuses\`; default to \`defaultStatus\` when creating an item.
5. Preserve unknown metadata when editing an existing item.
6. Optional fields include \`id\`, \`type\`, \`parent\`, \`priority\`, \`lane\`, and \`tags\`.
7. Do not introduce Scrum-specific structure unless requested or already established by the project.
`

function cloneDefault() {
  return JSON.parse(JSON.stringify(DEFAULT_WORKFLOW))
}

function configPath(root) {
  return join(resolve(root), WORKFLOW_CONFIG)
}

function cleanStringList(value, field) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty array`)
  const values = value.map((x) => String(x || '').trim()).filter(Boolean)
  if (values.length !== value.length || new Set(values).size !== values.length) {
    throw new Error(`${field} must contain unique non-empty strings`)
  }
  return values
}

export function normalizeWorkflowConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('workflow config must be an object')
  const paths = cleanStringList(value.paths, 'paths').map((path) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
    if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '.')) {
      throw new Error(`invalid workflow path: ${path}`)
    }
    return normalized
  })
  const statuses = cleanStringList(value.statuses, 'statuses')
  const defaultStatus = String(value.defaultStatus || statuses[0]).trim()
  if (!statuses.includes(defaultStatus)) throw new Error('defaultStatus must be listed in statuses')
  return { ...value, version: Number(value.version) || 1, paths, statuses, defaultStatus }
}

export function inspectWorkflow(root) {
  const path = configPath(root)
  if (!existsSync(path)) return { exists: false, path: WORKFLOW_CONFIG, config: cloneDefault(), raw: '' }
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
    return { exists: true, path: WORKFLOW_CONFIG, config: normalizeWorkflowConfig(JSON.parse(raw)), raw, valid: true }
  } catch (err) {
    return { exists: true, path: WORKFLOW_CONFIG, config: null, raw, valid: false, error: String((err && err.message) || err) }
  }
}

function writeIfMissing(path, content) {
  if (existsSync(path)) return false
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content.endsWith('\n') ? content : content + '\n')
  return true
}

export function setupWorkflow(root, { mode = 'create', config = DEFAULT_WORKFLOW, scaffold = true } = {}) {
  const project = resolve(root)
  const current = inspectWorkflow(project)
  if (current.exists && mode === 'create') {
    const err = new Error(`${WORKFLOW_CONFIG} already exists`)
    err.code = 'WORKFLOW_EXISTS'
    throw err
  }
  if (mode !== 'create' && mode !== 'modify' && mode !== 'overwrite') throw new Error('invalid workflow mode')
  if (mode === 'modify' && !current.exists) throw new Error(`${WORKFLOW_CONFIG} does not exist`)

  const normalized = normalizeWorkflowConfig(config)
  mkdirSync(project, { recursive: true })
  writeFileSync(configPath(project), JSON.stringify(normalized, null, 2) + '\n')

  const created = []
  if (scaffold) {
    const agent = join(project, '.claude', 'agents', 'work-planner.md')
    const skill = join(project, '.claude', 'skills', 'work-items', 'SKILL.md')
    if (writeIfMissing(agent, WORK_PLANNER)) created.push(relative(project, agent))
    if (writeIfMissing(skill, WORK_ITEMS_SKILL)) created.push(relative(project, skill))
  }
  for (const rel of normalized.paths) mkdirSync(join(project, ...rel.split('/')), { recursive: true })
  return { path: WORKFLOW_CONFIG, config: normalized, created }
}

function scalar(data, keys) {
  for (const key of keys) {
    if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim()
  }
  return ''
}

function looseField(body, keys) {
  for (const key of keys) {
    const match = body.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'mi'))
    if (match) return match[1].trim()
  }
  return ''
}

async function collectMarkdown(dir, out, depth = 0) {
  if (depth > 8) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectMarkdown(full, out, depth + 1)
    else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md' && !SKIP_FILES.has(entry.name.toLowerCase())) out.push(full)
  }
}

export async function readTaskBoard(root) {
  const project = resolve(root)
  const inspected = inspectWorkflow(project)
  const conventional = ['tasks', 'docs/tasks', 'docs/stories'].filter((rel) => existsSync(join(project, ...rel.split('/'))))
  if (!inspected.exists && conventional.length === 0) return { configured: false, configPath: WORKFLOW_CONFIG, sources: [], columns: [], tasks: [], warnings: [] }
  if (inspected.exists && !inspected.valid) return { configured: true, configPath: WORKFLOW_CONFIG, sources: [], columns: [], tasks: [], warnings: [inspected.error] }

  const config = inspected.exists ? inspected.config : { paths: conventional, statuses: [] }
  const files = []
  for (const rel of config.paths) await collectMarkdown(join(project, ...rel.split('/')), files)
  const tasks = []
  const warnings = []
  for (const file of [...new Set(files)].sort()) {
    try {
      const info = await stat(file)
      if (info.size > MAX_TASK_BYTES) {
        warnings.push(`${relative(project, file)} is too large`)
        continue
      }
      const source = await readFile(file, 'utf8')
      const { data, body } = parseFrontmatter(source)
      const heading = body.match(/^#\s+(.+)$/m)
      const title = scalar(data, ['title', 'name']) || (heading && heading[1].trim().replace(/^Story:\s*/i, '')) || relative(project, file).replace(/\.md$/i, '')
      const statusValue = scalar(data, ['status', 'state']) || looseField(body, ['status', 'state']) || 'unknown'
      const lane = scalar(data, ['lane', 'area', 'team']) || looseField(body, ['lane', 'area', 'team'])
      tasks.push({
        path: relative(project, file).replace(/\\/g, '/'),
        file: relative(project, file).replace(/\\/g, '/'),
        title,
        status: statusValue,
        lane,
        type: scalar(data, ['type']),
        parent: scalar(data, ['parent']),
        priority: scalar(data, ['priority'])
      })
    } catch (err) {
      warnings.push(`${relative(project, file)}: ${String((err && err.message) || err)}`)
    }
  }
  const discovered = [...new Set(tasks.map((task) => task.status))]
  const order = [...config.statuses, ...discovered.filter((status) => !config.statuses.includes(status))]
  const columns = order.map((id) => ({ id, label: id, count: tasks.filter((task) => task.status === id).length }))
  return { configured: true, autoDiscovered: !inspected.exists, configPath: WORKFLOW_CONFIG, sources: config.paths, columns, tasks, warnings }
}
