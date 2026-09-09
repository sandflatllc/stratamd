// Adapted from T3 Code SnapShotAccessibility.ts, MIT, Copyright 2026 T3 Tools Inc.
// Permission is granted, free of charge, to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies, provided this notice is retained.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
export interface AccessibleNode { name?: string | null; value?: string | null; role?: string; children?: AccessibleNode[] }
export function accessibleText(root: AccessibleNode): string {
  const stack = [root], seen = new Set<string>(), lines: string[] = []
  let visited = 0, length = 0
  while (stack.length && visited++ < 2_000 && length < 16_000) {
    const node = stack.pop()!
    if (/password|protected/i.test(node.role ?? '')) continue
    for (const raw of [node.name, node.value]) {
      const value = raw?.replaceAll('\0', '').trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      const text = value.slice(0, 16_000 - length)
      lines.push(text); length += text.length + 1
    }
    if (node.children) stack.push(...node.children.slice(0, 2_000).reverse())
  }
  return lines.join('\n')
}
export interface WindowBounds { x: number; y: number; width: number; height: number }
export function selectedAccessibleWindow<T extends { name: string | null; bounds: WindowBounds | null }>(windows: T[], title: string, bounds: WindowBounds): T | undefined {
  const matches = windows.filter(window => window.name?.trim() === title.trim() && window.bounds && (['x', 'y', 'width', 'height'] as const).every(key => Math.abs(window.bounds![key] - bounds[key]) <= 2))
  return matches.length === 1 ? matches[0] : undefined
}
