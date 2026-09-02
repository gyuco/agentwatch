const $ = (s) => document.querySelector(s)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

const HUES = [210, 150, 300, 25, 100, 250, 180, 340]
const hueFor = (id) => {
  if (id === 'project') return 40
  let h = 0
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return HUES[h % HUES.length]
}
const ACTIVE_MS = 60000

let lastData = null
let entering = false

function fitHall() {
  const wrap = document.querySelector('.hallwrap')
  const hall = $('#hall')
  if (!wrap || !hall) return
  const s = Math.min(wrap.clientWidth / 960, wrap.clientHeight / 540) * 0.97
  hall.style.transform = `scale(${Math.max(0.2, s)})`
}
window.addEventListener('resize', fitHall)

async function load() {
  try {
    const res = await fetch('/api/offices')
    const data = await res.json()
    lastData = data
    $('#conn').classList.add('on')
    $('#conn').classList.remove('off')
    $('#meta').textContent = `hub · port ${data.port}`
    render(data.offices || [])
    $('#hbBody').textContent = boardText(data.offices || [])
  } catch {
    $('#conn').classList.remove('on')
    $('#conn').classList.add('off')
    $('#meta').textContent = 'hub offline'
  }
}

function boardText(offices) {
  const running = offices.filter((o) => o.running > 0).length
  const busy = offices.filter((o) => o.lastActivity && Date.now() - o.lastActivity < ACTIVE_MS).length
  return `offices ${offices.length}\nactive ${running}\nrecent ${busy}`
}

function rel(ts) {
  if (!ts) return 'never'
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function enterOffice(id) {
  if (entering) return
  entering = true
  setTimeout(() => {
    location.href = '/office/' + encodeURIComponent(id)
  }, 550)
}

function doorHTML(o, many) {
  const hue = hueFor(o.id)
  const light = o.running > 0 ? 'live' : o.lastActivity && Date.now() - o.lastActivity < ACTIVE_MS ? 'warm' : ''
  return `
    <div class="hdoor${many ? ' many' : ''}${o.hooks ? '' : ' closed'}" data-id="${esc(o.id)}" style="--hue:${hue}" title="${esc(o.name)}\n${esc(o.path)}\nagents: ${o.agents} · skills: ${o.skills}\nactivity: ${rel(o.lastActivity)}\nhooks: ${o.hooks ? 'installed' : 'missing'}">
      <div class="dlight ${light}"></div>
      <div class="dsign">${esc(o.name.toUpperCase())}</div>
      <div class="dframe">
        <div class="dflap"><div class="dknob"></div></div>
        ${o.hooks ? '' : '<div class="dtag">CLOSED</div>'}
      </div>
      <div class="dplate">🤖 ${o.agents} · 🧩 ${o.skills} · ⚡ ${o.events}</div>
      <button class="brem" title="remove office">✕</button>
    </div>`
}

function addDoorHTML(many) {
  return `
    <div class="hdoor add${many ? ' many' : ''}" id="addDoor" title="create a new office">
      <div class="dsign">NEW</div>
      <div class="dframe">
        <div class="plus">＋</div>
      </div>
      <div class="dplate">new office</div>
    </div>`
}

function render(offices) {
  const grid = $('#hdoors')
  const many = offices.length > 9
  grid.classList.toggle('many', many)
  const html = offices.map((o) => doorHTML(o, many)).join('') + addDoorHTML(many)
  if (grid.innerHTML !== html) {
    grid.innerHTML = html
    wireDoors(offices)
  }
}

function wireDoors(offices) {
  gridDoors().forEach((d) => {
    const id = d.dataset.id
    if (!id) return
    d.addEventListener('click', () => {
      const flap = d.querySelector('.dflap')
      if (flap) flap.classList.add('open')
      enterOffice(id)
    })
    const rem = d.querySelector('.brem')
    if (rem) {
      rem.addEventListener('click', (e) => {
        e.stopPropagation()
        removeOffice(id, d)
      })
    }
  })
  const addD = document.getElementById('addDoor')
  if (addD) {
    addD.addEventListener('click', () => openModal())
  }
}

function gridDoors() {
  return [...document.querySelectorAll('#hdoors .hdoor')]
}

async function removeOffice(id, el) {
  const office = lastData && lastData.offices.find((o) => o.id === id)
  if (!confirm(`close the office "${office ? office.name : id}"? (files stay on disk)`)) return
  el.classList.add('gone')
  const res = await fetch('/api/office/remove', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id })
  })
  if (!res.ok) alert((await res.json()).error || 'error')
  load()
}

