import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { claimEscape } from '../escape'
import type { ThemePanelGeometry, ThemeView } from '../../shared/contracts'
import { AMBIENT_STYLES, BUILT_IN_THEME_ID, BUNDLED_FONTS, DEFAULT_THEME_VALUES, readSparseValue, THEME_GROUPS, THEME_KEYS, type ThemeGroup, type ThemeKeyEntry } from '../../shared/theme-keys'
import { clampThemePanel } from '../model'
import { AmbientDecor } from './AmbientDecor'

// The theme panel (PRD §6.13): a floating, movable, resizable panel that never
// dims the app. The open document, explorer, and rail are the live preview; the
// sample strip covers constructs the document may lack. It always edits the
// active theme, writes through on every change, and reverts to the snapshot
// taken when it opened.

interface ThemePanelProps {
  theme: ThemeView
  zoom: number
  geometry: ThemePanelGeometry
  onGeometry(geometry: ThemePanelGeometry, commit: boolean): void
  onClose(): void
  onHighlight(sample: string | null): void
  onError(message: string): void
}

const GROUP_LABELS: Record<ThemeGroup, string> = {
  fonts: 'Fonts',
  surfaces: 'Surfaces',
  interface: 'Interface text',
  document: 'Document text',
  controls: 'Controls and status',
  changes: 'Reviewed changes',
  people: 'Authors and outside changes',
  visuals: 'Charts and data',
  effects: 'Decoration and motion'
}

const GROUP_NOTES: Record<ThemeGroup, string> = {
  fonts: 'The two typefaces everything is set in.',
  surfaces: 'The backgrounds and borders every panel is built from.',
  interface: 'Text in the app around the document.',
  document: 'Text inside the document itself.',
  controls: 'Buttons, selections, and status colors.',
  changes: 'Added and removed text under review.',
  people: 'One color per author, so you can see who did what.',
  visuals: 'Table backgrounds, gradients, borders, and the chart series palette.',
  effects: 'The glows, motes, and stars behind everything.'
}

function viewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight }
}

