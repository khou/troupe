import * as fs from 'node:fs';
import * as path from 'node:path';
import { TROUPE_DIR } from './store.js';

export const PROTOCOL_VERSION = 1;

const BEGIN = '<!-- troupe:begin -->';
const END = '<!-- troupe:end -->';

/**
 * The agent-facing contract. Generated (never hand-edited) so the text and the
 * validating code ship from the same package and cannot drift. Mutations go
 * through the CLI — one claim mechanism, one code path; files are for reading.
 */
export function protocolMarkdown(): string {
  return `# troupe protocol v${PROTOCOL_VERSION}

This repository coordinates work between humans and coding agents through
files under \`.troupe/\` and the \`troupe\` CLI. Read state from files; make
ALL mutations through the CLI (this keeps one claim mechanism and one audit
path — do not hand-create claim/decision files).

## Read

- Tasks: \`.troupe/tasks/<ulid>.md\` (YAML frontmatter + markdown brief)
- Proposals: \`.troupe/proposals/<taskId>/<ulid>.md\`
- Decisions: \`.troupe/decisions/<taskId>/<ulid>.json\`
- Board: \`troupe task list\` (or \`troupe board\` for humans)

## Act

- See open work:      \`troupe task list --status open\`
- Take a task:        \`troupe run --task <id>\`   (claims, runs you in a worktree, proposes)
- File new work:      \`troupe task add "title" --body "details"\`
- If you cannot run the CLI: do the work on a branch and state clearly in
  your report that the task was NOT claimed — a human will reconcile.

## Rules

- Never modify \`.troupe/\` contents directly; especially never write files
  under \`.troupe/decisions/\` — approvals belong to humans.
- Work only inside the worktree/branch you were given.
- End every run with the report structure you were prompted with
  (Summary / What changed / How to verify / Risks).
`;
}

/**
 * The five-line pointer pinned into AGENTS.md. Deliberately tiny: pinning the
 * whole protocol would tax every unrelated agent session in the repo and
 * invite accidental participation.
 */
export function agentsMdBlock(): string {
  return `${BEGIN}
This repo uses [troupe](https://github.com/khou/troupe) to coordinate agent work
(tasks, proposals, human approvals) via files in \`.troupe/\` and the \`troupe\` CLI.
Only when explicitly asked to work on troupe tasks: run \`troupe instructions\` first
and follow it. Do not create or edit files under \`.troupe/\` by hand.
${END}`;
}

/** Idempotently pin/update the block in AGENTS.md; create the file if absent. */
export function pinAgentsMd(root: string): { created: boolean; updated: boolean } {
  const file = path.join(root, 'AGENTS.md');
  const block = agentsMdBlock();
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, `# Agent instructions\n\n${block}\n`);
    return { created: true, updated: false };
  }
  const raw = fs.readFileSync(file, 'utf8');
  const start = raw.indexOf(BEGIN);
  const end = raw.indexOf(END);
  if (start !== -1 && end !== -1) {
    const next = raw.slice(0, start) + block + raw.slice(end + END.length);
    if (next !== raw) {
      fs.writeFileSync(file, next);
      return { created: false, updated: true };
    }
    return { created: false, updated: false };
  }
  fs.writeFileSync(file, raw.replace(/\n*$/, '\n\n') + block + '\n');
  return { created: false, updated: true };
}

/** Ensure CLAUDE.md imports AGENTS.md (the documented bridge). */
export function shimClaudeMd(root: string): { touched: boolean } {
  const file = path.join(root, 'CLAUDE.md');
  const importLine = '@AGENTS.md';
  if (!fs.existsSync(file)) {
    // Do not create CLAUDE.md if the project doesn't use one; AGENTS.md is the standard.
    return { touched: false };
  }
  const raw = fs.readFileSync(file, 'utf8');
  if (raw.includes(importLine)) return { touched: false };
  fs.writeFileSync(file, raw.replace(/\n*$/, '\n\n') + importLine + '\n');
  return { touched: true };
}

export function writeProtocol(root: string): void {
  fs.writeFileSync(path.join(root, TROUPE_DIR, 'PROTOCOL.md'), protocolMarkdown());
}
