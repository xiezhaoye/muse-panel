// 主进程、preload、渲染层共用的类型与默认配置。

export interface Usage {
  weeklyPercent: number | null // 每周额度已用 %
  extraPercent: number | null // 额外额度已用 %
  resetText: string | null // "10月17日"
  extraText: string | null // 额外额度剩余，如 "20 亿个词元"
  raw: string | null
  updatedAt: number | null
  error?: string | null
}

export interface Account {
  id: string
  name: string
  remark: string
  sleeping?: boolean // 手动休眠：不创建 webview
  usage: Usage
  manualUsage: string // 手填兜底
}

export interface Tab {
  id: string
  name: string
  color?: string // 组名左侧竖条的颜色，创建时分配，排序不变
  accountIds: string[] // 顺序即列顺序
}

export interface LayoutRule {
  selector: string
  action: 'hide' | 'style'
  css?: string
  note?: string
}

export interface Rules {
  chat: {
    input: string
    sendButton: string
    stopButton: string // 出现即视为"生成中"
    assistantMessage: string
    userMessage: string
    mainChatPath: string // 主要聊天的 pathname
  }
  status: {
    panel: string
    connectedPattern: string
    activityTimePattern: string
  }
  usage: {
    // 打开设置：先发 ⌘,（与页面布局无关），不行再点按钮 → 菜单项
    openMenuButton: string // "设置" 按钮（宽屏在左侧 dock，窄屏在右下角）
    menuItemText: string // 菜单里的 "设置"
    sectionTitle: string // "使用情况"
    progressBar: string // 进度条，第 1 个是每周额度，第 2 个是额外额度
    intervalMin: number
  }
  layout: LayoutRule[]
  perf: {
    pauseLoopingVideos: boolean // 头像等循环播放的装饰视频，四路同时解码很耗 GPU
  }
}

export interface AppConfig {
  version: 1
  homeUrl: string
  window: { width: number; height: number; x?: number; y?: number; activeTabId: string | null; sidebarCollapsed?: boolean; sidebarWidth?: number }
  tabs: Tab[]
  accounts: Record<string, Account>
  rules: Rules
}

// 渲染层看到的运行时状态（不落盘）
export interface AccountStatus {
  connected: boolean | null
  busy: boolean
  draft: boolean // 输入框里有用户没发出的文字
  loggedIn: boolean | null
  path: string
  lastActivity: { title: string; time: string } | null
  lastAssistant: string | null
}

// 组颜色的取色板（新组优先用还没被占用的颜色）
export const TAB_COLORS = ['#2f6fde', '#e0773b', '#2f9e6b', '#9b59d0', '#d6455d', '#1aa3b8', '#c49a1c', '#5b6b7f']

export const DEFAULT_RULES: Rules = {
  chat: {
    input: 'textarea[placeholder="消息"]',
    sendButton: 'button[aria-label="发送"]',
    stopButton: 'button[aria-label*="停止"], button[aria-label*="Stop"], button[aria-label*="stop"]',
    assistantMessage: '[data-message-role="assistant"]',
    userMessage: '[data-message-role="user"]',
    mainChatPath: '/'
  },
  status: {
    panel: '[data-testid="hatch-status-panel-sliding-surface"]',
    connectedPattern: '^(已连接|Connected)$',
    activityTimePattern: '^\\d{1,2}:\\d{2}\\s?(am|pm|AM|PM)?$'
  },
  usage: {
    openMenuButton: 'button[aria-label="设置"], button[aria-label="更多"]',
    menuItemText: '设置',
    sectionTitle: '使用情况',
    progressBar: '[role="progressbar"]',
    intervalMin: 30
  },
  perf: { pauseLoopingVideos: true },
  layout: [
    { selector: '[data-testid="app-download-dock-mark"]', action: 'hide', note: '下载 Muse 应用' },
    { selector: '[data-testid="hatch-invite-friends-button"]', action: 'hide', note: '邀请' },
    { selector: '[data-testid="hatch-side-chats-panel-shell"]', action: 'hide', note: '聊天列表（需要时可删掉此条）' },
    { selector: '[data-testid="hatch-status-panel-sliding-surface"]', action: 'hide', note: '右侧状态面板（信息已搬到列头）' }
  ]
}

export function emptyUsage(): Usage {
  return { weeklyPercent: null, extraPercent: null, resetText: null, extraText: null, raw: null, updatedAt: null, error: null }
}

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    homeUrl: 'https://muse.ai/',
    window: { width: 1600, height: 1000, activeTabId: 't1' },
    tabs: [{ id: 't1', name: '默认组', accountIds: [] }],
    accounts: {},
    rules: DEFAULT_RULES
  }
}
