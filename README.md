# trupe

Team orchestration for coding agents, in your repo. Tasks, proposals, human
approvals, and a full audit trail - as files in `.trupe/`, synced by git.
No server, no accounts, no new API keys.

Your agents do the work; your team decides what ships; git carries the state.

## Install

Node >= 20:

```bash
npm install -g @khou/trupe    # puts `trupe` on your PATH
```

One-off without installing: `npx @khou/trupe@latest init`. The command you type
is always just `trupe`; the package is scoped because npm's typosquat filter
reserves the bare name. GitHub install works too: `npm install -g github:khou/trupe`.

## Quickstart (5 minutes, works offline)

```bash
cd your-repo
trupe init                # zero questions; detects claude/cursor on PATH
trupe run --demo          # full loop with the built-in offline agent (free, seconds)
trupe review              # read the proposal it produced
trupe approve <id>        # your git identity is the signature
trupe board               # local dashboard at localhost:4517
```

Then the same loop with a real agent (uses your existing `claude` or `cursor-agent` login):

```bash
trupe task add "Fix the flaky test in auth/" --body "It fails 1 in 5 runs on CI."
trupe run                 # claims the task, runs the agent headless in a worktree
trupe run --agent cursor  # or pin Cursor explicitly
trupe review              # proposal + diffstat + receipt (model, cost, duration)
trupe approve <id>        # then: git merge trupe/<task-id>, trupe mark <id> done
```

Teammate #2 needs nothing but the clone:

```bash
git clone <repo> && cd repo
trupe review              # sees every pending proposal immediately
trupe approve <id>        # their approval, their identity, merged by git like code
```

## How it works

- **Everything is a file.** Tasks (`.trupe/tasks/*.md`), claims, proposals,
  decisions, and run receipts are create-only files with ULID names. Status is
  never stored - it's derived by folding the records, so every clone that has
  pulled the same commits computes the same truth, and git merges never
  conflict on trupe state.
- **Agents run in worktrees.** `trupe run` claims a task, creates a worktree
  on branch `trupe/<task-id>`, bootstraps deps (detected from lockfiles),
  runs the agent headlessly, commits the work, and posts a proposal with a
  diffstat and receipt. Your working tree is never touched.
- **Claims use the remote as the lock.** Claiming pushes an atomic
  create-only ref (`refs/heads/trupe/claims/<task-id>`); two machines racing
  the same task resolve at the git host - the loser finds out before burning
  tokens. No remote? Claims are local and clearly labeled provisional.
- **Approvals are pinned to content.** A decision records the SHA-256 of the
  proposal it reviewed; if the proposal changes afterward, the vote is marked
  stale and surfaced - you approved a document, not a filename.
- **Zombies can't ship.** A proposal whose claim lost the race renders as
  contested and can't be approved. Conflicts (double decisions, stale votes)
  are shown, never silently resolved.
- **Agents can't approve.** Decisions belong to humans; the protocol and the
  runner both refuse agent-written approvals.

## Agents

| adapter | status | notes |
|---|---|---|
| `claude-code` | ✅ | headless `claude -p`, JSON output, cost/session in receipts |
| `cursor` | ✅ | headless `cursor-agent -p`, JSON output, session/duration in receipts |
| `fake` | ✅ | offline, deterministic; powers the demo and CI |
| `codex` / `gemini` / `aider` | planned | adapter interface is 3 functions; PRs welcome |

Any agent that can run a CLI can also participate with **no adapter at all**:
`trupe instructions` prints the protocol (`.trupe/PROTOCOL.md`), and `init`
pins a 5-line pointer into `AGENTS.md`.

## Cost

Prompt caching is automatic: Claude Code applies it inside every headless run,
and receipts record the cache read/write split so you can see it. What you
control: each run is a fresh session (the first turn pays the cache-write cost
for the system prompt), and the model is your CLI default unless you pin one.
For small tasks, pin a cheaper model per agent in `.trupe/config.json`:

```json
"agents": {
  "claude-code": { "adapter": "claude-code", "model": "claude-sonnet-5" },
  "cursor": { "adapter": "cursor", "model": "composer-2.5" }
}
```

Receipts on every proposal show `total_cost_usd`, turns, and cache usage, so
expensive task shapes are visible instead of surprising.

## Security posture (read this)

Task files are prompts that run with the runner's credentials. **Never run
trupe on a schedule in a repo where untrusted people can push.** Approvals
are as trustworthy as your repo's push discipline: identity comes from
`git config`, exactly like commits. See SPEC.md for the hardening roadmap
(state branch, verified identities, quorum, policy tiers).

## Commands

```
trupe init                  set up .trupe/ (zero questions, never touches your index)
trupe doctor                environment + adapter checks with copy-pastable fixes
trupe task add|list|show    manage the queue
trupe run [--task id]       claim + execute one task ( --demo = offline agent )
trupe review [--json]       proposals awaiting your decision
trupe approve|reject <id>   decide (records identity + content hash)
trupe mark <id> done        close out
trupe sync                  fetch, commit .trupe state (exact paths only), push
trupe board [--port n]      read-only local dashboard (+ /api JSON)
trupe instructions          the agent-facing protocol
```

## Why not …

- **Agency** - the inspiration (observe → propose → decide → execute, markdown
  state). Single-user by construction: one `decided_by` string, state on one
  laptop, execution inside the dashboard process. trupe is the team version:
  N humans, state in git, execution on any machine. (Clean-room reimplementation;
  Agency is AGPL and its code is untouched.)
- **GitHub Agentic Workflows** - great inside Actions; requires extension +
  compile + per-engine secrets, and only runs in CI. trupe runs anywhere git
  does, laptops included, and a task can still be drained by CI.
- **claude-squad / Conductor / vibe-kanban** - excellent single-human runner
  UIs with local state. trupe is the layer between *people*: shared queue,
  attributed approvals, audit - and it composes with any of them.

MIT. Built with tests: `npm test` (45 passing, including a two-clone team
e2e and cross-machine claim races against a bare remote).
