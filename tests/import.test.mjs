import { before, after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/src/index.ts'
import { createFixture, hash, fixturePassword } from './support.mjs'
let platform, env
const admin = 'b'.repeat(64)
const entry = (id = 'import-test-1') => ({ id, name: `虚构导入${id}`, contactKind: 'other', contactText: '虚构联系方式', city: '', note: '测试', updatedAt: '2026-11-01T10:00:00.000Z', version: 1, importFingerprint: hash(id) })
const batch = (...contacts) => ({ schema: 1, contacts })
before(async () => { platform = await createFixture(); env = { ...platform.env, ADMIN_IMPORT_HASH: hash(admin), IMPORT_TARGET: 'fixture-database' } })
after(async () => { await platform?.dispose() })
beforeEach(async () => { await env.DB.batch([env.DB.prepare('DELETE FROM contacts'), env.DB.prepare('DELETE FROM import_batches'), env.DB.prepare('DELETE FROM rate_limits')]) })
async function call(path, input, bearer = admin, headers = {}) {
  const response = await worker.fetch(new Request(`http://127.0.0.1:5190${path}`, { method: 'POST', headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input) }), env)
  return { status: response.status, ...(await response.json()) }
}
const preview = data => call('/ops/preview', { target: env.IMPORT_TARGET, batch: data })
async function apply(data, receipt) { return call('/ops/apply', { target: env.IMPORT_TARGET, batch: data, receipt: receipt || (await preview(data)).data.receipt }) }

test('member session, wrong management secret and browser origins cannot import', async () => {
  const login = await call('/auth/login', { password: fixturePassword }, '', { 'CF-Connecting-IP': '192.0.2.1' })
  assert.equal(login.status, 200)
  const input = { target: env.IMPORT_TARGET, batch: batch(entry()) }
  for (const token of [login.data.token, fixturePassword, 'c'.repeat(64)]) assert.equal((await call('/ops/preview', input, token)).status, 401)
  assert.equal((await call('/ops/preview', input, admin, { Origin: env.ALLOWED_ORIGIN })).status, 403)
})
test('preview reports counts only, target mismatch and unsigned apply fail', async () => {
  const input = batch(entry())
  const p = await preview(input)
  assert.equal(p.status, 200)
  assert.equal(p.data.summary.added, 1)
  assert.ok(!JSON.stringify(p).includes('虚构'))
  assert.equal((await call('/ops/preview', { target: 'wrong', batch: input })).status, 400)
  assert.equal((await call('/ops/apply', { target: env.IMPORT_TARGET, batch: input })).status, 409)
})
test('import collation preserves canonical digests across input order and ASCII IDs', async () => {
  const input = batch(...['a', 'A', '_a', '-a', 'a_1', 'a-1', 'a10', 'a2', 'Z', 'z', '0'].map(entry))
  const normalized = input.contacts.map(c => ({ ...c, deleted: false })).sort((a, b) => a.id.localeCompare(b.id, 'en'))
  const expected = hash(JSON.stringify(normalized))
  const first = await preview(input)
  const reversed = await preview(batch(...input.contacts.toReversed()))
  assert.equal(first.status, 200)
  assert.equal(first.data.digest, expected)
  assert.equal(reversed.data.digest, expected)
  assert.equal((await apply(input, first.data.receipt)).data.summary.added, input.contacts.length)
  assert.equal((await preview(input)).data.summary.skipped, input.contacts.length)
})
test('200-record import uses bounded chunks and is atomic and idempotent', async () => {
  const input = batch(...Array.from({ length: 200 }, (_, i) => entry(`record-${i}`)))
  const p = await preview(input)
  assert.equal((await apply(input, p.data.receipt)).data.summary.added, 200)
  const repeated = await apply(input, p.data.receipt)
  assert.equal(repeated.status, 200)
  assert.equal(repeated.data.summary.added, 0)
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts').first()).count, 200)
})
test('fresh revisions update; old or same-version changes stop without overwriting', async () => {
  await apply(batch(entry()))
  const changed = { ...entry(), note: '新版测试', version: 2 }
  assert.equal((await apply(batch(changed))).data.summary.updated, 1)
  const conflict = batch({ ...changed, note: '错误覆盖' })
  assert.equal((await preview(conflict)).data.summary.conflicts, 1)
  assert.equal((await apply(conflict)).status, 409)
  assert.equal((await env.DB.prepare('SELECT note FROM contacts').first()).note, '新版测试')
})
test('changed batch, forged receipt and stale database reject preview', async () => {
  const input = batch(entry())
  const p = await preview(input)
  assert.equal((await apply(batch(entry('other')), p.data.receipt)).status, 409)
  assert.equal((await apply(input, { ...p.data.receipt, signature: '0'.repeat(64) })).status, 409)
  await apply(batch(entry('another')))
  assert.equal((await apply(input, p.data.receipt)).status, 409)
})
test('concurrent imports from one revision cannot both modify the snapshot', async () => {
  const a = batch(entry('a')), b = batch(entry('b'))
  const [pa, pb] = await Promise.all([preview(a), preview(b)])
  const results = await Promise.all([apply(a, pa.data.receipt), apply(b, pb.data.receipt)])
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409])
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts').first()).count, 1)
})
test('late storage failure rolls back every imported row and batch metadata', async () => {
  await env.DB.prepare("CREATE TRIGGER reject_test BEFORE INSERT ON contacts WHEN NEW.id = 'z-fail' BEGIN SELECT RAISE(ABORT, 'fixture'); END").run()
  try {
    const input = batch(...Array.from({ length: 20 }, (_, i) => entry(`a-${i}`)), entry('z-fail'))
    assert.equal((await apply(input)).status, 409)
    assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts').first()).count, 0)
    assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM import_batches').first()).count, 0)
  } finally { await env.DB.prepare('DROP TRIGGER reject_test').run() }
})
test('explicit removal scrubs data; old export and new-ID fingerprint cannot resurrect it', async () => {
  await apply(batch(entry()))
  await apply(batch({ id: entry().id, deleted: true, importFingerprint: entry().importFingerprint }))
  const stored = await env.DB.prepare('SELECT * FROM contacts').first()
  assert.equal(stored.deleted, 1)
  for (const key of ['name', 'contact_text', 'city', 'note', 'updated_at']) assert.equal(stored[key], '')
  assert.equal((await apply(batch(entry()))).data.summary.added, 0)
  const renamed = { ...entry(), id: 'other-id' }
  assert.equal((await apply(batch(renamed))).data.summary.added, 0)
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts WHERE deleted = 0').first()).count, 0)
})
test('duplicates, excess rows, metadata leakage and invalid fields stop before writes', async () => {
  for (const input of [batch(entry(), entry()), batch({ ...entry(), ownerId: 'forbidden' }), batch({ ...entry(), note: 'x'.repeat(301) }), batch(...Array.from({ length: 201 }, (_, i) => entry(String(i)))), batch({ ...entry(), deleted: true })]) {
    assert.equal((await preview(input)).status, 400)
  }
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts').first()).count, 0)
})
