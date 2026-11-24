import crypto from 'node:crypto';
import {
  AgentHubError,
  isAgentHubError,
  type AppConfig,
  type BatchHandoffRequest,
  type ExportBundleResponse,
  type FreezeResult,
  type GitWipResult,
  type HandoffJobRecord,
  type HandoffRequest,
  type HandoffStepName,
  type HandoffStepRecord,
  type HubEventMessage,
  type ImportBundleResult,
  type PathMappingRule,
  type SessionRecord,
  type TargetWorkspacePrepResult
} from '@agent-hub/protocol';
import type { HubDatabase } from './db.js';
import type { NodeProvider } from './providers/node-provider.js';

const STEP_ORDER: HandoffStepName[] = [
  'FREEZE_SOURCE',
  'SYNC_WORKSPACE',
  'EXPORT_SESSION',
  'PREPARE_TARGET_REPO',
  'IMPORT_SESSION',
  'RESUME_TARGET',
  'FINALIZE'
];

export interface SagaOptions {
  startupVerifyDelayMs?: number;
}

export class HandoffSagaOrchestrator {
  private readonly db: HubDatabase;
  private readonly config: AppConfig;
  private readonly getProvider: (nodeId: string) => NodeProvider;
  private readonly emitEvent: (evt: HubEventMessage) => void;
  private readonly inFlightPromises = new Map<string, Promise<HandoffJobRecord>>();
  private readonly startupVerifyDelayMs: number;

  constructor(opts: {
    db: HubDatabase;
    config: AppConfig;
    getProvider: (nodeId: string) => NodeProvider;
    emitEvent: (evt: HubEventMessage) => void;
    sagaOptions?: SagaOptions;
  }) {
    this.db = opts.db;
    this.config = opts.config;
    this.getProvider = opts.getProvider;
    this.emitEvent = opts.emitEvent;
    this.startupVerifyDelayMs = opts.sagaOptions?.startupVerifyDelayMs ?? 1200;
  }

  private createInitialSteps(jobId: string): HandoffStepRecord[] {
    return STEP_ORDER.map((stepName) => ({
      jobId,
      stepName,
      status: 'PENDING',
      startedAt: null,
      finishedAt: null,
      message: '',
      stdoutTail: '',
      stderrTail: ''
    }));
  }

  private renderContinuationPrompt(vars: {
    sourceNode: string;
    targetNode: string;
    wipBranch: string;
    targetCwd: string;
  }): string {
    return this.config.handoff.continuationPromptTemplate
      .replace(/\{\{sourceNode\}\}/g, vars.sourceNode)
      .replace(/\{\{targetNode\}\}/g, vars.targetNode)
      .replace(/\{\{wipBranch\}\}/g, vars.wipBranch)
      .replace(/\{\{targetCwd\}\}/g, vars.targetCwd)
      .trim();
  }

  async startHandoff(
    req: HandoffRequest,
    batchId: string | null = null
  ): Promise<HandoffJobRecord> {
    const sourceSession = this.db.getSession(req.sessionId);
    if (!sourceSession) {
      throw new AgentHubError(
        'SESSION_NOT_FOUND',
        `Session not found: ${req.sessionId}`,
        404
      );
    }

    const targetNodeId = req.targetNodeId || this.config.nodeId;
    if (sourceSession.nodeId === targetNodeId) {
      throw new AgentHubError(
        'INVALID_REQUEST',
        `Session ${req.sessionId} is already on target node ${targetNodeId}`,
        400
      );
    }
    if (sourceSession.state === 'HANDED_OFF') {
      throw new AgentHubError(
        'CONFLICT',
        `Session ${req.sessionId} has already been handed off`,
        409
      );
    }

    const jobId = crypto.randomUUID();
    const locked = this.db.acquireLease(sourceSession.id, targetNodeId, jobId);
    if (!locked) {
      throw new AgentHubError(
        'LEASE_LOCKED',
        `Session ${sourceSession.id} already has an active handoff in progress`,
        409
      );
    }

    const now = new Date().toISOString();
    const job: HandoffJobRecord = {
      id: jobId,
      batchId,
      sourceSessionId: sourceSession.id,
      sourceNodeId: sourceSession.nodeId,
      targetNodeId,
      targetSessionId: null,
      agent: sourceSession.agent,
      phase: 'FREEZE_SOURCE',
      status: 'RUNNING',
      sourceStateAtFreeze: sourceSession.state,
      wipBranch: null,
      commitSha: null,
      sourceCwd: sourceSession.cwd,
      targetCwd: null,
      worktreeCreated: false,
      fallbackUsed: false,
      errorCode: null,
      errorMessage: null,
      steps: this.createInitialSteps(jobId),
      createdAt: now,
      updatedAt: now
    };

    const meta = {
      forceWorktree: Boolean(req.forceWorktree),
      skipGitPush: Boolean(req.skipGitPush)
    };
    this.db.upsertHandoffJob(job, meta);
    this.db.appendAuditEvent('HANDOFF_STARTED', { req }, { sessionId: sourceSession.id, jobId });
    this.emitEvent({ type: 'handoff_update', job });

    const runPromise = this.executeJob(jobId).finally(() => {
      this.inFlightPromises.delete(jobId);
    });
    this.inFlightPromises.set(jobId, runPromise);

    return job;
  }