export function ThemePanel({ theme, zoom, geometry, onGeometry, onClose, onHighlight, onError }: ThemePanelProps) {
  const active = theme.active
  const [fonts, setFonts] = useState<string[]>([...BUNDLED_FONTS])
  const [flash, setFlash] = useState<Set<string>>(new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const [open, setOpen] = useState<Set<ThemeGroup>>(new Set(['fonts', 'document', 'people']))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const snapshot = useRef<{ id: string; sparse: Record<string, unknown> } | null>(null)
  const previousValues = useRef(active.values)
  const previousRevision = useRef(theme.externalRevision)
  const throttle = useRef<Map<string, number>>(new Map())
  const root = useRef<HTMLDivElement>(null)

  const run = useCallback((work: () => Promise<unknown>) => {
    void work().catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))
  }, [onError])

  useEffect(() => { run(async () => setFonts(await window.strata.listFonts())) }, [run])

  // Snapshot on open and whenever the active theme changes.
  useEffect(() => {
    if (snapshot.current?.id !== active.id) snapshot.current = { id: active.id, sparse: structuredClone(active.sparse) }
  }, [active.id, active.sparse])

  // Highlight rows an external write changed.
  useEffect(() => {
    if (theme.externalRevision !== previousRevision.current) {
      const changed = THEME_KEYS.filter((entry) => previousValues.current[entry.key] !== active.values[entry.key]).map((entry) => entry.key)
      previousRevision.current = theme.externalRevision
      if (changed.length > 0) {
        setFlash(new Set(changed))
        const timer = window.setTimeout(() => setFlash(new Set()), 2000)
        return () => window.clearTimeout(timer)
      }
    }
    previousValues.current = active.values
    return undefined
  }, [active.values, theme.externalRevision])

  // A geometry change from a key or a window resize is shown at once and written to settings once the burst ends:
  // key repeat and resize events arrive many times a second, and each commit is a settings file write.
  const latestGeometry = useRef(geometry)
  const pendingCommit = useRef<ThemePanelGeometry | null>(null)
  const commitTimer = useRef<number | null>(null)
  const latestOnGeometry = useRef(onGeometry)
  useLayoutEffect(() => { latestGeometry.current = geometry; latestOnGeometry.current = onGeometry })
  const commitPending = useCallback(() => {
    if (commitTimer.current !== null) { window.clearTimeout(commitTimer.current); commitTimer.current = null }
    const pending = pendingCommit.current
    pendingCommit.current = null
    if (pending) latestOnGeometry.current(pending, true)
  }, [])
  const nudge = useCallback((next: ThemePanelGeometry, settle: 'later' | 'on-release') => {
    pendingCommit.current = next
    latestOnGeometry.current(next, false)
    if (settle === 'later') {
      if (commitTimer.current !== null) window.clearTimeout(commitTimer.current)
      commitTimer.current = window.setTimeout(commitPending, 250)
    }
  }, [commitPending])
  useEffect(() => () => commitPending(), [commitPending])

  // Keep the panel inside the window when it resizes.
  useEffect(() => {
    const clamp = (settle: 'now' | 'later') => {
      const current = latestGeometry.current
      const next = clampThemePanel(current, viewport())
      if (next.x === current.x && next.y === current.y && next.width === current.width && next.height === current.height) return
      if (settle === 'now') latestOnGeometry.current(next, true)
      else nudge(next, 'later')
    }
    clamp('now')
    const resized = () => clamp('later')
    window.addEventListener('resize', resized)
    return () => window.removeEventListener('resize', resized)
  }, [nudge])

  const setValue = useCallback((key: string, value: string | number | null, immediate = true) => {
    const now = Date.now()
    if (!immediate && now - (throttle.current.get(key) ?? 0) < 40) return
    throttle.current.set(key, now)
    run(() => window.strata.setThemeValue(key, value))
  }, [run])

  const startDrag = (event: React.PointerEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest('button:not(.theme-panel-grip), input, select')) return
    event.preventDefault()
    const origin = { x: event.clientX, y: event.clientY, panelX: geometry.x, panelY: geometry.y }
    let latest = geometry
    const move = (next: PointerEvent) => {
      latest = clampThemePanel({ ...geometry, x: origin.panelX + next.clientX - origin.x, y: origin.panelY + next.clientY - origin.y }, viewport())
      onGeometry(latest, false)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      onGeometry(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const origin = { x: event.clientX, y: event.clientY, width: geometry.width, height: geometry.height }
    let latest = geometry
    const move = (next: PointerEvent) => {
      latest = clampThemePanel({ ...geometry, width: origin.width + next.clientX - origin.x, height: origin.height + next.clientY - origin.y }, viewport())
      onGeometry(latest, false)
    }
    const finish = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
      onGeometry(latest, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish, { once: true })
    window.addEventListener('pointercancel', finish, { once: true })
  }

  const moveByKey = (event: React.KeyboardEvent<HTMLElement>) => {
    const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
    if (!delta) return
    event.preventDefault()
    nudge(clampThemePanel({ ...geometry, x: geometry.x + delta[0]!, y: geometry.y + delta[1]! }, viewport()), 'on-release')
  }

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !root.current?.contains(document.activeElement)) return
      claimEscape(event)
      commitPending()
      onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose, commitPending])

  const problems = useMemo(() => new Map(active.problems.map((problem) => [problem.key, problem.reason])), [active.problems])
  const locked = active.builtIn
  const revertable = !locked && snapshot.current !== null && JSON.stringify(snapshot.current.sparse) !== JSON.stringify(active.sparse)

  const style: CSSProperties = { left: geometry.x, top: geometry.y, width: geometry.width, height: geometry.height, '--zoom': zoom } as CSSProperties

  return (
    <div ref={root} className="theme-panel" data-pane="themePanel" role="dialog" aria-label="Theme" aria-modal="false" style={style}>
      <header className="theme-panel-header" onPointerDown={startDrag}>
        <button type="button" className="theme-panel-grip" aria-label="Move theme panel (arrow keys)" onKeyDown={moveByKey} onKeyUp={commitPending} onBlur={commitPending}>⋮⋮</button>
        {locked
          ? <strong className="theme-panel-name">{active.name}</strong>
          : <input className="theme-panel-name" aria-label="Theme name" defaultValue={active.name} key={active.id} onBlur={(event) => { const name = event.currentTarget.value.trim(); if (name && name !== active.name) run(() => window.strata.renameTheme(name)) }} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }} />}
        <button type="button" className="text-action" disabled={!revertable} onClick={() => { if (snapshot.current) run(() => window.strata.revertTheme(snapshot.current!.sparse)) }}>Revert to when opened</button>
        <button type="button" className="text-action" aria-label="Close theme panel" onClick={onClose}>Close</button>
      </header>

      <div className="theme-panel-pick">
        <select aria-label="Theme" value={active.id} onChange={(event) => run(() => window.strata.selectTheme(event.target.value))}>
          {theme.available.map((summary) => (
            <option key={summary.id} value={summary.id}>{summary.name}{summary.broken ? ' (broken file)' : summary.missing ? ' (file missing)' : summary.problems.length > 0 ? ` (${summary.problems.length} problem${summary.problems.length === 1 ? '' : 's'})` : ''}</option>
          ))}
        </select>
        <button type="button" className="text-action positive" onClick={() => run(() => window.strata.createTheme(`Copy of ${active.name}`, active.id))}>New from this</button>
        {!locked && (
          <button type="button" className={`text-action theme-delete ${confirmDelete ? 'armed' : ''}`} onClick={() => {
            if (!confirmDelete) { setConfirmDelete(true); return }
            setConfirmDelete(false)
            run(() => window.strata.deleteTheme(active.id))
          }} onBlur={() => setConfirmDelete(false)}>{confirmDelete ? 'Click again to delete' : 'Delete'}</button>
        )}
      </div>
      {locked && <p className="theme-panel-note">{active.id === BUILT_IN_THEME_ID ? 'Built-in theme.' : 'Bundled theme.'} Use New from this to make an editable copy.</p>}
      {active.missing && <p className="theme-panel-note">This theme's file was removed. Its last values stay until you pick another theme.</p>}
      {problems.has('file') && <p className="theme-panel-note">The file is not valid JSON ({problems.get('file')}). Setting any value rewrites it.</p>}

      <div className="theme-panel-scroll">
        <ChromeStrip highlight={hovered} />
        {THEME_GROUPS.map((group) => (
          <section className="theme-group" key={group} data-open={open.has(group)}>
            <button type="button" className="theme-group-title" aria-expanded={open.has(group)} onClick={() => setOpen((previous) => { const next = new Set(previous); if (next.has(group)) next.delete(group); else next.add(group); return next })}>
              <span className="disclosure">{open.has(group) ? '▾' : '▸'}</span> {GROUP_LABELS[group]}
            </button>
            {open.has(group) && <p className="theme-group-note">{GROUP_NOTES[group]}</p>}
            {open.has(group) && THEME_KEYS.filter((entry) => entry.group === group && (entry.key !== 'surfaces.transcript-shadow-strength' || (active.values['surfaces.transcript-style'] === 'panel' && active.values['surfaces.transcript-shadow-style'] === 'drop-shadow')) && (entry.key !== 'visuals.table-background-end' || active.values['visuals.table-style'] === 'gradient') && (entry.key !== 'effects.side-window-opacity' || active.values['effects.side-window-style'] === 'glass')).map((entry) => (
              <Row
                key={entry.key}
                entry={entry}
                value={active.values[entry.key] ?? DEFAULT_THEME_VALUES[entry.key]!}
                isSet={readSparseValue(active.sparse, entry.key) !== undefined}
                problem={problems.get(entry.key)}
                locked={locked}
                flash={flash.has(entry.key)}
                fonts={fonts}
                onHover={(sample) => { setHovered(sample); onHighlight(sample) }}
                onChange={setValue}
              />
            ))}
          </section>
        ))}
      </div>
      <button type="button" className="theme-panel-resize" aria-label="Resize theme panel" title="Drag to resize. Arrow keys adjust width and height." onPointerDown={startResize} onKeyUp={commitPending} onBlur={commitPending} onKeyDown={(event) => {
        const delta = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[event.key]
        if (!delta) return
        event.preventDefault()
        nudge(clampThemePanel({ ...geometry, width: geometry.width + delta[0]!, height: geometry.height + delta[1]! }, viewport()), 'on-release')
      }} />
    </div>
  )
}

