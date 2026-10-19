import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { beforeEach, describe, expect, it } from 'vitest'

import { backupOnce, readTextIfExists, writeAtomic } from '../src/fs/atomic'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dblab-cli-atomic-'))
})

describe('readTextIfExists', () => {
  it('不存在返回 null，存在返回内容', async () => {
    const path = join(dir, 'a.json')
    expect(await readTextIfExists(path)).toBeNull()
    await writeFile(path, 'hello', 'utf8')
    expect(await readTextIfExists(path)).toBe('hello')
  })
})

describe('backupOnce', () => {
  it('首次备份后不再覆盖', async () => {
    const path = join(dir, 'config.json')
    await writeFile(path, 'v1', 'utf8')

    const first = await backupOnce(path)
    expect(first).toBe(`${path}.dblab.bak`)
    expect(await readFile(first!, 'utf8')).toBe('v1')

    await writeFile(path, 'v2', 'utf8')
    const second = await backupOnce(path)
    expect(second).toBe(first)
    expect(await readFile(second!, 'utf8')).toBe('v1')
  })
})

describe('writeAtomic', () => {
  it('覆盖写入且不残留临时文件', async () => {
    const path = join(dir, 'x.json')
    await writeFile(path, 'old', 'utf8')
    await writeAtomic(path, 'new')
    expect(await readFile(path, 'utf8')).toBe('new')

    const { readdir } = await import('node:fs/promises')
    expect((await readdir(dir)).filter((name) => name.includes('.tmp'))).toEqual([])
  })
})
