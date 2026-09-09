import { z } from 'zod'
import { generatedModelSchema, mergeEdited, type GeneratedModel } from './engine-settings'
export const threadEnvironment = z.enum(['local', 'worktree'])
export const projectDefaultsPatch = z.object({ defaultModelSelection: generatedModelSchema.strip().nullable().optional(), defaultThreadEnvMode: threadEnvironment.nullable().optional() }).strict()
export const projectDefaultsEdit = z.object({ identity: z.string().nullable(), projectId: z.string().min(1), base: z.record(z.string(), z.unknown()), patch: projectDefaultsPatch }).strict()
export type ProjectDefaultsEdit = z.infer<typeof projectDefaultsEdit>
export type ProjectDefaultsPatch = z.infer<typeof projectDefaultsPatch>
export interface ProjectDefaults extends ProjectDefaultsPatch { identity: string | null; projectId: string; checkedIn: 'local' | 'worktree' | null; computerModel: GeneratedModel | null; computerEnvironment: 'local' | 'worktree' }
export function effectiveDefaults(value: ProjectDefaults) {
  return { model: value.defaultModelSelection ?? value.computerModel, modelSource: value.defaultModelSelection ? 'Project override' : 'Inherited from computer', environment: value.defaultThreadEnvMode ?? value.checkedIn ?? value.computerEnvironment, environmentSource: value.defaultThreadEnvMode ? 'Project override' : value.checkedIn ? 'Inherited from t3.json' : 'Inherited from computer' }
}
export function mergeProjectDefaults(current: ProjectDefaultsPatch, edit: ProjectDefaultsEdit): ProjectDefaultsPatch {
  return Object.fromEntries(Object.entries(projectDefaultsPatch.parse(edit.patch)).map(([key, value]) => [key, mergeEdited(current[key as keyof ProjectDefaultsPatch], edit.base[key as keyof ProjectDefaultsPatch], value, key === 'defaultThreadEnvMode' ? `Working copy for project ${edit.projectId}` : `Model and thinking for project ${edit.projectId}`)]))
}
const nonempty = z.string().trim().min(1)
const projectFile = z.object({ $schema: z.string().optional(), iconPath: nonempty.max(512).optional(), defaultThreadEnvMode: threadEnvironment.optional(), scripts: z.array(z.object({ name: nonempty, command: nonempty, icon: z.enum(['play','test','lint','configure','build','debug']).optional(), runOnWorktreeCreate: z.boolean().optional(), previewUrl: nonempty.optional(), autoOpenPreview: z.boolean().optional() })).max(50).optional() })
/** JSONC strings are protected while comments and trailing commas are removed. No script is executed. */
export function checkedInEnvironment(contents: string, truncated = false): 'local' | 'worktree' | null {
  if (truncated) return null
  try {
    const clean = contents.replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, token => token.startsWith('"') ? token : ' ').replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === ',' ? '' : token)
    const parsed = projectFile.safeParse(JSON.parse(clean))
    return parsed.success ? parsed.data.defaultThreadEnvMode ?? null : null
  } catch { return null }
}
