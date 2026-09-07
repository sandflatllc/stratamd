import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { T3EngineClient } from '../../src/main/engine/client'
import { fakeEngineServer } from './support/fake-engine-socket'
const at='2026-09-03T12:00:00.000Z'
const base={id:'t1',projectId:'p1',title:'Ask test',modelSelection:{instanceId:'codex',model:'gpt-5.6-luna',options:{}},runtimeMode:'full-access',interactionMode:'default',branch:null,worktreePath:null,latestTurn:null as unknown,createdAt:at,updatedAt:at,session:{threadId:'t1',status:'idle',providerName:'codex',providerInstanceId:'codex',runtimeMode:'full-access',activeTurnId:null,lastError:null,updatedAt:at},latestUserMessageAt:at,hasPendingApprovals:false,hasPendingUserInput:false,hasActionableProposedPlan:false}
async function setup() {
  const root=await mkdtemp(join(tmpdir(),'engine-asks-'))
  let sequence=10, source='Which date?', messageId='m1'
  const threads=[structuredClone(base),{...structuredClone(base),id:'t2',session:{...base.session,threadId:'t2'}}]
  const settings={providerInstances:{codex:{driver:'codex',enabled:true,config:{binaryPath:resolve('test/fixtures/ask-codex.cjs')}}},textGenerationModelSelection:{instanceId:'codex',model:'gpt-5.6-luna'}}
  const server=fakeEngineServer(tag=>tag.startsWith('orchestration.subscribe')?[{kind:'synchronized'}]:tag==='server.getConfig'?{settings,providers:[{instanceId:'codex',driver:'codex',displayName:'Codex',enabled:true,installed:true,version:'1',status:'ready',auth:{status:'authenticated',type:'chatgpt'},checkedAt:at,models:[]}]}:null)
  const fetch=vi.fn(async(input:string|URL|Request)=>{
    const url=String(input)
    if(url.endsWith('/oauth/token'))return Response.json({access_token:'secret',issued_token_type:'urn:ietf:params:oauth:token-type:access_token',token_type:'Bearer',expires_in:3600,scope:'orchestration:read orchestration:operate'})
    if(url.endsWith('/api/auth/websocket-ticket'))return Response.json({ticket:'ticket',expiresAt:at})
    if(url.endsWith('/api/orchestration/shell'))return Response.json({snapshotSequence:sequence,projects:[{id:'p1',title:'Project',workspaceRoot:root,defaultModelSelection:null,scripts:[],createdAt:at,updatedAt:at}],threads,updatedAt:at})
    const thread=threads.find(t=>url.endsWith(`/threads/${t.id}`))
    if(thread)return Response.json({snapshotSequence:sequence,thread:{...thread,deletedAt:null,messages:[{id:messageId,role:'assistant',text:source,attachments:[],turnId:(thread.latestTurn as {turnId?:string}|null)?.turnId ?? 'turn',streaming:false,createdAt:at,updatedAt:at}],activities:[],checkpoints:[]},page:{beforeCursor:null,hasMore:false,snapshotSequence:sequence,threadSequence:sequence}})
    return new Response('{}',{status:404})
  }) as typeof globalThis.fetch
  const scan=vi.fn(async(_invocation: unknown, _source: string, _registered: readonly string[], _signal: AbortSignal)=>[] as Array<{quote:string}>)
  const options={dataDirectory:root,fetch,webSocket:server.WebSocket,askRuntime:()=>({executable:process.execPath,baseDirectory:root,directory:root}),scanAsks:scan,publishDelayMs:0}
  const client=new T3EngineClient(options);await client.pair('http://engine.test','code')
  return {client,scan,options,server,root,complete:(id:string,text:string)=>{sequence++;source=text;messageId=`m${sequence}`;const thread=threads.find(t=>t.id===id)!;thread.latestTurn={turnId:`turn${sequence}`,state:'completed',completedAt:at};server.push('orchestration.subscribeShell',[{kind:'thread-upserted',sequence,thread:structuredClone(thread)}])}}
}
it('scans an unfollowed thread on completion, stores zero results, and restores them without a call',async()=>{
  const s=await setup()
  try {
    expect(s.scan).not.toHaveBeenCalled()
    s.complete('t2','Nothing needed.')
    await vi.waitFor(()=>expect(s.scan).toHaveBeenCalledTimes(1))
    await vi.waitFor(()=>expect(s.client.view().projects[0]?.threads.find(t=>t.id==='t2')?.askScan).toMatchObject({state:'done',count:0}))
    await s.client.shutdown()
    const restored=new T3EngineClient(s.options)
    try {await restored.initialize();await restored.openThread('t2');expect(s.scan).toHaveBeenCalledTimes(1);expect(restored.view().projects[0]?.threads.find(t=>t.id==='t2')?.askScan?.state).toBe('done')} finally {await restored.shutdown()}
  } finally {await s.client.shutdown()}
})
it('manual scan uses the selected account and includes original-passage items',async()=>{
  const s=await setup()
  try {
    await s.client.openThread('t1');expect(s.scan).not.toHaveBeenCalled()
    s.scan.mockResolvedValue([{quote:'Which date?'}]);await s.client.runAskScan('t1','m1')
    await vi.waitFor(()=>expect(s.client.view().projects[0]?.threads[0]?.items).toEqual(expect.arrayContaining([expect.objectContaining({inferred:true,quote:'Which date?',askRange:{from:0,to:11}})])))
    const id=s.client.view().projects[0]!.threads[0]!.items![0]!.id
    await s.client.saveAskDraft('t1',id,'Friday')
    expect(s.client.view().projects[0]!.threads[0]!.items![0]!.answerDraft).toBe('Friday')
    expect(s.client.view().projects[0]!.threads[0]!.items![0]!.draftReply).toBeUndefined()
    await s.client.queueItemReply('t1',id,'Friday')
    expect(s.client.view().projects[0]!.threads[0]!.items![0]).toMatchObject({status:'drafted',draftReply:'Friday'})
  } finally {await s.client.shutdown()}
})

