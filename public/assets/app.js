import { API_BASE, PREVIEW } from './config.js'

const $ = id => document.getElementById(id)
const kinds = { phone: '电话', wechat: '微信', qq: 'QQ', email: '邮箱', other: '联系方式' }
let token = ''
let expiresAt = 0
let sessionTimer
let searchTimer
let toastTimer
let generation = 0
let nextCursor = null
let selectedContact = null
let controller = new AbortController()

$('preview-banner').hidden = !PREVIEW

function notify(message) {
  clearTimeout(toastTimer)
  $('toast').textContent = message
  $('toast').hidden = false
  toastTimer = setTimeout(() => { $('toast').hidden = true; $('toast').textContent = '' }, 3000)
}

function clearDetails() {
  selectedContact = null
  if ($('contact-dialog').open) $('contact-dialog').close()
  for (const id of ['contact-avatar', 'contact-name', 'contact-city', 'contact-note', 'contact-kind', 'contact-text', 'contact-updated']) $(id).textContent = ''
}

function lock(message = '') {
  token = ''
  expiresAt = 0
  generation++
  controller.abort()
  controller = new AbortController()
  clearTimeout(sessionTimer)
  clearTimeout(searchTimer)
  clearTimeout(toastTimer)
  nextCursor = null
  clearDetails()
  $('toast').hidden = true
  $('toast').textContent = ''
  $('contacts').replaceChildren()
  $('member-panel').hidden = true
  $('login-panel').hidden = false
  $('directory-count').textContent = ''
  $('directory-error').textContent = ''
  $('directory-empty').hidden = true
  $('load-more').hidden = true
  $('search').value = ''
  $('city').replaceChildren(new Option('全部城市', ''))
  $('class-password').value = ''
  $('class-password').type = 'password'
  $('toggle-password').textContent = '显示'
  $('toggle-password').setAttribute('aria-pressed', 'false')
  $('toggle-password').setAttribute('aria-label', '显示口令')
  $('consent').checked = false
  $('login-error').textContent = message
}

