import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DateTime } from 'luxon';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';
import type { Session, State, Booking } from '../apps/api/src/booking.js';

type Transport = 'http' | 'inject';
export async function benchmarkApi(options: { samples?: number; warmups?: number; transport?: Transport } = {}) {
  const samples = options.samples ?? 40; const warmups = options.warmups ?? 5; const transport = options.transport ?? 'http';
  if (!Number.isInteger(samples) || samples < 1 || samples > 1000 || !Number.isInteger(warmups) || warmups < 0 || warmups > 100) throw new Error('invalid_samples');
  const db = await openDatabase();
  const { app } = await buildApp(db);
  const timings: Record<string, number[]> = { booking: [], reschedule: [], idempotent_retry: [] };
  let address = '';
  try {
    if (transport === 'http') address = await app.listen({ host: '127.0.0.1', port: 0 });
    async function request<T>(method: 'GET' | 'POST' | 'PATCH', path: string, token = '', payload?: unknown): Promise<T> {
      const headers = { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
      if (transport === 'inject') {
        const response = await app.inject({ method, url: path, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
        if (response.statusCode >= 400) throw new Error(response.json().status);
        return response.json() as T;
      }
      const response = await fetch(address + path, { method, headers, signal: AbortSignal.timeout(10_000),
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.status);
      return result as T;
    }
    async function prepare(date: string, reference?: string, token?: string) {
      const loaded = token ? await request<Session>('GET', '/session', token) : await request<Session & { token: string }>('POST', '/sessions', '', {});
      const bearer = token ?? (loaded as Session & { token: string }).token;
      const offered = await request<{ slots: { start: string }[] }>('GET', `/availability?serviceId=consultation&date=${date}${reference ? `&reference=${reference}` : ''}`, bearer);
      const selectedSlot = reference ? offered.slots.at(-1)?.start : offered.slots[0]?.start;
      if (!selectedSlot) throw new Error('fixture_unavailable');
      const state: State = { intent: reference ? 'reschedule' : 'book', serviceId: 'consultation', visitorName: 'Benchmark Demo', date,
        offeredSlots: offered.slots.map((slot) => slot.start), selectedSlot, confirmed: false,
        ...(reference ? { reference, booking: loaded.state.booking } : {}) };
      const selected = await request<Session>('PATCH', '/session', bearer, { version: loaded.version, state });
      const operationId = randomUUID();
      await request('PATCH', '/session', bearer, { version: selected.version, state: { ...state, confirmed: true, pendingOperationId: operationId } });
      return { token: bearer, payload: { operationId, slot: selectedSlot, confirmed: true,
        ...(reference ? {} : { serviceId: 'consultation', visitorName: 'Benchmark Demo' }) } };
    }
    async function measured(stage: keyof typeof timings, path: string, prepared: Awaited<ReturnType<typeof prepare>>, collect: boolean) {
      const start = performance.now();
      const result = await request<{ status: string; booking: Booking }>('POST', path, prepared.token, prepared.payload);
      if (collect) timings[stage].push(performance.now() - start);
      return result;
    }
    let day = DateTime.now().setZone('Asia/Kolkata').plus({ days: 7 }).startOf('day');
    const nextDate = () => { while (day.weekday > 5) day = day.plus({ days: 1 }); const date = day.toISODate()!; day = day.plus({ days: 1 }); return date; };
    for (let index = 0; index < warmups + samples; index++) {
      const date = nextDate(); const collect = index >= warmups;
      const original = await prepare(date);
      const booked = await measured('booking', '/bookings', original, collect);
      if (booked.status !== 'committed') throw new Error('booking_not_committed');
      const move = await prepare(date, booked.booking.reference, original.token);
      const path = `/bookings/${booked.booking.reference}/reschedule`;
      const moved = await measured('reschedule', path, move, collect);
      const retried = await measured('idempotent_retry', path, move, collect);
      if (moved.status !== 'committed' || moved.booking.reference !== booked.booking.reference
        || new Date(moved.booking.starts_at).getTime() === new Date(booked.booking.starts_at).getTime()
        || retried.status !== 'already_committed' || retried.booking.reference !== booked.booking.reference) throw new Error('reschedule_invariant_failed');
      const restored = await request<Session>('GET', '/session', original.token);
      if (restored.state.booking?.reference !== booked.booking.reference || restored.state.confirmed) throw new Error('recovery_invariant_failed');
    }
    const date = nextDate();
    const [a, b] = await Promise.all([prepare(date), prepare(date)]);
    const race = await Promise.allSettled([request<{ status: string }>('POST', '/bookings', a.token, a.payload), request<{ status: string }>('POST', '/bookings', b.token, b.payload)]);
    const winners = race.filter((result) => result.status === 'fulfilled' && result.value.status === 'committed').length;
    const losers = race.filter((result) => result.status === 'rejected' && result.reason instanceof Error && result.reason.message === 'slot_unavailable').length;
    const appointments = Number((await db.query<{ count: string }>('SELECT count(*) AS count FROM appointments')).rows[0].count);
    if (winners !== 1 || losers !== 1 || appointments !== warmups + samples + 1) throw new Error('duplicate_booking_invariant_failed');
    const stages = Object.fromEntries(Object.entries(timings).map(([stage, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [stage, { samples: values.length, p50Ms: sorted[Math.ceil(sorted.length * .5) - 1], p95Ms: sorted[Math.ceil(sorted.length * .95) - 1] }];
    }));
    return { generatedAt: new Date().toISOString(), transport, database: 'isolated in-memory PGlite', node: process.version,
      warmups, stages, invariants: { singleRaceWinner: true, stableRescheduleReferences: true, idempotentRetries: true, restoredCommittedState: true, appointments },
      targetMs: 300, targetAssessment: transport === 'http'
        ? stages.booking.p95Ms <= 300 && stages.reschedule.p95Ms <= 300 ? 'within_target' : 'above_target'
        : 'not_assessed_network_excluded',
      limitations: ['No cloud speech or model calls. No changes to .data/booking.',
        transport === 'http' ? 'Loopback HTTP, warmed embedded database, sequential samples; no production throughput claim.'
          : 'Fastify injection measures routes and database only; excludes network and cannot verify the HTTP round-trip target.',
        'PGlite serializes transactions; the race does not prove standalone multi-process PostgreSQL behavior.'] };
  } finally { await app.close(); await db.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { transport: { type: 'string', default: 'http' }, samples: { type: 'string', default: '40' }, output: { type: 'string' } } });
  if (values.transport !== 'http' && values.transport !== 'inject') throw new Error('invalid_transport');
  const report = await benchmarkApi({ transport: values.transport, samples: Number(values.samples) });
  const path = resolve(values.output ?? `.data/performance/api-${Date.now()}.json`);
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ report: path, transport: report.transport, stages: report.stages, targetAssessment: report.targetAssessment }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(code === 'EPERM' || code === 'EACCES' ? 'Loopback socket unavailable. Run in a normal terminal, or use --transport inject for a benchmark excluding network.' : 'API benchmark failed; no success report written.');
  process.exitCode = 1;
});
