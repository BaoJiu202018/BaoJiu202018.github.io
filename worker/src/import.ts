type RecordData = {
  id: string; name: string; contactKind: string; contactText: string; city: string
  note: string; updatedAt: string; version: number; importFingerprint: string | null; deleted: boolean
}
type ImportEnv = { DB: D1Database; IMPORT_TARGET: string; ADMIN_IMPORT_HASH: string }
export class ImportError extends Error {
  status: number
  code: string
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status }
}
function fail(code: string, status = 400): never { throw new ImportError(code, status) }
const encode = new TextEncoder()
// Initialize collation outside the first import's request CPU budget.
const compareIds = new Intl.Collator('en').compare
async function hash(value: string) {
  const result = await crypto.subtle.digest('SHA-256', encode.encode(value))
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('')
}
async function sign(env: ImportEnv, value: string) {
  const key = await crypto.subtle.importKey('raw', encode.encode(env.ADMIN_IMPORT_HASH), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const result = await crypto.subtle.sign('HMAC', key, encode.encode(value))
  return Array.from(new Uint8Array(result), b => b.toString(16).padStart(2, '0')).join('')
}
function normalize(input: unknown): RecordData[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('INVALID_BATCH')
  const batch = input as Record<string, unknown>
  if (batch.schema !== 1 || Object.keys(batch).some(k => !['schema', 'contacts'].includes(k)) || !Array.isArray(batch.contacts) || batch.contacts.length > 200) fail('INVALID_BATCH')
  const ids = new Set<string>(), fingerprints = new Set<string>()
  return (batch.contacts as unknown[]).map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_RECORD')
    const c = value as Record<string, unknown>
    if (Object.keys(c).some(k => !['id', 'name', 'contactKind', 'contactText', 'city', 'note', 'updatedAt', 'version', 'importFingerprint', 'deleted'].includes(k))) fail('UNEXPECTED_FIELD')
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id) || ids.has(c.id)) fail('DUPLICATE_OR_INVALID_ID')
    ids.add(c.id)
    const fingerprint = c.importFingerprint ?? null
    if (fingerprint !== null && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint) || fingerprints.has(fingerprint))) fail('INVALID_FINGERPRINT')
    if (fingerprint) fingerprints.add(fingerprint as string)
    if (c.deleted !== undefined && typeof c.deleted !== 'boolean') fail('INVALID_RECORD')
    if (c.deleted === true) {
      if (Object.keys(c).some(k => !['id', 'deleted', 'importFingerprint'].includes(k))) fail('TOMBSTONE_HAS_PERSONAL_FIELDS')
      return { id: c.id, name: '', contactKind: 'other', contactText: '', city: '', note: '', updatedAt: '', version: 1, importFingerprint: fingerprint as string | null, deleted: true }
    }
    for (const [key, max] of [['name', 40], ['contactText', 180], ['city', 60], ['note', 300]] as const) {
      if (typeof c[key] !== 'string' || c[key].length > max || (['name', 'contactText'].includes(key) && !c[key].trim())) fail('INVALID_FIELDS')
    }
    if (!['phone', 'wechat', 'qq', 'email', 'other'].includes(String(c.contactKind)) || !Number.isSafeInteger(c.version) || Number(c.version) < 1) fail('INVALID_FIELDS')
    if (typeof c.updatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(c.updatedAt) || !Number.isFinite(Date.parse(c.updatedAt))) fail('INVALID_TIMESTAMP')
    if (c.contactKind === 'phone' && !/^\+?[\d\s()-]{6,24}$/.test(String(c.contactText))) fail('INVALID_PHONE')
    return { id: c.id, name: c.name, contactKind: c.contactKind, contactText: c.contactText, city: c.city, note: c.note, updatedAt: c.updatedAt, version: c.version, importFingerprint: fingerprint, deleted: false } as RecordData
  }).sort((a, b) => compareIds(a.id, b.id))
}
function row(c: Record<string, unknown>): RecordData {
  return { id: String(c.id), name: String(c.name), contactKind: String(c.contact_kind), contactText: String(c.contact_text), city: String(c.city), note: String(c.note), updatedAt: String(c.updated_at), version: Number(c.version), importFingerprint: c.import_fingerprint as string | null, deleted: Boolean(c.deleted) }
}
function plan(incoming: RecordData[], existing: RecordData[]) {
  const byId = new Map(existing.map(c => [c.id, c]))
  const fingerprints = new Map(existing.filter(c => c.importFingerprint).map(c => [c.importFingerprint, c]))
  const changes: RecordData[] = []
  const summary = { added: 0, updated: 0, removed: 0, skipped: 0, conflicts: 0, unchangedOutsideBatch: existing.filter(c => !incoming.some(i => i.id === c.id)).length }
  for (const c of incoming) {
    const old = byId.get(c.id)
    const sameFingerprint = c.importFingerprint ? fingerprints.get(c.importFingerprint) : undefined
    if (old?.deleted || (!old && sameFingerprint?.deleted)) { summary.skipped++; continue }
    if (old && old.importFingerprint !== c.importFingerprint || !old && sameFingerprint) { summary.conflicts++; continue }
    if (!old) {
      if (!c.deleted && [...existing, ...changes].some(other => !other.deleted && other.name === c.name)) { summary.conflicts++; continue }
      changes.push(c)
      c.deleted ? summary.removed++ : summary.added++
    } else if (c.deleted) { changes.push(c); summary.removed++ }
    else if (JSON.stringify(c) === JSON.stringify(old)) summary.skipped++
    else if (c.version <= old.version || Date.parse(c.updatedAt) < Date.parse(old.updatedAt)) summary.conflicts++
    else { changes.push(c); summary.updated++ }
  }
  return { changes, summary }
}

