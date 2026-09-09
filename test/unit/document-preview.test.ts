import { expect, it } from 'vitest'
import { documentSourceSchema } from '../../src/shared/documents'

it('allows authorized attachment references and refuses arbitrary local file paths', () => {
  expect(documentSourceSchema.safeParse({ kind: 'local', path: '/tmp/secret.pdf', name: 'secret.pdf' }).success).toBe(false)
  expect(documentSourceSchema.safeParse({ kind: 'staged', id: 'staged-file', name: 'report.pdf' }).success).toBe(true)
  expect(documentSourceSchema.safeParse({ kind: 'attachment', id: 'file', threadId: 'thread', name: 'report.html' }).success).toBe(true)
})
