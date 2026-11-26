const tokenInput = document.getElementById('token')
const portInput = document.getElementById('port')
const statusBox = document.getElementById('status')

async function paint() {
  const stored = await chrome.storage.local.get({ port: 17871, token: '', status: null })
  portInput.value = String(stored.port)
  if (stored.token) tokenInput.value = stored.token
  const status = stored.status ?? { connected: false }
  const lines = [status.connected ? '✅ 已连接 DeepSeek Harness' : '❌ 未连接']
  if (status.lastConnectedAt) lines.push(`最近连接：${new Date(status.lastConnectedAt).toLocaleString()}`)
  if (status.lastError) lines.push(`错误：${status.lastError}`)
  statusBox.textContent = lines.join('\n')
}

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim()
  const port = Number(portInput.value) || 17871
  await chrome.storage.local.set({ token, port })
  statusBox.textContent = '已保存，正在重连…'
  setTimeout(paint, 900)
})

document.getElementById('check').addEventListener('click', async () => {
  const token = tokenInput.value.trim()
  const port = Number(portInput.value) || 17871
  if (!token) {
    statusBox.textContent = '❌ 先填入配对令牌'
    return
  }
  statusBox.textContent = '正在测试…'
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(token)}`)
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 5000)
      ws.addEventListener('open', () => {
        clearTimeout(timer)
        resolve('open')
        ws.close()
      })
      ws.addEventListener('error', () => {
        clearTimeout(timer)
        resolve('error')
      })
    })
    statusBox.textContent =
      outcome === 'open'
        ? '✅ 连接成功，令牌有效'
        : outcome === 'timeout'
          ? '⚠️ 超时：DeepSeek Harness 没在跑，或端口不是这个'
          : '❌ 被拒绝：令牌不对，或 Browser Bridge 插件未启用'
  } catch (error) {
    statusBox.textContent = `❌ ${error.message}`
  }
})

chrome.storage.onChanged.addListener((changes) => {
  if (changes.status) paint()
})
paint()
setInterval(paint, 3000)

// Opening this page with #reload makes Chrome re-read the extension from disk,
// which is how a changed background.js gets picked up without the toolbar menu.
if (location.hash === '#reload') {
  chrome.runtime.reload()
}
