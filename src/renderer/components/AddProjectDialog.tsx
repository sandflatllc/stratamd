import { useEffect, useRef, useState } from 'react'
import type { EngineFolderListing, EngineRepository, EngineView } from '../../shared/contracts'
import { joinPath, parentPath, parseGithubRepository, parseGitUrl, repositoryFolderName } from '../../core/project-source'
import { ArrowUpIcon, FolderIcon, GitBranchIcon, GlobeIcon, PlusIcon } from '../icons/lucide'
import { SetupDialog, SourceRow } from './SetupDialog'

type Step = 'sources' | 'local' | 'new-folder' | 'url' | 'github' | 'destination' | 'browse-destination'
export function AddProjectDialog({ engine, onClose, onAdded }: { engine: EngineView; onClose(): void; onAdded?(id: string): void }) {
  const [step, setStep] = useState<Step>('sources')
  const currentStep = useRef(step)
  currentStep.current = step
  const [startFolder, setStartFolder] = useState(engine.projects[0] ? parentPath(engine.projects[0].workspaceRoot) : '~')
  const [folder, setFolder] = useState(startFolder)
  const [listing, setListing] = useState<EngineFolderListing | null>(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState<'url' | 'github'>('url')
  const [repository, setRepository] = useState('')
  const [lookup, setLookup] = useState<EngineRepository | null>(null)
  const [destination, setDestination] = useState('')
  const [clonedPath, setClonedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => {
    let current = true
    void window.strata.readEngineSettings().then((settings) => {
      if (current && settings.addProjectBaseDirectory) { setStartFolder(settings.addProjectBaseDirectory); if (currentStep.current === 'sources') setFolder(settings.addProjectBaseDirectory) }
    }).catch(() => undefined)
    return () => { current = false }
  }, [])
  const browse = async (path: string) => {
    const id = ++sequence.current
    setFolder(path); setListing(null); setBrowsing(true); setError('')
    try {
      const result = await window.strata.browseEngineFolder(`${path.replace(/\/+$/, '')}/`)
      if (alive.current && id === sequence.current) { setListing(result); setFolder(result.parentPath) }
    } catch (failure) { if (alive.current && id === sequence.current) setError(`Cannot browse ${path}: ${String(failure)}`) }
    finally { if (alive.current && id === sequence.current) setBrowsing(false) }
  }
  useEffect(() => {
    if (step === 'local' || step === 'browse-destination') void browse(folder)
    return () => { sequence.current++ }
  }, [step])
  const go = (next: Step) => { setError(''); setStep(next) }
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (failure) { if (alive.current) setError(String(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  const add = async (path: string, create = false) => {
    const id = await window.strata.createEngineProject({ title: repositoryFolderName(path) || 'Project', workspaceRoot: path, ...(create ? { createWorkspaceRootIfMissing: true } : {}) })
    if (alive.current) { onAdded?.(id); onClose() }
  }
  const nextRepository = () => run(async () => {
    const parsed = source === 'github' ? parseGithubRepository(repository) : parseGitUrl(repository)
    if (!parsed) throw new Error(`Enter ${source === 'github' ? 'owner/repository' : 'an HTTPS or SSH clone URL'} for ${repository || 'the repository'}.`)
    const result = source === 'github' ? await window.strata.lookupEngineRepository(parsed) : null
    setLookup(result); setRepository(parsed); setDestination(joinPath(startFolder, repositoryFolderName(result?.nameWithOwner ?? parsed))); setClonedPath(null); go('destination')
  })
  const browser = step === 'local' || step === 'browse-destination'
  const title = { sources: 'Add project', local: 'Add a local folder', 'new-folder': 'Create a project folder', url: 'Clone a repository', github: 'Clone from GitHub', destination: 'Choose the working folder', 'browse-destination': 'Choose destination folder' }[step]
  const back: Step = step === 'new-folder' ? 'local' : step === 'browse-destination' ? 'destination' : step === 'destination' ? source : 'sources'
  return <SetupDialog title={title} subtitle={step === 'sources' ? 'Choose a source on your workstation.' : browser ? 'Browse folders on the paired workstation.' : step === 'new-folder' ? `The folder will be created inside ${folder}.` : step === 'destination' ? 'Clone this repository and add it to Projects.' : 'Enter the repository to clone.'} onClose={onClose} back={step === 'sources' ? undefined : { label: 'Back', action: () => { if (!busy) go(back) } }} footer={<>
    <button type="button" className="quiet-button" onClick={onClose}>Cancel</button>
    {browser && <button type="button" className="primary-button" disabled={busy || browsing || !listing || folder !== listing.parentPath} onClick={() => step === 'browse-destination' ? (setDestination(joinPath(folder, repositoryFolderName(repository))), go('destination')) : void run(() => add(folder))}>{step === 'local' ? 'Add folder' : 'Use this folder'}</button>}
    {step === 'new-folder' && <button type="button" className="primary-button" disabled={busy || !name.trim() || /[\\/]/.test(name) || ['.', '..'].includes(name.trim())} onClick={() => void run(() => add(joinPath(folder, name.trim()), true))}>Create &amp; add</button>}
    {(step === 'url' || step === 'github') && <button type="button" className="primary-button" disabled={busy || !repository.trim()} onClick={() => void nextRepository()}>{busy ? 'Looking up…' : source === 'github' ? 'Look up repository' : 'Continue'}</button>}
    {step === 'destination' && <button type="button" className="primary-button" disabled={busy || !destination.trim()} onClick={() => void run(async () => {
      const path = clonedPath ?? (await window.strata.cloneEngineRepository(source === 'url' ? { remoteUrl: repository, destinationPath: destination.trim() } : { provider: 'github', repository, destinationPath: destination.trim() })).cwd
      setClonedPath(path); await add(path)
    })}>{busy ? 'Adding project…' : clonedPath ? 'Add cloned folder' : 'Create & clone'}</button>}
  </>}>
    <fieldset disabled={busy} className="setup-fields">
      {step === 'sources' && <><SourceRow icon={<FolderIcon />} title="Local folder" description="Browse an existing folder, or create a new one." onClick={() => go('local')} /><SourceRow icon={<GlobeIcon />} title="Git URL" description="Clone a repository from its URL." onClick={() => { setSource('url'); setRepository(''); go('url') }} /><SourceRow icon={<GitBranchIcon />} title="GitHub repository" description="Look up a repository by owner and name." onClick={() => { setSource('github'); setRepository(''); go('github') }} /><p className="engine-hint">Other hosts work through Git URL. GitHub uses the login configured in t3.</p></>}
      {browser && <><nav className="folder-crumb" aria-label="Folder path"><button type="button" className="quiet-button" aria-label="Parent folder" onClick={() => void browse(parentPath(folder))}><ArrowUpIcon /></button>{folder.split('/').map((segment, index, parts) => <button key={index} type="button" className="quiet-button" onClick={() => void browse(parts.slice(0, index + 1).join('/') || '/')}>{segment || '/'}</button>)}</nav><label className="setup-field">Folder path<div className="setup-input-row"><input aria-label="Folder path" value={folder} onChange={(event) => { setFolder(event.target.value); setListing(null) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void browse(folder) } }} /><button type="button" onClick={() => void browse(folder)}>Browse</button></div></label><div className="folder-browser">{browsing ? <p>Loading folders…</p> : listing?.entries.length ? listing.entries.map((entry) => <button type="button" key={entry.fullPath} onClick={() => void browse(entry.fullPath)}><FolderIcon />{entry.name}<span>Open ›</span></button>) : <p>No subfolders.</p>}</div>{step === 'local' && <button type="button" className="quiet-button" disabled={!listing} onClick={() => { setName(''); go('new-folder') }}><PlusIcon /> New folder</button>}</>}
      {step === 'new-folder' && <label className="setup-field">Folder name<input aria-label="Folder name" value={name} onChange={(event) => setName(event.target.value)} /><small>A folder and project will be created when you confirm.</small></label>}
      {(step === 'url' || step === 'github') && <label className="setup-field">{source === 'github' ? 'GitHub repository' : 'Repository URL'}<input aria-label={source === 'github' ? 'GitHub repository' : 'Repository URL'} value={repository} onChange={(event) => setRepository(event.target.value)} placeholder={source === 'github' ? 't3-oss/t3code' : 'https://host/owner/repository.git'} /><small>{source === 'github' ? 'Uses the GitHub login configured in t3.' : 'HTTPS and SSH URLs are supported.'}</small></label>}
      {step === 'destination' && <><div className="setup-result"><GitBranchIcon /><div><strong>{lookup?.nameWithOwner ?? repositoryFolderName(repository)}</strong><small>{lookup ? 'GitHub repository' : repository}</small></div></div><label className="setup-field">Destination on the workstation<div className="setup-input-row"><input aria-label="Clone destination" value={destination} disabled={!!clonedPath} onChange={(event) => setDestination(event.target.value)} /><button type="button" disabled={!!clonedPath} onClick={() => { setFolder(parentPath(destination)); go('browse-destination') }}>Browse…</button></div><small>A new folder will be created here.</small></label></>}
    </fieldset>
    {error && <p className="send-error" role="alert">{error}</p>}
  </SetupDialog>
}
