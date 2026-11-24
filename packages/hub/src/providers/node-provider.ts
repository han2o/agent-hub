import type { WebSocket } from 'ws';
import type {
  AgentKind,
  DiscoveredSession,
  ExportBundleResponse,
  FreezeResult,
  GitWipResult,
  ImportBundleRequest,
  ImportBundleResult,
  NodeInfo,
  NodeRole,
  ProgressSnapshot,
  RepoInfo,
  RepoMappingEntry,
  ResumeSessionRequest,
  SessionRecord,
  StartSessionRequest,
  TargetWorkspacePrepResult
} from '@agent-hub/protocol';

export interface TargetWorkspacePrepInput {
  sessionId: string;
  isGit: boolean;
  originUrl: string | null;
  normalizedOrigin: string | null;
  wipBranch: string | null;
  commitSha: string | null;
  sourceCwd: string;
  sourceHome: string;
  sourceWorkspaceRoots: string[];
  repoMappings: RepoMappingEntry[];
  occupiedCwds: string[];
  subPath?: string;
  forceWorktree?: boolean;
}

export interface NodeProvider {
  readonly nodeId: string;
  readonly role: NodeRole;

  probe(): Promise<NodeInfo>;
  listWorkspaces(): Promise<RepoInfo[]>;
  listSessions(): Promise<SessionRecord[]>;
  discoverSessions(agent?: AgentKind, limit?: number): Promise<DiscoveredSession[]>;
  getProgress(sessionId: string): Promise<ProgressSnapshot>;
  startSession(req: StartSessionRequest): Promise<SessionRecord>;
  resumeSession(
    req: ResumeSessionRequest,
    opts?: { sourceType?: SessionRecord['sourceType']; handedOffFromSessionId?: string | null; worktreePath?: string | null; useFallback?: boolean }
  ): Promise<SessionRecord>;
  stopSession(sessionId: string, purge?: boolean): Promise<void>;
  attachPty(sessionId: string, clientSocket: WebSocket, cols: number, rows: number): void;

  // Source-side handoff operations
  freezeSession(sessionId: string): Promise<FreezeResult>;
  createGitWip(sessionId: string, skipGitPush?: boolean): Promise<GitWipResult & { subPath: string }>;
  exportBundle(sessionId: string): Promise<ExportBundleResponse>;
  markHandedOff(sessionId: string, targetSessionId: string): Promise<SessionRecord>;
  rollbackHandoff(sessionId: string): Promise<SessionRecord>;

  // Target-side handoff operations
  prepareTargetWorkspace(input: TargetWorkspacePrepInput): Promise<TargetWorkspacePrepResult>;
  importBundle(req: ImportBundleRequest): Promise<ImportBundleResult>;
  hasLiveSession(tmuxName: string): Promise<boolean>;
  sendContinuationText(tmuxName: string, text: string): Promise<void>;
}
