#!/usr/bin/env node
// Lab analyzer for docs/plans/open/performance-plan.md item 6, fast path: exclusive
// retention by graph reachability rather than a dominator tree, so it runs on
// million-node snapshots. For a chosen holder (default: the renderer module's
// `savedEditors` Map), it reports the bytes that would be freed if that edge
// were cut, split per Map entry, plus a string census and detached-DOM count.
//
// Usage: node --max-old-space-size=12288 scripts/heap-holders.mjs <file.heapsnapshot> [--edge savedEditors] [--marker "Fixture seed:"]
import { readFileSync } from 'node:fs'

const [, , snapshotPath, ...flags] = process.argv
if (!snapshotPath) {
  console.error('usage: node scripts/heap-holders.mjs <file.heapsnapshot> [--edge name] [--marker text]')
  process.exit(1)
}
const option = (name, fallback) => {
  const index = flags.indexOf(`--${name}`)
  return index >= 0 ? flags[index + 1] : fallback
}
const holderEdge = option('edge', 'savedEditors')
const marker = option('marker', 'Fixture seed:')

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const meta = snapshot.snapshot.meta
const nodeFields = meta.node_fields
const nodeTypes = meta.node_types[0]
const edgeFields = meta.edge_fields
const edgeTypes = meta.edge_types[0]
const { strings, nodes, edges } = snapshot
const nodeFieldCount = nodeFields.length
const edgeFieldCount = edgeFields.length
const nodeCount = nodes.length / nodeFieldCount
const edgeCount = edges.length / edgeFieldCount
const F = Object.fromEntries(nodeFields.map((name, index) => [name, index]))
const E = Object.fromEntries(edgeFields.map((name, index) => [name, index]))
const WEAK = edgeTypes.indexOf('weak')
const MB = 1048576

const typeOf = (node) => nodeTypes[nodes[node * nodeFieldCount + F.type]]
const nameOf = (node) => strings[nodes[node * nodeFieldCount + F.name]]
const selfSizeOf = (node) => nodes[node * nodeFieldCount + F.self_size]
const idOf = (node) => nodes[node * nodeFieldCount + F.id]
const isString = (node) => {
  const type = typeOf(node)
  return type === 'string' || type === 'concatenated string' || type === 'sliced string'
}

const firstEdge = new Uint32Array(nodeCount + 1)
for (let node = 0; node < nodeCount; node += 1) firstEdge[node + 1] = firstEdge[node] + nodes[node * nodeFieldCount + F.edge_count]

/** Reachable set from `roots`, over strong edges, optionally cutting one edge. */
function reachable(roots, cutFrom = -1, cutTo = -1) {
  const seen = new Uint8Array(nodeCount)
  const stack = new Int32Array(nodeCount)
  let top = -1
  for (const root of roots) if (!seen[root]) { seen[root] = 1; stack[++top] = root }
  while (top >= 0) {
    const node = stack[top--]
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += 1) {
      if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
      const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
      if (node === cutFrom && child === cutTo) continue
      if (seen[child]) continue
      seen[child] = 1
      stack[++top] = child
    }
  }
  return seen
}

const sizeOfSet = (set, minus = null) => {
  let bytes = 0
  let count = 0
  for (let node = 0; node < nodeCount; node += 1) {
    if (!set[node]) continue
    if (minus && minus[node]) continue
    bytes += selfSizeOf(node)
    count += 1
  }
  return { bytes, count }
}

console.log(`\n# ${snapshotPath.split('/').at(-1)}`)
let totalSelf = 0
for (let node = 0; node < nodeCount; node += 1) totalSelf += selfSizeOf(node)
console.log(`nodes ${nodeCount.toLocaleString()}  edges ${edgeCount.toLocaleString()}  total self size ${(totalSelf / MB).toFixed(1)} MB\n`)

// Locate the holder: the target of an edge named `holderEdge`.
let holderOwner = -1
let holder = -1
outer: for (let node = 0; node < nodeCount; node += 1) {
  for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += 1) {
    const type = edgeTypes[edges[edge * edgeFieldCount + E.type]]
    if (type === 'element' || type === 'hidden') continue
    if (strings[edges[edge * edgeFieldCount + E.name_or_index]] !== holderEdge) continue
    holderOwner = node
    holder = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
    break outer
  }
}

