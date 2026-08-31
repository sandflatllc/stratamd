import type { ActionMeasurement, BudgetViolation, ProcessSummary, RendererProbeSnapshot } from './types'

export const NORMAL_BUDGETS = {
  readyMs: 1_000,
  inputPaintMs: 100,
  maximumActionMs: 1_000,
  scrollActionMs: 1_500,
  deliveryRoundtripMs: 1_500,
  maximumLongTaskMs: 200,
  framesOver50Percent: 1,
  visibleIdleCpuPercent: 3,
  idleMemoryGrowthMB: 10,
} as const

export function interactionViolations(readyMs: number, actions: readonly ActionMeasurement[], renderer: RendererProbeSnapshot): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  if (readyMs > NORMAL_BUDGETS.readyMs) violations.push({ metric: 'ready', actual: readyMs, limit: NORMAL_BUDGETS.readyMs, unit: 'ms' })
  for (const action of actions) {
    const limit = action.name.endsWith('-paint')
      ? NORMAL_BUDGETS.inputPaintMs
      : action.name === 'scroll-full-document'
        ? NORMAL_BUDGETS.scrollActionMs
        : action.name === 'send-delivery'
          ? NORMAL_BUDGETS.deliveryRoundtripMs
          : NORMAL_BUDGETS.maximumActionMs
    if (action.durationMs > limit) violations.push({ metric: `action.${action.name}`, actual: action.durationMs, limit, unit: 'ms' })
  }
  if (renderer.maximumLongTaskMs > NORMAL_BUDGETS.maximumLongTaskMs) {
    violations.push({ metric: 'renderer.maximumLongTask', actual: renderer.maximumLongTaskMs, limit: NORMAL_BUDGETS.maximumLongTaskMs, unit: 'ms' })
  }
  const scrollFrames = actions.filter((action) => action.name === 'scroll-full-document').reduce((total, action) => total + action.renderer.frames, 0)
  const slowScrollFrames = actions.filter((action) => action.name === 'scroll-full-document').reduce((total, action) => total + action.renderer.framesOver50Ms, 0)
  const slowFramePercent = scrollFrames === 0 ? 0 : slowScrollFrames / scrollFrames * 100
  if (slowFramePercent > NORMAL_BUDGETS.framesOver50Percent) {
    violations.push({ metric: 'scroll.framesOver50', actual: slowFramePercent, limit: NORMAL_BUDGETS.framesOver50Percent, unit: 'percent' })
  }
  return violations
}

export function idleViolations(process: ProcessSummary, memoryGrowthMB: number): BudgetViolation[] {
  const violations: BudgetViolation[] = []
  if (process.averageCpuPercent > NORMAL_BUDGETS.visibleIdleCpuPercent) {
    violations.push({ metric: 'idle.averageCpu', actual: process.averageCpuPercent, limit: NORMAL_BUDGETS.visibleIdleCpuPercent, unit: 'percent' })
  }
  if (memoryGrowthMB > NORMAL_BUDGETS.idleMemoryGrowthMB) {
    violations.push({ metric: 'idle.memoryGrowth', actual: memoryGrowthMB, limit: NORMAL_BUDGETS.idleMemoryGrowthMB, unit: 'MB' })
  }
  return violations
}
