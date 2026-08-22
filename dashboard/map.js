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
let workflowInspection = null
let catalogData = null
const DEFAULT_WORKFLOW = { version: 1, paths: ['tasks'], statuses: ['todo', 'in-progress', 'done'], defaultStatus: 'todo' }

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

function openModal() {
  $('#newModal').classList.add('open')
  $('#ofName').focus()
}

function closeModal() {
  $('#newModal').classList.remove('open')
  resetWorkflowStep()
}

function resetWorkflowStep() {
  workflowInspection = null
  catalogData = null
  $('#workflowSetup').hidden = true
  $('#workflowConfig').value = ''
  $('#newOk').textContent = 'create office'
  $('#newHint').textContent = 'creates the folder, work-planner agent, work-items skill and task workflow — hooks are installed automatically'
  $('#overwriteWorkflow').hidden = true
}

function workflowConfig(id) {
  const workflow = catalogData && catalogData.workflows.find((item) => item.id === id)
  return workflow ? { version: 1, paths: workflow.paths, statuses: workflow.statuses, defaultStatus: workflow.defaultStatus } : DEFAULT_WORKFLOW
}

function renderCatalogGroup(target, kind, items, selected, conflicts) {
  const occupied = new Set(conflicts.filter((item) => item.type === kind.slice(0, -1)).map((item) => item.id))
  $(target).innerHTML = items.map((item) => `<label class="catalog-option ${occupied.has(item.id) ? 'conflict' : ''}">
    <input type="checkbox" data-kind="${kind}" value="${esc(item.id)}" ${selected.includes(item.id) ? 'checked' : ''}>
    <span>${esc(item.name)}${occupied.has(item.id) ? ' · existing' : ''}<small>${esc(item.description)}${item.installable === false ? ` · ${esc(item.note)}` : ''}</small></span>
  </label>`).join('') || '<span class="nm-detail">none available</span>'
}

function applyPack(packId, updateConfig = false) {
  if (!catalogData) return
  const pack = catalogData.packs.find((item) => item.id === packId)
  $('#packDescription').textContent = pack ? pack.description : 'Choose individual catalog items.'
  if (!pack) return
  const selected = pack
  for (const input of document.querySelectorAll('#workflowSetup input[data-kind]')) {
    input.checked = (selected[input.dataset.kind] || []).includes(input.value)
  }
  if (pack) $('#catalogWorkflow').value = pack.workflow
  updateWorkflowDescription()
  if (updateConfig) $('#workflowConfig').value = JSON.stringify(workflowConfig($('#catalogWorkflow').value), null, 2)
}

function updateWorkflowDescription() {
  const workflow = catalogData && catalogData.workflows.find((item) => item.id === $('#catalogWorkflow').value)
  $('#workflowDescription').textContent = workflow ? workflow.description : ''
}

function catalogSelection() {
  const selected = (kind) => [...document.querySelectorAll(`#workflowSetup input[data-kind="${kind}"]:checked`)].map((input) => input.value)
  return {
    pack: $('#setupPack').value,
    agents: selected('agents'),
    skills: selected('skills'),
    mcps: selected('mcps'),
    workflow: $('#catalogWorkflow').value
  }
}

