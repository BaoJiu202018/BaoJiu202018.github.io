import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseIssues, auditGit } from '../scripts/check-public.mjs'

const api = "export const API_BASE = 'https://directory.fixture.workers.dev'\nexport const PREVIEW = false\n"
const worker = {
  account_id: 'a'.repeat(32),
  vars: { ALLOWED_ORIGIN: 'https://baojiu202018.github.io', IMPORT_TARGET: '11111111-1111-4111-8111-111111111111' },
  d1_databases: [{ binding: 'DB', database_id: '11111111-1111-4111-8111-111111111111' }],
}
const html = '2017级（2020届）18班 <b>2017</b><span>相遇的起点</span> 原18班微信群回复网站发布消息，联系发起人 共享口令无法识别个人 班外持有者也可能访问 保留30天 手动清理 原腾讯文档与原系统历史备份 境外处理'

test('release accepts configured origins, matching database and required notices', () => {
  assert.deepEqual(releaseIssues(api, worker, html), [])
})

test('release rejects empty, local, non-HTTPS, credentialed, path and preview configurations', () => {
  for (const value of ['', '/api', 'http://directory.fixture.workers.dev', 'https://localhost', 'https://directory.fixture.workers.dev/', 'https://directory.fixture.workers.dev/path', 'https://user@directory.fixture.workers.dev', 'https://directory.fixture.workers.dev?token=x']) {
    const source = `export const API_BASE = '${value}'\nexport const PREVIEW = false\n`
    assert.ok(releaseIssues(source, worker, html).includes('API_OR_PREVIEW_INVALID'))
  }
  assert.ok(releaseIssues(api.replace('false', 'true'), worker, html).includes('API_OR_PREVIEW_INVALID'))
  assert.ok(releaseIssues(api + '\nexport const EXTRA = 1', worker, html).includes('API_OR_PREVIEW_INVALID'))
})

test('release rejects placeholder database, account, mismatched import target and CORS', () => {
  for (const id of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    const value = structuredClone(worker)
    value.d1_databases[0].database_id = id
    assert.ok(releaseIssues(api, value, html).includes('DATABASE_INVALID'))
  }
  for (const id of ['', '0'.repeat(32)]) assert.ok(releaseIssues(api, { ...worker, account_id: id }, html).includes('ACCOUNT_INVALID'))
  const value = structuredClone(worker)
  value.vars.IMPORT_TARGET = 'another-target'
  value.vars.ALLOWED_ORIGIN = '*'
  assert.deepEqual(releaseIssues(api, value, html), ['IMPORT_TARGET_MISMATCH', 'CORS_ORIGIN_INVALID'])
  assert.ok(releaseIssues(api, {}, html).includes('DATABASE_INVALID'))
})

test('release rejects old class year, unfinished deployment copy and missing privacy notices', () => {
  for (const text of ['2020级', '拟托管', '拟使用', '上线前须核实']) assert.ok(releaseIssues(api, worker, html + text).includes('UNFINISHED_COPY'))
  for (const text of ['2017级（2020届）18班', '原18班微信群回复网站发布消息，联系发起人', '共享口令无法识别个人', '保留30天', '手动清理', '境外处理']) {
    assert.ok(releaseIssues(api, worker, html.replace(text, '')).includes('REQUIRED_COPY_MISSING'))
  }
})

test('public artwork and metadata distinguish enrolment and graduation years', async () => {
  const read = path => readFile(new URL('../public/' + path, import.meta.url), 'utf8')
  const [page, seal, cover] = await Promise.all([read('index.html'), read('assets/seal.svg'), read('assets/share-cover.svg')])
  assert.doesNotMatch(page + seal + cover, /2020级|EST\.\s*2020/)
  assert.match(page, /<b>2017<\/b><span>相遇的起点/)
  assert.match(seal, /EST\. 2017/)
  assert.match(cover, /2017级（2020届）18班/)
  assert.match(cover, /CLASS OF 2020/)
  assert.match(page, /assets\/share-cover\.png/)
  const png = await readFile(new URL('../public/assets/share-cover.png', import.meta.url))
  assert.equal(png.subarray(1, 4).toString(), 'PNG')
  assert.equal(png.readUInt32BE(16), 1200)
  assert.equal(png.readUInt32BE(20), 630)
})

async function gitFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'class18-git-audit-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const git = (args, input) => execFileSync('git', ['-C', directory, ...args], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture Author', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture Author', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' },
  })
  git(['init', '-q', '--initial-branch=main'])
  await mkdir(join(directory, 'public'))
  await writeFile(join(directory, 'public/index.html'), 'Safe public page')
  git(['add', '--', 'public/index.html'])
  git(['commit', '-m', 'Fixture initial snapshot'])
  return { directory, git }
}

