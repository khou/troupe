import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listAdapters, getAdapter } from '../adapters/index.js';
import { startBoard } from '../board/server.js';
import { commitPaths, git, hasRemote, indexDirty } from '../core/git.js';
import { pinAgentsMd, protocolMarkdown, shimClaudeMd, writeProtocol } from '../core/protocol.js';
import { runTask } from '../core/runner.js';
import {
  createTask,
  decide,
  findRoot,
  getTaskView,
  humanIdentity,
  initTroupe,
  listTaskViews,
  markTask,
  readConfig,
  requireRoot,
  resolveTaskId,
  TROUPE_DIR,
} from '../core/store.js';
import type { TaskView } from '../core/types.js';

const VERSION = '0.1.0';

interface Flags {
  [key: string]: string | boolean;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function fail(msg: string): never {
  console.error(`troupe: ${msg}`);
  process.exit(1);
}

function short(id: string): string {
  // ULID tails are the entropy; heads are the timestamp and collide within a
  // millisecond (task + its seeded proposal share a head in the demo).
  return id.slice(-8).toLowerCase();
}

function statusLine(v: TaskView): string {
  const bits = [`[${v.status}]`, short(v.task.id), v.task.title];
  if (v.winningClaim && v.status === 'claimed') bits.push(`(${v.winningClaim.runner})`);
  if (v.proposals.length) bits.push(`- ${v.proposals.length} proposal(s)`);
  return bits.join(' ');
}

// ---------------------------------------------------------------------------

async function cmdInit(flags: Flags): Promise<void> {
  const cwd = process.cwd();
  const inRepo = fs.existsSync(path.join(cwd, '.git')) || findGitRoot(cwd) !== null;
  if (!inRepo) fail('not inside a git repository - run `git init` first');
  const root = findGitRoot(cwd) ?? cwd;

  const gitVersion = safeExec('git', ['--version']);
  if (!gitVersion) fail('git not found on PATH');

  const config = initTroupe(root, {
    defaultAgent: typeof flags.agent === 'string' ? flags.agent : undefined,
  });
  writeProtocol(root);
  const pin = pinAgentsMd(root);
  const shim = shimClaudeMd(root);

  // Detect agents without hanging: --version probes only.
  const detected: string[] = [];
  for (const adapter of listAdapters()) {
    if (adapter.name === 'fake') continue;
    if (!(await adapter.available())) detected.push(adapter.name);
  }

  // Seed a capped hello task once.
  const views = listTaskViews(root);
  let helloId: string | null = null;
  if (views.length === 0) {
    const hello = createTask(root, {
      title: 'Hello troupe: propose one small improvement',
      body: [
        'Read README.md (if present) and the output of `git ls-files | head -50`.',
        'Propose ONE small, concrete improvement to this repository. Do not make sweeping changes.',
        '',
        'FAKE:write TROUPE_HELLO.md troupe demo: the loop works - replace me with a real task',
      ].join('\n'),
    });
    helloId = hello.id;
  }

  console.log(`initialized ${TROUPE_DIR}/ in ${root}`);
  console.log(`  project:       ${config.project}`);
  console.log(`  default agent: ${config.defaultAgent}${detected.length ? ` (detected: ${detected.join(', ')})` : ' (none detected - demo works offline)'}`);
  console.log(`  AGENTS.md:     ${pin.created ? 'created with troupe pointer' : pin.updated ? 'troupe pointer pinned' : 'already pinned'}${shim.touched ? ' · CLAUDE.md now imports @AGENTS.md' : ''}`);
  if (await indexDirty(root)) {
    console.log(`  note: your index has staged changes - troupe committed nothing.`);
  }
  console.log('');
  console.log('next:');
  if (helloId) console.log(`  troupe run --demo            # offline demo of the full loop (seconds, free)`);
  console.log(`  troupe run                    # run the top task with ${config.defaultAgent}`);
  console.log(`  troupe review                 # see proposals awaiting your decision`);
  console.log(`  troupe board                  # local dashboard`);
  console.log(`  git add ${TROUPE_DIR} AGENTS.md && git commit -m "troupe init"   # share with your team`);
}

function findGitRoot(from: string): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function safeExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return null;
  }
}

