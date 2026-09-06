// Proposed dialog states for the bundled T3 server plan
// (docs/plans/open/bundled-t3-server-2026-09-05/plan.md), as markup that
// reuses the renderer's existing classes so a capture inside the real app
// shows the real theme, fonts, and dialog chrome. Every state maps to Include
// rows of the plan's settings audit. capture.spec.ts injects these into the
// running app and screenshots them; nothing here is product code.

const X = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-x"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>'
const ARROW_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-arrow-left"><path d="m12 19-7-7 7-7"/><path d="M19 12H5"/></svg>'
const PLUS = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="lucide lucide-plus"><path d="M5 12h14"/><path d="M12 5v14"/></svg>'

/**
 * The only styling the prototype adds: a select that matches the existing
 * input, a two-column setting row, a section heading inside a dialog, and a
 * color swatch row. Production replaces these with real classes.
 */
export const PROTOTYPE_STYLE = `
[data-proto] .modal { animation: none; }
[data-proto] .engine-facts { margin-top: 0; }
[data-proto] .quiet-button { display: inline-flex; align-items: center; gap: 6px; }
.proto-select { width: auto; min-width: 0; border: 1px solid var(--line); border-radius: 8px; padding: 8px 30px 8px 11px; background: var(--surfaces-field) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M3 4.5l3 3 3-3' fill='none' stroke='%23999' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 10px center / 11px; color: var(--text); font: inherit; font-weight: 700; appearance: none; }
.proto-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 18px; padding: 12px 0; border-bottom: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.proto-row:last-child { border-bottom: 0; }
.proto-row > div:first-child strong { display: block; font-weight: 700; }
.proto-row > div:first-child small { display: block; color: var(--dim); font-size: 13px; }
.proto-row input[type="text"], .proto-row input[type="number"] { width: 180px; border: 1px solid var(--line); border-radius: 8px; padding: 8px 11px; background: var(--surfaces-field); color: var(--text); font: inherit; }
.proto-row input.narrow { width: 88px; text-align: right; font-variant-numeric: tabular-nums; }
.proto-section { margin-top: 18px; }
.proto-section h3 { margin: 0 0 4px; font-size: 15px; font-weight: 800; }
.proto-section > p.engine-hint { margin-bottom: 6px; }
.proto-swatches { display: flex; gap: 8px; }
.proto-swatches button { width: 22px; height: 22px; border: 2px solid transparent; border-radius: 50%; padding: 0; cursor: pointer; }
.proto-swatches button[aria-pressed="true"] { border-color: var(--text); }
.proto-env { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
.proto-env > div { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr) auto; align-items: center; gap: 12px; padding: 9px 12px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.proto-env > div:first-child { border-top: 0; }
.proto-env code { font-family: var(--font-code), monospace; font-size: 12.5px; }
.proto-env .proto-secret { color: var(--dim); font-size: 12.5px; font-weight: 700; }
.proto-env .proto-actions { display: flex; gap: 4px; }
.proto-inline { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.proto-status { font-size: 12.5px; font-weight: 700; color: var(--controls-positive); }
.proto-devices { border: 1px solid var(--line); border-radius: 10px; }
.proto-devices > div { display: flex; align-items: center; gap: 12px; padding: 9px 12px; border-top: 1px solid color-mix(in srgb, var(--line) 55%, transparent); }
.proto-devices > div:first-child { border-top: 0; }
.proto-devices strong { flex: 1; font-weight: 700; }
.proto-devices small { color: var(--dim); }
textarea.proto-textarea { width: 100%; min-height: 72px; border: 1px solid var(--line); border-radius: 8px; padding: 9px 11px; background: var(--surfaces-field); color: var(--text); font: inherit; resize: vertical; }
`

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')

export function switchControl(label: string, on: boolean, disabled = false, text = ''): string {
  return `<button type="button" role="switch" class="setup-switch" aria-label="${esc(label)}" aria-checked="${on}"${disabled ? ' disabled' : ''}><span aria-hidden="true"><i></i></span>${text}</button>`
}

export function select(label: string, options: string[], selected: string): string {
  return `<select class="proto-select" aria-label="${esc(label)}">${options.map(option => `<option${option === selected ? ' selected' : ''}>${esc(option)}</option>`).join('')}</select>`
}

export function row(title: string, description: string, control: string): string {
  return `<div class="proto-row"><div><strong>${esc(title)}</strong>${description ? `<small>${esc(description)}</small>` : ''}</div>${control}</div>`
}

