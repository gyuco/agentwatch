import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventCollector } from '../src/collector.js'
import { startServer } from '../src/server.js'
import { scanCatalog } from '../src/scan.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'

function fixture() {
  return mkdtempSync(join(tmpdir(), 'aw-server-'))
}

function makeEv(event, extra = {}) {
  return { hook_event_name: event, session_id: 's1', __ts: 1000, ...extra }
}

function httpJson(port, path, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = !(typeof body === 'string') && body != null ? JSON.stringify(body) : body
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      agent: false,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers }
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: () => JSON.parse(buf || 'null') })
        } catch {
          resolve({ status: res.statusCode, json: () => null })
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

test('endpoints: state, hooks, rescan, stop, hook ingestion, SSE snapshot', async (t) => {
  const root = fixture()
  const collector = new EventCollector()
  let stopped = false
  const app = startServer({
    collector,
    project: root,
    catalog: scanCatalog(root),
    onRescan: () => scanCatalog(root),
    onStop: () => { stopped = true }
  })
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const state1 = await httpJson(port, '/api/state')
  assert.equal(state1.json().project, root)
  assert.equal(state1.json().catalog.agents.length, 0)

  const res = await httpJson(port, '/hook', {
    method: 'POST',
    body: makeEv('SubagentStart', { agent_id: 'a1', agent_type: 'coder' })
  })
  assert.equal(res.json().event, 'SubagentStart')

  const state2 = await httpJson(port, '/api/state')
  assert.deepEqual(state2.json().collector.running, ['a1'])

  const hooks = await httpJson(port, '/api/hooks')
  assert.deepEqual(hooks.json().hooks, [])

  const rescan = await httpJson(port, '/api/rescan', { method: 'POST' })
  assert.deepEqual(rescan.json(), { agents: [], skills: [], mcps: [] })

  const sse = await readSse(port, '/events', (buf) => buf.includes('event: snapshot'))
  const m = sse.match(/event: snapshot\ndata: (.*)/)
  const snapshot = JSON.parse(m[1])
  assert.equal(snapshot.collector.running[0], 'a1')

  await httpJson(port, '/api/stop', { method: 'POST' })
  assert.equal(stopped, true)
  const bad = await httpJson(port, '/hook', { method: 'POST', body: '{bad' })
  assert.equal(bad.status, 400)
})

test('transcript resolves subagents unknown to the collector via the main session path', async (t) => {
  const root = fixture()
  const collector = new EventCollector()
  const app = startServer({ collector, project: root, catalog: { agents: [], skills: [] } })
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const mainPath = join(root, 'session-main.jsonl')
  collector.ingest(makeEv('Stop', { transcript_path: mainPath }))
  const subId = 'a2609e7a00da181c0'
  collector.ingest(makeEv('PreToolUse', { agent_id: subId, agent_type: 'coder', tool_name: 'Bash', tool_input: { command: 'ls' } }))

  const missing = await httpJson(port, '/api/transcript?agent=' + subId)
  assert.equal(missing.status, 200)
  assert.equal(missing.json().found, false)

  const subDir = join(root, 'session-main', 'subagents')
  mkdirSync(subDir, { recursive: true })
  writeFileSync(join(subDir, `agent-${subId}.jsonl`), JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello from subagent' }] } }) + '\n')

  const hit = await httpJson(port, '/api/transcript?agent=' + subId)
  assert.equal(hit.status, 200)
  assert.equal(hit.json().found, true)
  assert.equal(hit.json().messages[0].blocks[0].text, 'hello from subagent')

  const ghost = await httpJson(port, '/api/transcript?agent=nope')
  assert.equal(ghost.json().found, false)
})

test('agent meeting seats participants, shares turns, and keeps a transcript', async (t) => {
  const root = fixture()
  const queryAgent = ({ prompt, options }) => (async function * () {
    yield {
      type: 'assistant',
      session_id: `session-${options.agent}`,
      message: { content: [{ type: 'text', text: `${options.agent} contribution about ${prompt.includes('Conversation so far:') ? 'the discussion' : 'the topic'}` }] }
    }
    yield { type: 'result', result: 'done', duration_ms: 5, total_cost_usd: 0, usage: {} }
  })()
  const catalog = {
    agents: [
      { id: 'architect', name: 'Architect', tools: [] },
      { id: 'reviewer', name: 'Reviewer', tools: [] }
    ],
    skills: [],
    mcps: []
  }
  const app = startServer({ collector: new EventCollector(), project: root, catalog, queryAgent })
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const started = await httpJson(port, '/api/meeting/start', {
    method: 'POST',
    body: { topic: 'Choose the safest API design', participants: ['architect', 'reviewer'], rounds: 2 }
  })
  assert.equal(started.status, 200)
  assert.equal(started.json().meeting.status, 'running')

  let meeting
  for (let i = 0; i < 20; i++) {
    const current = await httpJson(port, '/api/state')
    meeting = current.json().meeting
    if (meeting.status !== 'running') break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(meeting.status, 'completed')
  assert.equal(meeting.transcript.length, 4)
  assert.deepEqual(meeting.transcript.map((line) => line.agentId), ['architect', 'reviewer', 'architect', 'reviewer'])
  assert.equal(meeting.transcript[3].text.includes('the discussion'), true)
  const state = await httpJson(port, '/api/state')
  assert.equal(state.json().seats.length, 0)
})

test('calendar events persist in the workspace and can be deleted', async (t) => {
  const root = fixture()
  const app = startServer({ collector: new EventCollector(), project: root, catalog: { agents: [], skills: [] } })
  await app.listen()
  t.after(() => app.close())

  const empty = await httpJson(app.port(), '/api/calendar')
  assert.deepEqual(empty.json(), { events: [] })

  const startsAt = new Date(2027, 2, 18, 14, 30).getTime()
  const saved = await httpJson(app.port(), '/api/calendar/save', {
    method: 'POST',
    body: { title: 'Release review', text: 'Prepare the changelog', startsAt }
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json().event.title, 'Release review')
  assert.equal(saved.json().event.startsAt, startsAt)

  const persisted = JSON.parse(readFileSync(join(root, '.agentwatch', 'calendar.json'), 'utf8'))
  assert.equal(persisted.events[0].text, 'Prepare the changelog')

  const invalid = await httpJson(app.port(), '/api/calendar/save', {
    method: 'POST', body: { title: '', startsAt }
  })
  assert.equal(invalid.status, 400)

  const removed = await httpJson(app.port(), '/api/calendar/delete', {
    method: 'POST', body: { id: saved.json().event.id }
  })
  assert.equal(removed.status, 200)
  const after = await httpJson(app.port(), '/api/calendar')
  assert.deepEqual(after.json(), { events: [] })
})

test('stories endpoint reads docs/stories with status and lane', async (t) => {
  const root = fixture()
  const storiesDir = join(root, 'docs', 'stories')
  mkdirSync(storiesDir, { recursive: true })
  writeFileSync(join(storiesDir, 'EP-1.1-foo.md'),
    '# Story: EP-1.1 — Foo\n\n<!-- status: draft | in-progress | done -->\nstatus: draft\n<!-- lane -->\nlane: backend\n\n## Context\n')
  writeFileSync(join(storiesDir, 'EP-2.1-bar.md'),
    '# Story: EP-2.1 — Bar\n\nstatus: in-progress\nlane: infra\n')
  writeFileSync(join(storiesDir, '_TEMPLATE.md'), '# Story: T\n\nstatus: draft\n')
  writeFileSync(join(storiesDir, 'README.md'), '# stories\n')
  const app = startServer({ collector: new EventCollector(), project: root, catalog: { agents: [], skills: [] } })
  await app.listen()
  t.after(() => app.close())
  const res = await httpJson(app.port(), '/api/stories')
  assert.deepEqual(res.json().stories, [
    { file: 'EP-1.1-foo.md', title: 'EP-1.1 — Foo', status: 'draft', lane: 'backend' },
    { file: 'EP-2.1-bar.md', title: 'EP-2.1 — Bar', status: 'in-progress', lane: 'infra' }
  ])
})

test('stories endpoint returns empty list when docs/stories is missing', async (t) => {
  const root = fixture()
  const app = startServer({ collector: new EventCollector(), project: root, catalog: { agents: [], skills: [] } })
  await app.listen()
  t.after(() => app.close())
  const res = await httpJson(app.port(), '/api/stories')
  assert.deepEqual(res.json(), { stories: [] })
})

test('dashboard html is served at /', async (t) => {
  const root = fixture()
  const app = startServer({ collector: new EventCollector(), project: root, catalog: { agents: [], skills: [] } })
  await app.listen()
  t.after(() => app.close())
  const res = await httpJson(app.port(), '/')
  assert.equal(res.status, 200)
  const body = await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${app.port()}/`, { agent: false }, (r) => {
      let buf = ''
      r.on('data', (c) => { buf += c })
      r.on('end', () => resolve(buf))
    })
    req.on('error', reject)
    req.end()
  })
  assert.ok(body.includes('agentwatch'))
  assert.ok(body.includes('/app.js'))
  assert.ok(body.includes('/style.css'))
  assert.ok(body.includes('id="teamModal"'))
  assert.ok(body.includes('id="teamManageBtn"'))
  assert.ok(body.includes('id="teamPrompt"'))
  assert.ok(body.includes('id="teamPromptSend"'))
  assert.ok(body.includes('id="teamPromptCopy"'))
  assert.ok(body.includes('class="drawer d1" title="team"'))
  assert.ok(!body.includes('docs/prd.md'))
  assert.ok(!body.includes('onboardModal'))
  const js = await httpJson(app.port(), '/app.js')
  assert.equal(js.status, 200)
  assert.ok(await new Promise((resolve, reject) => {
    const req = request(`http://127.0.0.1:${app.port()}/app.js`, { agent: false }, (r) => {
      let buf = ''
      r.on('data', (c) => { buf += c })
      r.on('end', () => resolve(buf.includes('EventSource')))
    })
    req.on('error', reject)
    req.end()
  }))
})
