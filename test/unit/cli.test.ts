import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_HELP } from '../../src/cli/agent-help.js'
import { runCli, type CliRuntime } from '../../src/cli/commands.js'
import { parseStrataBlock } from '../../src/core/blocks.js'
import { parseMarkdown } from '../../src/core/markdown/index.js'

const temporaryDirectories: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function capture(): { runtime: CliRuntime; stdout: () => string; stderr: () => string } {
  let output = ''
  let errors = ''
  const writer = (append: (value: string) => void) => new Writable({
    write(chunk, _encoding, done) { append(chunk.toString()); done() },
  })
  return {
    runtime: { io: { stdout: writer((value) => { output += value }), stderr: writer((value) => { errors += value }) } },
    stdout: () => output,
    stderr: () => errors,
  }
}

async function environment() {
  const home = await mkdtemp(join(tmpdir(), 'stratamd-file-tool-'))
  temporaryDirectories.push(home)
  return {
    home,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, 'config'), XDG_DATA_HOME: join(home, 'data') },
  }
}

describe('agent contract', () => {
  it('prints PRD section 7 word for word', async () => {
    const prd = await readFile(join(process.cwd(), 'docs/PRD.md'), 'utf8')
    const contract = prd.match(/## 7\. Agent contract[\s\S]*?\`\`\`\`\n([\s\S]*?)\n\`\`\`\`/)?.[1]
    expect(contract).toBe(AGENT_HELP)
    const io = capture()
    expect(await runCli(['--agent-help'], io.runtime)).toBe(0)
    expect(io.stdout()).toBe(`${AGENT_HELP}\n`)
    expect(io.stderr()).toBe('')
  })

  it('ships valid skill action examples covering every contract verb', async () => {
    const skill = await readFile(join(process.cwd(), 'skills/stratamd/SKILL.md'), 'utf8')
    const examples = parseMarkdown(skill).ast.children.filter((node) => node.type === 'code' && node.lang === 'strata')
    expect(examples.length).toBeGreaterThan(0)
    const verbs = new Set<string>()
    for (const example of examples) {
      if (example.type !== 'code') continue
      const parsed = parseStrataBlock(`\`\`\`strata\n${example.value}\n\`\`\``)
      expect(parsed).not.toBeNull()
      for (const result of parsed!.results) {
        expect(result.error).toBeUndefined()
        expect(result.entry).toBeDefined()
        verbs.add(result.entry!.verb)
      }
    }
    const contractVerbs = /Available verbs are ([^.]+)\./.exec(AGENT_HELP)?.[1]
    expect(contractVerbs).toBeDefined()
    expect([...verbs].sort()).toEqual(contractVerbs!.replace(', and ', ', ').split(', ').sort())
  })

  it('documents only the four file-only jobs', async () => {
    const io = capture()
    expect(await runCli(['--help'], io.runtime)).toBe(0)
    expect(io.stdout()).toContain('open|theme|setup|doctor')
    expect(io.stdout()).toContain('never carries agent traffic')
    expect(io.stdout()).not.toContain('annotate')
  })
})

describe('file-only tool', () => {
  it('launches the app with a canonical Markdown path and never calls a transport', async () => {
    const { home, env } = await environment()
    const file = join(home, 'plan.md')
    await writeFile(file, '# Plan\n')
    let opened: string | undefined
    const io = capture()
    expect(await runCli(['open', file], { ...io.runtime, environment: env, launchApp: async (path) => { opened = path } })).toBe(0)
    expect(opened).toBe(file)
    expect(JSON.parse(io.stdout())).toEqual({ opened: file })
  })

  it('rejects missing and non-Markdown open targets with named JSON errors', async () => {
    const { home, env } = await environment()
    for (const [file, code] of [[join(home, 'missing.md'), 'NOT_FOUND'], [join(home, 'notes.txt'), 'NOT_MARKDOWN']] as const) {
      const io = capture()
      expect(await runCli(['open', file], { ...io.runtime, environment: env, launchApp: async () => undefined })).toBe(2)
      expect(JSON.parse(io.stderr())).toMatchObject({ code, detail: { file } })
    }
  })

  it('reads the active or named theme without changing its file', async () => {
    const { home, env } = await environment()
    const config = join(home, 'config', 'stratamd')
    await mkdir(join(config, 'themes'), { recursive: true })
    const theme = join(config, 'themes', 'owner.json')
    const raw = '{"schema-version":3,"name":"Owner","fonts":{"text":"Serif"}}\n'
    await writeFile(theme, raw)
    await writeFile(join(config, 'settings.json'), JSON.stringify({ formatVersion: 2, theme: 'owner' }))

    const io = capture()
    expect(await runCli(['theme', '--json'], { ...io.runtime, environment: env })).toBe(0)
    expect(JSON.parse(io.stdout())).toMatchObject({ id: 'owner', name: 'Owner' })
    expect(await readFile(theme, 'utf8')).toBe(raw)
  })

  it('reports local paths without probing the running app', async () => {
    const { env } = await environment()
    const io = capture()
    expect(await runCli(['doctor'], { ...io.runtime, environment: env })).toBe(0)
    const report = JSON.parse(io.stdout())
    expect(report.directories).toMatchObject({ data: expect.stringContaining('stratamd'), config: expect.stringContaining('stratamd') })
    expect(report.paths.engineCredential).toContain('engine-credential.json')
  })

  it('rejects every retired traffic command', async () => {
    for (const command of ['attach', 'annotate', 'edit', 'state', 'changes', 'send', 'lead', 'save']) {
      const io = capture()
      expect(await runCli([command], io.runtime)).toBe(1)
      expect(JSON.parse(io.stderr())).toMatchObject({ code: 'USAGE' })
    }
  })
})
