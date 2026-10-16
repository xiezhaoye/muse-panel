import { app, BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig, updateConfig } from './config'
import type { Rules, Usage } from '../shared/types'

// 额度在 muse.ai 的 设置 → 使用情况 里，没有可直接调用的接口（数据走加密长连接）。
// 只在用户手动刷新时读取：开一个同 partition 的离屏窗口（宽屏布局，带同一登录态），
// 打开设置读进度条，然后销毁。不碰用户正在看的页面，也不做任何定时抓取。
//
// 所有刷新请求进同一个队列，同一时间只跑 1 个：一次约 7 秒、内存峰值约 250MB，
// 串行可以避免多个账号同时刷新时瞬间占用 1GB 内存、占满 CPU。

export type UsageJobState = 'queued' | 'running' | 'idle'
export interface RefreshResult {
  usage: Usage | null
  error: string | null
  ms: number
}

const queue: string[] = []
const pending = new Map<string, Promise<RefreshResult>>()
const resolvers = new Map<string, (r: RefreshResult) => void>()
let runningId: string | null = null
let onState: (id: string, state: UsageJobState) => void = () => {}

export function initUsageQueue(cb: (id: string, state: UsageJobState) => void): void {
  onState = cb
}

/** 当前队列状态（界面重载后用来恢复显示） */
export function usageQueueState(): Record<string, UsageJobState> {
  const s: Record<string, UsageJobState> = {}
  for (const id of queue) s[id] = 'queued'
  if (runningId) s[runningId] = 'running'
  return s
}

/** 加入刷新队列；同一个账号已在队列或正在刷新时，直接复用那一次的结果 */
export function refreshUsage(accountId: string): Promise<RefreshResult> {
  const existing = pending.get(accountId)
  if (existing) return existing
  const p = new Promise<RefreshResult>((resolve) => resolvers.set(accountId, resolve))
  pending.set(accountId, p)
  queue.push(accountId)
  onState(accountId, 'queued')
  void pump()
  return p
}

async function pump(): Promise<void> {
  if (runningId) return
  const id = queue.shift()
  if (!id) return
  runningId = id
  onState(id, 'running')
  const r = await readOnce(id)
  runningId = null
  pending.delete(id)
  resolvers.get(id)?.(r)
  resolvers.delete(id)
  onState(id, 'idle')
  void pump()
}

function log(entry: Record<string, unknown>): void {
  try {
    const dir = app.getPath('logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'usage.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
  } catch {}
}

function scrapeScript(r: Rules['usage']): string {
  return `(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(300); } return null; };
    const ready = await waitFor(() => document.querySelector('textarea') || document.querySelector(${JSON.stringify(r.openMenuButton)}), 30000);
    if (!ready) return { error: /登录|Log in/.test(document.body?.innerText || '') ? '未登录' : '页面未加载' };
    const findTitle = () => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(r.sectionTitle)});
    // ⌘, 打开设置（宽屏布局下设置一打开就是「通用」页，能直接看到「使用情况」）。
    // 它是开关，只在没打开时才发；页面刚加载时快捷键可能还没注册，所以隔 3 秒重试，最多 6 次。
    await sleep(2500);
    let title = null;
    for (let i = 0; i < 6 && !title; i++) {
      if (!findTitle()) document.dispatchEvent(new KeyboardEvent('keydown', { key: ',', code: 'Comma', metaKey: true, bubbles: true }));
      title = await waitFor(findTitle, 3000);
    }
    if (!title) return { error: '打不开设置' };
    const box = await waitFor(() => { let el = title; for (let i = 0; i < 6 && el; i++) { el = el.parentElement; if (el && el.querySelectorAll(${JSON.stringify(r.progressBar)}).length) return el; } return null; }, 15000);
    if (!box) return { error: '用量数据未加载' };
    await sleep(300);
    const bars = [...box.querySelectorAll(${JSON.stringify(r.progressBar)})].map((b) => Number(b.getAttribute('aria-valuenow')));
    return { raw: (box.innerText || box.textContent).replace(/\\s+/g, ' ').trim(), bars };
  })()`
}

export function parseUsage(raw: string, bars: number[] = []): Pick<Usage, 'weeklyPercent' | 'extraPercent' | 'resetText' | 'extraText'> {
  const pcts = [...raw.matchAll(/已使用\s*(\d+(?:\.\d+)?)\s*%/g)].map((m) => Number(m[1]))
  const reset = raw.match(/将在\s*(.+?)\s*重置/)
  const extra = raw.match(/剩余\s*([^）)]+)/)
  const num = (v: number | undefined): number | null => (v != null && Number.isFinite(v) ? v : null)
  return {
    weeklyPercent: num(bars[0]) ?? num(pcts[0]),
    extraPercent: num(bars[1]) ?? num(pcts[1]),
    resetText: reset ? reset[1] : null,
    extraText: extra ? extra[1].trim() : null
  }
}

/** 把底层错误转成简短的中文说明（完整错误写进日志） */
function friendly(err: string): string {
  const net = err.match(/ERR_[A-Z_]+/)
  if (net) return '网络错误'
  if (/超时/.test(err)) return '超时'
  return err.length > 20 ? `${err.slice(0, 20)}…` : err
}

async function readOnce(accountId: string): Promise<RefreshResult> {
  const t0 = Date.now()
  let r = await readAttempt(accountId)
  // 网络瞬断（如代理抖动）自动重试一次
  if (r.error && /ERR_[A-Z_]+/.test(r.error)) {
    log({ account: getConfig().accounts[accountId]?.name, retry: true, error: r.error })
    await new Promise((res) => setTimeout(res, 2000))
    r = await readAttempt(accountId)
  }
  const acc = getConfig().accounts[accountId]
  updateConfig((c) => {
    const a = c.accounts[accountId]
    if (!a) return
    if (r.raw) a.usage = { ...parseUsage(r.raw, r.bars), raw: r.raw, updatedAt: Date.now(), error: null }
    else a.usage = { ...a.usage, error: friendly(r.error ?? '未知错误') } // 失败不覆盖旧值
  })
  const ms = Date.now() - t0
  log({ account: acc?.name, ok: !!r.raw, error: r.error ?? null, ms })
  return { usage: getConfig().accounts[accountId]?.usage ?? null, error: r.raw ? null : friendly(r.error ?? '未知错误'), ms }
}

async function readAttempt(accountId: string): Promise<{ raw?: string; bars?: number[]; error?: string }> {
  const cfg = getConfig()
  if (!cfg.accounts[accountId]) return { error: '账号不存在' }
  // 离屏渲染 + 每秒 1 帧：页面照常渲染（设置弹窗需要渲染才会打开），但只在内存里画、不走 GPU 合成
  const w = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      offscreen: true,
      partition: `persist:muse-${accountId}`,
      backgroundThrottling: false,
      sandbox: true,
      spellcheck: false
    }
  })
  w.webContents.setFrameRate(1)
  w.webContents.setAudioMuted(true)
  try {
    await w.loadURL(cfg.homeUrl)
    return await Promise.race([
      w.webContents.executeJavaScript(scrapeScript(cfg.rules.usage)),
      new Promise<{ error: string }>((res) => setTimeout(() => res({ error: '超时' }), 60000))
    ])
  } catch (e) {
    return { error: String(e) }
  } finally {
    if (!w.isDestroyed()) w.destroy()
  }
}
