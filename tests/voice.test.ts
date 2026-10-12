import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TokenVerifier } from 'livekit-server-sdk';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';

test('voice grants are short-lived and room-scoped; handoff is one-use and authenticated', async () => {
  const db = await openDatabase();
  let now = Date.now();
  const secret = 'local-agent-secret-for-testing';
  const livekit = { url: 'wss://test.livekit.cloud', apiKey: 'test-key', apiSecret: 'test-secret-with-enough-length-for-testing' };
  const { app } = await buildApp(db, { voice: { secret, livekit, clock: () => now } });
  try {
    const session = (await app.inject({ method: 'POST', url: '/sessions', payload: {} })).json();
    const headers = { authorization: `Bearer ${session.token}` };
    assert.equal((await app.inject({ method: 'POST', url: '/voice/connect', payload: {} })).statusCode, 401);
    const response = await app.inject({ method: 'POST', url: '/voice/connect', headers, payload: {} });
    assert.equal(response.headers['cache-control'], 'no-store');
    const credentials = response.json();
    assert.equal(credentials.maxDurationSeconds, 300);
    assert.equal(credentials.serverUrl, livekit.url);
    assert.equal(JSON.stringify(credentials).includes(session.token), false);
    const grant = await new TokenVerifier(livekit.apiKey, livekit.apiSecret).verify(credentials.participantToken);
    assert.equal(grant.video?.room, credentials.roomName);
    assert.equal(grant.video?.roomJoin, true);
    assert.deepEqual(grant.video?.canPublishSources, ['microphone']);
    assert.equal(grant.video?.roomAdmin, undefined);
    assert.equal(grant.roomConfig?.maxParticipants, 2);
    assert.equal(grant.roomConfig?.agents?.[0].agentName, 'voiceai-receptionist');
    const { ticket } = JSON.parse(grant.roomConfig!.agents[0].metadata);
    assert.equal((await app.inject({ method: 'POST', url: '/voice/redeem', payload: { ticket } })).statusCode, 401);
    const redeemed = await app.inject({ method: 'POST', url: '/voice/redeem', headers: { 'x-agent-secret': secret }, payload: { ticket } });
    assert.equal(redeemed.json().token, session.token);
    assert.equal((await app.inject({ method: 'POST', url: '/voice/redeem', headers: { 'x-agent-secret': secret }, payload: { ticket } })).statusCode, 401);
    const second = (await app.inject({ method: 'POST', url: '/voice/connect', headers, payload: {} })).json();
    const decoded = await new TokenVerifier(livekit.apiKey, livekit.apiSecret).verify(second.participantToken);
    const expiredTicket = JSON.parse(decoded.roomConfig!.agents[0].metadata).ticket;
    now += 120_000;
    assert.equal((await app.inject({ method: 'POST', url: '/voice/redeem', headers: { 'x-agent-secret': secret }, payload: { ticket: expiredTicket } })).statusCode, 401);
  } finally { await app.close(); await db.close(); }
});

test('missing LiveKit config fails without issuing credentials', async () => {
  const db = await openDatabase();
  const { app } = await buildApp(db, { voice: { secret: 'test', livekit: { url: '', apiKey: '', apiSecret: '' } } });
  try {
    const session = (await app.inject({ method: 'POST', url: '/sessions', payload: {} })).json();
    const config = (await app.inject({ method: 'GET', url: '/voice/config' })).json();
    assert.equal(config.ready, false);
    assert.deepEqual(config.missing, ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']);
    assert.equal((await app.inject({ method: 'POST', url: '/voice/connect', headers: { authorization: `Bearer ${session.token}` }, payload: {} })).statusCode, 503);
  } finally { await app.close(); await db.close(); }
});
