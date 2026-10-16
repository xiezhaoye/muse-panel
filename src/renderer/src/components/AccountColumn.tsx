import { useEffect, useRef, useState } from 'react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Account, AccountStatus, Rules } from '../../../shared/types'
import { registry, WebviewEl } from '../webviewRegistry'
import { IconGear, IconGrip, IconMoon, IconPencil, IconRefresh, IconTrash, IconWork } from './icons'

interface Props {
  account: Account
  status: AccountStatus | null
  visible: boolean
  order: number
  mounted: boolean
  musePreload: string
  homeUrl: string
  rules: Rules
  onChange: (mut: (a: Account) => void) => void
  onDelete: () => void
  onRefreshUsage: () => Promise<{ kind: 'ok' | 'same' | 'error'; text: string }>
}

// 头部尽量紧凑：一行"每周额度：52%已用 ↻"，下面一条进度条
function WeeklyUsage({ a, onRefresh }: { a: Account; onRefresh: Props['onRefreshUsage'] }): React.JSX.Element {
  const u = a.usage
  // 点刷新后：图标转圈 → 结果在右侧显示 3 秒（已更新 / 已是最新 / 失败原因）
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState<{ kind: string; text: string } | null>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refresh = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFlash(null)
    try {
      const r = await onRefresh()
      setFlash(r)
    } catch (e) {
      setFlash({ kind: 'error', text: `刷新失败：${String(e)}` })
    } finally {
      setBusy(false)
      if (flashTimer.current) clearTimeout(flashTimer.current)
      flashTimer.current = setTimeout(() => setFlash(null), 3000)
    }
  }
  const used = u.weeklyPercent == null ? null : Math.max(0, Math.min(100, u.weeklyPercent))
  const tip = [u.resetText ? `${u.resetText}重置` : '', u.updatedAt ? `更新于 ${new Date(u.updatedAt).toLocaleString('zh-CN')}` : '']
    .filter(Boolean)
    .join('，')
  return (
    <div className="weekly" title={tip}>
      <div className="weekly-line">
        {used != null ? (
          <span>
            每周额度：<b>{used}%</b>已用
          </span>
        ) : (
          <span className="muted">{u.error ? `额度：${u.error}` : '额度：点右侧按钮刷新'}</span>
        )}
        <button className={`icon urefresh ${busy ? 'spinning' : ''}`} title="刷新额度" disabled={busy} onClick={() => void refresh()}>
          <IconRefresh size={15} />
        </button>
        {busy ? (
          <span className="reset">刷新中…</span>
        ) : flash ? (
          <span className={`reset flash ${flash.kind}`}>{flash.text}</span>
        ) : (
          u.resetText && <span className="reset">{u.resetText}重置</span>
        )}
      </div>
      {used != null && (
        <div className="ubar" role="progressbar" aria-valuenow={used} aria-valuemax={100}>
          <div className={`ufill ${used >= 80 ? 'warn' : ''}`} style={{ width: `${used}%` }} />
        </div>
      )}
    </div>
  )
}

