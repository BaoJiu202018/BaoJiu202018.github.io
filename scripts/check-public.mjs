import { readdir, readFile, lstat, realpath } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { decryptDirectory, parseEncryptedFile } from '../public/assets/encrypted-directory.js'

const root = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['node_modules', '.git', '.wrangler', 'test-results', 'playwright-report'])
const publicFiles = new Set(['index.html', 'assets/app.js', 'assets/config.js', 'assets/encrypted-directory.js', 'assets/directory.encrypted.json', 'assets/site.css', 'assets/seal.svg', 'assets/campus.svg', 'assets/share-cover.svg', 'assets/share-cover.png'])
const sourceFiles = new Set(['.gitignore', '.github/workflows/pages.yml', 'package.json', 'package-lock.json', 'tsconfig.json', 'playwright.config.mjs', 'scripts/dev.mjs', 'scripts/check-public.mjs', 'scripts/import.mjs', 'worker/wrangler.jsonc', 'worker/src/index.ts', 'worker/src/import.ts', 'worker/migrations/0001.sql', 'tests/support.mjs', 'tests/api.test.mjs', 'tests/import.test.mjs', 'tests/public.test.mjs', 'tests/encrypted-directory.test.mjs', 'tests/ui.spec.mjs'])

export function releaseIssues(configSource, html) {
  const issues = []
  if (!/^\s*export const ENCRYPTED_DATA_PATH = (['"])assets\/directory\.encrypted\.json\1;?\s*export const PREVIEW = false;?\s*$/.test(configSource)) issues.push('ENCRYPTED_PATH_OR_PREVIEW_INVALID')
  if (/2020级|拟托管|拟使用|上线前须核实|口令由服务器校验|独立服务器校验口令|口令更换后原会话失效/.test(html)) issues.push('UNFINISHED_COPY')
  for (const text of ['2017级（2020届）18班', '<b>2017</b><span>相遇的起点</span>', '原18班微信群回复网站发布消息，联系发起人', '共享口令无法识别个人', '班外持有者也可能访问', '保留30天', '手动清理', '原腾讯文档与原系统历史备份', '境外处理', '口令不发送到服务器', '公开 GitHub 仓库及其历史', '离线尝试解密', '没有服务端限流或访问撤销', '更换口令不能使已下载的旧密文失效', '只清除本页资料', '原 Cloudflare Workers 与 D1 中的受保护资料副本仍保留']) {
    if (!html.includes(text)) issues.push('REQUIRED_COPY_MISSING')
  }
  return [...new Set(issues)]
}

export async function verifyEncryptedRecords(bytes, privateBytes, records, password) {
  if (!bytes.equals(privateBytes)) throw Error('ENCRYPTED_SOURCE_MISMATCH')
  const contacts = await decryptDirectory(bytes, password)
  const expected = records.filter(c => !c.deleted).map(c => ({ id: c._id, name: c.name, contactKind: c.contactKind, contactText: c.contactText, city: c.city || '', note: c.note || '', updatedAt: c.updatedAt, version: c.version }))
  const sorted = list => list.map(c => Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b, 'en')))).sort((a, b) => a.id.localeCompare(b.id, 'en'))
  if (JSON.stringify(sorted(contacts)) !== JSON.stringify(sorted(expected))) throw Error('ENCRYPTED_RECORDS_MISMATCH')
  return 'decrypted comparison performed'
}

function emptyViolations() {
  return { unapprovedFiles: 0, symlinks: 0, invalidGitModes: 0, secrets: 0, personalNames: 0, personalContacts: 0, privateNotes: 0, publicFixtures: 0, classYear: 0 }
}

function approvedPath(path) {
  return path.startsWith('public/') ? publicFiles.has(path.slice(7)) : sourceFiles.has(path)
}

