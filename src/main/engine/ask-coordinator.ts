import type { AskScanView, EngineThreadView, StoredAskScan } from '../../shared/contracts'
import type { ConversationState } from './conversation-state'
import { anchorAsks, askSource, askSourceHash } from '../../core/asks'
import { nativeQuestionTexts } from '../../core/user-input'
import { AskScanQueue } from './ask-scan'

interface Options {
  thread(id: string): EngineThreadView | undefined
  state(id: string): ConversationState | undefined
  available(): boolean
  save(id: string, messageId: string, record: StoredAskScan, current: () => boolean): Promise<void>
  scan(source: string, registered: string[], signal: AbortSignal): Promise<Array<{ quote: string }>>
  changed(): void
}
type ScanThread = Pick<EngineThreadView, 'id' | 'messages' | 'status' | 'latestTurn'>
function isRunning(thread: ScanThread): boolean {
  return ['running', 'starting'].includes(thread.status) || thread.latestTurn?.state === 'running'
}

export class AskCoordinator {
  readonly #queue = new AskScanQueue()
  readonly #generation = new Map<string, number>()
  readonly #working = new Map<string, AskScanView>()
  readonly #automatic = new Set<string>()
  readonly #observed = new Map<string, string>()
  #epoch = 0
  constructor(private readonly options: Options) {}
  active(threadId: string) { return this.#working.has(threadId) }
  policy(paused: boolean, maintenance: boolean) { this.#queue.policy(paused, maintenance) }
  view(thread: ScanThread): AskScanView | undefined {
    if (!this.options.available()) return undefined
    const message = thread.messages.findLast(m => m.role === 'assistant')
    if (!message || message.streaming || isRunning(thread)) return undefined
    const working = this.#working.get(thread.id)
    if (working?.messageId === message.id) return working
    const saved = this.options.state(thread.id)?.asks?.[message.id]
    const matching = saved?.sourceHash === askSourceHash(askSource(message)) ? saved : undefined
    return { messageId: message.id, state: matching?.state ?? 'cancelled', count: matching?.asks.filter(ask => !ask.retained).length ?? 0, reason: matching?.reason ?? (matching ? undefined : 'Click to scan this reply') }
  }
  observe(threadId: string, automatic: boolean) {
    const thread = this.options.thread(threadId)
    if (!thread) { this.cancel(threadId); return }
    const latest = thread.messages.findLast(m => m.role === 'assistant')
    const signature = latest ? `${latest.id}:${askSourceHash(askSource(latest))}` : ''
    const previous = this.#observed.get(threadId)
    this.#observed.set(threadId, signature)
    if (this.#working.has(threadId) && (previous !== signature || latest?.streaming || isRunning(thread))) this.cancel(threadId)
    if (automatic) this.#automatic.add(threadId)
    if (!this.#automatic.has(threadId) || !latest || latest.streaming || isRunning(thread) || !this.options.available()) return
    if (thread.latestTurn && latest.turnId && latest.turnId !== thread.latestTurn.id) return
    if (this.#working.has(threadId)) return
    const saved = this.options.state(threadId)?.asks?.[latest.id]
    if (saved?.sourceHash === askSourceHash(askSource(latest))) { this.#automatic.delete(threadId); return }
    this.start(threadId, latest.id, false)
  }
  start(threadId: string, messageId: string, manual: boolean) {
    const thread = this.options.thread(threadId)
    const message = thread?.messages.findLast(m => m.role === 'assistant')
    if (!this.options.available() || !thread || !message || message.id !== messageId || message.streaming || isRunning(thread)) throw new Error('This reply is not available to scan.')
    this.cancel(threadId)
    const generation = this.#generation.get(threadId) ?? 0, epoch = this.#epoch, turnId = thread.latestTurn?.id
    const source = askSource(message), sourceHash = askSourceHash(source)
    const registered = (thread.items ?? []).filter(item => !item.inferred && item.messageId === messageId && ['question','decision'].includes(item.kind)).map(item => item.text || item.quote).concat(nativeQuestionTexts(thread.activities ?? [], message.turnId))
    const current = () => {
      const now = this.options.thread(threadId), latest = now?.messages.findLast(m => m.role === 'assistant')
      return epoch === this.#epoch && generation === this.#generation.get(threadId) && now?.latestTurn?.id === turnId && latest?.id === messageId && askSourceHash(askSource(latest)) === sourceHash && !latest.streaming && !isRunning(now!)
    }
    this.#working.set(threadId, { messageId, state: 'working', count: 0, reason: 'Waiting to scan; click to cancel' })
    this.#automatic.delete(threadId)
    const previousAsks = this.options.state(threadId)?.asks?.[messageId]?.asks ?? []
    const reserved: StoredAskScan = { sourceHash, state: 'cancelled', asks: previousAsks, reason: 'Scan interrupted; click to retry' }
    // Reserve before launch so a crash/reconnect does not silently rerun this attempt.
    const reservation = this.options.save(threadId, messageId, reserved, current)
    // A paused job may not consume this promise until much later.
    void reservation.catch(() => undefined)
    this.#queue.enqueue(threadId, manual, async signal => {
      try {
        await Promise.race([reservation, new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })])
        if (!current() || signal.aborted) return
        this.#working.set(threadId, { messageId, state: 'working', count: 0, reason: 'Finding asks; click to cancel' }); this.options.changed()
        const found = await this.options.scan(source, registered, signal)
        if (!current() || signal.aborted) return
        await this.options.save(threadId, messageId, { sourceHash, state: 'done', asks: anchorAsks(messageId, source, found, registered.concat(nativeQuestionTexts(this.options.thread(threadId)?.activities ?? [], message.turnId))) }, current)
      } catch (error) {
        if (current()) await this.options.save(threadId, messageId, { sourceHash, state: 'cancelled', asks: previousAsks, reason: error instanceof Error ? error.message : 'Ask scan failed' }, current)
      } finally {
        if (generation === this.#generation.get(threadId)) { this.#working.delete(threadId); this.options.changed() }
      }
    })
    this.options.changed()
  }
  cancel(threadId: string) {
    const working = this.#working.get(threadId)
    const thread = working ? this.options.thread(threadId) : undefined
    const message = thread?.messages.find(message => message.id === working?.messageId)
    if (message) {
      const epoch = this.#epoch, sourceHash = askSourceHash(askSource(message))
      void this.options.save(threadId, message.id, { sourceHash, state: 'cancelled', asks: this.options.state(threadId)?.asks?.[message.id]?.asks ?? [], reason: 'Scan cancelled; click to retry' }, () => epoch === this.#epoch).catch(() => undefined)
    }
    this.#generation.set(threadId, (this.#generation.get(threadId) ?? 0) + 1)
    this.#queue.cancel(threadId); this.#working.delete(threadId); this.#automatic.delete(threadId)
    if (working) this.options.changed()
  }
  async stop() { this.#epoch++; this.#working.clear(); this.#automatic.clear(); this.#observed.clear(); await this.#queue.stop() }
}
