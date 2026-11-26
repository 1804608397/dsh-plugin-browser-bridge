/**
 * Host half of the Browser Bridge bundle.
 *
 * A paired Chrome extension dials in over a loopback WebSocket, so the model can
 * read a page's DOM and drive its tabs without opening Chrome's DevTools port and
 * without taking a screenshot. Screenshots remain available (both through the
 * extension and through the Linux Computer Use bundle's portal capture) for the
 * pages where structured extraction is the wrong tool.
 *
 * Deliberately dependency-free (node builtins only): a bundle that imports DSH
 * internals breaks on upgrade.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const DEFAULT_PORT = 17871
const REQUEST_TIMEOUT_MS = 20000
const TOKEN_DIR = join(homedir(), '.config', 'dsh-browser-bridge')
const TOKEN_PATH = join(TOKEN_DIR, 'token')

/** Read the pairing token, creating it on first run with owner-only permissions. */
function ensureToken() {
  try {
    mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 })
    if (existsSync(TOKEN_PATH)) {
      const existing = readFileSync(TOKEN_PATH, 'utf8').trim()
      if (existing.length >= 16) return { token: existing, path: TOKEN_PATH, created: false }
    }
    const token = randomBytes(24).toString('hex')
    writeFileSync(TOKEN_PATH, `${token}\n`, { mode: 0o600 })
    try {
      chmodSync(TOKEN_PATH, 0o600)
    } catch {}
    return { token, path: TOKEN_PATH, created: true }
  } catch (error) {
    return { token: null, path: TOKEN_PATH, created: false, error: error.message }
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a))
  const right = Buffer.from(String(b))
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/** Encode one unmasked server frame. */
function encodeFrame(opcode, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload)
  const length = body.length
  let header
  if (length < 126) {
    header = Buffer.alloc(2)
    header[1] = length
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, body])
}

/**
 * The bridge: one loopback WebSocket listener, one active extension connection,
 * and a request/response table keyed by monotonic id.
 */
export class Bridge {
  constructor(port) {
    this.port = port
    this.server = null
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 1
    this.clients = 0
    this.framesOut = 0
    this.framesIn = 0
    this.repliesIn = 0
    this.lastError = null
    this.token = ensureToken()
  }

  get connected() {
    return this.socket !== null
  }

  listen() {
    if (!this.token.token) {
      this.lastError = `could not create the pairing token at ${TOKEN_PATH}: ${this.token.error ?? 'unknown error'}`
      return
    }
    this.server = createServer((req, res) => {
      // One-shot pairing handover: only while the operator has dropped the
      // pair-allow marker next to the token (see docs/DETAIL.md).
      if (req.method === 'GET' && req.url === '/pair' && existsSync(join(TOKEN_DIR, 'pair-allow'))) {
        res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
        res.end(`${this.token.token}\n`)
        return
      }
      res.writeHead(426, { 'content-type': 'text/plain' })
      res.end('This endpoint only accepts a WebSocket upgrade.\n')
    })
    this.server.on('upgrade', (req, socket, head) => this.accept(req, socket, head))
    this.server.on('error', (error) => {
      this.lastError = `bridge listener failed: ${error.message}`
    })
    this.server.listen(this.port, '127.0.0.1')
  }

