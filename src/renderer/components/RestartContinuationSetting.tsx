import { useEngineSettings } from '../useEngineSettings'
export function RestartContinuationSetting() {
  const { settings, edit, save, busy, error } = useEngineSettings()
  const supported = typeof settings?.continueThreadsAfterServerUpdate === 'boolean'
  return <fieldset className="setup-fields restart-continuation-setting">
    <label className="settings-choice restart-continuation-choice"><input type="checkbox" checked={settings?.continueThreadsAfterServerUpdate === true} disabled={busy || !supported} onChange={event => { edit({ continueThreadsAfterServerUpdate: event.target.checked }); void save() }} /><span>Continue interrupted work after restart<p className="engine-hint">Off by default. When enabled, the engine can continue interrupted work after it restarts.</p></span></label>
    <p className="engine-hint">The engine may start a new turn with a continuation message. Held answers and queued deliveries stay separate.</p>
    {settings && !supported && <p className="engine-hint">This engine does not report restart continuation support.</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>
}
