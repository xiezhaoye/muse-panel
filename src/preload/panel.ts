import { contextBridge, ipcRenderer } from 'electron'
import type { AppConfig, Usage } from '../shared/types'

const CHANNELS = ['config:changed', 'usage:state'] as const
type Channel = (typeof CHANNELS)[number]

const api = {
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  setConfig: (c: unknown) => ipcRenderer.invoke('config:set', c),
  configPath: () => ipcRenderer.invoke('config:path'),
  musePreload: () => ipcRenderer.invoke('paths:musePreload'),
  refreshUsage: (id: string): Promise<{ usage: Usage | null; error: string | null; ms: number }> => ipcRenderer.invoke('usage:refresh', id),
  usageQueueState: (): Promise<Record<string, 'queued' | 'running' | 'idle'>> => ipcRenderer.invoke('usage:queueState'),
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
