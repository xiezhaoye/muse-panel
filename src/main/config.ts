import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppConfig, DEFAULT_RULES, defaultConfig, emptyUsage, TAB_COLORS } from '../shared/types'

// 所有设置的唯一落盘位置：~/Library/Application Support/Muse Panel/config.json
// 登录态不在这里，由每个 persist:muse-<id> partition 自己落盘。

let current: AppConfig
let saveTimer: NodeJS.Timeout | null = null
const listeners = new Set<(c: AppConfig) => void>()

export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

function normalize(raw: Partial<AppConfig>): AppConfig {
  const base = defaultConfig()
  const cfg: AppConfig = {
    ...base,
    ...raw,
    window: { ...base.window, ...(raw.window ?? {}) },
    rules: {
      chat: { ...DEFAULT_RULES.chat, ...(raw.rules?.chat ?? {}) },
      status: { ...DEFAULT_RULES.status, ...(raw.rules?.status ?? {}) },
      usage: { ...DEFAULT_RULES.usage, ...(raw.rules?.usage ?? {}) },
      layout: raw.rules?.layout ?? DEFAULT_RULES.layout,
      perf: { ...DEFAULT_RULES.perf, ...(raw.rules?.perf ?? {}) }
    },
    tabs: raw.tabs?.length ? raw.tabs : base.tabs,
    accounts: raw.accounts ?? {}
  }
  // 迁移：旧版默认每 30 分钟抓一次用量，改为 60 分钟（用户手动改过的值保留）
  if (raw.rules?.usage?.intervalMin === 30) cfg.rules.usage.intervalMin = DEFAULT_RULES.usage.intervalMin
  // 迁移：旧版默认选择器只认左侧 dock 的"设置"，窄屏下入口是右下角"更多"
  if (cfg.rules.usage.openMenuButton === 'button[aria-label="设置"]') cfg.rules.usage.openMenuButton = DEFAULT_RULES.usage.openMenuButton
  for (const a of Object.values(cfg.accounts)) {
    a.usage = { ...emptyUsage(), ...(a.usage ?? {}) }
    a.remark ??= ''
    a.manualUsage ??= ''
  }
  // 给还没有颜色的组分配颜色（优先用未被占用的）
  for (const t of cfg.tabs) {
    if (t.color) continue
    const used = new Set(cfg.tabs.map((x) => x.color).filter(Boolean))
    t.color = TAB_COLORS.find((c) => !used.has(c)) ?? TAB_COLORS[cfg.tabs.indexOf(t) % TAB_COLORS.length]
  }
  // 一个账号只属于一个组：去重，并把孤儿账号放进第一个组
  const seen = new Set<string>()
  for (const t of cfg.tabs) {
    t.accountIds = t.accountIds.filter((id) => cfg.accounts[id] && !seen.has(id) && (seen.add(id), true))
  }
  for (const id of Object.keys(cfg.accounts)) if (!seen.has(id)) cfg.tabs[0].accountIds.push(id)
  if (!cfg.tabs.find((t) => t.id === cfg.window.activeTabId)) cfg.window.activeTabId = cfg.tabs[0].id
  return cfg
}

export function loadConfig(): AppConfig {
  const p = configPath()
  try {
    current = existsSync(p) ? normalize(JSON.parse(readFileSync(p, 'utf8'))) : defaultConfig()
  } catch (e) {
    // 配置损坏时不覆盖原文件，留一份备份再用默认值启动
    console.error('[config] 解析失败，使用默认配置', e)
    try {
      renameSync(p, `${p}.broken-${Date.now()}`)
    } catch {}
    current = defaultConfig()
  }
  writeNow()
  return current
}

export function getConfig(): AppConfig {
  return current
}

function writeNow(): void {
  const p = configPath()
  mkdirSync(app.getPath('userData'), { recursive: true })
  const tmp = `${p}.tmp`
  writeFileSync(tmp, JSON.stringify(current, null, 2), 'utf8')
  renameSync(tmp, p) // 原子替换
}

export function setConfig(next: AppConfig, opts: { immediate?: boolean } = {}): AppConfig {
  current = normalize(next)
  if (saveTimer) clearTimeout(saveTimer)
  if (opts.immediate) writeNow()
  else saveTimer = setTimeout(writeNow, 300)
  for (const l of listeners) l(current)
  return current
}

export function updateConfig(mut: (c: AppConfig) => void, opts?: { immediate?: boolean }): AppConfig {
  const copy: AppConfig = structuredClone(current)
  mut(copy)
  return setConfig(copy, opts)
}

export function onConfigChange(fn: (c: AppConfig) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** 用户手动改了 config.json 后从磁盘重载（菜单"重新加载配置"） */
export function reloadFromDisk(): AppConfig {
  const fresh = JSON.parse(readFileSync(configPath(), 'utf8'))
  return setConfig(fresh, { immediate: true })
}

export function flushConfig(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    writeNow()
  }
}
