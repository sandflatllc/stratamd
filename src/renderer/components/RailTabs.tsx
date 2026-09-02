interface RailTab<T extends string> {
  id: T
  label: string
  count?: number
}

interface RailTabsProps<T extends string> {
  label: string
  tabs: readonly RailTab<T>[]
  selected: T
  idPrefix: string
  onSelect(tab: T): void
}

export function RailTabs<T extends string>({ label, tabs, selected, idPrefix, onSelect }: RailTabsProps<T>) {
  const selectAt = (index: number) => {
    const tab = tabs[index]
    if (!tab) return
    onSelect(tab.id)
    window.requestAnimationFrame(() => globalThis.document.getElementById(`${idPrefix}-tab-${tab.id}`)?.focus())
  }
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const current = tabs.findIndex((tab) => tab.id === selected)
    const next = previewTabIndex(current, tabs.length, event.key)
    if (next === null) return
    event.preventDefault()
    selectAt(next)
  }
  return (
    <div className="rail-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <button
          type="button"
          role="tab"
          id={`${idPrefix}-tab-${tab.id}`}
          aria-controls={`${idPrefix}-panel-${tab.id}`}
          aria-selected={selected === tab.id}
          tabIndex={selected === tab.id ? 0 : -1}
          className={`rail-tab ${selected === tab.id ? 'active' : ''}`}
          onClick={() => onSelect(tab.id)}
          key={tab.id}
        >
          {tab.label}
          {tab.count !== undefined && <span className="rail-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  )
}
import { previewTabIndex } from '../model'
