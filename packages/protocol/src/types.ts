import { z } from 'zod';

export const AgentKindSchema = z.enum(['agy', 'pi', 'claude', 'qodercli']);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const NodeRoleSchema = z.enum(['hub', 'companion']);
export type NodeRole = z.infer<typeof NodeRoleSchema>;

export const NodeStatusSchema = z.enum(['ONLINE', 'OFFLINE', 'DEGRADED']);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

export const SessionStateSchema = z.enum([
  'RUNNING',
  'WAITING_APPROVAL',
  'IDLE',
  'HANDING_OFF',
  'HANDED_OFF',
  'EXITED',
  'ERROR'
]);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const PermissionModeSchema = z.enum([
  'default',
  'accept_edits',
  'auto',
  'plan',
  'bypass'
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const SessionSourceTypeSchema = z.enum(['web', 'wrapped', 'handoff']);
export type SessionSourceType = z.infer<typeof SessionSourceTypeSchema>;

export const HandoffStepNameSchema = z.enum([
  'FREEZE_SOURCE',
  'SYNC_WORKSPACE',
  'EXPORT_SESSION',
  'PREPARE_TARGET_REPO',
  'IMPORT_SESSION',
  'RESUME_TARGET',
  'FINALIZE'
]);
export type HandoffStepName = z.infer<typeof HandoffStepNameSchema>;

export const HandoffStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'ROLLED_BACK'
]);
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;

export const AgentProbeResultSchema = z.object({
  kind: AgentKindSchema,
  installed: z.boolean(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  sessionDir: z.string(),
  sessionDirReadable: z.boolean(),
  notes: z.string().optional()
});
export type AgentProbeResult = z.infer<typeof AgentProbeResultSchema>;

export const RepoInfoSchema = z.object({
  path: z.string(),
  name: z.string(),
  isGit: z.boolean(),
  originUrl: z.string().nullable(),
  normalizedOrigin: z.string().nullable(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  isDirty: z.boolean(),
  dirtyFilesCount: z.number().int().nonnegative()
});
export type RepoInfo = z.infer<typeof RepoInfoSchema>;

export const NodeInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: NodeRoleSchema,
  os: z.string(),
  homeDir: z.string(),
  workspaceRoots: z.array(z.string()),
  worktreesRoot: z.string(),
  status: NodeStatusSchema,
  lastSeenAt: z.string(),
  agents: z.array(AgentProbeResultSchema),
  repos: z.array(RepoInfoSchema).default([])
});
export type NodeInfo = z.infer<typeof NodeInfoSchema>;

