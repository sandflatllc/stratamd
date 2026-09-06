import { describe, expect, it } from 'vitest'
import { partitionFor, PreviewFailure, PreviewTabModel, type PreviewTabRecord } from '../../src/main/preview/tabs'
import { keyEvent, parseLocator } from '../../src/main/preview/scripts'
import { pageName, previewPillName, resolvePreviewAddress, resolveViewport, splitAddress, viewportCaption, viewportLabel, viewportSetting } from '../../src/shared/preview'

function tab(id: string, kind: 'owner' | 'agent', threadId: string | null, openedAt: number): PreviewTabRecord {
  return { id, projectId: 'p1', workingFolder: '/work', partition: partitionFor('/work'), kind, threadId, openedUrl: 'http://localhost:5173/', url: 'http://localhost:5173/', title: 'Clients', loading: false, canGoBack: false, canGoForward: false, viewport: { mode: 'fill' }, paused: false, working: false, activity: null, error: null, openedAt, document: 0 }
}

describe('preview tab routing (docs/plans/open/visual-review, phase 2)', () => {
  it('sends a named request to its tab, an unnamed one to the thread\'s current tab, and never to the owner\'s tab', () => {
    const model = new PreviewTabModel()
    model.add(tab('tab_owner', 'owner', null, 1))
    model.add(tab('tab_a1', 'agent', 't1', 2))
    model.add(tab('tab_a2', 'agent', 't1', 3))
    expect(model.resolve('t1', undefined).id).toBe('tab_a2')
    expect(model.resolve('t1', 'tab_a1').id).toBe('tab_a1')
    expect(model.resolve('t2', 'tab_owner').id).toBe('tab_owner')
    expect(() => model.resolve('t2', undefined)).toThrow(PreviewFailure)
    expect(() => model.resolve('t2', undefined)).toThrow('no preview tab yet')
    model.remove('tab_a2')
    expect(() => model.resolve('t1', 'tab_a2')).toThrow('closed or was never opened')
    // The last tab a thread opened is current; closing it leaves the thread without one rather than falling back.
    expect(model.currentFor('t1')).toBeNull()
    model.setCurrent('t1', 'tab_a1')
    expect(model.resolve('t1', undefined).id).toBe('tab_a1')
  })

  it('persists only the owner\'s tabs and keys browser storage by working folder', () => {
    const model = new PreviewTabModel()
    model.add(tab('tab_owner', 'owner', null, 1))
    model.add(tab('tab_a1', 'agent', 't1', 2))
    expect(model.persisted().map((entry) => entry.id)).toEqual(['tab_owner'])
    expect(partitionFor('/work')).toBe(partitionFor('/work'))
    expect(partitionFor('/work')).not.toBe(partitionFor('/other'))
    expect(partitionFor('/work')).toMatch(/^persist:strata-preview-[0-9a-f]{12}$/)
  })
})

describe('locators and keys', () => {
  it('parses CSS, text, and role locators', () => {
    expect(parseLocator({ selector: 'button.save' })).toEqual({ kind: 'css', value: 'button.save' })
    expect(parseLocator({ locator: 'text=Continue' })).toEqual({ kind: 'text', value: 'Continue' })
    expect(parseLocator({ locator: "role=button[name='Send']" })).toEqual({ kind: 'role', value: 'button', name: 'Send' })
    expect(parseLocator({ locator: 'role=textbox' })).toEqual({ kind: 'role', value: 'textbox' })
    expect(() => parseLocator({})).toThrow('Provide a selector or locator')
  })

  it('maps key names to Chromium key codes', () => {
    expect(keyEvent('Enter')).toEqual({ keyCode: 'Enter', char: '\r' })
    expect(keyEvent('Escape')).toEqual({ keyCode: 'Escape', char: null })
    expect(keyEvent('ArrowDown')).toEqual({ keyCode: 'Down', char: null })
    expect(keyEvent('a')).toEqual({ keyCode: 'a', char: 'a' })
    expect(keyEvent('F5')).toEqual({ keyCode: 'F5', char: null })
  })
})

describe('addresses and sizes', () => {
  it('treats a typed address as supplied: loopback gets http, other hosts https, and nothing else opens', () => {
    expect(resolvePreviewAddress('localhost:5173')).toEqual({ url: 'http://localhost:5173/' })
    expect(resolvePreviewAddress('127.0.0.1:3000/office/clients')).toEqual({ url: 'http://127.0.0.1:3000/office/clients' })
    expect(resolvePreviewAddress('mesa.example')).toEqual({ url: 'https://mesa.example/' })
    expect(resolvePreviewAddress('https://mesa.example/clients?tab=1')).toEqual({ url: 'https://mesa.example/clients?tab=1' })
    expect(resolvePreviewAddress('file:///etc/passwd')).toEqual({ error: 'Only http and https pages can be previewed' })
    expect(resolvePreviewAddress('javascript:alert(1)')).toEqual({ error: 'Only http and https pages can be previewed' })
    expect(resolvePreviewAddress('   ')).toEqual({ error: 'Type an address to open' })
  })

  it('names device sizes as narrowed viewports and answers in T3\'s words', () => {
    const phone = resolveViewport({ mode: 'preset', preset: 'iphone-12-pro' })
    expect(phone).toEqual({ viewport: { mode: 'preset', preset: 'iphone-12-pro', label: 'Phone', width: 390, height: 844 } })
    if ('error' in phone) throw new Error('unexpected')
    expect(viewportLabel(phone.viewport)).toBe('Phone')
    expect(viewportCaption(phone.viewport)).toBe('Narrowed viewport · Phone · 390 × 844')
    expect(viewportSetting(phone.viewport)).toEqual({ _tag: 'preset', presetId: 'iphone-12-pro', width: 390, height: 844 })
    expect(viewportLabel({ mode: 'fill' })).toBe('Fit window')
    expect(viewportCaption({ mode: 'fill' })).toBeNull()
    expect(resolveViewport({ mode: 'freeform', width: 600, height: 400 })).toEqual({ viewport: { mode: 'freeform', width: 600, height: 400 } })
    expect(resolveViewport({ mode: 'freeform', width: 10, height: 400 })).toMatchObject({ error: expect.stringContaining('between') })
    expect(resolveViewport({ mode: 'preset', preset: 'toaster' })).toEqual({ error: 'There is no size called toaster' })
  })

  it('names pages and pills in plain words', () => {
    expect(pageName('http://localhost:5173/office/clients', 'Clients · Mesa')).toBe('Clients · Mesa')
    expect(pageName('http://localhost:5173/office/clients', '')).toBe('localhost:5173/office/clients')
    expect(pageName('', '')).toBe('New tab')
    expect(previewPillName('Mesa', { url: 'http://localhost:5173/', title: 'Clients' })).toBe('Mesa · Clients')
    expect(previewPillName('Mesa', null)).toBe('Mesa · Preview')
    expect(splitAddress('http://localhost:5173/office/clients?x=1')).toEqual({ host: 'localhost:5173', rest: '/office/clients?x=1' })
  })
})