export async function handleImport(path: string, body: Record<string, unknown>, env: ImportEnv) {
  if (Object.keys(body).some(k => !['target', 'batch', 'receipt'].includes(k)) || body.target !== env.IMPORT_TARGET) fail('TARGET_MISMATCH')
  const incoming = normalize(body.batch)
  const digest = await hash(JSON.stringify(incoming))
  const snapshot = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare('SELECT revision FROM import_state WHERE id = 1'),
    env.DB.prepare('SELECT * FROM contacts ORDER BY id'),
    env.DB.prepare('SELECT digest FROM import_batches WHERE digest = ?').bind(digest),
  ])
  const revision = Number(snapshot[0].results[0].revision)
  const { changes, summary } = plan(incoming, snapshot[1].results.map(row))
  if (path === '/ops/preview') {
    const expiresAt = Date.now() + 300000
    const signature = await sign(env, JSON.stringify([body.target, digest, revision, expiresAt]))
    return { digest, summary, receipt: { digest, revision, expiresAt, signature } }
  }
  if (path !== '/ops/apply') fail('NOT_FOUND', 404)
  const receipt = body.receipt as { digest?: unknown; revision?: unknown; expiresAt?: unknown; signature?: unknown } | undefined
  if (!receipt || typeof receipt.signature !== 'string' || !Number.isSafeInteger(receipt.revision) || typeof receipt.expiresAt !== 'number' || receipt.expiresAt <= Date.now()) fail('PREVIEW_EXPIRED', 409)
  const expected = await sign(env, JSON.stringify([body.target, digest, receipt.revision, receipt.expiresAt]))
  let mismatch = expected.length ^ receipt.signature.length
  for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ (receipt.signature.charCodeAt(i) || 0)
  if (mismatch || receipt.digest !== digest) fail('PREVIEW_MISMATCH', 409)
  if (snapshot[2].results.length) return { digest, summary: { ...summary, added: 0, updated: 0, removed: 0 }, alreadyApplied: true }
  if (receipt.revision !== revision) fail('PREVIEW_STALE', 409)
  if (summary.conflicts) fail('CONFLICT_REVIEW_REQUIRED', 409)
  const statements = [env.DB.prepare('INSERT INTO import_guard(id, valid) VALUES (1, CASE WHEN (SELECT revision FROM import_state WHERE id = 1) = ? THEN 1 ELSE 0 END) ON CONFLICT(id) DO UPDATE SET valid = excluded.valid').bind(revision)]
  for (let index = 0; index < changes.length; index += 10) {
    const group = changes.slice(index, index + 10)
    const placeholders = group.map(() => '(?,?,?,?,?,?,?,?,?,?)').join(',')
    const values = group.flatMap(c => [c.id, c.name, c.contactKind, c.contactText, c.city, c.note, c.updatedAt, c.version, c.importFingerprint, Number(c.deleted)])
    statements.push(env.DB.prepare(`INSERT INTO contacts(id,name,contact_kind,contact_text,city,note,updated_at,version,import_fingerprint,deleted) VALUES ${placeholders} ON CONFLICT(id) DO UPDATE SET name=excluded.name,contact_kind=excluded.contact_kind,contact_text=excluded.contact_text,city=excluded.city,note=excluded.note,updated_at=excluded.updated_at,version=excluded.version,import_fingerprint=excluded.import_fingerprint,deleted=excluded.deleted`).bind(...values))
  }
  statements.push(env.DB.prepare('INSERT INTO import_batches(digest,imported_at,added,updated,removed) VALUES (?,?,?,?,?)').bind(digest, new Date().toISOString(), summary.added, summary.updated, summary.removed))
  try { await env.DB.batch(statements) }
  catch { fail('IMPORT_NOT_APPLIED_RETRY_PREVIEW', 409) }
  return { digest, summary, alreadyApplied: false }
}
