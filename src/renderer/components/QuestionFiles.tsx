import type { ConversationAttachment } from '../../shared/contracts'
import { binaryFileLabel } from '../../core/composer-attachments'
import { visualImageUrl } from '../../shared/visual-urls'

export function QuestionFiles({ files, onRemove, onMarkUp, onOpen }: {
  files: readonly ConversationAttachment[]
  onRemove?(index: number): void
  onMarkUp?(file: ConversationAttachment): void
  onOpen?(file: ConversationAttachment): void
}) {
  return <>{files.map((file, index) => <div className="conversation-attachment-preview" data-kind={file.kind} key={file.kind === 'text' ? `${file.name}:${index}` : file.id}>
    {file.kind === 'image' ? <button type="button" className="conversation-attachment-markup" aria-label={`Mark up ${file.name}`} onClick={() => onMarkUp?.(file)}><img src={visualImageUrl('staged', file.id)} alt={file.name} /></button> : <span aria-hidden="true">{binaryFileLabel(file.name)}</span>}
    <strong title={file.name}>{onOpen && /\.(pdf|html?)$/i.test(file.name) ? <button type="button" className="text-action" onClick={() => onOpen(file)}>{file.name}</button> : file.name}</strong>
    <small>{binaryFileLabel(file.name)} · {Math.ceil((file.kind === 'text' ? new TextEncoder().encode(file.text).length : file.sizeBytes) / 1024)} KB</small>
    {onRemove && <button type="button" aria-label={`Remove ${file.name}`} onClick={() => onRemove(index)}>×</button>}
  </div>)}</>
}
