import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fixturePassword, staticFixtures as fixtures, encryptFixture } from './support.mjs'

const encryptedPath = '**/assets/directory.encrypted.json'
async function submit(page, password = fixturePassword) {
  await page.locator('#class-password').fill(password)
  await page.locator('#consent').check()
  await page.locator('#login-submit').click()
}
async function login(page) {
  await submit(page)
  await expect(page.locator('.contact-card')).toHaveCount(12)
}
async function cleared(page) {
  await expect(page.locator('#login-panel')).toBeVisible()
  await expect(page.locator('#member-panel')).toBeHidden()
  await expect(page.locator('.contact-card')).toHaveCount(0)
  await expect(page.locator('#contact-name')).toBeEmpty()
  await expect(page.locator('#contact-text')).toBeEmpty()
  await expect(page.locator('#class-password')).toBeEmpty()
  expect(await page.evaluate(() => document.body.textContent.includes('示例同学'))).toBe(false)
}

test.beforeEach(async ({ context, baseURL }) => {
  await context.route('**/*', route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.continue() : route.abort())
})

test('script failure cannot submit a password without server CSP headers', async ({ page, baseURL }) => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8')
  await page.route(baseURL + '/', route => route.fulfill({ contentType: 'text/html', body: html }))
  await page.route('**/assets/app.js', route => route.abort())
  await page.goto('/')
  await page.locator('#class-password').fill(fixturePassword)
  await page.locator('#consent').check()
  expect(await page.locator('#class-password').getAttribute('name')).toBeNull()
  expect(await page.evaluate(() => [...new FormData(document.getElementById('login-form')).values()])).toEqual([])
  const requests = []
  page.on('request', request => requests.push(request.url()))
  await page.evaluate(() => { window.formBlocked = false; document.addEventListener('securitypolicyviolation', event => { if (event.violatedDirective === 'form-action') window.formBlocked = true }) })
  await page.locator('#login-submit').click({ noWaitAfter: true })
  await page.waitForFunction(() => window.formBlocked)
  expect(requests).toEqual([])
  expect(page.url()).toBe(baseURL + '/')
  expect(await page.evaluate(() => getComputedStyle(document.getElementById('member-panel')).display)).toBe('none')
})

test('same-origin decryption preserves all fields, pagination, search, copy and logout', async ({ page, context, baseURL }) => {
  const errors = [], requests = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('request', request => requests.push({ url: request.url(), method: request.method(), body: request.postData(), authorization: request.headers().authorization }))
  await page.goto('/')
  await expect(page.locator('h1')).toContainText('散作满天星')
  await expect(page).toHaveTitle('18班同窗录 — 包头九中2017级（2020届）18班')
  await expect(page.locator('.school-line')).toHaveText('包头市第九中学 · 2017级（2020届）18班')
  await expect(page.locator('.chapter-ribbon')).toContainText('2017相遇的起点')
  await expect(page.locator('.postmark b')).toHaveText('2017')
  await expect(page.locator('#privacy')).toContainText('更换口令不能使已下载的旧密文失效')
  await expect(page.locator('#preview-banner')).toBeVisible()
  expect(requests.some(r => r.url.endsWith('.json'))).toBe(false)
  expect(await page.evaluate(() => document.body.textContent.includes('示例同学'))).toBe(false)
  await login(page)
  await expect(page.locator('.session-badge')).toHaveText('已在本机解密')
  await expect(page.locator('#directory-count')).toContainText('27')
  await page.locator('#load-more').click()
  await expect(page.locator('.contact-card')).toHaveCount(24)
  await page.locator('#load-more').click()
  await expect(page.locator('.contact-card')).toHaveCount(27)
  await expect(page.locator('#load-more')).toBeHidden()
  expect(await page.locator('.card-name').allTextContents()).toEqual(fixtures.map(c => c.name))
  await page.getByRole('button', { name: '查看示例同学01的名片', exact: true }).click()
  await expect(page.locator('#contact-dialog')).toBeVisible()
  await expect(page.locator('#contact-city')).toHaveText('城市待补充')
  await expect(page.locator('#contact-note')).toHaveText(fixtures[0].note)
  await expect(page.locator('#contact-text')).toHaveText(fixtures[0].contactText)
  await expect(page.locator('#contact-kind')).toHaveText('邮箱')
  await expect(page.locator('#contact-updated')).toContainText('2026')
  expect(await page.locator('#contact-note img').count()).toBe(0)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('#copy-contact').click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(fixtures[0].contactText)
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await page.keyboard.press('Escape')
  await expect(page.locator('#contact-name')).toBeEmpty()
  await page.locator('#city').selectOption('__unknown__')
  await expect(page.locator('.contact-card')).toHaveCount(9)
  await page.locator('#search').fill('不存在')
  await expect(page.locator('#directory-empty')).toBeVisible()
  await page.locator('#clear-filters').click()
  await expect(page.locator('.contact-card')).toHaveCount(12)
  await page.locator('#search').fill('示例同学02')
  await expect(page.locator('.contact-card')).toHaveCount(1)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(await page.evaluate(async () => ({ local: localStorage.length, session: sessionStorage.length, databases: (await indexedDB.databases()).length, workers: (await navigator.serviceWorker.getRegistrations()).length }))).toEqual({ local: 0, session: 0, databases: 0, workers: 0 })
  await page.locator('#logout').click()
  await cleared(page)
  expect(requests.filter(r => r.url.endsWith('directory.encrypted.json'))).toHaveLength(1)
  expect(requests.every(r => r.method === 'GET' && r.body === null && !r.authorization && new URL(r.url).origin === new URL(baseURL).origin)).toBe(true)
  expect(JSON.stringify(requests)).not.toContain(fixturePassword)
  expect(errors).toEqual([])
})

