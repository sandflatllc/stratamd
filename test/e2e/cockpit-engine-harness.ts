import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TestInfo } from '@playwright/test'
import { Scenario } from './harness'

const at = '2026-09-03T12:00:00.000Z'

export async function startEngine(): Promise<{ server: Server; origin: string; commands: Array<Record<string, unknown>>; uploads: string[]; setOnline(value: boolean): void; setMessage(value: string): void; finish(): void; close(): Promise<void> }> {
  let online = true
  let message = 'Read-side conversation from T3.'
  let status: 'running' | 'stopped' = 'running'
  let approvalOpen = true
  let inputOpen = true
  const commands: Array<Record<string, unknown>> = []
  const uploads: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    if (!online) {
      response.writeHead(503).end('offline')
      return
    }
    response.setHeader('content-type', 'application/json')
    response.setHeader('x-t3-version', '0.0.33')
    if (request.url === '/api/auth/websocket-ticket' && request.method === 'POST') {
      response.end(JSON.stringify({ ticket: 'test-ticket', expiresAt: new Date(Date.now() + 60_000).toISOString() }))
      return
    }
    if (request.url?.startsWith('/upload/') && request.method === 'PUT') {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => { uploads.push(Buffer.concat(chunks).toString('utf8')); response.end('{}') })
      return
    }
    if (request.url === '/api/orchestration/dispatch' && request.method === 'POST') {
      const chunks: Buffer[] = []
      request.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      request.on('end', () => {
        const command = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        commands.push(command)
        if (command.type === 'thread.turn.start') status = 'running'
        if (command.type === 'thread.turn.interrupt') status = 'stopped'
        if (command.type === 'thread.approval.respond') approvalOpen = false
        if (command.type === 'thread.user-input.respond') inputOpen = false
        response.end(JSON.stringify({ sequence: commands.length + 2 }))
      })
      return
    }
    if (request.url === '/api/orchestration/shell') {
      response.end(JSON.stringify({
        snapshotSequence: 1,
        projects: [{ id: 'p1', title: 'Cockpit project', workspaceRoot: '/tmp/cockpit', defaultModelSelection: null, scripts: [], createdAt: at, updatedAt: at }],
        threads: [
          { id: 't1', projectId: 'p1', title: 'Live engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: at, startedAt: at, completedAt: null, assistantMessageId: 'm1' }, createdAt: at, updatedAt: at, session: { threadId: 't1', status, providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: approvalOpen, hasPendingUserInput: inputOpen, hasActionableProposedPlan: false },
          { id: 't2', projectId: 'p1', title: 'Second engine thread', modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: null, createdAt: at, updatedAt: at, session: { threadId: 't2', status: 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: null, lastError: null, updatedAt: at }, latestUserMessageAt: at, hasPendingApprovals: false, hasPendingUserInput: false, hasActionableProposedPlan: false },
        ],
        updatedAt: at,
      }))
      return
    }
    if (request.url === '/api/orchestration/threads/t1' || request.url === '/api/orchestration/threads/t2') {
      const threadId = request.url.endsWith('/t2') ? 't2' : 't1'
      const threadTitle = threadId === 't2' ? 'Second engine thread' : 'Live engine thread'
      const messageId = threadId === 't2' ? 'm2' : 'm1'
      const activities = [
        ...(approvalOpen ? [{ id: 'a1', tone: 'approval', kind: 'approval.requested', summary: 'Command approval requested', payload: { requestId: 'approval-1', detail: 'Run the cockpit verification?' }, turnId: 'turn-1', createdAt: at }] : [{ id: 'a2', tone: 'approval', kind: 'approval.resolved', summary: 'Approval resolved', payload: { requestId: 'approval-1' }, turnId: 'turn-1', createdAt: at }]),
        ...(inputOpen ? [{ id: 'u1', tone: 'info', kind: 'user-input.requested', summary: 'User input requested', payload: { requestId: 'input-1', questions: [{ id: 'release', question: 'Which release?', options: [{ label: 'Version one' }] }] }, turnId: 'turn-1', createdAt: at }] : [{ id: 'u2', tone: 'info', kind: 'user-input.resolved', summary: 'User input submitted', payload: { requestId: 'input-1' }, turnId: 'turn-1', createdAt: at }]),
        { id: 'tool-1', tone: 'tool', kind: 'tool.completed', summary: 'Updated cockpit files', payload: {}, turnId: 'turn-1', createdAt: at },
      ]
      const sent = commands.filter((command) => command.type === 'thread.turn.start' && command.threadId === threadId).map((command, index) => ({ id: ((command.message as { messageId?: string }).messageId ?? `sent-${index}`), role: 'user', text: (command.message as { text: string }).text, attachments: [], turnId: 'turn-1', streaming: false, createdAt: at, updatedAt: at }))
      response.end(JSON.stringify({ snapshotSequence: commands.length + 2, thread: { id: threadId, projectId: 'p1', title: threadTitle, modelSelection: { instanceId: 'codex', model: 'gpt-5.6', options: { effort: 'medium' } }, runtimeMode: 'full-access', interactionMode: 'default', branch: 'master', worktreePath: null, latestTurn: threadId === 't1' ? { turnId: 'turn-1', state: status === 'running' ? 'running' : 'interrupted', requestedAt: at, startedAt: at, completedAt: null, assistantMessageId: messageId } : null, createdAt: at, updatedAt: at, session: { threadId, status: threadId === 't1' ? status : 'idle', providerName: 'codex', providerInstanceId: 'codex', runtimeMode: 'full-access', activeTurnId: threadId === 't1' && status === 'running' ? 'turn-1' : null, lastError: null, updatedAt: at }, deletedAt: null, messages: threadId === 't1' ? [...sent, { id: messageId, role: 'assistant', text: message, attachments: [], turnId: 'turn-1', streaming: status === 'running', createdAt: at, updatedAt: at }] : [], activities: threadId === 't1' ? activities : [], checkpoints: threadId === 't1' ? [{ turnId: 'turn-1', checkpointTurnCount: 1, checkpointRef: 'ref', status: 'ready', files: [{ path: 'notes/one.md', kind: 'created', additions: 4, deletions: 0 }, { path: 'src/two.ts', kind: 'created', additions: 8, deletions: 0 }], assistantMessageId: messageId, completedAt: at }] : [] }, page: { beforeCursor: null, hasMore: false, snapshotSequence: commands.length + 2, threadSequence: commands.length + 2 } }))
      return
    }
    response.writeHead(404).end('{}')
  })
  server.on('connection', (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket: Socket) => {
    const key = request.headers['sec-websocket-key']
    if (typeof key !== 'string') { socket.destroy(); return }
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.once('data', (chunk) => {
      const frame = Buffer.from(chunk)
      let offset = 2
      let length = frame[1]! & 0x7f
      if (length === 126) { length = frame.readUInt16BE(offset); offset += 2 }
      const mask = frame.subarray(offset, offset + 4); offset += 4
      const payload = Buffer.alloc(length)
      for (let index = 0; index < length; index += 1) payload[index] = frame[offset + index]! ^ mask[index % 4]!
      const rpc = JSON.parse(payload.toString('utf8')) as { id: string }
      const attachmentId = `upload-${uploads.length + 1}`
      const response = Buffer.from(JSON.stringify({ _tag: 'Exit', requestId: rpc.id, exit: { _tag: 'Success', value: { attachmentId, relativeUrl: `/upload/${attachmentId}`, expiresAt: Date.now() + 60_000 } } }))
      const header = response.length < 126
        ? Buffer.from([0x81, response.length])
        : Buffer.from([0x81, 126, response.length >> 8, response.length & 0xff])
      socket.write(Buffer.concat([header, response]))
      setTimeout(() => socket.end(), 25)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fake engine did not bind')
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
    commands,
    uploads,
    setOnline: (value) => { online = value },
    setMessage: (value) => { message = value },
    finish: () => { status = 'stopped' },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export async function seededScenario(testInfo: TestInfo, origin: string, content = '# Engine-safe document\n\nKeep editing while the engine is down.\n', name = 'cockpit-engine.md'): Promise<Scenario> {
  const scenario = await Scenario.create(testInfo, content, name)
  const directory = join(String(scenario.env.XDG_DATA_HOME), 'stratamd')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'engine-credential.json'), `${JSON.stringify({ formatVersion: 1, server: origin, accessToken: 'test-session', expiresAt: Date.now() + 3_600_000 })}\n`, { mode: 0o600 })
  return scenario
}
