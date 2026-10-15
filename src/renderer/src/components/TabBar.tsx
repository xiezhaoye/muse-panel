import { useEffect, useState } from 'react'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TAB_COLORS, type Tab } from '../../../shared/types'
import { IconPencil, IconTrash } from './icons'


interface Props {
  tabs: Tab[]
  activeId: string | null
  busyCount: Record<string, number>
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
}

// 组既是可拖拽排序的项（id = tab:<id>），也是账号列的落点（把列头拖到组上 = 移组）
function TabItem(p: {
  tab: Tab
  color: string
  active: boolean
  busy: number
  editing: boolean
  onSelect: () => void
  onContext: (e: React.MouseEvent) => void
  onEditDone: (name: string | null) => void
}): React.JSX.Element {
  const sortable = useSortable({ id: `tab:${p.tab.id}`, disabled: p.editing })
  const style: React.CSSProperties = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
    ['--tab-color' as string]: p.color
  }
  const accountOver = sortable.isOver && !String(sortable.active?.id ?? '').startsWith('tab:')
  return (
    <div
      ref={sortable.setNodeRef}
      style={style}
      className={`tab ${p.active ? 'active' : ''} ${accountOver ? 'over' : ''} ${sortable.isDragging ? 'dragging' : ''}`}
      onClick={p.onSelect}
      onContextMenu={p.onContext}
      title="拖动可排序；右键编辑或删除；把账号列头拖到这里可移组"
      {...(p.editing ? {} : sortable.attributes)}
      {...(p.editing ? {} : sortable.listeners)}
    >
      <i className="tab-bar" />
      {p.editing ? (
        <input
          autoFocus
          defaultValue={p.tab.name}
          onClick={(e) => e.stopPropagation()}
          onFocus={(e) => e.target.select()}
          onBlur={(e) => p.onEditDone(e.target.value.trim() || null)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') p.onEditDone(null)
          }}
        />
      ) : (
        <>
          <span className="tab-name">{p.tab.name}</span>
          <span className="tab-count">
            {p.busy > 0 && <i className="dot busy" />}
            {p.tab.accountIds.length}
          </span>
        </>
      )}
    </div>
  )
}

export function TabBar(p: Props): React.JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ctx, setCtx] = useState<{ id: string; x: number; y: number } | null>(null)

  useEffect(() => {
    if (!ctx) return
    const close = (e: Event): void => {
      if (e.type === 'keydown' && (e as KeyboardEvent).key !== 'Escape') return
      if (e.type === 'pointerdown' && (e.target as Element).closest?.('.ctxmenu')) return
      setCtx(null)
    }
    window.addEventListener('pointerdown', close, true)
    window.addEventListener('keydown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', close, true)
      window.removeEventListener('keydown', close)
      window.removeEventListener('blur', close)
    }
  }, [ctx])

  return (
    <nav className="tabbar">
      <SortableContext items={p.tabs.map((t) => `tab:${t.id}`)} strategy={verticalListSortingStrategy}>
        {p.tabs.map((t, i) => (
          <TabItem
            key={t.id}
            tab={t}
            color={t.color ?? TAB_COLORS[i % TAB_COLORS.length]}
            active={t.id === p.activeId}
            busy={p.busyCount[t.id] ?? 0}
            editing={editingId === t.id}
            onSelect={() => p.onSelect(t.id)}
            onContext={(e) => {
              e.preventDefault()
              setCtx({ id: t.id, x: e.clientX, y: e.clientY })
            }}
            onEditDone={(name) => {
              setEditingId(null)
              if (name && name !== t.name) p.onRename(t.id, name)
            }}
          />
        ))}
      </SortableContext>
      <button className="add-tab" onClick={p.onAdd}>
        ＋ 新建组
      </button>
      {ctx && (
        <div className="ctxmenu" style={{ left: ctx.x, top: ctx.y }}>
          <button
            className="menu-item"
            onClick={() => {
              setEditingId(ctx.id)
              setCtx(null)
            }}
          >
            <span className="mi-icon">
              <IconPencil size={16} />
            </span>
            <span className="mi-main">编辑</span>
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              const id = ctx.id
              setCtx(null)
              p.onDelete(id)
            }}
          >
            <span className="mi-icon">
              <IconTrash size={16} />
            </span>
            <span className="mi-main">删除</span>
          </button>
        </div>
      )}
    </nav>
  )
}