async function cmdDoctor(): Promise<void> {
  const checks: Array<[string, boolean | null, string]> = [];
  const gitv = safeExec('git', ['--version']);
  checks.push(['git present', !!gitv, gitv ?? 'install git']);
  const gitOk = gitv ? /(\d+)\.(\d+)/.exec(gitv) : null;
  const worktreeOk = gitOk ? Number(gitOk[1]) > 2 || (Number(gitOk[1]) === 2 && Number(gitOk[2]) >= 5) : false;
  checks.push(['git >= 2.5 (worktrees)', worktreeOk, worktreeOk ? 'ok' : 'upgrade git']);
  const root = findRoot();
  checks.push(['.troupe found', !!root, root ?? 'run `troupe init`']);
  if (root) {
    checks.push(['remote configured', await hasRemote(root), 'claims are provisional without a remote (fine solo)']);
    checks.push(['index clean', !(await indexDirty(root)), 'troupe will refuse to auto-commit while staged changes exist']);
  }
  for (const adapter of listAdapters()) {
    const reason = await adapter.available();
    checks.push([`adapter ${adapter.name}`, !reason, reason ?? 'ok']);
  }
  let red = 0;
  for (const [name, ok, detail] of checks) {
    const mark = ok ? 'ok ' : 'FAIL';
    if (!ok) red++;
    console.log(`  ${mark}  ${name}${ok ? '' : ` - ${detail}`}`);
  }
  process.exit(red > 0 && !checks[2][1] ? 1 : 0);
}

function cmdTaskAdd(positional: string[], flags: Flags): void {
  const root = requireRoot();
  const title = positional.join(' ').trim();
  if (!title) fail('usage: troupe task add "title" [--body "..."] [--agent name] [--priority high|normal|low]');
  const task = createTask(root, {
    title,
    body: typeof flags.body === 'string' ? flags.body : '',
    agent: typeof flags.agent === 'string' ? flags.agent : undefined,
    priority: (typeof flags.priority === 'string' ? flags.priority : 'normal') as 'low' | 'normal' | 'high',
    tags: typeof flags.tag === 'string' ? [flags.tag] : [],
  });
  console.log(`created task ${short(task.id)}: ${task.title}`);
  console.log(`  file: ${TROUPE_DIR}/tasks/${task.id}.md - edit the body freely before running`);
}

function cmdTaskList(flags: Flags): void {
  const root = requireRoot();
  let views = listTaskViews(root);
  if (typeof flags.status === 'string') views = views.filter((v) => v.status === flags.status);
  if (flags.json) {
    console.log(JSON.stringify(views.map((v) => ({
      id: v.task.id, title: v.task.title, status: v.status,
      proposals: v.proposals.length, conflicts: v.conflicts,
    })), null, 2));
    return;
  }
  if (views.length === 0) {
    console.log('no tasks. add one: troupe task add "title"');
    return;
  }
  for (const v of views) console.log(statusLine(v));
  const conflicted = views.filter((v) => v.conflicts.length);
  if (conflicted.length) {
    console.log('');
    console.log('conflicts:');
    for (const v of conflicted) for (const c of v.conflicts) console.log(`  ! ${short(v.task.id)} ${c}`);
  }
}

function cmdTaskShow(positional: string[]): void {
  const root = requireRoot();
  const id = resolveTaskId(root, positional[0] ?? fail('usage: troupe task show <id>'));
  const v = getTaskView(root, id);
  console.log(statusLine(v));
  console.log('');
  console.log(v.task.body || '(no body)');
  for (const p of v.proposals) {
    const contested = v.contestedProposalIds.includes(p.id) ? ' [CONTESTED - claim lost]' : '';
    console.log(`\n--- proposal ${short(p.id)} by ${p.runner} (${p.adapter})${contested} ---`);
    console.log(`${p.summary}`);
    if (p.branch) console.log(`branch: ${p.branch}`);
  }
  for (const c of v.conflicts) console.log(`\n! ${c}`);
}

