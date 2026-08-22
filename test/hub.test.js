import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startHubServer } from '../src/server.js'
import { addOffice, loadOffices } from '../src/offices.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { request } from 'node:http'

function fixture() {
  process.env.AGENTWATCH_HOME = mkdtempSync(join(tmpdir(), 'aw-hub-'))
}

function httpJson(port, path, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const data = !(typeof body === 'string') && body != null ? JSON.stringify(body) : body
    const req = request(`http://127.0.0.1:${port}${path}`, {
      method,
      agent: false,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}) }
    }, (res) => {
      let buf = ''
      res.on('data', (c) => { buf += c })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, json: () => JSON.parse(buf || 'null'), text: () => buf })
        } catch {
          resolve({ status: res.statusCode, json: () => null, text: () => buf })
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

test('hub: map at /, offices listing, per-office dashboard and APIs, office create/remove', async (t) => {
  fixture()
  const home = process.env.AGENTWATCH_HOME
  const officeA = addOffice({ name: 'Ufficio A', path: join(home, 'office-a') })
  const officeB = addOffice({ name: 'Ufficio B', path: join(home, 'office-b') })

  let stopped = false
  const app = startHubServer({
    runnerPath: '/tmp/run-hook.js',
    onStop: () => { stopped = true },
    pickDirectory: async () => join(home, 'picked-office')
  })
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const map = await httpJson(port, '/')
  assert.equal(map.status, 200)
  assert.ok(map.text().includes('agentwatch'))
  assert.ok(map.text().includes('hall'))
  assert.ok(map.text().includes('/map.js'))

  const offices = await httpJson(port, '/api/offices')
  const list = offices.json().offices
  assert.equal(list.length, 2)
  assert.deepEqual(new Set(list.map((o) => o.id)), new Set(['ufficio-a', 'ufficio-b']))
  const a = list.find((o) => o.id === 'ufficio-a')
  assert.equal(a.agents, 0)
  assert.equal(a.skills, 0)
  assert.equal(a.running, 0)
  assert.equal(a.url, '/office/ufficio-a')

  const picked = await httpJson(port, '/api/office/pick-directory', { method: 'POST' })
  assert.equal(picked.status, 200)
  assert.equal(picked.json().path, join(home, 'picked-office'))

  const dash = await httpJson(port, '/office/ufficio-a/')
  assert.equal(dash.status, 200)
  assert.ok(dash.text().includes("AGW_PREFIX=\"/office/ufficio-a\""))
  assert.ok(dash.text().includes('href="/office/ufficio-a/style.css"'))

  const state = await httpJson(port, '/office/ufficio-a/api/state')
  assert.equal(state.json().project, officeA.path)
  assert.equal(state.json().catalog.agents.length, 0)

  const res = await httpJson(port, '/office/ufficio-a/hook', {
    method: 'POST',
    body: { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'coder', __ts: 1000 }
  })
  assert.equal(res.json().event, 'SubagentStart')
  const state2 = await httpJson(port, '/office/ufficio-a/api/state')
  assert.deepEqual(state2.json().collector.running, ['a1'])

  const stateB = await httpJson(port, '/office/ufficio-b/api/state')
  assert.deepEqual(stateB.json().collector.running, [])

  const sse = await readSse(port, '/office/ufficio-a/events', (buf) => buf.includes('event: snapshot'))
  assert.ok(sse.includes('"a1"'))

  const created = await httpJson(port, '/api/office/new', {
    method: 'POST',
    body: { name: 'Ufficio C', path: join(home, 'office-c') }
  })
  assert.equal(created.json().id, 'ufficio-c')
  assert.ok(existsSync(join(home, 'office-c', 'agentwatch.tasks.json')))
  assert.ok(existsSync(join(home, 'office-c', '.claude', 'agents', 'work-planner.md')))
  assert.ok(existsSync(join(home, 'office-c', '.claude', 'skills', 'work-items', 'SKILL.md')))
  assert.equal(loadOffices().length, 3)

  const removed = await httpJson(port, '/api/office/remove', {
    method: 'POST',
    body: { id: 'ufficio-b' }
  })
  assert.equal(removed.json().ok, true)
  assert.equal(loadOffices().length, 2)

  const offices2 = await httpJson(port, '/api/offices')
  assert.equal(offices2.json().offices.length, 2)
  assert.ok(!offices2.json().offices.some((o) => o.id === 'ufficio-b'))

  const missing = await httpJson(port, '/office/nope/api/state')
  assert.equal(missing.status, 404)

  await httpJson(port, '/api/hub/stop', { method: 'POST' })
  assert.equal(stopped, true)
})

test('hub: office/new with missing path returns 400', async (t) => {
  fixture()
  const app = startHubServer({})
  await app.listen()
  t.after(() => app.close())
  const res = await httpJson(app.port(), '/api/office/new', { method: 'POST', body: {} })
  assert.equal(res.status, 400)
})

test('hub: existing workflow requires modify or overwrite choice', async (t) => {
  fixture()
  const root = join(process.env.AGENTWATCH_HOME, 'existing')
  const existing = { version: 1, paths: ['work'], statuses: ['open', 'closed'], defaultStatus: 'open', custom: 'keep' }
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'agentwatch.tasks.json'), JSON.stringify(existing, null, 2) + '\n')
  const app = startHubServer({ hooksEnabled: false })
  await app.listen()
  t.after(() => app.close())

  const inspected = await httpJson(app.port(), '/api/office/workflow/inspect', { method: 'POST', body: { path: root } })
  assert.equal(inspected.status, 200)
  assert.equal(inspected.json().exists, true)
  assert.equal(inspected.json().config.custom, 'keep')

  const conflict = await httpJson(app.port(), '/api/office/new', { method: 'POST', body: { name: 'Existing', path: root } })
  assert.equal(conflict.status, 409)
  assert.equal(loadOffices().length, 0)

  const modified = await httpJson(app.port(), '/api/office/new', {
    method: 'POST',
    body: { name: 'Existing', path: root, workflow: { mode: 'modify', config: { ...existing, statuses: ['open', 'review', 'closed'] } } }
  })
  assert.equal(modified.status, 200)
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'agentwatch.tasks.json'), 'utf8')).statuses, ['open', 'review', 'closed'])
})

