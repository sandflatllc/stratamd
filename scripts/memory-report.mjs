#!/usr/bin/env node
// Lab analyzer for docs/plans/open/performance-plan.md item 6 (memory floor attribution).
// Reads the memory-attribution driver's report.json plus its memory-infra
// traces and prints the per-capture attribution tables and rung deltas.
//
// Usage: node scripts/memory-report.mjs <report.json> [--full]
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const [, , reportPath, ...flags] = process.argv
if (!reportPath) {
  console.error('usage: node scripts/memory-report.mjs <report.json> [--full]')
  process.exit(1)
}
const full = flags.includes('--full')
const report = JSON.parse(readFileSync(reportPath, 'utf8'))
const MB = 1048576

const hex = (attr) => (attr && attr.value !== undefined ? parseInt(attr.value, 16) : 0)

/** Renderer-process memory-infra dump for one capture, rolled up. */
function readTrace(tracePath) {
  const raw = JSON.parse(readFileSync(tracePath, 'utf8'))
  const events = raw.traceEvents ?? raw
  const names = new Map()
  for (const event of events) {
    if (event.ph === 'M' && event.name === 'process_name') names.set(event.pid, event.args.name)
  }
  const perPid = new Map()
  for (const event of events) {
    if (event.ph !== 'v') continue
    const entry = perPid.get(event.pid) ?? { pid: event.pid, name: names.get(event.pid) ?? 'unknown', allocators: null, totals: null }
    if (event.args.dumps.allocators) entry.allocators = event.args.dumps.allocators
    if (event.args.dumps.process_totals) entry.totals = event.args.dumps.process_totals
    perPid.set(event.pid, entry)
  }
  return [...perPid.values()].map((entry) => {
    const roots = {}
    const detail = {}
    for (const [key, node] of Object.entries(entry.allocators ?? {})) {
      const size = hex(node.attrs?.size)
      if (!key.includes('/')) roots[key] = size
      // Blink's per-class dumps carry a build-local type id in the name; it
      // moves between dumps, so aggregate on the bare class name.
      const normalized = key.replace(/ \(0x[0-9a-f]+\)$/, '')
      const entryDetail = detail[normalized] ?? {
        size: 0, allocated: 0, committed: 0, objectCount: null, decommittable: 0, fragmentation: null, virtual: 0,
      }
      entryDetail.size += size
      entryDetail.allocated += hex(node.attrs?.allocated_objects_size)
      entryDetail.committed += hex(node.attrs?.committed_size)
      entryDetail.decommittable += hex(node.attrs?.decommittable_size)
      entryDetail.virtual += hex(node.attrs?.virtual_size)
      if (node.attrs?.object_count) entryDetail.objectCount = (entryDetail.objectCount ?? 0) + parseInt(node.attrs.object_count.value, 16)
      if (node.attrs?.fragmentation) entryDetail.fragmentation = parseInt(node.attrs.fragmentation.value, 16)
      detail[normalized] = entryDetail
    }
    return {
      pid: entry.pid,
      name: entry.name,
      residentBytes: entry.totals ? parseInt(entry.totals.resident_set_size ?? entry.totals.peak_resident_set_size ?? '0', 16) : 0,
      privateFootprintBytes: entry.totals ? parseInt(entry.totals.private_footprint_bytes ?? '0', 16) : 0,
      roots,
      detail,
    }
  })
}

function renderer(trace) {
  return trace.find((entry) => entry.name === 'Renderer')
}

const rows = []
for (const capture of report.captures) {
  const trace = readTrace(capture.tracePath)
  const tab = capture.appMetrics.find((metric) => metric.type === 'Tab')
  const tabProc = capture.proc.find((entry) => entry.pid === tab?.pid)
  rows.push({ capture, trace, render: renderer(trace), tab, tabProc })
}

const fmt = (bytes) => (bytes / MB).toFixed(1)
const pad = (value, width) => String(value).padStart(width)

console.log(`\n# ${basename(reportPath)}  variant=${report.variant} cache=${report.editorCache} display=${report.displayMode}\n`)

