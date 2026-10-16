import { BrowserWindow } from 'electron'
import { getConfig, updateConfig } from './config'
import type { Rules, Usage } from '../shared/types'

// 用量（"余额"）在 muse.ai 的 设置 → 使用情况 里，没有可直接调用的接口。
// 做法：开一个与账号同 partition 的隐藏窗口（带同一登录态），点开设置读文本，然后销毁。

const running = new Set<string>()
let onUpdated: (id: string) => void = () => {}

function scrapeScript(r: Rules['usage']): string {
  return `(async () => {
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    const waitFor = async (fn, ms) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await sleep(300); } return null; };
    const ready = await waitFor(() => document.querySelector('textarea') || document.querySelector(${JSON.stringify(r.openMenuButton)}), 30000);
    if (!ready) return { error: /登录|Log in/.test(document.body?.innerText || '') ? '未登录' : '页面未加载' };
    const findTitle = () => [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent.trim() === ${JSON.stringify(r.sectionTitle)});
    // ⌘, 打开设置：与页面布局无关（宽屏设置在左侧 dock，窄屏在右下角"更多"里）。
    // 它是开关，只在没打开时才发；页面刚加载时快捷键可能还没注册，所以隔 3 秒重试，最多 6 次。
    // （设置/更多按钮的菜单只响应真实鼠标事件，合成点击打不开，所以不走按钮。）
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

export async function refreshUsage(accountId: string): Promise<Usage | null> {
  const cfg = getConfig()
  const acc = cfg.accounts[accountId]
  if (!acc || running.has(accountId)) return acc?.usage ?? null
  running.add(accountId)
  // 离屏渲染 + 每秒 1 帧：页面照常渲染（设置弹窗需要渲染才会打开），但只在内存里画、不走 GPU 合成，
  // 避免反复开关隐藏窗口让 GPU 进程内存越积越多
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
  let result: { raw?: string; bars?: number[]; error?: string }
  try {
    await w.loadURL(cfg.homeUrl)
    result = await Promise.race([
      w.webContents.executeJavaScript(scrapeScript(cfg.rules.usage)),
      new Promise<{ error: string }>((res) => setTimeout(() => res({ error: '超时' }), 60000))
    ])
  } catch (e) {
    result = { error: String(e) }
  } finally {
    if (!w.isDestroyed()) w.destroy()
    running.delete(accountId)
  }
  updateConfig((c) => {
    const a = c.accounts[accountId]
    if (!a) return
    if (result.raw) a.usage = { ...parseUsage(result.raw, result.bars), raw: result.raw, updatedAt: Date.now(), error: null }
    else a.usage = { ...a.usage, error: result.error ?? '未知错误' } // 失败不覆盖旧值
  })
  onUpdated(accountId)
  return getConfig().accounts[accountId]?.usage ?? null
}

export function startUsageScheduler(cb: (id: string) => void): void {
  onUpdated = cb
  const kick = (): void => {
    const cfg = getConfig()
    const ids = Object.values(cfg.accounts)
      .filter((a) => !a.sleeping)
      .map((a) => a.id)
    // 错峰：每个账号间隔 5~15 秒随机，避免同一时刻一起请求
    let delay = 8000
    for (const id of ids) {
      setTimeout(() => refreshUsage(id), delay)
      delay += 5000 + Math.random() * 10000
    }
  }
  kick()
  const loop = (): void => {
    const min = Math.max(5, getConfig().rules.usage.intervalMin)
    setTimeout(() => {
      kick()
      loop()
    }, min * 60_000)
  }
  loop()
}
