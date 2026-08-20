import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, basename, dirname, extname } from 'node:path'

export function parseFrontmatter(md) {
  const data = {}
  const lines = md.split(/\r?\n/)
  if (lines[0] !== '---') return { data, body: md }
  let end = 1
  for (; end < lines.length; end++) {
    if (lines[end] === '---') break
  }
  const fm = lines.slice(1, end)
  let currentKey = null
  for (const raw of fm) {
    const line = raw.trimEnd()
    if (/^-\s+/.test(line) && currentKey) {
      data[currentKey].push(line.replace(/^-\s+/, '').trim())
      continue
    }
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1)
    if (value === '') {
      data[key] = []
    } else {
      data[key] = value
    }
    currentKey = value === '' ? key : null
  }
  return { data, body: lines.slice(end + 1).join('\n') }
}

function walkMds(dir, out, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkMds(full, out, depth + 1)
    else if (entry.isFile() && extname(entry.name) === '.md') out.push(full)
  }
}

export function scanAgents(root) {
  const dir = join(root, '.claude', 'agents')
  const files = []
  walkMds(dir, files)
  return files.map((file) => {
    const id = basename(file, '.md')
    const { data } = parseFrontmatter(readFileSync(file, 'utf8'))
    const tools = Array.isArray(data.tools) ? data.tools : []
    return {
      id,
      name: data.name || id,
      description: data.description || '',
      tools,
      model: data.model || '',
      path: file
    }
  })
}

export function scanSkills(root) {
  const dir = join(root, '.claude', 'skills')
  const files = []
  walkMds(dir, files)
  return files
    .filter((file) => basename(file).toLowerCase() === 'skill.md')
    .map((file) => {
      const id = basename(dirname(file))
      const { data } = parseFrontmatter(readFileSync(file, 'utf8'))
      return {
        id,
        name: data.name || id,
        description: data.description || '',
        path: file
      }
    })
}

export function scanCatalog(root) {
  return { agents: scanAgents(root), skills: scanSkills(root) }
}
