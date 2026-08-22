
const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const time = (ts) => new Date(ts).toLocaleTimeString('en-GB', { hour12: false })
const dur = (ms) => { const s = Math.floor(ms / 1000); return s >= 3600 ? `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m` : s >= 60 ? `${Math.floor(s/60)}m ${s%60}s` : `${s}s` }
const elapsed = (ts) => Math.max(0, Date.now() - ts)

const state = { catalog: { agents: [], skills: [], mcps: [] }, events: [], byId: new Map(), tasks: [], stories: [], tasksFilter: 'all', connected: false, filter: 'all', filterAgent: null, search: '', seats: new Map(), pendingAsk: null, askQueue: [], notes: [] }

const AGW = (window.AGW_PREFIX || '').replace(/\/+$/, '')
const api = (p) => AGW + p

const SKILL_TOOL = 'Skill'
const ASK_TOOLS = new Set(['AskUserQuestion', 'Question'])
const seatByType = (agentType) => [...state.seats.values()].find((s) => s.agentType === agentType)

function showAskAlert(ask) {
  if (!ask || !ask.id) return
  const existing = state.askQueue.findIndex((item) => item.id === ask.id)
  if (existing >= 0) state.askQueue[existing] = ask
  else state.askQueue.push(ask)
  if (state.pendingAsk && state.pendingAsk.id !== ask.id) return
  state.pendingAsk = ask
  $('#askAlert .ask-q').textContent = ask.question || '…'
  $('#askAlert .ask-opts').innerHTML = (ask.options || [])
    .map((o) => `<button type="button" class="ask-opt" data-option="${esc(o)}">${esc(o)}</button>`)
    .join('')
  $('#askCustomInput').value = ''
  $('#askAlert .ask-hint').textContent = state.askQueue.length > 1
    ? `${state.askQueue.length - 1} more question${state.askQueue.length === 2 ? '' : 's'} waiting`
    : 'answer here, or in the Claude Code terminal'
  for (const el of document.querySelectorAll('#askAlert button, #askCustomInput')) el.disabled = false
  $('#askAlert').classList.add('show')
}

function removeAsk(id) {
  state.askQueue = state.askQueue.filter((ask) => ask.id !== id)
  if (!state.pendingAsk || state.pendingAsk.id !== id) return
  state.pendingAsk = null
  const next = state.askQueue[0]
  if (next) showAskAlert(next)
  else $('#askAlert').classList.remove('show')
}

function replaceAskQueue(asks) {
  state.askQueue = []
  state.pendingAsk = null
  $('#askAlert').classList.remove('show')
  for (const ask of asks || []) showAskAlert(ask)
}

async function answerAsk(id, option) {
  if (!id || !option) return
  for (const el of document.querySelectorAll('#askAlert button, #askCustomInput')) el.disabled = true
  $('#askAlert .ask-hint').textContent = 'sending answer…'
  try {
    const res = await fetch(api('/api/ask/answer'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, option })
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    removeAsk(id)
  } catch {
    if (state.pendingAsk && state.pendingAsk.id === id) {
      $('#askAlert .ask-hint').textContent = 'answer not sent — check the connection and try again'
      for (const el of document.querySelectorAll('#askAlert button, #askCustomInput')) el.disabled = false
    }
  }
}

$('#askAlert .ask-opts').addEventListener('click', (e) => {
  const btn = e.target.closest('.ask-opt')
  if (!btn || !state.pendingAsk) return
  answerAsk(state.pendingAsk.id, btn.dataset.option)
})

function sendCustomAsk() {
  const input = $('#askCustomInput')
  const text = input.value.trim()
  if (!text || !state.pendingAsk) return
  answerAsk(state.pendingAsk.id, text)
}
$('#askCustomSend').addEventListener('click', sendCustomAsk)
$('#askCustomInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCustomAsk() })

const HUES = [210, 150, 300, 25, 100, 250, 180, 340]
const hueFor = (id) => {
  if (id === 'main') return 40
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}

const SLOTS = [
  { x: 161, feetY: 368, desk: '.desk.d1', hue: 210 },
  { x: 341, feetY: 368, desk: '.desk.d2', hue: 150 },
  { x: 521, feetY: 368, desk: '.desk.d3', hue: 300 },
  { x: 701, feetY: 368, desk: '.desk.d4', hue: 25 },
  { x: 881, feetY: 368, desk: '.desk.d5', hue: 100 }
]
const MAIN_SLOT = { x: 520, feetY: 537, desk: '.desk.maindesk' }
const SEAT_SLOTS = [...SLOTS, MAIN_SLOT]
const WALK_Y = 492
const DOOR_BASE_Y = 248
const SPAWN_X = 74
const CHAR_W = 120
const CHAR_H = 118
const SEAT_LIFT = 14
const HAIRS = ['#5a4632', '#2f2a26', '#8a5a2b', '#c98b45', '#7a4a3a', '#4a4a58']
const SKINS = ['#ffd9a0', '#f2c08a', '#e0a877', '#c98a5e', '#a6713f']
const LOOKS = ['look-a', 'look-b', 'look-c', 'look-d']
const hashOf = (id) => { let h = 0; for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return h }
const office = { chars: new Map(), order: [] }

const agentLabel = (rec) => rec.isMain ? 'main agent' : (rec.type || rec.id)
const modelFor = (rec) => {
  if (rec.model) return rec.model
  if (!rec.isMain && rec.type) {
    const cat = state.catalog.agents.find((a) => a.id === rec.type)
    if (cat && cat.model) return cat.model
  }
  const main = state.byId.get('main')
  if (main && main.model) return main.model
  return '…'
}

const PRESENT_MS = 90000
const agentPresent = (a) => {
  if (!a || a.status !== 'running') return false
  if (a.lastTool && a.lastTool.status === 'running') return true
  const at = (a.lastTool && a.lastTool.at) || a.startedAt
  return typeof at === 'number' && Date.now() - at < PRESENT_MS
}

function charHTML(rec) {
  const label = agentLabel(rec)
  return `<div class="head">
    <div class="ear l"></div><div class="ear r"></div>
    <div class="bun"></div>
    <div class="hair"></div>
    <div class="brow l"></div><div class="brow r"></div>
    <div class="eye l"></div><div class="eye r"></div>
    <div class="glasses"><div class="bridge"></div></div>
    <div class="cheek l"></div><div class="cheek r"></div>
    <div class="mouth"></div>
  </div>
  <div class="body">
    <div class="neck"></div>
    <div class="torso"><div class="collar"></div><div class="badge"></div></div>
    <div class="arm l"><div class="hand"></div></div>
    <div class="arm r"><div class="hand"></div></div>
    <div class="leg l"><div class="shoe"></div></div>
    <div class="leg r"><div class="shoe"></div></div>
    <div class="zzz"></div>
  </div>
  <div class="book"><div class="spine"></div></div>
  <div class="nameplate">${esc(label)}</div>
  <div class="bubble"></div>`
}

const agentKey = (ev) => ev.agentId || 'main'

function seatChar(seat) {
  const isMainSeat = seat.agentType === 'main'
  const slot = SEAT_SLOTS.find((s) => s.desk === (isMainSeat ? '.desk.maindesk' : '.desk.' + seat.desk))
  if (!slot) return
  const rec = {
    id: seat.sessionKey, type: seat.agentType, isMain: isMainSeat, status: 'running',
    startedAt: Date.now(), endedAt: null, lastTool: null, lastMessage: '', lastError: null,
    skills: [], promptCount: 0, lastPrompt: '', turns: 0, model: null
  }
  const c = ensureChar(rec)
  if (!c) return
  c.slot = slot
  sitChar(c, true)
}

async function seatAgent(agentType) {
  const res = await fetch(api('/api/desk/assign'), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentType })
  })
  if (!res.ok) {
    alert('no free desk — free one first')
    return
  }
  const data = await res.json()
  state.seats.set(data.sessionKey, { sessionKey: data.sessionKey, agentType, desk: data.desk, history: [], busy: false })
  seatChar(state.seats.get(data.sessionKey))
  openConsole(data.sessionKey)
  renderCatalog()
}

function mainDeskOccupied() {
  if ([...state.seats.values()].some((s) => s.desk === 'maindesk')) return true
  const main = state.byId.get('main')
  return !!(main && main.status === 'running')
}

let seatingMain = false
async function seatMain() {
  if (seatingMain || mainDeskOccupied()) return
  seatingMain = true
  try {
    const res = await fetch(api('/api/desk/assign'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agentType: 'main', desk: 'maindesk' })
    })
    if (!res.ok) {
      alert((await res.json().catch(() => ({}))).error || 'main desk unavailable')
      return
    }
    const data = await res.json()
    state.seats.set(data.sessionKey, { sessionKey: data.sessionKey, agentType: data.agentType, desk: data.desk, history: [], busy: false })
    seatChar(state.seats.get(data.sessionKey))
    openConsole(data.sessionKey)
    renderCatalog()
  } finally {
    seatingMain = false
  }
}

function cleanupSeat(key) {
  const seat = state.seats.get(key)
  if (!seat) return
  state.seats.delete(key)
  const c = office.chars.get(key)
  if (c) walkOut(c)
  if (activeConsole === key) { activeConsole = null; $('#console').classList.remove('open') }
  renderCatalog()
}

async function freeSeat(key) {
  let ok = false
  for (let i = 0; i < 2 && !ok; i++) {
    try {
      const res = await fetch(api('/api/desk/free'), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionKey: key })
      })
      ok = res.ok
    } catch {}
    if (!ok && i === 0) await new Promise((r) => setTimeout(r, 500))
  }
  if (ok) cleanupSeat(key)
  else {
    alert('failed to free the desk — the seat stays reserved, try again')
    renderCatalog()
  }
}

let activeConsole = null

function contextBarHTML(c) {
  const pct = Math.min(100, Math.round(c.percentage || 0))
  const fmt = (n) => Number(n || 0).toLocaleString('en-US')
  const danger = (c.percentage || 0) >= 90 ? ' danger' : ''
  return `<div class="con-ctx">
    <div class="ctx-label">context · <b>${pct}% used</b><span>${fmt(c.total_tokens)} / ${fmt(c.raw_max_tokens)} tokens</span></div>
    <div class="ctx-bar"><div class="ctx-fill${danger}" style="width:${pct}%"></div></div>
  </div>`
}