interface RowProps {
  entry: ThemeKeyEntry
  value: string | number
  isSet: boolean
  problem: string | undefined
  locked: boolean
  flash: boolean
  fonts: string[]
  onHover(sample: string | null): void
  onChange(key: string, value: string | number | null, immediate?: boolean): void
}

function Row({ entry, value, isSet, problem, locked, flash, fonts, onHover, onChange }: RowProps) {
  const id = `theme-${entry.key.replace('.', '-')}`
  const control = (() => {
    switch (entry.kind) {
      case 'color':
        return (
          <>
            <input id={id} type="color" value={String(value)} disabled={locked} aria-label={entry.label} onInput={(event) => onChange(entry.key, event.currentTarget.value, false)} onChange={(event) => onChange(entry.key, event.currentTarget.value)} />
            <code className="theme-hex">{String(value)}</code>
          </>
        )
      case 'font': {
        const installed = fonts.includes(String(value))
        return (
          <>
            <input id={id} list={`${id}-fonts`} value={String(value)} disabled={locked} aria-label={entry.label} onChange={(event) => { const family = event.currentTarget.value.trim(); if (family) onChange(entry.key, family) }} />
            <datalist id={`${id}-fonts`}>{fonts.map((family) => <option key={family} value={family} />)}</datalist>
            {!installed && <small className="theme-row-mark">(not installed)</small>}
          </>
        )
      }
      case 'style':
        return (
          <select id={id} value={String(value)} disabled={locked} aria-label={entry.label} onChange={(event) => onChange(entry.key, event.currentTarget.value)}>
            {(entry.options ?? AMBIENT_STYLES).map((style) => <option key={style.id} value={style.id}>{style.label}</option>)}
          </select>
        )
      case 'range':
        return (
          <>
            <input id={id} type="range" min={entry.min} max={entry.max} step={entry.step} value={Number(value)} disabled={locked} aria-label={entry.label} aria-valuetext={entry.unit === 'percent' ? `${Math.round(Number(value) * 100)}%` : undefined} onInput={(event) => onChange(entry.key, Number(event.currentTarget.value), false)} onChange={(event) => onChange(entry.key, Number(event.currentTarget.value))} />
            <code className="theme-hex">{entry.unit === 'percent' ? `${Math.round(Number(value) * 100)}%` : Number(value).toFixed(2)}</code>
          </>
        )
    }
  })()
  return (
    <div className={`theme-row ${isSet ? 'is-set' : 'is-default'} ${flash ? 'flash' : ''}`} data-key={entry.key} onMouseEnter={() => onHover(entry.sample ?? null)} onMouseLeave={() => onHover(null)}>
      <label htmlFor={id}>{entry.label}</label>
      <div className="theme-row-control">{control}</div>
      {problem && <small className="theme-row-problem" title={problem}>!</small>}
      {isSet && !locked ? <button type="button" className="text-action theme-row-default" onClick={() => onChange(entry.key, null)}>Use default</button> : <small className="theme-row-mark">{isSet ? '' : 'default'}</small>}
      <small className="theme-row-target">{entry.description}</small>
    </div>
  )
}

