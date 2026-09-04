import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'

interface TestTarget {
  readonly path: string
}

async function canonicalTarget(input: string): Promise<string> {
  const absolute = path.resolve(input)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    const canonicalParent = parent === absolute ? absolute : await canonicalTarget(parent)
    return path.join(canonicalParent, path.basename(absolute))
  }
}

async function versionOf(file: string): Promise<string> {
  const info = await stat(file, { bigint: true })
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}`
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function typeOf(info: Awaited<ReturnType<typeof stat>>): 'file' | 'directory' | 'other' {
  if (info.isFile()) return 'file'
  if (info.isDirectory()) return 'directory'
  return 'other'
}

export function testSession(cwd: string, id = 'test/session:1'): Session {
  return {
    id,
    header: { cwd },
  } as unknown as Session
}

export function testContext(workspace: string): Context {
  const fs = {
    async resolve(input: string, options: { cwd?: string } = {}): Promise<TestTarget> {
      return { path: await canonicalTarget(path.resolve(options.cwd ?? workspace, input)) }
    },
    contains(parent: TestTarget, child: TestTarget): boolean {
      return inside(parent.path, child.path)
    },
    async stat(target: TestTarget): Promise<undefined | { type: 'file' | 'directory' | 'other'; size: number; version: string }> {
      try {
        const info = await stat(target.path)
        return { type: typeOf(info), size: info.size, version: await versionOf(target.path) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async lstat(input: string, options: { cwd?: string } = {}): Promise<undefined | { type: 'file' | 'directory' | 'symlink' | 'other' }> {
      try {
        const info = await lstat(path.resolve(options.cwd ?? workspace, input))
        return { type: info.isSymbolicLink() ? 'symlink' : typeOf(info) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw error
      }
    },
    async readText(target: TestTarget): Promise<string> {
      return await readFile(target.path, 'utf8')
    },
    async streamText(target: TestTarget): Promise<AsyncIterable<string>> {
      const stream = createReadStream(target.path, { encoding: 'utf8' })
      return stream
    },
    async listDir(target: TestTarget): Promise<readonly { name: string; type: 'file' | 'directory' | 'symlink' | 'other' }[]> {
      const entries = await readdir(target.path, { withFileTypes: true })
      return entries.map(entry => ({
        name: entry.name,
        type: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
      }))
    },
    async writeText(
      target: TestTarget,
      content: string,
      mode: { kind: 'createIfAbsent' } | { kind: 'replaceIfVersion'; version: string },
    ): Promise<void> {
      if (mode.kind === 'createIfAbsent') {
        try {
          await writeFile(target.path, content, { encoding: 'utf8', flag: 'wx' })
          return
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new FsError('file already exists', 'FS_STALE_VERSION')
          }
          throw error
        }
      }
      let current: string
      try {
        current = await versionOf(target.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new FsError('file was not observed', 'FS_NOT_OBSERVED')
        }
        throw error
      }
      if (current !== mode.version) throw new FsError('stale version', 'FS_STALE_VERSION')
      await writeFile(target.path, content, 'utf8')
    },
  }

  return {
    fs,
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }),
    },
    logger: () => ({ warn: () => {} }),
  } as unknown as Context
}

export async function makeWorkspace(prefix: string): Promise<string> {
  const root = path.join(process.env.TMPDIR ?? '/tmp', `${prefix}-${process.pid}-${crypto.randomUUID()}`)
  await mkdir(root, { recursive: true })
  return await realpath(root)
}

export async function removeWorkspace(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}

export function fileUrl(file: string): string {
  return pathToFileURL(file).href
}
