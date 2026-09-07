import { describe, expect, it } from 'vitest'
import { linkCopyTarget, normalizePosixPath } from '../../src/core/link-target'

const doc = '/home/o/docs/design/README.md'

describe('linkCopyTarget', () => {
  it('copies a web address as written', () => {
    expect(linkCopyTarget('https://example.com/a?b=1#c', doc)).toEqual({ kind: 'web', address: 'https://example.com/a?b=1#c' })
    expect(linkCopyTarget('  http://x.test ', doc)).toEqual({ kind: 'web', address: 'http://x.test' })
  })
  it('resolves a relative file link against the document folder and drops query and fragment', () => {
    expect(linkCopyTarget('prototype.html?state=working', doc)).toEqual({ kind: 'file', path: '/home/o/docs/design/prototype.html', written: 'prototype.html?state=working' })
    expect(linkCopyTarget('../guide.md#intro', doc)).toEqual({ kind: 'file', path: '/home/o/docs/guide.md', written: '../guide.md#intro' })
    expect(linkCopyTarget('./a%20b/c.md', doc)).toEqual({ kind: 'file', path: '/home/o/docs/design/a b/c.md', written: './a%20b/c.md' })
  })
  it('resolves a conversation link against the project folder', () => {
    expect(linkCopyTarget('src/x.ts', '/work/proj/.conversation.md')).toEqual({ kind: 'file', path: '/work/proj/src/x.ts', written: 'src/x.ts' })
  })
  it('keeps absolute paths and file URLs as paths', () => {
    expect(linkCopyTarget('/etc/hosts', doc)).toEqual({ kind: 'file', path: '/etc/hosts', written: '/etc/hosts' })
    expect(linkCopyTarget('file:///tmp/a%20b/x.html', doc)).toEqual({ kind: 'file', path: '/tmp/a b/x.html', written: 'file:///tmp/a%20b/x.html' })
  })
  it('offers only the written form when no document folder is known', () => {
    expect(linkCopyTarget('notes.md', '')).toEqual({ kind: 'file', path: null, written: 'notes.md' })
  })
  it('treats other schemes and fragment-only links as addresses', () => {
    expect(linkCopyTarget('mailto:a@b.c', doc)).toEqual({ kind: 'other', address: 'mailto:a@b.c' })
    expect(linkCopyTarget('#heading', doc)).toEqual({ kind: 'other', address: '#heading' })
    expect(linkCopyTarget('   ', doc)).toBeNull()
    expect(linkCopyTarget('file://server/share/x.html', doc)).toEqual({ kind: 'file', path: null, written: 'file://server/share/x.html' })
  })
})

describe('normalizePosixPath', () => {
  it('collapses dot segments', () => {
    expect(normalizePosixPath('/a/./b/../c//d/')).toBe('/a/c/d')
    expect(normalizePosixPath('/../x')).toBe('/x')
  })
})