function inspectText(text, isPublic, records, secrets, violations) {
  violations.secrets += [...text.matchAll(/(?:gh[pousr]_[A-Za-z0-9_]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKID[A-Za-z0-9]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|BaoJiuZhong18-[A-Za-z0-9_-]{20,})/g)].length
  for (const secret of secrets) if (text.includes(secret)) violations.secrets++
  if (isPublic && /Fixture-Only|示例同学\d|example\.invalid|fixture-\d/.test(text)) violations.publicFixtures++
  if (isPublic && /2020级|EST\.\s*2020|<b>2020<\/b><span>相遇的起点/.test(text)) violations.classYear++
  for (const c of records) {
    if (typeof c.name === 'string' && c.name.length >= 2 && text.includes(c.name)) violations.personalNames++
    for (const value of new Set([c.contactText, c.rawContact].filter(v => typeof v === 'string' && v.length >= 4))) if (text.includes(value)) violations.personalContacts++
    if (typeof c.note === 'string' && c.note.length >= 8 && text.includes(c.note)) violations.privateNotes++
  }
}

export function auditGit(directory, records = [], secrets = []) {
  const git = args => execFileSync('git', ['--no-optional-locks', '-C', directory, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  if (realpathSync(git(['rev-parse', '--show-toplevel']).trim()) !== realpathSync(directory)) throw Error('GIT_ROOT_MISMATCH')
  const violations = emptyViolations()
  const publicBlobs = new Set()
  const stage = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean)
  const objects = git(['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)']).trim().split('\n').filter(Boolean).map(line => {
    const [oid, type, size] = line.split(' ')
    if (!/^[a-f0-9]{40,64}$/.test(oid) || !['blob', 'tree', 'commit', 'tag'].includes(type) || !/^\d+$/.test(size) || Number(size) > 8 * 1024 * 1024) throw Error('GIT_OBJECT_INVALID')
    return { oid, type }
  })
  if (!stage.length || !objects.length) throw Error('GIT_EMPTY')
  function inspectEntry(entry, staged) {
    const tab = entry.indexOf('\t')
    if (tab < 0) throw Error('GIT_ENTRY_INVALID')
    const fields = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    const mode = fields[0], oid = fields[staged ? 1 : 2]
    if (!approvedPath(path)) violations.unapprovedFiles++
    if (mode === '120000') violations.symlinks++
    if (!['100644', '100755'].includes(mode) || (staged && fields[2] !== '0')) violations.invalidGitModes++
    if (path.startsWith('public/')) publicBlobs.add(oid)
    inspectText(path, false, records, secrets, violations)
  }
  for (const entry of stage) inspectEntry(entry, true)
  const commits = objects.filter(o => o.type === 'commit')
  for (const { oid } of commits) {
    for (const entry of git(['ls-tree', '-r', '-z', oid]).split('\0').filter(Boolean)) inspectEntry(entry, false)
  }
  for (const { oid, type } of objects) {
    inspectText(git(['cat-file', type, oid]), publicBlobs.has(oid), records, secrets, violations)
  }
  return { objects: objects.length, commits: commits.length, stagedFiles: stage.length, violations }
}

async function privateInputs() {
  let records = [], secrets = [], password, privateBytes
  let privateComparison = 'not available', secretComparison = 'not available'
  const folder = fileURLToPath(new URL('../../private', import.meta.url))
  async function privatePath(name) {
    const dir = await lstat(folder)
    if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o777) !== 0o700 || await realpath(folder) !== folder) throw Error('PRIVATE_DIRECTORY_INVALID')
    const source = join(folder, name)
    const stat = await lstat(source)
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw Error('PRIVATE_FILE_INVALID')
    return source
  }
  try {
    const db = new DatabaseSync(await privatePath('local-directory.sqlite'), { readOnly: true })
    try {
      db.exec('BEGIN')
      records = db.prepare("SELECT value FROM documents WHERE collection = 'contacts'").all().map(r => JSON.parse(r.value))
    } finally { db.close() }
    privateComparison = 'read-only comparison performed'
  } catch (error) { if (error.code !== 'ENOENT') throw Error('PRIVATE_COMPARISON_FAILED') }
  try {
    const value = JSON.parse(await readFile(await privatePath('website-production-secrets.json'), 'utf8'))
    secrets = ['memberPassword', 'adminSecret', 'ratePepper', 'classPasswordHash', 'adminImportHash'].map(key => value[key])
    if (secrets.some(value => typeof value !== 'string' || value.length < 20)) throw Error('PRIVATE_SECRETS_INVALID')
    password = (await readFile(await privatePath('website-member-password.txt'), 'utf8')).trim()
    if (password !== value.memberPassword || !/^BaoJiuZhong18-[A-Za-z0-9_-]{32}$/.test(password) || createHash('sha256').update(password).digest('hex') !== value.classPasswordHash) throw Error('PRIVATE_PASSWORD_MISMATCH')
    secretComparison = 'read-only comparison performed'
  } catch (error) { if (error.code !== 'ENOENT') throw Error('SECRET_COMPARISON_FAILED') }
  try { privateBytes = await readFile(await privatePath('website-directory.encrypted.json')) }
  catch (error) { if (error.code !== 'ENOENT') throw Error('ENCRYPTED_SOURCE_FAILED') }
  return { records, secrets, password, privateBytes, privateComparison, secretComparison }
}

