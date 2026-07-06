import * as http from 'node:http';
import { listTaskViews, readConfig } from '../core/store.js';
import type { TaskView } from '../core/types.js';

/**
 * Read-only local viewer. State is recomputed from files on every request, so
 * the board can never cache a lie; whatever git says right now is what renders.
 * No websockets, no build step, no client JS beyond a refresh timer.
 */
export function startBoard(root: string, port = 4517): http.Server {
  const server = http.createServer((req, res) => {
    try {
      const views = listTaskViews(root);
      if (req.url?.startsWith('/api')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ project: readConfig(root).project, tasks: views }, null, 2));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderHtml(readConfig(root).project, views));
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(String(err));
    }
  });
  server.listen(port);
  return server;
}

const STATUS_ORDER = ['proposed', 'claimed', 'open', 'approved', 'rejected', 'done', 'dropped'] as const;

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderHtml(project: string, views: TaskView[]): string {
  const byStatus = new Map<string, TaskView[]>();
  for (const v of views) {
    const list = byStatus.get(v.status) ?? [];
    list.push(v);
    byStatus.set(v.status, list);
  }
  const conflicts = views.flatMap((v) => v.conflicts.map((c) => ({ task: v.task, text: c })));

  const columns = STATUS_ORDER.filter((s) => byStatus.has(s))
    .map((status) => {
      const cards = (byStatus.get(status) ?? [])
        .map((v) => {
          const short = v.task.id.slice(0, 8).toLowerCase();
          const claim = v.winningClaim ? `<div class="meta">claimed by ${esc(v.winningClaim.runner)} · ${esc(v.winningClaim.adapter)}</div>` : '';
          const proposals = v.proposals.length
            ? `<div class="meta">${v.proposals.length} proposal${v.proposals.length > 1 ? 's' : ''}${v.contestedProposalIds.length ? ` (${v.contestedProposalIds.length} contested)` : ''}</div>`
            : '';
          const decision = v.winningDecision
            ? `<div class="meta">approved by ${esc(v.winningDecision.decider)}</div>`
            : '';
          return `<div class="card"><span class="id">${short}</span> <strong>${esc(v.task.title)}</strong>${claim}${proposals}${decision}</div>`;
        })
        .join('\n');
      return `<section><h2>${status} <span class="count">${byStatus.get(status)?.length}</span></h2>${cards}</section>`;
    })
    .join('\n');

  const conflictBanner = conflicts.length
    ? `<div class="conflicts"><strong>⚠ ${conflicts.length} conflict${conflicts.length > 1 ? 's' : ''}</strong><ul>${conflicts
        .map((c) => `<li><code>${c.task.id.slice(0, 8).toLowerCase()}</code> ${esc(c.text)}</li>`)
        .join('')}</ul></div>`
    : '';

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>troupe - ${esc(project)}</title>
<style>
  :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
  body { margin: 2rem; }
  h1 { font-size: 1.3rem; } h1 small { font-weight: normal; opacity: .6; }
  .conflicts { border: 1px solid #d97706; border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
  .conflicts ul { margin: .5rem 0 0; padding-left: 1.2rem; }
  main { display: flex; gap: 1rem; align-items: flex-start; flex-wrap: wrap; }
  section { flex: 1 1 240px; min-width: 240px; }
  h2 { font-size: .85rem; text-transform: uppercase; letter-spacing: .06em; opacity: .7; }
  .count { opacity: .5; font-weight: normal; }
  .card { border: 1px solid rgba(128,128,128,.35); border-radius: 8px; padding: .6rem .8rem; margin-bottom: .6rem; }
  .id { font-family: ui-monospace, monospace; font-size: .75rem; opacity: .55; }
  .meta { font-size: .78rem; opacity: .7; margin-top: .25rem; }
  footer { margin-top: 2rem; font-size: .78rem; opacity: .55; }
</style>
<h1>troupe <small>· ${esc(project)} · ${views.length} tasks · rendered ${new Date().toLocaleTimeString()}</small></h1>
${conflictBanner}
<main>${columns || '<p>No tasks yet. <code>troupe task add "your first task"</code></p>'}</main>
<footer>Read-only fold of <code>.troupe/</code> - refresh for latest. JSON at <a href="/api">/api</a>.</footer>
<script>setTimeout(() => location.reload(), 15000)</script>
`;
}