test('hub: ask created at the root routes to the office by project and is answered', async (t) => {
  fixture()
  const home = process.env.AGENTWATCH_HOME
  const officeA = addOffice({ name: 'Ufficio A', path: join(home, 'office-a') })
  const app = startHubServer({})
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const ssePromise = readSse(port, '/office/ufficio-a/events', (buf) => buf.includes('event: ask'))
  await new Promise((r) => setTimeout(r, 30))

  const create = await httpJson(port, '/api/ask/create', {
    method: 'POST',
    body: { id: 'hq1', project: officeA.path, question: 'Deploy?', options: ['Yes', 'No'] }
  })
  assert.equal(create.status, 200)

  const sse = await ssePromise
  assert.match(sse, /"kind":"asked"/)
  assert.match(sse, /"question":"Deploy\?"/)

  const state = await httpJson(port, '/office/ufficio-a/api/state')
  assert.equal(state.json().asks.length, 1)
  assert.equal(state.json().asks[0].id, 'hq1')

  const poll = await httpJson(port, `/api/ask/poll?id=hq1&project=${encodeURIComponent(officeA.path)}`)
  assert.equal(poll.json().answered, false)

  const answer = await httpJson(port, '/office/ufficio-a/api/ask/answer', {
    method: 'POST',
    body: { id: 'hq1', option: 'Yes' }
  })
  assert.equal(answer.status, 200)

  const poll2 = await httpJson(port, `/api/ask/poll?id=hq1&project=${encodeURIComponent(officeA.path)}`)
  assert.equal(poll2.json().answered, true)
  assert.equal(poll2.json().option, 'Yes')
})

test('hub: ask create/poll 404 when the project is not a registered office', async (t) => {
  fixture()
  const app = startHubServer({})
  await app.listen()
  t.after(() => app.close())
  const port = app.port()

  const create = await httpJson(port, '/api/ask/create', {
    method: 'POST',
    body: { id: 'x', project: '/somewhere/else', question: 'Q?' }
  })
  assert.equal(create.status, 404)

  const poll = await httpJson(port, '/api/ask/poll?id=x&project=%2Fsomewhere%2Felse')
  assert.equal(poll.status, 404)
})
