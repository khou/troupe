import { spawn } from 'node:child_process';
import type { AgentConfig } from '../core/types.js';
import type { Adapter, AdapterResult, AdapterRunInput } from './types.js';

/**
 * Drives Cursor Agent headlessly: `cursor-agent -p --trust --force --output-format json`
 * in the workspace directory. `--trust` skips workspace prompts; `--force` allows
 * shell commands without interactive approval (headless equivalent of acceptEdits).
 */

export function buildCursorArgs(prompt: string, config: AgentConfig, workspaceDir: string): string[] {
  const args = ['-p', '--trust', '--force', '--output-format', 'json', '--workspace', workspaceDir];
  if (config.model) {
    args.push('--model', config.model);
  }
  if (config.args) args.push(...config.args);
  args.push(prompt);
  return args;
}

/** Parse the final JSON line from cursor-agent --output-format json. */
export function parseCursorJson(stdout: string): { result?: string; meta: Record<string, unknown> } {
  const lines = stdout.trim().split('\n').filter(Boolean);
  const last = lines[lines.length - 1] ?? stdout;
  try {
    const parsed = JSON.parse(last);
    const meta: Record<string, unknown> = {};
    for (const k of ['duration_ms', 'duration_api_ms', 'session_id', 'request_id', 'is_error', 'subtype']) {
      if (parsed[k] !== undefined) meta[k] = parsed[k];
    }
    if (parsed.usage && typeof parsed.usage === 'object') {
      const u = parsed.usage as Record<string, unknown>;
      meta.usage = {
        input_tokens: u.inputTokens ?? u.input_tokens,
        output_tokens: u.outputTokens ?? u.output_tokens,
        cache_read_input_tokens: u.cacheReadTokens ?? u.cache_read_input_tokens,
        cache_creation_input_tokens: u.cacheWriteTokens ?? u.cache_creation_input_tokens,
      };
    }
    if (typeof parsed.model === 'string') {
      meta.models = [parsed.model];
    }
    return { result: typeof parsed.result === 'string' ? parsed.result : undefined, meta };
  } catch {
    return { meta: {} };
  }
}

function probeVersion(cmd: string, prefixArgs: string[] = []): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, [...prefixArgs, '--version'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('error', () => resolve(false));
    child.on('exit', (code) => resolve(code === 0));
  });
}

async function resolveCursorLaunch(config: AgentConfig): Promise<{ cmd: string; prefixArgs: string[] }> {
  if (config.command) {
    return { cmd: config.command, prefixArgs: [] };
  }
  if (await probeVersion('cursor-agent')) {
    return { cmd: 'cursor-agent', prefixArgs: [] };
  }
  if (await probeVersion('cursor', ['agent'])) {
    return { cmd: 'cursor', prefixArgs: ['agent'] };
  }
  return { cmd: 'cursor-agent', prefixArgs: [] };
}

export const cursorAdapter: Adapter = {
  name: 'cursor',

  async available(): Promise<string | null> {
    if (await probeVersion('cursor-agent')) return null;
    if (await probeVersion('cursor', ['agent'])) return null;
    return '`cursor-agent` not found on PATH - install via cursor.com/install or use --agent fake';
  },

  async run(input: AdapterRunInput): Promise<AdapterResult> {
    const { cmd, prefixArgs } = await resolveCursorLaunch(input.config);
    const args = [...prefixArgs, ...buildCursorArgs(input.prompt, input.config, input.workspaceDir)];
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
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
        resolve({ ok: false, summary: 'failed to launch cursor-agent', output: '', error: String(err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const { result, meta } = parseCursorJson(stdout);
        if (code !== 0) {
          resolve({
            ok: false,
            summary: `cursor-agent exited ${code}`,
            output: result ?? stdout.slice(-4000),
            error: stderr.slice(-2000) || `exit code ${code}`,
            meta,
          });
          return;
        }
        const output = result ?? stdout;
        resolve({
          ok: meta.is_error !== true,
          summary: firstLine(output) || 'cursor run completed',
          output,
          error: meta.is_error === true ? 'cursor reported is_error' : undefined,
          meta,
        });
      });
    });
  },
};

function firstLine(s: string): string {
  return (s.split('\n').find((l) => l.trim().length > 0) ?? '').slice(0, 120);
}
