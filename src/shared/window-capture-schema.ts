import { z } from 'zod'
export const windowCaptureContextSchema = z.object({
  selection: z.enum(['window', 'system-source']),
  title: z.string().max(1_024), app: z.string().max(512).nullable(), windowId: z.string().max(128).nullable(),
  processId: z.number().int().positive().nullable(), accessibilityText: z.string().max(16_000).nullable(),
  textStatus: z.enum(['available', 'unavailable', 'permission-required']),
}).strict()
