import { getPlatformProxy } from 'wrangler'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

export const fixturePassword = 'Fixture-Only-18-not-a-production-password'
export const hash = value => createHash('sha256').update(value).digest('hex')
export const fixtures = Array.from({ length: 27 }, (_, index) => ({
  id: `fixture-${String(index + 1).padStart(2, '0')}`,
  name: `示例同学${String(index + 1).padStart(2, '0')}`,
  contactKind: index % 2 ? 'other' : 'email',
  contactText: index % 2 ? `虚构联络方式-${index + 1}` : `classmate${index + 1}@example.invalid`,
  city: index % 3 === 0 ? '' : index % 3 === 1 ? '包头' : '北京',
  note: index === 0 ? '这是虚构资料，用于测试长留言。\n'.repeat(28) + '<img src=x onerror=alert(1)>' : index === 1 ? 'X'.repeat(500) : '各自发光，也常常相聚。（测试资料）',
  updatedAt: '2026-11-01T10:00:00.000Z', version: 1,
}))

export async function createFixture(origin = 'http://127.0.0.1:5190') {
  const proxy = await getPlatformProxy({
    configPath: fileURLToPath(new URL('../worker/wrangler.jsonc', import.meta.url)),
    persist: false,
  })
  try {
    const DB = proxy.env.DB
    const migration = await readFile(new URL('../worker/migrations/0001.sql', import.meta.url), 'utf8')
    await DB.batch(migration.split(/;\s*(?=CREATE|INSERT|$)/).map(s => s.trim()).filter(Boolean).map(s => DB.prepare(s)))
    await DB.batch(fixtures.map(c => DB.prepare('INSERT INTO contacts(id,name,contact_kind,contact_text,city,note,updated_at,version) VALUES (?,?,?,?,?,?,?,?)')
      .bind(c.id, c.name, c.contactKind, c.contactText, c.city, c.note, c.updatedAt, c.version)))
    return {
      env: { DB, ALLOWED_ORIGIN: origin, CLASS_PASSWORD_HASH: hash(fixturePassword), RATE_PEPPER: hash('fixture-only-pepper'), AUTH_VERSION: 'fixture-v1' },
      dispose: () => proxy.dispose(),
    }
  } catch (error) { await proxy.dispose(); throw error }
}
