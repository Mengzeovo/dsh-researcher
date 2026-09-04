import { lstat, mkdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { ResearcherError } from './errors.ts'

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

async function requireWorkspace(ctx: Context, session: Session): Promise<{
  readonly root: string
  readonly policy: SandboxExecutionPolicy
}> {
  const policy = ctx.sandboxPolicy.resolve({ session })
  if (policy.mode === 'read-only') {
    throw new ResearcherError('researcher cannot modify project records while the session is read-only', 'RESEARCH_PATH_INVALID')
  }
  const cwd = session.header.cwd
  if (cwd === undefined) {
    throw new ResearcherError('researcher requires a session workspace cwd', 'RESEARCH_PATH_INVALID')
  }
  const root = await realpath(cwd)
  const policyRoot = await realpath(policy.workspaceRoot)
  if (!isInside(policyRoot, root)) {
    throw new ResearcherError('session cwd and sandbox workspace root do not identify the same workspace boundary', 'RESEARCH_PATH_INVALID')
  }
  return { root, policy }
}

async function ensureOneDirectory(root: string, relative: string): Promise<void> {
  const target = path.join(root, relative)
  if (!isInside(root, target)) throw new ResearcherError(`directory escapes workspace: ${relative}`, 'RESEARCH_PATH_INVALID')
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new ResearcherError(`research directory component is not a real directory: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await mkdir(target)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const created = await lstat(target)
  if (created.isSymbolicLink() || !created.isDirectory()) {
    throw new ResearcherError(`research directory component is not a real directory: ${relative}`, 'RESEARCH_PATH_INVALID')
  }
}

export async function ensureResearchDirectories(
  ctx: Context,
  session: Session,
  relatives: readonly string[],
): Promise<SandboxExecutionPolicy> {
  const { root, policy } = await requireWorkspace(ctx, session)
  for (const relative of relatives) {
    const normalized = path.posix.normalize(relative.replace(/\\/gu, '/'))
    if (normalized !== relative || path.posix.isAbsolute(relative) || normalized.startsWith('../')) {
      throw new ResearcherError(`unsafe fixed research directory: ${relative}`, 'RESEARCH_PATH_INVALID')
    }
    await ensureOneDirectory(root, normalized)
  }
  return policy
}

export async function commitResearchDirectory(
  ctx: Context,
  session: Session,
  stagingRelative: string,
  finalRelative: string,
): Promise<void> {
  const { root } = await requireWorkspace(ctx, session)
  const staging = path.join(root, stagingRelative)
  const final = path.join(root, finalRelative)
  if (!isInside(root, staging) || !isInside(root, final)) {
    throw new ResearcherError('research target commit escapes the project root', 'RESEARCH_PATH_INVALID')
  }
  const stagingInfo = await lstat(staging)
  if (stagingInfo.isSymbolicLink() || !stagingInfo.isDirectory()) {
    throw new ResearcherError('research staging target is not a real directory', 'RESEARCH_PATH_INVALID')
  }
  try {
    await lstat(final)
    throw new ResearcherError('research id collision: final target already exists', 'RESEARCH_STALE_WRITE')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(staging, final)
  } catch (error) {
    throw new ResearcherError('failed to atomically commit the research target directory', 'RESEARCH_STALE_WRITE', { cause: error })
  }
}

export async function discardResearchStaging(
  ctx: Context,
  session: Session,
  stagingRelative: string,
): Promise<void> {
  const { root } = await requireWorkspace(ctx, session)
  const staging = path.join(root, stagingRelative)
  if (!isInside(root, staging) || !path.basename(staging).startsWith('.creating-')) return
  await rm(staging, { recursive: true, force: true })
}