  accept(req, socket, head) {
    let url
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
      return
    }
    const token = url.searchParams.get('token') ?? req.headers['x-bridge-token']
    if (!this.token.token || !token || !safeEqual(token, this.token.token)) {
      this.lastError = 'a client presented the wrong pairing token'
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
      return
    }
    const accept = createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n'),
    )
    socket.setNoDelay(true)
    if (this.socket && this.socket !== socket) {
      try {
        this.socket.destroy()
      } catch {}
    }
    this.socket = socket
    this.clients += 1
    this.buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => this.onData(chunk))
    socket.on('close', () => this.onClose(socket))
    socket.on('error', () => this.onClose(socket))
    this.send({ type: 'hello', server: 'dsh-browser-bridge', version: 1 })
    // Chrome suspends an idle MV3 service worker after ~30s, which silently
    // drops this socket. Traffic in either direction counts as activity, so the
    // host keeps the link warm; the extension ignores messages without an id.
    this.stopHeartbeat()
    this.heartbeat = setInterval(() => {
      if (!this.socket) return this.stopHeartbeat()
      this.send({ type: 'ping', at: Date.now() })
    }, 20000)
    this.heartbeat.unref?.()
    if (head && head.length > 0) this.onData(head)
  }

  stopHeartbeat() {
    if (this.heartbeat) {
      clearInterval(this.heartbeat)
      this.heartbeat = null
    }
  }

  onClose(socket) {
    if (this.socket === socket) {
      this.socket = null
      this.stopHeartbeat()
    }
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error('the browser extension disconnected'))
    }
    this.pending.clear()
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    for (;;) {
      const frame = this.readFrame()
      if (!frame) return
      if (frame.opcode === 0x8) {
        try {
          this.socket?.end(encodeFrame(0x8, Buffer.alloc(0)))
        } catch {}
        this.onClose(this.socket)
        return
      }
      if (frame.opcode === 0x9) {
        this.write(encodeFrame(0xa, frame.payload))
        continue
      }
      if (frame.opcode === 0x1) {
        this.framesIn += 1
        this.onMessage(frame.payload.toString('utf8'))
      }
    }
  }

  /** Pop one complete client frame (masked) off the buffer, or return null. */
  readFrame() {
    const buf = this.buffer
    if (buf.length < 2) return null
    const opcode = buf[0] & 0x0f
    const masked = (buf[1] & 0x80) !== 0
    let length = buf[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buf.length < offset + 2) return null
      length = buf.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buf.length < offset + 8) return null
      const big = buf.readBigUInt64BE(offset)
      if (big > 64n * 1024n * 1024n) {
        this.onClose(this.socket)
        return null
      }
      length = Number(big)
      offset += 8
    }
    let maskKey = null
    if (masked) {
      if (buf.length < offset + 4) return null
      maskKey = buf.subarray(offset, offset + 4)
      offset += 4
    }
    if (buf.length < offset + length) return null
    const payload = Buffer.from(buf.subarray(offset, offset + length))
    if (maskKey) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i & 3]
    }
    this.buffer = buf.subarray(offset + length)
    return { opcode, payload }
  }

  onMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (!message || typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.repliesIn += 1
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.ok === false) entry.reject(new Error(String(message.error ?? 'the extension reported a failure')))
    else entry.resolve(message.result)
  }

  write(frame) {
    if (!this.socket) return false
    try {
      this.framesOut += 1
      this.socket.write(frame)
      return true
    } catch {
      this.onClose(this.socket)
      return false
    }
  }

  send(value) {
    return this.write(encodeFrame(0x1, JSON.stringify(value)))
  }

  /** Ask the extension to run one operation. */
  async waitForClient(timeoutMs = 5000) {
    if (this.connected) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (this.connected) return true
    }
    return false
  }

  async request(op, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    this.lastOp = op
    if (!this.connected && !(await this.waitForClient(op === 'ping' ? 500 : 5000))) {
      throw new Error(
        'no browser extension is connected: load the bundled Chrome extension (see this bundle\'s README) and pair it with the token printed by browser_status.',
      )
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`the browser did not answer "${op}" within ${Math.round(timeoutMs / 1000)}s`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.lastRequest = { id, op, sent: false }
      const sentOk = this.send({ id, op, params })
      if (this.lastRequest) this.lastRequest.sent = sentOk
      if (!sentOk) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error('the browser connection dropped while sending the request'))
      }
    })
  }

  close() {
    try {
      this.socket?.destroy()
    } catch {}
    this.socket = null
    try {
      this.server?.close()
    } catch {}
    this.server = null
  }
}

const TAB_ID = {
  type: 'number',
  description: 'Chrome tab id from browser_tabs. Omit to use the tab the user is looking at.',
}

const SELECTOR = {
  type: 'string',
  description: 'CSS selector, e.g. ".bili-video-card a" or "button[type=submit]".',
}

