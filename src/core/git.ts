import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, stdout: (e.stdout ?? '').trim(), stderr: (e.stderr ?? '').trim() };
  }
}

export async function hasRemote(root: string, remote = 'origin'): Promise<boolean> {
  const res = await git(root, ['remote', 'get-url', remote]);
  return res.ok;
}

/** True when the user's index has staged entries — troupe must not commit then. */
export async function indexDirty(root: string): Promise<boolean> {
  const res = await git(root, ['diff', '--cached', '--name-only']);
  return res.ok && res.stdout.length > 0;
}

/**
 * Commit exactly the given paths (never -A) with troupe's committer identity
 * layered on top of the user's. Refuses when the index already holds staged
 * work — sweeping a user's half-staged changes into a troupe commit is the
 * verified way to lose someone's afternoon.
 */
export async function commitPaths(
  root: string,
  paths: string[],
  message: string,
): Promise<{ ok: boolean; reason?: string }> {
  if (await indexDirty(root)) {
    return { ok: false, reason: 'index has staged changes; commit or unstage them, then run `troupe sync`' };
  }
  const add = await git(root, ['add', '--', ...paths]);
  if (!add.ok) return { ok: false, reason: add.stderr };
  const staged = await git(root, ['diff', '--cached', '--name-only']);
  if (staged.ok && staged.stdout.length === 0) {
    return { ok: true }; // nothing new to commit
  }
  const commit = await git(root, ['commit', '-q', '-m', message, '--', ...paths]);
  if (!commit.ok) return { ok: false, reason: commit.stderr };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Claim refs: the git remote as a lock server
// ---------------------------------------------------------------------------

export function claimRef(taskId: string): string {
  // refs/heads/* namespace: universally writable where custom namespaces are
  // often blocked by enterprise rulesets. Never contains user text.
  return `refs/heads/troupe/claims/${taskId}`;
}

export interface ClaimPushResult {
  mode: 'remote' | 'local';
  won: boolean;
  detail: string;
}

/**
 * Atomically publish a claim: create an empty commit whose message carries the
 * claim record, then push it to the claim ref with --force-with-lease=<ref>:
 * (empty expectation = the ref must not exist on the remote). Exactly one
 * claimant's push can succeed; everyone else is rejected before spending
 * tokens. Falls back to local (provisional) when no remote is configured.
 */
export async function pushClaim(
  root: string,
  taskId: string,
  claimJson: string,
  remote = 'origin',
): Promise<ClaimPushResult> {
  if (!(await hasRemote(root, remote))) {
    return { mode: 'local', won: true, detail: 'no remote configured — claim is provisional to this machine' };
  }
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (!head.ok) return { mode: 'local', won: true, detail: 'no HEAD commit — claim is provisional' };
  const tree = await git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!tree.ok) return { mode: 'local', won: true, detail: 'cannot resolve HEAD tree — claim is provisional' };

  const commit = await git(root, [
    'commit-tree', tree.stdout, '-p', head.stdout, '-m', `troupe-claim\n\n${claimJson}`,
  ]);
  if (!commit.ok) return { mode: 'local', won: true, detail: `commit-tree failed: ${commit.stderr}` };

  const ref = claimRef(taskId);
  const push = await git(root, ['push', remote, `--force-with-lease=${ref}:`, `${commit.stdout}:${ref}`]);
  if (push.ok) {
    return { mode: 'remote', won: true, detail: `claim ref created on ${remote}` };
  }
  const lost = /stale info|rejected|already exists|force-with-lease/i.test(push.stderr + push.stdout);
  if (lost) {
    return { mode: 'remote', won: false, detail: 'another runner holds the claim ref' };
  }
  // Host refused the mechanism itself (rulesets, permissions): degrade loudly.
  return { mode: 'local', won: true, detail: `claim ref push failed (${firstLine(push.stderr)}) — claim is provisional` };
}

/** Release = tombstone commit on the ref (ref deletion is often disabled on hosts). */
export async function releaseClaim(root: string, taskId: string, remote = 'origin'): Promise<void> {
  if (!(await hasRemote(root, remote))) return;
  const ref = claimRef(taskId);
  const remoteSha = await lsRemoteRef(root, ref, remote);
  if (!remoteSha) return;
  const tree = await git(root, ['rev-parse', 'HEAD^{tree}']);
  if (!tree.ok) return;
  const tomb = await git(root, ['commit-tree', tree.stdout, '-p', remoteSha, '-m', 'troupe-claim-released']);
  if (!tomb.ok) return;
  await git(root, ['push', remote, `--force-with-lease=${ref}:${remoteSha}`, `${tomb.stdout}:${ref}`]);
}

export async function lsRemoteRef(root: string, ref: string, remote = 'origin'): Promise<string | null> {
  const res = await git(root, ['ls-remote', remote, ref]);
  if (!res.ok || !res.stdout) return null;
  return res.stdout.split('\t')[0] || null;
}

/** Is the remote claim still live (exists and is not a tombstone)? */
export async function remoteClaimLive(root: string, taskId: string, remote = 'origin'): Promise<boolean | null> {
  if (!(await hasRemote(root, remote))) return null;
  const ref = claimRef(taskId);
  const sha = await lsRemoteRef(root, ref, remote);
  if (!sha) return false;
  // The tip commit may not exist locally (another clone pushed it): fetch the ref.
  let msg = await git(root, ['log', '-1', '--format=%s', sha]);
  if (!msg.ok) {
    const fetched = await git(root, ['fetch', '-q', remote, ref]);
    if (fetched.ok) msg = await git(root, ['log', '-1', '--format=%s', 'FETCH_HEAD']);
  }
  if (!msg.ok) return true; // cannot inspect; fail safe toward "held"
  return msg.stdout !== 'troupe-claim-released';
}

// ---------------------------------------------------------------------------
// Worktrees
// ---------------------------------------------------------------------------

export interface Worktree {
  dir: string;
  branch: string;
}

export async function addWorktree(root: string, dir: string, branch: string): Promise<{ ok: boolean; reason?: string }> {
  const existing = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const args = existing.ok
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', '-b', branch, dir, 'HEAD'];
  const res = await git(root, args);
  return res.ok ? { ok: true } : { ok: false, reason: res.stderr };
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', dir]);
}

/** Commit everything the agent changed inside the worktree (scoped to that tree). */
export async function commitWorktree(dir: string, message: string): Promise<{ committed: boolean; sha?: string }> {
  const status = await git(dir, ['status', '--porcelain']);
  if (!status.ok || status.stdout.length === 0) {
    const sha = await git(dir, ['rev-parse', 'HEAD']);
    return { committed: false, sha: sha.ok ? sha.stdout : undefined };
  }
  await git(dir, ['add', '-A']);
  const commit = await git(dir, ['commit', '-q', '-m', message]);
  if (!commit.ok) return { committed: false };
  const sha = await git(dir, ['rev-parse', 'HEAD']);
  return { committed: true, sha: sha.ok ? sha.stdout : undefined };
}

export async function diffStat(root: string, base: string, branch: string): Promise<string> {
  const res = await git(root, ['diff', '--stat', `${base}...${branch}`]);
  return res.ok ? res.stdout : '';
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? '';
}
