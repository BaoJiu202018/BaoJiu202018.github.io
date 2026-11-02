import { handleImport, ImportError } from './import.ts'

export interface Env {
  DB: D1Database
  ALLOWED_ORIGIN: string
  CLASS_PASSWORD_HASH: string
  AUTH_VERSION: string
  RATE_PEPPER: string
  ADMIN_IMPORT_HASH?: string
  IMPORT_TARGET?: string
}

type ContactRow = {
  id: string; name: string; contact_kind: string; contact_text: string
  city: string; note: string; updated_at: string; version: number
}

const encoder = new TextEncoder()
const ttl = 12 * 60 * 60 * 1000
const fields = 'id, name, contact_kind, contact_text, city, note, updated_at, version'

class HttpError extends Error {
  status: number
  code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

function hex(bytes: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('')
}

async function digest(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
}

function equal(a: string, b: string): boolean {
  let result = a.length ^ b.length
  for (let i = 0; i < 64; i++) result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return result === 0
}

function dto(row: ContactRow) {
  return {
    id: row.id, name: row.name, contactKind: row.contact_kind,
    contactText: row.contact_text, city: row.city, note: row.note,
    updatedAt: row.updated_at, version: row.version,
  }
}

function reject(status: number, code: string, message: string): never {
  throw new HttpError(status, code, message)
}

async function readBody(request: Request, maximum = 2048): Promise<Record<string, unknown>> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    reject(415, 'JSON_REQUIRED', '请使用 JSON 请求。')
  }
  if (Number(request.headers.get('content-length')) > maximum) reject(413, 'BODY_TOO_LARGE', '请求内容过长。')
  const reader = request.body?.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maximum) {
          await reader.cancel()
          reject(413, 'BODY_TOO_LARGE', '请求内容过长。')
        }
        chunks.push(value)
      }
    } finally { reader.releaseLock() }
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  let body: unknown
  try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) }
  catch { reject(400, 'INVALID_BODY', '请求格式不正确。') }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, 'INVALID_BODY', '请求格式不正确。')
  return body as Record<string, unknown>
}

async function increment(env: Env, bucket: string, maximum: number, expires: number) {
  const row = await env.DB.prepare(
    'INSERT INTO rate_limits(bucket, attempts, expires_at) VALUES (?, 1, ?) ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 WHERE attempts < ? RETURNING attempts',
  ).bind(bucket, expires, maximum).first<{ attempts: number }>()
  if (!row) reject(429, 'RATE_LIMITED', '尝试次数较多，请稍后再试。')
}

async function throttle(request: Request, env: Env, now: number) {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip || ip.length > 64) reject(503, 'NETWORK_UNAVAILABLE', '暂时无法验证网络来源。')
  const hour = Math.floor(now / 3600000)
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').bind(now),
  ])
  await increment(env, `global:${hour}`, 300, (hour + 1) * 3600000)
  const window = Math.floor(now / 600000)
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.RATE_PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const ipHash = hex(await crypto.subtle.sign('HMAC', key, encoder.encode(`${window}:${ip}`)))
  await increment(env, `ip:${ipHash}`, 8, (window + 1) * 600000)
}

async function authenticate(request: Request, env: Env, version: string, now: number) {
  const bearer = request.headers.get('authorization') || ''
  if (!/^Bearer [a-f0-9]{64}$/.test(bearer)) reject(401, 'UNAUTHORIZED', '请重新输入班级口令。')
  const hash = await digest(bearer.slice(7))
  const session = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND expires_at > ? AND auth_version = ?')
    .bind(hash, now, version).first()
  if (!session) reject(401, 'UNAUTHORIZED', '会话已失效，请重新输入班级口令。')
  return hash
}

function integer(value: string | null, fallback: number, maximum: number) {
  if (value === null) return fallback
  if (!/^\d{1,6}$/.test(value) || Number(value) > maximum) reject(400, 'INVALID_QUERY', '查询参数不正确。')
  return Number(value)
}

