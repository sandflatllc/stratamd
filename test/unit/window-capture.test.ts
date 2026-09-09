import { expect, it } from 'vitest'
import { accessibleText, selectedAccessibleWindow } from '../../src/main/capture/accessibility'
import { windowCaptureContextSchema } from '../../src/shared/window-capture-schema'
it('bounds selected-window text, strips nulls and duplicate labels, and omits protected fields', () => {
  expect(accessibleText({ name: 'Window', children: [{ name: 'Name', value: 'Dillon\0' }, { name: 'Name' }, { role: 'password', name: 'Secret', value: 'hidden' }] })).toBe('Window\nName\nDillon')
  expect(accessibleText({ value: 'x'.repeat(20_000) })).toHaveLength(16_000)
  expect(accessibleText({ children: Array.from({ length: 10_000 }, (_, i) => ({ name: String(i) })) }).split('\n').length).toBeLessThanOrEqual(2_000)
})
it('external window context is bounded and rejects arbitrary capture metadata', () => {
  expect(windowCaptureContextSchema.safeParse({ title: 'Test', app: null, windowId: '123', processId: 5, accessibilityText: 'x'.repeat(16_001), textStatus: 'available' }).success).toBe(false)
})

it('reads only an unambiguous title and bounds match within the selected app', () => {
  const bounds = { x: 10, y: 20, width: 600, height: 400 }
  const chosen = { name: 'Inspection', bounds }
  const other = { name: 'Inspection', bounds: { ...bounds, x: 900 } }
  expect(selectedAccessibleWindow([other, chosen], 'Inspection', bounds)).toBe(chosen)
  expect(selectedAccessibleWindow([chosen, { ...chosen }], 'Inspection', bounds)).toBeUndefined()
  expect(selectedAccessibleWindow([chosen], 'Other window', bounds)).toBeUndefined()
  expect(selectedAccessibleWindow([{ name: 'Inspection', bounds: null }], 'Inspection', bounds)).toBeUndefined()
})
