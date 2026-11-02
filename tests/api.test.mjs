import { before, after, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/src/index.ts'
import { createFixture, fixturePassword, fixtures, hash } from './support.mjs'

let platform
let env
before(async () => { platform = await createFixture(); env = platform.env })
after(async () => { await platform?.dispose() })
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare('DELETE FROM sessions'), env.DB.prepare('DELETE FROM rate_limits')])
})
function call(path, { method = 'GET', token, body, headers = {}, config = env } = {}) {
  return worker.fetch(new Request(`http://127.0.0.1:5190${path}`, {
    method, headers: { 'CF-Connecting-IP': '192.0.2.1', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), config)
}
async function login() {
  const response = await call('/auth/login', { method: 'POST', body: { password: fixturePassword } })
  assert.equal(response.status, 200)
  return (await response.json()).data
}

test('public health exposes no private counts; configuration fails closed', async () => {
  assert.deepEqual(await (await call('/health')).json(), { ok: true, data: { ready: true } })
  assert.equal((await call('/contacts', { config: { ...env, CLASS_PASSWORD_HASH: '' } })).status, 503)
})
test('all data and statistics require a token, including direct requests', async () => {
  for (const path of ['/contacts', '/contacts/fixture-01', '/cities']) {
    for (const token of [undefined, 'fake', 'a'.repeat(64)]) {
      const response = await call(path, { token })
      assert.equal(response.status, 401)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.ok(!(await response.text()).includes('示例同学'))
    }
  }
})
test('login signs a random expiring token but stores only its digest', async () => {
  const before = Date.now()
  const session = await login()
  assert.match(session.token, /^[a-f0-9]{64}$/)
  assert.ok(session.expiresAt >= before + 12 * 3600000)
  assert.ok(session.expiresAt <= Date.now() + 12 * 3600000)
  const records = (await env.DB.prepare('SELECT * FROM sessions').all()).results
  assert.equal(records.length, 1)
  assert.equal(records[0].token_hash, hash(session.token))
  assert.ok(!JSON.stringify(records).includes(session.token))
  assert.notEqual((await login()).token, session.token)
})
test('wrong password is rejected and no session is created', async () => {
  const response = await call('/auth/login', { method: 'POST', body: { password: 'wrong' } })
  assert.equal(response.status, 401)
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM sessions').first()).count, 0)
})
test('list, pagination, detail and fields remain faithful to the stored fixture', async () => {
  const { token } = await login()
  const response = await call('/contacts', { token })
  const first = (await response.json()).data
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(first.total, 27)
  assert.equal(first.items.length, 12)
  assert.equal(first.nextCursor, 12)
  assert.deepEqual(first.items[0], fixtures[0])
  const second = (await (await call('/contacts?cursor=12&limit=12', { token })).json()).data
  assert.equal(second.items.length, 12)
  assert.equal(second.nextCursor, 24)
  const third = (await (await call('/contacts?cursor=24&limit=12', { token })).json()).data
  assert.equal(third.items.length, 3)
  assert.equal(third.nextCursor, null)
  assert.equal(new Set([...first.items, ...second.items, ...third.items].map(c => c.id)).size, 27)
  assert.deepEqual((await (await call('/contacts/fixture-01', { token })).json()).data, fixtures[0])
})
test('search, unknown city, empty result and protected city counts work', async () => {
  const { token } = await login()
  const get = async path => (await (await call(path, { token })).json()).data
  assert.equal((await get('/contacts?query=示例同学01')).total, 1)
  assert.equal((await get('/contacts?query=不存在')).total, 0)
  assert.equal((await get('/contacts?city=__unknown__')).total, 9)
  assert.equal((await get('/contacts?city=包头')).total, 9)
  assert.deepEqual((await get('/cities')).cities.map(c => c.count), [9, 9, 9])
})
test('forged, expired, revoked and cross-version sessions cannot read', async () => {
  const { token } = await login()
  assert.equal((await call('/contacts', { token, config: { ...env, AUTH_VERSION: 'rotated' } })).status, 401)
  assert.equal((await call('/contacts', { token, config: { ...env, CLASS_PASSWORD_HASH: hash('new-high-entropy-password') } })).status, 401)
  await env.DB.prepare('UPDATE sessions SET expires_at = ?').bind(Date.now() - 1).run()
  assert.equal((await call('/contacts', { token })).status, 401)
  await env.DB.prepare('DELETE FROM sessions').run()
  assert.equal((await call('/contacts', { token })).status, 401)
})
test('logout removes server session; another session stays valid', async () => {
  const first = await login()
  const second = await login()
  assert.equal((await call('/auth/logout', { method: 'POST', token: first.token, body: {} })).status, 200)
  assert.equal((await call('/contacts', { token: first.token })).status, 401)
  assert.equal((await call('/contacts', { token: second.token })).status, 200)
})
test('shared sessions cannot write, delete, claim or become admin', async () => {
  const { token } = await login()
  for (const path of ['/contacts', '/contacts/fixture-01', '/admin', '/claim', '/import']) {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      assert.equal((await call(path, { token, method, body: { admin: true } })).status, 405)
    }
  }
  assert.equal((await env.DB.prepare('SELECT count(*) AS count FROM contacts').first()).count, 27)
})
test('origin policy is exact; no-origin calls still require authentication', async () => {
  const { token } = await login()
  const origin = env.ALLOWED_ORIGIN
  for (const method of ['GET', 'OPTIONS']) {
    const denied = await call('/contacts', { method, token, headers: { Origin: `${origin}.evil.invalid` } })
    assert.equal(denied.status, 403)
    assert.equal(denied.headers.get('access-control-allow-origin'), null)
  }
  const allowed = await call('/contacts', { token, headers: { Origin: origin } })
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin)
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null)
  assert.equal((await call('/contacts', { method: 'OPTIONS', headers: { Origin: origin } })).status, 204)
  assert.equal((await call('/contacts', { token })).status, 200)
})
test('strict query bounds and literal SQL-like search do not alter data', async () => {
  const { token } = await login()
  for (const query of ['limit=0', 'limit=51', 'cursor=-1', 'cursor=1.2', 'cursor=100001', 'query=a&query=b', 'admin=true', `city=${'x'.repeat(61)}`]) {
    assert.equal((await call(`/contacts?${query}`, { token })).status, 400)
  }
  const injected = (await (await call(`/contacts?query=${encodeURIComponent("' OR 1=1 --")}`, { token })).json()).data
  assert.equal(injected.total, 0)
  assert.equal(injected.totalAll, 27)
})
test('JSON keys, value types, content type and request byte limits are bounded', async () => {
  for (const body of [null, [], { password: 123 }, { password: '' }, { password: 'x'.repeat(181) }, { password: fixturePassword, admin: true }]) {
    assert.equal((await call('/auth/login', { method: 'POST', body })).status, 400)
  }
  assert.equal((await call('/auth/login', { method: 'POST', body: { password: 'x'.repeat(3000) } })).status, 413)
  assert.equal((await call('/auth/login', { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 415)
})
test('parallel IP login limit is atomic and stores no plaintext IP', async () => {
  const responses = await Promise.all(Array.from({ length: 24 }, () => call('/auth/login', { method: 'POST', body: { password: 'wrong' } })))
  assert.equal(responses.filter(r => r.status === 401).length, 8)
  assert.equal(responses.filter(r => r.status === 429).length, 16)
  assert.ok(responses.filter(r => r.status === 429).every(r => r.headers.get('retry-after') === '600'))
  const stored = JSON.stringify((await env.DB.prepare('SELECT * FROM rate_limits').all()).results)
  assert.ok(!stored.includes('192.0.2.1'))
})
test('global login budget cannot be bypassed by changing IPs', async () => {
  const hour = Math.floor(Date.now() / 3600000)
  await env.DB.prepare('INSERT INTO rate_limits VALUES (?, 297, ?)').bind(`global:${hour}`, (hour + 1) * 3600000).run()
  const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => call('/auth/login', { method: 'POST', body: { password: 'wrong' }, headers: { 'CF-Connecting-IP': `192.0.2.${i + 2}` } })))
  assert.equal(responses.filter(r => r.status === 401).length, 3)
  assert.equal(responses.filter(r => r.status === 429).length, 9)
})
test('expired records are pruned and no untrusted network fallback is allowed', async () => {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO sessions VALUES (?, ?, ?)').bind('expired', Date.now() - 1, 'old'),
    env.DB.prepare('INSERT INTO rate_limits VALUES (?, 1, ?)').bind('expired', Date.now() - 1),
  ])
  await login()
  assert.equal(await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind('expired').first(), null)
  assert.equal(await env.DB.prepare('SELECT * FROM rate_limits WHERE bucket = ?').bind('expired').first(), null)
  assert.equal((await call('/auth/login', { method: 'POST', body: { password: fixturePassword }, headers: { 'CF-Connecting-IP': '' } })).status, 503)
})
test('deleted contacts are absent from detail, list and all counts', async () => {
  const { token } = await login()
  await env.DB.prepare("UPDATE contacts SET deleted = 1 WHERE id = 'fixture-01'").run()
  try {
    assert.equal((await call('/contacts/fixture-01', { token })).status, 404)
    const data = (await (await call('/contacts', { token })).json()).data
    assert.equal(data.totalAll, 26)
    assert.equal(data.cities.reduce((n, c) => n + c.count, 0), 26)
  } finally { await env.DB.prepare("UPDATE contacts SET deleted = 0 WHERE id = 'fixture-01'").run() }
})