async function route(request: Request, env: Env) {
  const url = new URL(request.url)
  const path = url.pathname
  if (!['GET', 'POST'].includes(request.method)) reject(405, 'METHOD_NOT_ALLOWED', '此接口只允许指定的只读操作。')
  if (!env.DB || !/^https?:\/\//.test(env.ALLOWED_ORIGIN || '') || !/^[a-f0-9]{64}$/.test(env.CLASS_PASSWORD_HASH || '') ||
    !/^[a-f0-9]{64,}$/.test(env.RATE_PEPPER || '') || !env.AUTH_VERSION) {
    reject(503, 'NOT_CONFIGURED', '通讯录服务尚未配置，请联系班级维护者。')
  }
  if (path === '/health' && request.method === 'GET') return { ready: true }
  if (path.startsWith('/ops/')) {
    if (request.method !== 'POST') reject(405, 'METHOD_NOT_ALLOWED', '不支持此请求方式。')
    if (request.headers.has('origin')) reject(403, 'OPS_CLI_ONLY', '管理接口不接受浏览器来源。')
    if (!env.IMPORT_TARGET || !/^[a-f0-9]{64}$/.test(env.ADMIN_IMPORT_HASH || '')) reject(503, 'OPS_NOT_CONFIGURED', '导入服务尚未配置。')
    const admin = request.headers.get('authorization') || ''
    if (!/^Bearer [a-f0-9]{64}$/.test(admin) || !equal(await digest(admin.slice(7)), env.ADMIN_IMPORT_HASH!)) reject(401, 'OPS_UNAUTHORIZED', '需要独立管理凭据。')
    return handleImport(path, await readBody(request, 262144), { DB: env.DB, IMPORT_TARGET: env.IMPORT_TARGET, ADMIN_IMPORT_HASH: env.ADMIN_IMPORT_HASH! })
  }
  const now = Date.now()
  const version = await digest(`${env.AUTH_VERSION}:${env.CLASS_PASSWORD_HASH}`)
  if (path === '/auth/login' && request.method === 'POST') {
    await throttle(request, env, now)
    const body = await readBody(request)
    if (Object.keys(body).length !== 1 || typeof body.password !== 'string' || body.password.length > 180 || !body.password.length) {
      reject(400, 'INVALID_BODY', '请输入有效的班级口令。')
    }
    if (!equal(await digest(body.password), env.CLASS_PASSWORD_HASH)) reject(401, 'WRONG_PASSWORD', '班级口令不正确，请核对后重试。')
    const token = hex(crypto.getRandomValues(new Uint8Array(32)))
    const expiresAt = now + ttl
    await env.DB.prepare('INSERT INTO sessions(token_hash, expires_at, auth_version) VALUES (?, ?, ?)')
      .bind(await digest(token), expiresAt, version).run()
    return { token, expiresAt }
  }
  const sessionHash = await authenticate(request, env, version, now)
  if (path === '/auth/logout' && request.method === 'POST') {
    const body = await readBody(request)
    if (Object.keys(body).length) reject(400, 'INVALID_BODY', '请求格式不正确。')
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(sessionHash).run()
    return { signedOut: true }
  }
  if (request.method !== 'GET') reject(405, 'READ_ONLY', '共用班级口令仅供查阅，不能修改资料。')
  if (path === '/contacts' || path === '/cities') {
    const query = url.searchParams.get('query') || ''
    const city = url.searchParams.get('city') || ''
    const allowed = ['query', 'city', 'cursor', 'limit']
    for (const key of url.searchParams.keys()) {
      if (!allowed.includes(key) || url.searchParams.getAll(key).length !== 1) reject(400, 'INVALID_QUERY', '查询参数不正确。')
    }
    if (query.length > 40 || city.length > 60) reject(400, 'INVALID_QUERY', '查询内容过长。')
    const cursor = integer(url.searchParams.get('cursor'), 0, 100000)
    const limit = integer(url.searchParams.get('limit'), 12, 50)
    if (limit < 1) reject(400, 'INVALID_QUERY', '查询参数不正确。')
    const where = 'deleted = 0 AND instr(lower(name), lower(?)) > 0 AND (? = \'\' OR city = ?)'
    const values = [query.trim(), city, city === '__unknown__' ? '' : city]
    const results = await env.DB.batch([
      env.DB.prepare(`SELECT ${fields} FROM contacts WHERE ${where} ORDER BY name, id LIMIT ? OFFSET ?`).bind(...values, limit, cursor),
      env.DB.prepare(`SELECT count(*) AS count FROM contacts WHERE ${where}`).bind(...values),
      env.DB.prepare('SELECT count(*) AS count FROM contacts WHERE deleted = 0'),
      env.DB.prepare('SELECT city AS name, count(*) AS count FROM contacts WHERE deleted = 0 GROUP BY city ORDER BY city'),
    ])
    const total = Number((results[1].results[0] as { count: number }).count)
    const cities = results[3].results
    if (path === '/cities') return { cities }
    return {
      items: (results[0].results as ContactRow[]).map(dto), total,
      totalAll: Number((results[2].results[0] as { count: number }).count), cities,
      nextCursor: cursor + limit < total ? cursor + limit : null,
    }
  }
  const match = path.match(/^\/contacts\/([A-Za-z0-9_-]{1,100})$/)
  if (match && !url.search) {
    const contact = await env.DB.prepare(`SELECT ${fields} FROM contacts WHERE id = ? AND deleted = 0`).bind(match[1]).first<ContactRow>()
    if (!contact) reject(404, 'NOT_FOUND', '这份资料已不存在或暂未公开。')
    return dto(contact)
  }
  reject(404, 'NOT_FOUND', '没有找到这个接口。')
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('origin')
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer', 'Vary': 'Origin',
    })
    if (origin && origin === env.ALLOWED_ORIGIN) {
      headers.set('Access-Control-Allow-Origin', origin)
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type')
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    }
    try {
      if (origin && origin !== env.ALLOWED_ORIGIN) reject(403, 'ORIGIN_DENIED', '此来源不允许访问通讯录。')
      if (request.method === 'OPTIONS') {
        if (!origin) reject(403, 'ORIGIN_DENIED', '此来源不允许访问通讯录。')
        return new Response(null, { status: 204, headers })
      }
      return Response.json({ ok: true, data: await route(request, env) }, { headers })
    } catch (error) {
      const failure = error instanceof HttpError ? error : error instanceof ImportError ? new HttpError(error.status, error.code, `导入未执行（${error.code}）。`) : new HttpError(503, 'UNAVAILABLE', '通讯录暂时无法连接，请稍后重试。')
      if (failure.status === 429) headers.set('Retry-After', '600')
      return Response.json({ ok: false, error: { code: failure.code, message: failure.message } }, { status: failure.status, headers })
    }
  },
}