test('wrong password and download or format failures stay locked', async ({ page }) => {
  await page.goto('/')
  await page.locator('#toggle-password').click()
  await expect(page.locator('#class-password')).toHaveAttribute('type', 'text')
  await submit(page, 'wrong-password')
  await expect(page.locator('#login-error')).toContainText('口令不正确或加密文件已损坏')
  await cleared(page)
  for (const response of [
    { status: 503, body: '', expected: '无法下载' },
    { status: 200, body: '{}', expected: '格式不正确' },
    { status: 200, body: 'x'.repeat(262145), expected: '格式不正确' },
  ]) {
    await page.route(encryptedPath, route => route.fulfill({ status: response.status, contentType: 'application/json', body: response.body }))
    await submit(page)
    await expect(page.locator('#login-error')).toContainText(response.expected)
    await cleared(page)
    await page.unroute(encryptedPath)
  }
  await page.route(encryptedPath, route => route.abort('failed'))
  await submit(page)
  await expect(page.locator('#login-error')).toContainText('检查网络')
  await cleared(page)
  await page.unroute(encryptedPath)
  await login(page)
})

test('reload, offline and independent pages clear only their own plaintext', async ({ page, context }) => {
  await page.goto('/')
  await login(page)
  const other = await context.newPage()
  await other.goto('/')
  await cleared(other)
  await login(other)
  await page.locator('#logout').click()
  await cleared(page)
  await expect(other.locator('.contact-card')).toHaveCount(12)
  await other.reload()
  await cleared(other)
  await login(page)
  await page.locator('.contact-card').first().click()
  await context.setOffline(true)
  await cleared(page)
  await expect(page.locator('#login-error')).toContainText('网络已断开')
  await context.setOffline(false)
  await login(page)
  await page.reload()
  await cleared(page)
  await other.close()
})

test('local 12-hour lock removes plaintext without server traffic', async ({ page }) => {
  await page.clock.install()
  await page.goto('/')
  await login(page)
  await page.locator('.contact-card').first().click()
  await page.clock.fastForward(12 * 3600000 + 1)
  await expect(page.locator('#login-error')).toContainText('已到期')
  await cleared(page)
})

test('leaving during download cancels pending unlock and duplicate submission', async ({ page }) => {
  let release, reached, finished
  const gate = new Promise(resolve => { release = resolve })
  const requested = new Promise(resolve => { reached = resolve })
  const done = new Promise(resolve => { finished = resolve })
  let requests = 0
  await page.route(encryptedPath, async route => {
    requests++
    reached()
    await gate
    try { await route.fulfill({ contentType: 'application/json', body: JSON.stringify(encryptFixture()) }) } catch {} finally { finished() }
  })
  await page.goto('/')
  await submit(page)
  await requested
  await expect(page.locator('#login-submit')).toBeDisabled()
  await page.locator('#login-form').dispatchEvent('submit')
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')))
  release()
  await done
  await cleared(page)
  expect(requests).toBe(1)
  await page.unroute(encryptedPath)
  await login(page)
})

test('a late Web Crypto result cannot unlock after an offline event', async ({ page }) => {
  await page.addInitScript(() => {
    const original = crypto.subtle.decrypt.bind(crypto.subtle)
    crypto.subtle.decrypt = async (...args) => {
      const value = await original(...args)
      window.decryptStarted = true
      await new Promise(resolve => { window.releaseDecrypt = resolve })
      return value
    }
  })
  await page.goto('/')
  await submit(page)
  await page.waitForFunction(() => window.decryptStarted)
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('offline'))
    window.releaseDecrypt()
    await new Promise(requestAnimationFrame)
  })
  await cleared(page)
  await expect(page.locator('#login-error')).toContainText('网络已断开')
})

test('empty encrypted directory and unsupported crypto fail honestly', async ({ page }) => {
  await page.route(encryptedPath, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify(encryptFixture({ schema: 1, contacts: [] })) }))
  await page.goto('/')
  await submit(page)
  await expect(page.locator('#member-panel')).toBeVisible()
  await expect(page.locator('#directory-empty')).toBeVisible()
  await expect(page.locator('#directory-count')).toContainText('0')
  await page.locator('#logout').click()
  await page.evaluate(() => Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} }))
  await submit(page)
  await expect(page.locator('#login-error')).toContainText('不支持安全解密')
  await cleared(page)
})

test('320px, keyboard labels, reduced motion and missing configuration', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await login(page)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.locator('.contact-card').nth(1).click()
  await expect(page.locator('#contact-note')).toHaveText(fixtures[1].note)
  expect(await page.locator('#contact-dialog').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)
  await page.locator('#close-contact').click()
  await page.locator('#logout').click()
  await cleared(page)
  await page.route('**/assets/config.js', route => route.fulfill({ contentType: 'text/javascript', body: "export const ENCRYPTED_DATA_PATH = ''; export const PREVIEW = false;" }))
  await page.reload()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.getByLabel('班级口令', { exact: true }).fill('example-only')
  await page.locator('#consent').check()
  await page.locator('#login-submit').focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('#login-error')).toContainText('尚未配置')
  await cleared(page)
  expect(await page.evaluate(() => document.querySelectorAll('img:not([alt])').length)).toBe(0)
})
