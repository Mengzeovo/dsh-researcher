import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { Session } from '@deepseek-ai/dsh-session'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { vi } from 'vitest'
import type { GitCheckpointProvider, OutputCheckpoint, ReproductionSpec } from '../src/checkpoint.ts'
import { ResearcherError } from '../src/errors.ts'
import { ResearchStore } from '../src/storage.ts'
import type { ResearchId, StartResearchRunRequest } from '../src/types.ts'

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
    async readBytes(target: TestTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
      const info = await stat(target.path)
      if (info.size > maxBytes) throw new FsError('file exceeds byte bound', 'FS_TOO_LARGE')
      const bytes = await readFile(target.path)
      if (bytes.byteLength > maxBytes) throw new FsError('file exceeds byte bound', 'FS_TOO_LARGE')
      return bytes
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
    emit: vi.fn(),
    sandboxPolicy: {
      resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }),
    },
    logger: () => ({ warn: () => {} }),
  } as unknown as Context
}

/** Fail one matching write in testContext's real-file-backed filesystem. */
export async function failNextWrite(
  ctx: Context,
  relativePath: string,
  message: string,
  mode?: 'createIfAbsent' | 'replaceIfVersion',
): Promise<void> {
  const expectedTarget = await ctx.fs.resolve(relativePath) as unknown as TestTarget
  const writeText = ctx.fs.writeText.bind(ctx.fs)
  let failOnce = true
  vi.spyOn(ctx.fs, 'writeText').mockImplementation(async (...args: Parameters<Context['fs']['writeText']>) => {
    const [target, , intent] = args
    if (failOnce && (target as unknown as TestTarget).path === expectedTarget.path && (mode === undefined || intent?.kind === mode)) {
      failOnce = false
      throw new Error(message)
    }
    return await writeText(...args)
  })
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

export function testReproduction(overrides: Partial<ReproductionSpec> = {}): ReproductionSpec {
  return {
    command: 'node experiment.mjs --seed 7',
    cwd: '.',
    environment: { runtime: 'Node.js fixture; no environment variables are assigned', seed: 7 },
    inputs: [],
    ...overrides,
  }
}

/** Explicit test setup for the new mandatory plan gate; legacy fixtures must not use this helper. */
export async function ensureSelectedTestPlan(store: ResearchStore, session: Session, id: ResearchId | string) {
  const target = await store.readTarget(session, id)
  if (target.state.selectedPlanRef !== undefined) return { planId: target.state.selectedPlanRef.planId, revision: target.state.selectedPlanRef.revision }
  const plan = await store.createPlan(session, id, { title: 'Fixture execution plan', body: 'Run the fixture and verify the expected result and recovery boundaries.', delta: ['Initial fixture plan'] })
  await store.selectPlan(session, id, { planId: plan.plan.metadata.plan_id, revision: 1, expectedStateRevision: target.state.revision })
  return { planId: plan.plan.metadata.plan_id, revision: 1 }
}

export async function startPlannedTestRun(store: ResearchStore, session: Session, id: ResearchId | string, request: Omit<StartResearchRunRequest, 'plan'> & { plan?: StartResearchRunRequest['plan'] }) {
  const plan = request.plan ?? await ensureSelectedTestPlan(store, session, id)
  return await store.startRun(session, id, { ...request, plan })
}

/** A fake Git journal, not an artifact-validation bypass: first seal reads actual bytes. */
export function mockCheckpoints() {
  const sealed = new Map<string, {
    requestKey: string
    checkpoint: OutputCheckpoint
    prepared: Record<string, JsonValue>
  }>()
  const start = vi.fn<GitCheckpointProvider['start']>(async (_session, researchId, runId, _createdAt, reproduction) => ({
    backend: 'git',
    inputRef: `refs/dsh/research/${researchId}/runs/${runId}/input`,
    outputRef: `refs/dsh/research/${researchId}/runs/${runId}/output`,
    inputCommit: '1'.repeat(40),
    inputTree: '2'.repeat(40),
    baseHead: '3'.repeat(40),
    objectFormat: 'sha1',
    files: [...reproduction.inputs],
    reproduction: structuredClone(reproduction),
  }))
  const finish = vi.fn<GitCheckpointProvider['finish']>(async (session, input, requestKey, prepared, _signal, validate, beforeCapture) => {
    const existing = sealed.get(input.outputRef)
    if (existing !== undefined) {
      if (existing.requestKey !== requestKey) {
        throw new ResearcherError('output ref is already sealed for a different request', 'RESEARCH_RUN_CLOSED')
      }
      const recovered = structuredClone({ checkpoint: existing.checkpoint, prepared: existing.prepared })
      validate?.(recovered)
      return recovered
    }
    await beforeCapture?.()
    const artifactPaths = prepared.artifacts
    if (!Array.isArray(artifactPaths) || artifactPaths.some(item => typeof item !== 'string')) {
      throw new Error('fake checkpoint received invalid prepared artifact paths')
    }
    const artifacts = await Promise.all((artifactPaths as string[]).map(async relative => {
      const bytes = await readFile(path.join(session.header.cwd!, relative))
      return { path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }
    }))
    const checkpoint: OutputCheckpoint = {
      backend: 'git',
      inputCommit: input.inputCommit,
      outputCommit: '4'.repeat(40),
      inputTree: input.inputTree,
      outputTree: '5'.repeat(40),
      inputRef: input.inputRef,
      outputRef: input.outputRef,
      objectFormat: input.objectFormat,
      artifacts,
      codeChanged: true,
    }
    const entry = { requestKey, checkpoint, prepared: structuredClone(prepared) }
    validate?.({ checkpoint: entry.checkpoint, prepared: entry.prepared })
    sealed.set(input.outputRef, entry)
    return structuredClone({ checkpoint: entry.checkpoint, prepared: entry.prepared })
  })
  return { start, finish, sealed }
}

export function newCheckpointStore(ctx: Context): ResearchStore {
  return new ResearchStore(ctx, mockCheckpoints())
}