export function field(label: string, value: string, placeholder = '', hint = ''): string {
  return `<label class="setup-field">${esc(label)}<input aria-label="${esc(label)}" value="${esc(value)}" placeholder="${esc(placeholder)}">${hint ? `<small>${esc(hint)}</small>` : ''}</label>`
}

export function advanced(summary: string, body: string, open: boolean): string {
  return `<details class="setup-advanced"${open ? ' open' : ''}><summary>${esc(summary)}</summary>${body}</details>`
}

export function tabs(names: string[], selected: string): string {
  return `<div role="tablist" aria-label="Provider settings" class="setup-tabs">${names.map(name => `<button type="button" role="tab" aria-selected="${name === selected}">${esc(name)}</button>`).join('')}</div>`
}

/** A dialog in the SetupDialog shape: header with optional back link, scrolling body, footer. */
export function setupDialog(input: { title: string; subtitle?: string; back?: string; className?: string; body: string; footer: string }): string {
  const back = input.back ? `<button type="button" class="text-action setup-back">${ARROW_LEFT}${esc(input.back)}</button>` : ''
  const subtitle = input.subtitle ? `<p class="modal-subtitle">${esc(input.subtitle)}</p>` : ''
  return `<div class="modal-backdrop" data-proto><section tabindex="-1" class="modal setup-dialog ${input.className ?? ''}" role="dialog" aria-modal="true" aria-label="${esc(input.title)}">
<header class="setup-dialog-header"><div>${back}<h2>${esc(input.title)}</h2>${subtitle}</div><button type="button" class="quiet-button icon-button" aria-label="Close dialog">${X}</button></header>
<div class="setup-dialog-body">${input.body}</div>
<footer class="modal-actions parity-dialog-footer">${input.footer}</footer>
</section></div>`
}

const cancelSave = '<button type="button" class="quiet-button">Cancel</button><button type="button" class="primary-button">Save changes</button>'

function accentRow(selected: number): string {
  const colors = ['#6b7cff', '#3b9cff', '#3dc97c', '#ffb03a', '#ff5c8a', '#9b5cff', '#2fc4c4']
  return row('Accent color', 'Tells this account apart in pickers and model lists.', `<div class="proto-swatches">${colors.map((color, index) => `<button type="button" aria-label="Accent ${index + 1}" aria-pressed="${index === selected}" style="background:${color}"></button>`).join('')}</div>`)
}

function envVars(entries: Array<{ name: string; value?: string; secret?: boolean }>): string {
  const rows = entries.length === 0
    ? '<div><span class="engine-hint">None yet.</span><span></span><span></span></div>'
    : entries.map(entry => `<div><code>${esc(entry.name)}</code>${entry.secret ? '<span class="proto-secret">Saved · hidden</span>' : `<code>${esc(entry.value ?? '')}</code>`}<span class="proto-actions">${entry.secret ? '<button type="button" class="text-action">Replace</button>' : '<button type="button" class="text-action">Edit</button>'}<button type="button" class="text-action">Remove</button></span></div>`).join('')
  return `<div class="proto-section"><h3>Environment variables</h3><p class="engine-hint">Passed to this account’s process only. A secret is kept by the engine and never shown again; Replace and Remove are the only ways to change it.</p><div class="proto-env">${rows}</div><div style="margin-top:8px"><button type="button" class="quiet-button">${PLUS} Add variable</button></div></div>`
}

// Provider configuration, Claude: the current form (name, enabled, binary,
// home, launch arguments) plus the audit's added fields.
export function providerClaude(): string {
  const body = `${tabs(['Configuration', 'Models'], 'Configuration')}
<fieldset class="setup-fields" style="margin-top:18px">
${field('Display name', 'Claude')}
<div class="provider-status"><span>Ready · 8% used</span>${switchControl('Enabled', true, false, 'Enabled')}</div>
<p class="engine-hint">Enabled makes this provider available. Park excludes this login from automatic account selection.</p>
${accentRow(5)}
${envVars([{ name: 'ANTHROPIC_BASE_URL', value: 'https://proxy.example.internal' }, { name: 'ANTHROPIC_AUTH_TOKEN', secret: true }])}
${advanced('Advanced configuration', `${field('Binary path', '', 'claude', 'Blank finds it on PATH.')}${field('Account home path', '~/.claude-work', '', 'Keeps this account’s .claude.json and .claude separate.')}${field('Launch arguments', '')}${field('Auto-compact after', '', 'Claude’s default', 'Tokens, 100,000 to 1,000,000. Blank keeps Claude’s default.')}`, true)}
</fieldset>`
  return setupDialog({ title: 'Claude', subtitle: 'Claude · Ready · 8% used', back: 'Accounts', className: 'provider-setup', body, footer: cancelSave })
}

