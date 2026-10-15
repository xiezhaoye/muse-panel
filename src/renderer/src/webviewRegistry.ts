import type { AccountStatus } from '../../shared/types'

// accountId → webview 的唯一映射。所有跨账号操作都走这里。

export interface WebviewEl extends HTMLElement {
  send(channel: string, ...args: unknown[]): void
  loadURL(url: string): Promise<void>
  reload(): void
  getWebContentsId(): number
}

interface Entry {
  el: WebviewEl
  ready: boolean
  status: AccountStatus | null
}

const entries = new Map<string, Entry>()
const waiters = new Map<string, (r: { ok: boolean; error?: string }) => void>()
const statusListeners = new Set<(id: string, s: AccountStatus) => void>()
let seq = 0

export const registry = {
  register(id: string, el: WebviewEl): void {
    entries.set(id, { el, ready: false, status: null })
  },
  unregister(id: string, el: WebviewEl): void {
    if (entries.get(id)?.el === el) entries.delete(id)
  },
  get(id: string): Entry | undefined {
    return entries.get(id)
  },
  ids(): string[] {
    return [...entries.keys()]
  },
  setReady(id: string, ready: boolean): void {
    const e = entries.get(id)
    if (e) e.ready = ready
  },
  setStatus(id: string, s: AccountStatus): void {
    const e = entries.get(id)
    if (!e) return
    e.status = s
    for (const l of statusListeners) l(id, s)
  },
  onStatus(fn: (id: string, s: AccountStatus) => void): () => void {
    statusListeners.add(fn)
    return () => statusListeners.delete(fn)
  },
  broadcast(channel: string, ...args: unknown[]): void {
    for (const e of entries.values()) if (e.ready) e.el.send(channel, ...args)
  },
  /** 往某账号输入框写入文本；send=true 时点发送。返回 webview 内的执行结果 */
  inject(id: string, text: string, send: boolean, append = false, timeoutMs = 25_000): Promise<{ ok: boolean; error?: string }> {
    const e = entries.get(id)
    if (!e || !e.ready) return Promise.resolve({ ok: false, error: '该账号页面未就绪' })
    const jobId = `j${Date.now()}-${++seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(jobId)
        resolve({ ok: false, error: '注入超时' })
      }, timeoutMs)
      waiters.set(jobId, (r) => {
        clearTimeout(timer)
        resolve(r)
      })
      e.el.send('muse:inject', { id: jobId, text, send, append })
    })
  },
  resolveInjected(r: { id: string; ok: boolean; error?: string }): void {
    const w = waiters.get(r.id)
    if (w) {
      waiters.delete(r.id)
      w(r)
    }
  }
}