console.log('## Process working set (MB)\n')
console.log('capture              tabs   Tab   GPU  Browser  Net  total | TabRSS anon file shm  Pss')
for (const row of rows) {
  const { capture, tab, tabProc } = row
  const by = (type, name) => capture.appMetrics.filter((metric) => metric.type === type && (!name || metric.name === name))
    .reduce((sum, metric) => sum + metric.workingSetMB, 0)
  const total = capture.appMetrics.reduce((sum, metric) => sum + metric.workingSetMB, 0)
  console.log(
    `${capture.label.padEnd(20)} ${pad(capture.openFiles, 4)} ${pad(Math.round(tab?.workingSetMB ?? 0), 5)} ${pad(Math.round(by('GPU')), 5)} ${pad(Math.round(by('Browser')), 8)} ${pad(Math.round(by('Utility', 'Network Service')), 4)} ${pad(Math.round(total), 6)} |` +
    ` ${pad(Math.round((tabProc?.vmRssKB ?? 0) / 1024), 6)} ${pad(Math.round((tabProc?.rssAnonKB ?? 0) / 1024), 4)} ${pad(Math.round((tabProc?.rssFileKB ?? 0) / 1024), 4)} ${pad(Math.round((tabProc?.rssShmemKB ?? 0) / 1024), 3)} ${pad(Math.round((tabProc?.pssKB ?? 0) / 1024), 4)}`
  )
}

console.log('\n## Renderer JS heap and DOM\n')
console.log('capture              tabs  jsUsed jsTotal embedder  domNodes editorNodes layoutObj listeners docs')
for (const row of rows) {
  const { capture, render } = row
  const layout = render?.detail['blink_objects/LayoutObject']?.objectCount ?? 0
  console.log(
    `${capture.label.padEnd(20)} ${pad(capture.openFiles, 4)} ${pad(fmt(capture.heapUsage.usedSize), 7)} ${pad(fmt(capture.heapUsage.totalSize), 7)} ${pad(fmt(capture.heapUsage.embedderHeapUsedSize ?? 0), 8)} ${pad(capture.renderer.domNodes, 9)} ${pad(capture.renderer.editorNodes, 11)} ${pad(layout, 9)} ${pad(capture.domCounters.jsEventListeners, 9)} ${pad(capture.domCounters.documents, 4)}`
  )
}

console.log('\n## Renderer resident bytes by backing (MB, from /proc/pid/smaps)\n')
{
  const buckets = [...new Set(rows.flatMap((row) => Object.keys(row.capture.tabSmapsKB ?? {})))].sort()
  console.log(`capture              tabs ${buckets.map((name) => name.slice(0, 12).padStart(14)).join('')}`)
  for (const row of rows) {
    console.log(`${row.capture.label.padEnd(20)} ${pad(row.capture.openFiles, 4)} ${buckets.map((name) => pad(((row.capture.tabSmapsKB?.[name] ?? 0) / 1024).toFixed(1), 14)).join('')}`)
  }
}

const ROOTS = ['malloc', 'shared_memory', 'cc', 'blink_gc', 'v8', 'partition_alloc', 'discardable', 'parkable_strings', 'skia', 'web_cache', 'font_caches']
console.log('\n## Renderer memory-infra allocator roots (MB)\n')
console.log(`capture              tabs ${ROOTS.map((name) => name.slice(0, 8).padStart(9)).join('')}   sum  privFoot`)
for (const row of rows) {
  const { capture, render } = row
  const sum = ROOTS.reduce((total, name) => total + (render?.roots[name] ?? 0), 0)
  console.log(
    `${capture.label.padEnd(20)} ${pad(capture.openFiles, 4)} ${ROOTS.map((name) => pad(fmt(render?.roots[name] ?? 0), 9)).join('')} ${pad(fmt(sum), 6)} ${pad(fmt(render?.privateFootprintBytes ?? 0), 8)}`
  )
}

console.log('\n## Live vs committed inside the two big allocators (MB)\n')
console.log('capture              tabs  malloc.committed malloc.live  malloc.free  blinkGC.committed blinkGC.live blinkGC.free | v8.committed v8.live')
for (const row of rows) {
  const { capture, render } = row
  const mallocAllocator = render?.detail['malloc/partitions/allocator'] ?? {}
  const mallocLive = render?.detail['malloc/allocated_objects']?.size ?? 0
  const blinkHeap = render?.detail['blink_gc/main/heap'] ?? {}
  const blinkLive = render?.detail['blink_gc/main/allocated_objects']?.size ?? 0
  const v8Heap = render?.roots['v8'] ?? 0
  const v8Live = ['old_space', 'new_space', 'code_space', 'map_space', 'large_object_space', 'new_large_object_space', 'code_large_object_space', 'read_only_space', 'shared_large_object_space', 'trusted_space', 'trusted_large_object_space']
    .reduce((total, space) => total + (render?.detail[`v8/main/heap/${space}`]?.allocated ?? 0), 0)
  const blinkCommitted = render?.roots['blink_gc'] ?? 0
  console.log(
    `${capture.label.padEnd(20)} ${pad(capture.openFiles, 4)} ${pad(fmt(mallocAllocator.size ?? 0), 17)} ${pad(fmt(mallocLive), 11)} ${pad(fmt((mallocAllocator.size ?? 0) - mallocLive), 12)}` +
    ` ${pad(fmt(blinkCommitted), 18)} ${pad(fmt(blinkLive), 12)} ${pad(fmt(blinkCommitted - blinkLive), 12)} |` +
    ` ${pad(fmt(v8Heap), 12)} ${pad(fmt(v8Live), 7)}`
  )
}