async function cmdRun(flags: Flags): Promise<void> {
  const root = requireRoot();
  const demo = !!flags.demo;
  const taskId = typeof flags.task === 'string' ? resolveTaskId(root, flags.task) : undefined;
  const result = await runTask(root, {
    taskId,
    agent: demo ? 'fake' : typeof flags.agent === 'string' ? flags.agent : undefined,
    keepWorktree: !!flags['keep-worktree'],
    timeoutMs: typeof flags.timeout === 'string' ? Number(flags.timeout) * 1000 : undefined,
    onProgress: (line) => console.log(`  ${line}`),
  });
  switch (result.outcome) {
    case 'no-task':
      console.log(`nothing to run: ${result.detail}`);
      return;
    case 'claim-lost':
      console.log(`did not run ${short(result.taskId)}: ${result.detail}`);
      return;
    case 'failed':
      fail(`run failed on ${short(result.taskId)}: ${result.error}`);
      break;
    case 'proposed':
      console.log(`proposal ${short(result.proposal.id)} on task ${short(result.taskId)} (claim: ${result.claimMode})`);
      console.log(`  ${result.proposal.summary}`);
      if (result.proposal.branch) console.log(`  branch: ${result.proposal.branch}`);
      console.log(`  next: troupe review`);
  }
}

interface PendingProposal {
  view: TaskView;
  proposalId: string;
}

function pendingProposals(root: string): PendingProposal[] {
  const out: PendingProposal[] = [];
  for (const view of listTaskViews(root)) {
    if (view.status !== 'proposed') continue;
    const decided = new Set(view.decisions.map((d) => d.proposalId));
    for (const p of view.proposals) {
      if (view.contestedProposalIds.includes(p.id)) continue;
      if (!decided.has(p.id)) out.push({ view, proposalId: p.id });
    }
  }
  return out;
}

function cmdReview(flags: Flags): void {
  const root = requireRoot();
  const pending = pendingProposals(root);
  if (flags.json) {
    console.log(JSON.stringify(pending.map(({ view, proposalId }) => {
      const p = view.proposals.find((x) => x.id === proposalId)!;
      return { taskId: view.task.id, title: view.task.title, proposalId, summary: p.summary, branch: p.branch };
    }), null, 2));
    return;
  }
  if (pending.length === 0) {
    console.log('review queue is empty.');
    const conflicted = listTaskViews(root).filter((v) => v.conflicts.length);
    for (const v of conflicted) for (const c of v.conflicts) console.log(`  ! ${short(v.task.id)} ${c}`);
    return;
  }
  console.log(`${pending.length} proposal(s) awaiting decision (you are ${humanIdentity(root)}):\n`);
  for (const { view, proposalId } of pending) {
    const p = view.proposals.find((x) => x.id === proposalId)!;
    console.log(`═══ ${view.task.title} - proposal ${short(p.id)} by ${p.runner} (${p.adapter})`);
    if (p.branch) console.log(`    branch ${p.branch} - inspect: git diff main...${p.branch}`);
    console.log('');
    console.log(p.body.split('\n').map((l) => `    ${l}`).join('\n'));
    console.log('');
    console.log(`    approve: troupe approve ${short(p.id)}     reject: troupe reject ${short(p.id)} --note "why"`);
    console.log('');
  }
}

