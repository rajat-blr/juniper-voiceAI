import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { qualityReport, type MetricEvent } from '../apps/api/src/metrics.js';
import { buildDemoRun, demoRunMarkdown } from '../tools/demo-report.js';

const context = JSON.parse(await readFile(new URL('../tools/demo-run.example.json', import.meta.url), 'utf8'));
const events: MetricEvent[] = [
  { stage: 'audible_reply', duration_ms: 3000, result: 'ok', created_at: '2026-10-11T07:00:00Z' },
  { stage: 'booking_api', duration_ms: 80, result: 'ok', created_at: '2026-10-11T07:00:01Z' },
];
const metrics = () => ({ generatedAt: '2026-10-11T07:05:00Z', timezone: 'Asia/Kolkata', ...qualityReport(events) });

test('demo report recomputes targets and distinguishes automated checks from live evidence', () => {
  const snapshot = metrics();
  snapshot.latency[0].assessment = 'within_target';
  snapshot.latency[0].targets = { p50Ms: 9000, p95Ms: 9000 };
  const runContext = structuredClone(context);
  runContext.scenarios.book = { status: 'pass', method: 'automated' };
  const run = buildDemoRun(snapshot, runContext);
  assert.equal(run.metrics.latency[0].assessment, 'estimate_above_target');
  assert.deepEqual(run.metrics.latency[0].targets, { p50Ms: 1200, p95Ms: 2500 });
  assert.equal(run.metrics.latency[1].assessment, 'not_measured');
  assert.ok(run.remaining.missingLiveChecks.includes('book'));
  assert.equal(run.remaining.missingSetup.length, 7);
  assert.ok(demoRunMarkdown(run).includes('tester-reported'));
  runContext.scenarios.book.method = 'live_voice';
  assert.equal(buildDemoRun(snapshot, runContext).remaining.missingLiveChecks.includes('book'), false);
});

test('report rejects malformed measurements and private extra fields without propagating source prose', () => {
  const snapshot = metrics();
  snapshot.limitations = ['secret-token and private transcript'];
  assert.equal(JSON.stringify(buildDemoRun(snapshot, context)).includes('secret-token'), false);
  assert.throws(() => buildDemoRun({ ...snapshot, token: 'secret-token' }, context));
  assert.throws(() => buildDemoRun(snapshot, { ...context, transcript: 'private words' }));
  const inconsistent = metrics();
  inconsistent.stages.audible_reply.samples = 0;
  assert.throws(() => buildDemoRun(inconsistent, context), /Inconsistent/);
  const incomplete = structuredClone(context);
  delete incomplete.scenarios.reschedule;
  assert.throws(() => buildDemoRun(snapshot, incomplete));
  const wrongMethod = structuredClone(context);
  wrongMethod.scenarios.book = { status: 'pass', method: 'not_run' };
  assert.throws(() => buildDemoRun(snapshot, wrongMethod));
});

test('report CLI writes reviewable artifacts and refuses to overwrite a run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceai-demo-report-'));
  try {
    const source = join(directory, 'metrics.json');
    const setup = join(directory, 'context.json');
    const output = join(directory, 'reports');
    await writeFile(source, JSON.stringify(metrics()));
    await writeFile(setup, JSON.stringify(context));
    const args = ['--import', 'tsx', 'tools/demo-report.ts', '--metrics', source, '--context', setup, '--output', output];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const reportPath = join(output, `${context.runId}.json`);
    const original = await readFile(reportPath, 'utf8');
    assert.equal(JSON.parse(original).runId, context.runId);
    assert.ok((await readFile(join(output, `${context.runId}.md`), 'utf8')).includes('Remaining verification'));
    const repeated = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(repeated.status, 1);
    assert.match(repeated.stderr, /Run already exists/);
    assert.equal(await readFile(reportPath, 'utf8'), original);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