function showWorkflowSetup(data) {
  workflowInspection = data
  const onboarding = data.onboarding || {}
  catalogData = onboarding.catalog || { packs: [], agents: [], skills: [], mcps: [], workflows: [] }
  const preferredPack = (onboarding.setup && onboarding.setup.pack) || onboarding.recommendedPack || 'minimal'
  const packIds = new Set(catalogData.packs.map((item) => item.id))
  $('#setupPack').innerHTML = catalogData.packs.map((pack) =>
    `<option value="${esc(pack.id)}" ${pack.id === preferredPack ? 'selected' : ''}>${esc(pack.name)}${pack.id === onboarding.recommendedPack ? ' · recommended' : ''}</option>`
  ).join('') + `<option value="custom" ${!packIds.has(preferredPack) ? 'selected' : ''}>Custom</option>`
  $('#catalogWorkflow').innerHTML = catalogData.workflows.map((workflow) => `<option value="${esc(workflow.id)}">${esc(workflow.name)}</option>`).join('')
  const previous = onboarding.setup && onboarding.setup.installed
  const pack = catalogData.packs.find((item) => item.id === preferredPack) || {
    id: 'custom', name: 'Custom', description: 'Previously selected project components.',
    agents: Object.keys((previous && previous.agents) || {}),
    skills: Object.keys((previous && previous.skills) || {}),
    mcps: Object.keys((previous && previous.mcps) || {}),
    workflow: (onboarding.setup && onboarding.setup.workflow) || 'simple-tasks'
  }
  renderCatalogGroup('#catalogAgents', 'agents', catalogData.agents, pack.agents, onboarding.conflicts || [])
  renderCatalogGroup('#catalogSkills', 'skills', catalogData.skills, pack.skills, onboarding.conflicts || [])
  renderCatalogGroup('#catalogMcps', 'mcps', catalogData.mcps, pack.mcps, onboarding.conflicts || [])
  if (pack.id === 'custom') {
    $('#setupPack').value = 'custom'
    $('#catalogWorkflow').value = pack.workflow
    $('#packDescription').textContent = pack.description
    updateWorkflowDescription()
    if (!data.exists) $('#workflowConfig').value = JSON.stringify(workflowConfig(pack.workflow), null, 2)
  } else applyPack(pack.id, !data.exists)
  $('#workflowSetup').hidden = false
  if (data.exists) $('#workflowConfig').value = data.raw || JSON.stringify(data.config || DEFAULT_WORKFLOW, null, 2)
  $('#workflowNotice').innerHTML = data.exists
    ? '⚠ <b>agentwatch.tasks.json already exists.</b> Edit it below or overwrite it with the selected workflow.'
    : `✓ <b>${esc(pack.name)} setup proposed.</b> Review the components before installing.`
  $('#overwriteWorkflow').hidden = !data.exists
  $('#newOk').textContent = data.exists ? 'save changes & create office' : 'install setup & create office'
  $('#newHint').textContent = data.valid === false
    ? `the existing configuration is invalid: ${data.error}. Fix it below or overwrite it.`
    : 'existing catalog files are preserved; MCP connections always require separate manual setup'
}

function configFromEditor() {
  try {
    return JSON.parse($('#workflowConfig').value)
  } catch (err) {
    alert('invalid workflow JSON: ' + err.message)
    return null
  }
}

async function submitOffice(name, path, mode, config) {
  const btn = $('#newOk')
  const overwrite = $('#overwriteWorkflow')
  btn.disabled = true
  overwrite.disabled = true
  try {
    const res = await fetch('/api/office/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, path, workflow: { mode, config }, catalog: catalogSelection() })
    })
    const data = await res.json()
    if (!res.ok) {
      if (res.status === 409 && data.workflow) {
        showWorkflowSetup(data.workflow)
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
    overwrite.disabled = false
  }
}

$('#newClose').addEventListener('click', closeModal)
$('#newBackdrop').addEventListener('click', closeModal)
$('#newModal').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal()
})
$('#reload').addEventListener('click', load)
$('#ofPath').addEventListener('input', () => {
  if (workflowInspection) resetWorkflowStep()
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
      if ($('#ofPath').value !== data.path && workflowInspection) resetWorkflowStep()
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
  if (workflowInspection) {
    const config = configFromEditor()
    if (config) await submitOffice(name, path, workflowInspection.exists ? 'modify' : 'create', config)
    return
  }
  const btn = $('#newOk')
  btn.disabled = true
  try {
    const res = await fetch('/api/office/workflow/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path })
    })
    const data = await res.json()
    if (!res.ok) {
      if (res.status === 404) {
        alert('the Agentwatch server is running an older build — restart the hub and try again')
        return
      }
      alert(data.error || 'could not inspect workflow')
      return
    }
    showWorkflowSetup(data)
  } catch {
    alert('could not inspect workflow')
  } finally {
    btn.disabled = false
  }
})

$('#overwriteWorkflow').addEventListener('click', async () => {
  const name = $('#ofName').value.trim()
  const path = $('#ofPath').value.trim()
  if (!name || !path || !workflowInspection || !workflowInspection.exists) return
  if (!confirm('overwrite agentwatch.tasks.json with the selected workflow? Existing task files will not be changed.')) return
  await submitOffice(name, path, 'overwrite', workflowConfig($('#catalogWorkflow').value))
})

$('#setupPack').addEventListener('change', () => applyPack($('#setupPack').value, !workflowInspection?.exists))
$('#catalogWorkflow').addEventListener('change', () => {
  updateWorkflowDescription()
  if (!workflowInspection?.exists) $('#workflowConfig').value = JSON.stringify(workflowConfig($('#catalogWorkflow').value), null, 2)
})
$('#workflowSetup').addEventListener('change', (event) => {
  if (!event.target.matches('input[data-kind]')) return
  $('#setupPack').value = 'custom'
  $('#packDescription').textContent = 'Choose individual catalog items.'
})

load()
setInterval(load, 2000)
fitHall()
