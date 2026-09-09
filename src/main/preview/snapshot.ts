/** The screenshot travels separately. Trim the textual envelope as complete
 * fields/elements so every retained selector remains usable. */
export function boundSnapshot(snapshot: Record<string, unknown>, maximumBytes = 60_000): Record<string, unknown> {
  const result = { ...snapshot }
  const size = () => Buffer.byteLength(JSON.stringify(result), 'utf8')
  if (size() <= maximumBytes) return result
  result.accessibilityTree = { role: 'document', name: String(result.title ?? '').slice(0, 200) }
  for (const field of ['consoleEntries', 'networkEntries', 'actionTimeline']) {
    const entries = result[field]
    if (Array.isArray(entries)) result[field] = entries.slice(-10).map(value => JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'string' ? item.slice(0, 500) : item)))
  }
  result.visibleText = String(result.visibleText ?? '').slice(0, 8000)
  result.url = String(result.url ?? '').slice(0, 2048)
  result.title = String(result.title ?? '').slice(0, 2048)
  const elements = Array.isArray(result.interactiveElements) ? [...result.interactiveElements] : []
  result.interactiveElements = elements
  result.truncated = true
  while (elements.length && size() > maximumBytes) elements.pop()
  return result
}
