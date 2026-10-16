import { ipcRenderer } from 'electron'
import type { AccountStatus, Rules } from '../shared/types'

// 注入到每个 muse.ai webview（隔离世界，沙箱）。职责：
// 1. 按配置做入口链接排版（隐藏/改样式）
// 2. 刮削状态（登录、生成中、连接、最新动态、最后一条回复）上报给面板
// 3. 接收面板指令：往输入框写入文本，必要时点发送
// 所有选择器来自面板配置 rules，不写死。

let rules: Rules | null = null
let lastSent = ''
let lastSentAt = 0
let lastAssistantText = ''
let lastAssistantChangeAt = 0

const $ = <T extends Element = HTMLElement>(sel: string): T | null => {
  try {
    return document.querySelector<T>(sel)
  } catch {
    return null
  }
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function applyLayout(): void {
  if (!rules) return
  const css = rules.layout
    .map((r) => (r.action === 'hide' ? `${r.selector}{display:none !important}` : `${r.selector}{${r.css ?? ''}}`))
    .join('\n')
  let style = document.getElementById('muse-panel-layout') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'muse-panel-layout'
    ;(document.head || document.documentElement).appendChild(style)
  }
  if (style.textContent !== css) style.textContent = css
}

function visible(el: Element | null): boolean {
  if (!el) return false
  const r = (el as HTMLElement).getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

function scrape(): AccountStatus {
  const r = rules!
  const input = $<HTMLTextAreaElement>(r.chat.input)
  const assistants = document.querySelectorAll(r.chat.assistantMessage)
  const last = assistants[assistants.length - 1]
  const lastText = (last?.textContent ?? '').trim()
  if (lastText !== lastAssistantText) {
    lastAssistantText = lastText
    lastAssistantChangeAt = Date.now()
  }
  // 生成中：出现"停止"按钮，或最后一条回复在 2.5 秒内还在变化
  const stop = $(r.chat.stopButton)
  const busy = visible(stop) || (lastAssistantChangeAt > 0 && Date.now() - lastAssistantChangeAt < 2500 && assistants.length > 0)

  // 右侧状态面板：被排版规则隐藏时 DOM 仍在，用 textContent 读
  let connected: boolean | null = null
  let lastActivity: AccountStatus['lastActivity'] = null
  const panel = $(r.status.panel)
  if (panel) {
    const leaves = [...panel.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent?.trim())
    const connRe = new RegExp(r.status.connectedPattern)
    if (leaves.some((e) => connRe.test(e.textContent!.trim()))) connected = true
    else if (leaves.some((e) => /^(未连接|连接中|离线|Disconnected|Connecting)/.test(e.textContent!.trim()))) connected = false
    const timeRe = new RegExp(r.status.activityTimePattern)
    const timeLeaf = leaves.find((e) => timeRe.test(e.textContent!.trim()))
    if (timeLeaf) {
      // 动态条目：标题 / 描述 / 时间 三段，取同一条目里的第一段作标题
      let card: Element | null = timeLeaf.parentElement
      for (let i = 0; i < 3 && card && card.querySelectorAll('*').length < 3; i++) card = card.parentElement
      const title = card
        ? [...card.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() && e !== timeLeaf)
        : null
      lastActivity = { title: (title?.textContent ?? '').trim().slice(0, 60), time: timeLeaf.textContent!.trim() }
    }
  }

  // 只有找不到输入框时才读页面文字判断是否在登录页（innerText 会触发排版，尽量少用）
  const loggedIn = input ? true : /登录|Log in|Sign in|继续使用/.test((document.body?.textContent ?? '').slice(0, 4000)) ? false : null

  return {
    connected,
    busy,
    loggedIn,
    path: location.pathname,
    lastActivity,
    lastAssistant: lastText ? lastText.slice(-120) : null,
    draft: !!input?.value.trim(),
  }
}

function pauseLoopingVideos(): void {
  if (!rules?.perf?.pauseLoopingVideos) return
  document.querySelectorAll('video').forEach((v) => {
    if (v.loop && !v.paused) v.pause()
  })
}

function report(force = false): void {
  if (!rules || !document.body) return
  applyLayout()
  pauseLoopingVideos()
  const s = scrape()
  const json = JSON.stringify(s)
  if (force || json !== lastSent || Date.now() - lastSentAt > 10_000) {
    lastSent = json
    lastSentAt = Date.now()
    ipcRenderer.sendToHost('muse:status', s)
  }
}

function setNativeValue(el: HTMLTextAreaElement, value: string): void {
  // 隔离世界里的原生 setter 不经过 React 的值追踪器，配合 input 事件，React 会把它当作用户输入
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  setter.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function inject(job: { id: string; text: string; send: boolean; append?: boolean }): Promise<void> {
  const reply = (ok: boolean, error?: string): void => ipcRenderer.sendToHost('muse:injected', { id: job.id, ok, error })
  if (!rules) return reply(false, '规则未就绪')
  const deadline = Date.now() + 15_000
  let input: HTMLTextAreaElement | null = null
  while (Date.now() < deadline && !(input = $<HTMLTextAreaElement>(rules.chat.input))) await sleep(300)
  if (!input) return reply(false, '找不到输入框（未登录或页面未加载）')

  const existing = input.value
  if (job.send && existing.trim()) return reply(false, '输入框里有未发送的草稿')
  const value = job.append && existing.trim() ? `${existing}\n${job.text}` : job.text
  input.focus()
  setNativeValue(input, value)
  if (!job.send) return reply(true)

  let btn: HTMLButtonElement | null = null
  const t0 = Date.now()
  while (Date.now() - t0 < 4000) {
    btn = $<HTMLButtonElement>(rules.chat.sendButton)
    if (btn && !btn.disabled) break
    await sleep(150)
  }
  if (!btn || btn.disabled) {
    setNativeValue(input, existing)
    return reply(false, '发送按钮不可用')
  }
  const userCount = document.querySelectorAll(rules.chat.userMessage).length
  btn.click()
  // 确认已发出：输入框清空，或多出一条用户消息
  const t1 = Date.now()
  while (Date.now() - t1 < 6000) {
    const cur = $<HTMLTextAreaElement>(rules.chat.input)
    if (!cur?.value.trim() || document.querySelectorAll(rules.chat.userMessage).length > userCount) {
      report(true)
      return reply(true)
    }
    await sleep(200)
  }
  reply(false, '点击发送后未确认消息已发出')
}

// ---------- 额度：在已打开的页面里静默读取（方案 A） ----------
// 用 ⌘, 打开设置 → 读「使用情况」的进度条 → Esc 关闭。期间弹窗不可见、不可点；结束后还原输入焦点。
// 用户自己正开着设置时，直接读，不去开关它。
const trustedKeyWaiters = new Map<string, () => void>()
ipcRenderer.on('muse:trustedKeyDone', (_e, id: string) => {
  trustedKeyWaiters.get(id)?.()
  trustedKeyWaiters.delete(id)
})
function trustedKey(key: string, modifiers: string[]): Promise<void> {
  // 合成按键不生效时，请面板通过主进程发一次真实按键
  const id = `k${Date.now()}${Math.random()}`
  return new Promise((resolve) => {
    trustedKeyWaiters.set(id, resolve)
    ipcRenderer.sendToHost('muse:trustedKey', { id, key, modifiers })
    setTimeout(resolve, 1500)
  })
}

async function readUsage(job: { id: string }): Promise<void> {
  const reply = (r: { ok: boolean; raw?: string; bars?: number[]; error?: string; diag?: Record<string, unknown> }): void =>
    ipcRenderer.sendToHost('muse:usage', { id: job.id, ...r })
  if (!rules) return reply({ ok: false, error: '规则未就绪' })
  const u = rules.usage
  const findTitle = (): Element | undefined =>
    [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === u.sectionTitle)
  const waitFor = async <T>(fn: () => T | null | undefined, ms: number): Promise<T | null> => {
    const t = Date.now()
    while (Date.now() - t < ms) {
      const v = fn()
      if (v) return v
      await sleep(100)
    }
    return null
  }
  const readBox = async (title: Element): Promise<{ raw: string; bars: number[] } | null> => {
    const box = await waitFor(() => {
      let el: Element | null = title
      for (let i = 0; i < 6 && el; i++) {
        el = el.parentElement
        if (el && el.querySelectorAll(u.progressBar).length) return el
      }
      return null
    }, 8000)
    if (!box) return null
    await sleep(200)
    const bars = [...box.querySelectorAll(u.progressBar)].map((b) => Number(b.getAttribute('aria-valuenow')))
    return { raw: (box.textContent ?? '').replace(/\s+/g, ' ').trim(), bars }
  }

  // 用户自己开着设置：直接读
  const already = findTitle()
  if (already) {
    const r = await readBox(already)
    return reply(r ? { ok: true, ...r } : { ok: false, error: '额度数据未加载' })
  }

  // 静默模式：这期间新加到页面上的浮层（弹窗、遮罩）一律透明、不可点
  const prevFocus = document.activeElement as HTMLElement | null
  const root = document.documentElement
  root.setAttribute('data-muse-silent', '1')
  let style = document.getElementById('muse-panel-silent') as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = 'muse-panel-silent'
    style.textContent =
      'html[data-muse-silent] [role="dialog"], html[data-muse-silent] [data-muse-silent-node] { opacity: 0 !important; pointer-events: none !important; }'
    ;(document.head || root).appendChild(style)
  }
  const marked = new Set<HTMLElement>()
  const mo = new MutationObserver((ms) => {
    for (const m of ms)
      m.addedNodes.forEach((n) => {
        if (n instanceof HTMLElement) {
          n.setAttribute('data-muse-silent-node', '1')
          marked.add(n)
        }
      })
  })
  mo.observe(document.body, { childList: true })
  let opened = false
  const t0 = Date.now()
  const diag: Record<string, unknown> = { pageFocusBefore: document.hasFocus(), visibility: document.visibilityState }
  const cleanup = async (): Promise<void> => {
    // 把（可能已打开的）设置静默关掉，再恢复可见和输入焦点
    if (findTitle()) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }))
      if (!(await waitFor(() => !findTitle(), 1000))) {
        await trustedKey('Escape', [])
        await waitFor(() => !findTitle(), 1500)
      }
    }
    mo.disconnect()
    await sleep(350) // 等关闭动画结束再恢复可见，避免闪一下
    root.removeAttribute('data-muse-silent')
    marked.forEach((n) => n.removeAttribute('data-muse-silent-node'))
    if (prevFocus && prevFocus !== document.body && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true })
  }
  try {
    // 只发一次真实 ⌘,（合成按键在页面没焦点时无效；重复发送还可能把刚打开的设置又关掉）
    await trustedKey(',', ['meta'])
    diag.keySentMs = Date.now() - t0
    diag.pageFocusAfterKey = document.hasFocus()
    const title = (await waitFor(findTitle, 4000)) ?? null
    if (!title) {
      diag.result = 'not-opened'
      diag.totalMs = Date.now() - t0
      reply({ ok: false, error: '打不开设置', diag })
      // 按键可能"迟到"：继续保持静默再观察 6 秒，迟到打开的设置也静默关掉，绝不让它露出来
      const late = await waitFor(findTitle, 6000)
      ipcRenderer.sendToHost('muse:usageLate', { id: job.id, lateOpenMs: late ? Date.now() - t0 : null })
      await cleanup()
      return
    }
    opened = true
    diag.openMs = Date.now() - t0
    const r = await readBox(title)
    diag.readMs = Date.now() - t0
    diag.result = r ? 'ok' : 'no-data'
    diag.totalMs = Date.now() - t0
    reply(r ? { ok: true, ...r, diag } : { ok: false, error: '额度数据未加载', diag })
    await cleanup()
  } catch (e) {
    diag.result = 'exception'
    reply({ ok: false, error: String(e), diag })
    await cleanup()
  }
  void opened
}

ipcRenderer.on('muse:rules', (_e, r: Rules) => {
  rules = r
  report(true)
})
// 循环视频一开始播放就暂停（头像重渲染时会重新 autoplay）
document.addEventListener(
  'play',
  (e) => {
    const v = e.target as HTMLVideoElement
    if (rules?.perf?.pauseLoopingVideos && v instanceof HTMLVideoElement && v.loop) v.pause()
  },
  true
)
ipcRenderer.on('muse:inject', (_e, job) => void inject(job))
ipcRenderer.on('muse:readUsage', (_e, job) => void readUsage(job))
ipcRenderer.on('muse:report', () => report(true))

// 3 秒一次；页面隐藏（不在当前组）时 Chromium 会自动再降频
setInterval(() => report(), 3000)
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.sendToHost('muse:ready')
  new MutationObserver(() => {
    // 页面重渲染时尽快把排版样式补回去（节流）
    if (!rules) return
    if (!document.getElementById('muse-panel-layout')) applyLayout()
  }).observe(document.documentElement, { childList: true, subtree: false })
})