function renderConsole() {
  const seat = activeConsole && state.seats.get(activeConsole)
  if (!seat) return
  const body = $('#conBody')
  body.innerHTML = (seat.contextUsage ? contextBarHTML(seat.contextUsage) : '') + seat.history.map((m) => {
    if (m.role === 'user') return `<div class="con-msg user">${esc(m.text)}</div>`
    if (m.role === 'assistant') return `<div class="con-msg assistant">${esc(m.text)}</div>`
    if (m.role === 'tool') return `<div class="con-msg tool">⚙ ${esc(m.toolName)}</div>`
    if (m.role === 'error') return `<div class="con-msg error">✖ ${esc(m.text)}</div>`
    if (m.role === 'done') return `<div class="con-msg done">✔ done${m.durationMs != null ? ' · ' + dur(m.durationMs) : ''}</div>`
    return ''
  }).join('') + (seat.busy ? '<div class="con-typing">working…</div>' : '')
  body.scrollTop = body.scrollHeight
}

function openConsole(key) {
  const seat = state.seats.get(key)
  if (!seat) return
  activeConsole = key
  $('#console .con-title').textContent = seat.agentType
  $('#console .con-desk').textContent = seat.desk
  $('#console').classList.add('open')
  renderConsole()
  $('#conText').focus()
}

function closeConsole() {
  activeConsole = null
  $('#console').classList.remove('open')
}

function toggleConsole(key) {
  if (activeConsole === key) closeConsole()
  else openConsole(key)
}

let consoleDrag = null
$('.con-head').addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, .con-x')) return
  const el = $('#console')
  const r = el.getBoundingClientRect()
  el.style.left = r.left + 'px'
  el.style.top = r.top + 'px'
  el.style.right = 'auto'
  consoleDrag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top }
  e.currentTarget.setPointerCapture(e.pointerId)
})
$('.con-head').addEventListener('pointermove', (e) => {
  if (!consoleDrag) return
  const el = $('#console')
  const r = el.getBoundingClientRect()
  const x = Math.min(Math.max(0, consoleDrag.left + (e.clientX - consoleDrag.x)), window.innerWidth - r.width)
  const y = Math.min(Math.max(0, consoleDrag.top + (e.clientY - consoleDrag.y)), window.innerHeight - r.height)
  el.style.left = x + 'px'
  el.style.top = y + 'px'
})
$('.con-head').addEventListener('pointerup', (e) => {
  if (!consoleDrag) return
  consoleDrag = null
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
})

async function sendChat() {
  const seat = activeConsole && state.seats.get(activeConsole)
  if (!seat) return
  const input = $('#conText')
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  try {
    await fetch(api('/api/desk/send'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionKey: activeConsole, message: text })
    })
  } catch (e) {
    seat.history.push({ role: 'error', text: String(e && e.message || e) })
    renderConsole()
  }
}

function chatEvent(d) {
  const key = d.sessionKey
  if (d.kind === 'seated') {
    if (state.seats.has(key)) return
    state.seats.set(key, { sessionKey: key, agentType: d.agentType, desk: d.desk, history: [], busy: false })
    seatChar(state.seats.get(key))
    renderCatalog()
    return
  }
  const seat = state.seats.get(key)
  if (!seat) return
  switch (d.kind) {
    case 'context': seat.contextUsage = d.context; break
    case 'user': seat.history.push({ role: 'user', text: d.text }); break
    case 'assistant': seat.history.push({ role: 'assistant', text: d.text }); break
    case 'tool': seat.history.push({ role: 'tool', toolName: d.toolName }); break
    case 'done': seat.history.push({ role: 'done', text: d.result || '', durationMs: d.durationMs }); seat.busy = false; break
    case 'error': seat.history.push({ role: 'error', text: d.error }); seat.busy = false; break
    case 'running': seat.busy = true; break
    case 'idle': seat.busy = false; break
    case 'freed': cleanupSeat(key); return
    default: return
  }
  if (activeConsole === key) renderConsole()
}

function ensureChar(rec) {
  let c = office.chars.get(rec.id)
  if (c) {
    if (c.rec.status === 'idle' && rec.status !== 'idle') {
      c.rec = rec
      c.el.querySelector('.nameplate').textContent = agentLabel(rec)
    }
    return c
  }
  const hue = hueFor(rec.id)
  const h = hashOf(rec.id)
  const el = document.createElement('div')
  el.className = 'char ' + LOOKS[h % LOOKS.length]
  el.dataset.agent = rec.id
  el.style.setProperty('--hue', hue)
  el.style.setProperty('--hair', HAIRS[(h >> 3) % HAIRS.length])
  el.style.setProperty('--skin', SKINS[(h >> 5) % SKINS.length])
  el.innerHTML = charHTML(rec, hue)
  el.addEventListener('click', () => {
    if (state.seats.has(rec.id)) { toggleConsole(rec.id); return }
    openTranscript(rec.id)
  })
  $('#chars').appendChild(el)
  c = { el, rec, slot: null, expr: 'idle', typing: false, bubbles: [] }
  office.chars.set(rec.id, c)
  office.order.push(rec.id)
  return c
}

function slotFor(rec) {
  if (rec.isMain || rec.type === 'main') {
    const occupant = office.order.find((id) => id !== rec.id && office.chars.get(id) && office.chars.get(id).slot === MAIN_SLOT)
    if (occupant) removeChar(occupant)
    return MAIN_SLOT
  }
  const taken = new Set([...office.chars.values()].map((c) => c.slot && c.slot.desk).filter(Boolean))
  const free = SLOTS.find((s) => !taken.has(s.desk))
  if (free) return free
  const victim = office.order.find((id) => id !== rec.id && office.chars.get(id) && !office.chars.get(id).rec.isMain && office.chars.get(id).slot)
  if (victim) {
    const v = office.chars.get(victim)
    const s = v.slot
    removeChar(victim)
    return s
  }
  return SLOTS[office.order.indexOf(rec.id) % SLOTS.length]
}

function removeChar(id) {
  const c = office.chars.get(id)
  if (!c) return
  c.el.style.opacity = 0
  setTimeout(() => c.el.remove(), 500)
  office.chars.delete(id)
  office.order = office.order.filter((x) => x !== id)
  c.slot = null
}

function refreshDeskLabel(c) {
  const desk = c.slot ? document.querySelector(c.slot.desk) : null
  const dname = desk && desk.querySelector('.dname')
  if (!dname) return
  const st = dname.querySelector('.st')
  const m = modelFor(c.rec)
  dname.title = m
  dname.innerHTML = `${esc(m)}<span class="st">${st ? st.textContent : ' · idle'}</span>`
}

function sitChar(c, instant) {
  const s = c.slot
  const desk = document.querySelector(s.desk)
  c.el.classList.add('seated')
  c.el.style.left = desk.offsetLeft + 'px'
  c.el.style.top = (desk.offsetTop - SEAT_LIFT) + 'px'
  c.el.style.zIndex = 3
  if (instant) {
    c.el.style.transition = 'none'
    c.el.classList.add('pop')
    setTimeout(() => { c.el.style.transition = '' }, 60)
  }
  refreshDeskLabel(c)
  setExpr(c, 'idle')
}

function walkIn(c) {
  c.leaving = false
  const s = c.slot
  c.el.classList.remove('seated')
  c.el.style.zIndex = 5
  c.el.style.left = (SPAWN_X - CHAR_W / 2) + 'px'
  c.el.style.top = (DOOR_BASE_Y - CHAR_H) + 'px'
  c.el.style.transition = 'none'
  c.el.style.opacity = 0
  requestAnimationFrame(() => {
    c.el.style.transition = ''
    c.el.style.opacity = 1
    c.el.classList.add('walking')
    openDoor()
    bubble(c, '👋 hi!', 'think', 1600)
  })
  setTimeout(() => {
    c.el.style.top = (WALK_Y - CHAR_H) + 'px'
  }, 120)
  setTimeout(() => {
    c.el.style.left = document.querySelector(s.desk).offsetLeft + 'px'
  }, 800)
  setTimeout(() => {
    c.el.classList.remove('walking')
    sitChar(c)
  }, 1800)
}

function walkOut(c) {
  if (c.leaving) return
  c.leaving = true
  c.el.classList.remove('seated', 'typing', 'reading', 'error', 'thinking')
  c.el.style.zIndex = 5
  c.el.classList.add('walking')
  openDoor()
  c.el.style.left = (SPAWN_X - CHAR_W / 2) + 'px'
  c.el.style.top = (WALK_Y - CHAR_H) + 'px'
  setTimeout(() => {
    c.el.style.top = (DOOR_BASE_Y - CHAR_H) + 'px'
    c.el.style.opacity = 0
  }, 1000)
  setTimeout(() => removeChar(c.rec.id), 1900)
}

function openDoor() {
  const d = $('#door')
  d.classList.add('open')
  setTimeout(() => d.classList.remove('open'), 800)
}

function setExpr(c, expr, ms) {
  if (c.expr !== 'idle') c.el.classList.remove(c.expr)
  c.el.classList.add(expr)
  c.expr = expr
  if (ms) setTimeout(() => { if (c.expr === expr) { c.el.classList.remove(expr); c.expr = 'idle' } }, ms)
}

function bubble(c, text, kind, ms = 2200) {
  const b = c.el.querySelector('.bubble')
  b.className = 'bubble' + (kind ? ` ${kind}` : '')
  b.textContent = text
  b.classList.add('show')
  clearTimeout(c._bt)
  c._bt = setTimeout(() => b.classList.remove('show'), ms)
}

function setBusy(c, busy, tool) {
  c.typing = !!busy
  c.el.classList.toggle('typing', !!busy)
  const screen = c.slot ? document.querySelector(c.slot.desk + ' .screen') : null
  if (screen) {
    screen.classList.toggle('marquee', !!busy)
    screen.textContent = busy ? tool : 'idle'
  }
}

function confetti(x, y, n = 20) {
  const fx = $('#fx')
  const colors = ['#e85d3f', '#f59e0b', '#0ea5a4', '#2e8b3d', '#a78bfa', '#f4d35e']
  for (let i = 0; i < n; i++) {
    const p = document.createElement('div')
    p.className = 'confetti'
    p.style.left = (x + (Math.random() * 160 - 80)) + 'px'
    p.style.top = (y + (Math.random() * 40 - 20)) + 'px'
    p.style.setProperty('--c', colors[i % colors.length])
    p.style.animationDelay = (Math.random() * 0.4) + 's'
    fx.appendChild(p)
    setTimeout(() => p.remove(), 2400)
  }
}

function paperPlane() {
  const fx = $('#fx')
  const p = document.createElement('div')
  p.className = 'plane'
  p.textContent = '✈'
  fx.appendChild(p)
  setTimeout(() => p.remove(), 2600)
}

let pinIdx = 0
function pinTask(t) {
  const pb = $('#pinboard')
  const pin = document.createElement('div')
  pin.className = 'pin' + (t.status === 'done' ? ' done' : '')
  pin.style.setProperty('--rot', (Math.random() * 5 - 2.5) + 'deg')
  pin.textContent = t.subject
  pb.appendChild(pin)
  const pins = pb.querySelectorAll('.pin')
  while (pins.length > 5) pins[0].remove()
  pinIdx++
  if (t.status === 'done') {
    setTimeout(() => { pin.classList.add('done') }, 100)
    paperPlane()
  }
}

