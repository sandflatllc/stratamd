import type { StrataApi, WindowApi } from './contracts'

declare global {
  interface Window {
    strata: StrataApi
    strataWindow: WindowApi
    strataMermaidProofEnabled?: string
    strataPhase6Disabled?: string
    strataPhase7Disabled?: string
    strataMermaidProof?: {
      render(source: string, normalizeBreaks?: boolean): Promise<{ durationMs: number; normalizedBreaks: boolean; text: string }>
      clear(): void
    }
  }
}

export {}
