import { useEffect, useRef, useState } from 'react'
import type { EngineSettings } from '../shared/contracts'
import { isSettingsRecord, type EngineSettingsPatch } from '../shared/engine-settings'

export function mergeSettingsDisplay(base: unknown, patch: unknown): unknown {
  if (!isSettingsRecord(patch)) return patch
  const prior = isSettingsRecord(base) ? base : {}
  return { ...prior, ...Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, mergeSettingsDisplay(prior[key], value)])) }
}
export function useEngineSettings() {
  const [current, setCurrent] = useState<EngineSettings | null>(null)
  const revision = useRef(0)
  const saving = useRef(false)
  const base = useRef<EngineSettings | null>(null)
  const patchRef = useRef<EngineSettingsPatch>({})
  const [patch, setPatch] = useState<EngineSettingsPatch>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    const refresh = async () => {
      if (saving.current) return
      const ticket = ++revision.current
      try {
        const next = await window.strata.readEngineSettings()
        if (!alive || ticket !== revision.current || saving.current) return
        setCurrent(next)
        if (!Object.keys(patchRef.current).length) base.current = next
      } catch (error) { if (alive) setError(String(error)) }
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    window.addEventListener('focus', refresh)
    return () => { alive = false; window.clearInterval(timer); window.removeEventListener('focus', refresh) }
  }, [])
  const edit = (change: EngineSettingsPatch) => {
    const next = mergeSettingsDisplay(patchRef.current, change) as EngineSettingsPatch
    patchRef.current = next; setPatch(next)
  }
  const reload = async () => {
    ++revision.current
    try { const next = await window.strata.readEngineSettings(); base.current = next; patchRef.current = {}; setCurrent(next); setPatch({}); setError('') } catch (error) { setError(String(error)) }
  }
  const save = async () => {
    if (!base.current || busy) return
    saving.current = true; ++revision.current
    setBusy(true); setError('')
    try {
      const next = await window.strata.editEngineSettings({ identity: base.current.identity ?? null, base: base.current, patch: patchRef.current })
      base.current = next; setCurrent(next); patchRef.current = {}; setPatch({})
    } catch (error) { setError(String(error)) } finally { saving.current = false; setBusy(false) }
  }
  return { settings: current ? mergeSettingsDisplay(current, patch) as EngineSettings : null, dirty: Object.keys(patch).length > 0, error, busy, edit, reload, save }
}
