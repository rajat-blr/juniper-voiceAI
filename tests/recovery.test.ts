import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import type { Session, State } from '../apps/api/src/booking.js';
import { recoverSession, type BookingApi } from '../apps/web/src/recovery.js';

async function fixture() {
  const db = await openDatabase();
  const { app, service } = await buildApp(db, { clock: () => DateTime.fromISO('2026-10-11T00:00:00Z') });
  const create = async (slot = '2026-10-12T09:00:00+05:30') => {
    const session = await service.createSession();
    const initial: State = { intent: 'book', serviceId: 'consultation', visitorName: 'Alex Demo', date: slot.slice(0,10), offeredSlots: [slot], selectedSlot: slot, confirmed: false };
    let loaded = await service.saveState(session.token, session.version, initial);
    const calls: string[] = [];
    const api: BookingApi = async <T>(path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      calls.push(`${method} ${path}`);
      const response = await app.inject({ method: method as 'GET' | 'POST' | 'PATCH', url: path,
        headers: { authorization: `Bearer ${session.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { payload: JSON.stringify(body) } : {}) });
      if (response.statusCode >= 400) throw new Error(response.json().status);
      return response.json() as T;
    };
    const confirm = async (state = loaded.state) => {
      loaded = await api<Session>('/session');
      const operationId = randomUUID();
      loaded = await api<Session>('/session', { version: loaded.version, state: { ...state, confirmed: true, pendingOperationId: operationId } }, 'PATCH');
      return operationId;
    };
    return { api, calls, confirm, session: loaded };
  };
  return { db, create, close: async () => { await app.close(); await db.close(); } };
}

test('refresh after offer or selection never infers confirmation', async () => {
  const f = await fixture();
  try {
    const a = await f.create();
    const result = await recoverSession(a.api);
    assert.equal(result.recovered, false); assert.equal(result.session.state.confirmed, false);
    assert.equal(a.calls.some((call) => call.startsWith('POST ')), false);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 0);
  } finally { await f.close(); }
});

test('refresh after persisted confirmation retries the same operation and commits once', async () => {
  const f = await fixture();
  try {
    const a = await f.create(); const operationId = await a.confirm();
    const first = await recoverSession(a.api);
    assert.equal(first.recovered, true); assert.equal(first.session.state.confirmed, false);
    assert.equal(first.session.state.pendingOperationId, operationId);
    const reference = first.session.state.booking!.reference;
    const second = await recoverSession(a.api);
    assert.equal(second.session.state.booking!.reference, reference);
    assert.equal(a.calls.filter((call) => call === 'POST /bookings').length, 1);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 1);
  } finally { await f.close(); }
});

test('unknown response loss preserves recovery and never duplicates a committed appointment', async () => {
  const f = await fixture();
  try {
    const a = await f.create(); const operationId = await a.confirm();
    const unavailable: BookingApi = async <T>(path: string, body?: unknown, method?: string) => {
      if (path === '/bookings') throw new Error('connection_failed');
      return a.api<T>(path, body, method);
    };
    await assert.rejects(() => recoverSession(unavailable), /connection_failed/);
    const pending = await a.api<Session>('/session');
    assert.equal(pending.state.confirmed, true); assert.equal(pending.state.pendingOperationId, operationId);
    const lost: BookingApi = async <T>(path: string, body?: unknown, method?: string) => {
      const result = await a.api<T>(path, body, method);
      if (path === '/bookings') throw new Error('connection_failed');
      return result;
    };
    await assert.rejects(() => recoverSession(lost), /connection_failed/);
    const restored = await recoverSession(a.api);
    assert.ok(restored.session.state.booking?.reference);
    assert.equal(restored.session.state.pendingOperationId, operationId);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 1);
  } finally { await f.close(); }
});

test('a committed operation discovered after a stale session read loads fresh state', async () => {
  const f = await fixture();
  try {
    const a = await f.create(); await a.confirm();
    const stale = await a.api<Session>('/session');
    const committed = await recoverSession(a.api);
    let firstRead = true;
    const delayed: BookingApi = async <T>(path: string, body?: unknown, method?: string) => {
      if (path === '/session' && !body && firstRead) { firstRead = false; return stale as T; }
      return a.api<T>(path, body, method);
    };
    const recovered = await recoverSession(delayed);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.session.state.confirmed, false);
    assert.equal(recovered.session.state.booking!.reference, committed.session.state.booking!.reference);
    assert.equal(a.calls.filter((call) => call === 'POST /bookings').length, 1);
  } finally { await f.close(); }
});

test('failed reschedule recovery preserves original and requires a new confirmation', async () => {
  const f = await fixture();
  try {
    const a = await f.create(); await a.confirm();
    const original = (await recoverSession(a.api)).session;
    const target = '2026-10-13T10:00:00+05:30';
    const state: State = { ...original.state, intent: 'reschedule', date: '2026-10-13', selectedSlot: target, offeredSlots: [target], confirmed: false };
    delete state.pendingOperationId;
    await a.api('/session', { version: original.version, state }, 'PATCH');
    await a.confirm(state);
    const b = await f.create(target); await b.confirm(); await recoverSession(b.api);
    const failure = await recoverSession(a.api);
    assert.equal(failure.issue, 'slot_unavailable');
    assert.equal(failure.session.state.booking!.reference, original.state.booking!.reference);
    assert.equal(failure.session.state.booking!.starts_at, original.state.booking!.starts_at);
    assert.equal(failure.session.state.confirmed, false);
    assert.equal(failure.session.state.selectedSlot, undefined);
    assert.equal(failure.session.state.pendingOperationId, undefined);
    assert.equal((await f.db.query('SELECT * FROM appointments')).rows.length, 2);
  } finally { await f.close(); }
});
