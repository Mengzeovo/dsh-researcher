import { HarnessError } from '@deepseek-ai/dsh-llm'

export type ResearcherErrorCode =
  | 'RESEARCH_AUTHORITY_REQUIRED'
  | 'RESEARCH_DRIVER_REQUIRED'
  | 'RESEARCH_GOAL_CONFLICT'
  | 'RESEARCH_INVALID_RECORD'
  | 'RESEARCH_NOT_FOUND'
  | 'RESEARCH_OVERSIZED'
  | 'RESEARCH_PATH_INVALID'
  | 'RESEARCH_RUN_CLOSED'
  | 'RESEARCH_RUN_OPEN'
  | 'RESEARCH_SESSION_BOUND'
  | 'RESEARCH_SESSION_ID_TOO_LONG'
  | 'RESEARCH_SESSION_NOT_LIVE'
  | 'RESEARCH_STALE_WRITE'
  | 'RESEARCH_TARGET_COMPLETE'

export class ResearcherError extends HarnessError {
  declare readonly code: ResearcherErrorCode

  constructor(message: string, code: ResearcherErrorCode, options?: ErrorOptions) {
    super(message, code, options)
    this.code = code
  }
}

export function invalidRecord(message: string, options?: ErrorOptions): never {
  throw new ResearcherError(message, 'RESEARCH_INVALID_RECORD', options)
}
