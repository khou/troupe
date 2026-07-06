import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Adapter, AdapterResult, AdapterRunInput } from './types.js';

/**
 * Deterministic no-API adapter. It executes simple directives embedded in the
 * task body, which makes it double as (a) the test harness for the whole
 * pipeline and (b) the zero-key demo path in the quickstart:
 *
 *   FAKE:write <relative-path> <single-line content>
 *   FAKE:append <relative-path> <single-line content>
 *   FAKE:fail <message>
 *
 * A task with no directives still succeeds with a stub report, so
 * `troupe run --agent fake` always demonstrates the full loop.
 */
export const fakeAdapter: Adapter = {
  name: 'fake',

  async available() {
    return null;
  },

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const actions: string[] = [];
    for (const line of input.prompt.split('\n')) {
      const m = line.match(/^FAKE:(write|append|fail)\s+(.*)$/);
      if (!m) continue;
      const kind = m[1];
      if (kind === 'fail') {
        return { ok: false, summary: 'fake adapter failed on purpose', output: '', error: m[2] };
      }
      const sp = m[2].indexOf(' ');
      const rel = sp === -1 ? m[2] : m[2].slice(0, sp);
      const content = sp === -1 ? '' : m[2].slice(sp + 1);
      const target = path.resolve(input.workspaceDir, rel);
      if (!target.startsWith(path.resolve(input.workspaceDir) + path.sep)) {
        return { ok: false, summary: 'path escape blocked', output: '', error: `refusing to touch ${rel}` };
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (kind === 'write') fs.writeFileSync(target, content + '\n');
      else fs.appendFileSync(target, content + '\n');
      actions.push(`${kind} ${rel}`);
      input.onOutput?.(`${kind} ${rel}\n`);
    }
    const summary = actions.length
      ? `fake adapter: ${actions.join(', ')}`
      : 'fake adapter: no directives found, produced report only';
    return {
      ok: true,
      summary,
      output: `## What I did\n\n${actions.length ? actions.map((a) => `- ${a}`).join('\n') : '- read the brief; no FAKE: directives to execute'}\n\n## Notes\n\nThis proposal was produced by the built-in \`fake\` adapter (no API calls).\n`,
      meta: { actions: actions.length },
    };
  },
};
