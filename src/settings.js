import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { settingsLocalFile, backupsDir, hooksRegistryFile, agentwatchDir } from './paths.js'

export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'Stop',
  'SessionEnd'
]

export function handlerFor(runnerPath) {
  return {
    type: 'command',
    async: true,
    command: 'node',
    args: [runnerPath]
  }
}

export const ASK_MATCHER = 'AskUserQuestion|Question'
export const ASK_HOOK_TIMEOUT = 300

export function askHandlerFor(askRunnerPath) {
  return {
    type: 'command',
    command: 'node',
    args: [askRunnerPath],
    timeout: ASK_HOOK_TIMEOUT
  }
}

function hasAskGroup(groups, askRunnerPath) {
  return groups.some(
    (g) => g && g.matcher === ASK_MATCHER && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h, askRunnerPath))
  )
}

export function isOurs(handler, runnerPath) {
  if (handler.type !== 'command') return false
  const needle = (Array.isArray(runnerPath) ? runnerPath : [runnerPath]).map((p) => p.replace(/\\/g, '/'))
  const hay = JSON.stringify([handler.command, ...(handler.args || [])]).replace(/\\/g, '/')
  return needle.some((n) => n && hay.includes(n))
}

export function loadSettingsFile(file) {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

export function installedHooks(root) {
  const registry = loadSettingsFile(hooksRegistryFile(root))
  return registry && Array.isArray(registry.runnerPaths) ? registry.runnerPaths : []
}

export function installHooks(root, runnerPath, askRunnerPath) {
  const file = settingsLocalFile(root)
  const settings = loadSettingsFile(file)
  const prevHooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const nextHooks = {}
  const changed = []

  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(prevHooks[event]) ? prevHooks[event] : []
    const hasOurs = groups.some((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurs(h, runnerPath)))
    if (hasOurs) {
      nextHooks[event] = groups
      continue
    }
    nextHooks[event] = [...groups, { hooks: [handlerFor(runnerPath)] }]
    changed.push(event)
  }

  if (askRunnerPath) {
    const groups = Array.isArray(nextHooks.PreToolUse) ? nextHooks.PreToolUse : []
    if (!hasAskGroup(groups, askRunnerPath)) {
      nextHooks.PreToolUse = [...groups, { matcher: ASK_MATCHER, hooks: [askHandlerFor(askRunnerPath)] }]
      if (!changed.includes('PreToolUse')) changed.push('PreToolUse')
    }
  }

  if (changed.length) {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      const backupDir = backupsDir(root)
      mkdirSync(backupDir, { recursive: true })
      copyFileSync(file, join(backupDir, `settings.local.json.${Date.now()}`))
    }
    settings.hooks = nextHooks
    writeFileSync(file, JSON.stringify(settings, null, 2) + '\n')
  }

  const registry = loadSettingsFile(hooksRegistryFile(root))
  const runnerPaths = new Set(registry.runnerPaths || [])
  runnerPaths.add(runnerPath)
  if (askRunnerPath) runnerPaths.add(askRunnerPath)
  mkdirSync(agentwatchDir(root), { recursive: true })
  writeFileSync(hooksRegistryFile(root), JSON.stringify({ runnerPaths: [...runnerPaths], installedAt: Date.now() }, null, 2) + '\n')

  return { changed, runnerPath }
}

export function uninstallHooks(root, runnerPath) {
  const file = settingsLocalFile(root)
  const registry = loadSettingsFile(hooksRegistryFile(root))
  const registered = new Set(registry.runnerPaths || [])
  const targets = new Set(runnerPath != null ? [runnerPath].flat() : [...registered])

  const settings = loadSettingsFile(file)
  const prevHooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {}
  const removed = []
  for (const event of HOOK_EVENTS) {
    const groups = Array.isArray(prevHooks[event]) ? prevHooks[event] : []
    const kept = []
    let dropped = false
    for (const group of groups) {
      if (Array.isArray(group && group.hooks)) {
        const handlers = group.hooks.filter((h) => ![...targets].some((p) => isOurs(h, p)))
        if (handlers.length !== group.hooks.length) dropped = true
        if (handlers.length) kept.push({ ...group, hooks: handlers })
      } else {
        kept.push(group)
      }
    }
    if (dropped) removed.push(event)
    if (kept.length) prevHooks[event] = kept
    else delete prevHooks[event]
  }

  const next = { ...settings, hooks: prevHooks }
  if (Object.keys(prevHooks).length === 0) delete next.hooks

  const backupDir = backupsDir(root)
  mkdirSync(backupDir, { recursive: true })
  if (existsSync(file)) {
    renameSync(file, join(backupDir, `settings.local.json.${Date.now()}.pre-uninstall`))
  }
  if (Object.keys(next).length) {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(next, null, 2) + '\n')
  }

  const remaining = []
  for (const p of registered) {
    if (targets.has(p)) continue
    const still = HOOK_EVENTS.some((ev) => {
      const groups = Array.isArray(next.hooks && next.hooks[ev]) ? next.hooks[ev] : []
      return groups.some((g) => Array.isArray(g && g.hooks) && g.hooks.some((h) => isOurs(h, p)))
    })
    if (still) remaining.push(p)
  }
  if (!remaining.length) {
    try {
      renameSync(hooksRegistryFile(root), join(backupDir, `hooks.json.${Date.now()}.removed`))
    } catch {}
  } else {
    writeFileSync(hooksRegistryFile(root), JSON.stringify({ runnerPaths: remaining, installedAt: registry.installedAt || Date.now() }, null, 2) + '\n')
  }

  return { removed, runnerPaths: remaining }
}