import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseDoc, serializeDoc } from '../dist/core/frontmatter.js';
import { isUlid, ulid, ulidTime } from '../dist/core/id.js';
import {
  addProposal,
  claimTask,
  createTask,
  decide,
  findRoot,
  getTaskView,
  initTrupe,
  listTaskViews,
  markTask,
  readTask,
  resolveTaskId,
} from '../dist/core/store.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'trupe-test-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Test Human'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
  initTrupe(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('ulid', () => {
  it('is well-formed and sortable by time', () => {
    const a = ulid(1000000000000);
    const b = ulid(1000000000001);
    expect(isUlid(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(ulidTime(a)).toBe(1000000000000);
  });

  it('does not collide across many calls', () => {
    const seen = new Set(Array.from({ length: 5000 }, () => ulid()));
    expect(seen.size).toBe(5000);
  });
});

describe('frontmatter', () => {
  it('round-trips typical task headers', () => {
    const data = {
      id: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
      title: 'Fix the flaky test in auth/session.test.ts',
      tags: ['bug', 'ci'],
      priority: 'high',
      count: 3,
      draft: false,
    };
    const raw = serializeDoc(data, 'Body **markdown** here.\n');
    const parsed = parseDoc(raw);
    expect(parsed.data).toEqual(data);
    expect(parsed.body.trim()).toBe('Body **markdown** here.');
  });

  it('passes through documents without frontmatter', () => {
    const parsed = parseDoc('just text');
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe('just text');
  });
});

describe('store', () => {
  it('init is idempotent', () => {
    const again = initTrupe(root);
    expect(again.version).toBe(1);
    expect(findRoot(path.join(root))).toBe(root);
  });

  it('finds root from a nested directory', () => {
    const nested = path.join(root, 'src', 'deep');
    fs.mkdirSync(nested, { recursive: true });
    expect(findRoot(nested)).toBe(root);
  });

  it('creates and reads back a task with author from git config', () => {
    const t = createTask(root, { title: 'Add dark mode', body: 'Details.', tags: ['ui'] });
    const back = readTask(root, t.id);
    expect(back.title).toBe('Add dark mode');
    expect(back.author).toBe('Test Human <test@example.com>');
    expect(back.tags).toEqual(['ui']);
    expect(back.body.trim()).toBe('Details.');
  });

  it('resolves task id prefixes and rejects ambiguity', () => {
    const t = createTask(root, { title: 'One' });
    expect(resolveTaskId(root, t.id.slice(0, 8).toLowerCase())).toBe(t.id);
    expect(() => resolveTaskId(root, 'ZZZZZZ')).toThrow(/no task/);
  });

  it('walks the full lifecycle: open -> claimed -> proposed -> approved -> done', () => {
    const t = createTask(root, { title: 'Lifecycle' });
    expect(getTaskView(root, t.id).status).toBe('open');

    const claim = claimTask(root, t.id, 'alice@laptop', 'fake');
    expect(getTaskView(root, t.id).status).toBe('claimed');

    const p = addProposal(root, {
      taskId: t.id,
      claimId: claim.id,
      runner: 'alice@laptop',
      adapter: 'fake',
      summary: 'Did the thing',
      body: '## What\nChanged X.\n',
      branch: 'trupe/lifecycle',
    });
    expect(getTaskView(root, t.id).status).toBe('proposed');

    decide(root, { taskId: t.id, proposalId: p.id, verdict: 'approve', note: 'lgtm' });
    const view = getTaskView(root, t.id);
    expect(view.status).toBe('approved');
    expect(view.winningDecision?.decider).toBe('Test Human <test@example.com>');

    markTask(root, t.id, 'done');
    expect(getTaskView(root, t.id).status).toBe('done');
  });

  it('resolves double-claims deterministically: lowest ULID wins', () => {
    const t = createTask(root, { title: 'Contested' });
    const c1 = claimTask(root, t.id, 'alice@laptop', 'fake');
    const c2 = claimTask(root, t.id, 'bob@desktop', 'fake');
    const winner = getTaskView(root, t.id).winningClaim;
    expect(winner?.id).toBe([c1.id, c2.id].sort()[0]);
    // Both runners folding the same files agree on the same winner.
    expect(getTaskView(root, t.id).winningClaim?.id).toBe(winner?.id);
  });

  it('first decision per proposal is binding; later conflicting decisions are inert', () => {
    const t = createTask(root, { title: 'Race' });
    const claim = claimTask(root, t.id, 'alice@laptop', 'fake');
    const p = addProposal(root, {
      taskId: t.id,
      claimId: claim.id,
      runner: 'alice@laptop',
      adapter: 'fake',
      summary: 's',
      body: 'b',
    });
    const d1 = decide(root, { taskId: t.id, proposalId: p.id, verdict: 'reject' });
    decide(root, { taskId: t.id, proposalId: p.id, verdict: 'approve' });
    const view = getTaskView(root, t.id);
    // d1 was created first (lower ULID) so the task stays rejected.
    expect(view.decisions[0].id).toBe(d1.id);
    expect(view.status).toBe('rejected');
  });

  it('a rejected task reopens on a fresh proposal', () => {
    const t = createTask(root, { title: 'Retry' });
    const claim = claimTask(root, t.id, 'alice@laptop', 'fake');
    const p1 = addProposal(root, {
      taskId: t.id, claimId: claim.id, runner: 'alice@laptop', adapter: 'fake', summary: 'v1', body: 'b',
    });
    decide(root, { taskId: t.id, proposalId: p1.id, verdict: 'reject' });
    expect(getTaskView(root, t.id).status).toBe('rejected');
    addProposal(root, {
      taskId: t.id, claimId: claim.id, runner: 'alice@laptop', adapter: 'fake', summary: 'v2', body: 'b2',
    });
    expect(getTaskView(root, t.id).status).toBe('proposed');
  });

  it('lists task views across many tasks', () => {
    createTask(root, { title: 'A' });
    createTask(root, { title: 'B' });
    expect(listTaskViews(root)).toHaveLength(2);
  });
});