function renderJson(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

function statusRender(_args, value) {
  const lines = [
    `extension: ${value.connected ? 'connected' : 'not connected'}`,
    `listen: ws://127.0.0.1:${value.port}/ws`,
    `token file: ${value.token_path}${value.token_created ? ' (just created — paste it into the extension once)' : ''}`,
    `frames out/in: ${value.frames_out}/${value.frames_in} · replies: ${value.replies_in}`,
  ]
  if (value.last_request) {
    lines.push(`last request: #${value.last_request.id} ${value.last_request.op} sent=${value.last_request.sent}`)
  }
  if (value.last_error) lines.push(`last error: ${value.last_error}`)
  if (!value.connected) {
    lines.push('')
    lines.push('Load the bundled extension: chrome://extensions → enable Developer mode → Load unpacked → pick this bundle\'s extension/ directory, then paste the token into its options page.')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

export const inject = ['tools', 'attachments']

export const name = 'browser-bridge'

export function apply(context, config = {}) {
  const port = Number.isInteger(config?.port) ? config.port : DEFAULT_PORT
  const bridge = new Bridge(port)
  bridge.listen()
  context.effect(() => () => bridge.close())

  const register = (tool) => context.effect(() => context.tools.register(tool))

  register({
    name: 'browser_status',
    description:
      'Report whether the paired Chrome extension is connected to this DeepSeek Harness process, and print the token path used for pairing. Call it first when a browser_* tool says nothing is connected.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          connected: { type: 'boolean' },
          port: { type: 'number' },
          token_path: { type: 'string' },
          token_created: { type: 'boolean' },
          clients: { type: 'number' },
          frames_out: { type: 'number' },
          frames_in: { type: 'number' },
          replies_in: { type: 'number' },
          last_error: { type: 'string' },
        },
        required: ['connected', 'port', 'token_path'],
      },
      render: statusRender,
    },
    async execute() {
      return {
        connected: bridge.connected,
        port: bridge.port,
        token_path: bridge.token.path,
        token_created: bridge.token.created,
        clients: bridge.clients,
        frames_out: bridge.framesOut,
        frames_in: bridge.framesIn,
        replies_in: bridge.repliesIn,
        ...(bridge.lastRequest ? { last_request: bridge.lastRequest } : {}),
        ...(bridge.lastError ? { last_error: bridge.lastError } : {}),
      }
    },
  })

  register({
    name: 'browser_tabs',
    description: 'List the open Chrome tabs (id, title, url, active) through the paired extension. Use it to pick a tab id for the other browser_* tools.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        properties: {
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'number' },
                title: { type: 'string' },
                url: { type: 'string' },
                active: { type: 'boolean' },
              },
            },
          },
        },
        required: ['tabs'],
      },
      render: renderJson,
    },
    execute: async () => ({ tabs: await bridge.request('tabs') }),
  })

  register({
    name: 'browser_read',
    description: [
      'Read a page without taking a screenshot: returns its visible text, its HTML, or its links.',
      'Cheap and precise for lists, titles, prices, tables and form state; fall back to mcp__linux__screenshot when the page is canvas-based or the reader cannot see inside a cross-origin iframe.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        tabId: TAB_ID,
        selector: { type: 'string', description: 'Restrict the read to matching elements, e.g. "main" or ".list".' },
        mode: { type: 'string', enum: ['text', 'html', 'links'], default: 'text' },
        maxChars: { type: 'number', default: 8000, description: 'Truncate the result to this many characters.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          mode: { type: 'string' },
          truncated: { type: 'boolean' },
          content: { type: 'string' },
        },
        required: ['content'],
      },
      render: renderJson,
    },
    execute: async (args = {}) =>
      bridge.request('read', {
        tabId: args.tabId,
        selector: args.selector,
        mode: args.mode ?? 'text',
        maxChars: Math.max(200, Math.min(60000, args.maxChars ?? 8000)),
      }),
  })

  register({
    name: 'browser_query',
    description:
      'Query elements by CSS selector and return structured rows (text, tag, href, rect, form value). This is the precise alternative to guessing coordinates from a screenshot.',
    parameters: {
      type: 'object',
      properties: {
        selector: { ...SELECTOR },
        tabId: TAB_ID,
        limit: { type: 'number', default: 20, description: 'Maximum rows to return (1-200).' },
      },
      required: ['selector'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          selector: { type: 'string' },
          count: { type: 'number' },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['selector', 'count', 'rows'],
      },
      render: renderJson,
    },
    execute: async (args = {}) =>
      bridge.request('query', {
        selector: args.selector,
        tabId: args.tabId,
        limit: Math.max(1, Math.min(200, args.limit ?? 20)),
      }),
  })

  register({
    name: 'browser_click',
    description:
      'Click an element inside the page by CSS selector, by exact link text, or at viewport coordinates. Prefer a selector or text: it cannot miss because of a moved layout, unlike a screenshot-derived coordinate.',
    parameters: {
      type: 'object',
      properties: {
        selector: { ...SELECTOR },
        text: { type: 'string', description: 'Exact or substring text of the element to click, e.g. "五毒克星".' },
        tabId: TAB_ID,
        x: { type: 'number', description: 'Viewport x inside the page, used only when neither selector nor text is given.' },
        y: { type: 'number', description: 'Viewport y inside the page.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          clicked: { type: 'boolean' },
          matched: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['clicked'],
      },
      render: renderJson,
    },
    execute: async (args = {}) =>
      bridge.request('click', {
        selector: args.selector,
        text: args.text,
        tabId: args.tabId,
        x: args.x,
        y: args.y,
      }),
  })

  register({
    name: 'browser_type',
    description:
      'Type into a field inside the page by CSS selector (search boxes, textareas). Dispatches the input/change events frameworks listen for, so React/Vue state updates too.',
    parameters: {
      type: 'object',
      properties: {
        selector: { ...SELECTOR },
        text: { type: 'string', description: 'Text to put into the field.' },
        tabId: TAB_ID,
        submit: { type: 'boolean', default: false, description: 'Press Enter after typing.' },
      },
      required: ['selector', 'text'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          typed: { type: 'boolean' },
          submitted: { type: 'boolean' },
          value: { type: 'string' },
        },
        required: ['typed'],
      },
      render: renderJson,
    },
    execute: async (args = {}) =>
      bridge.request('type', {
        selector: args.selector,
        text: args.text,
        tabId: args.tabId,
        submit: args.submit === true,
      }),
  })

  register({
    name: 'browser_navigate',
    description: 'Open a URL in a tab through the paired extension (keeps the user\'s cookies and logins). Returns the resulting url and title.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        tabId: TAB_ID,
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' }, tabId: { type: 'number' } },
        required: ['url'],
      },
      render: renderJson,
    },
    execute: async (args = {}) => bridge.request('navigate', { url: args.url, tabId: args.tabId }),
  })

  register({
    name: 'browser_screenshot',
    description:
      'Capture the visible area of one Chrome tab through the extension (no desktop capture, no permission dialog) and return it as an image. Use it when the DOM is not enough: canvas, video frames, charts, or a visual layout question.',
    parameters: {
      type: 'object',
      properties: { tabId: TAB_ID },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { url: { type: 'string' }, title: { type: 'string' }, width: { type: 'number' }, height: { type: 'number' } },
        required: ['width', 'height'],
      },
      render(args, value) {
        const blocks = []
        const data = typeof value?.image === 'string' ? value.image : ''
        const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : ''
        if (base64 && value?.attachment) {
          blocks.push({ type: 'image', attachment: value.attachment })
        }
        blocks.push({
          type: 'text',
          text: JSON.stringify(
            { url: value.url, title: value.title, width: value.width, height: value.height, note: value.note },
            null,
            2,
          ),
        })
        return blocks
      },
    },
    async execute(args = {}) {
      const shot = await bridge.request('screenshot', { tabId: args.tabId }, 30000)
      const data = typeof shot?.image === 'string' ? shot.image : ''
      const base64 = data.startsWith('data:') ? data.slice(data.indexOf(',') + 1) : ''
      let attachment
      if (base64) {
        try {
          // `inject` is resolved once at load time, so a host that was already
          // running when this plugin gained the dependency still needs the
          // optional lookup to reach the service.
          const service =
            context.attachments ??
            (typeof context.get === 'function' ? context.get('attachments') : undefined)
          const save = service?.saveImage
          if (typeof save === 'function') {
            attachment = await save.call(service, {
              data: Buffer.from(base64, 'base64'),
              mediaType: 'image/png',
              name: `chrome-tab-${Date.now()}.png`,
            })
          }
        } catch (error) {
          console.error('[browser-bridge] could not store the screenshot:', error)
        }
      }
      // Tool results must survive a JSON round trip unchanged, so never leave an
      // `undefined` property behind: it disappears on stringify and the gateway
      // rejects the value as "not lossless JSON".
      const value = {
        url: String(shot?.url ?? ''),
        title: String(shot?.title ?? ''),
        width: Number(shot?.width ?? 0),
        height: Number(shot?.height ?? 0),
        image: attachment ? 'stored' : data ? 'unstored' : '',
        note: attachment
          ? 'captured from the tab viewport through the extension'
          : data
            ? 'captured, but no attachment service was available to store it'
            : 'the extension did not return an image',
      }
      if (attachment) {
        value.attachment = {
          attachmentId: String(attachment.attachmentId),
          mediaType: String(attachment.mediaType),
          bytes: Number(attachment.bytes ?? 0),
          width: Number(attachment.width ?? 0),
          height: Number(attachment.height ?? 0),
          ...(attachment.name ? { name: String(attachment.name) } : {}),
        }
      }
      return value
    },
  })
}
