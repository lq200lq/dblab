import { constants } from 'node:fs'
import { access, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, basename, join } from 'node:path'

import { CliError } from '../core/errors'

const BACKUP_SUFFIX = '.dblab.bak'

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * 每个配置文件只备份一次：`<file>.dblab.bak`。
 * 反复执行 setup 时如果每次都覆盖备份，第一次的原始状态就丢了，
 * 而「同一份备份」正好是这个工具能安全试错的凭据。
 */
export async function backupOnce(path: string): Promise<string | null> {
  const backupPath = `${path}${BACKUP_SUFFIX}`
  if (await pathExists(backupPath)) return backupPath
  await copyFile(path, backupPath)
  return backupPath
}

/**
 * 原子写：临时文件必须与目标同目录（跨设备 rename 会失败），最后 rename 覆盖。
 *
 * Windows 上目标文件常被正在运行的 Agent 进程占着，rename 会拿到 EPERM/EBUSY，
 * 所以重试几次；仍失败就明确告诉用户「关掉那个工具再试」，而不是抛原始 errno。
 */
export async function writeAtomic(path: string, content: string): Promise<void> {
  const dir = dirname(path)
  const tempPath = join(dir, `.${basename(path)}.dblab-${process.pid}-${Date.now()}.tmp`)
  await writeFile(tempPath, content, 'utf8')

  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await rename(tempPath, path)
      return
    } catch (error) {
      lastError = error
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await new Promise((resolve) => setTimeout(resolve, 120 * (attempt + 1)))
    }
  }

  await rm(tempPath, { force: true })
  const code = (lastError as NodeJS.ErrnoException | undefined)?.code
  throw new CliError(
    'write',
    `写入失败：${path}`,
    code === 'EPERM' || code === 'EBUSY' || code === 'EACCES'
      ? '文件被占用，请先退出对应的 Agent 工具（Claude Code / Cursor / Codex / Qoder）再重试。'
      : `系统返回 ${code ?? '未知错误'}。`,
  )
}
