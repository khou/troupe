import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAdapter } from '../adapters/index.js';
import type { AdapterResult } from '../adapters/types.js';
import {
  addWorktree,
  commitWorktree,
  diffStat,
  git,
  pushClaim,
  releaseClaim,
  removeWorktree,
} from './git.js';
import { ulid } from './id.js';
import {
  appendRunEvent,
  claimTask,
  addProposal,
  getTaskView,
  listTaskViews,
  readConfig,
  runnerIdentity,
  TRUPE_DIR,
} from './store.js';
import type { Proposal, TaskView } from './types.js';

export interface RunOptions {
  taskId?: string;          // resolved full id; undefined = pick oldest runnable
  agent?: string;           // adapter override
  timeoutMs?: number;
  keepWorktree?: boolean;
  onProgress?: (line: string) => void;
}

export type RunOutcome =
  | { outcome: 'no-task'; detail: string }
  | { outcome: 'claim-lost'; taskId: string; detail: string }
  | { outcome: 'failed'; taskId: string; error: string }
  | { outcome: 'proposed'; taskId: string; proposal: Proposal; adapterResult: AdapterResult; claimMode: 'remote' | 'local' };

const RUNNABLE = new Set(['open', 'rejected']);

export function pickRunnableTask(root: string, explicitId?: string): TaskView | null {
  if (explicitId) {
    const view = getTaskView(root, explicitId);
    return RUNNABLE.has(view.status) ? view : null;
  }
  const views = listTaskViews(root).filter((v) => RUNNABLE.has(v.status));
  return views[0] ?? null; // ULID order = oldest first
}

/** Detect a workspace bootstrap command from lockfiles (recorded + run pre-agent). */
export function detectBootstrap(dir: string): string[] | null {
  if (fs.existsSync(path.join(dir, 'pnpm-lock.yaml'))) return ['pnpm', 'install', '--frozen-lockfile'];
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return ['npm', 'ci', '--no-audit', '--no-fund'];
  if (fs.existsSync(path.join(dir, 'uv.lock'))) return ['uv', 'sync'];
  return null;
}

export function composePrompt(view: TaskView, branch: string): string {
  return [
    `You are a coding agent working on a task from this repository's shared queue (trupe).`,
    ``,
    `# Task ${view.task.id}: ${view.task.title}`,
    ``,
    view.task.body || '(no further brief)',
    ``,
    `# Rules`,
    `- Work ONLY inside the current directory (a git worktree on branch ${branch}).`,
    `- Never modify anything under .trupe/ - that is coordination state, not your workspace.`,
    `- Do NOT run git commit or git push; just edit files. The runner commits your changes when you finish.`,
    ``,
    `# Report`,
    `End your reply with exactly this structure:`,
    `## Summary`,
    `(one line)`,
    `## What changed`,
    `## How to verify`,
    `## Risks`,
  ].join('\n');
}

