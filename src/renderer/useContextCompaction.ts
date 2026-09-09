import { useRef, useState } from 'react'
import type { EngineThreadView, EngineView } from '../shared/contracts'
import type { CompactContextInput } from '../shared/context-compaction'
import { selectedProviderCommands, supportsManualCompaction } from '../shared/provider-commands'

/** Shared with the commands menu: capability comes from the one provider catalog. */
export interface CompactContextAction {
  name: 'compact'
  description: string
  disabledReason: string | null
  supported: boolean
  working: boolean
  error: string | null
  execute(): Promise<void>
}
export function useContextCompaction(engine: EngineView, thread: EngineThreadView | undefined, selection: CompactContextInput, cwd: string | undefined): CompactContextAction {
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const inFlight = useRef(false)
  const supported = supportsManualCompaction(selectedProviderCommands(engine.providerCommands ?? [], selection.instanceId ?? thread?.providerInstanceId, thread?.worktreePath ?? cwd))
  const working = submitting || thread?.compaction?.state === 'working'
  const disabledReason = !supported ? 'This agent does not support manual compaction in this workspace.'
    : engine.state !== 'connected' ? 'Reconnect to the engine to compact context.'
    : !thread || thread.messages.length === 0 ? 'Send a message before compacting context.'
    : working ? 'Compacting context…'
    : thread.status === 'running' || thread.status === 'starting' ? 'Wait for the current turn to finish before compacting context.' : null
  return {
    name: 'compact', description: 'Compacts context immediately', supported, working, disabledReason, error,
    async execute() {
      if (disabledReason || !thread || inFlight.current) return
      inFlight.current = true; setSubmitting(true); setError(null)
      try { await window.strata.compactContext(thread.id, selection) }
      catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)) }
      finally { inFlight.current = false; setSubmitting(false) }
    },
  }
}
