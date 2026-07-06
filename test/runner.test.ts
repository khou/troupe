import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushClaim } from '../dist/core/git.js';
import { composePrompt, detectBootstrap, runTask } from '../dist/core/runner.js';
import {
  createTask,
  decide,
  getTaskView,
  initTroupe,
  listRunIds,
  readRunEvents,
} from '../dist/core/store.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

let tmp: string;
let bare: string;
let repo: string;
let repoB: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-run-'));
  bare = path.join(tmp, 'origin.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '-q', '--bare', bare]);

  repo = path.join(tmp, 'work');
  fs.mkdirSync(repo);
  sh(repo, ['init', '-q', '-b', 'main']);
  sh(repo, ['config', 'user.name', 'Test Human']);
  sh(repo, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'demo repo\n');
  sh(repo, ['add', '.']);
  sh(repo, ['commit', '-qm', 'init']);
  sh(repo, ['remote', 'add', 'origin', bare]);
  sh(repo, ['push', '-q', 'origin', 'main']);
  initTroupe(repo, { defaultAgent: 'fake' });
  sh(repo, ['add', '.troupe']);
  sh(repo, ['commit', '-qm', 'troupe init']);

  repoB = path.join(tmp, 'workB');
  execFileSync('git', ['clone', '-q', bare, repoB]);
  sh(repoB, ['config', 'user.name', 'Other Human']);
  sh(repoB, ['config', 'user.email', 'other@example.com']);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('runner', () => {
  it('runs the full loop: claim -> worktree -> fake agent -> proposal -> approve', async () => {
    const task = createTask(repo, {
      title: 'Write the greeting file',
      body: 'Please create a greeting.\nFAKE:write greeting.txt hello from the fake agent',
    });

    const result = await runTask(repo, { taskId: task.id });
    expect(result.outcome).toBe('proposed');
    if (result.outcome !== 'proposed') return;

    // Work landed on the task branch, not on main, and the worktree is gone.
    expect(fs.existsSync(path.join(repo, '.troupe/worktrees', task.id))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'greeting.txt'))).toBe(false);
    const branchFile = sh(repo, ['show', `troupe/${task.id}:greeting.txt`]);
    expect(branchFile).toBe('hello from the fake agent');

    // Proposal carries summary, diffstat, and a receipt.
    expect(result.proposal.summary).toContain('greeting.txt');
    expect(result.proposal.body).toContain('## Receipt');
    expect(result.proposal.body).toContain('greeting.txt');

    // Fold reflects the proposal; approve closes the loop.
    let view = getTaskView(repo, task.id);
    expect(view.status).toBe('proposed');
    expect(view.conflicts).toEqual([]);
    decide(repo, { taskId: task.id, proposalId: result.proposal.id, verdict: 'approve' });
    view = getTaskView(repo, task.id);
    expect(view.status).toBe('approved');

    // Run log has start and end events.
    const runIds = listRunIds(repo, task.id);
    expect(runIds).toHaveLength(1);
    const kinds = readRunEvents(repo, task.id, runIds[0]).map((e) => e.kind);
    expect(kinds[0]).toBe('start');
    expect(kinds[kinds.length - 1]).toBe('end');
  });

  it('loses the claim race to another machine and does not run', async () => {
    const task = createTask(repo, { title: 'Contested work', body: 'FAKE:write x.txt x' });
    sh(repo, ['add', '.troupe']);
    sh(repo, ['commit', '-qm', 'task']);
    sh(repo, ['push', '-q', 'origin', 'main']);

    // Machine B claims first (remote CAS).
    const b = await pushClaim(repoB, task.id, '{"runner":"b"}');
    expect(b.won).toBe(true);

    const result = await runTask(repo, { taskId: task.id });
    expect(result.outcome).toBe('claim-lost');
    expect(fs.existsSync(path.join(repo, '.troupe/worktrees', task.id))).toBe(false);
  });

  it('reports adapter failure and releases the claim', async () => {
    const task = createTask(repo, { title: 'Doomed', body: 'FAKE:fail deliberate' });
    const result = await runTask(repo, { taskId: task.id });
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') return;
    expect(result.error).toBe('deliberate');
    // Task is not stuck: another run can claim again once the local claim is superseded remotely.
    expect(fs.existsSync(path.join(repo, '.troupe/worktrees', task.id))).toBe(false);
  });

  it('contested proposals are fenced out of the decidable set', async () => {
    const task = createTask(repo, { title: 'Fence me', body: 'FAKE:write f.txt f' });
    const first = await runTask(repo, { taskId: task.id });
    expect(first.outcome).toBe('proposed');

    // Simulate a zombie: a proposal citing a claim that is not the winner.
    const { addProposal, claimTask } = await import('../dist/core/store.js');
    const zombieClaim = claimTask(repo, task.id, 'zombie@old-laptop', 'fake');
    addProposal(repo, {
      taskId: task.id, claimId: zombieClaim.id, runner: 'zombie@old-laptop',
      adapter: 'fake', summary: 'stale work', body: 'from a lost claim',
    });

    const view = getTaskView(repo, task.id);
    expect(view.contestedProposalIds).toHaveLength(1);
    expect(view.conflicts.some((c) => c.includes('contested'))).toBe(true);
    // Status still derives from the legitimate proposal only.
    expect(view.status).toBe('proposed');
  });

  it('stale votes are surfaced when proposal content changes under a decision', async () => {
    const task = createTask(repo, { title: 'Pin me', body: 'FAKE:write p.txt p' });
    const run = await runTask(repo, { taskId: task.id });
    if (run.outcome !== 'proposed') throw new Error('expected proposal');

    decide(repo, { taskId: task.id, proposalId: run.proposal.id, verdict: 'approve' });
    expect(getTaskView(repo, task.id).status).toBe('approved');

    // Someone amends the proposal file after the vote.
    const pPath = path.join(repo, '.troupe/proposals', task.id, `${run.proposal.id}.md`);
    fs.appendFileSync(pPath, '\n\nAlso: run a schema migration in prod.\n');

    const view = getTaskView(repo, task.id);
    expect(view.status).toBe('proposed'); // approval no longer counts
    expect(view.conflicts.some((c) => c.includes('stale vote'))).toBe(true);
  });

  it('composePrompt embeds the brief and the report contract', () => {
    const task = createTask(repo, { title: 'Prompt shape', body: 'Do a thing.' });
    const prompt = composePrompt(getTaskView(repo, task.id), 'troupe/x');
    expect(prompt).toContain('Prompt shape');
    expect(prompt).toContain('Do a thing.');
    expect(prompt).toContain('## Summary');
    expect(prompt).toContain('.troupe/');
  });

  it('detects bootstrap commands from lockfiles', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-'));
    expect(detectBootstrap(d)).toBeNull();
    fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
    expect(detectBootstrap(d)?.[0]).toBe('npm');
    fs.rmSync(d, { recursive: true, force: true });
  });
});
