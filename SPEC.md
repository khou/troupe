# trupe - team orchestration for coding agents, in your repo

*Spec v0.1, 2026-07-06. Produced from a 12-agent research/differentiation lab and
a 3-lens adversarial attack pass (30+ verified findings); attack fixes are
threaded through every section. Prior art: [Agency](https://github.com/christag/agency)
(christag, AGPL-3.0) - reimplemented clean-room from concepts only; formats and
ideas credited, no code reused.*

## Thesis

Every zero-infra agent orchestrator today means "a team of agents for one
person" (Agency, claude-squad, Conductor, Sculptor, vibe-kanban, Claude Code
agent teams), and every multi-person product requires a vendor cloud (Cursor
cloud agents, Devin, Terragon†, gh-aw locks to Actions). The open slot is the
**multi-human layer**: several people's agents working one shared queue, with
human decisions, attribution, and audit - coordinated through the git remote
the team already has.

trupe is that layer. It is deliberately **not** a runner UI, a worktree
manager, a session multiplexer, or a CI system; those exist and trupe
composes with them. trupe owns four things:

1. **The queue** - agent-sized tasks, in the repo.
2. **The decision layer** - proposals, human approvals with real identity,
   quorum-capable, batched for humans.
3. **The audit ledger** - which human approved what, which agent/model/prompt
   produced it, at what cost. Receipts as files, reconstructible forever.
4. **The protocol** - a markdown convention any agent that can edit files and
   run a CLI can follow. Convention first, tool second (the AGENTS.md playbook).

† Terragon and Bloop shut down in 2025-2026; their users lost state. A
coordination layer that is only files in git cannot be shut down. Zero-infra is
a survivability argument, not just convenience.

## Design pillars

- **Git-native, truly.** All state is files synced by git. No server, no
  database, no daemon. The dashboard is a local viewer. Anything that can run
  `npx` can participate, including CI and Anthropic's own cloud VMs (repo
  state travels with every clone - no competitor's state does).
- **Merge-proof by construction.** Every record that two parties could race on
  is CREATE-ONLY, one file per record, ULID-named. Mutable status is never
  stored; it is derived by a deterministic fold. Correctness hangs on causal
  references, not wall clocks (see Conflict semantics).
- **The human's attention is the scarce resource.** Reviews are batched, tiered
  by stakes, and land where the human already lives (the PR) whenever a diff
  exists. One human decision moment per change, never two.
- **Integration bar: "your agent can run a CLI."** No SDK, no per-tool config
  format, no compile step. `trupe instructions` prints the whole contract.
- **Trust the diff, not the agent.** Policy is enforced on observed changes
  (glob-match the actual diff) and observed spend (receipts), not on prompt
  text asking nicely.
- **Never prompt, never guess, never touch what isn't ours.** Headless runs
  are spawned so they cannot interactively prompt (a prompt is a hang). trupe
  never stages or commits files it didn't create, and refuses to commit when
  the user's index is dirty.

## Data model

```
.trupe/
  config.json                    # scalars written at init, rarely edited
  PROTOCOL.md                    # the agent-facing contract (generated, versioned)
  people/<slug>.json             # identity registry: name, emails/aliases, capabilities, caps
  tasks/<ulid>.md                # one file per task: frontmatter + markdown brief
  claims/<taskId>/<ulid>.json    # claim attempts (create-only)
  proposals/<taskId>/<ulid>.md   # proposals (create-only; amendments = new ULID superseding)
  decisions/<taskId>/<ulid>.json # human decisions (create-only, content-pinned)
  marks/<taskId>/<ulid>.json     # terminal marks: done/dropped (+ reopen records)
  runs/<taskId>/<runId>.jsonl    # per-run transcript metadata + receipt (single writer)
  .gitignore                     # worktrees/ (local scratch, never shared)
```

Rules that make this safe (each traces to a verified attack):

- **One file per record, one writer per file.** No shared appendable files
  across writers; a run transcript has exactly one writing process. There is
  no `events.jsonl` anywhere, by design.
- **ULIDs name files and order displays; they carry no cross-actor authority.**
  A skewed clock can make a record *sort* early; it cannot *win* by sorting
  early where it matters (below).
