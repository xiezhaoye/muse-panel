import { useEffect, useState } from 'react'

/** 主进程推来的更新进度（见 src/main/updater.ts） */
export type UpdateState =
  | { phase: 'idle' }
  | { phase: 'downloading'; received: number; total: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string }

interface Props {
  open: boolean
  onClose: () => void
  updateState: UpdateState
}

export function SettingsDialog({ open, onClose, updateState }: Props): React.JSX.Element | null {
  const [version, setVersion] = useState('')
  const [checking, setChecking] = useState(false)
  // 打开时查一次主进程里已下载待安装的版本（菜单项之外的入口）
  const [pending, setPending] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void window.panel.appVersion().then(setVersion)
    void window.panel.pendingUpdate().then(setPending)
  }, [open])

  // 下载完成（updateState 变 ready）时以它为准
  useEffect(() => {
    if (open && updateState.phase === 'ready') setPending(updateState.version)
  }, [open, updateState])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.panel.checkForUpdates()
    } finally {
      setChecking(false)
      setPending(await window.panel.pendingUpdate())
    }
  }

  const percent =
    updateState.phase === 'downloading' && updateState.total > 0
      ? Math.min(100, Math.floor((updateState.received / updateState.total) * 100))
      : null

  return (
    <div className="settings-mask" onClick={onClose}>
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <span className="settings-title">设置</span>
          <button className="settings-close" title="关闭" aria-label="关闭" onClick={onClose}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>

        <div className="settings-row">
          <span className="settings-label">当前版本</span>
          <span className="settings-value">v{version || '…'}</span>
        </div>

        <div className="settings-row">
          <span className="settings-label">更新</span>
          <button className="settings-btn" disabled={checking} onClick={() => void check()}>
            {checking ? '检查中…' : '检查更新'}
          </button>
        </div>

        {updateState.phase === 'downloading' && (
          <div className="settings-state">
            <div className="settings-state-text">正在下载 {percent == null ? '' : `${percent}%`}</div>
            <div className="settings-bar">
              <div className="settings-bar-fill" style={{ width: `${percent ?? 15}%` }} />
            </div>
          </div>
        )}

        {pending && updateState.phase !== 'downloading' && (
          <div className="settings-state">
            <div className="settings-state-text">新版本 {pending} 已下载</div>
            <button className="settings-btn" onClick={() => void window.panel.installUpdate()}>
              重启并安装
            </button>
          </div>
        )}

        {updateState.phase === 'error' && <div className="settings-state settings-error">{updateState.message}</div>}
      </div>
    </div>
  )
}
