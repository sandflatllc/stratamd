#!/usr/bin/env node
// Lab analyzer for docs/plans/open/performance-plan.md item 6: who retains the detached
// DOM that survives a forced GC. BFS from the GC roots over strong edges,
// remembering each node's discoverer, then prints the shortest retainer path
// for a sample of detached nodes and the census of path shapes.
//
// Usage: node --max-old-space-size=12288 scripts/heap-detached.mjs <file.heapsnapshot> [--samples 6]
import { readFileSync } from 'node:fs'

const [, , snapshotPath, ...flags] = process.argv
if (!snapshotPath) {
  console.error('usage: node scripts/heap-detached.mjs <file.heapsnapshot> [--samples N]')
  process.exit(1)
}
const samples = Number(flags[flags.indexOf('--samples') + 1] ?? 6)

const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'))
const meta = snapshot.snapshot.meta
const nodeTypes = meta.node_types[0]
const edgeTypes = meta.edge_types[0]
const { strings, nodes, edges } = snapshot
const nodeFieldCount = meta.node_fields.length
const edgeFieldCount = meta.edge_fields.length
const nodeCount = nodes.length / nodeFieldCount
const F = Object.fromEntries(meta.node_fields.map((name, index) => [name, index]))
const E = Object.fromEntries(meta.edge_fields.map((name, index) => [name, index]))
const WEAK = edgeTypes.indexOf('weak')

const typeOf = (node) => nodeTypes[nodes[node * nodeFieldCount + F.type]]
const nameOf = (node) => strings[nodes[node * nodeFieldCount + F.name]]
const selfSizeOf = (node) => nodes[node * nodeFieldCount + F.self_size]
const idOf = (node) => nodes[node * nodeFieldCount + F.id]

const firstEdge = new Uint32Array(nodeCount + 1)
for (let node = 0; node < nodeCount; node += 1) firstEdge[node + 1] = firstEdge[node] + nodes[node * nodeFieldCount + F.edge_count]

const edgeName = (edge) => {
  const type = edgeTypes[edges[edge * edgeFieldCount + E.type]]
  const value = edges[edge * edgeFieldCount + E.name_or_index]
  return type === 'element' || type === 'hidden' ? `[${value}]` : `.${strings[value]}`
}
const label = (node) => {
  const type = typeOf(node)
  const name = nameOf(node)
  if (type === 'string' || type === 'concatenated string' || type === 'sliced string') return `"${name.slice(0, 40).replace(/\n/g, '\\n')}"`
  return `${name || '(anon)'} [${type}]`
}

// Breadth-first from the root so every node gets its shortest retainer chain.
const parent = new Int32Array(nodeCount).fill(-1)
const viaEdge = new Int32Array(nodeCount).fill(-1)
{
  const queue = new Int32Array(nodeCount)
  let head = 0
  let tail = 0
  const seen = new Uint8Array(nodeCount)
  seen[0] = 1
  queue[tail++] = 0
  while (head < tail) {
    const node = queue[head++]
    for (let edge = firstEdge[node]; edge < firstEdge[node + 1]; edge += 1) {
      if (edges[edge * edgeFieldCount + E.type] === WEAK) continue
      const child = edges[edge * edgeFieldCount + E.to_node] / nodeFieldCount
      if (seen[child]) continue
      seen[child] = 1
      parent[child] = node
      viaEdge[child] = edge
      queue[tail++] = child
    }
  }
}

const path = (node, limit = 14) => {
  const steps = []
  let current = node
  while (current > 0 && steps.length < limit && parent[current] >= 0) {
    steps.push(`${edgeName(viaEdge[current])} of ${label(parent[current])}`)
    current = parent[current]
  }
  return steps
}

const detached = []
for (let node = 0; node < nodeCount; node += 1) if (nodes[node * nodeFieldCount + F.detachedness] === 2) detached.push(node)
console.log(`\n# ${snapshotPath.split('/').at(-1)}`)
console.log(`detached nodes: ${detached.length}, ${(detached.reduce((sum, node) => sum + selfSizeOf(node), 0) / 1024).toFixed(1)} KB shallow\n`)

// Census of the first non-DOM ancestor on each detached node's shortest path.
const domNames = new Set(['Text', 'HTMLElement', 'Element', 'Node', 'HTMLDivElement', 'HTMLParagraphElement'])
const census = new Map()
for (const node of detached) {
  let current = node
  let hops = 0
  while (current > 0 && parent[current] >= 0 && hops < 60) {
    const owner = parent[current]
    const name = nameOf(owner)
    const isDom = name.startsWith('<') || domNames.has(name) || /^HTML|^SVG/.test(name) || name === 'Text'
    if (!isDom) {
      const key = `${edgeName(viaEdge[current])} of ${label(owner)}`
      census.set(key, (census.get(key) ?? 0) + 1)
      break
    }
    current = owner
    hops += 1
  }
}
console.log('## First non-DOM holder on each detached node\'s shortest retainer path\n')
for (const [key, count] of [...census.entries()].sort((left, right) => right[1] - left[1]).slice(0, 15)) {
  console.log(`  ${String(count).padStart(7)}  ${key}`)
}

console.log('\n## Sample retainer paths\n')
const ordered = detached.slice().sort((left, right) => selfSizeOf(right) - selfSizeOf(left))
const picks = [...new Set([...ordered.slice(0, Math.ceil(samples / 2)), ...detached.filter((node) => nameOf(node).startsWith('<')).slice(0, samples)])].slice(0, samples)
for (const node of picks) {
  console.log(`  @${idOf(node)} ${label(node)} (${selfSizeOf(node)} B)`)
  for (const step of path(node)) console.log(`      <- ${step}`)
  console.log('')
}
