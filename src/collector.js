import { readFileSync } from 'node:fs'

export const MAIN_ID = 'main'

function toolSummary(name, input = {}) {
  const pick = [input.file_path, input.filePath, input.command, input.pattern, input.query, input.url, input.path]
    .filter((v) => typeof v === 'string' && v)
    .map((v) => (v.length > 90 ? v.slice(0, 90) + '…' : v))
  return pick.length ? pick[0] : ''
}

function skillNameFromInput(input = {}) {
  const cands = [input.name, input.skill_name, input.skill, input.skillName]
  for (const c of cands) {
    if (typeof c === 'string' && c) return c
  }
  return null
}

const ASK_TOOLS = new Set(['AskUserQuestion', 'Question'])

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

export class EventCollector {
  constructor({ maxEvents = 600 } = {}) {
    this.maxEvents = maxEvents
    this.agents = new Map()
    this.events = []
    this.seq = 0
    this.pendingTools = new Map()
    this.tasks = new Map()
    this.sessions = new Map()
    this.startedAt = Date.now()
    this.usage = {
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      perModel: new Map(),
      lastUpdated: null
    }
    this.transcripts = new Map()
  }

  trackTranscript(path, sessionId) {
    if (typeof path !== 'string' || !path) return
    if (!this.transcripts.has(path)) {
      this.transcripts.set(path, { sessionId: sessionId || '?', offset: 0 })
      if (this.transcripts.size > 50) this.transcripts.delete(this.transcripts.keys().next().value)
    }
  }

  addUsage({ costUsd, usage = {}, perModel = [] } = {}) {
    const u = this.usage
    const n = (v) => Number(v) || 0
    u.costUsd += n(costUsd)
    u.inputTokens += n(usage.input_tokens ?? usage.inputTokens)
    u.outputTokens += n(usage.output_tokens ?? usage.outputTokens)
    u.cacheRead += n(usage.cache_read_input_tokens ?? usage.cacheRead)
    u.cacheWrite += n(usage.cache_creation_input_tokens ?? usage.cacheWrite)
    const entries = Array.isArray(perModel)
      ? perModel
      : perModel && typeof perModel === 'object'
        ? Object.entries(perModel).map(([model, stats]) => ({ model, ...stats }))
        : []
    for (const m of entries) {
      if (!m || !m.model) continue
      const row = u.perModel.get(m.model) || { model: m.model, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }
      row.inputTokens += n(m.input_tokens ?? m.inputTokens)
      row.outputTokens += n(m.output_tokens ?? m.outputTokens)
      row.cacheRead += n(m.cache_read_input_tokens ?? m.cacheRead ?? m.cacheReadInputTokens)
      row.cacheWrite += n(m.cache_creation_input_tokens ?? m.cacheWrite ?? m.cacheCreationInputTokens)
      row.costUsd += n(m.total_cost_usd ?? m.cost_usd ?? m.costUsd ?? m.costUSD)
      u.perModel.set(m.model, row)
    }
    u.lastUpdated = Date.now()
  }

