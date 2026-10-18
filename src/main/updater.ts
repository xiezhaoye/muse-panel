import { app, dialog, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

// 应用未签名（electron-builder identity: null），Squirrel.Mac / electron-updater 都不可用，
// 这里自己做一套最简更新：检查 latest.json → 流式下载 zip → 校验 SHA-256 → ditto 解压 →
// 交给一个脱离的 sh 脚本，在当前进程退出后替换 .app 并重新打开。

const DEFAULT_FEED = 'https://musepanel-dl.xiezhaoye.site/latest.json'
const DOWNLOAD_PAGE = 'https://musepanel.xiezhaoye.site'
const APP_BUNDLE = 'Muse Panel.app'

interface Manifest {
  version: string
  date?: string
  notes?: string
  zipUrl: string
  zipSize?: number
  zipSha256?: string
  dmgUrl?: string
}

/** 主进程 → 界面：下载进度与状态 */
export type UpdateProgress =
  | { phase: 'downloading'; received: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

type Send = (channel: string, ...args: unknown[]) => void

/** 主窗口 getter（窗口由 index.ts 创建/销毁，这里不持有它） */
let getWindow: () => Electron.BrowserWindow | null = () => null
let send: Send = () => {}
/** 菜单需要随「待安装」状态重建 */
let rebuildMenu: () => void = () => {}

/** 下载好、等待安装的包 */
let pending: { version: string; appPath: string; zipPath: string } | null = null
/** 同一时间只允许一次检查或下载 */
let busy = false

export function initUpdater(opts: { send: Send; rebuildMenu: () => void; getWindow: () => Electron.BrowserWindow | null }): void {
  send = opts.send
  rebuildMenu = opts.rebuildMenu
  getWindow = opts.getWindow
}

/** 有已下载待安装的版本时返回版本号（菜单项据此显示） */
export function pendingUpdateVersion(): string | null {
  return pending?.version ?? null
}

function emit(p: UpdateProgress): void {
  send('update:progress', p)
}

function setProgress(ratio: number): void {
  try {
    getWindow()?.setProgressBar(ratio)
  } catch {}
}

function updateDir(): string {
  return join(app.getPath('temp'), 'muse-panel-update')
}

function feedUrl(): string {
  const base = process.env.MUSE_PANEL_UPDATE_URL || DEFAULT_FEED
  return `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}` // 避免命中缓存
}

/** 按 x.y.z 数字逐段比较；a > b 返回正数 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  const pb = b.split('-')[0].split('.').map((x) => Number.parseInt(x, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function info(message: string, detail?: string): Promise<void> {
  const win = getWindow()
  const opts: Electron.MessageBoxOptions = { type: 'info', message, detail, buttons: ['好'], noLink: true }
  if (win) await dialog.showMessageBox(win, opts)
  else await dialog.showMessageBox(opts)
}

async function confirm(message: string, detail: string, buttons: string[]): Promise<number> {
  const win = getWindow()
  const opts: Electron.MessageBoxOptions = { type: 'info', message, detail, buttons, defaultId: 0, cancelId: buttons.length - 1, noLink: true }
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
  return r.response
}

async function fail(message: string, detail: string): Promise<void> {
  setProgress(-1)
  emit({ phase: 'error', message })
  await info(`${message}\n\n${detail}\n\n也可以到 ${DOWNLOAD_PAGE} 手动下载安装。`)
}

async function fetchManifest(): Promise<Manifest> {
  const res = await net.fetch(feedUrl(), { cache: 'no-store' })
  if (!res.ok) throw new Error(`更新信息获取失败（HTTP ${res.status}）`)
  const data = (await res.json()) as Partial<Manifest>
  if (!data.version || !data.zipUrl) throw new Error('更新信息格式不正确')
  if (!/^\d+\.\d+\.\d+/.test(data.version)) throw new Error(`版本号无法识别：${data.version}`)
  return data as Manifest
}

/** 检查更新。manual = 用户主动点菜单，只有这时才提示「已是最新版本」 */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (busy || pending) {
    // 已经在下载/检查：重复点击忽略；已下载待安装则提醒直接安装
    if (pending && manual) void installUpdate()
    return
  }
  busy = true
  try {
    let manifest: Manifest
    try {
      manifest = await fetchManifest()
    } catch (e) {
      await fail('检查更新失败', e instanceof Error ? e.message : String(e))
      return
    }

    const current = app.getVersion()
    if (compareVersions(manifest.version, current) <= 0) {
      if (manual) await info(`已是最新版本（${current}）`)
      return
    }

    const lines = [`当前版本 ${current} → 新版本 ${manifest.version}`]
    if (manifest.date) lines.push(`发布日期：${manifest.date}`)
    if (manifest.notes) lines.push('', manifest.notes)
    const r = await confirm(`发现新版本 ${manifest.version}（当前 ${current}）`, lines.join('\n'), ['下载并更新', '以后再说'])
    if (r !== 0) return

    await downloadAndPrepare(manifest)
  } finally {
    busy = false
  }
}

async function downloadAndPrepare(manifest: Manifest): Promise<void> {
  const dir = updateDir()
  const fileName = basename(new URL(manifest.zipUrl).pathname) || `MusePanel_${manifest.version}_arm64.zip`
  const zipPath = join(dir, fileName)
  const unpackDir = join(dir, `unpacked-${manifest.version}`)

  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.rm(unpackDir, { recursive: true, force: true })
    await fsp.rm(zipPath, { force: true })

    // ---- 下载：流式写盘，边下边报进度 ----
    const res = await net.fetch(manifest.zipUrl, { cache: 'no-store' })
    if (!res.ok || !res.body) throw new Error(`下载失败（HTTP ${res.status}）`)

    const total = Number(res.headers.get('content-length')) || manifest.zipSize || 0
    let received = 0
    let lastEmit = 0
    emit({ phase: 'downloading', received: 0, total })
    const body = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])
    body.on('data', (chunk: Buffer) => {
      received += chunk.length
      const now = Date.now()
      if (now - lastEmit < 100 && (!total || received < total)) return
      lastEmit = now
      emit({ phase: 'downloading', received, total })
      if (total > 0) setProgress(Math.min(0.999, received / total))
    })
    await pipeline(body, createWriteStream(zipPath))

    // ---- 校验 SHA-256 ----
    const expected = manifest.zipSha256?.trim().toLowerCase()
    if (expected) {
      const actual = createHash('sha256')
        .update(await fsp.readFile(zipPath))
        .digest('hex')
      if (actual !== expected) {
        await fsp.rm(zipPath, { force: true })
        throw new Error(`安装包校验失败（SHA-256 不一致）\n期望 ${expected}\n实际 ${actual}`)
      }
    }

    // ---- 解压并确认 .app ----
    await run('/usr/bin/ditto', ['-x', '-k', zipPath, unpackDir])
    const appPath = join(unpackDir, APP_BUNDLE)
    const st = await fsp.stat(appPath).catch(() => null)
    if (!st?.isDirectory()) {
      await fsp.rm(unpackDir, { recursive: true, force: true })
      throw new Error(`解压结果里没有找到 ${APP_BUNDLE}`)
    }

    // ---- 准备就绪 ----
    pending = { version: manifest.version, appPath, zipPath }
    setProgress(-1)
    rebuildMenu() // 菜单项变为「重启并安装更新（x.y.z）」
    emit({ phase: 'ready', version: manifest.version })

    const r = await confirm('新版本已下载，重启以完成更新', `Muse Panel ${manifest.version} 已准备好，重启后生效。`, ['立即重启', '稍后'])
    if (r === 0) await installUpdate()
  } catch (e) {
    pending = null
    await fsp.rm(zipPath, { force: true }).catch(() => {})
    await fail('更新下载失败', e instanceof Error ? e.message : String(e))
  }
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))))
  })
}

