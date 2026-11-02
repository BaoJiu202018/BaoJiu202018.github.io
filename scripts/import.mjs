import { readFile, lstat, realpath, open } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

async function privateFile(path, maxBytes) {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) || stat.size > maxBytes) throw Error('INVALID_PRIVATE_FILE')
  return readFile(path, 'utf8')
}
async function main() {
  const { values } = parseArgs({ options: {
    file: { type: 'string' }, url: { type: 'string' }, target: { type: 'string' },
    'secret-file': { type: 'string' }, receipt: { type: 'string' }, apply: { type: 'boolean' },
    'confirm-batch': { type: 'string' },
  } })
  if (!values.file || !values.url || !values.target || !values['secret-file'] || !values.receipt) {
    console.log('Preview: npm run import:preview -- --file /private/batch.json --url https://WORKER --target DATABASE_ID --secret-file /private/admin-token --receipt /private/preview.json')
    console.log('Apply only after review: add --apply --confirm-batch DIGEST; preview and apply both transmit the batch to the specified backend.')
    return
  }
  const base = new URL(values.url)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('HTTPS_ORIGIN_REQUIRED')
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(values.target)) throw Error('TARGET_REQUIRED')
  const root = fileURLToPath(new URL('../', import.meta.url))
  for (const path of [values.file, values['secret-file'], values.receipt]) {
    const parent = await realpath(dirname(resolve(path)))
    if (parent === root.slice(0, -1) || parent.startsWith(root) || (await lstat(parent)).mode & 0o077) throw Error('FILES_MUST_STAY_OUTSIDE_REPOSITORY_IN_PRIVATE_DIRECTORY')
  }
  const batch = JSON.parse(await privateFile(values.file, 250000))
  const admin = (await privateFile(values['secret-file'], 128)).trim()
  if (!/^[a-f0-9]{64}$/.test(admin)) throw Error('INVALID_ADMIN_TOKEN')
  let receipt
  if (values.apply) {
    receipt = JSON.parse(await privateFile(values.receipt, 4096))
    if (!/^[a-f0-9]{64}$/.test(values['confirm-batch'] || '') || values['confirm-batch'] !== receipt.digest) throw Error('BATCH_CONFIRMATION_REQUIRED')
  }
  const response = await fetch(new URL(values.apply ? '/ops/apply' : '/ops/preview', base), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ target: values.target, batch, ...(receipt ? { receipt } : {}) }),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) throw Error('REMOTE_REJECTED')
  const { digest, summary } = result.data
  if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest) || !summary || !['added', 'updated', 'removed', 'skipped', 'conflicts', 'unchangedOutsideBatch'].every(k => Number.isSafeInteger(summary[k]) && summary[k] >= 0)) throw Error('INVALID_RESPONSE')
  if (!values.apply) {
    const handle = await open(values.receipt, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(result.data.receipt)) } finally { await handle.close() }
  }
  console.log(JSON.stringify({ mode: values.apply ? 'apply' : 'preview', target: values.target, digest, summary: Object.fromEntries(['added', 'updated', 'removed', 'skipped', 'conflicts', 'unchangedOutsideBatch'].map(k => [k, summary[k]])) }))
}
main().catch(() => { console.error('Import stopped. Check target, private files, credentials, conflicts and preview expiry. No personal data or server response is logged.'); process.exitCode = 1 })
