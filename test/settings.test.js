import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installHooks, uninstallHooks, HOOK_EVENTS } from '../src/settings.js'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'aw-settings-'))
  mkdirSync(join(root, '.claude'), { recursive: true })
  return root
}

const RUNNER = '/tmp/agentwatch/run-hook.js'

test('installHooks writes all events and keeps user hooks', () => {
  const root = fixture()
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({
    permissions: { allow: ['Bash(npm run *)'] },
    hooks: {
      PreToolUse: [{ hooks: [{ type: 'command', command: '/usr/bin/guard.sh' }] }]
    }
  }))
  const res = installHooks(root, RUNNER)
  assert.equal(res.changed.length, HOOK_EVENTS.length)
  const file = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
  assert.equal(file.permissions.allow[0], 'Bash(npm run *)')
  const pre = file.hooks.PreToolUse
  assert.equal(pre.length, 2)
  assert.deepEqual(pre[0].hooks[0].command, '/usr/bin/guard.sh')
  assert.equal(pre[1].hooks[0].command, 'node')
  assert.equal(pre[1].hooks[0].async, true)
})

test('installHooks is idempotent', () => {
  const root = fixture()
  installHooks(root, RUNNER)
  const res2 = installHooks(root, RUNNER)
  assert.deepEqual(res2.changed, [])
  const file = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
  assert.equal(file.hooks.SubagentStart.length, 1)
})

test('uninstallHooks removes only agentwatch handlers and restores file', () => {
  const root = fixture()
  writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({
    hooks: {
      PreToolUse: [
        { hooks: [{ type: 'command', command: '/usr/bin/guard.sh' }] }
      ]
    }
  }))
  const res = installHooks(root, RUNNER + '-extra')
  assert.ok(res.changed.length > 0)
  const removed = uninstallHooks(root, RUNNER + '-extra')
  assert.ok(removed.removed.includes('PreToolUse'))
  const file = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
  assert.equal(file.hooks.PreToolUse.length, 1)
  assert.equal(file.hooks.PreToolUse[0].hooks[0].command, '/usr/bin/guard.sh')
  const backups = readdirSync(join(root, '.agentwatch', 'backups'))
  assert.ok(backups.some((b) => b.includes('pre-uninstall')))
})

test('uninstallHooks deletes the settings file when nothing else remains', () => {
  const root = fixture()
  const res = installHooks(root, RUNNER)
  assert.ok(res.changed.length)
  uninstallHooks(root, RUNNER)
  assert.ok(!existsSync(join(root, '.claude', 'settings.local.json')))
})

test('uninstallHooks keeps registry for other runner paths', () => {
  const root = fixture()
  installHooks(root, '/a/run-hook.js')
  installHooks(root, '/b/run-hook.js')
  uninstallHooks(root, '/a/run-hook.js')
  const file = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'))
  assert.equal(file.hooks.SubagentStart[0].hooks[0].args[0], '/b/run-hook.js')
  assert.ok(existsSync(join(root, '.agentwatch', 'hooks.json')))
})