function officeReact(ev) {
  const rec = state.byId.get(agentKey(ev))
  if (!rec) return
  if (ev.event === 'TaskCreated') {
    pinTask({ subject: ev.taskSubject || 'task', status: 'running' })
    return
  }
  if (ev.event === 'TaskCompleted') {
    pinTask({ subject: ev.taskSubject || 'task', status: 'done' })
    confetti(700, 90, 16)
    return
  }
  if (ev.event === 'SessionStart') {
    $('#doneAlert').classList.remove('show')
    const deskSeat = [...state.seats.values()].find((s) => s.desk === 'maindesk')
    if (deskSeat) freeSeat(deskSeat.sessionKey)
    const c = ensureChar(rec)
    if (c && !c.slot) {
      c.slot = slotFor(rec)
      walkIn(c)
    }
    return
  }
  if (ev.event === 'SessionEnd') {
    const c = office.chars.get(agentKey(ev))
    if (c && c.slot) {
      setExpr(c, 'happy', 1800)
      bubble(c, '✓ all done!', 'ok', 2600)
      $('#doneAlert').classList.add('show')
    }
    return
  }
  const c = ensureChar(rec)
  if (!c) return
  if (!c.slot) {
    c.slot = slotFor(rec)
    walkIn(c)
    return
  }
  switch (ev.event) {
    case 'SubagentStart':
      c.slot = slotFor(rec)
      walkIn(c)
      break
    case 'SubagentStop':
      if (c.slot) {
        setBusy(c, false)
        setExpr(c, 'happy', 1600)
        bubble(c, '✓ done!', 'ok', 1600)
        confetti(Number(c.el.style.left) + 60, Number(c.el.style.top) + 20, 24)
        setTimeout(() => walkOut(c), 900)
      }
      break
    case 'PreToolUse':
      if (ASK_TOOLS.has(ev.toolName)) {
        const q = ev.ask ? ev.ask.question : ''
        bubble(c, `❓ ${q.slice(0, 42)}`, 'think', 2600)
        setExpr(c, 'thinking', 2600)
      } else if (ev.toolName === SKILL_TOOL) {
        bubble(c, `📖 ${ev.skill}`, 'think', 2000)
        c.el.classList.add('reading')
        setTimeout(() => { if (!c.typing) c.el.classList.remove('reading') }, 1600)
      } else {
        bubble(c, `⚙ ${ev.toolName}`, '', 1600)
        setBusy(c, true, ev.toolName)
        setExpr(c, 'busy')
      }
      break
    case 'PostToolUse':
      if (ASK_TOOLS.has(ev.toolName)) {
        setBusy(c, false)
        setExpr(c, 'happy', 900)
        bubble(c, '✔ answered', 'ok', 1400)
      } else if (ev.toolName !== SKILL_TOOL) {
        setBusy(c, false)
        setExpr(c, 'happy', 700)
        bubble(c, '✓ ok', 'ok', 1200)
      } else {
        c.el.classList.remove('reading')
      }
      break
    case 'PostToolUseFailure':
      setBusy(c, false)
      setExpr(c, 'error', 2600)
      bubble(c, `✖ ${(ev.summary || ev.toolName || 'error').slice(0, 40)}`, 'err', 2800)
      break
    case 'TaskCreated':
      pinTask({ subject: ev.taskSubject || 'task', status: 'running' })
      setExpr(c, 'thinking', 1400)
      bubble(c, '📋 new task!', 'think', 1500)
      break
    case 'TaskCompleted':
      pinTask({ subject: ev.taskSubject || 'task', status: 'done' })
      confetti(700, 90, 16)
      break
    case 'Stop':
      setBusy(c, false)
      setExpr(c, 'happy', 900)
      bubble(c, '✔ turn done', 'ok', 1400)
      break
    case 'ForceClear':
      if (c.slot) walkOut(c)
      break
    case 'AgentModel':
      refreshDeskLabel(c)
      break
  }
}

function renderOfficeFocus() {
  for (const c of office.chars.values()) c.el.classList.toggle('focus', state.filterAgent === c.rec.id)
}

function updateMainDesk() {
  const deskEl = document.querySelector('.desk.maindesk')
  if (!deskEl) return
  const occupied = office.order.some((id) => { const c = office.chars.get(id); return c && c.slot === MAIN_SLOT })
  deskEl.classList.toggle('empty', !occupied)
  deskEl.title = occupied ? '' : 'click to seat an agent here and start an interactive session'
  if (!occupied) {
    const screen = deskEl.querySelector('.screen')
    if (screen) screen.textContent = seatingMain ? 'sitting down…' : '🪑 click to sit'
  }
}

function tickOffice() {
  updateMainDesk()
  const now = Date.now()
  for (const c of office.chars.values()) {
    if (!c.slot) continue
    const rec = c.rec
    const seat = state.seats.get(c.rec.id)
    if (!seat && !rec.isMain && rec.status === 'running' && !agentPresent(rec)) {
      walkOut(c)
      continue
    }
    const screen = document.querySelector(c.slot.desk + ' .screen')
    if (!screen) continue
    const t = rec.status === 'running' ? dur(elapsed(rec.startedAt)) : 'done'
    const dname = document.querySelector(c.slot.desk + ' .dname .st')
    if (seat && rec.status === 'running' && !c.typing && !rec.lastTool) {
      screen.textContent = 'awaiting instructions'
      if (dname) dname.textContent = '· awaiting'
      continue
    }
    if (rec.status === 'idle') {
      screen.textContent = 'waiting for session'
    } else if (c.typing) {
      screen.textContent = `${rec.lastTool ? rec.lastTool.name : '…'} · ${t}`
    } else {
      screen.textContent = `idle · ${t}`
    }
    if (dname) dname.textContent = rec.status === 'idle' ? '· waiting' : (c.typing ? `· ${rec.lastTool.name}` : (rec.status === 'running' ? `· ${t}` : '· done'))
  }
}

function fitOffice() {
  const wrap = $('#stagewrap')
  const officeEl = $('#office')
  const s = Math.min(wrap.clientWidth / 960, wrap.clientHeight / 540) * 0.97
  officeEl.style.transform = `scale(${Math.max(0.2, s)})`
}
window.addEventListener('resize', fitOffice)

const feedWrap = $('#feedwrap')
const feedToggle = $('#feedToggle')
let feedH = 0
const feedTxt = () => feedWrap.classList.contains('collapsed') ? '▴ activity' : '▾ activity'

function setFeedCollapsed(collapsed) {
  if (collapsed) feedH = feedWrap.offsetHeight
  feedWrap.classList.toggle('collapsed', collapsed)
  feedWrap.style.height = (collapsed ? 14 : feedH || 300) + 'px'
  feedToggle.textContent = feedTxt()
}

feedToggle.addEventListener('click', () => setFeedCollapsed(!feedWrap.classList.contains('collapsed')))

let feedDrag = null
$('#resizer').addEventListener('pointerdown', (e) => {
  if (e.target.closest('#feedToggle')) return
  feedDrag = { y: e.clientY, h: feedWrap.classList.contains('collapsed') ? (feedH || 300) : feedWrap.offsetHeight }
  e.currentTarget.setPointerCapture(e.pointerId)
})
$('#resizer').addEventListener('pointermove', (e) => {
  if (!feedDrag) return
  const maxH = $('#board').getBoundingClientRect().height - 14
  const h = Math.min(maxH, Math.max(60, feedDrag.h + (feedDrag.y - e.clientY)))
  feedWrap.style.height = h + 'px'
  feedWrap.classList.remove('collapsed')
  feedToggle.textContent = feedTxt()
})
$('#resizer').addEventListener('pointerup', (e) => {
  if (!feedDrag) return
  feedDrag = null
  try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
})

function feedEntry(ev) {
  let msg = '', cls = ''
  switch (ev.event) {
    case 'PreToolUse':
      if (ASK_TOOLS.has(ev.toolName)) { msg = `❓ <b>model asks:</b> ${esc(ev.ask ? ev.ask.question : '')}`; cls = 'ask' }
      else if (ev.toolName === SKILL_TOOL) { msg = `skill <b>${esc(ev.skill)}</b> loading`; cls = 'skill' }
      else { msg = `<span class="toolname">${esc(ev.toolName)}</span> ${esc(ev.summary || '')}`; cls = 'tool' }
      break
    case 'PostToolUse':
      if (ASK_TOOLS.has(ev.toolName)) { msg = `<span class="ok">✔</span> question answered`; cls = 'ask' }
      else { msg = `<span class="ok">✔</span> <span class="toolname">${esc(ev.toolName)}</span> ${esc(ev.summary || '')}`; cls = 'tool' }
      break
    case 'PostToolUseFailure':
      msg = `<span class="bad">✖</span> <span class="toolname">${esc(ev.toolName)}</span> ${esc(ev.summary || '')}`; cls = 'error'
      break
    case 'SubagentStart': msg = `▶ subagent <b>${esc(ev.agentType)}</b> started`; break
    case 'SubagentStop': msg = `■ subagent <b>${esc(ev.agentType)}</b> finished`; break
    case 'UserPromptSubmit': msg = `<b>prompt:</b> ${esc(ev.prompt)}`; cls = 'prompt'; break
    case 'TaskCreated': msg = `📋 task: ${esc(ev.taskSubject)}`; break
    case 'TaskCompleted': msg = `✅ task done: ${esc(ev.taskSubject)}`; break
    case 'Stop': msg = `⏹ turn finished`; break
    case 'SessionStart': msg = `session started`; break
    case 'SessionEnd': msg = `session ended`; break
    case 'ForceClear': msg = `🧹 stuck session force-cleared`; break
    case 'AgentModel': return null
    default: msg = `${esc(ev.event)}`; break
  }
  return { msg, cls, ev }
}

