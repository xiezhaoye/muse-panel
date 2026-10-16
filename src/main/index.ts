import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, session, shell } from 'electron'
import { join } from 'node:path'
import {
  configPath,
  flushConfig,
  getConfig,
  loadConfig,
  onConfigChange,
  reloadFromDisk,
  setConfig,
  updateConfig
} from './config'
import { initUsageQueue, refreshUsage, usageQueueState } from './usage'
import type { AppConfig } from '../shared/types'

// UA 归一化：去掉 Electron/x.y.z 和应用名，网站看到的就是普通 Chrome。
// 对所有 session（包括每个 persist:muse-* partition）生效。
app.userAgentFallback = app.userAgentFallback.replace(/\s(Electron|MusePanel|muse-panel)\/\S+/gi, '')

// 测试用：MUSE_PANEL_USER_DATA 指定独立的数据目录，不碰正式配置和登录态
if (process.env.MUSE_PANEL_USER_DATA) app.setPath('userData', process.env.MUSE_PANEL_USER_DATA)

const ALLOWED_POPUP_HOSTS = /(^|\.)(muse\.ai|meta\.com|facebook\.com|metaaivm\.com|accountscenter\.meta\.com)$/i

let win: BrowserWindow | null = null

function musePreloadPath(): string {
  return join(__dirname, '../preload/muse.js')
}

function createWindow(cfg: AppConfig): void {
  win = new BrowserWindow({
    width: cfg.window.width,
    height: cfg.window.height,
    x: cfg.window.x,
    y: cfg.window.y,
    minWidth: 900,
    minHeight: 600,
    title: 'Muse Panel',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#f6f6f4',
    webPreferences: {
      preload: join(__dirname, '../preload/panel.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true
    }
  })

  // 只允许本应用创建 muse 账号 webview，并强制安全参数
  win.webContents.on('will-attach-webview', (event, prefs, params) => {
    const partition = params.partition ?? ''
    if (!partition.startsWith('persist:muse-') || !/^https:\/\/([a-z0-9-]+\.)*muse\.ai\//.test(params.src)) {
      event.preventDefault()
      return
    }
    prefs.preload = musePreloadPath()
    prefs.contextIsolation = true
    prefs.nodeIntegration = false
    prefs.sandbox = true
    delete (prefs as Record<string, unknown>).preloadURL
  })

  win.webContents.on('did-attach-webview', (_e, wc) => {
    wc.setWindowOpenHandler(({ url }) => {
      try {
        const host = new URL(url).hostname
        if (ALLOWED_POPUP_HOSTS.test(host)) return { action: 'allow' } // 登录弹窗与同站链接，沿用同一 partition
      } catch {}
      shell.openExternal(url)
      return { action: 'deny' }
    })
  })

  const saveBounds = (): void => {
    if (!win) return
    const b = win.getBounds()
    updateConfig((c) => {
      c.window.width = b.width
      c.window.height = b.height
      c.window.x = b.x
      c.window.y = b.y
    })
  }
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)
  win.on('closed', () => (win = null))

  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'editMenu' }, // 没有它，webview 里 ⌘C/⌘V 不可用
    {
      label: '面板',
      submenu: [
        { label: '打开配置文件', click: () => shell.openPath(configPath()) },
        { label: '在 Finder 中显示配置', click: () => shell.showItemInFolder(configPath()) },
        {
          label: '重新加载配置（改完 JSON 后）',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => {
            try {
              reloadFromDisk()
            } catch (e) {
              dialog.showErrorBox('配置文件有误', String(e))
            }
          }
        },
        { type: 'separator' },
        { role: 'reload', label: '重载面板界面' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}


function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

function registerIpc(): void {
  // 侧栏收拢时隐藏左上角红绿灯，避免压在第一列列头上
  ipcMain.on('window:trafficLights', (_e, visible: boolean) => win?.setWindowButtonVisibility(visible))
  ipcMain.handle('config:get', () => getConfig())
  ipcMain.handle('config:set', (_e, next: AppConfig) => setConfig(next))
  ipcMain.handle('config:path', () => configPath())
  ipcMain.handle('paths:musePreload', () => `file://${musePreloadPath()}`)
  ipcMain.handle('usage:refresh', (_e, id: string) => refreshUsage(id))
  ipcMain.handle('usage:queueState', () => usageQueueState())
  ipcMain.handle('account:clearData', async (_e, id: string) => {
    await session.fromPartition(`persist:muse-${id}`).clearStorageData()
    return true
  })
  ipcMain.handle('dialog:confirm', async (_e, message: string) => {
    if (!win) return false
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['取消', '确定'], defaultId: 0, cancelId: 0, message })
    return r.response === 1
  })
  ipcMain.on('notify', (_e, title: string, body: string) => new Notification({ title, body }).show())
}

app.whenReady().then(() => {
  // 账号页面里用不上拼写检查，关掉省一点内存和 CPU
  app.on('session-created', (ses) => ses.setSpellCheckerEnabled(false))
  const cfg = loadConfig()
  buildMenu()
  registerIpc()
  createWindow(cfg)

  onConfigChange((c) => send('config:changed', c))
  // 额度只在用户点刷新时读取（串行队列），不做启动时或定时的抓取
  initUsageQueue((id, state) => send('usage:state', id, state))


  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(getConfig())
  })
})

app.on('before-quit', () => {
  flushConfig()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