async function main() {
  const args = process.argv.slice(2)
  if (new Set(args).size !== args.length || args.some(arg => !['--release', '--git', '--require-private'].includes(arg))) throw Error('INVALID_ARGUMENTS')
  const { records, secrets, password, privateBytes, privateComparison, secretComparison } = await privateInputs()
  const encryptedBytes = await readFile(join(root, 'public/assets/directory.encrypted.json'))
  parseEncryptedFile(encryptedBytes)
  const encryptedComparison = privateBytes && password && privateComparison !== 'not available' ? await verifyEncryptedRecords(encryptedBytes, privateBytes, records, password) : 'not available'
  const violations = emptyViolations()
  let publicBytes = 0
  async function scan(folder, relative = '') {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (ignored.has(entry.name)) continue
      const path = join(folder, entry.name), key = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) { violations.symlinks++; continue }
      if (entry.isDirectory()) { await scan(path, key); continue }
      if (!entry.isFile()) throw Error('NON_REGULAR_FILE')
      const isPublic = key.startsWith('public/')
      if (!approvedPath(key)) violations.unapprovedFiles++
      const buffer = await readFile(path)
      if (isPublic) publicBytes += buffer.byteLength
      inspectText(buffer.toString('utf8'), isPublic, records, secrets, violations)
    }
  }
  await scan(root)
  const release = args.includes('--release')
  const blockers = release ? releaseIssues(
    await readFile(join(root, 'public/assets/config.js'), 'utf8'),
    await readFile(join(root, 'public/index.html'), 'utf8'),
  ) : []
  if (args.includes('--require-private')) {
    if (privateComparison === 'not available' || records.length === 0) blockers.push('PRIVATE_COMPARISON_REQUIRED')
    if (secretComparison === 'not available') blockers.push('SECRET_COMPARISON_REQUIRED')
    if (encryptedComparison === 'not available') blockers.push('ENCRYPTED_COMPARISON_REQUIRED')
  }
  for (const file of ['app.js', 'config.js', 'encrypted-directory.js']) {
    if (/workers\.dev|API_BASE|\/auth\/(?:login|logout)|localStorage|sessionStorage|indexedDB|serviceWorker/.test(await readFile(join(root, 'public/assets', file), 'utf8'))) blockers.push('STATIC_CLIENT_BOUNDARY_INVALID')
  }
  const git = args.includes('--git') ? auditGit(root, records, secrets) : null
  if (publicBytes > 500000) throw Error('Public assets exceed the 500KB budget')
  console.log(JSON.stringify({ mode: release ? 'release' : 'source', publicBytes, privateComparison, secretComparison, encryptedComparison, violations, git, releaseBlockers: blockers }))
  if (Object.values(violations).some(Boolean) || blockers.length || (git && Object.values(git.violations).some(Boolean))) process.exitCode = 1
}

if (process.argv[1] && await realpath(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Public validation failed; no file contents or private data are logged.'); process.exitCode = 1 })
}