  async waitForJob(jobId: string): Promise<HandoffJobRecord> {
    const running = this.inFlightPromises.get(jobId);
    if (running) return running;
    const job = this.db.getHandoffJob(jobId);
    if (!job) {
      throw new AgentHubError('NOT_FOUND', `Handoff job not found: ${jobId}`, 404);
    }
    return job;
  }

  async startBatchHandoff(
    req: BatchHandoffRequest
  ): Promise<{ batchId: string; jobs: HandoffJobRecord[] }> {
    const sourceNodeId = req.sourceNodeId || this.config.companionNodeId;
    const targetNodeId = req.targetNodeId || this.config.nodeId;

    const candidates = this.db
      .listSessions({ nodeId: sourceNodeId })
      .filter((s) => {
        if (req.sessionIds && req.sessionIds.length > 0) {
          return req.sessionIds.includes(s.id);
        }
        return (
          s.state === 'RUNNING' ||
          s.state === 'WAITING_APPROVAL' ||
          s.state === 'IDLE'
        );
      });

    const batchId = crypto.randomUUID();
    const jobs: HandoffJobRecord[] = [];
    for (const s of candidates) {
      try {
        const job = await this.startHandoff(
          {
            sessionId: s.id,
            targetNodeId,
            forceWorktree: req.forceWorktree ?? false,
            skipGitPush: false
          },
          batchId
        );
        jobs.push(job);
      } catch {
        // Skip locked/ineligible sessions individually
      }
    }
    return { batchId, jobs };
  }

  async retryHandoff(jobId: string): Promise<HandoffJobRecord> {
    const existing = this.db.getHandoffJob(jobId);
    if (!existing) {
      throw new AgentHubError('NOT_FOUND', `Handoff job not found: ${jobId}`, 404);
    }
    if (existing.status === 'RUNNING') {
      throw new AgentHubError('CONFLICT', `Job ${jobId} is already running`, 409);
    }
    if (existing.status === 'SUCCEEDED') {
      return existing;
    }

    const locked = this.db.acquireLease(
      existing.sourceSessionId,
      existing.targetNodeId,
      jobId
    );
    if (!locked) {
      throw new AgentHubError(
        'LEASE_LOCKED',
        `Session ${existing.sourceSessionId} is locked by another handoff`,
        409
      );
    }

    const resetSteps = existing.steps.map((s) =>
      s.status === 'FAILED' || s.status === 'RUNNING'
        ? {
            ...s,
            status: 'PENDING' as const,
            finishedAt: null,
            stderrTail: ''
          }
        : s
    );

    const updated: HandoffJobRecord = {
      ...existing,
      status: 'RUNNING',
      errorCode: null,
      errorMessage: null,
      steps: resetSteps,
      updatedAt: new Date().toISOString()
    };
    this.db.upsertHandoffJob(updated);
    this.emitEvent({ type: 'handoff_update', job: updated });

    const runPromise = this.executeJob(jobId).finally(() => {
      this.inFlightPromises.delete(jobId);
    });
    this.inFlightPromises.set(jobId, runPromise);
    return updated;
  }

