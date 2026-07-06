import { claudeCodeAdapter } from './claude-code.js';
import { fakeAdapter } from './fake.js';
import type { Adapter } from './types.js';

const registry = new Map<string, Adapter>([
  [fakeAdapter.name, fakeAdapter],
  [claudeCodeAdapter.name, claudeCodeAdapter],
]);

export function getAdapter(name: string): Adapter {
  const adapter = registry.get(name);
  if (!adapter) {
    throw new Error(`unknown adapter "${name}" (have: ${[...registry.keys()].join(', ')})`);
  }
  return adapter;
}

export function listAdapters(): Adapter[] {
  return [...registry.values()];
}

export type { Adapter, AdapterResult, AdapterRunInput } from './types.js';