- **Reversal is a new record.** `reopen` marks, `withdraw` decisions/claims.
  Nothing is ever edited or deleted; mistakes and corrections are both audit
  trail.
- **Config that teams touch concurrently is one-key-per-file** (`people/`,
  later `config.d/`), so additions never conflict. `config.json` parse errors
  print the path and position, never a stack trace.

### Where state lives (the branch-protection answer)

Real teams protect `main`. Committing votes and claims to code branches is
dead on arrival (rejected pushes) or toxic (merge-queue churn, PR-diff noise,
CODEOWNERS pings). The verified answer, in two stages:

- **v0.1 (MVP, shipped):** records live in `.trupe/` on the current branch;
  `trupe sync` commits exactly the record paths (never `-A`) and pushes.
  Correct for solo use, unprotected repos, and the demo. Claims - the one
  record needing *cross-machine mutual exclusion right now* - do not rely on
  branch state at all (next section).
- **v0.2 (default-on):** all mutable records move to a dedicated orphan branch
  `trupe/state`, written via plumbing (`commit-tree` + `update-ref`, no
  checkout, user's working tree untouched), pushed with fetch-retry. Code
  branches keep only `config.json`, `PROTOCOL.md`, `AGENTS.md` pointer, and
  task specs. Effects: no merge-queue entries, no CI burns, no CODEOWNERS
  pings, no PR noise, clean `git log`, mobile web edits land on an
  unprotected branch, and PR merges never touch record files (GitHub ignores
  merge drivers - verified). `trupe doctor` probes pushability and prints the
  exact ruleset exception if blocked.

### Claims: the remote is the lock server

`trupe claim <task>` performs an atomic compare-and-swap against the git
remote: push a tiny claim commit to `refs/heads/trupe/claims/<taskId>` with
`--force-with-lease=<ref>:` (empty expectation = ref must not exist). Create
wins exactly once per host semantics; the loser's push is rejected before any
tokens burn. Namespace is `refs/heads/*` deliberately - custom ref namespaces
are blocked by many enterprise rulesets (verified attack), branch namespace is
universally writable. Release is a tombstone commit on the same ref (ref
deletion is often disabled). Stale claims are stealable after `expires_at`
via delta-observed elapsed time, not absolute clocks.

- No remote configured → local claim file, printed as **provisional**.
- Fork workflows / locked-down hosts → claims-as-files on the state branch
  with non-FF retry (v0.2), or advisory mode via draft-PR declaration; a claim
  that couldn't be registered marks the run **contested**, never silent.

### Fencing: a lost claim cannot ship results

A proposal is decidable only if its `claimId` is the winning claim at fold
time. A zombie runner (laptop slept through its lease, task stolen) that wakes
and posts renders as **superseded (claim lost)**, its diff salvageable but not
approvable. Runners re-validate their lease after wall-clock gaps and always
immediately before posting a proposal.

### Decisions: content-pinned, causally bound

Two verified attacks die here:

- **Content pinning.** Every decision records the git blob sha of the proposal
  file it reviewed. The fold counts a decision only while the proposal content
  hash matches. Amending a proposal demotes prior votes to
  `stale (content changed)` with a one-key re-approve showing the diff since
  the vote. You cannot approve a docs tweak and have it count for the schema
  migration someone slipped in after.
- **Causal authority.** The first decision per proposal binds *among the
  records citing the same predecessor state*. A record that arrives claiming
  an earlier timestamp after execution referenced a decision does not rewrite
  history: execution pins the decision ids it folded, and a contrary late
  vote opens a **conflict item** ("reject landed after execution began -
  revert?") instead of silently flipping the board.

Conflicts (two decisions on one proposal, contested claims, stale votes,
post-execution reversals) are **first-class fold outputs**, rendered as
banners on `board`/`review`, resolved by explicit human records - never by
whichever ULID happened to sort first across machines.

### Identity: honest, not theatrical

Identity comes from `git config` - the same trust model as the team's
commits, and the spec says so bluntly: *unsigned attribution is exactly as
strong as push access, no stronger.* What trupe adds:

- `people/<slug>.json` registry with alias lists (laptop email, GitHub
  noreply, CI identity) so one human never folds as two actors, and unknown
  emails fold as **unverified** (rendered, flagged, never quorum-satisfying).
- Attribution honesty levels rendered everywhere: **verified** (backfilled
  from a host-authenticated PR review, or a signed vote commit checked at
  fold time) vs **unverified** (plain email). Policy can require verified
  votes for high-stakes tiers.
- **Agents cannot write approvals.** The fold counts decisions only from
  trusted refs (state branch / default branch), never from a running task's
  worktree branch, and a runner refuses any decision that first appears in
  the run it would authorize. Adapter permission rules additionally deny
  writes to `.trupe/decisions/**`. Task provenance gates auto-claim: the
  runner only self-serves tasks authored by registered people on trusted
  refs; foreign tasks need explicit `trupe run --task <id>` which prints the
  full prompt first, defaulting to read-only autonomy. (This is the
  prompt-injection / drive-by-PR RCE answer.)

## The loop

```
task ──claim──▶ run (worktree) ──▶ proposal ──decision──▶ land ──▶ receipt
  ▲                                    │
  └──────────── observations ◀────────┘        every arrow = files in git
```

Kept from Agency (the parts the XDA article praised, formats preserved in
spirit): observe → propose → decide → execute staging; typed questions on
proposals (boolean / choice / free-response) answered at decision time;
role archetypes (Builder edits code, Maintainer/Strategist read-only) as
*capability records in config, role-relative, no hardcoded names or hosts*.

Fixed from Agency (each a documented failure): execution routes by
**capability, never origin-agent** (their read-only agents got dispatched to
implement); execution is any machine running `trupe run`, never a background
task inside a dashboard process (their dashboard-down = nothing executes);
attribution is per-person (theirs is one config string, `'admin'`);
scheduling is CI cron or any teammate's runner, never one laptop's
systemd/launchd timer with baked-in paths; health is probed, not inferred
from log mtimes that stay green while dispatch is dead.

### Review, designed for the lead with 15 pending proposals

- `trupe review`: one batch session. Stakes tiers computed from the diff -
  S (docs/tests, small, in-scope), M (in-scope code), L (**floor, not
  classifier**: lockfiles, CI/workflow files, dependency manifests,
  migrations, deletions, `.trupe/`/`AGENTS.md`/hooks paths, secret-pattern
  matches - always L regardless of line count; verified anti-gaming fix).
  One-keystroke verdicts; typed agent questions answered in the same pass.
  `--approve-all S` exists only behind an explicit policy opt-in, only for
  allowlisted paths, and every batched verdict still writes an individual
  attributed decision file marked `batch: true`.
- **One decision moment per change:** where a diff exists, the *draft PR is
  the proposal* and the PR review is the decision - `trupe sync` backfills
  attributed decision files from `gh pr view --json reviews` (host-verified
  identity, mobile approval via the GitHub app for free, and the teammate who
  never installs trupe reviews agent work exactly like human work). The
  pre-diff review queue is reserved for decision-shaped items: typed
  questions, direction choices, L-tier plans. This is also the answer to
  "the second human never installs it": her first contact is a PR she already
  knows how to review; `trupe join` is the moment she wants agents on her
  own backlog, not an entry fee.

### Budgets and consent

`people/<slug>.json` carries per-person caps (`max_runs_per_day`,
`max_cost_per_day`, task filters); receipts make agent spend per person/task
visible on the board, so "the junior's Max subscription quietly drained by
the lead's backlog" becomes a visible, capped, consented thing. Per-task
budget caps flip tasks to `blocked:over-budget`; refills are attributed
records. Cost enforcement is honest: dollars gate the *next* run
(cost is known post-run); turns and wall-clock stall-kill are the mid-flight
switches.

## Integration (the "critically important" part)

### Getting started: 5 minutes, guaranteed by construction

```
npx trupe@latest init     # zero questions
trupe run --demo          # offline, free, seconds - fake adapter, full loop
trupe review              # approve your first proposal
trupe run                 # same loop, real agent (claude detected + smoke-tested)
```

- `init` asks nothing: doctor-grade preflight (git ≥ 2.5, repo present, every
  failure printed with a copy-pastable fix), PATH probe for
  claude/codex/gemini/aider, optional sub-cent auth smoke call **with stdin
  closed and a 30s hard timeout** against the user's *existing* login - no
  new API keys. Honors proxy/CA env. **Never** stages anything beyond the
  exact files it creates; refuses to auto-commit if the index is dirty
  (verified attack: `git add -A` on a dirty repo sweeps user work/secrets).
- **First success cannot depend on auth or network:** the built-in `fake`
  adapter completes the entire init → run → review → approve loop offline,
  clearly labeled, so the 5-minute promise survives the corp-proxy laptop
  with no `claude` login. Real-agent success is step two, via `trupe doctor`.
- The seeded hello task is capped by construction: prompt scoped to README +
  truncated `git ls-files`, `--max-turns 8`, 90s stall-kill, streamed
  one-line progress ticker, prints actual cost after. (Verified attack: an
  unbounded "map this repo" demo burns 15 minutes and real dollars on a
  monorepo.)
- `trupe join` (teammate #2): in a fresh clone, probes local agent CLIs,
  writes + commits `people/<slug>.json`, prints your inbox and the exact next
  command. Config traveled in the clone; identity is git config; agent auth
  is whatever you already have. No accounts anywhere.

### Agents integrate by reading one file

`trupe init` writes `PROTOCOL.md` (the full agent-facing contract, generated
from the same schema the code validates - they cannot drift) and pins a
**five-line** pointer into `AGENTS.md` between markers (not the whole
protocol - verified attack: a 2k-token pin makes every unrelated agent
session an accidental trupe participant). CLAUDE.md gets the documented
`@AGENTS.md` import; other tools get their native shims. Mutations always go
through the CLI (`npx trupe claim <id>` etc.) so there is exactly one claim
mechanism (verified attack: a files-only protocol path forks mutual
exclusion); the documented no-CLI fallback is "work unclaimed and say so",
which folds as contested by construction.

### Adapters are capability records

```ts
interface Adapter {
  name; capabilities: { stream, resume, structured_output, context_file, autonomy_flags }
  available(): reason | null
  run({ workspaceDir, prompt, config, timeoutMs, onOutput }): AdapterResult
}
```

- claude-code first (headless `-p`, JSON output, session/cost/turns captured
  into receipts). **Every flag explicit, never a CLI default** - Anthropic
  documents `--bare` becoming the `-p` default, which would break implicit
  auth inheritance for everyone the same morning (verified attack). CLI
  version recorded per run; tested-range warnings with the exact remedy.
- `fake` adapter ships in the box: deterministic, offline, executes simple
  directives - it is the CI harness, the demo, and the protocol's honesty
  check at once.
- Two auth profiles: `inherit` (default; runs under the developer's existing
  login, zero new credentials) and `hermetic` (API key **or** the documented
  `claude setup-token` OAuth token - Claude Max teams have no API billing;
  verified attack) for CI.
- One autonomy knob (`read` / `edit` / `full`) mapped per adapter;
  **never-prompt invariant enforced in code**: stdin closed, no TTY,
  non-interactive flags, 120s no-event stall watchdog → kill, record
  `exit_class: stalled`, release claim.
- Workspaces: trupe owns worktree lifecycle (`trupe/<taskId>` branches),
  honors `.worktreeinclude` for gitignored env files, auto-detects and runs
  the bootstrap command from lockfiles (`npm ci` / `pnpm i --frozen-lockfile`
  / `uv sync`) **before** the agent starts, recording its exit in the receipt
  (verified attack: agents flailing in unprovisioned worktrees read as "the
  agent is bad").
- Windows is CI'd from day one with the fake-adapter e2e; adapter spawns use
  `.cmd`-safe resolution; user text never lands in filesystem or ref names -
  ULIDs only. (Agency's origin failure, not repeated.)

### Where trupe deliberately does NOT compete

Worktree/container isolation UIs, in-session multi-agent fan-out, cloud
execution, CI automation - named as composable layers. Interop commitments:
import/export with Claude Code agent-teams hooks when they stabilize; a
trupe task can be what a gh-aw workflow drains; `trupe task import
--from-issue` bridges GitHub Issues (the tracker stays the tracker; `.trupe/
tasks` is the agent-sized execution queue, never a second backlog - verified
adoption attack).

## The board

`trupe board` serves a local read-only view (also `--html` static export).
Because state is a pure fold over committed files, `board --at <ref>` renders
any historical moment and `board --diff @{yesterday}` is standup mode - no
competitor can do this (their state lives in local DBs or SaaS).

Against the "new green dashboard" attack: **states derivable from git are
probed, never recorded** - claim ref existence/expiry, task branch existence,
merged-into-main, last commit age. Drift renders as first-class states
(`stale-claim`, `landed-unrecorded`, `orphaned-task`) with one-key reconcile
via `trupe sync`; the header prints reconciliation freshness. Read commands
attempt a cheap fetch with silent offline fallback and print a staleness line
("47 records behind origin, fetched 3d ago"); acting commands require a fresh
fetch or explicit `--offline`.

## Scheduling

There is deliberately no daemon. The scheduler is: any teammate's
`trupe run --loop 30m`, a crontab line, or `trupe init --ci` writing a
static ~25-line Actions workflow (pinned version - `@latest` in CI is a
supply-chain hole and a registry SPOF, verified attack) that drains the same
claim pool. Scheduler failures are red CI runs, not a silently green
dashboard. This must ship in v0.2 at the latest: "agents on schedules" is the
pitch, and an MVP with no scheduling story reads as a todo-list format
(verified adoption attack).

## Security posture (stated plainly in the README)

- Task files are prompts that run with your credentials: **never run
  `trupe run --loop` on a repo where untrusted people can push.** Provenance
  gating (registered authors, trusted refs) is the enforced floor; L-tier
  floors and print-before-run are the seatbelts.
- Attribution is as strong as your repo's push discipline, upgradeable to
  host-verified (PR reviews) and signed commits per policy tier.
- The audit trail's tamper-evidence is per-writer hash chains + (optionally)
  signed records - never `git log --grep` alone, which squash merges erase.

## Differentiation, in one table

| | Agency | gh-aw | orchestrator wave | **trupe** |
|---|---|---|---|---|
| Humans | 1, hardcoded | repo collaborators | 1 | N, attributed, quorum-capable |
| State | one laptop's disk | Actions logs/PRs | local DB or SaaS | files in every clone |
| Infra | FastAPI + timers | GitHub Actions | app/daemon/cloud | none (git remote) |
| Agent integration | 6 bespoke wrappers | compiled engines | per-tool | 1 protocol file + CLI |
| Getting started | venv + wizard | ext+init+compile+secrets | app install | `npx trupe init`, offline demo |
| Decision execution | in dashboard process | Actions only | n/a | any machine holding capability |
| Audit | log files, `admin` | Actions UI | vendor DB | receipts + decisions in repo |
| Survives vendor death | n/a | no | no (Terragon, Bloop) | yes - it's your repo |

## Milestones

- **v0.1 (today's MVP):** core store + fold with fencing, content-pinned
  decisions, conflict surfacing; ref-CAS claims with local fallback; runner
  (worktrees, bootstrap, receipts); claude-code + fake adapters; CLI (init,
  doctor, task, claim, run, review, approve/reject, mark, sync, board,
  instructions); local board server; PROTOCOL.md/AGENTS.md generation;
  offline demo; unit + e2e tests (incl. bare-remote claim races, dirty-repo
  init safety); README quickstart.
- **v0.2:** state branch default-on; `init --ci`; PR-backfill decisions
  (`trupe sync --prs`); quorum policies; people alias registry; budgets
  enforcement; `trupe gc`; Windows CI lane.
- **v1:** MCP server rail; handoff/resume across machines; `trupe audit`
  reports; issue-tracker bridges; policy diff-contract enforcement;
  drop-in declarative adapters (codex/gemini/aider).

## Kill metrics (pre-registered, honest)

- Init → first approved proposal in under 5 minutes on a cold laptop with no
  agent auth (offline demo path): measured in CI on macOS/Linux/Windows.
- A second machine claiming the same task loses the race 100% of the time
  with a remote configured (e2e against a bare remote).
- A decision recorded against proposal content vN never counts for vN+1
  (e2e).
- If, after teammate #2 exists, >80% of decisions still come from one human
  in month one, the team layer isn't landing - revisit the PR-first review
  flow before adding features.
