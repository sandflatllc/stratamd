import { useEffect, useState } from 'react'
import type { EngineView } from '../../shared/contracts'
import { generatedModelSchema, isSettingsRecord, type EngineSettingsPatch, type EngineSupport } from '../../shared/engine-settings'
import { useEngineSettings } from '../useEngineSettings'
import { SetupDialog } from './SetupDialog'
import { Switch } from './Switch'
import { GeneratedModelField } from './GeneratedModelField'
import { BackgroundSettingsDialog } from './BackgroundSettingsDialog'

export function SettingsDialog({ engine, onClose }: { engine: EngineView; onClose(): void }) {
  const form = useEngineSettings()
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
  if (tune) return <BackgroundSettingsDialog activity={activity} onApply={form.edit} onBack={() => setTune(false)} onClose={onClose} />
  return <SetupDialog title="Settings" subtitle="Defaults on the connected engine. Existing conversations keep their choices." onClose={onClose} className="engine-settings-dialog" footer={<><button type="button" className="quiet-button" onClick={onClose}>Close</button><button type="button" className="primary-button" disabled={form.busy || !form.dirty} onClick={() => void form.save()}>{form.busy ? 'Saving…' : 'Save changes'}</button></>}>
    {form.error && <div role="alert" className="send-error"><p>{form.error}</p><button className="quiet-button" onClick={() => void form.reload()}>Reload and discard changes</button></div>}
    {!settings && !form.error && <p>Reading engine settings…</p>}
    {settings && <fieldset className="setup-fields" disabled={form.busy}>
      {supports('defaultThreadEnvMode') && <label className="setup-field">New conversations<select aria-label="New conversations" value={String(settings.defaultThreadEnvMode)} onChange={event => form.edit({ defaultThreadEnvMode: event.target.value as 'local' | 'worktree' })}><option value="local">Local</option><option value="worktree">New worktree</option></select></label>}
      {settings.defaultThreadEnvMode === 'worktree' && switchField('newWorktreesStartFromOrigin', 'Start from origin')}
      {supports('addProjectBaseDirectory') && <label className="setup-field">Add project starts in<input aria-label="Add project starts in" value={String(settings.addProjectBaseDirectory ?? '')} placeholder="Home folder" onChange={event => form.edit({ addProjectBaseDirectory: event.target.value })} /><small>This folder is on the engine's computer. Blank uses its home folder.</small></label>}
      {switchField('sidebarAutoSettleOnMerge', 'Auto-settle merged conversations')}
      {supports('sidebarAutoSettleOnMerge') && <p className="engine-hint">Closed pull requests can still settle automatically.</p>}
      {supports('sidebarAutoSettleAfterDays') && <><Switch label="Auto-settle inactive conversations" checked={settings.sidebarAutoSettleAfterDays !== null} onChange={on => form.edit({ sidebarAutoSettleAfterDays: on ? 3 : null })} />{settings.sidebarAutoSettleAfterDays !== null && <label className="setup-field">Days of inactivity<input aria-label="Days of inactivity" type="number" min="1" max="90" value={Number(settings.sidebarAutoSettleAfterDays)} onChange={event => form.edit({ sidebarAutoSettleAfterDays: Number(event.target.value) })} /></label>}</>}
      {generated.success && <GeneratedModelField label="Generated text model" engine={engine} value={generated.data} onChange={value => form.edit({ textGenerationModelSelection: value })} />}
      {generated.success && <p className="engine-hint">Used for titles and other generated text. Choose the model and effort manually.</p>}
      <details className="setup-advanced"><summary>Advanced</summary>
        {switchField('enableProviderUpdateChecks', 'Provider update checks')}
        {supports('backgroundActivity') && <><label className="setup-field">Background activity profile<select aria-label="Background activity profile" value={String(activity.profile ?? '')} onChange={event => form.edit({ backgroundActivity: { profile: event.target.value as NonNullable<EngineSettingsPatch['backgroundActivity']>['profile'] } })}><option value="balanced">Balanced</option><option value="performance">Performance</option><option value="battery-saver">Battery saver</option><option value="custom">Custom</option></select></label><button type="button" className="quiet-button" onClick={() => setTune(true)}>Tune background activity</button></>}
        {supports('sourceControlWritingStyle') && <section aria-label="Source control writing"><h3>Source control writing</h3><label className="setup-field">Writing style<select aria-label="Writing style" value={String(writing.mode ?? '')} onChange={event => form.edit({ sourceControlWritingStyle: { mode: event.target.value as 'repo_conventions' | 'conventional_commits' | 'custom' } })}><option value="repo_conventions">Repository conventions</option><option value="conventional_commits">Conventional Commits</option><option value="custom">Custom instructions</option></select></label>{writing.mode === 'custom' && <label className="setup-field">Custom writing instructions<textarea aria-label="Custom writing instructions" value={String(writing.customInstructions ?? '')} onChange={event => form.edit({ sourceControlWritingStyle: { customInstructions: event.target.value } })} /></label>}{typeof writing.followChangeRequestTemplates === 'boolean' && <Switch label="Follow change request templates" checked={writing.followChangeRequestTemplates} onChange={value => form.edit({ sourceControlWritingStyle: { followChangeRequestTemplates: value } })} />}</section>}
        {supports('sourceControlWriterModelSelection') && <><Switch label="Separate source control writer model" disabled={!generated.success && !writer.success} checked={settings.sourceControlWriterModelSelection !== null} onChange={on => form.edit({ sourceControlWriterModelSelection: on && generated.success ? generated.data : null })} />{writer.success && <GeneratedModelField label="Source control writer model" engine={engine} value={writer.data} onChange={value => form.edit({ sourceControlWriterModelSelection: value })} />}</>}
        <section aria-label="Source control readiness"><h3>Source control readiness</h3>{support?.sourceControl.map(row => <p key={row.label}><strong>{row.label}</strong> · {row.status}{row.account ? ` · ${row.account}` : ''}{row.detail && <small> {row.detail}</small>}</p>)}{support?.problems.map(problem => <p className="engine-hint" key={problem}>{problem}</p>)}<p className="engine-hint">Source control services have their own sign-ins. T3 sign-in does not sign in to GitHub.</p></section>
      </details>
    </fieldset>}
  </SetupDialog>
}
