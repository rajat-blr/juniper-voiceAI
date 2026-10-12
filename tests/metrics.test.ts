import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMetrics, metricsCsv, qualityReport, type MetricEvent } from '../apps/api/src/metrics.js';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import { tokenHash } from '../apps/api/src/booking.js';

const event = (duration_ms: number, result: 'ok' | 'error' = 'ok'): MetricEvent =>
  ({ stage: 'tts', duration_ms, result, created_at: '2026-10-11T07:00:00Z' });

test('latency percentiles exclude failures and handle empty stages and zero durations', () => {
  const summary = summarizeMetrics([event(0, 'error'), event(900), event(100), event(200), event(0)]);
  assert.deepEqual(summary.tts, { samples: 4, errors: 1, latestMs: 900, p50Ms: 100, p95Ms: 900 });
  assert.deepEqual(summary.model, { samples: 0, errors: 0, latestMs: null, p50Ms: null, p95Ms: null });
  assert.equal(summarizeMetrics([event(0)]).tts.p50Ms, 0);
});

test('CSV export retains telemetry and excludes extra sensitive fields', () => {
  const row = { ...event(125), token: 'secret-token', transcript: 'private words', visitor_name: 'Private Name' };
  assert.equal(metricsCsv([row]), 'stage,duration_ms,result,created_at\r\n"tts","125","ok","2026-10-11T07:00:00Z"\r\n');
});

test('quality reports distinguish estimates and missing measurements without exporting private fields', () => {
  const measured: MetricEvent[] = [
    { ...event(1000), stage: 'audible_reply', token: 'secret', transcript: 'private' } as MetricEvent,
    { ...event(400), stage: 'interruption' },
    { ...event(250), stage: 'booking_api' },
    { ...event(0, 'error'), stage: 'booking_api' },
    { ...event(0), stage: 'false_interruption' },
    { ...event(0), stage: 'stt_correction' },
    { ...event(800), stage: 'reconnect' },
  ];
  const report = qualityReport(measured);
  assert.deepEqual(report.latency.map((item) => item.assessment), ['estimate_within_target', 'estimate_above_target', 'within_target']);
  assert.deepEqual(report.observations, { falseInterruptions: 1, sttCorrections: 1, toolErrors: 1, reconnects: 1, reconnectErrors: 0 });
  assert.equal('false_interruption' in report.stages, false);
  assert.equal(JSON.stringify(report).includes('private'), false);
  assert.equal(JSON.stringify(report).includes('secret'), false);
  assert.ok(qualityReport([]).latency.every((item) => item.assessment === 'not_measured' && item.samples === 0));
  assert.equal(qualityReport([{ ...event(301), stage: 'booking_api' }]).latency[2].assessment, 'above_target');
});

test('metrics endpoint isolates sessions, bounds its window, and rejects arbitrary telemetry', async () => {
  const db = await openDatabase();
  const { app, service } = await buildApp(db);
  try {
    const a = await service.createSession(); const b = await service.createSession();
    const headers = { authorization: `Bearer ${a.token}` };
    await db.query("INSERT INTO performance_events (session_hash,stage,duration_ms,result) SELECT $1,'tts',n,'ok' FROM generate_series(1,103) n", [tokenHash(a.token)]);
    assert.equal((await app.inject({ method: 'POST', url: '/metrics', headers, payload: { stage: 'tts', durationMs: 0, result: 'error' } })).statusCode, 201);
    const response = await app.inject({ method: 'GET', url: '/metrics', headers });
    const data = response.json();
    assert.equal(data.windowLimit, 100); assert.equal(data.events.length, 100);
    assert.deepEqual(data.summary.tts, { samples: 99, errors: 1, latestMs: 103, p50Ms: 54, p95Ms: 99 });
    assert.equal(response.body.includes(a.token), false);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${b.token}` } })).json().events, []);
    assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
    for (const payload of [
      { stage: 'tts', durationMs: 1, result: 'ok', transcript: 'private' },
      { stage: 'invented', durationMs: 1, result: 'ok' },
      { stage: 'tts', durationMs: -1, result: 'ok' },
      { stage: 'false_interruption', durationMs: 100, result: 'ok' },
      { stage: 'stt_correction', durationMs: 0, result: 'error' },
    ]) assert.equal((await app.inject({ method: 'POST', url: '/metrics', headers, payload })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/metrics', headers, payload: { stage: 'stt_correction', durationMs: 0, result: 'ok' } })).statusCode, 201);
    const observed = (await app.inject({ method: 'GET', url: '/metrics', headers })).json();
    assert.equal(observed.summary.stt_correction.samples, 1);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: `Bearer ${b.token}` } })).json().events, []);
  } finally { await app.close(); await db.close(); }
});