/**
 * The states the open document may not be showing right now: attribution,
 * controls, review colors, popovers, inner surfaces. Hovering a row lights up
 * the matching example here alongside the real targets in the app.
 */
function ChromeStrip({ highlight }: { highlight: string | null }) {
  const sample = (name: string) => ({ 'data-sample': name, 'data-sample-active': highlight === name || undefined })
  return (
    <div className="theme-chrome island" {...sample('surfaces-panel')}>
      <AmbientDecor variant="agents" />
      <span className="theme-sample-chip theme-sample-transcript" {...sample('surfaces-transcript')} style={{ background: 'var(--surfaces-transcript)', border: '1px solid var(--surfaces-transcript-border)', color: 'var(--document-body)' }}><span {...sample('surfaces-transcript-shadow')}><span {...sample('surfaces-transcript-border')}>reading panel</span></span></span>
      <span className="annotation-chip" {...sample('people-you')} style={{ color: 'var(--people-you)', background: 'color-mix(in srgb, var(--people-you) 20%, transparent)' }}>you</span>
      {[1, 2, 3, 4].map((slot) => <span className="agent-avatar" {...sample(`people-agent-${slot}`)} style={{ background: `var(--people-agent-${slot})`, color: `var(--people-agent-${slot}-text)` }} key={slot}>A{slot}</span>)}
      <span className="annotation-chip" {...sample('people-external')} style={{ color: 'var(--people-external)', background: 'color-mix(in srgb, var(--people-external) 25%, transparent)' }}>outside</span>
      <span className="theme-sample-chip theme-sample-primary" {...sample('controls-primary')}>button</span>
      <span className="theme-sample-chip theme-sample-primary-highlight" {...sample('controls-primary-highlight')}>send</span>
      <span className="theme-sample-chip theme-sample-selected" {...sample('controls-selected')}>selected</span>
      <span className="theme-sample-chip theme-sample-positive" {...sample('controls-positive')}>keep</span>
      <span className="theme-sample-chip theme-sample-warning" {...sample('controls-warning')}>warning</span>
      <span className="theme-sample-chip theme-sample-danger" {...sample('controls-danger')}>delete</span>
      <span className="theme-sample-chip theme-sample-focus" {...sample('controls-focus')}>focus</span>
      <span className="theme-sample-chip theme-sample-added" {...sample('changes-added')}>added</span>
      <span className="theme-sample-chip theme-sample-removed" {...sample('changes-removed')}>removed</span>
      <span className="theme-sample-chip theme-sample-inset" {...sample('surfaces-inset')}>inset</span>
      <span className="theme-sample-chip theme-sample-overlay" {...sample('surfaces-overlay')}>popover</span>
      <span className="theme-sample-chip theme-sample-field" {...sample('surfaces-field')}>field</span>
      <span className="theme-sample-interface-primary" {...sample('interface-primary')}>title</span>
      <span className="theme-sample-interface-body" {...sample('interface-body')}>body</span>
      <span className="theme-sample-interface-secondary" {...sample('interface-secondary')}>quiet</span>
      <span className="theme-sample-interface-muted" {...sample('interface-muted')}>fine print</span>
      <span className="theme-sample-border" {...sample('surfaces-border')} />
    </div>
  )
}
