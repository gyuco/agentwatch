import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

export function findProjectRoot(start = process.cwd()) {
  if (process.env.AGENTWATCH_PROJECT) return resolve(process.env.AGENTWATCH_PROJECT)
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.git')) || existsSync(join(dir, '.claude')) || existsSync(join(dir, '.agentwatch'))) {
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return resolve(start)
    dir = parent
  }
}

export function agentwatchDir(root) {
  return join(root, '.agentwatch')
}

export function queueFile(root) {
  return join(agentwatchDir(root), 'events.ndjson')
}

export function portFile(root) {
  return join(agentwatchDir(root), 'port')
}

export function hooksRegistryFile(root) {
  return join(agentwatchDir(root), 'hooks.json')
}

export function backupsDir(root) {
  return join(agentwatchDir(root), 'backups')
}

export function settingsLocalFile(root) {
  return join(root, '.claude', 'settings.local.json')
}