test('Git audit accepts safe snapshots and refuses a parent repository boundary', async t => {
  const { directory } = await gitFixture(t)
  const report = auditGit(directory)
  assert.equal(report.commits, 1)
  assert.equal(report.stagedFiles, 1)
  assert.ok(Object.values(report.violations).every(value => value === 0))
  assert.throws(() => auditGit(join(directory, 'public')), /GIT_ROOT_MISMATCH/)
})

test('Git audit catches an index leak even when the working copy is clean', async t => {
  const { directory, git } = await gitFixture(t)
  const record = { name: 'Fictional Member Zulu', contactText: 'synthetic-contact-zulu', note: 'Synthetic private message for testing only' }
  await writeFile(join(directory, 'public/index.html'), JSON.stringify(record))
  git(['add', '--', 'public/index.html'])
  await writeFile(join(directory, 'public/index.html'), 'Safe working copy')
  const report = auditGit(directory, [record])
  assert.ok(report.violations.personalNames > 0)
  assert.ok(report.violations.personalContacts > 0)
  assert.ok(report.violations.privateNotes > 0)
})

test('Git audit catches removed exports in older commits', async t => {
  const { directory, git } = await gitFixture(t)
  await writeFile(join(directory, 'export.csv'), 'synthetic export')
  git(['add', '--', 'export.csv'])
  git(['commit', '-m', 'Fixture historical export'])
  await rm(join(directory, 'export.csv'))
  git(['add', '--', 'export.csv'])
  git(['commit', '-m', 'Fixture removal'])
  const report = auditGit(directory)
  assert.equal(report.commits, 3)
  assert.ok(report.violations.unapprovedFiles > 0)
})

test('Git audit scans dangling blobs and commit messages for exact production secrets', async t => {
  const { directory, git } = await gitFixture(t)
  const secret = 'synthetic-secret-' + randomUUID()
  git(['hash-object', '-w', '--stdin'], Buffer.concat([Buffer.from([137, 80, 78, 71]), Buffer.from(secret)]))
  assert.ok(auditGit(directory, [], [secret]).violations.secrets > 0)
  await writeFile(join(directory, 'public/index.html'), 'Another safe page')
  git(['add', '--', 'public/index.html'])
  git(['commit', '-m', 'Fixture message ' + secret])
  assert.ok(auditGit(directory, [], [secret]).violations.secrets >= 2)
})

test('Git audit refuses symlinks and submodules even at approved paths', async t => {
  const { directory, git } = await gitFixture(t)
  const link = git(['hash-object', '-w', '--stdin'], '../../outside').trim()
  git(['update-index', '--add', '--cacheinfo', `120000,${link},public/assets/app.js`])
  const commit = git(['rev-parse', 'HEAD']).trim()
  git(['update-index', '--add', '--cacheinfo', `160000,${commit},worker/src/index.ts`])
  const report = auditGit(directory)
  assert.equal(report.violations.symlinks, 1)
  assert.equal(report.violations.invalidGitModes, 2)
})

test('Git audit rejects old public fixtures and dates even after replacement', async t => {
  const { directory, git } = await gitFixture(t)
  await writeFile(join(directory, 'public/index.html'), '2020级 fixture-' + '7')
  git(['add', '--', 'public/index.html'])
  git(['commit', '-m', 'Fixture old page'])
  await writeFile(join(directory, 'public/index.html'), 'Safe public page')
  git(['add', '--', 'public/index.html'])
  const report = auditGit(directory)
  assert.ok(report.violations.publicFixtures > 0)
  assert.ok(report.violations.classYear > 0)
})

test('Pages workflow pins official Actions and publishes only public assets', async () => {
  const workflow = await readFile(new URL('../.github/workflows/pages.yml', import.meta.url), 'utf8')
  const actions = [...workflow.matchAll(/^\s*- uses: (\S+)$/gm)].map(match => match[1])
  assert.equal(actions.length, 4)
  for (const action of actions) assert.match(action, /^actions\/[a-z-]+@[a-f0-9]{40}$/)
  assert.match(workflow, /uses: actions\/deploy-pages@[a-f0-9]{40}/)
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /persist-credentials: false/)
  assert.match(workflow, /path: public\n/)
  assert.match(workflow, /branches: \[main\]/)
  assert.match(workflow, /--release --git/)
  assert.doesNotMatch(workflow, /secrets\.|CLOUDFLARE|wrangler deploy/)
  const [build, deploy] = workflow.split('  deploy:\n')
  assert.doesNotMatch(build, /pages: write|id-token: write/)
  assert.match(deploy, /pages: write/)
  assert.match(deploy, /id-token: write/)
})
