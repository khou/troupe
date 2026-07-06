import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs, parseClaudeJson } from '../dist/adapters/claude-code.js';
import { fakeAdapter } from '../dist/adapters/fake.js';
import { getAdapter, listAdapters } from '../dist/adapters/index.js';

let ws: string;

beforeEach(() => {
  ws = fs.mkdtempSync(path.join(os.tmpdir(), 'trupe-ws-'));
});

afterEach(() => {
  fs.rmSync(ws, { recursive: true, force: true });
});

describe('registry', () => {
  it('resolves known adapters and rejects unknown ones', () => {
    expect(getAdapter('fake').name).toBe('fake');
    expect(getAdapter('claude-code').name).toBe('claude-code');
    expect(() => getAdapter('gpt-9')).toThrow(/unknown adapter/);
    expect(listAdapters().map((a) => a.name)).toContain('fake');
  });
});

describe('fake adapter', () => {
  it('executes write and append directives inside the workspace', async () => {
    const result = await fakeAdapter.run({
      workspaceDir: ws,
      prompt: 'Do the thing.\nFAKE:write notes/hello.txt hello world\nFAKE:append notes/hello.txt second line',
      taskId: 'T1',
      config: { adapter: 'fake' },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(ws, 'notes/hello.txt'), 'utf8')).toBe('hello world\nsecond line\n');
    expect(result.summary).toContain('write notes/hello.txt');
  });

  it('fails on demand', async () => {
    const result = await fakeAdapter.run({
      workspaceDir: ws,
      prompt: 'FAKE:fail boom',
      taskId: 'T1',
      config: { adapter: 'fake' },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('boom');
  });

  it('blocks path escapes', async () => {
    const result = await fakeAdapter.run({
      workspaceDir: ws,
      prompt: 'FAKE:write ../outside.txt nope',
      taskId: 'T1',
      config: { adapter: 'fake' },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(ws, '..', 'outside.txt'))).toBe(false);
  });

  it('succeeds with a stub report when there are no directives', async () => {
    const result = await fakeAdapter.run({
      workspaceDir: ws,
      prompt: 'Just a normal brief.',
      taskId: 'T1',
      config: { adapter: 'fake' },
      timeoutMs: 1000,
    });
    expect(result.ok).toBe(true);
    expect(result.output).toContain('no FAKE: directives');
  });
});

describe('claude-code adapter plumbing', () => {
  it('builds conservative headless args', () => {
    const args = buildClaudeArgs('do it', { adapter: 'claude-code' });
    expect(args).toEqual(['-p', 'do it', '--output-format', 'json', '--permission-mode', 'acceptEdits']);
  });

  it('passes model, allowedTools, and extra args through', () => {
    const args = buildClaudeArgs('x', {
      adapter: 'claude-code',
      model: 'claude-sonnet-5',
      allowedTools: ['Edit', 'Bash(git *)'],
      args: ['--verbose'],
    });
    expect(args.join(' ')).toContain('--model claude-sonnet-5');
    expect(args.join(' ')).toContain('--allowedTools Edit,Bash(git *)');
    expect(args.join(' ')).toContain('--verbose');
  });

  it('parses claude JSON output and extracts audit meta including cache usage', () => {
    const { result, meta } = parseClaudeJson(
      JSON.stringify({
        result: 'Did the task.', total_cost_usd: 0.12, num_turns: 4, is_error: false,
        usage: { input_tokens: 900, output_tokens: 200, cache_read_input_tokens: 14000, cache_creation_input_tokens: 3000 },
        modelUsage: { 'claude-sonnet-5': {} },
      }),
    );
    expect(result).toBe('Did the task.');
    expect(meta.total_cost_usd).toBe(0.12);
    expect(meta.num_turns).toBe(4);
    expect((meta.usage as Record<string, number>).cache_read_input_tokens).toBe(14000);
    expect(meta.models).toEqual(['claude-sonnet-5']);
  });

  it('tolerates non-JSON output', () => {
    const { result, meta } = parseClaudeJson('plain text');
    expect(result).toBeUndefined();
    expect(meta).toEqual({});
  });
});
