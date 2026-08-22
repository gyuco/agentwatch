import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectCatalog, installCatalogSelection, loadCatalog, resolveCatalogSelection, workflowConfig } from '../src/catalog.js'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'aw-catalog-'))
}

test('bundled catalog exposes packs, components, and generic workflows', () => {
  const catalog = loadCatalog()
  assert.ok(catalog.packs.some((pack) => pack.id === 'minimal'))
  assert.ok(catalog.packs.some((pack) => pack.id === 'development'))
  assert.ok(catalog.agents.some((agent) => agent.id === 'work-planner'))
  assert.deepEqual(
    catalog.packs.find((pack) => pack.id === 'development').agents,
    ['work-planner', 'analyst', 'architect', 'coder', 'code-reviewer', 'qa-engineer']
  )
  assert.deepEqual(workflowConfig(catalog, 'simple-tasks').statuses, ['todo', 'in-progress', 'done'])
})

test('catalog recommends development for a software repository', () => {
  const root = fixture()
  writeFileSync(join(root, 'package.json'), '{}\n')
  assert.equal(inspectCatalog(root).recommendedPack, 'development')
  assert.equal(inspectCatalog(fixture()).recommendedPack, 'minimal')
})

test('catalog installation creates selected files and a versioned setup manifest', () => {
  const root = fixture()
  const result = installCatalogSelection(root, { pack: 'development' })
  assert.ok(existsSync(join(root, '.claude', 'agents', 'work-planner.md')))
  assert.ok(existsSync(join(root, '.claude', 'agents', 'analyst.md')))
  assert.ok(existsSync(join(root, '.claude', 'agents', 'architect.md')))
  assert.ok(existsSync(join(root, '.claude', 'agents', 'coder.md')))
  assert.ok(existsSync(join(root, '.claude', 'agents', 'code-reviewer.md')))
  assert.ok(existsSync(join(root, '.claude', 'skills', 'release-notes', 'SKILL.md')))
  const manifest = JSON.parse(readFileSync(join(root, 'agentwatch.setup.json'), 'utf8'))
  assert.equal(manifest.pack, 'development')
  assert.equal(manifest.workflow, 'continuous-delivery')
  assert.equal(result.results.agents.every((item) => item.status === 'created'), true)
})

test('catalog preserves existing files and resolves agent skill dependencies', () => {
  const root = fixture()
  const target = join(root, '.claude', 'agents', 'qa-engineer.md')
  mkdirSync(join(root, '.claude', 'agents'), { recursive: true })
  writeFileSync(target, 'custom\n')
  const catalog = loadCatalog()
  const selection = resolveCatalogSelection(catalog, { pack: 'custom', agents: ['qa-engineer'], skills: [], workflow: 'simple-tasks' })
  assert.deepEqual(selection.skills, ['test-strategy'])
  const result = installCatalogSelection(root, selection)
  assert.equal(readFileSync(target, 'utf8'), 'custom\n')
  assert.equal(result.results.agents[0].status, 'existing')
  assert.ok(existsSync(join(root, '.claude', 'skills', 'test-strategy', 'SKILL.md')))
})