/** 由可执行文件路径推出当前 .app 包路径（形如 /Applications/Muse Panel.app），找不到返回 null */
function currentAppPath(): string | null {
  const candidates: string[] = [app.getPath('exe')]
  if (process.execPath && process.execPath !== candidates[0]) candidates.push(process.execPath)
  if (process.defaultApp && process.argv[0]) candidates.push(process.argv[0])
  for (const exe of candidates) {
    const idx = exe.indexOf('.app/')
    if (idx > 0) return exe.slice(0, idx + 4)
  }
  return null
}

/** 生成并启动替换脚本，然后退出应用 */
export async function installUpdate(): Promise<void> {
  if (!app.isPackaged) {
    await info('开发模式下不能安装更新', '请运行打包后的应用（npm run dist）再试用更新功能。')
    return
  }
  if (!pending) {
    await info('没有已下载的更新', '请先在「面板」菜单里检查更新。')
    return
  }
  const target = currentAppPath()
  if (!target) {
    await info('找不到应用位置', `可执行文件路径：${app.getPath('exe')}`)
    return
  }

  const dir = updateDir()
  const scriptPath = join(dir, `install-${Date.now()}.sh`)
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const backup = `${target}.bak-${stamp}`
  const script = `#!/bin/sh
# 由 Muse Panel 更新器生成：等旧进程退出 → 备份旧 .app → 拷入新 .app → 去掉隔离属性 → 打开
set -u
PID=${process.pid}
TARGET=${sh(target)}
NEW=${sh(pending.appPath)}
BACKUP=${sh(backup)}

i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 120 ]; then break; fi   # 最多等 60 秒
  sleep 0.5
done
# 60 秒后旧进程仍在运行（退出被拦下等）：放弃替换，不动任何文件，避免在运行中挪走 .app
if kill -0 "$PID" 2>/dev/null; then exit 1; fi

cd / || exit 1
if [ -d "$TARGET" ]; then
  rm -rf "$BACKUP" 2>/dev/null
  mv "$TARGET" "$BACKUP" || exit 1
fi

if ! /usr/bin/ditto "$NEW" "$TARGET"; then
  rm -rf "$TARGET" 2>/dev/null
  [ -d "$BACKUP" ] && mv "$BACKUP" "$TARGET"
  exit 1
fi

xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true
open "$TARGET" || true
rm -rf "$BACKUP" 2>/dev/null || true
rm -rf ${sh(dir)} 2>/dev/null || true
exit 0
`
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(scriptPath, script, { mode: 0o755 })
  } catch (e) {
    await fail('无法写入更新脚本', e instanceof Error ? e.message : String(e))
    return
  }

  spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' }).unref()
  setProgress(-1)
  app.quit()
}

/** 单引号安全包裹（脚本里所有路径都走这里） */
function sh(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
