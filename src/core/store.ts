import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseDoc, serializeDoc, type Frontmatter } from './frontmatter.js';
import { ulid, ulidTime } from './id.js';

/**
 * A claim only holds a task in `claimed` for this long. A crashed or wedged
 * runner therefore releases its task by doing nothing — no lock server, no
 * cleanup step, and every machine computes the same expiry from the claim's
 * own ULID timestamp.
 */
export const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
import type {
  Claim,
  Decision,
  Mark,
  Proposal,
  RunEvent,
  Task,
  TaskStatus,
  TaskView,
  TroupeConfig,
} from './types.js';

export const TROUPE_DIR = '.troupe';

/** Walk up from cwd to find the directory containing .troupe (like git). */
export function findRoot(from: string = process.cwd()): string | null {
  let dir = path.resolve(from);
  for (;;) {
    if (fs.existsSync(path.join(dir, TROUPE_DIR, 'config.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireRoot(from?: string): string {
  const root = findRoot(from);
  if (!root) {
    throw new Error(`no ${TROUPE_DIR}/ found here or above — run \`troupe init\` first`);
  }
  return root;
}

function troupePath(root: string, ...segments: string[]): string {
  return path.join(root, TROUPE_DIR, ...segments);
}

/** Human identity from git config; falls back to OS user. */
export function humanIdentity(root: string): string {
  try {
    const name = execFileSync('git', ['config', 'user.name'], { cwd: root }).toString().trim();
    const email = execFileSync('git', ['config', 'user.email'], { cwd: root }).toString().trim();
    if (name) return email ? `${name} <${email}>` : name;
  } catch {
    // not a git repo or no config — fall through
  }
  return os.userInfo().username;
}

/** Runner identity: which machine/process claims and runs tasks. */
export function runnerIdentity(): string {
  return `${os.userInfo().username}@${os.hostname()}`;
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitOptions {
  project?: string;
  defaultAgent?: string;
  requireApproval?: boolean;
}

export function initTroupe(root: string, opts: InitOptions = {}): TroupeConfig {
  const dir = troupePath(root);
  if (fs.existsSync(path.join(dir, 'config.json'))) {
    return readConfig(root);
  }
  const config: TroupeConfig = {
    version: 1,
    project: opts.project ?? path.basename(path.resolve(root)),
    defaultAgent: opts.defaultAgent ?? 'claude-code',
    requireApproval: opts.requireApproval ?? true,
    agents: {
      'claude-code': { adapter: 'claude-code' },
      fake: { adapter: 'fake' },
    },
  };
  for (const sub of ['tasks', 'claims', 'proposals', 'decisions', 'marks', 'runs']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2) + '\n');
  // Worktrees are scratch space on the local machine, never shared state.
  fs.writeFileSync(path.join(dir, '.gitignore'), 'worktrees/\n');
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# .troupe\n\nGit-native state for [troupe](https://github.com/tokonoma-ai/troupe): tasks, claims, proposals,\ndecisions, and run logs, all as create-only files that merge cleanly.\nCommit this directory like code. Do not hand-edit files under claims/,\ndecisions/, or marks/ — use the `troupe` CLI.\n',
  );
  return config;
}

export function readConfig(root: string): TroupeConfig {
  const raw = fs.readFileSync(troupePath(root, 'config.json'), 'utf8');
  return JSON.parse(raw) as TroupeConfig;
}

// ---------------------------------------------------------------------------
// tasks
// ---------------------------------------------------------------------------

export interface CreateTaskInput {
  title: string;
  body?: string;
  priority?: Task['priority'];
  tags?: string[];
  agent?: string;
  author?: string;
}

export function createTask(root: string, input: CreateTaskInput): Task {
  const task: Task = {
    id: ulid(),
    title: input.title,
    author: input.author ?? humanIdentity(root),
    createdAt: new Date().toISOString(),
    priority: input.priority ?? 'normal',
    tags: input.tags ?? [],
    agent: input.agent,
    body: input.body ?? '',
  };
  const data: Frontmatter = {
    id: task.id,
    title: task.title,
    author: task.author,
    createdAt: task.createdAt,
    priority: task.priority,
    tags: task.tags,
  };
  if (task.agent) data.agent = task.agent;
  fs.writeFileSync(troupePath(root, 'tasks', `${task.id}.md`), serializeDoc(data, task.body));
  return task;
}

export function readTask(root: string, taskId: string): Task {
  const raw = fs.readFileSync(troupePath(root, 'tasks', `${taskId}.md`), 'utf8');
  const { data, body } = parseDoc(raw);
  return {
    id: String(data.id ?? taskId),
    title: String(data.title ?? '(untitled)'),
    author: String(data.author ?? 'unknown'),
    createdAt: String(data.createdAt ?? ''),
    priority: (data.priority as Task['priority']) ?? 'normal',
    tags: Array.isArray(data.tags) ? data.tags : [],
    agent: data.agent ? String(data.agent) : undefined,
    body,
  };
}

export function listTaskIds(root: string): string[] {
  const dir = troupePath(root, 'tasks');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/**
 * Resolve a task id by prefix or suffix. Suffix matters: ULIDs minted in the
 * same millisecond share their leading time chars, so the short form shown to
 * humans is the entropy TAIL, which is what actually distinguishes records.
 */
export function resolveTaskId(root: string, idFragment: string): string {
  const needle = idFragment.toUpperCase();
  const ids = listTaskIds(root);
  const exact = ids.find((id) => id === needle);
  if (exact) return exact;
  const matches = ids.filter((id) => id.startsWith(needle) || id.endsWith(needle));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`no task matches "${idFragment}"`);
  throw new Error(`ambiguous task id "${idFragment}" (${matches.length} matches)`);
}

// ---------------------------------------------------------------------------
// create-only records: claims, proposals, decisions, marks
// ---------------------------------------------------------------------------

function readJsonRecords<T>(dir: string): T[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort() // ULID filenames: lexicographic = chronological, and the tiebreak
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T);
}

export function claimTask(root: string, taskId: string, runner: string, adapter: string): Claim {
  const claim: Claim = { id: ulid(), taskId, runner, adapter, createdAt: new Date().toISOString() };
  const dir = troupePath(root, 'claims', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${claim.id}.json`), JSON.stringify(claim, null, 2) + '\n');
  return claim;
}

export function listClaims(root: string, taskId: string): Claim[] {
  return readJsonRecords<Claim>(troupePath(root, 'claims', taskId));
}

export interface CreateProposalInput {
  taskId: string;
  claimId: string;
  runner: string;
  adapter: string;
  summary: string;
  body: string;
  branch?: string;
}

export function addProposal(root: string, input: CreateProposalInput): Proposal {
  const proposal: Proposal = { id: ulid(), createdAt: new Date().toISOString(), ...input };
  const dir = troupePath(root, 'proposals', input.taskId);
  fs.mkdirSync(dir, { recursive: true });
  const data: Frontmatter = {
    id: proposal.id,
    taskId: proposal.taskId,
    claimId: proposal.claimId,
    runner: proposal.runner,
    adapter: proposal.adapter,
    summary: proposal.summary,
    createdAt: proposal.createdAt,
  };
  if (proposal.branch) data.branch = proposal.branch;
  fs.writeFileSync(path.join(dir, `${proposal.id}.md`), serializeDoc(data, proposal.body));
  return proposal;
}

export function listProposals(root: string, taskId: string): Proposal[] {
  const dir = troupePath(root, 'proposals', taskId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const { data, body } = parseDoc(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        id: String(data.id ?? f.replace(/\.md$/, '')),
        taskId: String(data.taskId ?? taskId),
        claimId: String(data.claimId ?? ''),
        runner: String(data.runner ?? 'unknown'),
        adapter: String(data.adapter ?? 'unknown'),
        summary: String(data.summary ?? ''),
        createdAt: String(data.createdAt ?? ''),
        branch: data.branch ? String(data.branch) : undefined,
        body,
      } satisfies Proposal;
    });
}

export interface DecideInput {
  taskId: string;
  proposalId: string;
  verdict: Decision['verdict'];
  decider?: string;
  note?: string;
}

export function proposalContentSha(root: string, taskId: string, proposalId: string): string {
  const raw = fs.readFileSync(troupePath(root, 'proposals', taskId, `${proposalId}.md`));
  return createHash('sha256').update(raw).digest('hex');
}

export function decide(root: string, input: DecideInput): Decision {
  const decision: Decision = {
    id: ulid(),
    taskId: input.taskId,
    proposalId: input.proposalId,
    contentSha: proposalContentSha(root, input.taskId, input.proposalId),
    verdict: input.verdict,
    decider: input.decider ?? humanIdentity(root),
    note: input.note,
    createdAt: new Date().toISOString(),
  };
  const dir = troupePath(root, 'decisions', input.taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${decision.id}.json`), JSON.stringify(decision, null, 2) + '\n');
  return decision;
}

export function listDecisions(root: string, taskId: string): Decision[] {
  return readJsonRecords<Decision>(troupePath(root, 'decisions', taskId));
}

export function markTask(root: string, taskId: string, state: Mark['state'], note?: string): Mark {
  const mark: Mark = {
    id: ulid(),
    taskId,
    state,
    actor: humanIdentity(root),
    note,
    createdAt: new Date().toISOString(),
  };
  const dir = troupePath(root, 'marks', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${mark.id}.json`), JSON.stringify(mark, null, 2) + '\n');
  return mark;
}

export function listMarks(root: string, taskId: string): Mark[] {
  return readJsonRecords<Mark>(troupePath(root, 'marks', taskId));
}

// ---------------------------------------------------------------------------
// run logs (single writer per run file)
// ---------------------------------------------------------------------------

export function appendRunEvent(root: string, taskId: string, runId: string, event: RunEvent): void {
  const dir = troupePath(root, 'runs', taskId);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${runId}.jsonl`), JSON.stringify(event) + '\n');
}

