/**
 * trupe's git-native data model.
 *
 * Design rule that everything else follows from: files are CREATE-ONLY
 * wherever two parties could otherwise race. Mutable state (a task's status)
 * is never stored - it is DERIVED by folding create-only records, so any two
 * teammates who have pulled the same commits compute the same truth and git
 * merges never conflict on trupe state:
 *
 *   .trupe/
 *     config.json                     - created by init, edited rarely by humans
 *     tasks/<ulid>.md                 - one file per task, written once by its author
 *     claims/<taskId>/<ulid>.json     - one file per claim attempt (create-only)
 *     proposals/<taskId>/<ulid>.md    - one file per proposal (create-only)
 *     decisions/<taskId>/<ulid>.json  - one file per human decision (create-only)
 *     runs/<taskId>/<ulid>.jsonl      - per-run agent transcript metadata (single writer)
 *
 * Deterministic conflict resolution: where two create-only records compete
 * (two claims, two decisions), the lowest ULID wins - both machines agree
 * without coordinating.
 */

export type TaskStatus =
  | 'open'       // created, unclaimed
  | 'claimed'    // an agent runner holds the winning claim, no proposal yet
  | 'proposed'   // at least one proposal awaiting decision
  | 'approved'   // winning decision approves a proposal; implementation pending/landed
  | 'rejected'   // winning decision rejects all current proposals; task reopens on new proposal
  | 'done'       // author or approver marked complete
  | 'dropped';   // cancelled

export interface Task {
  id: string;
  title: string;
  author: string;         // human identity, from git config
  createdAt: string;      // ISO
  priority: 'low' | 'normal' | 'high';
  tags: string[];
  agent?: string;         // preferred adapter, e.g. "claude-code"
  body: string;           // the brief, markdown
}

export interface Claim {
  id: string;
  taskId: string;
  runner: string;         // "<user>@<host>"
  adapter: string;
  createdAt: string;
}

export interface Proposal {
  id: string;
  taskId: string;
  claimId: string;
  runner: string;
  adapter: string;
  branch?: string;        // branch where implementation lives, if any
  summary: string;        // one-line, for lists
  createdAt: string;
  body: string;           // full proposal markdown: what/why/how/risks/diffstat
}

export interface Decision {
  id: string;
  taskId: string;
  proposalId: string;
  /**
   * SHA-256 of the proposal file content at review time. A decision only
   * counts while the proposal still hashes to this - you approved a document,
   * not a document ID that can change under your vote.
   */
  contentSha: string;
  verdict: 'approve' | 'reject';
  decider: string;        // human identity
  note?: string;
  createdAt: string;
}

/** Task-level terminal marker (done/dropped), create-only like everything else. */
export interface Mark {
  id: string;
  taskId: string;
  state: 'done' | 'dropped';
  actor: string;
  note?: string;
  createdAt: string;
}

export interface RunEvent {
  ts: string;
  kind: 'start' | 'log' | 'error' | 'end';
  data?: unknown;
}

/** A task with everything derivable folded in. */
export interface TaskView {
  task: Task;
  status: TaskStatus;
  claims: Claim[];
  winningClaim?: Claim;
  proposals: Proposal[];
  /** Proposal ids whose claim lost the race: visible, salvageable, never decidable. */
  contestedProposalIds: string[];
  decisions: Decision[];
  winningDecision?: Decision;
  /**
   * Human-readable anomalies the fold refuses to hide: stale votes (content
   * changed under a decision), conflicting verdicts, contested proposals.
   */
  conflicts: string[];
}

export interface TrupeConfig {
  version: 1;
  project: string;
  defaultAgent: string;            // adapter name
  requireApproval: boolean;        // false = auto-approve (solo mode)
  agents: Record<string, AgentConfig>;
}

export interface AgentConfig {
  adapter: string;                 // module key: "claude-code" | "cursor" | "fake" | ...
  command?: string;                // override binary, e.g. "claude"
  model?: string;                  // e.g. "claude-sonnet-5" - the biggest cost lever for small tasks
  args?: string[];                 // extra args
  allowedTools?: string[];         // passed through to the adapter
}