  ingestTranscript(chunk) {
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry.type !== 'assistant') continue
      const msg = entry.message || {}
      const usage = msg.usage
      if (!usage || typeof usage !== 'object') continue
      const cost = typeof msg.cost === 'number' ? msg.cost : (msg.cost && msg.cost.total)
      const perModel = msg.model
        ? [{ model: msg.model, input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, cache_creation_input_tokens: usage.cache_creation_input_tokens, cache_read_input_tokens: usage.cache_read_input_tokens, total_cost_usd: cost }]
        : []
      this.addUsage({ costUsd: cost, usage, perModel })
    }
  }

  pollTranscripts() {
    for (const [path, info] of this.transcripts) {
      let data
      try {
        data = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      let offset = info.offset || 0
      if (data.length < offset) offset = 0
      const chunk = data.slice(offset)
      const nl = chunk.lastIndexOf('\n')
      if (nl < 0) continue
      info.offset = offset + nl + 1
      this.ingestTranscript(chunk.slice(0, nl))
    }
  }

  usageSummary() {
    const u = this.usage
    return {
      costUsd: u.costUsd,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheRead: u.cacheRead,
      cacheWrite: u.cacheWrite,
      perModel: [...u.perModel.values()].sort((a, b) => b.costUsd - a.costUsd),
      lastUpdated: u.lastUpdated,
      trackedTranscripts: this.transcripts.size
    }
  }

  agentFor(payload, { create = true } = {}) {
    const agentId = payload.agent_id || MAIN_ID
    let agent = this.agents.get(agentId)
    if (!agent) {
      if (!create && agentId !== MAIN_ID) return null
      agent = {
        id: agentId,
        type: payload.agent_type || (agentId === MAIN_ID ? MAIN_ID : ''),
        isMain: agentId === MAIN_ID,
        status: 'running',
        startedAt: this.ts(payload),
        endedAt: null,
        lastTool: null,
        lastMessage: '',
        lastError: null,
        skills: new Map(),
        promptCount: 0,
        lastPrompt: '',
        turns: 0,
        model: null
      }
      this.agents.set(agentId, agent)
    }
    if (!agent.type && payload.agent_type) agent.type = payload.agent_type
    return agent
  }

  ts(payload) {
    return typeof payload.__ts === 'number' ? payload.__ts : Date.now()
  }

  push(event) {
    this.events.push(event)
    if (this.events.length > this.maxEvents) this.events.shift()
  }

  ingest(raw) {
    let payload = raw
    if (raw && typeof raw === 'object' && 'event' in raw && 'payload' in raw) {
      payload = raw.payload
      payload.hook_event_name = raw.event
    }
    if (!payload || typeof payload !== 'object') return null
    const event = payload.hook_event_name
    if (!event) return null
    const ts = this.ts(payload)
    const seq = ++this.seq
    this.sessions.set(payload.session_id || '?', true)

    switch (event) {
      case 'SessionStart': {
        const main = this.agentFor({ ...payload, agent_type: 'main' })
        if (!main.startedAt) main.startedAt = ts
        if (payload.model) main.model = payload.model
        break
      }
      case 'SessionEnd': {
        for (const agent of this.agents.values()) {
          if (agent.status !== 'done') {
            agent.status = 'ended'
            agent.endedAt = ts
          }
        }
        break
      }
      case 'UserPromptSubmit': {
        const main = this.agentFor({ ...payload, agent_type: 'main' })
        main.promptCount += 1
        main.lastPrompt = (payload.prompt || '').slice(0, 200)
        break
      }
      case 'Stop': {
        const main = this.agentFor({ ...payload, agent_type: 'main' })
        main.turns += 1
        this.trackTranscript(payload.transcript_path, payload.session_id)
        break
      }
      case 'SessionEnd': {
        this.trackTranscript(payload.transcript_path, payload.session_id)
        break
      }
      case 'SubagentStart': {
        const agent = this.agentFor(payload)
        agent.status = 'running'
        agent.startedAt = ts
        break
      }
      case 'SubagentStop': {
        const agent = this.agentFor(payload)
        agent.status = 'done'
        agent.endedAt = ts
        agent.lastMessage = (payload.last_assistant_message || '').slice(0, 300)
        if (payload.agent_transcript_path) agent.transcriptPath = payload.agent_transcript_path
        this.trackTranscript(payload.agent_transcript_path, payload.session_id)
        break
      }
      case 'PreToolUse': {
        const agent = this.agentFor(payload, { create: false })
        if (!agent) break
        const key = payload.tool_use_id || `${seq}`
        const skill = payload.tool_name === 'Skill' ? skillNameFromInput(payload.tool_input) : null
        this.pendingTools.set(key, {
          name: payload.tool_name,
          summary: toolSummary(payload.tool_name, payload.tool_input),
          skill,
          agentId: agent.id,
          at: ts
        })
        if (skill) {
          const s = agent.skills.get(skill) || { name: skill, count: 0, inUse: false, firstUsedAt: ts, lastUsedAt: ts }
          s.inUse = true
          agent.skills.set(skill, s)
        }
        agent.lastTool = { name: payload.tool_name, summary: this.currentSummary(agent, payload.tool_name), status: 'running', at: ts }
        break
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const agent = this.agentFor(payload, { create: false })
        if (!agent) break
        const key = payload.tool_use_id || `${seq}`
        const entry = this.pendingTools.get(key)
        const ok = event === 'PostToolUse'
        if (entry) {
          this.pendingTools.delete(key)
          if (entry.skill) {
            const s = agent.skills.get(entry.skill)
            if (s) {
              s.inUse = false
              s.count += 1
              s.lastUsedAt = ts
            }
          }
          const summary = toolSummary(entry.name, payload.tool_input)
          agent.lastTool = {
            name: entry.name,
            summary,
            status: ok ? 'ok' : 'error',
            durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
            at: ts
          }
          if (!ok) agent.lastError = entry.summary
        }
        break
      }
      case 'TaskCreated': {
        this.tasks.set(payload.task_id, {
          id: payload.task_id,
          subject: payload.task_subject || '',
          status: 'running',
          at: ts
        })
        break
      }
      case 'TaskCompleted': {
        const task = this.tasks.get(payload.task_id)
        if (task) task.status = 'done'
        break
      }
      case 'ForceClear': {
        const agent = this.agentFor(payload)
        agent.status = 'ended'
        agent.endedAt = ts
        if (agent.lastTool && agent.lastTool.status === 'running') {
          agent.lastTool = { ...agent.lastTool, status: 'error' }
        }
        for (const [key, entry] of this.pendingTools) {
          if (entry.agentId === agent.id) this.pendingTools.delete(key)
        }
        break
      }
    }

    const record = {
      seq,
      ts,
      event,
      agentId: payload.agent_id || MAIN_ID,
      agentType: payload.agent_type || MAIN_ID,
      sessionId: payload.session_id || '',
      toolName: payload.tool_name,
      summary: payload.tool_name ? toolSummary(payload.tool_name, payload.tool_input) : '',
      skill: payload.tool_name === 'Skill' ? skillNameFromInput(payload.tool_input) : null,
      prompt: event === 'UserPromptSubmit' ? (payload.prompt || '').slice(0, 200) : null,
      taskId: event === 'TaskCreated' || event === 'TaskCompleted' ? payload.task_id || null : null,
      taskSubject: event === 'TaskCreated' ? payload.task_subject || '' : null,
      taskStatus: event === 'TaskCompleted' ? 'done' : null,
      lastMessage: event === 'SubagentStop' ? (payload.last_assistant_message || '').slice(0, 200) : null,
      durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
      error: event === 'PostToolUseFailure' ? true : null,
      model: event === 'SessionStart' && payload.model ? payload.model : null,
      ask: event === 'PreToolUse' && ASK_TOOLS.has(payload.tool_name)
        ? askFromInput(payload.tool_input)
        : event === 'PostToolUse' && ASK_TOOLS.has(payload.tool_name)
          ? null
          : undefined
    }
    this.push(record)
    return record
  }

  currentSummary(agent, toolName) {
    let latest = null
    for (const entry of this.pendingTools.values()) {
      if (entry.agentId === agent.id && (!latest || entry.at > latest.at)) latest = entry
    }
    return latest ? latest.summary : ''
  }

  runningAgents() {
    return [...this.agents.values()].filter((a) => a.status === 'running' || a.status === 'started')
  }

  snapshot() {
    const agents = [...this.agents.values()].map((a) => {
      const pending = [...this.pendingTools.values()].filter((p) => p.agentId === a.id).sort((x, y) => y.at - x.at)
      return {
        id: a.id,
        type: a.type,
        isMain: a.isMain,
        status: a.status,
        startedAt: a.startedAt,
        endedAt: a.endedAt,
        lastTool: pending[0] ? { name: pending[0].name, summary: pending[0].summary, status: 'running' } : a.lastTool,
        lastMessage: a.lastMessage,
        lastError: a.lastError,
        skills: [...a.skills.values()].sort((x, y) => y.lastUsedAt - x.lastUsedAt),
        promptCount: a.promptCount,
        lastPrompt: a.lastPrompt,
        turns: a.turns,
        model: a.model
      }
    })
    return {
      uptime: Date.now() - this.startedAt,
      agents,
      running: this.runningAgents().map((a) => a.id),
      tasks: [...this.tasks.values()]
        .sort((x, y) => (x.status === y.status ? y.at - x.at : x.status === 'running' ? -1 : 1))
        .slice(0, 20),
      usage: this.usageSummary(),
      events: this.events.slice(-200)
    }
  }
}