export function readRunEvents(root: string, taskId: string, runId: string): RunEvent[] {
  const file = troupePath(root, 'runs', taskId, `${runId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as RunEvent);
}

export function listRunIds(root: string, taskId: string): string[] {
  const dir = troupePath(root, 'runs', taskId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => f.replace(/\.jsonl$/, ''))
    .sort();
}

// ---------------------------------------------------------------------------
// folding: derived status
// ---------------------------------------------------------------------------

/**
 * Deterministic fold of create-only records into a task's current state.
 * Anyone with the same files computes the same view; ULID order breaks races.
 */
export function getTaskView(root: string, taskId: string): TaskView {
  const task = readTask(root, taskId);
  const claims = listClaims(root, taskId);
  const proposals = listProposals(root, taskId);
  const decisions = listDecisions(root, taskId);
  const marks = listMarks(root, taskId);
  const conflicts: string[] = [];

  const freshClaims = claims.filter((c) => Date.now() - ulidTime(c.id) < CLAIM_TTL_MS);
  const winningClaim = freshClaims[0] ?? claims[0]; // lowest ULID wins; stale ones only matter for attribution

  // FENCING: a proposal from a losing claim is visible but never decidable —
  // the zombie-runner result cannot ship (it may still be salvaged by a human).
  const contestedProposalIds = proposals
    .filter((p) => p.claimId && winningClaim && p.claimId !== winningClaim.id
      && claims.some((c) => c.id === p.claimId))
    .map((p) => p.id);
  for (const id of contestedProposalIds) {
    conflicts.push(`proposal ${id} is contested: its claim lost the race`);
  }
  const decidable = proposals.filter((p) => !contestedProposalIds.includes(p.id));

  // CONTENT PINNING: a decision binds only while the proposal still hashes to
  // what the decider actually reviewed. Among valid decisions, the earliest
  // per proposal is binding; later conflicting verdicts surface as conflicts.
  const currentSha = new Map<string, string>(
    proposals.map((p) => [p.id, proposalContentSha(root, taskId, p.id)]),
  );
  const bindingByProposal = new Map<string, Decision>();
  for (const d of decisions) {
    if (d.contentSha && d.contentSha !== currentSha.get(d.proposalId)) {
      conflicts.push(`stale vote: ${d.decider} ${d.verdict}d proposal ${d.proposalId} before its content changed`);
      continue;
    }
    const existing = bindingByProposal.get(d.proposalId);
    if (!existing) {
      bindingByProposal.set(d.proposalId, d);
    } else if (existing.verdict !== d.verdict) {
      conflicts.push(
        `conflicting decisions on proposal ${d.proposalId}: ${existing.decider} ${existing.verdict} (binding) vs ${d.decider} ${d.verdict}`,
      );
    }
  }

  const approvals = decidable
    .map((p) => bindingByProposal.get(p.id))
    .filter((d): d is Decision => !!d && d.verdict === 'approve');
  const winningDecision = approvals[0];

  let status: TaskStatus;
  const terminalMark = marks[0];
  if (terminalMark) {
    status = terminalMark.state;
  } else if (winningDecision) {
    status = 'approved';
  } else if (decidable.length > 0) {
    const allRejected = decidable.every((p) => bindingByProposal.get(p.id)?.verdict === 'reject');
    status = allRejected ? 'rejected' : 'proposed';
  } else if (freshClaims.length > 0) {
    status = 'claimed';
  } else {
    status = 'open'; // stale claims release the task automatically
  }

  return {
    task, status, claims, winningClaim, proposals, contestedProposalIds,
    decisions, winningDecision, conflicts,
  };
}

export function listTaskViews(root: string): TaskView[] {
  return listTaskIds(root).map((id) => getTaskView(root, id));
}