export function AccountColumn(p: Props): React.JSX.Element {
  const { account: a, status: s } = p
  const holder = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  // 下拉菜单：点菜单外、按 Esc、或焦点进到网页（点了 webview）时收起
  useEffect(() => {
    if (!menuOpen) return
    const close = (e: Event): void => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      if (e.type === 'pointerdown') {
        const t = e.target as Element
        if (menuRef.current?.contains(t) || t.closest?.('.tools')) return
      }
      setMenuOpen(false)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [menuOpen])
  const [editing, setEditing] = useState(false)
  // 改过名字（不再是默认的「账号N」）就用大字号显示，一眼认出是哪个号
  const named = !/^账号\d+$/.test(a.name)
  const sortable = useSortable({ id: a.id, disabled: !p.visible })
  const rulesRef = useRef(p.rules)
  useEffect(() => {
    rulesRef.current = p.rules
    const e = registry.get(a.id)
    if (e?.ready) e.el.send('muse:rules', p.rules)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(p.rules), a.id])


  // webview 只创建一次，之后不随排序/切组移动 DOM（移动会导致页面重载）
  useEffect(() => {
    if (!p.mounted || a.sleeping || !holder.current || !p.musePreload) return
    const wv = document.createElement('webview') as WebviewEl
    wv.setAttribute('partition', `persist:muse-${a.id}`)
    wv.setAttribute('preload', p.musePreload)
    wv.setAttribute('allowpopups', 'true')
    wv.setAttribute('src', p.homeUrl)
    wv.className = 'webview'
    const onIpc = (e: Event): void => {
      const { channel, args } = e as unknown as { channel: string; args: unknown[] }
      if (channel === 'muse:ready') {
        registry.setReady(a.id, true)
        wv.send('muse:rules', rulesRef.current)
      } else if (channel === 'muse:status') registry.setStatus(a.id, args[0] as AccountStatus)
      else if (channel === 'muse:injected' || channel === 'muse:usage') registry.resolveInjected(args[0] as { id: string; ok: boolean; error?: string })
      else if (channel === 'muse:trustedKey') {
        const k = args[0] as { id: string; key: string; modifiers: ('meta' | 'shift')[] }
        // 先把键盘焦点交给这一列的页面，真实按键才会送进去；之后还原焦点
        const prev = document.activeElement as HTMLElement | null
        wv.focus()
        void window.panel
          .sendKey(wv.getWebContentsId(), k.key, k.modifiers)
          .then(() => wv.send('muse:trustedKeyDone', k.id))
          .finally(() => setTimeout(() => prev?.focus?.(), 50))
      }
    }
    const onDomReady = (): void => {
      registry.setReady(a.id, true)
      wv.send('muse:rules', rulesRef.current)
    }
    const onStart = (): void => registry.setReady(a.id, false)
    wv.addEventListener('ipc-message', onIpc)
    wv.addEventListener('dom-ready', onDomReady)
    wv.addEventListener('did-start-navigation', onStart as EventListener)
    registry.register(a.id, wv)
    holder.current.appendChild(wv)
    return () => {
      registry.unregister(a.id, wv)
      wv.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.mounted, a.sleeping, p.musePreload])

  const style: React.CSSProperties = p.visible
    ? { order: p.order, transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }
    : {}

  const extra = a.usage.extraText ? a.usage.extraText.replace(/个词元$/, ' 词元') : null

  const confirmSleep = async (): Promise<void> => {
    setMenuOpen(false)
    if (a.sleeping) return
    if (await window.panel.confirm(`让「${a.name}」休眠？\n页面会被关闭以释放内存，切回「工作」时重新加载（不用重新登录）。`)) p.onChange((x) => (x.sleeping = true))
  }


  return (
    <section
      ref={sortable.setNodeRef}
      className={`column ${p.visible ? 'visible' : 'hidden'} ${sortable.isDragging ? 'dragging' : ''}`}
      style={style}
    >
      <header className="infobar">
        <div className="row1">
          <span className="handle" title="拖动排序；拖到左侧组名上可移组" {...sortable.attributes} {...sortable.listeners}>
            <IconGrip size={18} />
          </span>
          <div className="titlebox">
            {editing ? (
              <input
                className={`title-input ${named ? 'named' : ''}`}
                autoFocus
                defaultValue={a.name}
                spellCheck={false}
                onBlur={(e) => {
                  setEditing(false)
                  const v = e.target.value.trim()
                  if (v && v !== a.name) p.onChange((x) => (x.name = v))
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                  if (e.key === 'Escape') setEditing(false)
                }}
              />
            ) : (
              <span className={`title ${named ? 'named' : ''}`} onDoubleClick={() => setEditing(true)}>
                {a.name}
              </span>
            )}
            {!editing && (
              <button className="icon edit" title="编辑名称" onClick={() => setEditing(true)}>
                <IconPencil size={17} />
              </button>
            )}
            {!editing && extra && (
              <span className="extra" title="不过期额度剩余">
                {extra}
              </span>
            )}
          </div>
          <div className="tools">
            <button className={`icon gear ${menuOpen ? 'on' : ''}`} title="设置" onClick={() => setMenuOpen((v) => !v)}>
              <IconGear size={20} />
            </button>
          </div>
        </div>
        <WeeklyUsage a={a} onRefresh={p.onRefreshUsage} />
        {s?.lastActivity && (
          <div className="row4">
            <span className="activity" title="右侧状态面板的最新动态">
              {s.lastActivity.time} {s.lastActivity.title}
            </span>
          </div>
        )}
        {menuOpen && (
          <div className="menu" ref={menuRef} onClick={(e) => e.stopPropagation()}>
            <button
              className="menu-item"
              onClick={() => {
                registry.get(a.id)?.el.reload()
                setMenuOpen(false)
              }}
            >
              <span className="mi-icon"><IconRefresh size={17} /></span>
              <span className="mi-main">刷新</span>
              <span className="mi-note">重新加载这一列</span>
            </button>
            <div className="menu-sep" />
            <button
              className={`menu-item ${!a.sleeping ? 'checked' : ''}`}
              onClick={() => {
                if (a.sleeping) p.onChange((x) => (x.sleeping = false))
                setMenuOpen(false)
              }}
            >
              <span className="mi-icon"><IconWork size={17} /></span>
              <span className="mi-main">工作</span>
              <span className="mi-note">开机正常使用</span>
            </button>
            <button className={`menu-item ${a.sleeping ? 'checked' : ''}`} onClick={() => void confirmSleep()}>
              <span className="mi-icon"><IconMoon size={17} /></span>
              <span className="mi-main">休眠</span>
              <span className="mi-note">释放内存</span>
            </button>
            <button
              className="menu-item danger"
              onClick={() => {
                setMenuOpen(false)
                p.onDelete()
              }}
            >
              <span className="mi-icon"><IconTrash size={17} /></span>
              <span className="mi-main">删除</span>
              <span className="mi-note">从面板里面删掉</span>
            </button>
          </div>
        )}
      </header>
      <div className="webview-holder" ref={holder}>
        {a.sleeping && <div className="placeholder">已休眠 · 不占内存。在 ⚙ 菜单里选「工作」恢复</div>}
      </div>
    </section>
  )
}