function generatedText(model: string, effort: string): string {
  return `<div class="proto-inline">${select('Generated text model', ['Codex · Astra', 'Codex · 5.6', 'Claude · Fable 5.1', 'Claude · Sonnet 5'], model)}${select('Effort', ['Low', 'Medium', 'High'], effort)}</div>`
}

// General settings: the audit's General rows. Advanced closed here and open
// in generalAdvanced.
export function general(advancedOpen: boolean): string {
  const advancedBody = `
${row('Provider update checks', 'Look for new provider versions in the background. Installing stays a separate step.', switchControl('Provider update checks', true))}
${row('Background activity', 'How much the engine does while you are away.', `<div class="proto-inline">${select('Background activity', ['Balanced', 'Performance', 'Battery saver', 'Custom'], 'Balanced')}<button type="button" class="text-action">Tune…</button></div>`)}
<div class="proto-section"><h3>Source control writing</h3><p class="engine-hint">How the engine writes commit messages and pull requests.</p>
${row('Style', '', select('Style', ['Repository conventions', 'Conventional Commits', 'Custom instructions'], 'Custom instructions'))}
<label class="setup-field" style="margin-top:8px">Custom instructions<textarea class="proto-textarea" aria-label="Custom instructions">Present tense, one line under 72 characters, no trailing period.</textarea></label>
${row('Follow change request templates', 'Use the repository’s pull request template when one exists.', switchControl('Follow change request templates', true))}
${row('Separate writer model', 'Off uses the generated text model above.', switchControl('Separate writer model', true))}
${row('Writer model', '', generatedText('Claude · Fable 5.1', 'High'))}
</div>`
  const body = `<div class="proto-section" style="margin-top:0"><h3>New conversations</h3>
${row('Start in', 'Where a new conversation works.', select('Start in', ['Current checkout', 'New worktree'], 'New worktree'))}
${row('Start from origin', 'New worktrees branch from the remote default branch instead of the local one.', switchControl('Start from origin', true))}
${row('Add project starts in', 'Blank uses your home folder.', '<input type="text" aria-label="Add project starts in" value="~/Projects">')}
</div>
<div class="proto-section"><h3>Threads</h3>
${row('Settle merged threads', 'Move a thread to Settled when its pull request merges. Closed pull requests settle on their own either way.', switchControl('Settle merged threads', true))}
${row('Settle inactive threads', 'New activity brings a settled thread back.', switchControl('Settle inactive threads', true))}
${row('After this many days', '', '<input type="number" class="narrow" aria-label="Days of inactivity" value="3">')}
</div>
<div class="proto-section"><h3>Generated text</h3><p class="engine-hint">Titles and summaries. This is not the model your conversations use.</p>
${row('Model', '', generatedText('Codex · Astra', 'Low'))}
</div>
${advanced('Advanced', advancedBody, advancedOpen)}`
  return setupDialog({ title: 'Settings', subtitle: 'Defaults for new conversations on this computer.', body, footer: cancelSave })
}

// The background tuning dialog behind Custom, with T3's eight controls.
export function background(): string {
  const seconds = (label: string, value: number) => `<div class="proto-inline"><input type="number" class="narrow" aria-label="${esc(label)}" value="${value}" style="width:88px;border:1px solid var(--line);border-radius:8px;padding:8px 11px;background:var(--surfaces-field);color:var(--text);font:inherit;text-align:right"><span class="engine-hint">seconds</span></div>`
  const body = `
${row('Shared policy', 'Whether background work may run after an interval fires.', select('Shared policy', ['Balanced', 'Performance', 'Battery saver'], 'Balanced'))}
${row('Git fetch interval', 'Refresh remote branch status in the background.', seconds('Git fetch interval', 30))}
${row('Provider health interval', 'Refresh provider availability, versions, sign-in state and model lists. Also refreshes the usage meters in Accounts.', seconds('Provider health interval', 300))}
${row('Host power monitor', 'Poll host power state while a Strata window is open.', seconds('Active host power interval', 30))}
${row('Idle host monitor', 'Poll host power state when no window is open.', seconds('Idle host power interval', 300))}
${row('Pause when locked', '', switchControl('Pause when host is locked', true))}
${row('Pause on host low power', '', switchControl('Pause on host low power', true))}
${row('Pause on client low power', '', switchControl('Pause on client low power', true))}
${row('Pause on battery', '', switchControl('Pause on battery', false))}
<p class="engine-hint" style="margin-top:12px">These gate background probes. A running turn is never paused by them.</p>`
  return setupDialog({ title: 'Background activity', subtitle: 'The shared power policy and the intervals that feed it.', back: 'Settings', body, footer: '<button type="button" class="quiet-button">Reset all</button><button type="button" class="primary-button">Done</button>' })
}

