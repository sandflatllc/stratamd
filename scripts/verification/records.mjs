/** Elapsed time includes queues and gaps; overlapping callers don't erase gaps. */
export function updateTask(task, report, finish) {
  task.runs.push({ id: report.id, mode: report.mode, status: report.status, started: report.started, finished: report.finished, commandDurationMs: report.commandDurationMs, output: report.output, candidateFingerprint: report.identity?.source })
  const intervals = task.runs.map(run => [Date.parse(run.started), Date.parse(run.finished)]).sort((a, b) => a[0] - b[0])
  let occupied = 0, end = intervals[0][0]
  for (const [start, stop] of intervals) { occupied += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop) }
  task.started = new Date(intervals[0][0]).toISOString()
  task.lastResult = report.finished
  task.elapsedMs = end - intervals[0][0]
  task.commandDurationMs = task.runs.reduce((sum, run) => sum + run.commandDurationMs, 0)
  task.gapsMs = task.elapsedMs - occupied
  task.complete = finish && report.status === 'passed'
  return task
}

export function observations(tasks) {
  const complete = tasks.filter(task => task.complete).sort((a, b) => Date.parse(a.started) - Date.parse(b.started))
  const routine = complete.filter(task => task.runs.some(run => run.mode === 'full' && run.status === 'passed') && !task.runs.some(run => ['stress', 'managed', 'packaged'].includes(run.mode)))
  const summarize = values => {
    if (!values.length) return null
    const sorted = values.toSorted((a, b) => a - b), middle = Math.floor(sorted.length / 2)
    return { count: sorted.length, medianMs: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, slowestMs: sorted.at(-1) }
  }
  return { pendingFirstTen: Math.max(0, 10 - routine.length), firstTenRoutine: summarize(routine.slice(0, 10).map(task => task.elapsedMs)), allRoutine: summarize(routine.map(task => task.elapsedMs)), special: complete.filter(task => !routine.includes(task)).map(task => ({ task: task.task, elapsedMs: task.elapsedMs, modes: [...new Set(task.runs.map(run => run.mode))] })) }
}
