import { z } from 'zod'
import type { EngineModelView, ModelOption, ModelOptionDescriptor } from './contracts'

// Unknown fields and descriptors belong to the engine or another client. Keep them intact.
export const customModelSchema = z.union([z.string().trim().min(1).max(512), z.object({
  slug: z.string().trim().min(1).max(512), name: z.string().trim().min(1).max(512).optional(),
  capabilities: z.object({ optionDescriptors: z.array(z.unknown()).optional() }).passthrough().optional(),
}).passthrough()])
export type CustomModel = z.infer<typeof customModelSchema>
export function customModelId(value: unknown): string | undefined {
  return typeof value === 'string' ? value : typeof value === 'object' && value !== null && 'slug' in value && typeof value.slug === 'string' ? value.slug : undefined
}
export function supportsOption(descriptor: ModelOptionDescriptor, value: unknown): value is string | boolean {
  return descriptor.type === 'boolean' ? typeof value === 'boolean' : typeof value === 'string' && !!descriptor.options?.some(option => option.id === value)
}
export function customModelValues(entry: unknown, descriptors: ModelOptionDescriptor[]): Record<string, unknown> {
  const parsed = customModelSchema.safeParse(entry)
  const stored = parsed.success && typeof parsed.data !== 'string' ? parsed.data.capabilities?.optionDescriptors ?? [] : []
  return Object.fromEntries(descriptors.map(descriptor => {
    const saved = stored.find(value => typeof value === 'object' && value !== null && 'id' in value && value.id === descriptor.id)
    const value = typeof saved === 'object' && saved !== null && 'currentValue' in saved ? saved.currentValue : descriptor.currentValue ?? descriptor.options?.find(value => value.isDefault)?.id
    return [descriptor.id, value]
  }))
}
/** Only changed defaults are rewritten. A name edit never narrows capabilities. */
export function editCustomModel(entry: unknown, slug: string, name: string, descriptors: ModelOptionDescriptor[], changes: Record<string, string | boolean>): CustomModel {
  const parsed = customModelSchema.parse(entry ?? slug)
  const next = typeof parsed === 'string' ? { slug: parsed } : { ...parsed }
  if (name.trim()) Object.assign(next, { name: name.trim() })
  else delete (next as { name?: string }).name
  if (Object.keys(changes).length) {
    const source = typeof parsed === 'string' ? {} : parsed.capabilities ?? {}
    const options = [...(source.optionDescriptors ?? descriptors)]
    for (const [id, value] of Object.entries(changes)) {
      const descriptor = descriptors.find(descriptor => descriptor.id === id)
      if (!descriptor || !supportsOption(descriptor, value)) throw new Error(`Choose a supported value for ${descriptor?.label ?? id}.`)
      const index = options.findIndex(item => typeof item === 'object' && item !== null && 'id' in item && item.id === id)
      const original = index >= 0 ? options[index] : descriptor
      const updated = { ...original as object, currentValue: value }
      if (index < 0) options.push(updated); else options[index] = updated
    }
    Object.assign(next, { capabilities: { ...source, optionDescriptors: options } })
  }
  return next
}

export function supportedModelOptions(model: EngineModelView | undefined, options: ModelOption[]): ModelOption[] {
  if (!model?.options.length) return options
  return options.filter(option => model.options.some(descriptor => descriptor.id === option.id && supportsOption(descriptor, option.value)))
}

/** Legacy engines without option metadata retain their existing effort behavior. */
export function validatedModelOptions(model: EngineModelView | undefined, options: ModelOption[]): ModelOption[] {
  if (!model?.options.length) return options
  for (const option of options) {
    const descriptor = model.options.find(descriptor => descriptor.id === option.id)
    if (!descriptor || !supportsOption(descriptor, option.value)) throw new Error(`Choose a supported value for ${descriptor?.label ?? option.id} on model ${model.slug} (${model.instanceId}).`)
  }
  return options
}
