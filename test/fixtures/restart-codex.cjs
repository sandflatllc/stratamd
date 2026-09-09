#!/usr/bin/env node
// Synthetic local app-server peer. Never loads credentials or contacts a provider.
const fs = require('node:fs')
const readline = require('node:readline')
const crypto = require('node:crypto')
if (process.argv.includes('--version')) { console.log('codex-cli 0.145.0'); process.exit(0) }
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const record = message => { if (process.env.STRATA_RESTART_RECORD) fs.appendFileSync(process.env.STRATA_RESTART_RECORD, JSON.stringify(message) + '\n') }
const threadId = '00000000-0000-4000-8000-000000000001'
readline.createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line)
  const { id, method, params } = message
  if (!method) return
  record({ method, params })
  let result = {}
  if (method === 'initialize') result = { userAgent: 'strata-fixture/1', codexHome: process.env.CODEX_HOME, platformFamily: 'unix', platformOs: 'linux' }
  else if (method === 'account/read') result = { account: { type: 'apiKey' }, requiresOpenaiAuth: false }
  else if (method === 'model/list' || method === 'skills/list') result = { data: [], nextCursor: null }
  else if (method === 'thread/start' || method === 'thread/resume') result = {
    thread: { id: threadId, sessionId: threadId, extra: null, forkedFromId: null, parentThreadId: null, preview: '', ephemeral: false, historyMode: 'legacy', modelProvider: 'openai', createdAt: 1788652800, updatedAt: 1788652800, recencyAt: 1788652800, status: { type: 'idle' }, path: process.cwd() + '/synthetic.jsonl', cwd: process.cwd(), cliVersion: '0.145.0', source: 'vscode', canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] },
    model: 'gpt-5.6', modelProvider: 'openai', serviceTier: 'default', cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()], instructionSources: [], approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: { type: 'dangerFullAccess' }, activePermissionProfile: null, reasoningEffort: 'medium', multiAgentMode: 'explicitRequestOnly',
  }
  else if (method === 'turn/start') {
    const turn = { id: crypto.randomUUID(), items: [], itemsView: 'notLoaded', status: 'inProgress', error: null, startedAt: null, completedAt: null, durationMs: null }
    send({ id, result: { turn } })
    send({ method: 'turn/started', params: { threadId, turn } })
    return
  }
  if (id !== undefined) send({ id, result })
})
