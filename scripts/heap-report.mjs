#!/usr/bin/env node
// Lab analyzer for docs/plans/open/performance-plan.md item 6: what the renderer's V8 heap
// holds, and who retains it. Reads a .heapsnapshot written by
// webContents.takeHeapSnapshot and prints
//   - totals and per-constructor shallow/retained size,
//   - the largest single objects with their dominator (retainer) path,
//   - a string census, including how many document-sized strings are alive,
//   - detached DOM node counts.
//
// Usage: node --max-old-space-size=8192 scripts/heap-report.mjs <file.heapsnapshot> [--grep <text>]
import { readFileSync } from 'node:fs'

const [, , snapshotPath, ...flags] = process.argv
if (!snapshotPath) {
  console.error('usage: node scripts/heap-report.mjs <file.heapsnapshot> [--grep text]')
  process.exit(1)
}
const grepIndex = flags.indexOf('--grep')
const grep = grepIndex >= 0 ? flags[grepIndex + 1] : null

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const meta = snapshot.snapshot.meta
const nodeFields = meta.node_fields
const nodeTypes = meta.node_types[0]
const edgeFields = meta.edge_fields
const edgeTypes = meta.edge_types[0]
const strings = snapshot.strings
const nodes = snapshot.nodes
const edges = snapshot.edges
const nodeFieldCount = nodeFields.length
const edgeFieldCount = edgeFields.length
const nodeCount = nodes.length / nodeFieldCount
const edgeCount = edges.length / edgeFieldCount

const F = Object.fromEntries(nodeFields.map((name, index) => [name, index]))
const E = Object.fromEntries(edgeFields.map((name, index) => [name, index]))
const typeOf = (node) => nodeTypes[nodes[node * nodeFieldCount + F.type]]
const nameOf = (node) => strings[nodes[node * nodeFieldCount + F.name]]
const selfSizeOf = (node) => nodes[node * nodeFieldCount + F.self_size]
const idOf = (node) => nodes[node * nodeFieldCount + F.id]
const detachedOf = (node) => (F.detachedness === undefined ? 0 : nodes[node * nodeFieldCount + F.detachedness])

// Edge offsets per node.
const firstEdge = new Uint32Array(nodeCount + 1)
for (let node = 0; node < nodeCount; node += 1) firstEdge[node + 1] = firstEdge[node] + nodes[node * nodeFieldCount + F.edge_count]

const MB = 1048576
const totalSelf = (() => { let sum = 0; for (let node = 0; node < nodeCount; node += 1) sum += selfSizeOf(node); return sum })()
console.log(`\n# ${snapshotPath.split('/').at(-1)}`)
console.log(`nodes ${nodeCount.toLocaleString()}  edges ${edgeCount.toLocaleString()}  total self size ${(totalSelf / MB).toFixed(1)} MB\n`)

// --- Retained sizes via the dominator tree (weak edges excluded, as DevTools does).
const WEAK = edgeTypes.indexOf('weak')
const postOrder = new Int32Array(nodeCount).fill(-1)
const ordinal = new Int32Array(nodeCount).fill(-1)
{
  const stack = new Int32Array(nodeCount)
  const edgeCursor = new Uint32Array(nodeCount)
  const visited = new Uint8Array(nodeCount)
  let stackTop = 0
  let counter = 0
  stack[0] = 0
  visited[0] = 1
  edgeCursor[0] = firstEdge[0]
  while (stackTop >= 0) {
    const node = stack[stackTop]
    if (edgeCursor[node] < firstEdge[node + 1]) {
      const edge = edgeCursor[node]
      edgeCursor[node] += 1
      if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
      const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
      if (!visited[child]) {
        visited[child] = 1
        edgeCursor[child] = firstEdge[child]
        stackTop += 1
        stack[stackTop] = child
      }
      continue
    }
    postOrder[counter] = node
    ordinal[node] = counter
    counter += 1
    stackTop -= 1
  }
  if (counter < nodeCount) console.log(`(unreachable nodes: ${nodeCount - counter})`)
}

