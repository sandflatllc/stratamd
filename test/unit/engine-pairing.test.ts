import { describe, expect, it } from 'vitest'
import { resolvePairingTarget } from '../../src/main/engine/pairing'

describe('engine pairing target (§5.1)', () => {
  it('reads the code from a pairing link query or hash and keeps only the origin', () => {
    expect(resolvePairingTarget({ link: 'http://127.0.0.1:3774/pair?token=abc123' })).toEqual({ server: 'http://127.0.0.1:3774', code: 'abc123' })
    expect(resolvePairingTarget({ link: 'https://desk.example/pair#token=hash-code' })).toEqual({ server: 'https://desk.example', code: 'hash-code' })
  })

  it('follows a hosted pairing link to the server it names', () => {
    expect(resolvePairingTarget({ link: 'https://hosted.example/pair?host=http://10.0.0.5:3774&token=t1' })).toEqual({ server: 'http://10.0.0.5:3774', code: 't1' })
  })

  it('accepts a bare host plus code and refuses missing pieces with plain words', () => {
    expect(resolvePairingTarget({ host: '127.0.0.1:3774', code: ' code-9 ' })).toEqual({ server: 'http://127.0.0.1:3774', code: 'code-9' })
    expect(resolvePairingTarget({ host: 'wss://desk.example', code: 'c' })).toEqual({ server: 'https://desk.example', code: 'c' })
    expect(() => resolvePairingTarget({ host: '127.0.0.1:3774', code: '' })).toThrow('Enter the pairing code shown in T3')
    expect(() => resolvePairingTarget({ link: 'http://127.0.0.1:3774/pair' })).toThrow('carries no code')
    expect(() => resolvePairingTarget({ host: 'ftp://x', code: 'c' })).toThrow('must use http or https')
  })
})
