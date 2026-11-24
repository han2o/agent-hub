import { describe, expect, it } from 'vitest';
import {
  encodeClaudeCwd,
  encodePiCwd,
  encodePiSessionDirName,
  encodeQoderCwd,
  extractRepoName,
  normalizeGitOriginUrl,
  rewriteFileUriArrayJson,
  rewritePath,
  type PathMappingRule
} from '@agent-hub/protocol';

describe('protocol path utilities', () => {
  it('normalizes SSH, SCP, and HTTPS git origin URLs consistently', () => {
    expect(normalizeGitOriginUrl('git@github.com:Org/My-Repo.git')).toBe(
      'github.com/org/my-repo'
    );
    expect(normalizeGitOriginUrl('ssh://git@github.com:22/Org/My-Repo.git')).toBe(
      'github.com/org/my-repo'
    );
    expect(normalizeGitOriginUrl('https://user@github.com/Org/My-Repo/')).toBe(
      'github.com/org/my-repo'
    );
    expect(normalizeGitOriginUrl('ssh://git@git.example.com:2222/team/app.git')).toBe(
      'git.example.com:2222/team/app'
    );
  });

  it('extracts repo names cleanly', () => {
    expect(extractRepoName('git@github.com:acme/agent-hub.git')).toBe('agent-hub');
    expect(extractRepoName('/Users/alice/Workspace/my-service/')).toBe('my-service');
  });

  it('rewrites paths respecting priority and segment boundaries', () => {
    const rule: PathMappingRule = {
      sourceHome: '/Users/alice',
      targetHome: '/Users/mini',
      sourceCwd: '/Users/alice/Workspace/app-a',
      targetCwd: '/Users/mini/Projects/app-a-wt',
      sourceWorkspaceRoots: ['/Users/alice/Workspace'],
      targetWorkspaceRoots: ['/Users/mini/Code'],
      repoMappings: [
        {
          sourceCwd: '/Users/alice/Workspace/special',
          targetCwd: '/Volumes/SSD/special-repo'
        }
      ]
    };

    // Priority 1: exact sourceCwd
    expect(rewritePath('/Users/alice/Workspace/app-a/src/index.ts', rule)).toBe(
      '/Users/mini/Projects/app-a-wt/src/index.ts'
    );
    // Priority 2: explicit repoMappings
    expect(rewritePath('/Users/alice/Workspace/special/README.md', rule)).toBe(
      '/Volumes/SSD/special-repo/README.md'
    );
    // Priority 3: workspaceRoots
    expect(rewritePath('/Users/alice/Workspace/other/file.ts', rule)).toBe(
      '/Users/mini/Code/other/file.ts'
    );
    // Priority 4: homeDir
    expect(rewritePath('/Users/alice/Desktop/notes.md', rule)).toBe(
      '/Users/mini/Desktop/notes.md'
    );
    // Segment boundary safety: must NOT match /Users/alice2
    expect(rewritePath('/Users/alice2/Workspace/other', rule)).toBe(
      '/Users/alice2/Workspace/other'
    );
  });

  it('encodes cwd directories accurately for pi, claude, and qodercli', () => {
    expect(encodePiCwd('/Users/alice/Ai-cli/gpt-5.6-instruct')).toBe(
      'Users-alice-Ai-cli-gpt-5.6-instruct'
    );
    expect(encodePiSessionDirName('/Users/alice/Desktop')).toBe(
      '--Users-alice-Desktop--'
    );
    expect(encodeClaudeCwd('/Users/alice/Workspace/foo.bar_v1')).toBe(
      '-Users-alice-Workspace-foo-bar-v1'
    );
    expect(encodeQoderCwd('/Users/alice/Workspace/api.service.dev')).toBe(
      '-Users-alice-Workspace-api-service-dev'
    );
  });

  it('rewrites agy workspace_uris JSON arrays', () => {
    const rule: PathMappingRule = {
      sourceHome: '/Users/alice',
      targetHome: '/Users/mini',
      sourceCwd: '/Users/alice/Workspace/demo',
      targetCwd: '/Users/mini/Projects/demo-wt',
      sourceWorkspaceRoots: [],
      targetWorkspaceRoots: [],
      repoMappings: []
    };
    const input = JSON.stringify(['file:///Users/alice/Workspace/demo']);
    expect(rewriteFileUriArrayJson(input, rule)).toBe(
      JSON.stringify(['file:///Users/mini/Projects/demo-wt'])
    );
  });
});
