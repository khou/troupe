# troupe

Team orchestration for coding agents, in your repo. Tasks, proposals, human
approvals, and a full audit trail — as files in `.troupe/`, synced by git.
No server, no accounts, no new API keys.

Your agents do the work; your team decides what ships; git carries the state.

## Quickstart (5 minutes, works offline)

```bash
cd your-repo
npx troupe@latest init     # zero questions; detects claude/codex on PATH
troupe run --demo          # full loop with the built-in offline agent (free, seconds)
troupe review              # read the proposal it produced
troupe approve <id>        # your git identity is the signature
troupe board               # local dashboard at localhost:4517
```

Then the same loop with a real agent (uses your existing `claude` login):

```bash
troupe task add "Fix the flaky test in auth/" --body "It fails 1 in 5 runs on CI."
troupe run                 # claims the task, runs Claude Code headless in a worktree
troupe review              # proposal + diffstat + receipt (model, cost, duration)
troupe approve <id>        # then: git merge troupe/<task-id>, troupe mark <id> done
```

Teammate #2 needs nothing but the clone:

```bash
git clone <repo> && cd repo
troupe review              # sees every pending proposal immediately
troupe approve <id>        # their approval, their identity, merged by git like code
```

## How it works

- **Everything is a file.** Tasks (`.troupe/tasks/*.md`), claims, proposals,
  decisions, and run receipts are create-only files with ULID names. Status is
  never stored — it's derived by folding the records, so every clone that has
  pulled the same commits computes the same truth, and git merges never
  conflict on troupe state.
- **Agents run in worktrees.** `troupe run` claims a task, creates a worktree
  on branch `troupe/<task-id>`, bootstraps deps (detected from lockfiles),
  runs the agent headlessly, commits the work, and posts a proposal with a
  diffstat and receipt. Your working tree is never touched.
- **Claims use the remote as the lock.** Claiming pushes an atomic
  create-only ref (`refs/heads/troupe/claims/<task-id>`); two machines racing
  the same task resolve at the git host — the loser finds out before burning
  tokens. No remote? Claims are local and clearly labeled provisional.
- **Approvals are pinned to content.** A decision records the SHA-256 of the
  proposal it reviewed; if the proposal changes afterward, the vote is marked
  stale and surfaced — you approved a document, not a filename.
- **Zombies can't ship.** A proposal whose claim lost the race renders as
  contested and can't be approved. Conflicts (double decisions, stale votes)
  are shown, never silently resolved.
- **Agents can't approve.** Decisions belong to humans; the protocol and the
  runner both refuse agent-written approvals.

## Agents

| adapter | status | notes |
|---|---|---|
| `claude-code` | ✅ | headless `claude -p`, JSON output, cost/session in receipts |
| `fake` | ✅ | offline, deterministic; powers the demo and CI |
| `codex` / `gemini` / `aider` | planned | adapter interface is 3 functions; PRs welcome |

Any agent that can run a CLI can also participate with **no adapter at all**:
`troupe instructions` prints the protocol (`.troupe/PROTOCOL.md`), and `init`
pins a 5-line pointer into `AGENTS.md`.

## Security posture (read this)

Task files are prompts that run with the runner's credentials. **Never run
troupe on a schedule in a repo where untrusted people can push.** Approvals
are as trustworthy as your repo's push discipline: identity comes from
`git config`, exactly like commits. See SPEC.md for the hardening roadmap
(state branch, verified identities, quorum, policy tiers).

## Commands

```
troupe init                  set up .troupe/ (zero questions, never touches your index)
troupe doctor                environment + adapter checks with copy-pastable fixes
troupe task add|list|show    manage the queue
troupe run [--task id]       claim + execute one task ( --demo = offline agent )
troupe review [--json]       proposals awaiting your decision
troupe approve|reject <id>   decide (records identity + content hash)
troupe mark <id> done        close out
troupe sync                  fetch, commit .troupe state (exact paths only), push
troupe board [--port n]      read-only local dashboard (+ /api JSON)
troupe instructions          the agent-facing protocol
```

## Why not …

- **Agency** — the inspiration (observe → propose → decide → execute, markdown
  state). Single-user by construction: one `decided_by` string, state on one
  laptop, execution inside the dashboard process. troupe is the team version:
  N humans, state in git, execution on any machine. (Clean-room reimplementation;
  Agency is AGPL and its code is untouched.)
- **GitHub Agentic Workflows** — great inside Actions; requires extension +
  compile + per-engine secrets, and only runs in CI. troupe runs anywhere git
  does, laptops included, and a task can still be drained by CI.
- **claude-squad / Conductor / vibe-kanban** — excellent single-human runner
  UIs with local state. troupe is the layer between *people*: shared queue,
  attributed approvals, audit — and it composes with any of them.

MIT. Built with tests: `npm test` (41 passing, including a two-clone team
e2e and cross-machine claim races against a bare remote).
