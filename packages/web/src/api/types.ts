export type AgentKind = 'agy' | 'pi' | 'claude' | 'qodercli';
export type NodeRole = 'hub' | 'companion';
export type NodeStatus = 'ONLINE' | 'OFFLINE' | 'DEGRADED';
export type SessionState =
  | 'RUNNING'
  | 'WAITING_APPROVAL'
  | 'IDLE'
  | 'HANDING_OFF'
  | 'HANDED_OFF'
  | 'EXITED'
  | 'ERROR';
export type PermissionMode =
  | 'default'
  | 'accept_edits'
  | 'auto'
  | 'plan'
  | 'bypass';
export type SessionSourceType = 'web' | 'wrapped' | 'handoff';
export type HandoffStepName =
  | 'FREEZE_SOURCE'
  | 'SYNC_WORKSPACE'
  | 'EXPORT_SESSION'
  | 'PREPARE_TARGET_REPO'
  | 'IMPORT_SESSION'
  | 'RESUME_TARGET'
  | 'FINALIZE';
export type HandoffStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'ROLLED_BACK';

export interface AgentProbeResult {
  kind: AgentKind;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  sessionDir: string;
  sessionDirReadable: boolean;
  notes?: string;
}

export interface RepoInfo {
  path: string;
  name: string;
  isGit: boolean;
  originUrl: string | null;
  normalizedOrigin: string | null;
  branch: string | null;
  headSha: string | null;
  isDirty: boolean;
  dirtyFilesCount: number;
}

export interface NodeInfo {
  id: string;
  name: string;
  role: NodeRole;
  os: string;
  homeDir: string;
  workspaceRoots: string[];
  worktreesRoot: string;
  status: NodeStatus;
  lastSeenAt: string;
  agents: AgentProbeResult[];
  repos: RepoInfo[];
}

export interface SessionRecord {
  id: string;
  nodeId: string;
  agent: AgentKind;
  externalSessionId: string | null;
  sessionFilePath: string | null;
  title: string;
  cwd: string;
  gitOrigin: string | null;
  gitBranch: string | null;
  tmuxName: string;
  pid: number | null;
  permissionMode: PermissionMode;
  cliArgs: string[];
  model: string | null;
  state: SessionState;
  sourceType: SessionSourceType;
  latestSummary: string;
  approvalPrompt: string | null;
  handedOffToSessionId: string | null;
  handedOffFromSessionId: string | null;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveredSession {
  agent: AgentKind;
  externalSessionId: string;
  title: string;
  preview: string;
  cwd: string;
  filePath: string;
  stateHint: SessionState;
  updatedAt: string;
  stepCount: number;
}

export interface HandoffStepRecord {
  jobId: string;
  stepName: HandoffStepName;
  status: HandoffStatus;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
  stdoutTail: string;
  stderrTail: string;
}

export interface HandoffJobRecord {
  id: string;
  batchId: string | null;
  sourceSessionId: string;
  sourceNodeId: string;
  targetNodeId: string;
  targetSessionId: string | null;
  agent: AgentKind;
  phase: HandoffStepName;
  status: HandoffStatus;
  sourceStateAtFreeze: SessionState;
  wipBranch: string | null;
  commitSha: string | null;
  sourceCwd: string;
  targetCwd: string | null;
  worktreeCreated: boolean;
  fallbackUsed: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  steps: HandoffStepRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface ProgressEventItem {
  timestamp: string;
  kind: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'system' | 'approval';
  title: string;
  detail: string;
}

export interface ProgressSnapshot {
  sessionId: string;
  state: SessionState;
  summary: string;
  approvalPrompt: string | null;
  stepCount: number;
  events: ProgressEventItem[];
  ptyTail: string;
  observedAt: string;
}

export interface StartSessionPayload {
  nodeId: string;
  agent: AgentKind;
  cwd: string;
  title?: string;
  permissionMode: PermissionMode;
  model?: string;
  initialPrompt?: string;
  extraArgs?: string[];
}

export interface ResumeSessionPayload {
  nodeId: string;
  agent: AgentKind;
  externalSessionId: string;
  cwd: string;
  sessionFilePath?: string;
  title?: string;
  permissionMode: PermissionMode;
  model?: string;
  extraArgs?: string[];
  continuationPrompt?: string;
}

export type HubEventMessage =
  | {
      type: 'snapshot';
      nodes: NodeInfo[];
      sessions: SessionRecord[];
      handoffs: HandoffJobRecord[];
    }
  | { type: 'node_update'; node: NodeInfo }
  | { type: 'session_update'; session: SessionRecord }
  | { type: 'handoff_update'; job: HandoffJobRecord }
  | { type: 'approval_alert'; session: SessionRecord; prompt: string };
