#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, statSync, truncateSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

const MAX_QUEUE_BYTES = 4 * 1024 * 1024

function findRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.claude')) || existsSync(join(dir, '.git')) || existsSync(join(dir, '.agentwatch'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

let payload
try {
  const input = readFileSync(0, 'utf8').trim()
  payload = input ? JSON.parse(input) : null
} catch {
  process.exit(0)
}
if (!payload) process.exit(0)

const sdkKey = process.env.AGENTWATCH_SDK_KEY
if (sdkKey) {
  const ev = payload.hook_event_name
  if (['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Stop'].includes(ev)) process.exit(0)
  if (!payload.agent_id) {
    payload.agent_id = sdkKey
    payload.agent_type = process.env.AGENTWATCH_SDK_TYPE || 'assistant'
  }
}

try {
  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd())
  const queue = join(root, '.agentwatch', 'events.ndjson')
  mkdirSync(dirname(queue), { recursive: true })
  try {
    if (statSync(queue).size > MAX_QUEUE_BYTES) truncateSync(queue, 0)
  } catch {}
  appendFileSync(queue, JSON.stringify({ ...payload, __ts: Date.now() }) + '\n')
} catch {
  process.exit(0)
}
