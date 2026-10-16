import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig } from '../shared/types'

const CHANNELS = ['config:changed', 'usage:updated'] as const
type Channel = (typeof CHANNELS)[number]

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (c: unknown) => ipcRenderer.invoke('config:set', c),
  configPath: () => ipcRenderer.invoke('config:path'),
  musePreload: () => ipcRenderer.invoke('paths:musePreload'),
  refreshUsage: (id: string) => ipcRenderer.invoke('usage:refresh', id),
  saveUsage: (id: string, raw: string, bars: number[]) => ipcRenderer.invoke('usage:save', id, raw, bars),
  sendKey: (wcId: number, keyCode: string, modifiers: ('meta' | 'shift')[] = []) => ipcRenderer.invoke('webview:key', wcId, keyCode, modifiers),
  clearAccountData: (id: string) => ipcRenderer.invoke('account:clearData', id),
  confirm: (message: string) => ipcRenderer.invoke('dialog:confirm', message),
  notify: (title: string, body: string) => ipcRenderer.send('notify', title, body),
  setTrafficLights: (visible: boolean) => ipcRenderer.send('window:trafficLights', visible),
  on: (channel: Channel, cb: (...args: unknown[]) => void) => {
    if (!CHANNELS.includes(channel)) throw new Error(`channel not allowed: ${channel}`)
    const h = (_e: unknown, ...args: unknown[]): void => cb(...args)
    ipcRenderer.on(channel, h)
    return (): void => {
      ipcRenderer.removeListener(channel, h)
    }
  }
}

contextBridge.exposeInMainWorld('panel', api)
export type PanelApi = typeof api
