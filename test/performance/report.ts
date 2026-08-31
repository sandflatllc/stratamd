import { execFileSync } from 'node:child_process'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { writeFile } from 'node:fs/promises'
import type { ElectronApplication, TestInfo } from '@playwright/test'
import type { PerformanceRunReport } from './types'

function git(args: string[]): string {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim() }
  catch { return 'unknown' }
}

export async function environmentDetails(application: ElectronApplication): Promise<PerformanceRunReport['environment']> {
  const versions = await application.evaluate(() => ({ electron: process.versions.electron ?? 'unknown', chrome: process.versions.chrome ?? 'unknown' }))
  const processors = cpus()
  return {
    gitCommit: git(['rev-parse', 'HEAD']),
    gitDirty: git(['status', '--porcelain']) !== '',
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: processors[0]?.model ?? 'unknown',
    logicalCpus: processors.length,
    totalMemoryMB: totalmem() / 1024 / 1024,
    node: process.version,
    electron: versions.electron,
    chrome: versions.chrome,
    displayMode: process.env.STRATAMD_PERF_DISPLAY_MODE === 'desktop' || process.env.STRATAMD_PERF_DISPLAY_MODE === 'xvfb'
      ? process.env.STRATAMD_PERF_DISPLAY_MODE
      : 'unknown',
  }
}

export async function attachReport(testInfo: TestInfo, report: PerformanceRunReport): Promise<void> {
  const path = testInfo.outputPath('performance-report.json')
  const body = `${JSON.stringify(report, null, 2)}\n`
  await writeFile(path, body)
  await testInfo.attach('performance-report.json', { path, contentType: 'application/json' })
  testInfo.annotations.push({ type: 'performance-classification', description: report.classification })
  testInfo.annotations.push({ type: 'performance-ready-ms', description: report.readyMs.toFixed(1) })
}