function renderFeed() {
  const list = $('#feed')
  const q = state.search.toLowerCase()
  const items = state.events
    .map(feedEntry)
    .filter((entry) => {
      if (!entry) return false
      const { cls, ev } = entry
      if (state.filter === 'main' && ev.agentType !== 'main') return false
      if (state.filter === 'sub' && ev.agentType === 'main') return false
      if (state.filter === 'skill' && ev.toolName !== SKILL_TOOL && ev.event !== 'UserPromptExpansion') return false
      if (state.filter === 'error' && cls !== 'error' && ev.event !== 'PostToolUseFailure') return false
      if (state.filterAgent && ev.agentId !== state.filterAgent) return false
      if (q) {
        const hay = `${ev.toolName} ${ev.summary} ${ev.prompt} ${ev.skill} ${ev.agentType} ${ev.taskSubject} ${ev.event}`.toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
  if (!items.length) {
    list.innerHTML = '<div class="empty">no matching events</div>'
    return
  }
  list.innerHTML = items
    .map(({ cls, msg, ev }) => {
      const who = ev.agentId === 'main' ? 'main' : esc(ev.agentType || ev.agentId)
      const durTxt = ev.durationMs != null ? `<span class="dur">${ev.durationMs}ms</span>` : ''
      return `<div class="ev ${cls}">
        <span class="t">${time(ev.ts)}</span>
        <span class="who ${ev.agentId === 'main' ? 'main' : ''}" style="--hue:${hueFor(ev.agentId)}">${who}</span>
        <span class="msg">${msg}</span>${durTxt}</div>`
    })
    .join('')
}

function renderCatalog() {
  const agents = state.catalog.agents || []
  const skills = state.catalog.skills || []
  const mcps = state.catalog.mcps || []
  $('#agentCount').textContent = `(${agents.length})`
  $('#skillCount').textContent = `(${skills.length})`
  $('#mcpCount').textContent = `(${mcps.length})`
  $('#catalogCnt').textContent = agents.length + skills.length + mcps.length
  $('#agentList').innerHTML = agents
    .map((a) => {
      const running = [...state.byId.values()].some((r) => r.type === a.id && agentPresent(r))
      const seated = seatByType(a.id)
      return `<div class="note">
        <h4><span class="ava" style="--hue:${hueFor(a.id)}"></span>${esc(a.name)} <span class="badge ${running ? 'live' : ''}">${running ? 'at work' : 'agent'}</span></h4>
        ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
        ${a.model ? `<div class="model">model: ${esc(a.model)}</div>` : ''}
        ${a.tools.length ? `<div class="tools">${a.tools.map((t) => `<span class="tool-chip">${esc(t)}</span>`).join('')}</div>` : ''}
        <button class="seat-btn ${seated ? 'on' : ''}" data-type="${esc(a.id)}">${seated ? '✕ free desk' : '🪑 seat'}</button>
      </div>`
    })
    .join('')
  const liveSkills = new Set()
  for (const a of state.byId.values()) for (const s of a.skills || []) if (s.inUse) liveSkills.add(s.name)
  const usedCount = new Map()
  for (const a of state.byId.values()) for (const s of a.skills || []) usedCount.set(s.name, (usedCount.get(s.name) || 0) + s.count)
  $('#skillList').innerHTML = skills
    .map((s) => {
      const live = liveSkills.has(s.name)
      const used = usedCount.get(s.name) || 0
      const badge = live ? '<span class="badge live">in use</span>' : used ? `<span class="badge used">${used}×</span>` : ''
      return `<div class="note">
        <h4>${esc(s.name)} ${badge}</h4>
        ${s.description ? `<div class="desc">${esc(s.description)}</div>` : ''}
      </div>`
    })
    .join('')
  $('#mcpList').innerHTML = mcps.length
    ? mcps.map((m) => `<div class="note mcp-note">
        <h4>🔌 ${esc(m.name)} <span class="badge ${m.disabled ? '' : 'used'}">${esc(m.disabled ? 'disabled' : m.transport)}</span></h4>
        ${m.url ? `<div class="model">${esc(m.url)}</div>` : ''}
        ${m.command ? `<div class="model">command: ${esc(m.command)}</div>` : ''}
        <div class="mcp-source">${esc(m.source)}</div>
      </div>`).join('')
    : '<div class="mcp-empty">no project MCP servers found</div>'
  renderTeam()
}

function renderTeam() {
  const configured = state.catalog.agents || []
  const configuredTypes = new Set(configured.map((a) => a.id))
  const active = [...state.byId.values()].filter((a) => !a.isMain && agentPresent(a))
  const extraActive = active.filter((a) => !configuredTypes.has(a.type))
  const body = $('#teamBody')
  if (!body) return
  $('#teamTitle').textContent = `🤖 team · ${configured.length} configured · ${active.length} active`
  const configuredHtml = configured.map((a) => {
    const running = active.some((r) => r.type === a.id)
    const seated = seatByType(a.id)
    return `<div class="note team-member">
      <h4><span class="ava" style="--hue:${hueFor(a.id)}"></span>${esc(a.name)} <span class="badge ${running ? 'live' : ''}">${running ? 'at work' : 'available'}</span></h4>
      ${a.description ? `<div class="desc">${esc(a.description)}</div>` : ''}
      ${a.model ? `<div class="model">model: ${esc(a.model)}</div>` : ''}
      ${a.tools.length ? `<div class="tools">${a.tools.map((t) => `<span class="tool-chip">${esc(t)}</span>`).join('')}</div>` : ''}
      <button class="seat-btn ${seated ? 'on' : ''}" data-type="${esc(a.id)}">${seated ? '✕ free desk' : '🪑 seat'}</button>
    </div>`
  }).join('')
  const activeHtml = extraActive.map((a) => `<div class="note team-member">
    <h4><span class="ava" style="--hue:${hueFor(a.id)}"></span>${esc(agentLabel(a))} <span class="badge live">at work</span></h4>
    <div class="desc">active subagent</div>
    <div class="model">session: ${esc(a.id)}</div>
  </div>`).join('')
  body.innerHTML = configuredHtml || activeHtml
    ? `<div class="team-list">${configuredHtml}${activeHtml}</div>`
    : '<div class="empty">no subagents configured or active</div>'
}

const STATUS_LABEL = { draft: 'draft', 'in-progress': 'in progress', done: 'done' }
const normStatus = (s) => (s === 'done' || s === 'in-progress' ? s : 'draft')

function renderTasks() {
  const st = state.stories || []
  const count = (s) => st.filter((x) => normStatus(x.status) === s).length
  $('#pbCounts').innerHTML =
    `<div class="pb-row draft"><span class="pb-dot"></span>open<span class="pb-n">${count('draft')}</span></div>` +
    `<div class="pb-row in-progress"><span class="pb-dot"></span>in progress<span class="pb-n">${count('in-progress')}</span></div>` +
    `<div class="pb-row done"><span class="pb-dot"></span>done<span class="pb-n">${count('done')}</span></div>`
  $('#tasksTitle').textContent = `📋 tasks · docs/stories (${st.length})`
}

function renderNotesPreview() {
  const notes = state.notes || []
  const preview = notes.slice(-2).reverse().map((n) => n.title || n.text || 'untitled').join(' · ')
  $('#notesCount').textContent = String(notes.length)
  $('#notesPreview').textContent = preview || 'no notes yet'
  $('#notesTitle').textContent = `📌 notes (${notes.length})`
}

function loadStories() {
  fetch(api('/api/stories'))
    .then((r) => r.json())
    .then((d) => {
      state.stories = (d && d.stories) || []
      renderTasks()
      if ($('#tasksModal').classList.contains('open')) renderKanban()
    })
    .catch(() => {
      state.stories = []
      renderTasks()
      if ($('#tasksModal').classList.contains('open')) {
        $('#tasksBody').innerHTML = '<div class="doc-missing">could not read <b>docs/stories</b><span class="doc-searched">the office has no stories directory, or the server is unreachable</span></div>'
      }
    })
}

function openTasks(filter) {
  state.tasksFilter = filter || 'all'
  for (const b of document.querySelectorAll('#tasksTabs .dtab')) b.classList.toggle('active', b.dataset.tab === state.tasksFilter)
  $('#tasksModal').classList.add('open')
  $('#tasksBody').innerHTML = '<div class="empty">reading docs/stories…</div>'
  loadStories()
}

function closeTasks() { $('#tasksModal').classList.remove('open') }

function renderKanban() {
  const body = $('#tasksBody')
  const st = state.stories || []
  const cols = state.tasksFilter === 'all' ? ['draft', 'in-progress', 'done'] : [state.tasksFilter]
  body.innerHTML = '<div class="kanban">' + cols.map((s) => {
    const items = st.filter((x) => normStatus(x.status) === s)
    const cards = items.map((x) => `<button class="kb-card ${s}" data-file="${esc(x.file)}">
      <span class="kb-title">${esc(x.title)}</span>
      <span class="kb-meta">${esc(x.file)}${x.lane ? ` · ${esc(x.lane)}` : ''}</span>
    </button>`).join('')
    return `<div class="kb-col ${s}">
      <div class="kb-head"><span class="kb-dot"></span>${STATUS_LABEL[s]}<span class="kb-count">${items.length}</span></div>
      <div class="kb-list">${cards || '<div class="kb-empty">no tasks</div>'}</div>
    </div>`
  }).join('') + '</div>'
}

function render() {
  renderCatalog()
  renderTasks()
  renderFeed()
  renderOfficeFocus()
}

function applyEvent(ev) {
  state.events.unshift(ev)
  if (state.events.length > 400) state.events.length = 400
  if ((ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') && ASK_TOOLS.has(ev.toolName)) hideAskAlert()
  if (ev.event === 'UserPromptSubmit') hideAskAlert()
  const key = agentKey(ev)
  const rec = state.byId.get(key) || {
    id: key,
    type: ev.agentType,
    isMain: key === 'main',
    status: 'running',
    startedAt: ev.ts,
    endedAt: null,
    lastTool: null,
    lastMessage: '',
    lastError: null,
    skills: [],
    promptCount: 0,
    lastPrompt: '',
    turns: 0,
    model: null
  }
  if (ev.event === 'SessionStart') { rec.status = 'running'; rec.startedAt = ev.ts; if (ev.model) rec.model = ev.model }
  if (ev.event === 'SessionEnd') { rec.status = 'ended'; rec.endedAt = ev.ts }
  if (ev.event === 'SubagentStart') { rec.status = 'running'; rec.startedAt = ev.ts; rec.endedAt = null; rec.type = ev.agentType }
  if (ev.event === 'SubagentStop') { rec.status = 'done'; rec.endedAt = ev.ts; rec.lastMessage = ev.lastMessage || '' }
  if (ev.event === 'ForceClear') { rec.status = 'ended'; rec.endedAt = ev.ts }
  if (ev.event === 'UserPromptSubmit') { rec.promptCount++; rec.lastPrompt = ev.prompt || '' }
  if (ev.event === 'AgentModel') { rec.model = ev.model }
  if (ev.event === 'Stop') rec.turns++
  if (ev.event === 'PreToolUse') {
    rec.lastTool = { name: ev.toolName, summary: ev.summary, status: 'running', at: ev.ts }
    if (ev.skill && !rec.skills.some((s) => s.name === ev.skill)) {
      rec.skills.push({ name: ev.skill, count: 0, inUse: true, firstUsedAt: ev.ts, lastUsedAt: ev.ts })
    } else if (ev.skill) {
      const s = rec.skills.find((s) => s.name === ev.skill); s.inUse = true
    }
  }
  if (ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') {
    rec.lastTool = { name: ev.toolName, summary: ev.summary, status: ev.event === 'PostToolUse' ? 'ok' : 'error', durationMs: ev.durationMs, at: ev.ts }
    if (ev.skill) {
      const s = rec.skills.find((s) => s.name === ev.skill)
      if (s) { s.inUse = false; s.count++; s.lastUsedAt = ev.ts }
    }
    if (ev.event === 'PostToolUseFailure') rec.lastError = ev.summary
  }
  if (ev.event === 'TaskCreated') {
    state.tasks = state.tasks || []
    state.tasks.unshift({ id: ev.taskId || String(ev.seq), subject: ev.taskSubject, status: 'running' })
    state.tasks = state.tasks.slice(0, 20)
  }
  if (ev.event === 'TaskCompleted') {
    state.tasks = state.tasks || []
    const t = state.tasks.find((t) => t.id === (ev.taskId || ''))
    if (t) t.status = 'done'
  }
  state.byId.set(rec.id, rec)
}

function applySnapshot(snap) {
  state.byId.clear()
  state.usage = snap.usage
  for (const a of snap.agents) {
    state.byId.set(a.id, { ...a, isMain: a.id === 'main' })
  }
  state.events = snap.events.slice().reverse()
  state.tasks = snap.tasks
  state.seats.clear()
  for (const s of snap.seats || []) {
    state.seats.set(s.sessionKey, { sessionKey: s.sessionKey, agentType: s.agentType, desk: s.desk, history: s.history || [], busy: false, contextUsage: s.contextUsage || null })
  }
  replaceAskQueue(snap.asks)
  render()
  for (const seat of state.seats.values()) {
    const existing = state.byId.get(seat.sessionKey)
    const rec = existing
      ? { ...existing, isMain: existing.isMain || seat.agentType === 'main' }
      : {
          id: seat.sessionKey, type: seat.agentType, isMain: seat.agentType === 'main', status: 'running',
          startedAt: Date.now(), lastTool: null, skills: [], promptCount: 0, turns: 0, model: null
        }
    seatChar(seat)
    const c = office.chars.get(seat.sessionKey)
    if (c) c.rec = rec
  }
  const present = [...state.byId.values()].filter((a) => a.isMain ? a.status === 'running' : agentPresent(a))
  for (const a of present) {
    const c = ensureChar(a)
    if (!c) continue
    if (!c.slot) c.slot = slotFor(a)
    sitChar(c, true)
    if (a.lastTool && a.lastTool.status === 'running') setBusy(c, true, a.lastTool.name)
  }
  fitOffice()
  updateMainDesk()
}

function connect() {
  const es = new EventSource(AGW + '/events')
  es.addEventListener('snapshot', (e) => {
    const data = JSON.parse(e.data)
    state.catalog = data.catalog
    state.connected = true
    $('#conn').className = 'dot on'
    $('#meta').innerHTML = `<b>${esc(data.project)}</b>`
    const sign = $('#projectSign .pboard')
    if (sign) {
      const pname = (data.project || '').split(/[\\/]/).filter(Boolean).pop() || '…'
      sign.textContent = pname
      const signEl = $('#projectSign')
      if (signEl) signEl.title = pname
    }
    applySnapshot({ ...data.collector, seats: data.seats, asks: data.asks })
    loadStories()
    loadNotes()
  })
  es.addEventListener('event', (e) => {
    const ev = JSON.parse(e.data)
    applyEvent(ev)
    officeReact(ev)
    if (state.filterAgent && ev.agentId !== state.filterAgent) return
    render()
  })
  es.addEventListener('chat', (e) => {
    chatEvent(JSON.parse(e.data))
  })
  es.addEventListener('ask', (e) => {
    const d = JSON.parse(e.data)
    if (d.kind === 'asked') showAskAlert(d)
    else if (d.kind === 'answered' || d.kind === 'expired') removeAsk(d.id)
  })
  es.addEventListener('usage', (e) => {
    state.usage = JSON.parse(e.data)
    if ($('#usageModal').classList.contains('open')) renderUsage()
  })
  es.addEventListener('notes', (e) => {
    const d = JSON.parse(e.data)
    state.notes = d.notes || []
    maybeRenderNotes()
  })
  es.onerror = () => {
    state.connected = false
    $('#conn').className = 'dot off'
  }
}

document.querySelectorAll('.fbtn').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.fbtn').forEach((x) => x.classList.remove('active'))
  b.classList.add('active')
  state.filter = b.dataset.f
  state.filterAgent = null
  renderFeed()
  renderOfficeFocus()
}))

$('#search').addEventListener('input', (e) => { state.search = e.target.value; renderFeed() })

$('#agentList').addEventListener('click', (e) => {
  const btn = e.target.closest('.seat-btn')
  if (!btn) return
  const type = btn.dataset.type
  const seated = seatByType(type)
  if (seated) freeSeat(seated.sessionKey)
  else seatAgent(type)
})

$('#teamBody').addEventListener('click', (e) => {
  const btn = e.target.closest('.seat-btn')
  if (!btn) return
  const seated = seatByType(btn.dataset.type)
  if (seated) freeSeat(seated.sessionKey)
  else seatAgent(btn.dataset.type)
})

document.querySelector('.desk.maindesk').addEventListener('click', () => {
  if (!mainDeskOccupied()) seatMain()
})

$('#conSend').addEventListener('click', sendChat)
$('#conText').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat() })
$('#conCtx').addEventListener('click', () => {
  if (!activeConsole) return
  $('#conText').value = '/context'
  sendChat()
})
$('#conClose').addEventListener('click', closeConsole)
$('#conFree').addEventListener('click', () => {
  if (activeConsole && confirm('free this desk? the session will end for good — you won\'t be able to reopen it')) freeSeat(activeConsole)
})

