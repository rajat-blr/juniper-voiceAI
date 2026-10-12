import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { BookingService, Outcome } from './booking.js';
import type { Database } from './db.js';
import { registerVoice } from './voice.js';
import { metricStages, observationStages, summarizeMetrics, type MetricEvent } from './metrics.js';

const timestamp = z.iso.datetime({ offset: true });
const id = z.string().min(8).max(128);
const bookingSchema = z.object({
  reference: z.string(), service_id: z.string(), visitor_name: z.string(),
  starts_at: timestamp, ends_at: timestamp, timezone: z.string(), status: z.literal('confirmed'),
}).passthrough();
const stateSchema = z.object({
  intent: z.enum(['book', 'reschedule']).optional(), serviceId: z.string().max(80).optional(),
  date: z.iso.date().optional(), offeredSlots: z.array(timestamp).max(32).optional(),
  selectedSlot: timestamp.optional(), visitorName: z.string().trim().min(1).max(80).optional(),
  reference: z.string().max(80).optional(), confirmed: z.boolean().optional(),
  pendingOperationId: id.optional(), booking: bookingSchema.optional(),
}).strict();
const writeSchema = z.object({
  operationId: id, slot: timestamp, confirmed: z.literal(true),
  serviceId: z.string().max(80).optional(), visitorName: z.string().trim().min(1).max(80).optional(),
}).strict();

export async function buildApp(db: Database, options: { timezone?: string; ttlHours?: number; clock?: BookingService['clock']; origin?: string | false; voice?: Parameters<typeof registerVoice>[2] } = {}) {
  const service = new BookingService(db, options.timezone, options.ttlHours, options.clock);
  const app = Fastify({ logger: false, bodyLimit: 32_768 });
  await app.register(cors, { origin: options.origin ?? process.env.WEB_ORIGIN ?? 'http://127.0.0.1:5173' });
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    return payload;
  });
  const token = (headers: { authorization?: string }) => {
    const value = headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!value) throw new Outcome('session_required', 401);
    return value;
  };
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ status: 'invalid_request', issues: error.issues.map((i) => ({ path: i.path, message: i.message })) });
    if (error instanceof Outcome) return reply.code(error.http).send({ status: error.status });
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) return reply.code(statusCode).send({ status: 'invalid_request' });
    // Log only an error class; tokens and visitor details never enter traces.
    console.error('API failure:', error instanceof Error ? error.name : 'UnknownError');
    return reply.code(500).send({ status: 'internal_error' });
  });
  app.get('/health', async () => { await db.query('SELECT 1'); return { status: 'ok' }; });
  app.get('/services', async () => ({ business: 'Juniper Studio', timezone: service.timezone, services: await service.services() }));
  app.get('/availability', async (request) => {
    const query = z.object({ serviceId: z.string(), date: z.iso.date(), reference: z.string().optional() }).parse(request.query);
    if (query.reference) {
      await service.session(token(request.headers));
      const booking = await service.lookup(query.reference);
      if (booking.service_id !== query.serviceId) throw new Outcome('service_mismatch', 400);
    }
    return { timezone: service.timezone, slots: await service.slots(query.serviceId, query.date, query.reference) };
  });
  app.post('/sessions', async (_request, reply) => reply.code(201).send(await service.createSession()));
  // Tokens travel in Authorization headers rather than URLs, to avoid access-log leaks.
  app.get('/session', async (request) => service.session(token(request.headers)));
  app.patch('/session', async (request) => {
    const { version, state } = z.object({ version: z.number().int().nonnegative(), state: stateSchema }).strict().parse(request.body);
    return service.saveState(token(request.headers), version, state);
  });
  app.get<{ Params: { reference: string } }>('/bookings/:reference', async (request) => {
    await service.session(token(request.headers));
    return { booking: await service.lookup(request.params.reference) };
  });
  app.post('/bookings', async (request) => {
    const body = writeSchema.required({ serviceId: true, visitorName: true }).parse(request.body);
    return service.write(token(request.headers), body);
  });
  app.post<{ Params: { reference: string } }>('/bookings/:reference/reschedule', async (request) =>
    service.write(token(request.headers), writeSchema.parse(request.body), request.params.reference));
  app.get<{ Params: { id: string } }>('/operations/:id', async (request) => service.operation(token(request.headers), request.params.id));
  app.get('/metrics', async (request) => {
    const sessionToken = token(request.headers);
    await service.session(sessionToken);
    const { tokenHash } = await import('./booking.js');
    const events = (await db.query('SELECT stage, duration_ms, result, created_at FROM performance_events WHERE session_hash=$1 ORDER BY id DESC LIMIT 100', [tokenHash(sessionToken)])).rows as unknown as MetricEvent[];
    return { events, summary: summarizeMetrics(events), windowLimit: 100 };
  });
  app.post('/metrics', async (request, reply) => {
    const sessionToken = token(request.headers);
    await service.session(sessionToken);
    const event = z.object({ stage: z.enum(metricStages), durationMs: z.number().min(0).max(3600000), result: z.enum(['ok', 'error']) }).strict()
      .refine((event) => !observationStages.some((stage) => stage === event.stage) || (event.durationMs === 0 && event.result === 'ok'),
        { message: 'Manual observations must have zero duration and an ok result' }).parse(request.body);
    const { tokenHash } = await import('./booking.js');
    await db.query('INSERT INTO performance_events (session_hash, stage, duration_ms, result) VALUES ($1,$2,$3,$4)', [tokenHash(sessionToken), event.stage, event.durationMs, event.result]);
    return reply.code(201).send({ status: 'recorded' });
  });
  if (options.voice) registerVoice(app, service, options.voice);
  return { app, service };
}