  private async runStep<T>(
    jobId: string,
    stepName: HandoffStepName,
    fn: () => Promise<{ result: T; message: string; stdoutTail?: string }>
  ): Promise<T> {
    const current = this.db.getHandoffJob(jobId)!;
    const existingStep = current.steps.find((s) => s.stepName === stepName);
    if (existingStep?.status === 'SUCCEEDED') {
      // Idempotent skip on retry!
      const meta = this.db.getHandoffMetadata(jobId);
      const cached = meta[`stepResult_${stepName}`] as T | undefined;
      if (cached !== undefined) return cached;
    }

    const startedAt = new Date().toISOString();
    const runningStep: HandoffStepRecord = {
      jobId,
      stepName,
      status: 'RUNNING',
      startedAt,
      finishedAt: null,
      message: `Executing ${stepName}...`,
      stdoutTail: '',
      stderrTail: ''
    };
    this.db.upsertHandoffStep(runningStep);
    const jobBefore = this.db.getHandoffJob(jobId)!;
    jobBefore.phase = stepName;
    jobBefore.updatedAt = startedAt;
    this.db.upsertHandoffJob(jobBefore);
    this.emitEvent({ type: 'handoff_update', job: jobBefore });

    try {
      const { result, message, stdoutTail } = await fn();
      const finishedAt = new Date().toISOString();
      this.db.upsertHandoffStep({
        jobId,
        stepName,
        status: 'SUCCEEDED',
        startedAt,
        finishedAt,
        message,
        stdoutTail: stdoutTail ?? '',
        stderrTail: ''
      });

      const meta = this.db.getHandoffMetadata(jobId);
      meta[`stepResult_${stepName}`] = result;
      this.db.updateHandoffMetadata(jobId, meta);

      const jobAfter = this.db.getHandoffJob(jobId)!;
      jobAfter.updatedAt = finishedAt;
      this.db.upsertHandoffJob(jobAfter);
      this.emitEvent({ type: 'handoff_update', job: jobAfter });
      return result;
    } catch (err) {
      const finishedAt = new Date().toISOString();
      const msg = err instanceof Error ? err.message : String(err);
      this.db.upsertHandoffStep({
        jobId,
        stepName,
        status: 'FAILED',
        startedAt,
        finishedAt,
        message: msg,
        stdoutTail: '',
        stderrTail: msg
      });
      throw err;
    }
  }