export async function runTask(root: string, opts: RunOptions = {}): Promise<RunOutcome> {
  const config = readConfig(root);
  const view = pickRunnableTask(root, opts.taskId);
  if (!view) {
    return { outcome: 'no-task', detail: opts.taskId ? 'task is not in a runnable state' : 'no open tasks' };
  }
  const taskId = view.task.id;
  const agentName = opts.agent ?? view.task.agent ?? config.defaultAgent;
  const agentConfig = config.agents[agentName] ?? { adapter: agentName };
  const adapter = getAdapter(agentConfig.adapter);
  const unavailable = await adapter.available();
  if (unavailable) return { outcome: 'failed', taskId, error: unavailable };

  const runner = runnerIdentity();
  const progress = opts.onProgress ?? (() => {});

  // Claim: local record for the fold + remote CAS for cross-machine exclusion.
  const claim = claimTask(root, taskId, runner, agentName);
  const push = await pushClaim(root, taskId, JSON.stringify(claim));
  if (!push.won) {
    return { outcome: 'claim-lost', taskId, detail: push.detail };
  }
  progress(`claimed ${taskId} (${push.mode}: ${push.detail})`);
  const localWinner = getTaskView(root, taskId).winningClaim;
  if (localWinner && localWinner.id !== claim.id) {
    await releaseClaim(root, taskId);
    return { outcome: 'claim-lost', taskId, detail: 'a lower-ULID local claim exists' };
  }

  const runId = ulid();
  const branch = `trupe/${taskId}`;
  const worktreeDir = path.join(root, TRUPE_DIR, 'worktrees', taskId);
  const startedAt = Date.now();
  appendRunEvent(root, taskId, runId, {
    ts: new Date().toISOString(),
    kind: 'start',
    data: { adapter: agentName, runner, host: os.hostname(), claimId: claim.id, claimMode: push.mode, branch },
  });

  const cleanup = async () => {
    if (!opts.keepWorktree) await removeWorktree(root, worktreeDir);
    await releaseClaim(root, taskId);
  };

  try {
    const wt = await addWorktree(root, worktreeDir, branch);
    if (!wt.ok) throw new Error(`worktree failed: ${wt.reason}`);

    // Provision the workspace before the agent sees it; a broken env must be
    // visible in the receipt, not inferred from a flailing agent.
    const bootstrap = detectBootstrap(worktreeDir);
    if (bootstrap) {
      progress(`bootstrap: ${bootstrap.join(' ')}`);
      const code = await new Promise<number>((resolve) => {
        const child = execFile(bootstrap[0], bootstrap.slice(1), { cwd: worktreeDir, timeout: 300_000 }, () =>
          resolve(child.exitCode ?? -1));
        child.on('error', () => resolve(-1));
      });
      appendRunEvent(root, taskId, runId, {
        ts: new Date().toISOString(), kind: 'log',
        data: { bootstrap: bootstrap.join(' '), exitCode: code },
      });
    }

    const prompt = composePrompt(view, branch);
    const result = await adapter.run({
      workspaceDir: worktreeDir,
      prompt,
      taskId,
      config: agentConfig,
      timeoutMs: opts.timeoutMs ?? 20 * 60 * 1000,
      onOutput: (chunk) => {
        appendRunEvent(root, taskId, runId, { ts: new Date().toISOString(), kind: 'log', data: { chunk: chunk.slice(0, 2000) } });
      },
    });

    if (!result.ok) {
      appendRunEvent(root, taskId, runId, {
        ts: new Date().toISOString(), kind: 'error', data: { error: result.error, summary: result.summary },
      });
      await cleanup();
      return { outcome: 'failed', taskId, error: result.error ?? result.summary };
    }

    const commit = await commitWorktree(worktreeDir, `trupe(${taskId.slice(0, 8)}): agent work by ${agentName}`);
    const baseRes = await git(root, ['rev-parse', 'HEAD']);
    const stat = baseRes.ok ? await diffStat(root, baseRes.stdout, branch) : '';

    const receipt = {
      runId,
      adapter: agentName,
      runner,
      host: os.hostname(),
      claimId: claim.id,
      claimMode: push.mode,
      durationMs: Date.now() - startedAt,
      ...result.meta,
    };
    const proposal = addProposal(root, {
      taskId,
      claimId: claim.id,
      runner,
      adapter: agentName,
      summary: result.summary,
      branch,
      body: [
        result.output.trim(),
        '',
        '## Diffstat',
        '',
        stat ? '```\n' + stat + '\n```' : '_no file changes on the branch_',
        '',
        '## Receipt',
        '',
        '```json',
        JSON.stringify(receipt, null, 2),
        '```',
      ].join('\n'),
    });

    appendRunEvent(root, taskId, runId, {
      ts: new Date().toISOString(),
      kind: 'end',
      data: { proposalId: proposal.id, committed: commit.committed, sha: commit.sha, ...receipt },
    });
    await cleanup();
    return { outcome: 'proposed', taskId, proposal, adapterResult: result, claimMode: push.mode };
  } catch (err) {
    appendRunEvent(root, taskId, runId, { ts: new Date().toISOString(), kind: 'error', data: { error: String(err) } });
    await cleanup();
    return { outcome: 'failed', taskId, error: String(err) };
  }
}
