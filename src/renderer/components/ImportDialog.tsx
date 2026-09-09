import { useRef, useState } from 'react'
import type { EngineView } from '../../shared/contracts'
import { recentHistoryGroups, type HistoryCandidate, type HistoryImportResult, type HistoryScan } from '../../shared/history-import'
import { SetupDialog } from './SetupDialog'
import './import-dialog.css'

type Step = 'sources' | 'select' | 'confirm' | 'progress' | 'partial' | 'done'
type Outcome = { candidate: HistoryCandidate; projectId?: string; result?: HistoryImportResult; error?: string }
export function ImportDialog({ engine, onClose }: { engine: EngineView; onClose(): void }) {
  const [step, setStep] = useState<Step>('sources')
  const [scan, setScan] = useState<HistoryScan | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [limit, setLimit] = useState(20)
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const [error, setError] = useState('')
  const [outcomes, setOutcomes] = useState<Outcome[]>([])
  const [active, setActive] = useState('')
  const groups = recentHistoryGroups(scan?.candidates ?? [], limit)
  const candidates = groups.flatMap(group => group.candidates).filter(candidate => selected.has(candidate.path))
  const imported = outcomes.reduce((sum, outcome) => sum + (outcome.result?.importedCount ?? 0), 0)
  const skipped = outcomes.reduce((sum, outcome) => sum + (outcome.result?.skippedCount ?? 0), 0)
  const failed = outcomes.filter(outcome => outcome.error)
  const discover = async () => {
    if (running.current) return
    running.current = true; setBusy(true); setError('')
    try { setScan(await window.strata.scanEngineHistory()); setSelected(new Set()); setStep('select') }
    catch (failure) { setError(String(failure)) }
    finally { running.current = false; setBusy(false) }
  }
  const runImport = async (retry = false) => {
    if (running.current) return
    running.current = true; setStep('progress'); setBusy(true)
    const pending: Outcome[] = retry ? failed : candidates.map(candidate => ({ candidate }))
    const completed = retry ? outcomes.filter(outcome => outcome.result) : []
    setOutcomes([...completed])
    for (const item of pending) {
      setActive(item.candidate.path)
      let projectId = item.projectId ?? item.candidate.projectId ?? engine.projects.find(project => project.workspaceRoot === item.candidate.path)?.id
      try {
        projectId ??= await window.strata.createEngineProject({ title: item.candidate.title, workspaceRoot: item.candidate.path })
        const result = await window.strata.importEngineHistory({ projectId, expectedWorkspaceRoot: item.candidate.path })
        completed.push({ candidate: item.candidate, projectId, result })
      } catch (failure) { completed.push({ candidate: item.candidate, ...(projectId ? { projectId } : {}), error: String(failure) }) }
      setOutcomes([...completed])
    }
    setActive(''); setStep(completed.some(outcome => outcome.error) ? 'partial' : 'done'); setBusy(false); running.current = false
  }
  const close = () => { if (!running.current) onClose() }
  return <SetupDialog className="history-import-dialog" title="Import existing work" subtitle="Copy history from an existing agent home into Strata." onClose={close} footer={<>
    <button type="button" className="quiet-button" disabled={busy} onClick={() => step === 'select' ? setStep('sources') : step === 'confirm' ? setStep('select') : step === 'done' ? (setOutcomes([]), setStep('sources')) : close()}>{step === 'select' || step === 'confirm' ? 'Back' : step === 'done' ? 'Import more' : step === 'partial' ? 'Open imported work' : 'Cancel'}</button>
    {step === 'sources' && <button className="primary-button" disabled={busy} onClick={() => void discover()}>{busy ? 'Finding projects…' : 'Find projects'}</button>}
    {step === 'select' && <button className="primary-button" disabled={!candidates.length} onClick={() => setStep('confirm')}>Review {candidates.length} {candidates.length === 1 ? 'project' : 'projects'}</button>}
    {step === 'confirm' && <button className="primary-button" onClick={() => void runImport()}>Import conversations</button>}
    {step === 'partial' && <button className="primary-button" onClick={() => void runImport(true)}>Retry failed import</button>}
    {step === 'done' && <button className="primary-button" onClick={close}>Open imported work</button>}
  </>}>
    {error && <p role="alert" className="history-import-notice">{error}</p>}
    {step === 'sources' && <><h3>Find native agent history</h3><div className="history-import-row"><strong>Codex and Claude</strong><small>The engine searches its configured native agent sources.</small></div><p className="history-import-note">History is read on the engine computer. Import copies history without starting an agent.</p></>}
    {step === 'select' && <><h3>Choose projects</h3><label>Show recent projects <select aria-label="Show recent projects" value={limit} onChange={event => { setLimit(Number(event.target.value)); setSelected(new Set()) }}>{[20, 50, 100].map(count => <option key={count} value={count}>{count}</option>)}</select></label><p className="history-import-note">Select folders to import their recent conversations. Counts show discovered history, not a guaranteed import total. The limit applies to projects shown, not to history within a project.</p>{scan?.truncated && <p role="status">Discovery reached the engine's scan limit. Some projects may be missing.</p>}{groups.map(group => <section key={group.key}><h3>{group.title}</h3>{group.candidates.map(candidate => <label className="history-import-row history-import-choice" key={candidate.path}><input type="checkbox" checked={selected.has(candidate.path)} onChange={event => setSelected(previous => { const next = new Set(previous); event.target.checked ? next.add(candidate.path) : next.delete(candidate.path); return next })} /><span><strong>{candidate.title}</strong><small>{candidate.path} · {candidate.sources.map(source => source === 'codex' ? 'Codex' : 'Claude').join(', ')} · {candidate.threadCount} {candidate.threadCount === 1 ? 'conversation' : 'conversations'}</small><small>{candidate.projectId || engine.projects.some(project => project.workspaceRoot === candidate.path) ? 'Existing project at this folder' : 'Create project at this folder'}</small></span></label>)}</section>)}{!groups.length && <p>No native history was found in the configured sources.</p>}</>}
    {step === 'confirm' && <><h3>{candidates.reduce((sum, candidate) => sum + candidate.threadCount, 0)} conversations found across {candidates.length} {candidates.length === 1 ? 'project' : 'projects'}</h3><p>The engine imports recent history for each selected folder, up to 100 conversations and 200 messages per conversation. Its size limits may reduce this further.</p><p className="history-import-note">Source history stays where it is. This is a one-time copy.</p>{candidates.map(candidate => <div className="history-import-row" key={candidate.path}><strong>{candidate.title}</strong><small>Source folder: {candidate.path}</small><small>Destination: {engine.projects.find(project => project.workspaceRoot === candidate.path)?.title ?? `New project ${candidate.title}`} at {candidate.path}</small></div>)}<p className="history-import-notice">Imported conversations are added to their matching project. No agent will be started.</p></>}
    {step === 'progress' && <div role="status"><h3>Importing projects</h3><p>{outcomes.length} of {retryTotal(outcomes, candidates)} projects complete</p><progress aria-label="Import progress" max={retryTotal(outcomes, candidates) || 1} value={outcomes.length} /><p className="history-import-note">Reading {active || 'selected history'}… Keep this dialog open until import finishes.</p></div>}
    {step === 'partial' && <><h3>{imported} imported · {failed.length} {failed.length === 1 ? 'project needs' : 'projects need'} attention</h3>{failed.map(outcome => <p role="alert" className="history-import-notice" key={outcome.candidate.path}>{outcome.candidate.path}: {outcome.error}</p>)}<p className="history-import-note">Retry skips successful projects and conversations already imported.</p></>}
    {step === 'done' && <><h3>{imported} conversations imported</h3><p className="history-import-notice">Imported work is available in Projects.</p><p>{skipped} unchanged conversations skipped</p><p className="history-import-note">No agent was started. Open a conversation to review its history before continuing it.</p></>}
  </SetupDialog>
}
function retryTotal(outcomes: Outcome[], candidates: HistoryCandidate[]): number { return Math.max(outcomes.length, candidates.length) }