function openUsage() {
  $('#usageModal').classList.add('open')
  renderUsage()
}

function renderUsage() {
  const u = state.usage
  const body = $('#usageBody')
  if (u === undefined) {
    body.innerHTML = '<div class="doc-missing">usage tracking not active — this dashboard is running an older version.<span class="doc-searched">restart it: agentwatch stop && agentwatch</span></div>'
    return
  }
  if (!u) {
    body.innerHTML = '<div class="empty">no session activity yet — usage appears as soon as Claude Code runs</div>'
    return
  }
  const fmt = (n) => Number(n || 0).toLocaleString('en-US')
  const usd = (n) => Number(n || 0) > 0 ? '$' + Number(n || 0).toFixed(4) : '—'
  const rows = (u.perModel || [])
    .filter((m) => m.inputTokens || m.outputTokens || m.cacheRead || m.cacheWrite)
    .map((m) => `<tr><td>${esc(m.model)}</td><td>${fmt(m.inputTokens)}</td><td>${fmt(m.outputTokens)}</td><td>${fmt(m.cacheRead)}</td><td>${fmt(m.cacheWrite)}</td><td>${usd(m.costUsd)}</td></tr>`)
    .join('')
  body.innerHTML =
    '<div class="usage-grid">' +
    `<div class="usage-cell"><span>cost</span><b>${usd(u.costUsd)}</b></div>` +
    `<div class="usage-cell"><span>input tokens</span><b>${fmt(u.inputTokens)}</b></div>` +
    `<div class="usage-cell"><span>output tokens</span><b>${fmt(u.outputTokens)}</b></div>` +
    `<div class="usage-cell"><span>cache read</span><b>${fmt(u.cacheRead)}</b></div>` +
    `<div class="usage-cell"><span>cache write</span><b>${fmt(u.cacheWrite)}</b></div>` +
    '</div>' +
    (rows
      ? '<table class="usage-table"><thead><tr><th>model</th><th>input</th><th>output</th><th>cache read</th><th>cache write</th><th>cost</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '') +
    `<div class="usage-note">updates live · last update ${u.lastUpdated ? time(u.lastUpdated) : '—'}${u.costUsd > 0 ? '' : ' · cost not provided by this Claude Code version'}</div>`
}

function closeUsage() { $('#usageModal').classList.remove('open') }
$('#usageBtn').addEventListener('click', openUsage)
$('#usageClose').addEventListener('click', closeUsage)
$('#usageModal .backdrop').addEventListener('click', closeUsage)

$('#pinboard').addEventListener('click', () => openTasks('all'))
$('#pbRefresh').addEventListener('click', (e) => {
  e.stopPropagation()
  const b = $('#pbRefresh')
  b.classList.add('spin')
  setTimeout(() => b.classList.remove('spin'), 500)
  loadStories()
})
$('#tasksClose').addEventListener('click', closeTasks)
$('#tasksModal .backdrop').addEventListener('click', closeTasks)
$('#tasksTabs').addEventListener('click', (e) => {
  const b = e.target.closest('.dtab')
  if (!b) return
  state.tasksFilter = b.dataset.tab
  for (const x of document.querySelectorAll('#tasksTabs .dtab')) x.classList.remove('active')
  b.classList.add('active')
  renderKanban()
})
$('#tasksBody').addEventListener('click', (e) => {
  const card = e.target.closest('.kb-card')
  if (!card) return
  openDoc(card.dataset.file)
})

const OFFICE_W = 960
const OFFICE_H = 540
const clampN = (v, min, max) => Math.min(max, Math.max(min, v))
const notesScale = () => ($('#notes').getBoundingClientRect().width / OFFICE_W) || 1

let notesEditingId = null
let notesDrag = null
let notesDirty = false

function renderNotes() {
  const wrap = $('#notes')
  wrap.innerHTML = ''
  for (const n of state.notes) wrap.appendChild(noteEl(n))
  renderNotesPreview()
}

function maybeRenderNotes() {
  if (notesDrag || notesEditingId) { notesDirty = true; return }
  renderNotes()
}

function afterNoteInteraction() {
  if (notesDirty && !notesDrag && !notesEditingId) { notesDirty = false; renderNotes() }
}

function noteEl(n) {
  const el = document.createElement('div')
  el.className = 'sticky'
  el.dataset.id = n.id
  el.style.left = n.x + 'px'
  el.style.top = n.y + 'px'
  el.style.setProperty('--hue', n.hue ?? 48)
  el.style.setProperty('--rot', ((hashOf(n.id || 'x') % 7) - 3) + 'deg')
  el.innerHTML = `<div class="st-head">
      <span class="st-grip">📌</span>
      <span class="st-title"></span>
      <button class="st-btn st-edit" title="edit note">✎</button>
      <button class="st-btn st-del" title="delete note">✕</button>
    </div>
    <div class="st-body"></div>
    <div class="st-editor">
      <input class="st-in-title" maxlength="120" placeholder="title…">
      <textarea class="st-in-text" maxlength="4000" placeholder="write here…"></textarea>
      <div class="st-actions">
        <button class="st-btn st-save" title="save">💾 save</button>
        <button class="st-btn st-cancel" title="cancel">cancel</button>
      </div>
    </div>`
  el.querySelector('.st-title').textContent = n.title || 'untitled'
  el.querySelector('.st-body').textContent = n.text || '—'
  el.querySelector('.st-edit').addEventListener('click', () => startNoteEdit(el, n))
  el.querySelector('.st-del').addEventListener('click', async () => {
    if (!confirm('delete this note?')) return
    state.notes = state.notes.filter((x) => x.id !== n.id)
    el.remove()
    renderNotesPreview()
    if (n.id) {
      try { await fetch(api('/api/notes/delete'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: n.id }) }) } catch {}
    }
  })
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.st-btn, .st-editor, input, textarea')) return
    if (notesEditingId === n.id) return
    notesDrag = { id: n.id, el, n, sx: e.clientX, sy: e.clientY, l: el.offsetLeft, t: el.offsetTop }
    el.classList.add('dragging')
    try { el.setPointerCapture(e.pointerId) } catch {}
  })
  el.addEventListener('pointermove', (e) => {
    if (!notesDrag || notesDrag.el !== el) return
    const s = notesScale()
    const x = clampN(notesDrag.l + (e.clientX - notesDrag.sx) / s, 0, OFFICE_W - el.offsetWidth)
    const y = clampN(notesDrag.t + (e.clientY - notesDrag.sy) / s, 0, OFFICE_H - el.offsetHeight)
    el.style.left = x + 'px'
    el.style.top = y + 'px'
    n.x = Math.round(x)
    n.y = Math.round(y)
  })
  const endDrag = async (e) => {
    if (!notesDrag || notesDrag.el !== el) return
    notesDrag = null
    el.classList.remove('dragging')
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch {}
    await saveNote(n)
    afterNoteInteraction()
  }
  el.addEventListener('pointerup', endDrag)
  el.addEventListener('pointercancel', endDrag)
  const inTitle = el.querySelector('.st-in-title')
  const inText = el.querySelector('.st-in-text')
  inTitle.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); inText.focus() }
    if (e.key === 'Escape') { e.stopPropagation(); cancelNoteEdit(el, n) }
  })
  inText.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); saveNoteEdit(el, n) }
    if (e.key === 'Escape') { e.stopPropagation(); cancelNoteEdit(el, n) }
  })
  el.querySelector('.st-save').addEventListener('click', () => saveNoteEdit(el, n))
  el.querySelector('.st-cancel').addEventListener('click', () => cancelNoteEdit(el, n))
  return el
}

