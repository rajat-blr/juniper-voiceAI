import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import type { Session } from '../apps/api/src/booking.js';
import { createBookingApi } from '../apps/web/src/api.js';
import { recoverSession } from '../apps/web/src/recovery.js';

async function fixture() {
  const db = await openDatabase();
  let now = DateTime.fromISO('2026-10-12T00:00:00Z');
  const { app } = await buildApp(db, { clock: () => now });
  let token = ''; let expirations = 0; let loseResponse = false;
  const calls: string[] = [];
  const send: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(`${init?.method} ${url}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
    const response = await app.inject({ method: init?.method as 'GET' | 'POST' | 'PATCH', url: url.slice(4),
      headers,
      ...(init?.body === undefined ? {} : { payload: String(init.body) }) });
    if (url === '/api/bookings' && loseResponse) { loseResponse = false; throw new Error('Lost committed response'); }
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const api = createBookingApi(() => token, () => { expirations++; }, { fetch: send });
  const create = async () => { const created = await api<Session & { token: string }>('/sessions', {}); token = created.token; return created; };
  const prepare = async () => {
    const created = await create(); const operationId = randomUUID();
    const state = { intent: 'book' as const, serviceId: 'consultation', visitorName: 'Alex Demo', date: '2026-10-19',
      offeredSlots: ['2026-10-19T09:00:00+05:30'], selectedSlot: '2026-10-19T09:00:00+05:30', confirmed: false };
    const selected = await api<Session>('/session', { version: created.version, state }, 'PATCH');
    await api('/session', { version: selected.version, state: { ...state, confirmed: true, pendingOperationId: operationId } }, 'PATCH');
    return { operationId, serviceId: state.serviceId, visitorName: state.visitorName, slot: state.selectedSlot, confirmed: true };
  };
  return { db, api, create, prepare, calls, expirations: () => expirations,
    advance: () => { now = now.plus({ hours: 25 }); }, loseResponse: () => { loseResponse = true; },
    close: async () => { await app.close(); await db.close(); } };
}

test('expired browser session creates a clean replacement while the original appointment remains booked', async () => {
  const f = await fixture();
  try {
    const write = await f.prepare();
    const booked = await f.api<{ booking: { reference: string } }>('/bookings', write);
    f.advance();
    await assert.rejects(() => f.api('/session'), /session_expired/);
    assert.equal(f.expirations(), 1);
    assert.equal(f.calls.filter((call) => call === 'POST /api/sessions').length, 1);
    const fresh = await f.create();
    assert.deepEqual(fresh.state, {});
    assert.deepEqual((await f.api<Session>('/session')).state, {});
    const original = await f.api<{ booking: { reference: string } }>(`/bookings/${booked.booking.reference}`);
    assert.equal(original.booking.reference, booked.booking.reference);
    await assert.rejects(() => f.api('/bookings', write), /operation_conflict/);
    await assert.rejects(() => f.api('/bookings', { ...write, operationId: randomUUID() }), /confirmation_required/);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 1);
  } finally { await f.close(); }
});

test('lost write response never retries automatically; recovery finds the same committed operation', async () => {
  const f = await fixture();
  try {
    const write = await f.prepare(); f.loseResponse();
    await assert.rejects(() => f.api('/bookings', write), /connection_failed/);
    assert.equal(f.calls.filter((call) => call === 'POST /api/bookings').length, 1);
    const restored = await recoverSession(f.api);
    assert.ok(restored.session.state.booking?.reference);
    assert.equal(restored.session.state.pendingOperationId, write.operationId);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 1);
    assert.equal(f.calls.filter((call) => call === 'POST /api/bookings').length, 1);
  } finally { await f.close(); }
});

test('a delayed expiry response cannot expire a new token', async () => {
  let token = 'old'; let expirations = 0;
  let release!: (response: Response) => void;
  const api = createBookingApi(() => token, () => { expirations++; }, { fetch: () => new Promise((resolve) => { release = resolve; }) });
  const pending = api('/session'); token = 'new';
  release(new Response('{"status":"session_expired"}', { status: 401 }));
  await assert.rejects(() => pending, /session_expired/);
  assert.equal(expirations, 0);
});

test('timeouts abort once and non-JSON failures never expose raw response content', async () => {
  let attempts = 0;
  const api = createBookingApi(() => '', () => {}, { timeoutMs: 10, fetch: async (_input, init) => {
    attempts++;
    return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } });
  await assert.rejects(() => api('/bookings', {}), /^Error: connection_failed$/);
  assert.equal(attempts, 1);
  const nonJson = createBookingApi(() => '', () => {}, { fetch: async () => new Response('private proxy error', { status: 502 }) });
  await assert.rejects(() => nonJson('/session'), /^Error: connection_failed$/);
  const rawStatus = createBookingApi(() => '', () => {}, { fetch: async () => new Response('{"status":"secret=private"}', { status: 500 }) });
  await assert.rejects(() => rawStatus('/session'), /^Error: api_error$/);
});
