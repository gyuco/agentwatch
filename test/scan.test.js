import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanCatalog, scanMcps, parseFrontmatter } from '../src/scan.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-scan-'))
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'python-backend'), { recursive: true })
  mkdirSync(join(root, '.claude', 'skills', 'frontend'), { recursive: true })
  writeFileSync(
    join(root, '.claude', 'agents', 'analyst.md'),
    [
      '---',
      'name: Analyst',
      'description: Interviews users and analyzes project needs.',
      'tools:',
      '- Read',
      '- Write',
      '- Grep',
      '---',
      'body text'
    ].join('\n')
  )
  writeFileSync(join(root, '.claude', 'agents', 'coder.md'), '---\nname: Coder\ndescription: "Implements stories, runs fast gates."\n---\n')
  writeFileSync(
    join(root, '.claude', 'skills', 'python-backend', 'SKILL.md'),
    '---\nname: python-backend\ndescription: Hexagonal layers and ports.\n---\n'
  )
  writeFileSync(join(root, '.claude', 'skills', 'frontend', 'SKILL.md'), '---\ndescription: Frontend conventions.\n---\n')
  return root
}

test('parseFrontmatter handles lists, quotes and plain scalars', () => {
  const { data } = parseFrontmatter('---\nname: Foo\ndescription: "Quoted \\"v\\""\ntools:\n- Read\n- Write\n---\nbody')
  assert.equal(data.name, 'Foo')
  assert.deepEqual(data.tools, ['Read', 'Write'])
})

test('scanCatalog discovers agents and skills with frontmatter', () => {
  const root = fixture()
  const catalog = scanCatalog(root)
  assert.equal(catalog.agents.length, 2)
  const analyst = catalog.agents.find((a) => a.id === 'analyst')
  assert.equal(analyst.name, 'Analyst')
  assert.deepEqual(analyst.tools, ['Read', 'Write', 'Grep'])
  const coder = catalog.agents.find((a) => a.id === 'coder')
  assert.equal(coder.description, 'Implements stories, runs fast gates.')
  assert.equal(catalog.skills.length, 2)
  const py = catalog.skills.find((s) => s.id === 'python-backend')
  assert.equal(py.name, 'python-backend')
  const fe = catalog.skills.find((s) => s.id === 'frontend')
  assert.equal(fe.name, 'frontend')
})

test('scanCatalog tolerates missing skills dir', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-empty-'))
  const catalog = scanCatalog(root)
  assert.deepEqual(catalog, { agents: [], skills: [], mcps: [] })
})

test('scanMcps discovers project servers without exposing secrets', () => {
  const root = mkdtempSync(join(tmpdir(), 'aw-mcp-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  mkdirSync(join(root, '.vscode'), { recursive: true })
  writeFileSync(join(root, '.mcp.json'), JSON.stringify({
    mcpServers: {
      database: { command: 'npx', args: ['server', '--token', 'secret'], env: { API_KEY: 'secret' } },
      remote: { type: 'sse', url: 'https://user:pass@example.com/mcp?token=secret' }
    }
  }))
  writeFileSync(join(root, '.vscode', 'mcp.json'), JSON.stringify({ servers: { browser: { url: 'https://example.com/browser' } } }))
  const mcps = scanMcps(root)
  assert.equal(mcps.length, 3)
  assert.deepEqual(mcps.find((m) => m.id === 'database'), {
    id: 'database', name: 'database', transport: 'stdio', command: 'npx', url: '', source: '.mcp.json', disabled: false
  })
  assert.equal(mcps.find((m) => m.id === 'remote').url, 'https://example.com/mcp')
  assert.equal(mcps.find((m) => m.id === 'browser').source, '.vscode/mcp.json')
  assert.equal(JSON.stringify(mcps).includes('secret'), false)
})