if (holder < 0) {
  console.log(`(no edge named ${holderEdge} found)`)
} else {
  console.log(`## Holder: .${holderEdge} -> ${nameOf(holder)} @${idOf(holder)}  (owner: ${nameOf(holderOwner) || typeOf(holderOwner)})\n`)
  const all = reachable([0])
  const withoutHolder = reachable([0], holderOwner, holder)
  const exclusive = sizeOfSet(all, withoutHolder)
  console.log(`  exclusive retention: ${(exclusive.bytes / MB).toFixed(2)} MB over ${exclusive.count.toLocaleString()} nodes`)
  console.log(`  (bytes that become unreachable if .${holderEdge} is cut)\n`)

  // Per-entry: Map -> .table -> array of alternating key/value slots.
  let table = -1
  for (let edge = firstEdge[holder]; edge < firstEdge[holder + 1]; edge += 1) {
    if (strings[edges[edge * edgeFieldCount + E.name_or_index]] === 'table') table = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
  }
  if (table >= 0) {
    const slots = []
    for (let edge = firstEdge[table]; edge < firstEdge[table + 1]; edge += 1) {
      if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
      slots.push(edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount)
    }
    const entries = slots.filter((node) => typeOf(node) === 'object' && nameOf(node) === 'Object')
    const keys = slots.filter((node) => isString(node))
    console.log(`  table slots: ${slots.length}  entry objects: ${entries.length}  string keys: ${keys.length}`)
    const measured = []
    for (const entry of entries) {
      const without = reachable([0], table, entry)
      const size = sizeOfSet(all, without)
      let kind = 'unknown'
      for (let edge = firstEdge[entry]; edge < firstEdge[entry + 1]; edge += 1) {
        const name = strings[edges[edge * edgeFieldCount + E.name_or_index]]
        if (name === 'kind') {
          const value = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
          kind = nameOf(value) || typeOf(value)
        }
      }
      measured.push({ entry, kind, bytes: size.bytes, nodes: size.count })
      if (measured.length >= Number(option('entries', '12'))) break
    }
    measured.sort((left, right) => right.bytes - left.bytes)
    console.log('\n  per-entry exclusive retention (sampled):')
    for (const item of measured) {
      console.log(`    ${(item.bytes / 1024).toFixed(0).padStart(8)} KB  ${String(item.nodes).padStart(7)} nodes  kind=${item.kind}  @${idOf(item.entry)}`)
      for (let edge = firstEdge[item.entry]; edge < firstEdge[item.entry + 1]; edge += 1) {
        const name = strings[edges[edge * edgeFieldCount + E.name_or_index]]
        const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
        if (name === 'state') {
          const parts = []
          for (let inner = firstEdge[child]; inner < firstEdge[child + 1]; inner += 1) {
            const field = strings[edges[inner * edgeFieldCount + E.name_or_index]]
            const value = edges[inner * edgeFieldCount + E.to_node] / nodeFieldCount
            const withoutField = reachable([0], child, value)
            const fieldSize = sizeOfSet(all, withoutField)
            if (fieldSize.bytes > 4096) parts.push(`${field} ${(fieldSize.bytes / 1024).toFixed(0)} KB`)
          }
          console.log(`        state fields: ${parts.join(', ') || '(all under 4 KB)'}`)
        }
      }
    }
  }
}

// String census and the document-text question.
let stringCount = 0
let stringBytes = 0
let markerCount = 0
let markerBytes = 0
let bigCount = 0
let bigBytes = 0
for (let node = 0; node < nodeCount; node += 1) {
  if (!isString(node)) continue
  const size = selfSizeOf(node)
  stringCount += 1
  stringBytes += size
  if (size >= 10240) { bigCount += 1; bigBytes += size }
  if (nameOf(node).includes(marker)) { markerCount += 1; markerBytes += size }
}
console.log(`\n## Strings\n`)
console.log(`  all: ${stringCount.toLocaleString()} strings, ${(stringBytes / MB).toFixed(2)} MB`)
console.log(`  >= 10 KB: ${bigCount} strings, ${(bigBytes / MB).toFixed(2)} MB`)
console.log(`  containing ${JSON.stringify(marker)}: ${markerCount} strings, ${(markerBytes / MB).toFixed(2)} MB`)

// Where the big strings sit, by their first strong retainer's constructor.
const retainerName = new Map()
for (let node = 0, edge = 0; node < nodeCount; node += 1) {
  for (; edge < firstEdge[node + 1]; edge += 1) {
    if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
    const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
    if (!isString(child) || selfSizeOf(child) < 10240) continue
    const key = `${nameOf(node) || typeOf(node)} .${strings[edges[edge * edgeFieldCount + E.name_or_index]]}`
    const entry = retainerName.get(key) ?? { count: 0, bytes: 0 }
    entry.count += 1
    entry.bytes += selfSizeOf(child)
    retainerName.set(key, entry)
  }
}
console.log('\n  retainers of strings >= 10 KB (first strong referrer):')
for (const [key, entry] of [...retainerName.entries()].sort((left, right) => right[1].bytes - left[1].bytes).slice(0, 15)) {
  console.log(`    ${(entry.bytes / MB).toFixed(2).padStart(7)} MB  ${String(entry.count).padStart(5)}  ${key}`)
}

let detached = 0
let detachedBytes = 0
if (F.detachedness !== undefined) {
  for (let node = 0; node < nodeCount; node += 1) {
    if (nodes[node * nodeFieldCount + F.detachedness] !== 2) continue
    detached += 1
    detachedBytes += selfSizeOf(node)
  }
}
console.log(`\n## Detached DOM wrappers: ${detached} nodes, ${(detachedBytes / 1024).toFixed(1)} KB`)

// Constructor census, shallow only (cheap and enough for rung-to-rung diffs).
const byName = new Map()
for (let node = 0; node < nodeCount; node += 1) {
  const type = typeOf(node)
  const key = isString(node) || type === 'number' ? `(${type})` : `${nameOf(node)} [${type}]`
  const entry = byName.get(key) ?? { count: 0, self: 0 }
  entry.count += 1
  entry.self += selfSizeOf(node)
  byName.set(key, entry)
}
console.log('\n## Top constructors by shallow size\n')
console.log('    shallowMB     count  constructor')
for (const [key, entry] of [...byName.entries()].sort((left, right) => right[1].self - left[1].self).slice(0, 20)) {
  console.log(`  ${(entry.self / MB).toFixed(2).padStart(9)}  ${String(entry.count).padStart(8)}  ${key}`)
}