// Predecessors, over the same edge filter.
const predecessorCount = new Uint32Array(nodeCount + 1)
for (let edge = 0; edge < edgeCount; edge += 1) {
  if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
  predecessorCount[edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount] += 1
}
const predecessorStart = new Uint32Array(nodeCount + 1)
for (let node = 0; node < nodeCount; node += 1) predecessorStart[node + 1] = predecessorStart[node] + predecessorCount[node]
const predecessors = new Int32Array(predecessorStart[nodeCount])
{
  const cursor = predecessorStart.slice()
  let node = 0
  for (let edge = 0; edge < edgeCount; edge += 1) {
    while (edge >= firstEdge[node + 1]) node += 1
    if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
    const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
    predecessors[cursor[child]] = node
    cursor[child] += 1
  }
}

// Cooper-Harvey-Kennedy iterative dominators over reverse post-order.
const dominator = new Int32Array(nodeCount).fill(-1)
dominator[0] = 0
{
  const intersect = (left, right) => {
    while (left !== right) {
      while (ordinal[left] < ordinal[right]) left = dominator[left]
      while (ordinal[right] < ordinal[left]) right = dominator[right]
    }
    return left
  }
  let changed = true
  while (changed) {
    changed = false
    for (let index = nodeCount - 1; index >= 0; index -= 1) {
      const node = postOrder[index]
      if (node < 0 || node === 0) continue
      let candidate = -1
      for (let slot = predecessorStart[node]; slot < predecessorStart[node + 1]; slot += 1) {
        const predecessor = predecessors[slot]
        if (ordinal[predecessor] < 0 || dominator[predecessor] < 0) continue
        candidate = candidate < 0 ? predecessor : intersect(candidate, predecessor)
      }
      if (candidate >= 0 && dominator[node] !== candidate) { dominator[node] = candidate; changed = true }
    }
  }
}

const retained = new Float64Array(nodeCount)
for (let node = 0; node < nodeCount; node += 1) retained[node] = selfSizeOf(node)
for (let index = 0; index < nodeCount; index += 1) {
  const node = postOrder[index]
  if (node <= 0) continue
  const parent = dominator[node]
  if (parent >= 0 && parent !== node) retained[parent] += retained[node]
}

const label = (node) => {
  const type = typeOf(node)
  const name = nameOf(node)
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string') {
    return `"${name.slice(0, 60).replace(/\n/g, '\\n')}"${name.length > 60 ? `…(${name.length})` : ''}`
  }
  return `${name || type} [${type}]`
}

const edgeLabel = (from, to) => {
  for (let edge = firstEdge[from]; edge < firstEdge[from + 1]; edge += 1) {
    if (edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount !== to) continue
    const type = edgeTypes[edges[edge * edgeFieldCount + E.type]]
    const nameOrIndex = edges[edge * edgeFieldCount + E.name_or_index]
    return type === 'element' || type === 'hidden' ? `[${nameOrIndex}]` : `.${strings[nameOrIndex]}`
  }
  return '?'
}

const retainerPath = (node, limit = 12) => {
  const path = []
  let current = node
  while (current > 0 && path.length < limit) {
    const parent = dominator[current]
    if (parent < 0 || parent === current) break
    path.push(`${edgeLabel(parent, current)} in ${label(parent)}`)
    current = parent
  }
  return path
}

// --- Per-constructor aggregation.
const byName = new Map()
for (let node = 0; node < nodeCount; node += 1) {
  const type = typeOf(node)
  const key = type === 'string' || type === 'concatenated string' || type === 'sliced string' || type === 'number'
    ? `(${type})` : `${nameOf(node)} [${type}]`
  const entry = byName.get(key) ?? { count: 0, self: 0, retained: 0 }
  entry.count += 1
  entry.self += selfSizeOf(node)
  entry.retained += retained[node]
  byName.set(key, entry)
}
console.log('## Top constructors by shallow size\n')
console.log('    shallowMB   retainedMB    count  constructor')
for (const [key, entry] of [...byName.entries()].sort((left, right) => right[1].self - left[1].self).slice(0, 25)) {
  console.log(`  ${(entry.self / MB).toFixed(2).padStart(9)}  ${(entry.retained / MB).toFixed(2).padStart(11)}  ${String(entry.count).padStart(7)}  ${key}`)
}

console.log('\n## Largest single objects by retained size (with dominator path)\n')
const order = Array.from({ length: nodeCount }, (unused, index) => index)
  .filter((node) => node !== 0)
  .sort((left, right) => retained[right] - retained[left])
