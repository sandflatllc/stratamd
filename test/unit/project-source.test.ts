import { describe, expect, it } from 'vitest'
import { joinPath, parentPath, parseGithubRepository, parseGitUrl, repositoryFolderName } from '../../src/core/project-source'

describe('project sources', () => {
  it('accepts the supported clone protocols without treating local paths or shell text as URLs', () => {
    for (const url of ['https://github.com/org/repo.git', 'ssh://git@host/org/repo.git', 'git@host:org/repo.git']) expect(parseGitUrl(url)).toBe(url)
    for (const url of ['/home/repo', 'file:///repo', 'https://host/', 'git@host:repo extra', 'git clone https://host/repo']) expect(parseGitUrl(url)).toBeNull()
    expect(repositoryFolderName('git@host:org/repo.git')).toBe('repo')
  })
  it('validates GitHub owner and repository names', () => {
    expect(parseGithubRepository(' t3-oss/t3code.git ')).toBe('t3-oss/t3code')
    for (const input of ['repo', 'org/repo/extra', 'org/..', 'https://github.com/org/repo']) expect(parseGithubRepository(input)).toBeNull()
  })
  it('keeps root and home paths usable', () => {
    expect(parentPath('/projects/repo/')).toBe('/projects')
    expect(parentPath('/projects')).toBe('/')
    expect(parentPath('/')).toBe('/')
    expect(parentPath('~')).toBe('~')
    expect(joinPath('/', 'repo')).toBe('/repo')
    expect(joinPath('~/Projects/', '/repo')).toBe('~/Projects/repo')
  })
})
