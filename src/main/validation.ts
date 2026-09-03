import { z } from 'zod'

const tableAnnotationContextSchema = z.object({
  kind: z.enum(['table-row', 'table-cell']),
  heading: z.string().max(512).nullable(),
  columns: z.array(z.string().max(512)).min(1).max(100),
  column: z.object({ index: z.number().int().nonnegative().max(99), label: z.string().max(512) }).strict().nullable(),
}).strict()

export const annotationContextSchema = z.union([
  tableAnnotationContextSchema,
  z.object({
    kind: z.literal('screenshot-pin'),
    component: z.literal('AnnotatedScreenshot'),
    componentLine: z.number().int().positive().max(10_000_000),
    image: z.string().min(1).max(16_384),
    pin: z.number().int().positive().max(1_000_000),
  }).strict(),
])
