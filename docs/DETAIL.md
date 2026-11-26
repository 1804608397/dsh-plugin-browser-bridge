# Browser Bridge

Read what a Chrome page actually says — and click the right thing — without screenshotting the desktop.

The plugin opens one loopback WebSocket (`ws://127.0.0.1:17871/ws`) and waits for the bundled Chrome
extension to dial in with a pairing token. Once paired, the model talks to the page through the extension:

| Tool | What it does |
| --- | --- |
| `browser_status` | Connection state, port, and the token path to paste into the extension |
| `browser_tabs` | List open tabs (`id`, `title`, `url`, `active`) |
| `browser_read` | Page text / HTML / links, optionally scoped to one CSS selector |
| `browser_query` | Elements matching a selector: text, tag, `href`, form value, on-screen rect |
| `browser_click` | Click by selector, by exact text, or by viewport point |
| `browser_type` | Type into a field (input/change events, so React/Vue state updates) and optionally press Enter |
| `browser_navigate` | Open a URL in a tab, keeping the user's cookies and logins |
| `browser_screenshot` | Capture the tab viewport as an image — no desktop capture, no permission dialog (tab must be visible, non-minimized window) |

## Why a bridge instead of the DevTools port

`--remote-debugging-port` works, but while it is open **any** process on the machine can drive the
browser and read every logged-in session. Here the only listener is a loopback WebSocket that requires
a token stored as `~/.config/dsh-browser-bridge/token` (mode `0600`), and the extension implements a
fixed command list — it cannot be asked to run arbitrary CDP commands.

## Set it up

1. Enable this plugin in the plugin panel (it registers the `browser_*` tools).
2. Ask the model to run `browser_status`; it creates the token and prints its path, e.g.
   `~/.config/dsh-browser-bridge/token`.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and pick
   `extension/` inside this package. Chrome's folder picker opens on *Recent*; press `Ctrl+L`, type a
   path it can reach (for example a copy under `~/Downloads`), then click **Select**.
4. Open the extension's **Options**, paste the token, click **保存并重连**. The badge turns connected.

### Pairing without pasting the token

If `~/.config/dsh-browser-bridge/pair-allow` exists, the extension fetches the token from
`GET http://127.0.0.1:17871/pair` on its own and the file is deleted right after. Without the marker the
endpoint answers `426 Upgrade Required`, so a stray process cannot harvest the token.

### Keeping the connection alive

Chrome suspends an idle MV3 service worker after ~30 s, which silently drops the WebSocket. Two
heartbeats prevent it: the extension sends `{type:"ping"}` every 20 s, and the host does the same; the
extension reconnects with a back-off capped at 3 s and the host waits up to 5 s for it before a tool
call gives up. After editing `extension/*.js` you must press ↻ on the extension card — reloading the
DSH plugin alone does not reload the extension.

### What the extension cannot see

`chrome://` pages, the Web Store, and other extensions' pages refuse script injection
(`Cannot access a chrome:// URL`). `browser_screenshot` also needs the tab to be the visible one in a
window that is not minimized; it gives up after 8 s instead of hanging.

## When to still use a screenshot

Structured extraction cannot see: `<canvas>` rendering, video frames, cross-origin iframes it has no
script access to, and any page whose meaning is purely visual (a chart, a game, a layout question).
For those, `browser_screenshot` (tab-only capture) or the Linux Computer Use bundle's
`mcp__linux__screenshot` (whole desktop) remain the right tools — nothing was removed.

## Security notes

- Listener binds `127.0.0.1` only; the token is required on every connection.
- The extension runs with `<all_urls>` so it can read any page the user opens; it sends page content
  only to the local DeepSeek Harness process, never to a remote host.
- Nothing is captured unless a `browser_*` tool is called.
- Rotate the token by deleting `~/.config/dsh-browser-bridge/token` and reloading the plugin; the
  extension needs the new token pasted again.
