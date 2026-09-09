import { useEffect, useState, type ReactNode } from 'react'
import type { EngineView } from '../../shared/contracts'
import { effectiveDefaults, type ProjectDefaults, type ProjectDefaultsPatch } from '../../shared/project-defaults'
import { initialSelection } from '../conversationDrafts'
import { DefaultModelFields } from './DefaultModelFields'
import { SetupDialog } from './SetupDialog'

export function ProjectDefaultsSettings({ engine, projectId, tabs, onClose, onConnections }: { engine: EngineView; projectId: string; tabs(disabled: boolean): ReactNode; onClose(): void; onConnections(): void }) {
  const [base, setBase] = useState<ProjectDefaults | null>(null)
  const [patch, setPatch] = useState<ProjectDefaultsPatch>({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const reload = async () => { try { setBase(await window.strata.readEngineProjectDefaults(projectId)); setPatch({}); setError('') } catch (error) { setError(error instanceof Error ? error.message : String(error)) } }
  useEffect(() => { void reload() }, [projectId])
  const current = base ? { ...base, ...patch } : null
  const effective = current ? effectiveDefaults(current) : null
  const project = engine.projects.find(value => value.id === projectId)
  const save = async () => {
    if (!base || busy) return
    setBusy(true); setError('')
    try { setBase(await window.strata.editEngineProjectDefaults({ identity: base.identity, projectId, base: { defaultModelSelection: base.defaultModelSelection ?? null, defaultThreadEnvMode: base.defaultThreadEnvMode ?? null }, patch })); setPatch({}) } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { setBusy(false) }
  }
  const overrideModel = () => {
    const initial = initialSelection(engine, projectId)
    const model = effective?.model ?? (initial.instanceId ? { instanceId: initial.instanceId, model: initial.model, options: initial.options ?? [] } : null)
    if (model) setPatch(value => ({ ...value, defaultModelSelection: model }))
  }
  return <SetupDialog title="Settings" subtitle={engine.managed ? 'Defaults on this computer. Existing conversations keep their choices.' : 'Defaults on the connected engine. Existing conversations keep their choices.'} onClose={onClose} className="engine-settings-dialog" footer={<><button className="quiet-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || !Object.keys(patch).length} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button></>}>
    {tabs(busy || Object.keys(patch).length > 0)}
    <section className="settings-connections"><h3>Connections</h3><p>Connect this computer to T3 on your phone, or choose the server that runs your agents.</p><button className="quiet-button" disabled={busy || Object.keys(patch).length > 0} onClick={onConnections}>Connections</button></section>
    {!current && !error && <p>Reading project defaults…</p>}
    {current && effective && <fieldset className="setup-fields" disabled={busy}>
      <h3>New conversations</h3>
      <div className="defaults-row"><div><strong>Account and model</strong><small>{effective.modelSource}</small></div><div>{effective.model ? `${engine.accounts.find(account => account.instanceId === effective.model!.instanceId)?.name ?? effective.model.instanceId} · ${engine.models?.find(model => model.instanceId === effective.model!.instanceId && model.slug === effective.model!.model)?.name ?? effective.model.model}` : 'Automatic'}<button className="quiet-button" onClick={() => current.defaultModelSelection ? setPatch(value => ({ ...value, defaultModelSelection: null })) : overrideModel()}>{current.defaultModelSelection ? 'Reset model and thinking' : 'Override model and thinking'}</button></div></div>
      {current.defaultModelSelection && <DefaultModelFields project engine={engine} value={current.defaultModelSelection} onChange={model => setPatch(value => ({ ...value, defaultModelSelection: model }))} />}
      {!current.defaultModelSelection && <div className="defaults-row"><div><strong>Thinking</strong><small>{current.defaultModelSelection ? 'Saved with account and model' : 'Uses the account and model default'}</small></div><div>{(() => { const selected = effective.model?.options?.find(option => ['effort', 'reasoningEffort'].includes(option.id)); const descriptor = engine.models?.find(model => model.instanceId === effective.model?.instanceId && model.slug === effective.model?.model)?.options.find(option => option.id === selected?.id); return descriptor?.options?.find(option => option.id === selected?.value)?.label ?? String(selected?.value ?? 'Model default') })()}</div></div>}
      <div className="defaults-row"><div><strong>Working copy</strong><small>{effective.environmentSource}</small></div><div>{current.defaultThreadEnvMode ? <select aria-label="Project working copy" value={current.defaultThreadEnvMode} onChange={event => setPatch(value => ({ ...value, defaultThreadEnvMode: event.target.value as 'local' | 'worktree' }))}><option value="local">Current checkout</option><option value="worktree">New worktree</option></select> : effective.environment === 'worktree' ? 'New worktree' : 'Current checkout'}<button className="quiet-button" onClick={() => setPatch(value => ({ ...value, defaultThreadEnvMode: current.defaultThreadEnvMode ? null : effective.environment }))}>{current.defaultThreadEnvMode ? 'Reset working copy' : 'Override working copy'}</button></div></div>

      <p className="engine-hint">Model and thinking are saved together. These choices apply only to new conversations in {project?.title}.</p>

    </fieldset>}
    {error && <div role="alert" className="send-error"><p>{error}</p><button className="quiet-button" onClick={() => void reload()}>Reload and discard changes</button></div>}
  </SetupDialog>
}