async function saveNote(n) {
  if (!n.id) return
  try {
    const res = await fetch(api('/api/notes/save'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: n.id, title: n.title, text: n.text, x: n.x, y: n.y })
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
  } catch (e) {
    alert('could not save the note: ' + String(e && e.message || e) + ' — restart the agentwatch server to load notes support')
  }
}

function startNoteEdit(el, n) {
  notesEditingId = n.id
  el.classList.add('editing')
  el.querySelector('.st-in-title').value = n.title || ''
  el.querySelector('.st-in-text').value = n.text || ''
  el.querySelector('.st-in-title').focus()
}

function cancelNoteEdit(el, n) {
  if (!n.id) {
    state.notes = state.notes.filter((x) => x !== n)
    el.remove()
  } else {
    el.classList.remove('editing')
  }
  notesEditingId = null
  afterNoteInteraction()
}

async function saveNoteEdit(el, n) {
  n.title = el.querySelector('.st-in-title').value.trim().slice(0, 120)
  n.text = el.querySelector('.st-in-text').value.slice(0, 4000)
  try {
    const res = await fetch(api('/api/notes/save'), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: n.id || undefined, title: n.title, text: n.text, x: n.x, y: n.y })
    })
    const d = await res.json()
    if (d.ok && d.note) Object.assign(n, d.note)
    else throw new Error(d.error || 'HTTP ' + res.status)
  } catch (e) {
    alert('could not save the note: ' + String(e && e.message || e) + ' — restart the agentwatch server to load notes support')
  }
  notesEditingId = null
  el.classList.remove('editing')
  el.dataset.id = n.id
  el.querySelector('.st-title').textContent = n.title || 'untitled'
  el.querySelector('.st-body').textContent = n.text || '—'
  renderNotesPreview()
  afterNoteInteraction()
}

async function addNote() {
  if (notesEditingId) return
  const i = state.notes.length
  const n = {
    id: '', title: 'Reminder',
    text: 'Sample note: drag me around the wall, click ✎ to edit me, ✕ to delete me.',
    x: clampN(28 + (i % 4) * 186, 0, OFFICE_W - 180),
    y: clampN(16 + Math.floor(i / 4) * 108, 0, OFFICE_H - 150),
    hue: Math.floor(Math.random() * 360)
  }
  state.notes.push(n)
  renderNotes()
  startNoteEdit($('#notes').querySelector(`[data-id=""]`), n)
}

function openNotes() {
  $('#notesModal').classList.add('open')
  renderNotes()
}

function closeNotes() { $('#notesModal').classList.remove('open') }

function loadNotes() {
  fetch(api('/api/notes'))
    .then((r) => r.json())
    .then((d) => { state.notes = d.notes || []; renderNotes() })
    .catch(() => {})
}

$('#notesBtn').addEventListener('click', (e) => { e.stopPropagation(); openNotes() })
$('#notesAdd').addEventListener('click', addNote)
$('#notesClose').addEventListener('click', closeNotes)
$('#notesModal .backdrop').addEventListener('click', closeNotes)

/* ---------- fake CEO video call (desk phone on the main desk) ---------- */
const CEO_SCRIPT = [
  { mood: 'calm', text: 'Ah, finally someone picks up! This is Rick, the CEO. Just a second, I promise.' },
  { mood: 'calm', text: 'So: the project. Where are we? And don\'t tell me "almost ready", you\'ve been repeating that for three sprints.' },
  { mood: 'annoyed', text: 'I looked at the board this morning. Lots of tasks in progress, very few in done. You know what that chart tells me? That we\'re burning budget.' },
  { mood: 'annoyed', text: 'The board meets on Friday. FRIDAY. And I have to present something that works, not a demo that crashes on the second click.' },
  { mood: 'furious', text: 'And don\'t talk to me about refactoring! I don\'t want to hear the word refactoring! I want to see FEATURES. THAT. WORK.' },
  { mood: 'furious', text: 'So everything ships by Friday. Make those agents work day and night, they\'re machines, they don\'t get tired!' },
  { mood: 'calm', text: 'Anyway, great work team. I love your energy. See you Friday. Bye bye!' }
]

const MOOD_LABEL = { calm: 'calm', annoyed: 'annoyed', furious: 'furious' }

const call = { open: false, idx: -1, timer: null, tick: null, type: null, startedAt: 0, muted: false, ringLoop: null }

function setPhoneRinging(on) {
  const p = $('#deskPhone')
  if (!p) return
  p.classList.toggle('ringing', !!on)
}

// the CEO only bothers the office while the main desk is actually busy
function scheduleRing() {
  clearTimeout(call.ringLoop)
  call.ringLoop = setTimeout(() => {
    if (!call.open && mainDeskOccupied()) {
      setPhoneRinging(true)
      setTimeout(() => setPhoneRinging(false), 7000)
    }
    scheduleRing()
  }, 45000)
}

function callTypeOut(text) {
  const el = $('#callSub')
  clearInterval(call.type)
  el.textContent = ''
  const caret = document.createElement('span')
  caret.className = 'cs-caret'
  el.appendChild(caret)
  let i = 0
  call.type = setInterval(() => {
    if (i >= text.length) {
      clearInterval(call.type)
      call.type = null
      caret.remove()
      $('#ceoAvatar').classList.remove('talking')
      return
    }
    caret.insertAdjacentText('beforebegin', text[i++])
  }, 26)
}

function callAdvance() {
  if (!call.open) return
  if (call.type) {
    clearInterval(call.type)
    call.type = null
    const line = CEO_SCRIPT[call.idx]
    if (line) $('#callSub').textContent = line.text
    $('#ceoAvatar').classList.remove('talking')
    return
  }
  call.idx++
  const line = CEO_SCRIPT[call.idx]
  if (!line) {
    $('#callSub').textContent = 'Rick has closed the call. Happy Friday.'
    $('#ceoAvatar').className = 'ceo'
    $('#callNext').disabled = true
    $('#callNext').textContent = '—'
    return
  }
  const ceo = $('#ceoAvatar')
  ceo.className = 'ceo talking ' + line.mood
  $('#callMood').textContent = MOOD_LABEL[line.mood] || line.mood
  $('#callMood').className = 'call-badge ' + line.mood
  $('#callNext').textContent = call.idx >= CEO_SCRIPT.length - 1 ? '▸ ok, ok…' : '▸ listen'
  callTypeOut(line.text)
}

function openCall() {
  if (call.open) return
  call.open = true
  call.idx = -1
  call.muted = false
  call.startedAt = Date.now()
  setPhoneRinging(false)
  $('#deskPhone').classList.add('offhook')
  $('#callMute').classList.remove('on')
  $('#callMute').textContent = '🎤 mute'
  $('.call-self').classList.remove('muted')
  $('#callNext').disabled = false
  $('#callNext').textContent = '▸ listen'
  $('#callMood').textContent = MOOD_LABEL.calm
  $('#callMood').className = 'call-badge calm'
  $('#callSub').textContent = 'connecting…'
  $('#callTimer').textContent = '00:00'
  $('#callModal').classList.add('open')
  clearInterval(call.tick)
  call.tick = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000)
    $('#callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
  }, 1000)
  clearTimeout(call.timer)
  call.timer = setTimeout(callAdvance, 900)
}

function closeCall() {
  if (!call.open) return
  call.open = false
  clearInterval(call.tick)
  clearInterval(call.type)
  clearTimeout(call.timer)
  call.tick = call.type = call.timer = null
  $('#callModal').classList.remove('open')
  $('#deskPhone').classList.remove('offhook')
  $('#ceoAvatar').className = 'ceo'
  scheduleRing()
}

$('#deskPhone').addEventListener('click', (e) => {
  e.stopPropagation()
  openCall()
})
$('#callNext').addEventListener('click', callAdvance)
$('#callHang').addEventListener('click', closeCall)
$('#callClose').addEventListener('click', closeCall)
$('#callModal .backdrop').addEventListener('click', closeCall)
$('#callMute').addEventListener('click', () => {
  call.muted = !call.muted
  $('#callMute').classList.toggle('on', call.muted)
  $('#callMute').textContent = call.muted ? '🔇 muted' : '🎤 mute'
  $('.call-self').classList.toggle('muted', call.muted)
})
scheduleRing()

