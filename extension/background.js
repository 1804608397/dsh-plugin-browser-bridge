/**
 * Page functions injected into the tab. They must stay self-contained: Chrome
 * serialises each one and runs it in the page, so they cannot close over
 * anything in this file.
 */

function pageRead(payload) {
  const { selector, mode, maxChars } = payload
  const root = selector ? document.querySelector(selector) : document.body
  if (!root) return { ok: false, error: `no element matches ${selector}` }
  let content
  if (mode === 'html') {
    content = root.outerHTML
  } else if (mode === 'links') {
    content = [...root.querySelectorAll('a[href]')]
      .slice(0, 400)
      .map((a) => `${(a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80)}\t${a.href}`)
      .join('\n')
  } else {
    content = root.innerText || root.textContent || ''
  }
  const limit = Math.max(200, Math.min(60000, maxChars || 8000))
  const truncated = content.length > limit
  return {
    url: location.href,
    title: document.title,
    mode,
    truncated,
    content: truncated ? content.slice(0, limit) : content,
  }
}

function pageQuery(payload) {
  const { selector, limit } = payload
  let nodes
  try {
    nodes = [...document.querySelectorAll(selector)]
  } catch (error) {
    return { ok: false, error: `bad selector: ${error.message}` }
  }
  const rows = nodes.slice(0, limit).map((el) => {
    const rect = el.getBoundingClientRect()
    const attr = (name) => el.getAttribute(name) || ''
    return {
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 400),
      href: el.href || attr('href') || '',
      title: attr('title'),
      aria_label: attr('aria-label'),
      value: 'value' in el ? String(el.value).slice(0, 200) : undefined,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      visible: rect.width > 0 && rect.height > 0,
    }
  })
  return { url: location.href, selector, count: nodes.length, rows }
}

function pageClick(payload) {
  const { selector, text, x, y } = payload
  let target = null
  let matched = ''
  if (selector) {
    target = document.querySelector(selector)
    matched = selector
  } else if (text) {
    const wanted = String(text).trim()
    const CANDIDATE_SELECTOR = [
      'a', 'button', '[role=button]', '[onclick]', 'li', 'label', 'summary',
      '[class*=item]', '[class*=card]', '[class*=node]', '[class*=row]', '[class*=tab]',
      '[class*=cell]', '[class*=title]', '[class*=chapter]', '[class*=catalog]', '[class*=point]',
    ].join(', ')
    const candidates = [...document.querySelectorAll(CANDIDATE_SELECTOR)]
    const area = (el) => {
      const r = el.getBoundingClientRect()
      return r.width * r.height
    }
    const pickSmallest = (list) =>
      list.length ? list.slice().sort((a, b) => area(a) - area(b))[0] : null
    const exact = candidates.filter((el) => (el.innerText || '').trim() === wanted)
    const partial = candidates.filter((el) => (el.innerText || '').includes(wanted))
    target = pickSmallest(exact) || pickSmallest(partial) || null
    matched = `text ${wanted}`
  } else if (typeof x === 'number' && typeof y === 'number') {
    target = document.elementFromPoint(x, y)
    matched = `point ${x},${y}`
  }
  if (!target) return { ok: false, error: `nothing matched ${matched || 'the request'}` }
  if (target.scrollIntoView) target.scrollIntoView({ block: 'center', inline: 'center' })
  const rect = target.getBoundingClientRect()
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  const init = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }
  for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mousemove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    const event = type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init)
    target.dispatchEvent(event)
  }
  if (typeof target.click === 'function') target.click()
  return {
    ok: true,
    clicked: true,
    matched,
    target: {
      tag: target.tagName.toLowerCase(),
      text: (target.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 160),
      href: target.href || '',
    },
    url: location.href,
  }
}

function pageType(payload) {
  const { selector, text, submit } = payload
  const el = document.querySelector(selector)
  if (!el) return { ok: false, error: `no element matches ${selector}` }
  if (el.focus) el.focus()
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, text)
  else el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  if (submit) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }))
    }
  }
  return { ok: true, typed: true, submitted: submit === true, value: String(el.value).slice(0, 200) }
}

/** Resolve the tab to act on: explicit id, else the active tab of the last focused window. */
async function resolveTab(tabId) {
  if (typeof tabId === 'number') {
    const tab = await chrome.tabs.get(tabId).catch(() => null)
    if (tab) return tab
    throw new Error(`tab ${tabId} does not exist`)
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  if (tab) return tab
  const [any] = await chrome.tabs.query({ active: true })
  if (any) return any
  throw new Error('no active tab')
}

async function runInTab(tab, func, args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func, args: [args] })
  const value = result?.result
  if (value && value.ok === false) throw new Error(value.error || 'the page rejected the request')
  return value
}

