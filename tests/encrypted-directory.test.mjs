import test from 'node:test'
import assert from 'node:assert/strict'
import { decryptDirectory, parseEncryptedFile, loadEncryptedDirectory } from '../public/assets/encrypted-directory.js'
import { encryptFixture, fixturePassword, staticFixtures } from './support.mjs'

const pack = value => Buffer.from(JSON.stringify(value))
const envelope = encryptFixture()
const bytes = pack(envelope)
const formatError = /格式不正确/
function changeHeader(change) {
  const h = JSON.parse(Buffer.from(envelope.protected, 'base64'))
  change(h)
  return pack({ ...envelope, protected: Buffer.from(JSON.stringify(h)).toString('base64') })
}

test('Web Crypto decrypts independently encrypted fixtures with exactly eight fields', async () => {
  assert.deepEqual(await decryptDirectory(bytes, fixturePassword), staticFixtures)
  assert.deepEqual(await decryptDirectory(pack(encryptFixture({ schema: 1, contacts: [] })), fixturePassword), [])
  const next = encryptFixture()
  assert.notEqual(next.protected, envelope.protected)
  assert.notEqual(next.ciphertext, envelope.ciphertext)
  assert.ok(!JSON.stringify(envelope).includes(fixturePassword))
})

test('wrong passwords, altered tags, ciphertext and truncated payloads fail authentication', async () => {
  await assert.rejects(decryptDirectory(bytes, 'wrong'), /口令不正确或加密文件已损坏/)
  for (const position of [0, -1]) {
    const value = Buffer.from(envelope.ciphertext, 'base64')
    const i = position === -1 ? value.length - 1 : position
    value[i] ^= 1
    await assert.rejects(decryptDirectory(pack({ ...envelope, ciphertext: value.toString('base64') }), fixturePassword), /口令不正确/)
  }
  await assert.rejects(decryptDirectory(pack({ ...envelope, ciphertext: Buffer.from(envelope.ciphertext, 'base64').subarray(0, -1).toString('base64') }), fixturePassword), /口令不正确/)
})

test('authenticated metadata cannot be replaced or even reserialized', async () => {
  const h = JSON.parse(Buffer.from(envelope.protected, 'base64'))
  const reordered = { cipher: h.cipher, kdf: h.kdf, format: h.format }
  const encoded = pack({ ...envelope, protected: Buffer.from(JSON.stringify(reordered)).toString('base64') })
  parseEncryptedFile(encoded)
  await assert.rejects(decryptDirectory(encoded, fixturePassword), /口令不正确/)
  for (const change of [h => { h.cipher.iv = Buffer.alloc(12).toString('base64') }, h => { h.kdf.salt = Buffer.alloc(16).toString('base64') }]) await assert.rejects(decryptDirectory(changeHeader(change), fixturePassword), /口令不正确/)
})

test('format, algorithms, KDF costs, nonce sizes and unknown keys fail before derivation', () => {
  for (const change of [
    h => { h.format = 'other' }, h => { h.extra = true }, h => { h.kdf.name = 'scrypt' },
    h => { h.kdf.hash = 'SHA-1' }, h => { h.kdf.iterations = 1 }, h => { h.kdf.iterations = 1e12 },
    h => { h.kdf.salt = Buffer.alloc(15).toString('base64') }, h => { h.kdf.password = 'not-allowed' },
    h => { h.cipher.name = 'AES-CBC' }, h => { h.cipher.keyLength = 128 }, h => { h.cipher.tagLength = 32 },
    h => { h.cipher.iv = Buffer.alloc(11).toString('base64') },
  ]) assert.throws(() => parseEncryptedFile(changeHeader(change)), formatError)
  for (const value of [null, [], {}, { ...envelope, extra: true }, { ...envelope, format: 'other' }, { ...envelope, ciphertext: Buffer.alloc(16).toString('base64') }]) assert.throws(() => parseEncryptedFile(pack(value)), formatError)
})