function confirmDone() {
  $('#doneAlert').classList.remove('show')
  const main = office.chars.get('main')
  if (main && main.slot) walkOut(main)
}
$('#doneConfirm').addEventListener('click', confirmDone)
$('#doneClose').addEventListener('click', confirmDone)

function openCatalog(tab) { setCatalogTab(tab); $('#modal').classList.add('open'); }
function closeCatalog() { $('#modal').classList.remove('open'); }
function setCatalogTab(tab) {
  for (const b of document.querySelectorAll('.mtab')) b.classList.toggle('active', b.dataset.tab === tab)
  for (const p of document.querySelectorAll('.tabpane')) p.classList.toggle('active', p.id === 'pane-' + tab)
}
$('#catalogBtn').addEventListener('click', () => openCatalog('agents'))
document.querySelectorAll('.mtab').forEach((b) => b.addEventListener('click', () => setCatalogTab(b.dataset.tab)))
$('#modalClose').addEventListener('click', closeCatalog)
$('#modal .backdrop').addEventListener('click', closeCatalog)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeCatalog(); closeDoc(); closeUsage(); closeTasks(); closeNotes(); closeConsole(); closeGit(); closeCall(); closeTeam() } })
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R')) {
    e.preventDefault()
    document.body.classList.toggle('raining')
  }
})

function mdToHtml(src) {
  const escM = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  const inline = (s) => {
    const codes = []
    s = String(s).replace(/`([^`]+)`/g, (_m, c) => { codes.push(c); return `\u0001${codes.length - 1}\u0001` })
    s = escM(s)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/__([^_]+)__/g, '<b>$1</b>')
      .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
      .replace(/~~([^~]+)~~/g, '<s>$1</s>')
      .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">🖼 $1</a>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>')
    return s.replace(/\u0001(\d+)\u0001/g, (_m, n) => `<code>${escM(codes[+n])}</code>`)
  }
  const lines = String(src).replace(/\r\n/g, '\n').split('\n')
  const out = []
  let inCode = false, code = [], codeLang = ''
  const flushCode = () => {
    if (!inCode) return
    out.push(`<pre><code>${code.map(escM).join('\n')}</code></pre>`)
    inCode = false; code = []; codeLang = ''
  }
  const para = []
  const flushPara = () => {
    if (para.length) {
      out.push('<p>' + inline(para.join('\n')).replace(/\n/g, '<br>') + '</p>')
      para.length = 0
    }
  }
  const stack = []
  const closeTo = (n) => { while (stack.length > n) out.push(stack.pop()) }
  let itemBuf = []
  const endItem = () => {
    if (itemBuf.length) {
      out.push(`<li>${inline(itemBuf.join('\n')).replace(/\n/g, '<br>')}</li>`)
      itemBuf = []
    }
  }
  const closeAllLists = () => { endItem(); while (stack.length) out.push(stack.pop()) }
  let i = 0
  while (i < lines.length) {
    const raw = lines[i]
    const fence = raw.match(/^\s*```\s*(\w*)/)
    if (fence) {
      flushPara(); closeAllLists(); flushCode()
      if (inCode) flushCode()
      else { inCode = true; codeLang = fence[1] }
      i++
      continue
    }
    if (inCode) { code.push(raw); i++; continue }
    const t = raw.trim()
    const h = t.match(/^(#{1,6})\s+(.*)/)
    if (h) { flushPara(); closeAllLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushPara(); closeAllLists(); out.push('<hr>'); i++; continue }
    if (/^\|.*\|\s*$/.test(t)) {
      flushPara(); closeAllLists()
      const rows = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i].trim())) {
        rows.push(lines[i].trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()))
        i++
      }
      if (rows.length >= 2 && rows[1].every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '')))) {
        const head = rows[0], body = rows.slice(2)
        let html = '<table><thead><tr>' + head.map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
        html += body.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
        out.push(html + '</tbody></table>')
      } else {
        out.push('<p>' + inline(t) + '</p>')
      }
      continue
    }
    if (/^>/.test(t)) {
      flushPara(); closeAllLists()
      const q = []
      while (i < lines.length && /^>/.test(lines[i].trim())) {
        q.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      out.push('<blockquote>' + inline(q.join('\n')).replace(/\n/g, '<br>') + '</blockquote>')
      continue
    }
    const lm = t.match(/^([-*+]|\d+[.)])\s+(.*)/)
    if (lm) {
      flushPara()
      const isOl = /^\d/.test(lm[1])
      const depth = Math.min(Math.floor(/^\s*/.exec(raw)[0].length / 2), 8)
      const closeTag = isOl ? '</ol>' : '</ul>'
      const openTag = isOl ? '<ol>' : '<ul>'
      endItem()
      closeTo(depth)
      if (stack.length && stack.length === depth && stack[stack.length - 1] !== closeTag) {
        out.push(stack.pop())
      }
      while (stack.length <= depth) {
        stack.push(closeTag)
        out.push(openTag)
      }
      itemBuf = [lm[2]]
      i++
      continue
    }
    if (stack.length && itemBuf.length && /^\s+\S/.test(raw)) {
      itemBuf.push(raw.replace(/^\s+/, ''))
      i++
      continue
    }
    if (!t) {
      flushPara()
      if (stack.length && itemBuf.length) itemBuf.push('')
      else closeAllLists()
      i++
      continue
    }
    para.push(t)
    i++
  }
  flushPara(); closeAllLists(); flushCode()
  return out.join('\n')
}

let docData = null
let docTab = 'md'

function renderDoc() {
  const body = $('#docBody')
  if (!docData) return
  if (docTab === 'raw') body.innerHTML = `<pre class="raw">${esc(docData.content)}</pre>`
  else body.innerHTML = `<div class="md">${mdToHtml(docData.content)}</div>`
}

function openDoc(file) {
  $('#docTitle').textContent = file
  $('#docModal').classList.add('open')
  $('#docBody').innerHTML = `<div class="empty">looking for <b>${esc(file)}</b>…</div>`
  fetch(api('/api/doc?name=' + encodeURIComponent(file)))
    .then((r) => r.json())
    .then((d) => {
      if (!d.found) {
        const extra = d.error ? `<span class="doc-searched">${esc(d.error)}</span>` : ''
        $('#docBody').innerHTML = `<div class="doc-missing">not found <b>${esc(file)}</b>${extra}<span class="doc-searched">searched in: ${esc(d.searched || '')}</span></div>`
        return
      }
      docData = d
      renderDoc()
    })
    .catch((e) => {
      $('#docBody').innerHTML = `<div class="doc-missing">error: ${esc(String(e && e.message || e))}</div>`
    })
}

function closeDoc() { $('#docModal').classList.remove('open') }
$('#docClose').addEventListener('click', closeDoc)
$('#docModal .backdrop').addEventListener('click', closeDoc)
$('#docModal .doc-tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.dtab')
  if (!b) return
  document.querySelectorAll('#docModal .dtab').forEach((x) => x.classList.remove('active'))
  b.classList.add('active')
  docTab = b.dataset.tab
  renderDoc()
})
let transcriptAgent = null
let transcriptTimer = null

function renderTranscriptBlock(b) {
  if (b.type === 'text') return `<div class="tr-block">${esc(b.text)}</div>`
  if (b.type === 'thinking') return `<div class="tr-block thinking">${esc(b.text)}</div>`
  if (b.type === 'tool_use') return `<div class="tr-block tr-tool"><span class="tr-tool-name">${esc(b.name)}</span> ${esc(b.input)}</div>`
  return ''
}

function renderTranscriptMessage(m) {
  if (m.role === 'tool_result') {
    return `<div class="tr-msg role-tool_result"><div class="tr-role">${esc(m.toolName || 'tool')} result</div><div class="tr-block tr-tool">${esc(m.content)}</div></div>`
  }
  const blocks = (m.blocks || []).map(renderTranscriptBlock).join('')
  return `<div class="tr-msg role-${esc(m.role)}"><div class="tr-role">${esc(m.role)}</div>${blocks}</div>`
}

function loadTranscript(agentId) {
  fetch(api('/api/transcript?agent=' + encodeURIComponent(agentId)))
    .then((r) => r.json())
    .then((d) => {
      if (transcriptAgent !== agentId) return
      if (!d.found) {
        $('#transcriptBody').innerHTML = `<div class="empty">${esc(d.error || 'no transcript')}</div>`
        return
      }
      const body = $('#transcriptBody')
      const wasAtBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 24
      body.innerHTML = d.messages.length
        ? d.messages.map(renderTranscriptMessage).join('')
        : '<div class="empty">no messages yet…</div>'
      if (wasAtBottom) body.scrollTop = body.scrollHeight
    })
    .catch((e) => {
      if (transcriptAgent !== agentId) return
      $('#transcriptBody').innerHTML = `<div class="doc-missing">error: ${esc(String(e && e.message || e))}</div>`
    })
}

function openTranscript(agentId) {
  const rec = state.byId.get(agentId)
  transcriptAgent = agentId
  $('#transcriptTitle').textContent = rec ? agentLabel(rec) + ' · ' + agentId : agentId
  $('#transcriptModal').classList.add('open')
  $('#transcriptBody').innerHTML = '<div class="empty">loading…</div>'
  loadTranscript(agentId)
  clearInterval(transcriptTimer)
  transcriptTimer = setInterval(() => {
    const live = state.byId.get(transcriptAgent)
    if (live && live.status !== 'running' && live.status !== 'started') return
    loadTranscript(transcriptAgent)
  }, 3000)
}

function closeTranscript() {
  $('#transcriptModal').classList.remove('open')
  clearInterval(transcriptTimer)
  transcriptTimer = null
  transcriptAgent = null
}
$('#transcriptClose').addEventListener('click', closeTranscript)
$('#transcriptModal .backdrop').addEventListener('click', closeTranscript)

const cabinetEl = document.querySelector('.cabinet')
cabinetEl.querySelector('.d1').addEventListener('click', (e) => {
  e.stopPropagation()
  openTeam()
})

function openTeam() {
  renderTeam()
  $('#teamModal').classList.add('open')
}
function closeTeam() { $('#teamModal').classList.remove('open') }
$('#teamClose').addEventListener('click', closeTeam)
$('#teamModal .backdrop').addEventListener('click', closeTeam)

