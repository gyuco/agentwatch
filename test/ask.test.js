import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventCollector } from '../src/collector.js'
import { startServer } from '../src/server.js'
import { scanCatalog } from '../src/scan.js'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'
import { spawn } from 'node:child_process'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'aw-ask-'))
}

function httpJson(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      agent: false,
      headers: data ? { 'content-type': 'application/json' } : {}
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(buf || 'null') })
        } catch {
          resolve({ status: res.statusCode, body: null })
        }
      })
    })
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

function readSse(port, path, until) {
  return new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${port}${path}`, { agent: false }, (res) => {
      let buf = ''
      res.on('data', (c) => {
        buf += c
        if (until(buf)) {
          req.destroy()
          resolve(buf)
        }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function withServer(t, fn) {
  const project = fixture()
  const collector = new EventCollector()
  const catalog = scanCatalog(project)
  const server = startServer({ collector, project, catalog, defaultPort: 4890 + Math.floor(Math.random() * 400) })
  await server.listen()
  t.after(() => server.close())
  await fn({ server, project, port: server.port() })
}

test('POST /api/ask/create stores a pending ask and broadcasts it', async (t) => {
  await withServer(t, async ({ port }) => {
    const ssePromise = readSse(port, '/events', (buf) => buf.includes('event: ask'))
    await new Promise((r) => setTimeout(r, 30))
    const create = await httpJson(port, '/api/ask/create', {
      method: 'POST',
      body: { id: 'q1', sessionId: 's1', question: 'Proceed?', options: ['Yes', 'No'] }
    })
    assert.equal(create.status, 200)
    assert.equal(create.body.ok, true)

    const sse = await ssePromise
    assert.match(sse, /"kind":"asked"/)
    assert.match(sse, /"question":"Proceed\?"/)

    const state = await httpJson(port, '/api/state')
    assert.equal(state.body.asks.length, 1)
    assert.equal(state.body.asks[0].id, 'q1')
  })
})

test('GET /api/ask/poll reflects the answer submitted via /api/ask/answer', async (t) => {
  await withServer(t, async ({ port }) => {
    await httpJson(port, '/api/ask/create', { method: 'POST', body: { id: 'q2', question: 'Which?', options: ['A', 'B'] } })

    const before = await httpJson(port, '/api/ask/poll?id=q2')
    assert.equal(before.body.answered, false)

    const answer = await httpJson(port, '/api/ask/answer', { method: 'POST', body: { id: 'q2', option: 'B' } })
    assert.equal(answer.status, 200)

    const after = await httpJson(port, '/api/ask/poll?id=q2')
    assert.equal(after.body.answered, true)
    assert.equal(after.body.option, 'B')

    const state = await httpJson(port, '/api/state')
    assert.equal(state.body.asks.length, 0)
  })
})

test('/api/ask/answer 404s for an unknown id', async (t) => {
  await withServer(t, async ({ port }) => {
    const res = await httpJson(port, '/api/ask/answer', { method: 'POST', body: { id: 'missing', option: 'X' } })
    assert.equal(res.status, 404)
  })
})

function runAskHook({ project, payload }) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [join(import.meta.dirname, '..', 'src', 'ask-hook.js')], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: project },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (c) => { out += c })
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', () => resolve({ out, err }))
    child.stdin.write(JSON.stringify(payload))
    child.stdin.end()
  })
}

test('ask-hook allows immediately when no dashboard port file is present', async () => {
  const project = fixture()
  const { out } = await runAskHook({
    project,
    payload: { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Q?', options: ['Y'] }] }, session_id: 's1' }
  })
  const decision = JSON.parse(out)
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
})

test('ask-hook allows immediately for non-question tools', async () => {
  const project = fixture()
  mkdirSync(join(project, '.agentwatch'), { recursive: true })
  writeFileSync(join(project, '.agentwatch', 'port'), '4999')
  const { out } = await runAskHook({
    project,
    payload: { tool_name: 'Bash', tool_input: { command: 'ls' }, session_id: 's1' }
  })
  const decision = JSON.parse(out)
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'allow')
})

test('ask-hook denies with the dashboard answer once one is posted', async (t) => {
  const project = fixture()
  const collector = new EventCollector()
  const catalog = scanCatalog(project)
  const server = startServer({ collector, project, catalog, defaultPort: 4890 + Math.floor(Math.random() * 400) })
  await server.listen()
  t.after(() => server.close())
  mkdirSync(join(project, '.agentwatch'), { recursive: true })
  writeFileSync(join(project, '.agentwatch', 'port'), String(server.port()))

  const hookPromise = runAskHook({
    project,
    payload: {
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Deploy to prod?', options: ['Yes', 'No'] }] },
      session_id: 's1',
      agent_id: 'main',
      agent_type: 'main'
    }
  })

  await new Promise((r) => setTimeout(r, 200))
  const state = await httpJson(server.port(), '/api/state')
  assert.equal(state.body.asks.length, 1)
  const id = state.body.asks[0].id
  await httpJson(server.port(), '/api/ask/answer', { method: 'POST', body: { id, option: 'Yes' } })

  const { out } = await hookPromise
  const decision = JSON.parse(out)
  assert.equal(decision.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(decision.hookSpecificOutput.permissionDecisionReason, /Yes/)
})
