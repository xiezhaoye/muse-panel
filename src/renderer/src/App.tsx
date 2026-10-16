import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { closestCenter, CollisionDetection, DndContext, DragEndEvent, DragOverEvent, DragOverlay, DragStartEvent, MeasuringStrategy, Modifier, PointerSensor, pointerWithin, useSensor, useSensors } from '@dnd-kit/core'
import { getEventCoordinates } from '@dnd-kit/utilities'
import { arrayMove, horizontalListSortingStrategy, SortableContext } from '@dnd-kit/sortable'
import type { Account, AccountStatus, AppConfig, Tab } from '../../shared/types'
import { emptyUsage, resetLabel } from '../../shared/types'
import { AccountColumn, type UsageFlash } from './components/AccountColumn'
import { TabBar } from './components/TabBar'
import { registry } from './webviewRegistry'
import { IconSidebar } from './components/icons'

// 碰撞检测：列很宽、组名条很小，默认的矩形重叠算法几乎判不到组上。
// 拖账号时：指针落在某个组名上 → 该组；否则取指针横向所在的那一列（列是满高的，只看 x）。
// 拖组时：只在组之间判断。
// 其它组的列虽然隐藏了，仍然注册为落点且保留旧位置，所以只认当前显示的组里的列（shown()）。
const makeCollision = (shown: () => string[]): CollisionDetection => (args) => {
  const dragTab = String(args.active.id).startsWith('tab:')
  const tabs = args.droppableContainers.filter((c) => String(c.id).startsWith('tab:'))
  if (dragTab) return closestCenter({ ...args, droppableContainers: tabs })
  const hit = pointerWithin({ ...args, droppableContainers: tabs })
  if (hit.length) return hit
  const ids = shown()
  const cols = args.droppableContainers.filter((c) => ids.includes(String(c.id)))
  const px = args.pointerCoordinates?.x
  if (px != null) {
    const col = cols.find((c) => {
      const r = args.droppableRects.get(c.id)
      return r && px >= r.left && px <= r.right
    })
    if (col) return [{ id: col.id }]
  }
  return closestCenter({ ...args, droppableContainers: cols })
}

// 拖动卡片的中心对准鼠标
const snapCenter: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  const p = activatorEvent && getEventCoordinates(activatorEvent)
  if (!p || !draggingNodeRect) return transform
  return {
    ...transform,
    x: transform.x + p.x - draggingNodeRect.left - draggingNodeRect.width / 2,
    y: transform.y + p.y - draggingNodeRect.top - draggingNodeRect.height / 2
  }
}

// 拖动账号的过程中，分组和当前显示的组都先放在这份"预览"里，松手才写入配置；按 Esc 取消则丢弃
interface DragPreview {
  id: string
  tabs: Tab[]
  view: string
}

