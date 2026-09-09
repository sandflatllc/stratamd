import type { EngineActivityView } from '../../shared/contracts'
import { inputPayload } from '../../core/user-input'

export type QuestionFileSource = { kind: 'staged'; id: string; name: string } | { kind: 'attachment'; id: string; name: string; threadId: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** Native answer history retains each question's durable files after its pending request disappears. */
export function UserInputResult({ activity, threadId, onOpenFile }: {
  activity: EngineActivityView; threadId: string; onOpenFile?: (source: QuestionFileSource) => void
}) {
  const payload = inputPayload(activity)
  const dismissed = !('answers' in payload)
  const answers = Object.values(record(payload.answers)).flat().filter(value => typeof value === 'string' && value).join(' · ')
  const groups = Object.entries(record(payload.attachmentsByQuestionId)).flatMap(([questionId, files]) => Array.isArray(files) && files.length ? [{ questionId, files: files.map(record) }] : [])
  return <section className="conversation-request conversation-input-result" data-kind="user-input-result">
    <strong>{dismissed ? 'Question dismissed' : `Answer sent${answers ? ` · ${answers}` : ''}`}</strong>
    {groups.length ? <div className="question-sent-files">{groups.map(({ questionId, files }) => <small key={questionId} aria-label={`Submitted files for ${questionId}`}>
      {groups.length > 1 ? `${String(record(payload.questionTextById)[questionId] ?? questionId)}: ` : 'The agent received your answer and '}
      {files.map((file, index) => <span key={String(file.id)}>{index > 0 ? ', ' : ''}{onOpenFile && /\.(pdf|html?)$/i.test(String(file.name)) ? <button type="button" className="text-action" onClick={() => onOpenFile({ kind: 'attachment', id: String(file.id), name: String(file.name), threadId })}>{String(file.name)}</button> : String(file.name)}</span>)}.
    </small>)}</div> : <small>{dismissed ? 'The agent can continue without an answer.' : 'The agent received your answer.'}</small>}
  </section>
}
