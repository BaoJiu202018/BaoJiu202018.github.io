const format = 'class-directory-encrypted-v1'
const maximumBytes = 262144
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function invalid() {
  throw new Error('加密文件格式不正确，请联系班级维护者。')
}

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) invalid()
}

function base64(value, maximum) {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value.length % 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid()
  const raw = atob(value)
  if (btoa(raw) !== value) invalid()
  return Uint8Array.from(raw, c => c.charCodeAt(0))
}

function json(bytes) {
  try { return JSON.parse(decoder.decode(bytes)) } catch { invalid() }
}

export function parseEncryptedFile(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > maximumBytes) invalid()
  const envelope = json(bytes)
  keys(envelope, ['format', 'protected', 'ciphertext'])
  if (envelope.format !== format) invalid()
  const header = json(base64(envelope.protected, 4096))
  keys(header, ['format', 'kdf', 'cipher'])
  keys(header.kdf, ['name', 'hash', 'iterations', 'salt'])
  keys(header.cipher, ['name', 'keyLength', 'iv', 'tagLength'])
  if (header.format !== format || header.kdf.name !== 'PBKDF2' || header.kdf.hash !== 'SHA-256' || header.kdf.iterations !== 600000 || header.cipher.name !== 'AES-GCM' || header.cipher.keyLength !== 256 || header.cipher.tagLength !== 128) invalid()
  const salt = base64(header.kdf.salt, 24)
  const iv = base64(header.cipher.iv, 16)
  const ciphertext = base64(envelope.ciphertext, maximumBytes)
  if (salt.length !== 16 || iv.length !== 12 || ciphertext.length <= 16) invalid()
  return { salt, iv, ciphertext, additionalData: encoder.encode(envelope.protected) }
}

function validateContacts(payload) {
  keys(payload, ['schema', 'contacts'])
  if (payload.schema !== 1 || !Array.isArray(payload.contacts) || payload.contacts.length > 200) invalid()
  const ids = new Set()
  for (const c of payload.contacts) {
    keys(c, ['id', 'name', 'contactKind', 'contactText', 'city', 'note', 'updatedAt', 'version'])
    if (typeof c.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(c.id) || ids.has(c.id)) invalid()
    ids.add(c.id)
    if (!['phone', 'wechat', 'qq', 'email', 'other'].includes(c.contactKind) || !Number.isSafeInteger(c.version) || c.version < 1 || typeof c.updatedAt !== 'string' || c.updatedAt.length > 40 || !/^\d{4}-\d{2}-\d{2}T/.test(c.updatedAt) || Number.isNaN(Date.parse(c.updatedAt))) invalid()
    for (const [field, maximum] of [['name', 40], ['contactText', 180], ['city', 60], ['note', 300]]) {
      if (typeof c[field] !== 'string' || c[field].length > maximum || ((field === 'name' || field === 'contactText') && !c[field].trim())) invalid()
    }
    if (c.contactKind === 'phone' && !/^\+?[\d\s()-]{6,24}$/.test(c.contactText)) invalid()
  }
  return payload.contacts
}

export async function decryptDirectory(bytes, password) {
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全解密，请使用最新版手机浏览器打开 HTTPS 网站。')
  if (typeof password !== 'string' || !password.length || password.length > 180) throw new Error('请输入有效的班级口令。')
  const data = parseEncryptedFile(bytes)
  const passwordBytes = encoder.encode(password)
  let plaintext
  try {
    const material = await crypto.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveKey'])
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: data.salt }, material, { name: 'AES-GCM', length: 256 }, false, ['decrypt'])
    try {
      plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.iv, tagLength: 128, additionalData: data.additionalData }, key, data.ciphertext))
    } catch { throw new Error('口令不正确或加密文件已损坏，请核对口令后重试。') }
    return validateContacts(json(plaintext))
  } finally {
    passwordBytes.fill(0)
    plaintext?.fill(0)
  }
}

export async function loadEncryptedDirectory(path, password, signal) {
  if (path !== 'assets/directory.encrypted.json') throw new Error('通讯录文件尚未配置，请联系班级维护者。')
  if (!globalThis.crypto?.subtle) throw new Error('当前浏览器不支持安全解密，请使用最新版手机浏览器打开 HTTPS 网站。')
  const url = new URL('./directory.encrypted.json', import.meta.url)
  let response
  try {
    response = await fetch(url, { signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' })
  } catch (error) {
    if (error.name === 'AbortError') throw error
    throw new Error('无法下载加密通讯录，请检查网络后重试。')
  }
  if (!response.ok) throw new Error('暂时无法下载加密通讯录，请稍后重试。')
  if (Number(response.headers.get('content-length')) > maximumBytes) {
    await response.body?.cancel()
    invalid()
  }
  const reader = response.body?.getReader()
  if (!reader) invalid()
  const chunks = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maximumBytes) {
        await reader.cancel()
        invalid()
      }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  signal?.throwIfAborted()
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const contacts = await decryptDirectory(bytes, password)
  signal?.throwIfAborted()
  return contacts
}
