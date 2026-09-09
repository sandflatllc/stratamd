import { describe, expect, it } from 'vitest'
import { preserveAskAnswers, anchorAsks, askItems, askSourceHash, locateAsk, parseAskOutput } from '../../src/core/asks'
import { emptyConversationState, normalizeConversationsStore } from '../../src/main/engine/conversation-state'
import { inferQuestions } from '../../src/core/inference'
import type { EngineMessageView } from '../../src/shared/contracts'
const message = (id: string, text: string): EngineMessageView => ({ id, text, role: 'assistant', turnId: 'turn', streaming: false, createdAt: '', attachmentCount: 0 })
describe('model found asks', () => {
  it('accepts quote-only and empty results, rejecting invented fields and malformed output', () => {
    expect(parseAskOutput('{"asks":[]}')).toEqual([])
    expect(parseAskOutput('{"asks":[{"quote":"Choose a date."}]}')).toEqual([{quote:'Choose a date.'}])
    expect(() => parseAskOutput('{"asks":[{"quote":"Which?","question":"Which?"}]}')).toThrow()
    expect(() => parseAskOutput('not json')).toThrow()
  })
  it('maps normalized whitespace and quotes back to original UTF-16 offsets after Unicode and Markdown', () => {
    const source = '😀 **Review**\nChoose  “north”\nor south?'
    const range = locateAsk(source, 'Choose "north" or south?')!
    expect(source.slice(range.from,range.to)).toBe('Choose  “north”\nor south?')
    expect(range.from).toBe(source.indexOf('Choose'))
    expect(anchorAsks('m',source,[{quote:'Choose "north" or south?'}])[0]?.id).toBe(anchorAsks('m',source,[{quote:'Choose  “north”\nor south?'}])[0]?.id)
  })
  it('rejects absent/ambiguous quotes and deduplicates spans and registered requests', () => {
    expect(locateAsk('Which? Which?','Which?')).toBeNull()
    expect(locateAsk('Which?','Nope')).toBeNull()
    expect(anchorAsks('m','First? Second?',[{quote:'First?'},{quote:'First?'},{quote:'Second?'}],['First?']).map(a=>a.quote)).toEqual(['Second?'])
  })
  it('retains old draft, pending and answered asks while hiding superseded unanswered requests', () => {
    const state=emptyConversationState(), old=message('m1','First? Second? Third? Fourth? Fifth?')
    const asks=anchorAsks(old.id,old.text,old.text.split(' ').map(quote=>({quote})))
    state.asks={m1:{sourceHash:askSourceHash(old.text),state:'done',asks}}
    state.askDrafts={[asks[0]!.id]:'Still typing'}
    state.replies[asks[1]!.id]={text:'Queued',quote:'Second?',messageId:'m1',kind:'question'}
    state.pending=[{deliveryId:'d',itemIds:[asks[2]!.id],replies:{}}]
    state.answered=[asks[3]!.id]
    expect(askItems([old,message('m2','Done')],'t',state).map(a=>a.quote)).toEqual(['First?','Second?','Third?','Fourth?'])
    old.text='Changed source'
    expect(askItems([old],'t',state).every(a=>a.unavailable)).toBe(true)
  })
  it('preserves saved zero results and only recovers existing legacy identities', () => {
    const state=emptyConversationState(), old=message('m','First? Second?')
    const legacy=inferQuestions(old.id,old.text)
    state.answered=[legacy[0]!.id]
    expect(askItems([old],'t',state).map(a=>a.id)).toEqual([legacy[0]!.id])
    state.asks={empty:{sourceHash:'hash',state:'done',asks:[]}}
    expect(normalizeConversationsStore({formatVersion:1,threads:{t:state}}).threads.t?.asks?.empty).toEqual(state.asks.empty)
  })
})

it('retains an unqueued answer across a rescan and refuses its stale range after source replacement', () => {
  const state = emptyConversationState(), old = message('m', 'Which date?')
  const asks = anchorAsks(old.id, old.text, [{ quote: old.text }])
  state.asks = { m: { sourceHash: askSourceHash(old.text), state: 'done', asks } }
  state.askDrafts = { [asks[0]!.id]: 'Friday' }
  state.asks.m = preserveAskAnswers('m', { sourceHash: askSourceHash('Replaced.'), state: 'done', asks: [] }, state)
  expect(askItems([message('m', 'Replaced.')], 't', state)).toEqual([expect.objectContaining({ id: asks[0]!.id, answerDraft: 'Friday', unavailable: true, askRange: undefined })])
  state.askDrafts = {}
  expect(askItems([old], 't', state)).toEqual([])
})

it('retires saved inference when a matching native request arrives later, without losing an owner draft', () => {
  const state = emptyConversationState(), source = message('m', 'Which date?')
  const asks = anchorAsks(source.id, source.text, [{ quote: source.text }])
  state.asks = { m: { sourceHash: askSourceHash(source.text), state: 'done', asks } }
  const activities = [{ id: 'native', kind: 'user-input.requested', tone: 'info' as const, summary: 'Question', turnId: 'turn', createdAt: '', payload: { requestId: 'native-id', responseMode: 'message', questions: [{ id: 'date', question: 'Which date?' }] } }]
  expect(askItems([source], 't', state, activities)).toEqual([])
  state.askDrafts = { [asks[0]!.id]: 'Friday' }
  expect(askItems([source], 't', state, activities)).toEqual([expect.objectContaining({ answerDraft: 'Friday' })])
})