test('invalid JSON, noncanonical base64, oversized envelopes and headers are rejected', () => {
  for (const value of [new Uint8Array([255]), Buffer.from('{'), new Uint8Array(262145)]) assert.throws(() => parseEncryptedFile(value), formatError)
  for (const value of ['', 'a===', 'AAAA\n', 'AB==', '____', 'A'.repeat(4100)]) assert.throws(() => parseEncryptedFile(pack({ ...envelope, protected: value })), formatError)
  assert.throws(() => parseEncryptedFile(pack({ ...envelope, ciphertext: 'AB==' })), formatError)
})

test('decrypted records reject duplicate IDs, hidden metadata and invalid DTO values', async () => {
  const first = staticFixtures[0]
  const telephone = { ...first, contactKind: 'phone', contactText: '+86 (0472) 1234567' }
  assert.deepEqual(await decryptDirectory(pack(encryptFixture({ schema: 1, contacts: [telephone] })), fixturePassword), [telephone])
  await assert.rejects(decryptDirectory(pack(encryptFixture({ schema: 1, contacts: [{ ...first, updatedAt: '11/01/2026' }] })), fixturePassword), formatError)
  const invalid = [null, [], { schema: 2, contacts: [] }, { schema: 1, contacts: [], extra: true },
    { schema: 1, contacts: [first, first] }, { schema: 1, contacts: Array.from({ length: 201 }, (_, i) => ({ ...first, id: `test-${i}` })) },
    ...[{ ownerId: 'forbidden' }, { importFingerprint: 'forbidden' }, { id: '../private' }, { note: 'x'.repeat(301) }, { name: '' }, { city: null }, { updatedAt: 'invalid' }, { version: 0 }, { contactKind: 'phone', contactText: 'not-a-number' }].map(change => ({ schema: 1, contacts: [{ ...first, ...change }] })),
  ]
  for (const payload of invalid) await assert.rejects(decryptDirectory(pack(encryptFixture(payload)), fixturePassword), formatError)
  for (const password of ['', 123, 'x'.repeat(181)]) await assert.rejects(decryptDirectory(bytes, password), /有效的班级口令/)
})

test('loader fetches only its static file and never transmits the password', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url.pathname.endsWith('/assets/directory.encrypted.json'), true)
    assert.equal(options.cache, 'no-store')
    assert.equal(options.credentials, 'omit')
    assert.equal(options.referrerPolicy, 'no-referrer')
    assert.equal(options.redirect, 'error')
    assert.equal(options.body, undefined)
    assert.equal(options.headers, undefined)
    assert.ok(!String(url).includes(fixturePassword))
    return new Response(bytes)
  })
  assert.deepEqual(await loadEncryptedDirectory('assets/directory.encrypted.json', fixturePassword), staticFixtures)
  assert.equal(calls, 1)
  await assert.rejects(loadEncryptedDirectory('https://example.invalid/file', fixturePassword), /尚未配置/)
  assert.equal(calls, 1)
})

test('loader rejects failed fetches, excess bytes, missing bodies and cancelled results', async t => {
  const cases = [
    { result: () => { throw new TypeError('network') }, pattern: /检查网络/ },
    { result: () => new Response('', { status: 503 }), pattern: /稍后重试/ },
    { result: () => new Response(bytes, { headers: { 'content-length': '262145' } }), pattern: formatError },
    { result: () => new Response(new Uint8Array(262145)), pattern: formatError },
    { result: () => new Response(null, { status: 204 }), pattern: formatError },
  ]
  for (const item of cases) {
    const mock = t.mock.method(globalThis, 'fetch', async () => item.result())
    await assert.rejects(loadEncryptedDirectory('assets/directory.encrypted.json', fixturePassword), item.pattern)
    mock.mock.restore()
  }
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async () => { controller.abort(); return new Response(bytes) })
  await assert.rejects(loadEncryptedDirectory('assets/directory.encrypted.json', fixturePassword, controller.signal), { name: 'AbortError' })
})

test('unsupported Web Crypto never falls back to plaintext', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} })
  t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor))
  await assert.rejects(decryptDirectory(bytes, fixturePassword), /不支持安全解密/)
})
