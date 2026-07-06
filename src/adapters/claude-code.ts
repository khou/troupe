import { spawn } from 'node:child_process';
import type { AgentConfig } from '../core/types.js';
import type { Adapter, AdapterResult, AdapterRunInput } from './types.js';

/**
 * Drives Claude Code headlessly: `claude -p "<prompt>" --output-format json`
 * in the workspace directory. Permission posture is deliberately conservative:
 * acceptEdits lets the agent edit files in its (worktree) workspace without
 * interactive prompts, while arbitrary Bash stays off unless the user opts in
 * via agents.<name>.allowedTools in .trupe/config.json.
 */

export function buildClaudeArgs(prompt: string, config: AgentConfig): string[] {
  const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits'];
  if (config.model) {
    args.push('--model', config.model);
  }
  if (config.allowedTools && config.allowedTools.length > 0) {
    args.push('--allowedTools', config.allowedTools.join(','));
  }
  if (config.args) args.push(...config.args);
  return args;
}

export function parseClaudeJson(stdout: string): { result?: string; meta: Record<string, unknown> } {
  try {
    const parsed = JSON.parse(stdout);
    const meta: Record<string, unknown> = {};
    for (const k of ['total_cost_usd', 'duration_ms', 'num_turns', 'session_id', 'is_error', 'subtype']) {
      if (parsed[k] !== undefined) meta[k] = parsed[k];
    }
    // Cache economics belong in the receipt: fresh sessions pay cache WRITES
    // for the system/tool prefix; only intra-session (and <5min back-to-back)
    // turns get cache READS. Surfacing the split makes cost diagnosable.
    if (parsed.usage && typeof parsed.usage === 'object') {
      const u = parsed.usage as Record<string, unknown>;
      meta.usage = {
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        cache_read_input_tokens: u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens,
      };
    }
    if (parsed.modelUsage && typeof parsed.modelUsage === 'object') {
      meta.models = Object.keys(parsed.modelUsage as Record<string, unknown>);
    }
    return { result: typeof parsed.result === 'string' ? parsed.result : undefined, meta };
  } catch {
    return { meta: {} };
  }
}

export const claudeCodeAdapter: Adapter = {
  name: 'claude-code',

  async available(): Promise<string | null> {
    return new Promise((resolve) => {
      const child = spawn('claude', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
      child.on('error', () => resolve('`claude` CLI not found on PATH - install Claude Code or use --agent fake'));
      child.on('exit', (code) => resolve(code === 0 ? null : '`claude --version` failed'));
    });
  },

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const command = input.config.command ?? 'claude';
    const args = buildClaudeArgs(input.prompt, input.config);
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: input.workspaceDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, input.timeoutMs);

      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString();
        input.onOutput?.(d.toString());
      });
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        resolve({ ok: false, summary: 'failed to launch claude', output: '', error: String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const { result, meta } = parseClaudeJson(stdout);
        if (code !== 0) {
          resolve({
            ok: false,
            summary: `claude exited ${code}`,
            output: result ?? stdout.slice(-4000),
            error: stderr.slice(-2000) || `exit code ${code}`,
            meta,
          });
          return;
        }
        const output = result ?? stdout;
        resolve({
          ok: meta.is_error !== true,
          summary: firstLine(output) || 'claude run completed',
          output,
          error: meta.is_error === true ? 'claude reported is_error' : undefined,
          meta,
        });
      });
    });
  },
};

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? '').slice(0, 120);
}
