import { mkdtemp, readFile, access, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { AskScanQueue, askConfigurationProblem, resolveAskInvocation, scanAsks } from '../../src/main/engine/ask-scan'
const fixture=resolve('test/fixtures/ask-codex.cjs')
describe('ask subprocess and queue',()=>{
  it('uses the chosen shadow home, low/fast, tool restrictions and a disposable cwd',async()=>{
    const root=await mkdtemp(join(tmpdir(),'ask-test-')), record=join(root,'record')
    try {
      const context={executable:process.execPath,baseDirectory:root,directory:root}
      const settings={providerInstances:{codex:{driver:'codex',enabled:true,config:{binaryPath:fixture,homePath:'base',shadowHomePath:'shadow'}}},textGenerationModelSelection:{instanceId:'codex',model:'gpt-5.6-luna'}}
      const invocation=await resolveAskInvocation(context,settings)
      invocation.env.ASK_FIXTURE_RECORD=record
      expect(await scanAsks(invocation,'Which date?',[],new AbortController().signal)).toEqual([{quote:'Which date?'}])
      const saved=JSON.parse(await readFile(record,'utf8'))
      expect(saved.home).toBe(join(root,'shadow'))
      expect(saved.args).toEqual(expect.arrayContaining(['--ignore-user-config','model_reasoning_effort="low"','service_tier="fast"','shell_tool']))
      expect(saved.input).toContain('Which date?')
      await expect(access(saved.cwd)).rejects.toThrow()
      expect(askConfigurationProblem(null,settings)).toContain('managed')
    } finally {await rm(root,{recursive:true,force:true})}
  })
  it.each(['fail','malformed','tool','tool-no-newline','hang','orphan'])('rejects %s without publishing a result',async mode=>{
    await expect(scanAsks({binary:fixture,model:'luna',env:{...process.env,ASK_FIXTURE_MODE:mode}},'Which date?',[],new AbortController().signal,['hang','orphan'].includes(mode)?500:2000)).rejects.toThrow()
  })
  it('cancels a running process and never launches an already aborted one',async()=>{
    const control=new AbortController();control.abort()
    await expect(scanAsks({binary:fixture,model:'luna',env:process.env},'Which date?',[],control.signal)).rejects.toThrow('cancelled')
    const root = await mkdtemp(join(tmpdir(), 'ask-cancel-')), record = join(root, 'record')
    const next = new AbortController()
    const pending = scanAsks({ binary: fixture, model: 'luna', env: { ...process.env, ASK_FIXTURE_MODE: 'hang', ASK_FIXTURE_RECORD: record } }, 'Which date?', [], next.signal)
    try {
      await vi.waitFor(async () => expect(JSON.parse(await readFile(record, 'utf8')).pid).toBeGreaterThan(0))
      const saved = JSON.parse(await readFile(record, 'utf8'))
      next.abort()
      await expect(pending).rejects.toThrow('cancelled')
      await expect(access(saved.cwd)).rejects.toThrow()
      expect(() => process.kill(saved.pid, 0)).toThrow()
    } finally { next.abort(); await pending.catch(() => undefined); await rm(root, { recursive: true, force: true }) }

  })
  it('serializes threads, replaces queued work, and pauses background work without blocking explicit retry',async()=>{
    const queue=new AskScanQueue(), seen:string[]=[]
    queue.policy(true)
    queue.enqueue('a',false,async()=>{seen.push('obsolete')})
    queue.enqueue('a',false,async()=>{seen.push('a')})
    queue.enqueue('b',true,async()=>{seen.push('b')})
    await vi.waitFor(()=>expect(seen).toEqual(['b']))
    queue.policy(false)
    await vi.waitFor(()=>expect(seen).toEqual(['b','a']))
    await queue.stop()
  })
})

it('refuses oversized inputs and missing executables', async () => {
  const signal = new AbortController().signal
  await expect(scanAsks({ binary: fixture, model: 'luna', env: process.env }, 'x'.repeat(120001), [], signal)).rejects.toThrow('too long')
  await expect(scanAsks({ binary: '/missing/strata-ask-codex', model: 'luna', env: process.env }, 'Which date?', [], signal)).rejects.toThrow()
})