function resolveProposal(root: string, prefix: string): { taskId: string; proposalId: string } {
  const needle = prefix.toUpperCase();
  const hit = (id: string) => id.startsWith(needle) || id.endsWith(needle);
  const matches: Array<{ taskId: string; proposalId: string }> = [];
  for (const view of listTaskViews(root)) {
    for (const p of view.proposals) {
      if (hit(p.id)) matches.push({ taskId: view.task.id, proposalId: p.id });
    }
    if (hit(view.task.id)) {
      // Allow approving by task id when exactly one undecided proposal exists.
      const decided = new Set(view.decisions.map((d) => d.proposalId));
      const open = view.proposals.filter((p) => !decided.has(p.id) && !view.contestedProposalIds.includes(p.id));
      if (open.length === 1) matches.push({ taskId: view.task.id, proposalId: open[0].id });
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) fail(`no proposal matches "${prefix}"`);
  fail(`ambiguous "${prefix}" (${matches.length} matches) - use a longer prefix from troupe review`);
}

function cmdDecide(verdict: 'approve' | 'reject', positional: string[], flags: Flags): void {
  const root = requireRoot();
  const target = positional[0] ?? fail(`usage: troupe ${verdict} <proposal-id> [--note "..."]`);
  const { taskId, proposalId } = resolveProposal(root, target);
  const view = getTaskView(root, taskId);
  if (view.contestedProposalIds.includes(proposalId)) {
    fail('this proposal is contested (its claim lost the race) and cannot be decided');
  }
  const d = decide(root, {
    taskId, proposalId, verdict,
    note: typeof flags.note === 'string' ? flags.note : undefined,
  });
  console.log(`${verdict}d proposal ${short(proposalId)} on ${short(taskId)} as ${d.decider}`);
  const after = getTaskView(root, taskId);
  console.log(`task status: ${after.status}`);
  const p = after.proposals.find((x) => x.id === proposalId);
  if (verdict === 'approve' && p?.branch) {
    console.log(`land it: git merge ${p.branch}   (or open a PR from that branch)`);
    console.log(`then:    troupe mark ${short(taskId)} done`);
  }
}

function cmdMark(positional: string[]): void {
  const root = requireRoot();
  const id = resolveTaskId(root, positional[0] ?? fail('usage: troupe mark <task-id> done|dropped'));
  const state = positional[1];
  if (state !== 'done' && state !== 'dropped') fail('state must be done or dropped');
  markTask(root, id, state);
  console.log(`marked ${short(id)} ${state}`);
}

async function cmdSync(): Promise<void> {
  const root = requireRoot();
  const remote = await hasRemote(root);
  if (remote) {
    const fetch = await git(root, ['fetch', '-q', 'origin']);
    console.log(fetch.ok ? 'fetched origin' : `fetch failed: ${fetch.stderr}`);
  }
  const res = await commitPaths(root, [TROUPE_DIR, 'AGENTS.md'], 'troupe: sync coordination state');
  if (!res.ok) fail(res.reason ?? 'commit failed');
  console.log('committed .troupe state (exact paths only)');
  if (remote) {
    const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const push = await git(root, ['push', 'origin', branch.stdout]);
    console.log(push.ok ? `pushed ${branch.stdout}` : `push failed: ${push.stderr} - pull/rebase and retry`);
  } else {
    console.log('no remote configured - state is local');
  }
}

function cmdBoard(flags: Flags): void {
  const root = requireRoot();
  const port = typeof flags.port === 'string' ? Number(flags.port) : 4517;
  startBoard(root, port);
  console.log(`troupe board: http://localhost:${port}  (read-only fold of ${TROUPE_DIR}/ - Ctrl-C to stop)`);
}

function cmdInstructions(flags: Flags): void {
  if (flags.sync) {
    const root = requireRoot();
    writeProtocol(root);
    const pin = pinAgentsMd(root);
    console.error(pin.updated || pin.created ? 'AGENTS.md pointer updated' : 'AGENTS.md pointer already current');
  }
  console.log(protocolMarkdown());
}

const HELP = `troupe ${VERSION} - team orchestration for coding agents, in your repo

usage: troupe <command> [args]

  init                       set up .troupe/ in this repo (zero questions)
  doctor                     check git, adapters, auth, repo posture
  task add "title" [--body]  add a task to the queue
  task list [--status s]     list tasks (--json for machines)
  task show <id>             task detail with proposals
  run [--task id] [--demo]   claim + run the top task ( --demo: offline fake agent )
  review [--json]            proposals awaiting your decision
  approve <id> [--note]      approve a proposal (records your git identity)
  reject <id> [--note]       reject a proposal
  mark <id> done|dropped     close a task
  sync                       fetch + commit .troupe state + push (exact paths only)
  board [--port n]           local read-only dashboard
  instructions [--sync]      print the agent protocol (pin into AGENTS.md with --sync)

state lives in .troupe/ as create-only files that merge cleanly; share it with
plain git push/pull. docs: SPEC.md`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, sub, ...rest] = argv;
  const { positional, flags } = parseArgs(cmd === 'task' ? rest : [sub, ...rest].filter((x) => x !== undefined));

  switch (cmd) {
    case 'init': return cmdInit(flags);
    case 'doctor': return cmdDoctor();
    case 'task':
      if (sub === 'add') return cmdTaskAdd(positional, flags);
      if (sub === 'list') return cmdTaskList(flags);
      if (sub === 'show') return cmdTaskShow(positional);
      fail('usage: troupe task add|list|show');
      break;
    case 'run': return cmdRun(flags);
    case 'review': return cmdReview(flags);
    case 'approve': return cmdDecide('approve', positional, flags);
    case 'reject': return cmdDecide('reject', positional, flags);
    case 'mark': return cmdMark(positional);
    case 'sync': return cmdSync();
    case 'board': return cmdBoard(flags);
    case 'instructions': return cmdInstructions(flags);
    case '--version':
    case 'version':
      console.log(VERSION);
      return;
    default:
      console.log(HELP);
      process.exit(cmd && cmd !== '--help' && cmd !== 'help' ? 1 : 0);
  }
}