const INIT_PROMPT = `You are initializing a new software project. Follow this process step by step, asking questions and waiting for my confirmation before moving to the next step. Do not skip ahead.

STEP 1 — Check for existing documentation
- Check if a file named prd.md (or PRD.md) exists in this project.
- If it exists, read it and summarize your understanding of the project back to me for confirmation.
- If it does not exist, tell me so and proceed to Step 2 to gather the information needed to build one.

STEP 2 — Product clarification (ask one question at a time, confirm each answer)
Ask me questions until the project is clear, covering at least:
- What problem does this project solve, and who is it for?
- What are the core features / user stories for a first version?
- What is explicitly out of scope?
- Are there existing systems, APIs, or constraints it must integrate with?
- What does success look like (acceptance criteria)?
Summarize the answers into a draft PRD and ask me to confirm before continuing.

STEP 3 — Technical clarification (ask one question at a time, confirm each answer)
Once the product side is confirmed, ask about:
- Preferred language(s) and framework(s), or should you recommend one?
- Architecture style (monolith, microservices, serverless, etc.)?
- Database / storage requirements?
- Deployment target (cloud provider, on-prem, local)?
- Testing and CI/CD expectations?
Summarize the technical decisions and ask me to confirm before continuing.

STEP 4 — Agents, skills, and MCP setup
Propose the following as a starting structure, and ask me to confirm or adjust before creating anything:
- Agents (workflow): analyst, architect, scrum-master, coder, reviewer, dev-ops
- Suggest relevant skills and MCP servers based on the confirmed tech stack (ask before adding any)
- Suggest an integrated kanban board with three initial statuses: draft, in progress, done
- Explain that status changes (draft → in progress → done) should be communicated to the scrum-master agent, so it can keep the workflow in sync

For every proposal in this step, ask for my explicit confirmation before creating any agent, skill, MCP configuration, or kanban structure.

Do not create any files or run any commands until I have confirmed each step.`

function openModal() {
  $('#newModal').classList.add('open')
  $('#initPrompt').value = INIT_PROMPT
  $('#ofName').focus()
}

function closeModal() {
  $('#newModal').classList.remove('open')
}

async function submitOffice(name, path, workflow) {
  const btn = $('#newOk')
  btn.disabled = true
  try {
    const res = await fetch('/api/office/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path, ...(workflow ? { workflow } : {}) })
    })
    const data = await res.json()
    if (!res.ok) {
      if (res.status === 409 && data.workflow) {
        if (data.workflow.valid === false) {
          alert(`existing ${data.workflow.path} is invalid: ${data.workflow.error}`)
          return
        }
        await submitOffice(name, path, { mode: 'modify', config: data.workflow.config })
        return
      }
      alert(data.error || 'error')
      return
    }
    closeModal()
    $('#ofName').value = ''
    $('#ofPath').value = ''
    load()
  } catch {
    alert('could not create office')
  } finally {
    btn.disabled = false
  }
}

$('#newClose').addEventListener('click', closeModal)
$('#newBackdrop').addEventListener('click', closeModal)
$('#newModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
})
$('#reload').addEventListener('click', load)
$('#copyInitPrompt').addEventListener('click', async () => {
  const btn = $('#copyInitPrompt')
  try {
    await navigator.clipboard.writeText($('#initPrompt').value)
    const original = btn.textContent
    btn.textContent = 'copied!'
    setTimeout(() => { btn.textContent = original }, 1500)
  } catch {
    alert('could not copy to clipboard')
  }
})
$('#pickPath').addEventListener('click', async () => {
  const btn = $('#pickPath')
  btn.disabled = true
  btn.classList.add('loading')
  try {
    const res = await fetch('/api/office/pick-directory', { method: 'POST' })
    const data = await res.json()
    if (!res.ok) {
      alert(data.error || 'directory picker unavailable')
      return
    }
    if (data.path) {
      $('#ofPath').value = data.path
      $('#ofPath').focus()
    }
  } catch {
    alert('directory picker unavailable')
  } finally {
    btn.disabled = false
    btn.classList.remove('loading')
  }
})

$('#newOk').addEventListener('click', async () => {
  const name = $('#ofName').value.trim()
  const path = $('#ofPath').value.trim()
  if (!name || !path) return
  await submitOffice(name, path)
})

load()
setInterval(load, 2000)
fitHall()
