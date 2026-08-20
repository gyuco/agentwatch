#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

const ASK_TOOLS = new Set(['AskUserQuestion', 'Question'])
const POLL_MS = 700
const MAX_WAIT_MS = 290000

function findRoot(start) {
  let dir = start
  for (;;) {
    if (existsSync(join(dir, '.claude')) || existsSync(join(dir, '.git')) || existsSync(join(dir, '.agentwatch'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

function readPort(root) {
  try {
    const n = Number(readFileSync(join(root, '.agentwatch', 'port'), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function readHubPort() {
  try {
    const home = process.env.AGENTWATCH_HOME || join(homedir(), '.agentwatch')
    const n = Number(readFileSync(join(home, 'hub.port'), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function askFromInput(input = {}) {
  const qs = Array.isArray(input.questions) && input.questions.length ? input.questions : [input]
  const first = qs[0]
  if (!first || typeof first !== 'object') return null
  const q = typeof first.question === 'string' ? first.question : first.prompt
  if (!q) return null
  return {
    question: q.slice(0, 300),
    header: typeof first.header === 'string' ? first.header : '',
    options: Array.isArray(first.options)
      ? first.options.map((o) => (typeof o === 'string' ? o : (o && o.label) || '')).filter(Boolean).slice(0, 5)
      : []
  }
}

function allow() {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } }))
  process.exit(0)
}

function denyWithAnswer(option) {
  const reason = `The user answered this question from the agentwatch dashboard: "${option}". Treat this as the user's response and continue the conversation accordingly — do not ask the question again.`
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason
      }
    })
  )
  process.exit(0)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function main() {
  let payload
  try {
    const input = readFileSync(0, 'utf8').trim()
    payload = input ? JSON.parse(input) : null
  } catch {
    return allow()
  }
  if (!payload || !ASK_TOOLS.has(payload.tool_name)) return allow()

  const ask = askFromInput(payload.tool_input)
  if (!ask) return allow()

  const root = findRoot(process.env.CLAUDE_PROJECT_DIR || process.cwd())
  const candidates = []
  const localPort = readPort(root)
  if (localPort) candidates.push(localPort)
  const hubPort = readHubPort()
  if (hubPort && hubPort !== localPort) candidates.push(hubPort)
  if (!candidates.length) return allow()

  const id = randomUUID()
  const body = {
    id,
    sessionId: payload.session_id || '',
    agentId: payload.agent_id || 'main',
    agentType: payload.agent_type || 'main',
    question: ask.question,
    header: ask.header,
    options: ask.options,
    project: root
  }

  let base = null
  for (const port of candidates) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/ask/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
      if (res.ok) {
        base = `http://127.0.0.1:${port}`
        break
      }
    } catch {}
  }
  if (!base) return allow()

  const deadline = Date.now() + MAX_WAIT_MS
  while (Date.now() < deadline) {
    await sleep(POLL_MS)
    try {
      const res = await fetch(`${base}/api/ask/poll?id=${encodeURIComponent(id)}&project=${encodeURIComponent(root)}`)
      if (res.ok) {
        const data = await res.json()
        if (data && data.answered) return denyWithAnswer(data.option || '')
      }
    } catch {
      return allow()
    }
  }
  return allow()
}

main().catch(() => allow())
