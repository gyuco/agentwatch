import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventCollector } from '../src/collector.js'

function ev(event, extra = {}) {
  return { hook_event_name: event, session_id: 's1', __ts: 1000, ...extra }
}

test('subagent lifecycle: start → tool with skill → stop', () => {
  const c = new EventCollector()
  c.ingest(ev('SubagentStart', { agent_id: 'a1', agent_type: 'coder', __ts: 10 }))
  c.ingest(ev('PreToolUse', { agent_id: 'a1', agent_type: 'coder', tool_name: 'Skill', tool_use_id: 't1', tool_input: { name: 'python-backend' }, __ts: 20 }))
  c.ingest(ev('PreToolUse', { agent_id: 'a1', agent_type: 'coder', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: '/x/src/y.py' }, __ts: 30 }))
  c.ingest(ev('PostToolUse', { agent_id: 'a1', agent_type: 'coder', tool_name: 'Edit', tool_use_id: 't2', tool_input: { file_path: '/x/src/y.py' }, duration_ms: 400, __ts: 40 }))
  c.ingest(ev('PostToolUse', { agent_id: 'a1', agent_type: 'coder', tool_name: 'Skill', tool_use_id: 't1', tool_input: { name: 'python-backend' }, duration_ms: 200, __ts: 50 }))
  c.ingest(ev('SubagentStop', { agent_id: 'a1', agent_type: 'coder', last_assistant_message: 'Done.', __ts: 60 }))

  const snap = c.snapshot()
  const agent = snap.agents.find((a) => a.id === 'a1')
  assert.equal(agent.status, 'done')
  assert.equal(agent.lastMessage, 'Done.')
  assert.equal(agent.lastTool.name, 'Skill')
  assert.equal(agent.lastTool.status, 'ok')
  assert.equal(agent.lastTool.durationMs, 200)
  const editEvent = snap.events.find((e) => e.toolName === 'Edit' && e.event === 'PostToolUse')
  assert.equal(editEvent.summary, '/x/src/y.py')
  assert.equal(editEvent.durationMs, 400)
  assert.equal(agent.skills.length, 1)
  assert.equal(agent.skills[0].name, 'python-backend')
  assert.equal(agent.skills[0].count, 1)
  assert.equal(agent.skills[0].inUse, false)
  assert.deepEqual(snap.running, [])
})

test('running subagent shows pending tool and in-use skill', () => {
  const c = new EventCollector()
  c.ingest(ev('SubagentStart', { agent_id: 'a2', agent_type: 'reviewer', __ts: 10 }))
  c.ingest(ev('PreToolUse', { agent_id: 'a2', agent_type: 'reviewer', tool_name: 'Skill', tool_use_id: 't9', tool_input: { name: 'quality-gates' }, __ts: 20 }))
  const snap = c.snapshot()
  const agent = snap.agents.find((a) => a.id === 'a2')
  assert.deepEqual(snap.running, ['a2'])
  assert.equal(agent.lastTool.status, 'running')
  assert.equal(agent.lastTool.name, 'Skill')
  assert.equal(agent.skills[0].inUse, true)
})

test('main agent activity is tracked without agent_id', () => {
  const c = new EventCollector()
  c.ingest(ev('SessionStart', { __ts: 5 }))
  c.ingest(ev('UserPromptSubmit', { prompt: 'implement story 3', __ts: 10 }))
  c.ingest(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'uv run pytest tests' }, __ts: 15 }))
  c.ingest(ev('Stop', { __ts: 20 }))
  const snap = c.snapshot()
  const main = snap.agents.find((a) => a.isMain)
  assert.ok(main)
  assert.equal(main.lastTool.status, 'running')
  assert.equal(main.lastPrompt, 'implement story 3')
  assert.equal(main.promptCount, 1)
  assert.equal(main.turns, 1)
  const feed = snap.events.map((e) => e.event)
  assert.ok(feed.includes('UserPromptSubmit'))
  assert.ok(feed.includes('PreToolUse'))
  assert.ok(feed.includes('Stop'))
})

test('tool failure closes pending tool with error', () => {
  const c = new EventCollector()
  c.ingest(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'rm -rf /' }, __ts: 10 }))
  c.ingest(ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'x1', tool_input: { command: 'rm -rf /' }, __ts: 20 }))
  c.ingest(ev('SubagentStart', { agent_id: 's1', agent_type: 'explore', __ts: 30 }))
  const snap = c.snapshot()
  const main = snap.agents.find((a) => a.isMain)
  assert.equal(main.lastTool.status, 'error')
  assert.equal(main.lastTool.summary, 'rm -rf /')
  const events = snap.events.filter((e) => e.event === 'PostToolUseFailure')
  assert.equal(events[0].error, true)
})

test('task lifecycle tracked', () => {
  const c = new EventCollector()
  c.ingest(ev('TaskCreated', { task_id: 't1', task_subject: 'add endpoint', __ts: 10 }))
  c.ingest(ev('TaskCompleted', { task_id: 't1', task_subject: 'add endpoint', __ts: 20 }))
  const snap = c.snapshot()
  assert.equal(snap.tasks[0].status, 'done')
  assert.equal(snap.tasks[0].subject, 'add endpoint')
})

test('events are bounded', () => {
  const c = new EventCollector({ maxEvents: 5 })
  for (let i = 0; i < 10; i++) c.ingest(ev('Stop', { __ts: i }))
  assert.equal(c.events.length, 5)
  assert.equal(c.events[4].seq, 10)
})

test('session end closes running agents', () => {
  const c = new EventCollector()
  c.ingest(ev('SubagentStart', { agent_id: 'z', agent_type: 'coder', __ts: 10 }))
  c.ingest(ev('SessionEnd', { __ts: 40 }))
  const snap = c.snapshot()
  assert.deepEqual(snap.running, [])
  assert.equal(snap.agents.find((a) => a.id === 'z').status, 'ended')
})

test('ingest tolerates garbage and unknown events', () => {
  const c = new EventCollector()
  assert.equal(c.ingest(null), null)
  assert.equal(c.ingest({ foo: 1 }), null)
  assert.equal(c.ingest(ev('TotallyUnknown', { a: 1 }))?.event, 'TotallyUnknown')
})

test('addUsage accepts perModel as an array (transcript polling shape)', () => {
  const c = new EventCollector()
  c.addUsage({ costUsd: 0.02, usage: { input_tokens: 10 }, perModel: [{ model: 'claude-sonnet-5', input_tokens: 10, total_cost_usd: 0.02 }] })
  const summary = c.usageSummary()
  assert.equal(summary.perModel.length, 1)
  assert.equal(summary.perModel[0].model, 'claude-sonnet-5')
  assert.equal(summary.perModel[0].inputTokens, 10)
})

test('addUsage accepts perModel as an object map (SDK modelUsage shape)', () => {
  const c = new EventCollector()
  c.addUsage({
    costUsd: 0.03,
    usage: { input_tokens: 20 },
    perModel: { 'claude-sonnet-5': { inputTokens: 20, outputTokens: 5, costUSD: 0.03 } }
  })
  const summary = c.usageSummary()
  assert.equal(summary.perModel.length, 1)
  assert.equal(summary.perModel[0].model, 'claude-sonnet-5')
  assert.equal(summary.perModel[0].inputTokens, 20)
  assert.equal(summary.perModel[0].costUsd, 0.03)
})

test('addUsage tolerates missing perModel', () => {
  const c = new EventCollector()
  assert.doesNotThrow(() => c.addUsage({ costUsd: 0.01, usage: {} }))
  assert.equal(c.usageSummary().perModel.length, 0)
})