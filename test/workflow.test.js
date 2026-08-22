import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectWorkflow, normalizeWorkflowConfig, readTaskBoard, setupWorkflow } from '../src/workflow.js'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'aw-workflow-'))
}

test('setupWorkflow creates config, planner, skill, and configured directories', () => {
  const root = fixture()
  const result = setupWorkflow(root)
  assert.deepEqual(result.config.statuses, ['todo', 'in-progress', 'done'])
  assert.ok(existsSync(join(root, 'agentwatch.tasks.json')))
  assert.ok(existsSync(join(root, '.claude', 'agents', 'work-planner.md')))
  assert.ok(existsSync(join(root, '.claude', 'skills', 'work-items', 'SKILL.md')))
  assert.ok(existsSync(join(root, 'tasks')))
})

test('setupWorkflow requires an explicit choice and preserves existing scaffold on modify', () => {
  const root = fixture()
  setupWorkflow(root)
  const agent = join(root, '.claude', 'agents', 'work-planner.md')
  writeFileSync(agent, 'custom planner\n')
  assert.throws(() => setupWorkflow(root), /already exists/)
  setupWorkflow(root, {
    mode: 'modify',
    config: { version: 1, paths: ['planning'], statuses: ['open', 'review', 'closed'], defaultStatus: 'open', custom: true }
  })
  assert.equal(readFileSync(agent, 'utf8'), 'custom planner\n')
  assert.equal(inspectWorkflow(root).config.custom, true)
  assert.ok(existsSync(join(root, 'planning')))
})

test('normalizeWorkflowConfig rejects escaping paths and invalid defaults', () => {
  assert.throws(() => normalizeWorkflowConfig({ paths: ['../tasks'], statuses: ['open'] }), /invalid workflow path/)
  assert.throws(() => normalizeWorkflowConfig({ paths: ['tasks'], statuses: ['open'], defaultStatus: 'done' }), /defaultStatus/)
})

test('readTaskBoard preserves dynamic statuses, metadata, and exact relative paths', async () => {
  const root = fixture()
  setupWorkflow(root, {
    config: { version: 1, paths: ['planning'], statuses: ['queued', 'building', 'verified'], defaultStatus: 'queued' }
  })
  writeFileSync(join(root, 'planning', 'one.md'), '---\ntitle: First item\nstatus: review\ntype: feature\nlane: api\n---\n\nBody\n')
  writeFileSync(join(root, 'planning', 'two.md'), '# Second item\n\nstate: building\n')
  const board = await readTaskBoard(root)
  assert.deepEqual(board.columns.map((col) => col.id), ['queued', 'building', 'verified', 'review'])
  assert.equal(board.tasks[0].path, 'planning/one.md')
  assert.equal(board.tasks[0].type, 'feature')
  assert.equal(board.tasks[1].status, 'building')
})

test('readTaskBoard auto-discovers legacy docs/stories when config is absent', async () => {
  const root = fixture()
  const stories = join(root, 'docs', 'stories')
  setupWorkflow(root, { config: { version: 1, paths: ['docs/stories'], statuses: ['draft'], defaultStatus: 'draft' } })
  writeFileSync(join(stories, 'story.md'), '# Story: Legacy\n\nstatus: custom\n')
  // Remove only the config to model an office created before workflow support.
  const config = join(root, 'agentwatch.tasks.json')
  unlinkSync(config)
  const board = await readTaskBoard(root)
  assert.equal(board.autoDiscovered, true)
  assert.equal(board.tasks[0].title, 'Legacy')
  assert.deepEqual(board.columns.map((col) => col.id), ['custom'])
})
