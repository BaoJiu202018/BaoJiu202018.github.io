import { ENCRYPTED_DATA_PATH, PREVIEW } from './config.js'
import { loadEncryptedDirectory } from './encrypted-directory.js'

const $ = id => document.getElementById(id)
const kinds = { phone: '电话', wechat: '微信', qq: 'QQ', email: '邮箱', other: '联系方式' }
let directory = null
let expiresAt = 0
let pending = false
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

function setPending(value) {
  pending = value
  $('login-submit').disabled = value
  $('login-submit').textContent = value ? '正在解密…' : '进入同窗录 →'
}

function clearDetails() {
  selectedContact = null
  if ($('contact-dialog').open) $('contact-dialog').close()
  for (const id of ['contact-avatar', 'contact-name', 'contact-city', 'contact-note', 'contact-kind', 'contact-text', 'contact-updated']) $(id).textContent = ''
}

function lock(message = '') {
  directory = null
  expiresAt = 0
  generation++
  controller.abort()
  controller = new AbortController()
  clearTimeout(sessionTimer)
  clearTimeout(searchTimer)
  clearTimeout(toastTimer)
  nextCursor = null
  clearDetails()
  setPending(false)
  $('toast').hidden = true
  $('toast').textContent = ''
  $('contacts').replaceChildren()
  $('member-panel').hidden = true
  $('login-panel').hidden = false
  $('directory-count').textContent = ''
  $('directory-error').textContent = ''
  $('directory-empty').hidden = true
  $('load-more').hidden = true
  $('clear-filters').hidden = true
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

function unlocked() {
  if (directory && Date.now() >= expiresAt) lock('本页解锁已到期，请重新输入班级口令。')
  return directory !== null
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

function loadContacts(append = false) {
  if (!unlocked()) return
  clearDetails()
  if (!append) $('contacts').replaceChildren()
  const query = $('search').value.trim().toLowerCase()
  const city = $('city').value
  const matches = directory.filter(c => c.name.toLowerCase().includes(query) && (!city || c.city === (city === '__unknown__' ? '' : city)))
  const cursor = append ? nextCursor : 0
  $('contacts').append(...matches.slice(cursor, cursor + 12).map(card))
  $('directory-count').textContent = query || city ? `找到 ${matches.length} 位同学 · 共 ${directory.length} 位` : `共 ${directory.length} 位老同学，常联系。`
  $('clear-filters').hidden = !query && !city
  $('directory-empty').hidden = matches.length !== 0
  nextCursor = cursor + 12 < matches.length ? cursor + 12 : null
  $('load-more').hidden = nextCursor === null
  $('load-more').disabled = false
}

function openContact(id) {
  if (!unlocked()) return
  clearDetails()
  const contact = directory.find(c => c.id === id)
  if (!contact) return
  selectedContact = contact
  $('contact-avatar').textContent = Array.from(contact.name)[0] || '同'
  $('contact-name').textContent = contact.name
  $('contact-city').textContent = contact.city || '城市待补充'
  $('contact-note').textContent = contact.note || '还没有留下近况。下一次见面，再慢慢聊。'
  $('contact-kind').textContent = kinds[contact.contactKind] || '联系方式'
  $('contact-text').textContent = contact.contactText
  $('contact-updated').textContent = displayDate(contact.updatedAt)
  $('contact-dialog').showModal()
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
  if (pending || !$('login-form').reportValidity()) return
  setPending(true)
  $('login-error').textContent = ''
  const current = ++generation
  controller.abort()
  controller = new AbortController()
  let password = $('class-password').value
  $('class-password').value = ''
  try {
    const contacts = await loadEncryptedDirectory(ENCRYPTED_DATA_PATH, password, controller.signal)
    if (current !== generation) return
    const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
    directory = contacts.sort((a, b) => compare(a.name, b.name) || compare(a.id, b.id))
    expiresAt = Date.now() + 12 * 3600000
    sessionTimer = setTimeout(() => lock('本页解锁已到期，请重新输入班级口令。'), 12 * 3600000)
    const cities = new Map()
    for (const c of directory) cities.set(c.city, (cities.get(c.city) || 0) + 1)
    $('city').replaceChildren(new Option('全部城市', ''), ...[...cities].sort(([a], [b]) => compare(a, b)).map(([city, count]) => new Option(`${city || '城市待补充'} · ${count}`, city || '__unknown__')))
    $('login-panel').hidden = true
    $('member-panel').hidden = false
    loadContacts()
    if (unlocked()) $('search').focus({ preventScroll: true })
  } catch (error) {
    if (current === generation && error.name !== 'AbortError') {
      lock(error instanceof TypeError ? '无法读取加密通讯录，请检查网络后重试。' : error.message)
      $('class-password').focus({ preventScroll: true })
    }
  } finally {
    password = ''
    if (current === generation) setPending(false)
  }
})

$('logout').addEventListener('click', () => {
  lock()
  $('class-password').focus({ preventScroll: true })
})

$('search').addEventListener('input', () => {
  clearTimeout(searchTimer)
  if (!unlocked()) return
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
  if (!selectedContact || !unlocked()) return
  const current = generation
  try { await navigator.clipboard.writeText(selectedContact.contactText); if (current === generation && unlocked()) notify('联系方式已复制，请勿转发至班外。') }
  catch { if (current === generation && unlocked()) notify('浏览器暂不支持复制，请长按联系方式手动复制。') }
})
window.addEventListener('offline', () => { if (directory || pending) lock('网络已断开，本页资料已清除。联网后请重新输入口令。') })
window.addEventListener('pagehide', () => lock())
window.addEventListener('pageshow', () => unlocked())
document.addEventListener('visibilitychange', () => unlocked())