export const SessionRecordSchema = z.object({
  id: z.string(),
  nodeId: z.string(),
  agent: AgentKindSchema,
  externalSessionId: z.string().nullable(),
  sessionFilePath: z.string().nullable(),
  title: z.string(),
  cwd: z.string(),
  gitOrigin: z.string().nullable(),
  gitBranch: z.string().nullable(),
  tmuxName: z.string(),
  pid: z.number().int().nullable(),
  permissionMode: PermissionModeSchema,
  cliArgs: z.array(z.string()),
  model: z.string().nullable(),
  state: SessionStateSchema,
  sourceType: SessionSourceTypeSchema,
  latestSummary: z.string(),
  approvalPrompt: z.string().nullable(),
  handedOffToSessionId: z.string().nullable(),
  handedOffFromSessionId: z.string().nullable(),
  worktreePath: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type SessionRecord = z.infer<typeof SessionRecordSchema>;

export const DiscoveredSessionSchema = z.object({
  agent: AgentKindSchema,
  externalSessionId: z.string(),
  title: z.string(),
  preview: z.string(),
  cwd: z.string(),
  filePath: z.string(),
  stateHint: SessionStateSchema,
  updatedAt: z.string(),
  stepCount: z.number().int().nonnegative()
});
export type DiscoveredSession = z.infer<typeof DiscoveredSessionSchema>;

export const StartSessionRequestSchema = z.object({
  nodeId: z.string().optional(),
  agent: AgentKindSchema,
  cwd: z.string().min(1),
  title: z.string().optional(),
  permissionMode: PermissionModeSchema.optional().default('default'),
  model: z.string().optional(),
  initialPrompt: z.string().optional(),
  extraArgs: z.array(z.string()).optional().default([])
});
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;

export const ResumeSessionRequestSchema = z.object({
  nodeId: z.string().optional(),
  agent: AgentKindSchema,
  externalSessionId: z.string().min(1),
  cwd: z.string().min(1),
  sessionFilePath: z.string().optional(),
  title: z.string().optional(),
  permissionMode: PermissionModeSchema.optional().default('default'),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).optional().default([]),
  continuationPrompt: z.string().optional(),
  fallbackContextFile: z.string().optional()
});
export type ResumeSessionRequest = z.infer<typeof ResumeSessionRequestSchema>;

export const RegisterWrappedSessionRequestSchema = z.object({
  id: z.string().optional(),
  nodeId: z.string().optional(),
  agent: AgentKindSchema,
  externalSessionId: z.string().nullable().optional(),
  title: z.string().optional(),
  cwd: z.string().min(1),
  tmuxName: z.string().min(1),
  pid: z.number().int().nullable().optional(),
  permissionMode: PermissionModeSchema.optional().default('default'),
  cliArgs: z.array(z.string()).optional().default([]),
  model: z.string().nullable().optional()
});
export type RegisterWrappedSessionRequest = z.infer<
  typeof RegisterWrappedSessionRequestSchema
>;

export const HandoffRequestSchema = z.object({
  sessionId: z.string().min(1),
  targetNodeId: z.string().optional(),
  forceWorktree: z.boolean().optional().default(false),
  skipGitPush: z.boolean().optional().default(false)
});
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

export const BatchHandoffRequestSchema = z.object({
  sourceNodeId: z.string().optional(),
  targetNodeId: z.string().optional(),
  sessionIds: z.array(z.string()).optional(),
  forceWorktree: z.boolean().optional().default(false)
});
export type BatchHandoffRequest = z.infer<typeof BatchHandoffRequestSchema>;

export const HandoffStepRecordSchema = z.object({
  jobId: z.string(),
  stepName: HandoffStepNameSchema,
  status: HandoffStatusSchema,
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  message: z.string(),
  stdoutTail: z.string(),
  stderrTail: z.string()
});
export type HandoffStepRecord = z.infer<typeof HandoffStepRecordSchema>;

export const HandoffJobRecordSchema = z.object({
  id: z.string(),
  batchId: z.string().nullable(),
  sourceSessionId: z.string(),
  sourceNodeId: z.string(),
  targetNodeId: z.string(),
  targetSessionId: z.string().nullable(),
  agent: AgentKindSchema,
  phase: HandoffStepNameSchema,
  status: HandoffStatusSchema,
  sourceStateAtFreeze: SessionStateSchema,
  wipBranch: z.string().nullable(),
  commitSha: z.string().nullable(),
  sourceCwd: z.string(),
  targetCwd: z.string().nullable(),
  worktreeCreated: z.boolean(),
  fallbackUsed: z.boolean(),
  errorCode: z.string().nullable(),
  errorMessage: z.string().nullable(),
  steps: z.array(HandoffStepRecordSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type HandoffJobRecord = z.infer<typeof HandoffJobRecordSchema>;

export const ProgressEventItemSchema = z.object({
  timestamp: z.string(),
  kind: z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'system', 'approval']),
  title: z.string(),
  detail: z.string()
});
export type ProgressEventItem = z.infer<typeof ProgressEventItemSchema>;

export const ProgressSnapshotSchema = z.object({
  sessionId: z.string(),
  state: SessionStateSchema,
  summary: z.string(),
  approvalPrompt: z.string().nullable(),
  stepCount: z.number().int().nonnegative(),
  events: z.array(ProgressEventItemSchema),
  ptyTail: z.string(),
  observedAt: z.string()
});
export type ProgressSnapshot = z.infer<typeof ProgressSnapshotSchema>;

export const RepoMappingEntrySchema = z.object({
  sourceCwd: z.string(),
  targetCwd: z.string()
});
export type RepoMappingEntry = z.infer<typeof RepoMappingEntrySchema>;

export const PathMappingRuleSchema = z.object({
  sourceHome: z.string(),
  targetHome: z.string(),
  sourceCwd: z.string(),
  targetCwd: z.string(),
  sourceWorkspaceRoots: z.array(z.string()).default([]),
  targetWorkspaceRoots: z.array(z.string()).default([]),
  repoMappings: z.array(RepoMappingEntrySchema).default([])
});
export type PathMappingRule = z.infer<typeof PathMappingRuleSchema>;

export const SessionBundleManifestSchema = z.object({
  version: z.literal(1),
  agent: AgentKindSchema,
  externalSessionId: z.string(),
  sourceHome: z.string(),
  sourceCwd: z.string(),
  title: z.string(),
  createdAt: z.string(),
  files: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type SessionBundleManifest = z.infer<typeof SessionBundleManifestSchema>;

export interface FreezeResult {
  sessionId: string;
  previousState: SessionState;
  externalSessionId: string | null;
  sessionFilePath: string | null;
  cwd: string;
  title: string;
  permissionMode: PermissionMode;
  cliArgs: string[];
  model: string | null;
  agent: AgentKind;
  stdoutTail: string;
}

export interface GitWipResult {
  isGit: boolean;
  originUrl: string | null;
  normalizedOrigin: string | null;
  origBranch: string | null;
  wipBranch: string | null;
  commitSha: string | null;
  pushed: boolean;
  message: string;
  logs: string[];
}

export interface ExportBundleResponse {
  manifest: SessionBundleManifest;
  archiveBase64: string;
}

export interface ImportBundleRequest {
  manifest: SessionBundleManifest;
  archiveBase64: string;
  pathMapping: PathMappingRule;
}

export interface ImportBundleResult {
  externalSessionId: string;
  targetSessionFilePath: string | null;
  fallbackContextFile: string | null;
  warnings: string[];
}

export interface TargetWorkspacePrepResult {
  targetCwd: string;
  isGit: boolean;
  worktreeCreated: boolean;
  checkedOutBranch: string | null;
  commitSha: string | null;
  logs: string[];
}

export const AgentEntryConfigSchema = z.object({
  binary: z.string().default(''),
  preserveShellHooks: z.boolean().default(false),
  defaultArgs: z.array(z.string()).default([])
});
export type AgentEntryConfig = z.infer<typeof AgentEntryConfigSchema>;

export const HandoffPolicyConfigSchema = z.object({
  wipBranchPrefix: z.string().default('wip/handoff'),
  continuationPromptTemplate: z
    .string()
    .default(
      '[Agent Hub 移交续跑] 本会话已从 {{sourceNode}} 移交至 {{targetNode}}，代码分支已同步为 {{wipBranch}}（工作目录：{{targetCwd}}）。请先快速确认当前代码改动与上下文进度，然后继续完成未完成的任务。'
    ),
  enableAgyFallback: z.boolean().default(true)
});
export type HandoffPolicyConfig = z.infer<typeof HandoffPolicyConfigSchema>;

export const AppConfigSchema = z.object({
  role: NodeRoleSchema.default('hub'),
  nodeId: z.string().default('mini'),
  nodeName: z.string().default('Mac mini'),
  host: z.string().default('127.0.0.1'),
  port: z.number().int().min(0).max(65535).default(4780),
  authToken: z.string().default(''),
  homeDir: z.string().default(''),
  workspaceRoots: z.array(z.string()).default([]),
  worktreesRoot: z.string().default(''),
  dataDir: z.string().default(''),
  tmuxSocket: z.string().optional(),
  companionUrl: z.string().default('http://127.0.0.1:4781'),
  companionNodeId: z.string().default('mac'),
  companionNodeName: z.string().default('MacBook Pro'),
  sshHost: z.string().default('mini'),
  hubUrl: z.string().default('http://127.0.0.1:4780'),
  repoMappings: z.array(RepoMappingEntrySchema).default([]),
  agents: z
    .object({
      agy: AgentEntryConfigSchema.default({ binary: '', preserveShellHooks: false, defaultArgs: [] }),
      pi: AgentEntryConfigSchema.default({ binary: '', preserveShellHooks: false, defaultArgs: [] }),
      claude: AgentEntryConfigSchema.default({ binary: '', preserveShellHooks: true, defaultArgs: [] }),
      qodercli: AgentEntryConfigSchema.default({ binary: '', preserveShellHooks: true, defaultArgs: [] })
    })
    .default({
      agy: { binary: '', preserveShellHooks: false, defaultArgs: [] },
      pi: { binary: '', preserveShellHooks: false, defaultArgs: [] },
      claude: { binary: '', preserveShellHooks: true, defaultArgs: [] },
      qodercli: { binary: '', preserveShellHooks: true, defaultArgs: [] }
    }),
  handoff: HandoffPolicyConfigSchema.default({
    wipBranchPrefix: 'wip/handoff',
    continuationPromptTemplate:
      '[Agent Hub 移交续跑] 本会话已从 {{sourceNode}} 移交至 {{targetNode}}，代码分支已同步为 {{wipBranch}}（工作目录：{{targetCwd}}）。请先快速确认当前代码改动与上下文进度，然后继续完成未完成的任务。',
    enableAgyFallback: true
  })
});
export type AppConfig = z.infer<typeof AppConfigSchema>;