for (const node of order.slice(0, 18)) {
  console.log(`  ${(retained[node] / MB).toFixed(2).padStart(8)} MB retained  ${(selfSizeOf(node) / 1024).toFixed(1)} KB self  @${idOf(node)}  ${label(node)}`)
  for (const step of retainerPath(node, 8)) console.log(`      <- ${step}`)
}

// --- String census.
console.log('\n## String census\n')
let stringCount = 0
let stringBytes = 0
const buckets = { '<1 KB': [0, 0], '1-10 KB': [0, 0], '10-100 KB': [0, 0], '100 KB-1 MB': [0, 0], '>1 MB': [0, 0] }
for (let node = 0; node < nodeCount; node += 1) {
  const type = typeOf(node)
  if (type !== 'string' && type !== 'concatenated string' && type !== 'sliced string') continue
  const size = selfSizeOf(node)
  stringCount += 1
  stringBytes += size
  const bucket = size < 1024 ? '<1 KB' : size < 10240 ? '1-10 KB' : size < 102400 ? '10-100 KB' : size < MB ? '100 KB-1 MB' : '>1 MB'
  buckets[bucket][0] += 1
  buckets[bucket][1] += size
}
console.log(`  ${stringCount.toLocaleString()} strings, ${(stringBytes / MB).toFixed(1)} MB shallow`)
for (const [bucket, [count, size]] of Object.entries(buckets)) console.log(`    ${bucket.padEnd(12)} ${String(count).padStart(8)}  ${(size / MB).toFixed(2).padStart(8)} MB`)

const marker = grep ?? 'Fixture seed:'
const matches = []
for (let node = 0; node < nodeCount; node += 1) {
  const type = typeOf(node)
  if (type !== 'string' && type !== 'concatenated string' && type !== 'sliced string') continue
  const value = nameOf(node)
  if (!value.includes(marker)) continue
  matches.push(node)
}
console.log(`\n  strings containing ${JSON.stringify(marker)}: ${matches.length}, ${(matches.reduce((sum, node) => sum + selfSizeOf(node), 0) / MB).toFixed(2)} MB shallow`)
for (const node of matches.sort((left, right) => selfSizeOf(right) - selfSizeOf(left)).slice(0, 6)) {
  console.log(`    ${(selfSizeOf(node) / 1024).toFixed(1)} KB  ${label(node)}`)
  for (const step of retainerPath(node, 6)) console.log(`        <- ${step}`)
}

// --- Detached DOM.
let detachedCount = 0
let detachedBytes = 0
for (let node = 0; node < nodeCount; node += 1) {
  if (detachedOf(node) !== 2) continue
  detachedCount += 1
  detachedBytes += selfSizeOf(node)
}
console.log(`\n## Detached DOM wrappers: ${detachedCount} nodes, ${(detachedBytes / 1024).toFixed(1)} KB shallow`)

// --- Maps keyed by document path (savedEditors is the one that matters).
console.log('\n## Map-like objects holding tab paths\n')
const candidates = []
for (let node = 0; node < nodeCount; node += 1) {
  const name = nameOf(node)
  if (name !== 'Map' && name !== 'system / Map') continue
  if (retained[node] < 64 * 1024) continue
  candidates.push(node)
}
for (const node of candidates.sort((left, right) => retained[right] - retained[left]).slice(0, 8)) {
  let sample = ''
  for (let edge = firstEdge[node]; edge < firstEdge[node + 1] && !sample; edge += 1) {
    const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
    if (typeOf(child) === 'string' && nameOf(child).includes('.md')) sample = nameOf(child)
    for (let inner = firstEdge[child]; inner < firstEdge[child + 1] && !sample; inner += 1) {
      const leaf = edges[inner * edgeFieldCount + E.to_node] / nodeFieldCount
      if (typeOf(leaf) === 'string' && nameOf(leaf).includes('.md')) sample = nameOf(leaf)
    }
  }
  console.log(`  ${(retained[node] / MB).toFixed(2).padStart(8)} MB retained  @${idOf(node)}  ${nameOf(node)}  sample key: ${sample || '(none found)'}`)
  for (const step of retainerPath(node, 6)) console.log(`      <- ${step}`)
}
