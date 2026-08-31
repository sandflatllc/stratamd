import type { ResolveHook } from 'node:module'

export const resolve: ResolveHook = async (specifier, context, nextResolve) => {
  try {
    return await nextResolve(specifier, context)
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error
    }
    if (specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context)
    }
    if (specifier.startsWith('.') && !specifier.slice(specifier.lastIndexOf('/') + 1).includes('.')) {
      return nextResolve(`${specifier}.ts`, context)
    }
    throw error
  }
}
