import { expect, it, vi } from 'vitest'
import { AskCoordinator } from '../../src/main/engine/ask-coordinator'
import { emptyConversationState } from '../../src/main/engine/conversation-state'
import type { EngineThreadView } from '../../src/shared/contracts'
const message=(id:string,text='Which date?')=>({id,text,role:'assistant' as const,turnId:'turn',streaming:false,createdAt:'',attachmentCount:0})
function setup() {
  let thread={id:'t',status:'idle',messages:[message('m1')],items:[]} as unknown as EngineThreadView
  const state=emptyConversationState(), scan=vi.fn(async(_source:string,_registered:string[],_signal:AbortSignal)=>[{quote:'Which date?'}])
  const changed = vi.fn()
  const coordinator=new AskCoordinator({thread:()=>thread,state:()=>state,available:()=>true,scan,changed,save:async(_id,messageId,record,current)=>{if(current())state.asks={...state.asks,[messageId]:record}}})
  return {coordinator,state,scan,changed,get thread(){return thread},setThread:(next:EngineThreadView)=>thread=next}
}
it('leaves historical replies manual, saves zero results, and never rescans them on a snapshot',async()=>{
  const s=setup();s.coordinator.observe('t',false);expect(s.scan).not.toHaveBeenCalled()
  s.scan.mockResolvedValue([]);s.coordinator.start('t','m1',true)
  await vi.waitFor(()=>expect(s.coordinator.view(s.thread)).toMatchObject({state:'done',count:0}))
  s.coordinator.observe('t',true);expect(s.scan).toHaveBeenCalledTimes(1)
  await s.coordinator.stop()
})
it('does not scan interim messages in running turns',async()=>{
  const s=setup();s.setThread({...s.thread,status:'running'})
  s.coordinator.observe('t',true);expect(s.scan).not.toHaveBeenCalled()
  s.setThread({...s.thread,status:'idle'});s.coordinator.observe('t',true)
  await vi.waitFor(()=>expect(s.coordinator.view(s.thread)?.state).toBe('done'))
  await s.coordinator.stop()
})
it('rejects an old result after cancellation and a new reply',async()=>{
  const s=setup();let finish!:(asks:Array<{quote:string}>)=>void
  s.scan.mockImplementationOnce(()=>new Promise(resolve=>finish=resolve))
  s.coordinator.observe('t',true)
  await vi.waitFor(()=>expect(s.scan).toHaveBeenCalledTimes(1))
  s.coordinator.cancel('t');s.setThread({...s.thread,messages:[...s.thread.messages,message('m2','Choose a color.')]})
  finish([{quote:'Which date?'}])
  await s.coordinator.stop()
  expect(s.state.asks?.m1?.state).toBe('cancelled')
  expect(s.state.asks?.m1?.asks).toEqual([])
})
it('keeps owner cancellation on later duplicate events',async()=>{
  const s=setup();s.coordinator.policy(true,false)
  s.coordinator.observe('t',true);s.coordinator.cancel('t')
  s.coordinator.observe('t',true);s.coordinator.policy(false,false)
  expect(s.coordinator.view(s.thread)?.state).toBe('cancelled')
  expect(s.scan).not.toHaveBeenCalled()
  await s.coordinator.stop()
})
it('allows separate prose requests beside registered explicit requests',async()=>{
  const s=setup();s.setThread({...s.thread,items:[{inferred:false,messageId:'m1',kind:'question',text:'Which account?',quote:'Which account? Which date?'} as never]})
  s.coordinator.observe('t',true)
  await vi.waitFor(()=>expect(s.scan).toHaveBeenCalled())
  expect(s.scan.mock.calls[0]?.[1]).toEqual(['Which account?'])
  await s.coordinator.stop()
})

it('waits for the turn to settle even if the session appears idle', async () => {
  const s = setup()
  s.setThread({ ...s.thread, latestTurn: { id: 'turn', state: 'running', startedAt: null, completedAt: null } })
  s.coordinator.observe('t', true)
  expect(s.coordinator.view(s.thread)).toBeUndefined()
  expect(s.scan).not.toHaveBeenCalled()
  s.setThread({ ...s.thread, latestTurn: { ...s.thread.latestTurn!, state: 'completed' } })
  s.coordinator.observe('t', false)
  await vi.waitFor(() => expect(s.coordinator.view(s.thread)?.state).toBe('done'))
  await s.coordinator.stop()
})

it('rejects a result after the source changes under the same message id', async () => {
  const s = setup()
  let finish!: (asks: Array<{ quote: string }>) => void
  s.scan.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  s.coordinator.observe('t', true)
  await vi.waitFor(() => expect(s.scan).toHaveBeenCalledTimes(1))
  s.setThread({ ...s.thread, messages: [message('m1', 'Changed question?')] })
  finish([{ quote: 'Which date?' }])
  await s.coordinator.stop()
  expect(s.state.asks?.m1?.asks).toEqual([])
})

it('does not publish unchanged scan state during repeated Send cancellation', async () => {
  const s = setup()
  s.coordinator.observe('t', false)
  s.coordinator.cancel('t')
  s.coordinator.cancel('t')
  expect(s.changed).not.toHaveBeenCalled()
  await s.coordinator.stop()
})

it('excludes a native question from prose inference, including native requests arriving during scanning', async () => {
  const s = setup()
  let finish!: (asks: Array<{ quote: string }>) => void
  s.scan.mockImplementationOnce(() => new Promise(resolve => finish = resolve))
  s.coordinator.observe('t', true)
  await vi.waitFor(() => expect(s.scan).toHaveBeenCalledTimes(1))
  s.setThread({ ...s.thread, activities: [{ id: 'native', kind: 'user-input.requested', tone: 'info', summary: 'Question', turnId: 'turn', createdAt: '', payload: { requestId: 'stable-native-id', responseMode: 'message', questions: [{ id: 'date', question: 'Which date?' }] } }] })
  finish([{ quote: 'Which date?' }])
  await vi.waitFor(() => expect(s.coordinator.view(s.thread)).toMatchObject({ state: 'done', count: 0 }))
  expect(s.state.asks?.m1?.asks).toEqual([])
  await s.coordinator.stop()
})
