/// <reference types="vite/client" />
import type { PanelApi } from '../../preload/panel'

declare global {
  interface Window {
    panel: PanelApi
  }
}
