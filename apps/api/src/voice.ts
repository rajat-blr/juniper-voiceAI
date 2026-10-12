import { randomBytes, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BookingService, Outcome, tokenHash } from './booking.js';
import { AccessToken, RoomAgentDispatch, RoomConfiguration, TrackSource } from 'livekit-server-sdk';

export interface VoiceOptions {
  secret: string; clock?: () => number; enabled?: boolean; receptionistTimeoutSeconds?: number;
  limits?: { daily: number; monthly: number; sessionHourly: number };
  livekit?: { url: string; apiKey: string; apiSecret: string };
}

export async function agentSecret() {
  if (process.env.AGENT_SHARED_SECRET) return process.env.AGENT_SHARED_SECRET;
  if (process.env.VERCEL) throw new Error('AGENT_SHARED_SECRET is required on Vercel');
  await mkdir('.data', { recursive: true });
  try {
    await writeFile('.data/agent-secret', randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' });
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  return (await readFile('.data/agent-secret', 'utf8')).trim();
}

export function registerVoice(app: FastifyInstance, service: BookingService,
  options: VoiceOptions) {
  const now = options.clock ?? Date.now;
  const encryptionKey = createHash('sha256').update(options.secret).digest();
  const seal = (token: string) => {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
  };
  const unseal = (value: string) => {
    const bytes = Buffer.from(value, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  };
  const bearer = (authorization?: string) => {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    if (!token) throw new Outcome('session_required', 401);
    return token;
  };
  const configured = () => options.livekit ?? {
    url: process.env.LIVEKIT_URL ?? '', apiKey: process.env.LIVEKIT_API_KEY ?? '', apiSecret: process.env.LIVEKIT_API_SECRET ?? '',
  };
  const config = () => {
    const values = configured();
    const missing = [!values.url && 'LIVEKIT_URL', !values.apiKey && 'LIVEKIT_API_KEY', !values.apiSecret && 'LIVEKIT_API_SECRET'].filter(Boolean);
    return { ready: options.enabled !== false && !missing.length, mode: 'livekit', missing, maxDurationSeconds: 300 };
  };
  app.get('/voice/config', async () => config());
  app.post('/voice/connect', async (request, reply) => {
    const token = bearer(request.headers.authorization);
    await service.session(token);
    if (!config().ready) throw new Outcome('voice_not_ready', 503);
    const livekit = configured();
    if (!/^wss:\/\//.test(livekit.url)) throw new Outcome('invalid_livekit_url', 503);
    // Short-lived tickets keep the long-lived browser session secret out of URLs
    // and cloud job metadata. Only the local Python process can redeem a ticket.
    const ticket = randomBytes(32).toString('base64url');
    await service.db.transaction(async (tx) => {
      await tx.query('LOCK TABLE voice_requests IN EXCLUSIVE MODE');
      const timestamp = new Date(now());
      await tx.query('DELETE FROM voice_handoffs WHERE expires_at <= $1', [timestamp]);
      if (options.limits) {
        await tx.query('DELETE FROM voice_requests WHERE created_at < $1', [new Date(now() - 32 * 86400_000)]);
        const day = new Date(timestamp); day.setUTCHours(0, 0, 0, 0);
        const month = new Date(day); month.setUTCDate(1);
        const counts = (await tx.query<{ daily: string; monthly: string; hourly: string }>(
          'SELECT count(*) FILTER (WHERE created_at >= $1) AS daily, count(*) FILTER (WHERE created_at >= $2) AS monthly, count(*) FILTER (WHERE session_hash=$3 AND created_at >= $4) AS hourly FROM voice_requests',
          [day, month, tokenHash(token), new Date(now() - 3600_000)])).rows[0];
        if (Number(counts.daily) >= options.limits.daily || Number(counts.monthly) >= options.limits.monthly) throw new Outcome('voice_demo_limit', 429);
        if (Number(counts.hourly) >= options.limits.sessionHourly) throw new Outcome('voice_session_limit', 429);
        await tx.query('INSERT INTO voice_requests (session_hash, created_at) VALUES ($1, $2)', [tokenHash(token), timestamp]);
      }
      const count = (await tx.query<{ count: string }>('SELECT count(*) AS count FROM voice_handoffs')).rows[0];
      if (Number(count.count) >= 1000) throw new Outcome('voice_capacity', 429);
      await tx.query('INSERT INTO voice_handoffs (ticket_hash, session_hash, sealed_token, expires_at) VALUES ($1,$2,$3,$4)',
        [tokenHash(ticket), tokenHash(token), seal(token), new Date(now() + 120_000)]);
    });
    const roomName = `voiceai-${randomBytes(12).toString('hex')}`;
    const access = new AccessToken(livekit.apiKey, livekit.apiSecret, { identity: `visitor-${randomBytes(8).toString('hex')}`, ttl: 120 });
    access.addGrant({ roomJoin: true, room: roomName, canSubscribe: true, canPublish: true,
      canPublishData: true, canPublishSources: [TrackSource.MICROPHONE] });
    access.roomConfig = new RoomConfiguration({ name: roomName, maxParticipants: 2, emptyTimeout: 60,
      agents: [new RoomAgentDispatch({ agentName: 'voiceai-receptionist', metadata: JSON.stringify({ ticket }) })] });
    return reply.header('Cache-Control', 'no-store').send({ serverUrl: livekit.url, participantToken: await access.toJwt(), roomName, maxDurationSeconds: 300, receptionistTimeoutSeconds: options.receptionistTimeoutSeconds ?? 30 });
  });
  app.post('/voice/redeem', async (request, reply) => {
    if (options.enabled === false) throw new Outcome('agent_unauthorized', 401);
    const supplied = request.headers['x-agent-secret'];
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(options.secret) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(options.secret))) throw new Outcome('agent_unauthorized', 401);
    const { ticket } = z.object({ ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict().parse(request.body);
    const found = (await service.db.query<{ sealed_token: string; expires_at: Date }>(
      'DELETE FROM voice_handoffs WHERE ticket_hash=$1 RETURNING sealed_token, expires_at', [tokenHash(ticket)])).rows[0];
    if (!found || new Date(found.expires_at).getTime() <= now()) throw new Outcome('voice_ticket_expired', 401);
    let sessionToken: string;
    try { sessionToken = unseal(found.sealed_token); }
    catch { throw new Outcome('voice_ticket_expired', 401); }
    await service.session(sessionToken);
    return reply.header('Cache-Control', 'no-store').send({ token: sessionToken });
  });
}