export function App(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null>(null)
  const [musePreload, setMusePreload] = useState('')
  const [statuses, setStatuses] = useState<Record<string, AccountStatus>>({})
  const [mounted, setMounted] = useState<Set<string>>(new Set())
  const [liveWidth, setLiveWidth] = useState<number | null>(null)
  const cfgRef = useRef<AppConfig | null>(null)
  cfgRef.current = cfg
  const [drag, setDrag] = useState<DragPreview | null>(null)
  const dragRef = useRef<DragPreview | null>(null)
  dragRef.current = drag
  const shownRef = useRef<string[]>([])
  const collision = useMemo(() => makeCollision(() => shownRef.current), [])

  // ---------- 初始化 ----------
  useEffect(() => {
    void (async () => {
      const [c, pre] = await Promise.all([window.panel.getConfig(), window.panel.musePreload()])
      setCfg(c)
      setMusePreload(pre)
      // 启动时只加载当前组；其它组等切过去再加载。
      // 若关闭了自动休眠（hibernateAfterMin = 0），则沿用"全部常驻"：其余组错峰加载
      const active = c.tabs.find((t) => t.id === c.window.activeTabId)?.accountIds ?? []
      setMounted(new Set(active))
      if (!c.rules.perf.hibernateAfterMin) {
        const rest = Object.keys(c.accounts).filter((id) => !active.includes(id))
        rest.forEach((id, i) => setTimeout(() => setMounted((m) => new Set(m).add(id)), 2000 + i * 1500))
      }
    })()
    const offs = [
      window.panel.on('config:changed', (c) => setCfg(c as AppConfig))
    ]
    const offStatus = registry.onStatus((id, s) => setStatuses((m) => ({ ...m, [id]: s })))
    return () => {
      offs.forEach((f) => f())
      offStatus()
    }
  }, [])

  // ---------- 手动刷新额度 ----------
  // 所有刷新都交给主进程的串行队列（同一时间只跑 1 个，后台离屏读取，不碰正在看的页面）。
  // 队列状态（排队中 / 刷新中）实时推送过来；每次结果在列头显示 3 秒。
  const [usageState, setUsageState] = useState<Record<string, 'queued' | 'running'>>({})
  const [usageFlash, setUsageFlash] = useState<Record<string, UsageFlash>>({})
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  useEffect(() => {
    void window.panel.usageQueueState().then((st) => {
      const m: Record<string, 'queued' | 'running'> = {}
      for (const [id, v] of Object.entries(st)) if (v !== 'idle') m[id] = v
      setUsageState(m)
    })
    return window.panel.on('usage:state', (id, state) =>
      setUsageState((m) => {
        const n = { ...m }
        if (state === 'idle') delete n[id as string]
        else n[id as string] = state as 'queued' | 'running'
        return n
      })
    )
  }, [])
  const refreshUsage = useCallback(async (id: string): Promise<void> => {
    const before = cfgRef.current?.accounts[id]?.usage
    const { usage: after, error } = await window.panel.refreshUsage(id)
    let flash: UsageFlash
    if (error || !after) flash = { kind: 'error', text: `刷新失败：${error ?? '读取失败'}` }
    else if (before?.weeklyPercent === after.weeklyPercent && before?.extraText === after.extraText) flash = { kind: 'same', text: '已是最新' }
    else {
      const from = before?.weeklyPercent
      flash = { kind: 'ok', text: from != null && after.weeklyPercent != null ? `已更新 ${from}% → ${after.weeklyPercent}%` : '已更新' }
    }
    setUsageFlash((m) => ({ ...m, [id]: flash }))
    clearTimeout(flashTimers.current[id])
    flashTimers.current[id] = setTimeout(
      () =>
        setUsageFlash((m) => {
          const n = { ...m }
          delete n[id]
          return n
        }),
      3000
    )
  }, [])
  // 刷新整组：按列的顺序依次加入队列（串行执行）
  const refreshGroup = useCallback(
    (tabId: string) => {
      const t = cfgRef.current?.tabs.find((x) => x.id === tabId)
      t?.accountIds.forEach((id) => void refreshUsage(id))
    },
    [refreshUsage]
  )

  const ensureMounted = useCallback((id: string) => setMounted((m) => (m.has(id) ? m : new Set(m).add(id))), [])

  // ---------- 非当前组自动休眠 ----------
  // 切到某个组时加载它的账号；离开一个组超过 hibernateAfterMin 分钟，就卸载该组的页面释放内存。
  // 切回来时重新加载（登录态保存在 partition 里，不会掉）。
  const leftAt = useRef<Record<string, number>>({})
  const activeTabId = drag?.view ?? cfg?.window.activeTabId ?? null
  useEffect(() => {
    const c = cfgRef.current
    if (!c || !activeTabId) return
    const ids = c.tabs.find((t) => t.id === activeTabId)?.accountIds ?? []
    delete leftAt.current[activeTabId]
    for (const t of c.tabs) if (t.id !== activeTabId && !(t.id in leftAt.current)) leftAt.current[t.id] = Date.now()
    setMounted((m) => {
      const n = new Set(m)
      ids.forEach((id) => n.add(id))
      return n
    })
  }, [activeTabId])
  useEffect(() => {
    const timer = setInterval(() => {
      const c = cfgRef.current
      const min = c?.rules.perf.hibernateAfterMin ?? 0
      if (!c || !min) return
      const stale = new Set<string>()
      for (const t of c.tabs) {
        if (t.id === c.window.activeTabId) continue
        const since = leftAt.current[t.id]
        if (since && Date.now() - since > min * 60_000) t.accountIds.forEach((id) => stale.add(id))
      }
      if (!stale.size) return
      setMounted((m) => {
        if (![...stale].some((id) => m.has(id))) return m
        return new Set([...m].filter((id) => !stale.has(id)))
      })
      setStatuses((s) => Object.fromEntries(Object.entries(s).filter(([id]) => !stale.has(id))))
    }, 30_000)
    return () => clearInterval(timer)
  }, [])

  // ---------- 配置修改 ----------
  const update = useCallback((mut: (c: AppConfig) => void) => {
    const cur = cfgRef.current
    if (!cur) return
    const next = structuredClone(cur)
    mut(next)
    cfgRef.current = next
    setCfg(next)
    void window.panel.setConfig(next)
  }, [])

  // 拖动中显示预览里的分组和组，否则显示配置里的
  const tabs = drag?.tabs ?? cfg?.tabs
  const activeTab = tabs?.find((t) => t.id === activeTabId) ?? tabs?.[0]
  const tabOf = useMemo(() => {
    const m: Record<string, string> = {}
    tabs?.forEach((t) => t.accountIds.forEach((id) => (m[id] = t.id)))
    return m
  }, [tabs])

  const busyCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const [id, s] of Object.entries(statuses)) if (s.busy && tabOf[id]) m[tabOf[id]] = (m[tabOf[id]] ?? 0) + 1
    return m
  }, [statuses, tabOf])

  const collapsedFlag = !!cfg?.window.sidebarCollapsed
  useEffect(() => window.panel.setTrafficLights(!collapsedFlag), [collapsedFlag])

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  if (!cfg || !tabs || !activeTab) return <div className="loading">加载中…</div>

  shownRef.current = activeTab.accountIds
  const accountsInTab = activeTab.accountIds.map((id) => cfg.accounts[id]).filter(Boolean)
  const collapsed = !!cfg.window.sidebarCollapsed
  const setCollapsed = (v: boolean): void => update((c) => (c.window.sidebarCollapsed = v))
  const sidebarWidth = liveWidth ?? cfg.window.sidebarWidth ?? 168
  // 拖动分组栏右边缘调宽：拖动中只改本地状态，松手时写入配置
  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault()
    const x0 = e.clientX
    const w0 = sidebarWidth
    let w = w0
    document.body.classList.add('dnd-active', 'resizing')
    const move = (ev: PointerEvent): void => {
      w = Math.max(120, Math.min(360, w0 + ev.clientX - x0))
      setLiveWidth(w)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      document.body.classList.remove('dnd-active', 'resizing')
      update((c) => (c.window.sidebarWidth = Math.round(w)))
      setLiveWidth(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const addAccount = (): void => {
    const id = `a${Date.now().toString(36)}`
    const n = Object.keys(cfg.accounts).length + 1
    const acc: Account = { id, name: `账号${n}`, remark: '', usage: emptyUsage(), manualUsage: '' }
    update((c) => {
      c.accounts[id] = acc
      c.tabs.find((t) => t.id === activeTab.id)!.accountIds.push(id)
    })
    ensureMounted(id)
  }

  const deleteAccount = async (id: string): Promise<void> => {
    const a = cfg.accounts[id]
    if (!(await window.panel.confirm(`删除账号「${a.name}」？\n会同时清除该账号在本机的登录态，之后需要重新登录。`))) return
    update((c) => {
      delete c.accounts[id]
      c.tabs.forEach((t) => (t.accountIds = t.accountIds.filter((x) => x !== id)))
    })
    await window.panel.clearAccountData(id)
  }

  const deleteTab = async (tabId: string): Promise<void> => {
    if (cfg.tabs.length <= 1) {
      await window.panel.confirm('至少要保留一个组，不能删除最后一个。')
      return
    }
    const t = cfg.tabs.find((x) => x.id === tabId)!
    const tip = t.accountIds.length ? `组内 ${t.accountIds.length} 个账号会移到第一个组，不会被删除。` : '这是一个空组。'
    if (!(await window.panel.confirm(`删除组「${t.name}」？\n${tip}`))) return
    update((c) => {
      const idx = c.tabs.findIndex((x) => x.id === tabId)
      const [removed] = c.tabs.splice(idx, 1)
      c.tabs[0].accountIds.push(...removed.accountIds)
      if (c.window.activeTabId === tabId) c.window.activeTabId = c.tabs[0].id
    })
  }

  const endDrag = (): void => {
    document.body.classList.remove('dnd-active')
    setDrag(null)
  }

  const onDragStart = (e: DragStartEvent): void => {
    document.body.classList.add('dnd-active')
    const id = String(e.active.id)
    if (!id.startsWith('tab:')) setDrag({ id, tabs: structuredClone(cfg.tabs), view: activeTab.id })
  }

  // 拖账号经过某个组名：立刻切过去显示该组，并把这一列先放进该组末尾；
  // 之后在该组的列上移动，由排序动画实时让出位置
  const onDragOver = (e: DragOverEvent): void => {
    const d = dragRef.current
    const over = e.over ? String(e.over.id) : null
    if (!d || !over?.startsWith('tab:')) return
    const target = over.slice(4)
    if (target === d.view) return
    const next = structuredClone(d.tabs)
    next.forEach((t) => (t.accountIds = t.accountIds.filter((x) => x !== d.id)))
    next.find((t) => t.id === target)!.accountIds.push(d.id)
    setDrag({ ...d, tabs: next, view: target })
  }

  const onDragEnd = (e: DragEndEvent): void => {
    const id = String(e.active.id)
    const over = e.over ? String(e.over.id) : null
    const d = dragRef.current
    endDrag()
    // 拖的是组：只在组之间排序
    if (id.startsWith('tab:')) {
      if (!over?.startsWith('tab:') || over === id) return
      update((c) => {
        const from = c.tabs.findIndex((t) => `tab:${t.id}` === id)
        const to = c.tabs.findIndex((t) => `tab:${t.id}` === over)
        if (from >= 0 && to >= 0) c.tabs = arrayMove(c.tabs, from, to)
      })
      return
    }
    if (!d) return
    // 拖的是账号：以预览为准，再按落点列排一下顺序；松手后停在这一列所在的组
    const next = structuredClone(d.tabs)
    const t = next.find((x) => x.id === d.view)!
    if (over && !over.startsWith('tab:') && over !== id) {
      const from = t.accountIds.indexOf(id)
      const to = t.accountIds.indexOf(over)
      if (from >= 0 && to >= 0) t.accountIds = arrayMove(t.accountIds, from, to)
    }
    update((c) => {
      c.tabs = c.tabs.map((x) => ({ ...x, accountIds: next.find((y) => y.id === x.id)?.accountIds ?? x.accountIds }))
      c.window.activeTabId = d.view
    })
  }

  const dragged = drag ? cfg.accounts[drag.id] : null

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDragCancel={endDrag}
    >
      <div className="app">
        {collapsed ? (
          <div className="sidebar-strip" title="展开分组栏" onClick={() => setCollapsed(false)}>
            <span className="strip-arrow">›</span>
          </div>
        ) : (
        <aside className="sidebar" style={{ width: sidebarWidth }}>
          <div className="sidebar-resizer" title="拖动调节宽度" onPointerDown={startResize} />
          <div className="brand">Muse Panel</div>
          <TabBar
            tabs={tabs}
            activeId={activeTab.id}
            busyCount={busyCount}
            onSelect={(id) => update((c) => (c.window.activeTabId = id))}
            onRename={(id, name) => update((c) => (c.tabs.find((t) => t.id === id)!.name = name))}
            onAdd={() =>
              update((c) => {
                const id = `t${Date.now().toString(36)}`
                c.tabs.push({ id, name: `新组${c.tabs.length + 1}`, accountIds: [] })
                c.window.activeTabId = id
              })
            }
            onDelete={(id) => void deleteTab(id)}
            onRefreshGroup={refreshGroup}
          />
          {/* 添加账号：紧跟在「新建组」下方，左右居中 */}
          <div className="add-zone">
            <button className="add-account" title="添加账号" aria-label="添加账号" onClick={addAccount}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="sidebar-foot">
            <button className="collapse-btn" title="收拢分组栏" onClick={() => setCollapsed(true)}>
              <IconSidebar size={24} />
            </button>
          </div>
        </aside>
        )}
        <main className="main">
          <SortableContext items={activeTab.accountIds} strategy={horizontalListSortingStrategy}>
            <div className="columns">
              {accountsInTab.length === 0 && (
                <div className="empty">
                  这个组还没有账号。点左侧分组栏里的灰色圆形 ＋ 按钮，在新出现的列里亲手登录 muse.ai；之后会话会一直保存在本机。
                </div>
              )}
              {/* 按稳定顺序渲染全部账号，用 CSS order 排列，切组/排序都不移动 webview 的 DOM */}
              {Object.values(cfg.accounts).map((a) => (
                <AccountColumn
                  key={a.id}
                  account={a}
                  status={statuses[a.id] ?? null}
                  visible={tabOf[a.id] === activeTab.id}
                  order={activeTab.accountIds.indexOf(a.id)}
                  mounted={mounted.has(a.id)}
                  musePreload={musePreload}
                  homeUrl={cfg.homeUrl}
                  rules={cfg.rules}
                  onChange={(mut) => update((c) => mut(c.accounts[a.id]))}
                  onDelete={() => void deleteAccount(a.id)}
                  usageState={usageState[a.id]}
                  usageFlash={usageFlash[a.id] ?? null}
                  onRefreshUsage={() => void refreshUsage(a.id)}
                />
              ))}
            </div>
          </SortableContext>
        </main>
      </div>
      <DragOverlay modifiers={[snapCenter]} dropAnimation={null}>
        {dragged && (
          <div className="drag-card">
            <div className="drag-card-name">{dragged.name}</div>
            <div className="drag-card-sub">
              {dragged.usage.weeklyPercent != null ? `每周额度 ${dragged.usage.weeklyPercent}% 已用` : '额度未知'}
              {resetLabel(dragged.usage.resetText, dragged.resetTime) && ` · ${resetLabel(dragged.usage.resetText, dragged.resetTime)}`}
            </div>
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