const fileIcon = (name, type) => {
  if (type === 'dir') return '📁'
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : ''
  const map = {
    md: '📝', txt: '📄', js: '🟨', jsx: '🟨', ts: '🟦', tsx: '🟦', mjs: '🟨', cjs: '🟨',
    json: '📋', yml: '📋', yaml: '📋', toml: '📋', css: '🎨', scss: '🎨', html: '🌐',
    py: '🐍', sh: '🐚', zsh: '🐚', bash: '🐚', java: '☕', go: '🐹', rs: '🦀', c: '⚙️',
    h: '⚙️', cpp: '⚙️', hpp: '⚙️', sql: '🗄', lock: '🔒', svg: '🖼', png: '🖼', jpg: '🖼',
    jpeg: '🖼', gif: '🖼', webp: '🖼', ico: '🖼', pdf: '📕', zip: '🗜', gz: '🗜',
    mp3: '🎵', wav: '🎵', mp4: '🎬', test: '🧪', spec: '🧪'
  }
  return map[ext] || (name === 'package.json' || name === 'package-lock.json' ? '📦' : '📄')
}

const fmtSize = (n) => {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

let filePath = ''

function renderFiles(data) {
  const body = $('#filesBody')
  const parts = (data.path && data.path !== '.' ? data.path : '').split('/').filter(Boolean)
  $('#fileCrumb').innerHTML =
    `<button class="fcrumb-seg root" data-path="">🗂 project</button>` +
    parts.map((p, i) => {
      const path = parts.slice(0, i + 1).join('/')
      return `<span class="fcrumb-sep">/</span><button class="fcrumb-seg" data-path="${esc(path)}">${esc(p)}</button>`
    }).join('')
  if (!data.entries.length) {
    body.innerHTML = `<div class="empty">empty folder</div>`
    return
  }
  body.innerHTML = `<div class="files-grid">` + data.entries.map((e) => `
    <button class="fentry ${e.type}" data-type="${e.type}" data-path="${esc(e.path)}">
      <span class="ficon">${fileIcon(e.name, e.type)}</span>
      <span class="fname" title="${esc(e.path)}">${esc(e.name)}</span>
      ${e.type === 'file' ? `<span class="fsize">${fmtSize(e.size)}</span>` : ''}
    </button>`).join('') + `</div>`
}

function loadFiles(path) {
  filePath = path || ''
  const body = $('#filesBody')
  body.innerHTML = `<div class="empty">loading <b>${esc(filePath || 'project root')}</b>…</div>`
  fetch(api('/api/files?path=' + encodeURIComponent(filePath)))
    .then((r) => r.json())
    .then((d) => {
      if (d.error) {
        body.innerHTML = `<div class="doc-missing">error: ${esc(d.error)}</div>`
        return
      }
      renderFiles(d)
    })
    .catch((e) => {
      body.innerHTML = `<div class="doc-missing">error: ${esc(String(e && e.message || e))}</div>`
    })
}

function openFiles() {
  $('#filesModal').classList.add('open')
  loadFiles('')
  const repo = $('#fileRepo')
  if (!repo) return
  repo.innerHTML = ''
  fetch(api('/api/repo-url'))
    .then((r) => r.json())
    .then((d) => {
      if (!d || !d.ok || !d.url) return
      repo.innerHTML = `<a class="repo-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer" title="${esc(d.url)}">🔗 ${esc(d.url)}</a>`
    })
    .catch(() => {})
}
function closeFiles() { $('#filesModal').classList.remove('open') }

cabinetEl.querySelector('.d2').addEventListener('click', (e) => {
  e.stopPropagation()
  openFiles()
})
$('#filesClose').addEventListener('click', closeFiles)
$('#filesModal .backdrop').addEventListener('click', closeFiles)
$('#filesModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFiles()
})
$('#fileCrumb').addEventListener('click', (e) => {
  const seg = e.target.closest('.fcrumb-seg')
  if (!seg) return
  loadFiles(seg.dataset.path)
})
$('#filesBody').addEventListener('click', (e) => {
  const entry = e.target.closest('.fentry')
  if (!entry) return
  if (entry.dataset.type === 'dir') {
    loadFiles(entry.dataset.path)
  } else {
    closeFiles()
    openDoc(entry.dataset.path)
  }
})

const GIT_ICON = { added: '🟢', modified: '✏️', deleted: '🗑', renamed: '🔀', copied: '📑', 'type changed': '🔧', unmerged: '💥', untracked: '➕' }
const GIT_LABEL = { added: 'added', modified: 'modified', deleted: 'deleted', renamed: 'renamed', copied: 'copied', 'type changed': 'type changed', unmerged: 'unmerged', untracked: 'untracked' }

function renderGit(data) {
  const body = $('#gitBody')
  const groups = new Map()
  for (const f of data.files || []) {
    const g = groups.get(f.kind) || []
    g.push(f)
    groups.set(f.kind, g)
  }
  const order = ['added', 'modified', 'untracked', 'deleted', 'renamed', 'copied', 'type changed', 'unmerged']
  const html = [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([kind, files]) => `<div class="git-group ${kind}">
      <div class="git-head"><span class="git-ico">${GIT_ICON[kind] || '•'}</span>${GIT_LABEL[kind] || kind}<span class="git-n">${files.length}</span></div>
      ${files.map((f) => `<div class="git-file" data-path="${esc(f.path)}"><span class="git-code">${esc(f.code.trim())}</span><span class="git-path">${esc(f.path)}</span></div>`).join('')}
    </div>`).join('')
  if (!html) {
    body.innerHTML = '<div class="empty">working tree is clean — no local changes</div>'
    return
  }
  body.innerHTML = html
}

function openGit() {
  $('#gitModal').classList.add('open')
  $('#gitBody').innerHTML = `<div class="empty">reading local git changes…</div>`
  fetch(api('/api/git'))
    .then((r) => r.json())
    .then((d) => {
      if (!d.ok) {
        $('#gitBody').innerHTML = `<div class="doc-missing">could not read git status<span class="doc-searched">${esc(d.error || 'unknown error')}</span></div>`
        return
      }
      renderGit(d)
    })
    .catch((e) => {
      $('#gitBody').innerHTML = `<div class="doc-missing">error: ${esc(String(e && e.message || e))}</div>`
    })
}
function closeGit() { $('#gitModal').classList.remove('open') }

cabinetEl.querySelector('.d3').addEventListener('click', (e) => {
  e.stopPropagation()
  openGit()
})
$('#gitClose').addEventListener('click', closeGit)
$('#gitModal .backdrop').addEventListener('click', closeGit)
$('#gitModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeGit()
})
$('#gitBody').addEventListener('click', (e) => {
  const row = e.target.closest('.git-file')
  if (!row) return
  closeGit()
  openDoc(row.dataset.path)
})

const doorEl = $('#door')
const doorSign = doorEl.querySelector('.sign')
if (AGW) {
  doorSign.textContent = '← hall'
  doorEl.title = 'torna alla hall'
  doorEl.classList.add('exit')
  let leaving = false
  doorEl.addEventListener('click', () => {
    if (leaving) return
    leaving = true
    openDoor()
    setTimeout(() => { location.href = '/' }, 550)
  })
} else {
  doorEl.title = 'exit: available in hub mode (agentwatch hub)'
  doorEl.addEventListener('click', () => openDoor())
}

const coffeeEl = $('#coffee')
if (coffeeEl) {
  const DRINKS = ['espresso', 'cappuccino', 'doppio', 'flat white', 'macchiato', 'ristretto']
  let brewing = false
  coffeeEl.addEventListener('click', () => {
    if (brewing) return
    brewing = true
    coffeeEl.classList.remove('served')
    coffeeEl.querySelector('.shot').textContent = '☕ ' + DRINKS[Math.floor(Math.random() * DRINKS.length)] + '!'
    coffeeEl.classList.add('brewing')
    setTimeout(() => {
      coffeeEl.classList.remove('brewing')
      coffeeEl.classList.add('served')
    }, 1300)
    setTimeout(() => { brewing = false }, 2900)
  })
}

const coolerEl = $('#cooler')
if (coolerEl) {
  const HYDRO = ['stay hydrated!', 'glug glug!', 'hydration 100%', 'water you doing?', '8 glasses a day!', 'pure H₂O!']
  let pouring = false
  coolerEl.addEventListener('click', () => {
    if (pouring) return
    pouring = true
    coolerEl.classList.remove('served')
    coolerEl.querySelector('.shot').textContent = '💧 ' + HYDRO[Math.floor(Math.random() * HYDRO.length)]
    coolerEl.classList.add('pouring')
    setTimeout(() => {
      coolerEl.classList.remove('pouring')
      coolerEl.classList.add('served')
    }, 1600)
    setTimeout(() => { pouring = false }, 3000)
  })
}

const plantEl = $('#plant')
if (plantEl) {
  const CHATS = ['🌵 hi!', '🌵 wiggle wiggle!', '🌵 photosynthesizing…', '🌵 water me!', '🌵 doot doot!', '🌵 thorns up!', '🌵 growth spurt!']
  let dancing = false
  plantEl.addEventListener('click', () => {
    if (dancing) return
    dancing = true
    plantEl.classList.remove('served')
    plantEl.querySelector('.shot').textContent = CHATS[Math.floor(Math.random() * CHATS.length)]
    plantEl.classList.add('boogie')
    setTimeout(() => {
      plantEl.classList.remove('boogie')
      plantEl.classList.add('served')
    }, 1000)
    setTimeout(() => { dancing = false }, 2400)
  })
}

async function doRescan() {
  const res = await fetch(api('/api/rescan'), { method: 'POST' })
  if (res.ok) {
    state.catalog = await res.json()
    renderCatalog()
  }
}
const rescanBtn = $('#rescan')
if (rescanBtn) rescanBtn.addEventListener('click', doRescan)
$('#rescan2').addEventListener('click', doRescan)

async function clearStale() {
  if (!confirm('force-clear stuck/ghost sessions? this only resets the dashboard\'s tracking state — it does not stop any real work, and live seated agents are left untouched.')) return
  try {
    const res = await fetch(api('/api/agents/clear-stale'), { method: 'POST' })
    const data = await res.json()
    alert(data.cleared && data.cleared.length ? `cleared ${data.cleared.length} stuck session(s)` : 'nothing to clear — no stuck sessions found')
  } catch (e) {
    alert('failed to clear: ' + String(e && e.message || e))
  }
}
const clearStaleBtn = $('#clearStaleBtn')
if (clearStaleBtn) clearStaleBtn.addEventListener('click', clearStale)

function periodOf(now) {
  const h = now.getHours()
  if (h < 6) return 'night'       // 00–06
  if (h < 12) return 'morning'    // 06–12
  if (h < 18) return 'afternoon'  // 12–18
  return 'evening'                // 18–24
}

function tickClock() {
  const now = new Date()
  $('#clockTime').textContent = now.toLocaleTimeString('en-GB', { hour12: false })
  $('#clockDate').textContent = now.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
  document.body.dataset.period = periodOf(now)
}

setInterval(tickOffice, 1000)
setInterval(tickClock, 1000)
tickClock()
fitOffice()
setFeedCollapsed(true)

connect()