function facts(entries: Array<[string, string, string?]>): string {
  return `<dl class="engine-facts">${entries.map(([term, value, state]) => `<div><dt>${esc(term)}</dt><dd${state ? ` data-state="${state}"` : ''}>${esc(value)}</dd></div>`).join('')}</dl>`
}

function closeBehavior(): string {
  return `<div class="proto-section"><h3>When the last window closes</h3>
${row('Keep running in the tray', 'Agents finish their work and your phone stays connected. Quit from the tray when you want it stopped.', switchControl('Keep running in the tray', true))}
${row('Start at login', 'Off by default.', switchControl('Start at login', false))}
</div>`
}

function advancedConnections(open: boolean): string {
  const body = `
${row('Network access', 'Limited to this machine. On makes the engine reachable on your network after a restart.', switchControl('Enable network access', false))}
${row('Tailscale HTTPS', 'Start Tailscale to set up HTTPS access through MagicDNS.', '<span class="engine-hint">Not running</span>')}
<div class="proto-section"><h3>Pairing links</h3><p class="engine-hint">For another Strata or T3 client. A link works once and expires in ten minutes.</p><button type="button" class="quiet-button">Create link</button></div>
<div class="proto-section"><h3>Paired devices</h3><div class="proto-devices"><div><strong>Pixel 9 · T3 mobile</strong><small>paired Fri, read and send</small><button type="button" class="text-action">Revoke</button></div><div><strong>This Strata</strong><small>manages access</small><span class="engine-hint">Current</span></div></div></div>`
  return advanced('Advanced connections', body, open)
}

// This computer replaces the Engine dialog for the managed local engine:
// status and recovery, T3 Connect, close behavior, advanced connections.
export function thisComputer(state: 'signed-out' | 'connected' | 'stopped'): string {
  const stopped = state === 'stopped'
  const statusFacts = facts([
    ['Engine', 'Bundled T3 0.0.38'],
    ['Status', stopped ? 'Stopped' : 'Connected', stopped ? 'disconnected' : 'connected'],
    ['Address', stopped ? 'Not listening' : '127.0.0.1:41733 · this machine only'],
    ['Data', '~/.local/share/stratamd/engine'],
  ])
  const problem = stopped ? '<p class="engine-problem">The engine stopped on its own at 4:12 PM (exit code 1). Strata restarted it twice in the last minute and paused. Your documents are unaffected.</p>' : ''
  const actions = `<div class="engine-dialog-row"><button type="button" class="${stopped ? 'primary-button' : 'quiet-button'}">Restart engine</button><button type="button" class="quiet-button">Show log</button><button type="button" class="quiet-button">Open T3 in a browser</button></div>`
  const connect = state === 'connected'
    ? `<div class="proto-section"><h3>T3 Connect</h3>
${row('Signed in to T3 as dillon@example.com', 'Environment “Strata on cachyos”. Your provider logins stay on this computer.', '<button type="button" class="text-action">Sign out of T3</button>')}
${row('Remote access', 'Reach this computer from the T3 mobile app.', `<div class="proto-inline"><span class="proto-status">Connected</span>${switchControl('Enable T3 Connect', true)}</div>`)}
${row('Publish agent activity', 'Sends activity to T3 for push notifications on your phone. Works without remote access.', switchControl('Publish agent activity', true))}
</div>`
    : `<div class="proto-section"><h3>T3 Connect</h3><p class="engine-hint">Use your phone with the T3 mobile app. T3 provides the account and the connection. Your provider logins stay on this computer.</p>
<div class="proto-inline" style="margin:10px 0 6px"><button type="button" class="primary-button"${stopped ? ' disabled' : ''}>Sign in to T3</button><span class="engine-hint">Opens T3’s own sign-in in your browser.</span></div>
${row('Publish agent activity', 'Push notifications on your phone. Sign in to T3 first.', switchControl('Publish agent activity', false, true))}
</div>`
  const body = `${statusFacts}${problem}${actions}${connect}${closeBehavior()}${advancedConnections(state === 'connected')}`
  return setupDialog({ title: 'This computer', subtitle: 'The T3 engine Strata runs for you.', body, footer: '<button type="button" class="quiet-button">Accounts</button><button type="button" class="primary-button">Close</button>' })
}
