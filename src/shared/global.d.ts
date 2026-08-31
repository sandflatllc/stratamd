import type { StrataApi } from './contracts'

declare global {
  interface Window {
    strata: StrataApi
  }
}

export {}