// Deltas between consecutive rungs, per allocator and per Blink class.
console.log('\n## Rung deltas (MB unless noted)\n')
for (let index = 1; index < rows.length; index += 1) {
  const from = rows[index - 1]
  const to = rows[index]
  const tabs = to.capture.openFiles - from.capture.openFiles
  const deltaTab = (to.tab?.workingSetMB ?? 0) - (from.tab?.workingSetMB ?? 0)
  console.log(`### ${from.capture.label} -> ${to.capture.label}  (+${tabs} tabs)`)
  console.log(`  Tab working set  ${deltaTab.toFixed(1)} MB${tabs > 0 ? `  (${(deltaTab / tabs).toFixed(2)} MB/tab)` : ''}`)
  const jsDelta = (to.capture.heapUsage.usedSize - from.capture.heapUsage.usedSize) / MB
  console.log(`  JS heap used     ${jsDelta.toFixed(2)} MB${tabs > 0 ? `  (${(jsDelta * 1024 / tabs).toFixed(0)} KB/tab)` : ''}`)
  const allocatorDeltas = []
  for (const name of ROOTS) {
    const delta = ((to.render?.roots[name] ?? 0) - (from.render?.roots[name] ?? 0)) / MB
    if (Math.abs(delta) >= 0.2) allocatorDeltas.push(`${name} ${delta > 0 ? '+' : ''}${delta.toFixed(1)}`)
  }
  console.log(`  allocators       ${allocatorDeltas.join('  ') || 'none over 0.2 MB'}`)
  const classDeltas = []
  const keys = new Set([...Object.keys(to.render?.detail ?? {}), ...Object.keys(from.render?.detail ?? {})].filter((key) => key.startsWith('blink_objects/blink_gc/main/')))
  for (const key of keys) {
    const delta = ((to.render?.detail[key]?.size ?? 0) - (from.render?.detail[key]?.size ?? 0)) / MB
    if (Math.abs(delta) >= 0.2) classDeltas.push({ key: key.replace('blink_objects/blink_gc/main/', ''), delta })
  }
  classDeltas.sort((left, right) => Math.abs(right.delta) - Math.abs(left.delta))
  console.log(`  blink classes    ${classDeltas.slice(0, 8).map((entry) => `${entry.key} ${entry.delta > 0 ? '+' : ''}${entry.delta.toFixed(2)}`).join('  ') || 'none over 0.2 MB'}`)
  console.log(`  DOM nodes        ${to.capture.renderer.domNodes - from.capture.renderer.domNodes}   listeners ${to.capture.domCounters.jsEventListeners - from.capture.domCounters.jsEventListeners}   documents ${to.capture.domCounters.documents - from.capture.domCounters.documents}`)
  console.log('')
}

if (full) {
  for (const row of rows) {
    console.log(`\n## ${row.capture.label}: renderer allocators over 0.5 MB\n`)
    const entries = Object.entries(row.render?.detail ?? {})
      .filter(([, node]) => node.size > MB / 2)
      .sort((left, right) => right[1].size - left[1].size)
      .slice(0, 45)
    for (const [key, node] of entries) console.log(`  ${fmt(node.size).padStart(8)}  ${key}`)
    console.log(`\n## ${row.capture.label}: top Blink classes (Oilpan, MB)\n`)
    const classes = Object.entries(row.render?.detail ?? {})
      .filter(([key]) => key.startsWith('blink_objects/blink_gc/main/'))
      .sort((left, right) => right[1].size - left[1].size)
      .slice(0, 25)
    for (const [key, node] of classes) console.log(`  ${fmt(node.size).padStart(8)}  ${String(node.objectCount ?? '').padStart(8)}  ${key.replace('blink_objects/blink_gc/main/', '')}`)
    console.log(`\n## ${row.capture.label}: other processes (MB resident / private footprint)\n`)
    for (const entry of row.trace) {
      console.log(`  ${entry.name.padEnd(40)} ${fmt(entry.residentBytes).padStart(8)} ${fmt(entry.privateFootprintBytes).padStart(8)}  roots: ${Object.entries(entry.roots).filter(([, size]) => size > MB).sort((left, right) => right[1] - left[1]).slice(0, 6).map(([name, size]) => `${name} ${fmt(size)}`).join(', ')}`)
    }
  }
}