async function request(path, { method = 'GET', body, bearer = token, signal = controller.signal } = {}) {
  if (!API_BASE) throw new Error('通讯录后端尚未接入，暂时不能登录。此页面不包含同学资料。')
  const response = await fetch(`${API_BASE}${path}`, {
    method, signal, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const result = await response.json()
  if (!response.ok || !result.ok) {
    const error = new Error(result.error?.message || '服务暂时无法连接，请稍后重试。')
    error.status = response.status
    throw error
  }
  return result.data
}

function fail(error) {
  if (error.name === 'AbortError') return
  lock(error.status === 401 ? '会话已失效，请重新输入班级口令。' : '暂时无法读取通讯录，已清除本页资料。请检查网络后重新登录。')
  $('class-password').focus({ preventScroll: true })
}

function node(tag, className, text) {
  const element = document.createElement(tag)
  element.className = className
  element.textContent = text
  return element
}

function displayDate(value) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '更新时间待补充' : `更新于 ${date.toLocaleDateString('zh-CN')}`
}

function card(contact) {
  const button = node('button', 'contact-card', '')
  button.type = 'button'
  button.setAttribute('aria-label', `查看${contact.name}的名片`)
  const top = node('span', 'card-top', '')
  top.append(node('span', 'card-avatar', Array.from(contact.name)[0] || '同'), node('span', 'card-city', contact.city || '城市待补充'))
  button.append(top, node('strong', 'card-name', contact.name), node('span', 'card-contact', `${kinds[contact.contactKind] || '联系方式'} · ${contact.contactText}`), node('span', 'card-note', contact.note || '留一点空白，等下一次相逢。'))
  const bottom = node('span', 'card-bottom', '')
  bottom.append(node('span', 'card-updated', displayDate(contact.updatedAt)), node('span', '', '翻开名片 ↗'))
  button.append(bottom)
  button.addEventListener('click', () => openContact(contact.id))
  return button
}

async function loadContacts(append = false) {
  const current = ++generation
  controller.abort()
  controller = new AbortController()
  clearDetails()
  if (!append) $('contacts').replaceChildren()
  $('directory-count').textContent = '正在翻开同窗录…'
  $('directory-empty').hidden = true
  $('load-more').disabled = true
  $('load-more').hidden = true
  const query = $('search').value.trim()
  const city = $('city').value
  $('clear-filters').hidden = !query && !city
  try {
    const result = await request(`/contacts?${new URLSearchParams({ query, city, cursor: String(append ? nextCursor : 0), limit: '12' })}`)
    if (current !== generation || !token) return
    $('contacts').append(...result.items.map(card))
    $('directory-count').textContent = query || city ? `找到 ${result.total} 位同学 · 共 ${result.totalAll} 位` : `共 ${result.totalAll} 位老同学，常联系。`
    const options = [new Option('全部城市', '')]
    for (const item of result.cities) options.push(new Option(`${item.name || '城市待补充'} · ${item.count}`, item.name || '__unknown__'))
    $('city').replaceChildren(...options)
    $('city').value = city
    $('directory-empty').hidden = result.total !== 0
    nextCursor = result.nextCursor
    $('load-more').hidden = nextCursor === null
    $('load-more').disabled = false
  } catch (error) { if (current === generation) fail(error) }
}

async function openContact(id) {
  const current = ++generation
  clearDetails()
  try {
    const contact = await request(`/contacts/${encodeURIComponent(id)}`)
    if (current !== generation || !token) return
    selectedContact = contact
    $('contact-avatar').textContent = Array.from(contact.name)[0] || '同'
    $('contact-name').textContent = contact.name
    $('contact-city').textContent = contact.city || '城市待补充'
    $('contact-note').textContent = contact.note || '还没有留下近况。下一次见面，再慢慢聊。'
    $('contact-kind').textContent = kinds[contact.contactKind] || '联系方式'
    $('contact-text').textContent = contact.contactText
    $('contact-updated').textContent = displayDate(contact.updatedAt)
    $('contact-dialog').showModal()
  } catch (error) { if (current === generation) fail(error) }
}

$('toggle-password').addEventListener('click', () => {
  const show = $('class-password').type === 'password'
  $('class-password').type = show ? 'text' : 'password'
  $('toggle-password').textContent = show ? '隐藏' : '显示'
  $('toggle-password').setAttribute('aria-label', show ? '隐藏口令' : '显示口令')
  $('toggle-password').setAttribute('aria-pressed', String(show))
})

$('login-form').addEventListener('submit', async event => {
  event.preventDefault()
  if (!$('login-form').reportValidity()) return
  $('login-submit').disabled = true
  $('login-error').textContent = ''
  const current = ++generation
  const password = $('class-password').value
  $('class-password').value = ''
  try {
    const session = await request('/auth/login', { method: 'POST', body: { password }, bearer: '' })
    if (current !== generation) return
    token = session.token
    expiresAt = session.expiresAt
    sessionTimer = setTimeout(() => lock('会话已到期，请重新输入班级口令。'), Math.max(0, expiresAt - Date.now()))
    $('login-panel').hidden = true
    $('member-panel').hidden = false
    await loadContacts()
    if (token) $('search').focus({ preventScroll: true })
  } catch (error) {
    if (current === generation && error.name !== 'AbortError') $('login-error').textContent = error.message === 'Failed to fetch' ? '无法连接通讯录，请检查网络后重试。' : error.message
  } finally { $('login-submit').disabled = false }
})

$('logout').addEventListener('click', async () => {
  const bearer = token
  lock()
  $('class-password').focus({ preventScroll: true })
  try { await request('/auth/logout', { method: 'POST', body: {}, bearer }) }
  catch (error) { if (error.status !== 401) notify('本页资料已清除；服务端退出未确认，会话将在到期后失效。') }
})

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  generation++
  controller.abort()
  $('contacts').replaceChildren()
  clearDetails()
  $('directory-count').textContent = '正在筛选…'
  $('directory-empty').hidden = true
  $('load-more').hidden = true
  searchTimer = setTimeout(() => loadContacts(), 250)
})
$('city').addEventListener('change', () => { clearTimeout(searchTimer); loadContacts() })
$('clear-filters').addEventListener('click', () => {
  clearTimeout(searchTimer)
  $('search').value = ''
  $('city').value = ''
  loadContacts()
})
$('load-more').addEventListener('click', () => { if (nextCursor !== null) loadContacts(true) })
$('close-contact').addEventListener('click', clearDetails)
$('contact-dialog').addEventListener('close', clearDetails)
$('copy-contact').addEventListener('click', async () => {
  if (!selectedContact || !token) return
  try { await navigator.clipboard.writeText(selectedContact.contactText); notify('联系方式已复制，请勿转发至班外。') }
  catch { notify('浏览器暂不支持复制，请长按联系方式手动复制。') }
})
window.addEventListener('offline', () => { if (token) lock('网络已断开，本页资料已清除。联网后请重新登录。') })
window.addEventListener('pagehide', () => lock())
document.addEventListener('visibilitychange', () => { if (token && Date.now() >= expiresAt) lock('会话已到期，请重新输入班级口令。') })
