import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenVerifier } from 'livekit-server-sdk';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import { runtimeConfig } from '../apps/api/src/runtime.js';
import { apiPath } from '../api/index.js';

const livekit = { url: 'wss://example.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret-long-enough-for-fixtures' };
const secret = 'shared-secret-with-at-least-thirty-two-bytes';
test('Vercel requires durable storage, disables preview voice, and validates production secrets and caps', () => {
  assert.throws(() => runtimeConfig({ VERCEL: '1' }), /DATABASE_URL/);
  const base = { VERCEL: '1', DATABASE_URL: 'postgresql://test.invalid/demo', VOICE_ENABLED: 'true' };
  assert.equal(runtimeConfig({ ...base, VERCEL_ENV: 'preview' }).voiceEnabled, false);
  assert.throws(() => runtimeConfig({ ...base, VERCEL_ENV: 'production' }), /AGENT_SHARED_SECRET/);
  const production = runtimeConfig({ ...base, VERCEL_ENV: 'production', AGENT_SHARED_SECRET: secret });
  assert.equal(production.voiceEnabled, true);
  assert.deepEqual(production.limits, { daily: 5, monthly: 20, sessionHourly: 5 });
  assert.throws(() => runtimeConfig({ ...base, VERCEL_ENV: 'production', AGENT_SHARED_SECRET: secret, VOICE_DAILY_LIMIT: '0' }), /Invalid/);
});

test('Vercel rewrites preserve API paths and scheduling queries', () => {
  assert.equal(apiPath('/api/availability?serviceId=consultation&date=2026-10-20'), '/availability?serviceId=consultation&date=2026-10-20');
  assert.equal(apiPath('/api/index?__path=voice%2Fredeem'), '/voice/redeem');
  assert.equal(apiPath('/api/index?__path=bookings%2FVA-DEMO%2Freschedule'), '/bookings/VA-DEMO/reschedule');
  assert.equal(apiPath('/api/health?__path=voice/redeem'), '/health');
});

test('handoff survives separate API instances, is encrypted at rest, and redeems exactly once', async () => {
  const db = await openDatabase();
  const a = await buildApp(db, { voice: { secret, livekit } });
  const b = await buildApp(db, { voice: { secret, livekit } });
  try {
    const created = await a.service.createSession();
    const response = await a.app.inject({ method: 'POST', url: '/voice/connect', headers: { authorization: `Bearer ${created.token}` }, payload: {} });
    const credentials = response.json();
    const decoded = await new TokenVerifier(livekit.apiKey, livekit.apiSecret).verify(credentials.participantToken);
    const { ticket } = JSON.parse(decoded.roomConfig!.agents[0].metadata);
    const stored = JSON.stringify((await db.query('SELECT * FROM voice_handoffs')).rows);
    assert.equal(stored.includes(created.token), false); assert.equal(stored.includes(ticket), false);
    const requests = [a.app, b.app].map((app) => app.inject({ method: 'POST', url: '/voice/redeem', headers: { 'x-agent-secret': secret }, payload: { ticket } }));
    const redeemed = await Promise.all(requests);
    assert.deepEqual(redeemed.map((row) => row.statusCode).sort(), [200, 401]);
    assert.equal(redeemed.find((row) => row.statusCode === 200)!.json().token, created.token);
    assert.equal((await db.query('SELECT * FROM voice_handoffs')).rows.length, 0);
  } finally { await a.app.close(); await b.app.close(); await db.close(); }
});

test('persistent voice quota limits concurrent requests across instances without blocking manual booking', async () => {
  const db = await openDatabase();
  const options = { voice: { secret, livekit, limits: { daily: 1, monthly: 2, sessionHourly: 5 } } };
  const a = await buildApp(db, options); const b = await buildApp(db, options);
  try {
    const created = await a.service.createSession();
    const responses = await Promise.all([a.app, b.app].map((app) => app.inject({ method: 'POST', url: '/voice/connect', headers: { authorization: `Bearer ${created.token}` }, payload: {} })));
    assert.deepEqual(responses.map((row) => row.statusCode).sort(), [200, 429]);
    assert.equal(responses.find((row) => row.statusCode === 429)!.json().status, 'voice_demo_limit');
    assert.equal((await db.query('SELECT * FROM voice_requests')).rows.length, 1);
    assert.equal((await db.query('SELECT * FROM voice_handoffs')).rows.length, 1);
    assert.equal((await a.app.inject({ method: 'GET', url: '/services' })).statusCode, 200);
    assert.equal((await b.app.inject({ method: 'GET', url: '/session', headers: { authorization: `Bearer ${created.token}` } })).headers['cache-control'], 'no-store');
  } finally { await a.app.close(); await b.app.close(); await db.close(); }
});
