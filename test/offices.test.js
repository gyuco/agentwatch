import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadOffices, saveOffices, addOffice, removeOffice, findOffice, slugify, registryFile, agentwatchHome } from '../src/offices.js'

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'aw-home-'))
  process.env.AGENTWATCH_HOME = home
  return home
}

test('registry: save/load roundtrip', () => {
  fixture()
  assert.ok(!existsSync(registryFile()))
  saveOffices([{ id: 'a', name: 'A', path: '/tmp/a' }])
  assert.deepEqual(loadOffices(), [{ id: 'a', name: 'A', path: '/tmp/a' }])
})

test('slugify: accents and spaces', () => {
  assert.equal(slugify('Ufficio Primo'), 'ufficio-primo')
  assert.equal(slugify('Città degli Studi'), 'citta-degli-studi')
  assert.equal(slugify('123'), '123')
  assert.equal(slugify('!!!'), 'office')
})

test('addOffice: creates .claude scaffolding, unique id, installs into registry', () => {
  const home = fixture()
  const root = join(home, 'ufficio-due')
  const entry = addOffice({ name: 'Ufficio Due', path: root })
  assert.equal(entry.id, 'ufficio-due')
  assert.equal(entry.name, 'Ufficio Due')
  assert.ok(existsSync(join(root, '.claude', 'agents')))
  assert.ok(existsSync(join(root, '.claude', 'skills')))
  assert.equal(loadOffices().length, 1)

  const dup = addOffice({ name: 'Ufficio Due', path: join(home, 'altro-ufficio') })
  assert.equal(dup.id, 'ufficio-due-2')
  assert.equal(loadOffices().length, 2)

  assert.throws(() => addOffice({ name: 'x', path: root }), /already registered/)
})

test('addOffice installs hooks when runnerPath is given', () => {
  fixture()
  const root = mkdtempSync(join(tmpdir(), 'aw-office-'))
  const runner = join(root, 'runner.js')
  addOffice({ name: 'Con Hooks', path: root, runnerPath: runner })
  const settings = join(root, '.claude', 'settings.local.json')
  assert.ok(existsSync(settings))
  assert.ok(existsSync(join(root, '.agentwatch', 'hooks.json')))
})

test('findOffice matches by id, name or resolved path', () => {
  fixture()
  const root = mkdtempSync(join(tmpdir(), 'aw-find-'))
  addOffice({ name: 'Roma', path: root })
  assert.equal(findOffice('roma').id, 'roma')
  assert.equal(findOffice('Roma').id, 'roma')
  assert.equal(findOffice(root).id, 'roma')
  assert.equal(findOffice('nope'), null)
})

test('removeOffice unregisters and uninstalls hooks', () => {
  fixture()
  const root = mkdtempSync(join(tmpdir(), 'aw-rem-'))
  const runner = join(root, 'runner.js')
  const entry = addOffice({ name: 'Via', path: root, runnerPath: runner })
  assert.ok(existsSync(join(root, '.agentwatch', 'hooks.json')))
  const removed = removeOffice(entry.id, runner)
  assert.equal(removed.id, 'via')
  assert.equal(loadOffices().length, 0)
  assert.ok(!existsSync(join(root, '.agentwatch', 'hooks.json')))
  assert.equal(removeOffice(entry.id), null)
})

test('agentwatchHome honors AGENTWATCH_HOME', () => {
  fixture()
  assert.equal(agentwatchHome(), process.env.AGENTWATCH_HOME)
})