it('does not scan historical prose for an unrelated thread event', async () => {
  const s = await setup()
  try {
    await s.client.openThread('t1')
    s.server.push('orchestration.subscribeThread', [{ kind: 'event', event: { sequence: 11, eventId: 'e11', commandId: null, causationEventId: null, correlationId: null, metadata: {}, aggregateKind: 'thread', aggregateId: 't1', type: 'thread.activity-appended', occurredAt: at, payload: { activity: { id: 'a1', tone: 'info', kind: 'test', summary: 'Activity', payload: {}, turnId: null, createdAt: at } } } }])
    await vi.waitFor(() => expect(s.client.view().projects[0]?.threads[0]?.activities).toHaveLength(1))
    await s.client.saveAskDraft('t1', 'missing', 'x').catch(() => undefined)
    expect(s.scan).not.toHaveBeenCalled()
  } finally { await s.client.shutdown() }
})

it('persists scan completion and queued answers without overwriting either', async () => {
  const s = await setup()
  try {
    await s.client.openThread('t1')
    s.scan.mockResolvedValue([{ quote: 'Which date?' }])
    await s.client.runAskScan('t1', 'm1')
    await vi.waitFor(() => expect(s.client.view().projects[0]?.threads[0]?.items).toHaveLength(1))
    const id = s.client.view().projects[0]!.threads[0]!.items![0]!.id
    await s.client.runAskScan('t1', 'm1')
    await s.client.queueItemReply('t1', id, 'Friday')
    await vi.waitFor(() => expect(s.client.view().projects[0]?.threads[0]?.askScan?.state).toBe('done'))
    const saved = JSON.parse(await readFile(join(s.root, 'engine-conversations.json'), 'utf8'))
    expect(saved.threads.t1.asks.m1.state).toBe('done')
    expect(saved.threads.t1.replies[id].text).toBe('Friday')
  } finally { await s.client.shutdown() }
})

it('Send cancels the running scanner without waiting for its delayed result', async () => {
  const s = await setup()
  let finish!: (asks: Array<{ quote: string }>) => void
  try {
    await s.client.openThread('t1')
    s.scan.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
    await s.client.runAskScan('t1', 'm1')
    await vi.waitFor(() => expect(s.scan).toHaveBeenCalledTimes(1))
    const signal = s.scan.mock.calls[0]![3]
    const sending = s.client.startTurn('t1', { text: 'Continue.', model: 'gpt-5.6-luna', effort: 'low', access: 'full-access' }).catch(() => undefined)
    expect(signal.aborted).toBe(true)
    await sending
    finish([{ quote: 'Which date?' }])
    await s.client.shutdown()
    expect(s.client.view().projects[0]?.threads[0]?.items ?? []).toEqual([])
  } finally { finish?.([]); await s.client.shutdown() }
})
