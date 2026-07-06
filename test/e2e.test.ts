import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const BIN = path.resolve(import.meta.dirname, '..', 'bin', 'troupe.js');

function troupe(cwd: string, args: string[], expectFail = false): string {
  try {
    return execFileSync(process.execPath, [BIN, ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    }).toString();
  } catch (err) {
    if (expectFail) {
      const e = err as { stdout?: Buffer; stderr?: Buffer };
      return `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    throw err;
  }
}

function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd }).toString().trim();
}

function makeRepo(dir: string, name = 'Test Human', email = 'test@example.com'): void {
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, ['init', '-q', '-b', 'main']);
  sh(dir, ['config', 'user.name', name]);
  sh(dir, ['config', 'user.email', email]);
  fs.writeFileSync(path.join(dir, 'README.md'), '# e2e demo\n');
  sh(dir, ['add', '.']);
  sh(dir, ['commit', '-qm', 'init']);
}

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'troupe-e2e-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('e2e: the quickstart loop through the real CLI', () => {
  it('init → run --demo → review → approve → mark done, with audit trail', () => {
    const repo = path.join(tmp, 'solo');
    makeRepo(repo);

    const init = troupe(repo, ['init']);
    expect(init).toContain('initialized .troupe/');
    expect(fs.existsSync(path.join(repo, '.troupe/config.json'))).toBe(true);
    expect(fs.existsSync(path.join(repo, '.troupe/PROTOCOL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8')).toContain('troupe:begin');

    const run = troupe(repo, ['run', '--demo']);
    expect(run).toContain('proposal');

    const reviewJson = JSON.parse(troupe(repo, ['review', '--json']));
    expect(reviewJson).toHaveLength(1);
    const proposalId: string = reviewJson[0].proposalId;

    const approve = troupe(repo, ['approve', proposalId.slice(-8)]);
    expect(approve).toContain('approved proposal');
    expect(approve).toContain('Test Human <test@example.com>');
    expect(approve).toContain('task status: approved');

    // The work is on the branch, main untouched.
    const branch = reviewJson[0].branch as string;
    expect(sh(repo, ['show', `${branch}:TROUPE_HELLO.md`])).toContain('troupe demo');
    expect(fs.existsSync(path.join(repo, 'TROUPE_HELLO.md'))).toBe(false);

    troupe(repo, ['mark', reviewJson[0].taskId.slice(-8), 'done']);
    const list = JSON.parse(troupe(repo, ['task', 'list', '--json']));
    expect(list[0].status).toBe('done');

    // Audit trail on disk: task, claim, proposal, decision, mark, run log.
    const t = reviewJson[0].taskId;
    for (const dir of ['claims', 'proposals', 'decisions', 'marks', 'runs']) {
      const entries = fs.readdirSync(path.join(repo, '.troupe', dir, t));
      expect(entries.length).toBeGreaterThan(0);
    }
    // Decision file carries identity + content pin.
    const dDir = path.join(repo, '.troupe/decisions', t);
    const decision = JSON.parse(fs.readFileSync(path.join(dDir, fs.readdirSync(dDir)[0]), 'utf8'));
    expect(decision.decider).toBe('Test Human <test@example.com>');
    expect(decision.contentSha).toMatch(/^[0-9a-f]{64}$/);
  });

  it('two clones: state travels by git; teammate reviews what the runner produced', () => {
    const bare = path.join(tmp, 'origin.git');
    fs.mkdirSync(bare);
    execFileSync('git', ['init', '-q', '--bare', bare]);

    const alice = path.join(tmp, 'alice');
    makeRepo(alice, 'Alice', 'alice@example.com');
    sh(alice, ['remote', 'add', 'origin', bare]);
    sh(alice, ['push', '-q', '-u', 'origin', 'main']);

    troupe(alice, ['init']);
    troupe(alice, ['task', 'add', 'Write the banner', '--body', 'FAKE:write banner.txt the team was here']);
    // Run the specific task (init also seeds a hello task).
    const tasks = JSON.parse(troupe(alice, ['task', 'list', '--json']));
    const banner = tasks.find((t: { title: string }) => t.title === 'Write the banner');
    troupe(alice, ['run', '--task', banner.id.slice(-8), '--demo']);
    troupe(alice, ['sync']);
    // Push the agent's work branch too so Bob can inspect it.
    sh(alice, ['push', '-q', 'origin', `troupe/${banner.id}`]);

    const bob = path.join(tmp, 'bob');
    execFileSync('git', ['clone', '-q', bare, bob]);
    sh(bob, ['config', 'user.name', 'Bob']);
    sh(bob, ['config', 'user.email', 'bob@example.com']);

    // Bob sees Alice's proposal with zero setup beyond the clone.
    const pending = JSON.parse(troupe(bob, ['review', '--json']));
    const bobView = pending.find((p: { taskId: string }) => p.taskId === banner.id);
    expect(bobView).toBeTruthy();

    const approve = troupe(bob, ['approve', bobView.proposalId.slice(-8)]);
    expect(approve).toContain('Bob <bob@example.com>');

    // Bob's decision syncs back to Alice.
    troupe(bob, ['sync']);
    sh(alice, ['pull', '-q', 'origin', 'main']);
    const aliceList = JSON.parse(troupe(alice, ['task', 'list', '--json']));
    expect(aliceList.find((t: { id: string }) => t.id === banner.id).status).toBe('approved');
  });

  it('board serves HTML and JSON', async () => {
    const repo = path.join(tmp, 'board');
    makeRepo(repo);
    troupe(repo, ['init']);
    troupe(repo, ['run', '--demo']);

    const { startBoard } = await import('../dist/board/server.js');
    const server = startBoard(repo, 4587) as http.Server;
    try {
      const html = await fetchText('http://localhost:4587/');
      expect(html).toContain('troupe');
      expect(html).toContain('proposed');
      const api = JSON.parse(await fetchText('http://localhost:4587/api'));
      expect(api.tasks).toHaveLength(1);
      expect(api.tasks[0].status).toBe('proposed');
    } finally {
      server.close();
    }
  });

  it('help and unknown commands behave', () => {
    const repo = path.join(tmp, 'help');
    makeRepo(repo);
    expect(troupe(repo, ['--help'], true)).toContain('usage: troupe');
    expect(troupe(repo, ['not-a-command'], true)).toContain('usage: troupe');
  });
});

function fetchText(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}