const OPS = {
  async tabs() {
    const tabs = await chrome.tabs.query({})
    return tabs
      .filter((tab) => typeof tab.id === 'number')
      .map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '', active: tab.active === true, windowId: tab.windowId }))
  },

  async read(params) {
    const tab = await resolveTab(params.tabId)
    const value = await runInTab(tab, pageRead, params)
    return value
  },

  async query(params) {
    const tab = await resolveTab(params.tabId)
    return runInTab(tab, pageQuery, params)
  },

  async click(params) {
    const tab = await resolveTab(params.tabId)
    const value = await runInTab(tab, pageClick, params)
    // Give the page a moment to navigate or re-render before the next command.
    await new Promise((resolve) => setTimeout(resolve, 400))
    return value
  },

  async type(params) {
    const tab = await resolveTab(params.tabId)
    return runInTab(tab, pageType, params)
  },

  async navigate(params) {
    if (typeof params.url !== 'string' || !/^https?:\/\//i.test(params.url)) throw new Error('url must be absolute http(s)')
    let tab
    if (typeof params.tabId === 'number') {
      tab = await chrome.tabs.update(params.tabId, { url: params.url, active: true })
    } else {
      tab = await resolveTab()
      tab = await chrome.tabs.update(tab.id, { url: params.url })
    }
    return waitForTab(tab.id)
  },

  async screenshot(params) {
    const tab = await resolveTab(params.tabId)
    // captureVisibleTab silently hangs when the window is minimized or the tab
    // is not the visible one, so focus the window, activate the tab, and never
    // wait forever.
    try {
      await chrome.windows.update(tab.windowId, { focused: true })
    } catch {}
    try {
      await chrome.tabs.update(tab.id, { active: true })
    } catch {}
    const image = await Promise.race([
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('captureVisibleTab timed out: the tab must be visible in a window that is not minimized')),
          8000,
        ),
      ),
    ])
    // A full-screen PNG data URL runs to several megabytes; a service worker's
    // WebSocket send silently fails on payloads that large, so downscale first.
    const shrunk = await shrinkDataUrl(image, 1600, 0.7)
    const dimensions = await runInTab(
      tab,
      function pageSize() {
        return { width: window.innerWidth, height: window.innerHeight, url: location.href, title: document.title }
      },
      {},
    )
    return { image: shrunk, ...dimensions }
  },
}

/** Decode a data URL, scale it down to maxWidth, and re-encode it as JPEG. */
async function shrinkDataUrl(dataUrl, maxWidth, quality) {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    const bitmap = await createImageBitmap(blob)
    const scale = Math.min(1, maxWidth / bitmap.width)
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    bitmap.close?.()
    const shrunk = await canvas.convertToBlob({ type: 'image/jpeg', quality })
    const bytes = new Uint8Array(await shrunk.arrayBuffer())
    let binary = ''
    const chunk = 0x8000
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunk))
    }
    return `data:image/jpeg;base64,${btoa(binary)}`
  } catch {
    return dataUrl
  }
}

/** Wait until a tab reports complete, or time out. */
async function waitForTab(tabId, timeoutMs = 15000) {
  const started = Date.now()
  let tab = await chrome.tabs.get(tabId)
  while (tab.status !== 'complete' && Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    tab = await chrome.tabs.get(tabId).catch(() => tab)
  }
  return { tabId, url: tab.url || '', title: tab.title || '' }
}

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

const DEFAULT_PORT = 17871
let socket = null
let reconnectDelay = 1000
let status = { connected: false, lastError: null, lastConnectedAt: null }

async function settings() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: '' })
  return { port: Number(stored.port) || DEFAULT_PORT, token: String(stored.token || '') }
}

function setStatus(patch) {
  status = { ...status, ...patch }
  chrome.storage.local.set({ status }).catch(() => {})
}

async function pairFromHost() {
  const { port, token } = await settings()
  if (token) return token
  try {
    const response = await fetch(`http://127.0.0.1:${port}/pair`, { cache: 'no-store' })
    if (!response.ok) return ''
    const fresh = (await response.text()).trim()
    if (fresh.length < 16) return ''
    await chrome.storage.local.set({ token: fresh })
    return fresh
  } catch (_) {
    return ''
  }
}

async function connect() {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  const { port } = await settings()
  const token = await pairFromHost()
  if (!token) {
    setStatus({ connected: false, lastError: 'no pairing token saved — open this extension\'s options and paste it' })
    return
  }
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
  socket = ws

  ws.addEventListener('open', () => {
    reconnectDelay = 1000
    setStatus({ connected: true, lastError: null, lastConnectedAt: Date.now() })
  })
  ws.addEventListener('close', () => {
    if (socket === ws) socket = null
    setStatus({ connected: false })
    scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    setStatus({ connected: false, lastError: 'connection failed — is DeepSeek Harness running with the Browser Bridge plugin enabled?' })
  })
  ws.addEventListener('message', (event) => onMessage(ws, event.data))
}

function scheduleReconnect() {
  setTimeout(() => {
    connect().catch(() => scheduleReconnect())
  }, reconnectDelay)
  reconnectDelay = Math.min(reconnectDelay * 2, 3000)
}

async function onMessage(ws, raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }
  // server → client commands carry a numeric id; anything else is informational.
  if (typeof message.id !== 'number') return
  const reply = (body) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, ...body }))
  }
  try {
    const handler = OPS[message.op]
    if (!handler) throw new Error(`unknown op ${message.op}`)
    const result = await handler(message.params || {})
    reply({ ok: true, result })
  } catch (error) {
    reply({ ok: false, error: String(error && error.message ? error.message : error) })
  }
}

chrome.runtime.onStartup.addListener(() => {
  connect().catch(() => {})
})
chrome.runtime.onInstalled.addListener(() => {
  connect().catch(() => {})
})
chrome.storage.onChanged.addListener((changes) => {
  if (changes.token || changes.port) {
    try {
      socket?.close()
    } catch {}
    socket = null
    connect().catch(() => {})
  }
})

// Keep the service worker warm: MV3 suspends an idle worker after ~30s, which
// would silently drop the socket. A ping every 20s counts as activity.
setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    try {
      socket.send(JSON.stringify({ type: 'ping', at: Date.now() }))
    } catch {}
    return
  }
  connect().catch(() => {})
}, 20000)
chrome.alarms?.create?.('dsh-browser-bridge-keepalive', { periodInMinutes: 0.4 })

connect().catch(() => {})
