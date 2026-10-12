import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { openDatabase, type Database } from '../apps/api/src/db.js';
import { BookingService, type State } from '../apps/api/src/booking.js';
import { buildApp } from '../apps/api/src/app.js';

let db: Database;
let service: BookingService;
const clock = () => DateTime.fromISO('2026-10-11T00:00:00Z');
before(async () => { db = await openDatabase(); service = new BookingService(db, 'Asia/Kolkata', 24, clock); });
after(async () => db.close());
async function prepared(slot: string, fields: Partial<State> = {}) {
  const session = await service.createSession();
  const state: State = { intent: 'book', serviceId: 'consultation', visitorName: 'Alex Demo',
    selectedSlot: slot, offeredSlots: [slot], ...fields, confirmed: false };
  const saved = await service.saveState(session.token, 0, state);
  const operationId = randomUUID();
  await service.saveState(session.token, saved.version, { ...state, confirmed: true, pendingOperationId: operationId });
  return { token: session.token, request: { operationId, slot, serviceId: state.serviceId!, visitorName: state.visitorName!, confirmed: true as const } };
}

test('availability honors weekdays, duration, hours, and UTC offsets', async () => {
  assert.deepEqual(await service.slots('consultation', '2026-10-11'), []);
  const short = await service.slots('consultation', '2026-10-12');
  const long = await service.slots('extended-care', '2026-10-12');
  assert.equal(short.length, 16); assert.equal(long.length, 15);
  assert.equal(short[0].start, '2026-10-12T09:00:00.000+05:30');
  assert.equal(long.at(-1)?.end, '2026-10-12T17:00:00.000+05:30');
  await assert.rejects(() => service.slots('consultation', '2026-02-30'), /invalid_date/);
});
test('timezone follows daylight-saving changes', async () => {
  const ny = new BookingService(db, 'America/New_York', 24, clock);
  assert.match((await ny.slots('consultation', '2026-10-30'))[0].start, /-04:00$/);
  assert.match((await ny.slots('consultation', '2026-11-02'))[0].start, /-05:00$/);
});
test('two concurrent requests for one slot produce exactly one appointment', async () => {
  const slot = '2026-10-13T09:00:00+05:30';
  const a = await prepared(slot); const b = await prepared(slot);
  const results = await Promise.allSettled([service.write(a.token, a.request), service.write(b.token, b.request)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejected.reason.status, 'slot_unavailable');
  const rows = await db.query('SELECT reference FROM appointments WHERE starts_at=$1', [slot]);
  assert.equal(rows.rows.length, 1);
});
test('concurrent retries and a lost response return one committed reference', async () => {
  const a = await prepared('2026-10-14T10:00:00+05:30');
  const [first, retry] = await Promise.all([service.write(a.token, a.request), service.write(a.token, a.request)]);
  assert.equal(first.status, 'committed'); assert.equal(retry.status, 'already_committed');
  assert.equal(first.booking.reference, retry.booking.reference);
  const resumed = await service.session(a.token);
  assert.equal(resumed.state.booking?.reference, first.booking.reference);
  assert.equal(resumed.state.confirmed, false);
  assert.equal((await service.operation(a.token, a.request.operationId) as { booking: { reference: string } }).booking.reference, first.booking.reference);
  await assert.rejects(() => service.write(a.token, { ...a.request, slot: '2026-10-14T11:00:00+05:30' }), /operation_conflict/);
});
test('writes require final confirmation of the exact selected details', async () => {
  const session = await service.createSession();
  await assert.rejects(() => service.write(session.token, { operationId: randomUUID(), serviceId: 'consultation', visitorName: 'Alex', slot: '2026-10-15T09:00:00+05:30', confirmed: true }), /confirmation_required/);
  const a = await prepared('2026-10-15T10:00:00+05:30');
  await assert.rejects(() => service.write(a.token, { ...a.request, slot: '2026-10-15T11:00:00+05:30' }), /confirmation_required/);
  const loaded = await service.session(a.token);
  await assert.rejects(() => service.saveState(a.token, loaded.version, { ...loaded.state, visitorName: 'Changed' }), /confirmation_details_changed/);
});
test('failed reschedule preserves old appointment; success keeps reference', async () => {
  const original = await prepared('2026-10-16T09:00:00+05:30');
  const old = (await service.write(original.token, original.request)).booking;
  const other = await prepared('2026-10-16T11:00:00+05:30', { serviceId: 'extended-care' });
  await service.write(other.token, other.request);
  const bad = await prepared('2026-10-16T11:30:00+05:30', { intent: 'reschedule', reference: old.reference });
  const { serviceId: _s, visitorName: _n, ...badRequest } = bad.request;
  await assert.rejects(() => service.write(bad.token, badRequest, old.reference), /slot_unavailable/);
  assert.equal(new Date((await service.lookup(old.reference)).starts_at).toISOString(), new Date(old.starts_at).toISOString());
  const good = await prepared('2026-10-16T14:00:00+05:30', { intent: 'reschedule', reference: old.reference });
  const { serviceId: _gs, visitorName: _gn, ...goodRequest } = good.request;
  const result = await service.write(good.token, goodRequest, old.reference);
  assert.equal(result.booking.reference, old.reference);
  assert.equal(new Date(result.booking.starts_at).toISOString(), '2026-10-16T08:30:00.000Z');
  assert.equal((await service.write(good.token, goodRequest, old.reference)).status, 'already_committed');
});
test('invalid slot alignment and closing-time overflow cannot commit', async () => {
  for (const slot of ['2026-10-19T08:30:00+05:30', '2026-10-19T09:15:00+05:30', '2026-10-19T16:30:00+05:30']) {
    const a = await prepared(slot, { serviceId: 'extended-care' });
    await assert.rejects(() => service.write(a.token, a.request), /invalid_time/);
  }
});
test('database constraint blocks overlapping inserts outside API', async () => {
  await assert.rejects(() => db.query(`INSERT INTO appointments (reference, service_id, visitor_name, starts_at, ends_at, timezone)
    VALUES ('BYPASS', 'consultation', 'Demo', '2026-10-14T04:45:00Z', '2026-10-14T05:15:00Z', 'Asia/Kolkata')`),
    (error: unknown) => (error as { code: string }).code === '23P01');
});
test('session tokens are hashed, stale updates fail, expiry is enforced', async () => {
  const a = await service.createSession();
  const state = { intent: 'book' as const, serviceId: 'consultation', date: '2026-10-20' };
  await service.saveState(a.token, 0, state);
  await assert.rejects(() => service.saveState(a.token, 0, {}), /version_conflict/);
  assert.deepEqual((await service.session(a.token)).state, state);
  assert.equal((await db.query('SELECT token_hash FROM sessions WHERE token_hash=$1', [a.token])).rows.length, 0);
  const expired = new BookingService(db, 'Asia/Kolkata', 24, () => clock().plus({ hours: 24 }));
  await assert.rejects(() => expired.session(a.token), /session_expired/);
});
test('HTTP contract validates requests, requires bearer token, and restores checkpoints', async () => {
  const { app } = await buildApp(db, { clock });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/session' })).statusCode, 401);
    const created = (await app.inject({ method: 'POST', url: '/sessions', payload: {} })).json();
    const headers = { authorization: `Bearer ${created.token}` };
    const state = { intent: 'book', serviceId: 'consultation', date: '2026-10-21', offeredSlots: ['2026-10-21T09:00:00+05:30'] };
    assert.equal((await app.inject({ method: 'PATCH', url: '/session', headers, payload: { version: 0, state } })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/session', headers })).json().state, state);
    assert.equal((await app.inject({ method: 'PATCH', url: '/session', headers, payload: { version: 0, state } })).statusCode, 409);
    assert.equal((await app.inject({ method: 'POST', url: '/bookings', headers, payload: { operationId: randomUUID(), slot: '2026-10-21T09:00:00', confirmed: true } })).statusCode, 400);
    assert.equal((await app.inject({ method: 'POST', url: '/bookings', headers, payload: { operationId: randomUUID(), serviceId: 'consultation', visitorName: 'Demo', slot: '2026-10-21T09:00:00+05:30', confirmed: false } })).statusCode, 400);
  } finally { await app.close(); }
});
test('disk restart restores offered state and committed operation result', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'voiceai-recovery-'));
  let persistent: Database | undefined;
  try {
    persistent = await openDatabase({ path: directory });
    let bookingService = new BookingService(persistent, 'Asia/Kolkata', 24, clock);
    const session = await bookingService.createSession();
    const slot = '2026-10-22T09:00:00+05:30';
    const state: State = { intent: 'book', serviceId: 'consultation', visitorName: 'Recovery Demo', date: '2026-10-22', selectedSlot: slot, offeredSlots: [slot], confirmed: false };
    await bookingService.saveState(session.token, 0, state);
    await persistent.close(); persistent = undefined;
    persistent = await openDatabase({ path: directory });
    bookingService = new BookingService(persistent, 'Asia/Kolkata', 24, clock);
    const recovered = await bookingService.session(session.token);
    assert.deepEqual(recovered.state, state);
    const operationId = randomUUID();
    await bookingService.saveState(session.token, recovered.version, { ...state, confirmed: true, pendingOperationId: operationId });
    const request = { operationId, serviceId: 'consultation', visitorName: 'Recovery Demo', slot, confirmed: true as const };
    const committed = await bookingService.write(session.token, request);
    await persistent.close(); persistent = undefined;
    persistent = await openDatabase({ path: directory });
    bookingService = new BookingService(persistent, 'Asia/Kolkata', 24, clock);
    const retry = await bookingService.write(session.token, request);
    assert.equal(retry.status, 'already_committed');
    assert.equal(retry.booking.reference, committed.booking.reference);
    assert.equal((await bookingService.session(session.token)).state.booking?.reference, committed.booking.reference);
  } finally {
    await persistent?.close(); await rm(directory, { recursive: true, force: true });
  }
});
