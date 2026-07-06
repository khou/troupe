import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addWorktree,
  commitPaths,
  commitWorktree,
  indexDirty,
  pushClaim,
  releaseClaim,
  remoteClaimLive,
  removeWorktree,
} from '../dist/core/git.js';

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function makeRepo(dir: string): void {
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', 'Test']);
  sh(dir, ['config', 'user.email', 'test@example.com']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, ['add', 'README.md']);
  sh(dir, ['commit', '-qm', 'init']);
}

let tmp: string;
let bare: string;
let cloneA: string;
let cloneB: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trupe-git-'));
  bare = path.join(tmp, 'origin.git');
  fs.mkdirSync(bare);
  execFileSync('git', ['init', '-q', '--bare', bare]);

  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  makeRepo(seed);
  sh(seed, ['remote', 'add', 'origin', bare]);
  sh(seed, ['push', '-q', 'origin', 'main']);

  cloneA = path.join(tmp, 'a');
  cloneB = path.join(tmp, 'b');
  execFileSync('git', ['clone', '-q', bare, cloneA]);
  execFileSync('git', ['clone', '-q', bare, cloneB]);
  for (const c of [cloneA, cloneB]) {
    sh(c, ['config', 'user.name', 'Test']);
    sh(c, ['config', 'user.email', 'test@example.com']);
  }
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claim refs (remote CAS)', () => {
  it('first claimant wins, second is rejected', async () => {
    const a = await pushClaim(cloneA, 'TASK1', '{"runner":"a"}');
    expect(a.mode).toBe('remote');
    expect(a.won).toBe(true);

    const b = await pushClaim(cloneB, 'TASK1', '{"runner":"b"}');
    expect(b.mode).toBe('remote');
    expect(b.won).toBe(false);
  });

  it('claims on different tasks do not contend', async () => {
    const a = await pushClaim(cloneA, 'TASK1', '{}');
    const b = await pushClaim(cloneB, 'TASK2', '{}');
    expect(a.won).toBe(true);
    expect(b.won).toBe(true);
  });

  it('release tombstones the ref and liveness reflects it', async () => {
    await pushClaim(cloneA, 'TASK1', '{}');
    expect(await remoteClaimLive(cloneA, 'TASK1')).toBe(true);
    await releaseClaim(cloneA, 'TASK1');
    expect(await remoteClaimLive(cloneB, 'TASK1')).toBe(false);
  });

  it('falls back to provisional local mode with no remote', async () => {
    const lone = path.join(tmp, 'lone');
    fs.mkdirSync(lone);
    makeRepo(lone);
    const res = await pushClaim(lone, 'TASK1', '{}');
    expect(res.mode).toBe('local');
    expect(res.won).toBe(true);
    expect(res.detail).toContain('provisional');
  });
});

describe('dirty-index safety', () => {
  it('refuses to commit trupe paths while user work is staged', async () => {
    fs.writeFileSync(path.join(cloneA, 'user-wip.txt'), 'half-finished\n');
    sh(cloneA, ['add', 'user-wip.txt']);
    expect(await indexDirty(cloneA)).toBe(true);

    fs.mkdirSync(path.join(cloneA, '.trupe'), { recursive: true });
    fs.writeFileSync(path.join(cloneA, '.trupe/x.json'), '{}\n');
    const res = await commitPaths(cloneA, ['.trupe/x.json'], 'trupe: record');
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('staged');
    // The user's staged file was not committed.
    expect(sh(cloneA, ['log', '--oneline'])).not.toContain('trupe: record');
  });

  it('commits exactly the given paths on a clean index', async () => {
    fs.writeFileSync(path.join(cloneA, 'unrelated.txt'), 'untracked but unstaged\n');
    fs.mkdirSync(path.join(cloneA, '.trupe'), { recursive: true });
    fs.writeFileSync(path.join(cloneA, '.trupe/x.json'), '{}\n');
    const res = await commitPaths(cloneA, ['.trupe/x.json'], 'trupe: record');
    expect(res.ok).toBe(true);
    const shown = sh(cloneA, ['show', '--name-only', '--format=', 'HEAD']);
    expect(shown).toContain('.trupe/x.json');
    expect(shown).not.toContain('unrelated.txt');
  });
});

describe('worktrees', () => {
  it('creates, commits inside, and removes a worktree', async () => {
    const wt = path.join(tmp, 'wt-task1');
    const add = await addWorktree(cloneA, wt, 'trupe/task1');
    expect(add.ok).toBe(true);

    fs.writeFileSync(path.join(wt, 'agent-output.txt'), 'work\n');
    const commit = await commitWorktree(wt, 'trupe: agent work');
    expect(commit.committed).toBe(true);
    expect(commit.sha).toBeTruthy();

    await removeWorktree(cloneA, wt);
    expect(fs.existsSync(wt)).toBe(false);
    // Branch survives worktree removal.
    expect(sh(cloneA, ['rev-parse', '--verify', 'refs/heads/trupe/task1'])).toBeTruthy();
  });

  it('reports no commit when the agent changed nothing', async () => {
    const wt = path.join(tmp, 'wt-task2');
    await addWorktree(cloneA, wt, 'trupe/task2');
    const commit = await commitWorktree(wt, 'trupe: agent work');
    expect(commit.committed).toBe(false);
    await removeWorktree(cloneA, wt);
  });
});