  private async executeJob(jobId: string): Promise<HandoffJobRecord> {
    const job = this.db.getHandoffJob(jobId)!;
    const meta = this.db.getHandoffMetadata(jobId);
    const forceWorktree = Boolean(meta.forceWorktree);
    const skipGitPush = Boolean(meta.skipGitPush);

    const sourceProvider = this.getProvider(job.sourceNodeId);
    const targetProvider = this.getProvider(job.targetNodeId);

    try {
      // 1. FREEZE_SOURCE
      const freeze = await this.runStep<FreezeResult>(
        jobId,
        'FREEZE_SOURCE',
        async () => {
          const res = await sourceProvider.freezeSession(job.sourceSessionId);
          return {
            result: res,
            message: `Frozen Mac session (${res.previousState}), externalId=${res.externalSessionId ?? 'none'}`,
            stdoutTail: res.stdoutTail
          };
        }
      );

      const j1 = this.db.getHandoffJob(jobId)!;
      j1.sourceStateAtFreeze = freeze.previousState;
      this.db.upsertHandoffJob(j1);

      // 2. SYNC_WORKSPACE
      const gitWip = await this.runStep<GitWipResult & { subPath: string }>(
        jobId,
        'SYNC_WORKSPACE',
        async () => {
          const res = await sourceProvider.createGitWip(
            job.sourceSessionId,
            skipGitPush
          );
          return {
            result: res,
            message: res.message,
            stdoutTail: res.logs.join('\n')
          };
        }
      );

      const j2 = this.db.getHandoffJob(jobId)!;
      j2.wipBranch = gitWip.wipBranch;
      j2.commitSha = gitWip.commitSha;
      this.db.upsertHandoffJob(j2);

      // 3. EXPORT_SESSION
      const bundle = await this.runStep<ExportBundleResponse>(
        jobId,
        'EXPORT_SESSION',
        async () => {
          const res = await sourceProvider.exportBundle(job.sourceSessionId);
          return {
            result: res,
            message: `Exported ${res.manifest.agent} bundle (${res.manifest.files.length} items)`
          };
        }
      );

      // 4. PREPARE_TARGET_REPO
      const sourceNode =
        this.db.getNode(job.sourceNodeId) ?? (await sourceProvider.probe());
      const targetNode =
        this.db.getNode(job.targetNodeId) ?? (await targetProvider.probe());

      const targetPrep = await this.runStep<TargetWorkspacePrepResult>(
        jobId,
        'PREPARE_TARGET_REPO',
        async () => {
          const occupiedCwds = this.db
            .listSessions({ nodeId: job.targetNodeId })
            .filter(
              (s) =>
                s.state === 'RUNNING' ||
                s.state === 'WAITING_APPROVAL' ||
                s.state === 'IDLE'
            )
            .map((s) => s.cwd);

          const prep = await targetProvider.prepareTargetWorkspace({
            sessionId: job.sourceSessionId,
            isGit: gitWip.isGit,
            originUrl: gitWip.originUrl,
            normalizedOrigin: gitWip.normalizedOrigin,
            wipBranch: gitWip.wipBranch,
            commitSha: gitWip.commitSha,
            sourceCwd: freeze.cwd,
            sourceHome: sourceNode.homeDir,
            sourceWorkspaceRoots: sourceNode.workspaceRoots,
            repoMappings: this.config.repoMappings,
            occupiedCwds,
            subPath: gitWip.subPath,
            forceWorktree
          });
          return {
            result: prep,
            message: prep.worktreeCreated
              ? `Created isolated git worktree at ${prep.targetCwd}`
              : `Prepared workspace at ${prep.targetCwd}`,
            stdoutTail: prep.logs.join('\n')
          };
        }
      );

      const j4 = this.db.getHandoffJob(jobId)!;
      j4.targetCwd = targetPrep.targetCwd;
      j4.worktreeCreated = targetPrep.worktreeCreated;
      this.db.upsertHandoffJob(j4);

      // 5. IMPORT_SESSION
      const importResult = await this.runStep<ImportBundleResult>(
        jobId,
        'IMPORT_SESSION',
        async () => {
          const pathMapping: PathMappingRule = {
            sourceHome: sourceNode.homeDir,
            targetHome: targetNode.homeDir,
            sourceCwd: freeze.cwd,
            targetCwd: targetPrep.targetCwd,
            sourceWorkspaceRoots: sourceNode.workspaceRoots,
            targetWorkspaceRoots: targetNode.workspaceRoots,
            repoMappings: this.config.repoMappings
          };
          const res = await targetProvider.importBundle({
            manifest: bundle.manifest,
            archiveBase64: bundle.archiveBase64,
            pathMapping
          });
          return {
            result: res,
            message: `Imported session ${res.externalSessionId} -> ${res.targetSessionFilePath ?? 'fallback-only'}`
          };
        }
      );

      // 6. RESUME_TARGET
      const resumeOutcome = await this.runStep<{
        targetSession: SessionRecord;
        fallbackUsed: boolean;
      }>(jobId, 'RESUME_TARGET', async () => {
        const wasActive =
          freeze.previousState === 'RUNNING' ||
          freeze.previousState === 'WAITING_APPROVAL';
        const continuationPrompt = wasActive
          ? this.renderContinuationPrompt({
              sourceNode: sourceNode.name,
              targetNode: targetNode.name,
              wipBranch: targetPrep.checkedOutBranch || gitWip.wipBranch || 'local',
              targetCwd: targetPrep.targetCwd
            })
          : undefined;

        const resumeReq = {
          nodeId: job.targetNodeId,
          agent: freeze.agent,
          externalSessionId: importResult.externalSessionId,
          cwd: targetPrep.targetCwd,
          sessionFilePath: importResult.targetSessionFilePath ?? undefined,
          title: freeze.title,
          permissionMode: freeze.permissionMode,
          model: freeze.model ?? undefined,
          extraArgs: freeze.cliArgs,
          continuationPrompt,
          fallbackContextFile: importResult.fallbackContextFile ?? undefined
        };

        let targetSession = await targetProvider.resumeSession(resumeReq, {
          sourceType: 'handoff',
          handedOffFromSessionId: job.sourceSessionId,
          worktreePath: targetPrep.worktreeCreated ? targetPrep.targetCwd : null,
          useFallback: false
        });
        let fallbackUsed = false;

        // Startup verify & agy graceful fallback
        if (
          freeze.agent === 'agy' &&
          this.config.handoff.enableAgyFallback &&
          importResult.fallbackContextFile &&
          this.startupVerifyDelayMs > 0
        ) {
          await new Promise((r) => setTimeout(r, this.startupVerifyDelayMs));
          const alive = await targetProvider.hasLiveSession(targetSession.tmuxName);
          if (!alive) {
            await targetProvider.stopSession(targetSession.id, true).catch(() => {});
            targetSession = await targetProvider.resumeSession(resumeReq, {
              sourceType: 'handoff',
              handedOffFromSessionId: job.sourceSessionId,
              worktreePath: targetPrep.worktreeCreated ? targetPrep.targetCwd : null,
              useFallback: true
            });
            fallbackUsed = true;
          }
        }

        if (continuationPrompt && !fallbackUsed) {
          await new Promise((r) =>
            setTimeout(r, Math.min(800, this.startupVerifyDelayMs))
          );
          if (await targetProvider.hasLiveSession(targetSession.tmuxName)) {
            await targetProvider
              .sendContinuationText(targetSession.tmuxName, continuationPrompt)
              .catch(() => {});
          }
        }

        return {
          result: { targetSession, fallbackUsed },
          message: fallbackUsed
            ? `Resumed via agy fallback context (${targetSession.id})`
            : `Resumed ${freeze.agent} on ${targetNode.name} (${targetSession.id})`
        };
      });

      // 7. FINALIZE
      await this.runStep(jobId, 'FINALIZE', async () => {
        const updatedSource = await sourceProvider
          .markHandedOff(job.sourceSessionId, resumeOutcome.targetSession.id)
          .catch(() => null);
        if (updatedSource) {
          this.db.upsertSession(updatedSource);
          this.emitEvent({ type: 'session_update', session: updatedSource });
        }
        this.db.upsertSession(resumeOutcome.targetSession);
        this.emitEvent({
          type: 'session_update',
          session: resumeOutcome.targetSession
        });
        return {
          result: { ok: true },
          message: `Handoff complete -> target session ${resumeOutcome.targetSession.id}`
        };
      });

      const doneJob = this.db.getHandoffJob(jobId)!;
      doneJob.status = 'SUCCEEDED';
      doneJob.targetSessionId = resumeOutcome.targetSession.id;
      doneJob.fallbackUsed = resumeOutcome.fallbackUsed;
      doneJob.updatedAt = new Date().toISOString();
      this.db.upsertHandoffJob(doneJob);
      this.db.releaseLease(job.sourceSessionId, jobId);
      this.db.appendAuditEvent(
        'HANDOFF_SUCCEEDED',
        { targetSessionId: resumeOutcome.targetSession.id, fallbackUsed: resumeOutcome.fallbackUsed },
        { sessionId: job.sourceSessionId, jobId }
      );
      this.emitEvent({ type: 'handoff_update', job: doneJob });
      return doneJob;
    } catch (err) {
      const failedJob = this.db.getHandoffJob(jobId)!;
      failedJob.status = 'FAILED';
      failedJob.errorCode = isAgentHubError(err) ? err.code : 'INTERNAL_ERROR';
      failedJob.errorMessage = err instanceof Error ? err.message : String(err);
      failedJob.updatedAt = new Date().toISOString();
      this.db.upsertHandoffJob(failedJob);

      // Safe rollback of source session status & lease
      const rolledBack = await sourceProvider
        .rollbackHandoff(job.sourceSessionId)
        .catch(() => null);
      if (rolledBack) {
        this.db.upsertSession(rolledBack);
        this.emitEvent({ type: 'session_update', session: rolledBack });
      }
      this.db.releaseLease(job.sourceSessionId, jobId);
      this.db.appendAuditEvent(
        'HANDOFF_FAILED',
        { errorCode: failedJob.errorCode, errorMessage: failedJob.errorMessage },
        { sessionId: job.sourceSessionId, jobId }
      );
      this.emitEvent({ type: 'handoff_update', job: failedJob });
      return failedJob;
    }
  }
}
