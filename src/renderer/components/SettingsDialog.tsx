import { DefaultModelFields } from './DefaultModelFields'
import { ProjectDefaultsSettings } from './ProjectDefaultsSettings'
import { initialSelection } from '../conversationDrafts'
import { useEffect, useState } from 'react'
import type { EngineView } from '../../shared/contracts'
import { generatedModelSchema, isSettingsRecord, type EngineSettingsPatch, type EngineSupport } from '../../shared/engine-settings'
import { useEngineSettings } from '../useEngineSettings'
import { SetupDialog } from './SetupDialog'
import { Switch } from './Switch'
import { GeneratedModelField } from './GeneratedModelField'
import { BackgroundSettingsDialog } from './BackgroundSettingsDialog'

export function SettingsDialog({ engine, onClose, onConnections }: { engine: EngineView; onClose(): void; onConnections(): void }) {
  const form = useEngineSettings()
  const [scope, setScope] = useState('computer')
  const tabs = (projectDirty = false) => <div className="defaults-tabs" role="tablist" aria-label="Settings scope"><button role="tab" aria-selected={scope === 'computer'} disabled={projectDirty || form.busy || form.dirty} onClick={() => setScope('computer')}>Computer</button>{engine.projects.map(project => <button key={project.id} role="tab" aria-selected={scope === project.id} disabled={projectDirty || form.busy || form.dirty} onClick={() => setScope(project.id)}>{project.title.toLowerCase().endsWith('project') ? project.title : `${project.title} project`}</button>)}</div>
  const [tune, setTune] = useState(false)
  const [support, setSupport] = useState<EngineSupport | null>(null)
  useEffect(() => { let current = true; void window.strata.readEngineSupport().then(value => { if (current) setSupport(value) }).catch(() => { if (current) setSupport({ sourceControl: [], problems: ['Source control readiness is unavailable.'] }) }); return () => { current = false } }, [])
  const settings = form.settings
  const activity = isSettingsRecord(settings?.backgroundActivity) ? settings.backgroundActivity : {}
  const writing = isSettingsRecord(settings?.sourceControlWritingStyle) ? settings.sourceControlWritingStyle : {}
  const generated = generatedModelSchema.safeParse(settings?.textGenerationModelSelection)
  const writer = generatedModelSchema.safeParse(settings?.sourceControlWriterModelSelection)
  const supports = (key: string) => settings !== null && key in settings
  const switchField = (key: 'newWorktreesStartFromOrigin' | 'sidebarAutoSettleOnMerge' | 'enableProviderUpdateChecks', label: string) => supports(key) && typeof settings?.[key] === 'boolean' && <Switch label={label} checked={settings[key]} onChange={value => form.edit({ [key]: value })} />
  if (scope !== 'computer') return <ProjectDefaultsSettings key={scope} engine={engine} projectId={scope} tabs={tabs} onClose={onClose} onConnections={onConnections} />
  if (tune) return <BackgroundSettingsDialog activity={activity} onApply={form.edit} onBack={() => setTune(false)} onClose={onClose} />
  return <SetupDialog title="Settings" subtitle={engine.managed ? "Defaults on this computer. Existing conversations keep their choices." : "Defaults on the connected engine. Existing conversations keep their choices."} onClose={onClose} className="engine-settings-dialog" footer={<><button type="button" className="quiet-button" onClick={onClose}>Cancel</button><button type="button" className="primary-button" disabled={form.busy || !form.dirty} onClick={() => void form.save()}>{form.busy ? 'Saving…' : 'Save changes'}</button></>}>
    {tabs()}
    <section className="settings-connections"><h3>Connections</h3><p>Connect this computer to T3 on your phone, or choose the server that runs your agents.</p><button className="quiet-button" disabled={form.dirty || form.busy} onClick={onConnections}>Connections</button>{form.dirty && <p className="engine-hint">Save your settings changes before opening Connections.</p>}</section>
    {form.error && <div role="alert" className="send-error"><p>{form.error}</p><button className="quiet-button" onClick={() => void form.reload()}>Reload and discard changes</button></div>}
    {!settings && !form.error && <p>Reading engine settings…</p>}
    {settings && <fieldset className="setup-fields" disabled={form.busy}>
      <h3>New conversations</h3>
      {supports('defaultModelSelection') && <>{generatedModelSchema.strip().safeParse(settings.defaultModelSelection).success ? <DefaultModelFields engine={engine} value={generatedModelSchema.strip().parse(settings.defaultModelSelection)} onChange={value => form.edit({ defaultModelSelection: value })} /> : <button className="quiet-button" onClick={() => { const selected = initialSelection(engine, engine.projects[0]?.id ?? ''); if (selected.instanceId) form.edit({ defaultModelSelection: { instanceId: selected.instanceId, model: selected.model, options: selected.options ?? [] } }) }}>Choose default model and thinking</button>}</>}
      {supports('defaultThreadEnvMode') && <label className="setup-field defaults-field">Working copy<select aria-label="New conversations" value={String(settings.defaultThreadEnvMode)} onChange={event => form.edit({ defaultThreadEnvMode: event.target.value as 'local' | 'worktree' })}><option value="local">Current checkout</option><option value="worktree">New worktree</option></select></label>}
      <p className="engine-hint">Applies to new conversations unless a project overrides it.</p>
      {settings.defaultModelSelection != null && <button className="quiet-button" onClick={() => form.edit({ defaultModelSelection: null })}>Reset model and thinking to automatic</button>}
      {settings.defaultThreadEnvMode === 'worktree' && <div className="settings-choice">{switchField('newWorktreesStartFromOrigin', 'Start from origin')}<p className="engine-hint">New worktrees branch from the remote default branch instead of the local one.</p></div>}
      {supports('addProjectBaseDirectory') && <label className="setup-field">Add project starts in<input aria-label="Add project starts in" value={String(settings.addProjectBaseDirectory ?? '')} placeholder="Home folder" onChange={event => form.edit({ addProjectBaseDirectory: event.target.value })} /><small>This folder is on the engine's computer. Blank uses its home folder.</small></label>}
      <h3>Threads</h3>
      {switchField('sidebarAutoSettleOnMerge', 'Auto-settle merged conversations')}
      {supports('sidebarAutoSettleOnMerge') && <p className="engine-hint">Moves merged conversations to Settled. Closed pull requests can still settle automatically.</p>}
      {supports('sidebarAutoSettleAfterDays') && <><Switch label="Auto-settle inactive conversations" checked={settings.sidebarAutoSettleAfterDays !== null} onChange={on => form.edit({ sidebarAutoSettleAfterDays: on ? 3 : null })} />{settings.sidebarAutoSettleAfterDays !== null && <label className="setup-field">Days of inactivity<input aria-label="Days of inactivity" type="number" min="1" max="90" value={Number(settings.sidebarAutoSettleAfterDays)} onChange={event => form.edit({ sidebarAutoSettleAfterDays: Number(event.target.value) })} /></label>}</>}
      {generated.success && <h3>Generated text</h3>}
      {generated.success && <GeneratedModelField label="Text generation model" engine={engine} value={generated.data} onChange={value => form.edit({ textGenerationModelSelection: value })} />}
      {generated.success && <p className="engine-hint">Used for thread titles, branch names, and finding asks in supported agent replies. Source-control writing uses this model unless a separate writer model is selected. Ask scans use low effort and request fast service.</p>}
      {engine.askScanProblem && <p className="engine-hint">{engine.askScanProblem}</p>}
      <details className="setup-advanced"><summary>Advanced</summary>
        {switchField('enableProviderUpdateChecks', 'Provider update checks')}
        {supports('backgroundActivity') && <div className="settings-profile"><label className="setup-field">Background activity profile<select aria-label="Background activity profile" value={String(activity.profile ?? '')} onChange={event => form.edit({ backgroundActivity: { profile: event.target.value as NonNullable<EngineSettingsPatch['backgroundActivity']>['profile'] } })}><option value="balanced">Balanced</option><option value="performance">Performance</option><option value="battery-saver">Battery saver</option><option value="custom">Custom</option></select></label><button type="button" className="quiet-button" onClick={() => setTune(true)}>Tune background activity</button></div>}
        {supports('sourceControlWritingStyle') && <section aria-label="Source control writing"><h3>Source control writing</h3><label className="setup-field">Writing style<select aria-label="Writing style" value={String(writing.mode ?? '')} onChange={event => form.edit({ sourceControlWritingStyle: { mode: event.target.value as 'repo_conventions' | 'conventional_commits' | 'custom' } })}><option value="repo_conventions">Repository conventions</option><option value="conventional_commits">Conventional Commits</option><option value="custom">Custom instructions</option></select></label>{writing.mode === 'custom' && <label className="setup-field">Custom writing instructions<textarea aria-label="Custom writing instructions" value={String(writing.customInstructions ?? '')} onChange={event => form.edit({ sourceControlWritingStyle: { customInstructions: event.target.value } })} /></label>}{typeof writing.followChangeRequestTemplates === 'boolean' && <Switch label="Follow change request templates" checked={writing.followChangeRequestTemplates} onChange={value => form.edit({ sourceControlWritingStyle: { followChangeRequestTemplates: value } })} />}</section>}
        {supports('sourceControlWriterModelSelection') && <><Switch label="Separate writer model" disabled={!generated.success && !writer.success} checked={settings.sourceControlWriterModelSelection !== null} onChange={on => form.edit({ sourceControlWriterModelSelection: on && generated.success ? generated.data : null })} />{writer.success && <GeneratedModelField label="Source control writer model" engine={engine} value={writer.data} onChange={value => form.edit({ sourceControlWriterModelSelection: value })} />}</>}
        <section aria-label="Source control readiness"><h3>Source control readiness</h3>{support?.sourceControl.map(row => <p key={row.label}><strong>{row.label}</strong> · {row.status}{row.account ? ` · ${row.account}` : ''}{row.detail && <small> {row.detail}</small>}</p>)}{support?.problems.map(problem => <p className="engine-hint" key={problem}>{problem}</p>)}<p className="engine-hint">Source control services have their own sign-ins. T3 sign-in does not sign in to GitHub.</p></section>
      </details>
    </fieldset>}
  </SetupDialog>
}
