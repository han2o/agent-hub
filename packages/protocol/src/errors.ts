export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'NODE_OFFLINE'
  | 'AGENT_NOT_FOUND'
  | 'SESSION_NOT_FOUND'
  | 'LEASE_LOCKED'
  | 'GIT_SYNC_FAILED'
  | 'BUNDLE_EXPORT_FAILED'
  | 'BUNDLE_IMPORT_FAILED'
  | 'RESUME_FAILED'
  | 'TMUX_ERROR'
  | 'INTERNAL_ERROR';

export class AgentHubError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode = 500,
    details?: unknown
  ) {
    super(message);
    this.name = 'AgentHubError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON(): { code: ErrorCode; message: string; details?: unknown } {
    return {
      code: this.code,
      message: this.message,
      ...(this.details !== undefined ? { details: this.details } : {})
    };
  }
}

export function isAgentHubError(err: unknown): err is AgentHubError {
  return err instanceof AgentHubError;
}
