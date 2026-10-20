import { randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from './db.js';
import { Outcome, tokenHash } from './booking.js';

const credentials = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_]+$/).transform((s) => s.toLowerCase()),
  password: z.string().min(8).max(128),
}).strict();
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
const cookieToken = (request: FastifyRequest) => request.headers.cookie?.match(/(?:^|;\s*)voiceai_auth=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
const cookie = (request: FastifyRequest, value: string, age: number, secure: boolean) =>
  `voiceai_auth=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure || request.protocol === 'https' ? '; Secure' : ''}`;

export function registerAuth(app: FastifyInstance, db: Database, secureCookies = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production') {
  const requireUser = async (request: FastifyRequest) => {
    const token = cookieToken(request);
    if (!token) throw new Outcome('authentication_required', 401);
    const user = (await db.query<{ id: string; username: string; session_hash: string }>(
      'SELECT u.id, u.username, s.token_hash AS session_hash FROM users u JOIN auth_sessions s ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at > now()', [tokenHash(token)])).rows[0];
    if (!user) throw new Outcome('authentication_required', 401);
    return user;
  };
  // Custom header plus JSON prevent cross-origin form submissions from using cookies.
  app.addHook('onRequest', async (request) => {
    if (request.url.split('?')[0].startsWith('/auth/') && request.method !== 'GET' && request.method !== 'OPTIONS' && request.headers['x-voiceai-auth'] !== '1')
      throw new Outcome('invalid_request', 400);
  });
  const issue = async (request: FastifyRequest, reply: FastifyReply, user: { id: string; username: string }) => {
    const token = randomBytes(32).toString('base64url');
    await db.query('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES ($1,$2,now() + interval \'7 days\')', [tokenHash(token), user.id]);
    reply.header('Set-Cookie', cookie(request, token, 7 * 86400, secureCookies));
    return { user: { id: user.id, username: user.username } };
  };
  // Persist limits in the database so they also apply across serverless instances.
  const limit = async (request: FastifyRequest, username: string) => {
    await db.transaction(async (tx) => {
      await tx.query('DELETE FROM auth_attempts WHERE window_start < now() - interval \'15 minutes\'');
      for (const key of [`ip:${request.ip}`, `username:${username}`]) {
        const row = (await tx.query<{ attempts: number }>(`INSERT INTO auth_attempts (key, attempts, window_start) VALUES ($1,1,now())
          ON CONFLICT (key) DO UPDATE SET attempts=auth_attempts.attempts+1 RETURNING attempts`, [tokenHash(key)])).rows[0];
        if (row.attempts > (key.startsWith('ip:') ? 50 : 15)) throw new Outcome('too_many_attempts', 429);
      }
    });
  };
  app.post('/auth/signup', async (request, reply) => {
    const { username, password } = credentials.parse(request.body);
    await limit(request, username);
    const salt = randomBytes(16).toString('hex');
    const hash = `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
    const user = (await db.query<{ id: string; username: string }>(
      'INSERT INTO users (id, username, password_hash) VALUES ($1,$2,$3) ON CONFLICT (username) DO NOTHING RETURNING id, username',
      [randomUUID(), username, hash])).rows[0];
    if (!user) throw new Outcome('username_taken', 409);
    reply.code(201);
    return issue(request, reply, user);
  });
  app.post('/auth/login', async (request, reply) => {
    const { username, password } = credentials.parse(request.body);
    await limit(request, username);
    const user = (await db.query<{ id: string; username: string; password_hash: string }>('SELECT id, username, password_hash FROM users WHERE username=$1', [username])).rows[0];
    const [, salt, expected] = user?.password_hash.split('$') ?? ['scrypt', '0'.repeat(32), '0'.repeat(128)];
    const key = await derive(password, salt);
    if (!timingSafeEqual(key, Buffer.from(expected, 'hex')) || !user) throw new Outcome('invalid_credentials', 401);
    return issue(request, reply, user);
  });
  app.get('/auth/me', async (request) => {
    const { id, username } = await requireUser(request);
    return { user: { id, username } };
  });
  app.post('/auth/logout', async (request, reply) => {
    const token = cookieToken(request);
    if (token) await db.transaction(async (tx) => {
      await tx.query('UPDATE sessions SET expires_at=now() WHERE auth_session_hash=$1', [tokenHash(token)]);
      await tx.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash(token)]);
    });
    reply.header('Set-Cookie', cookie(request, '', 0, secureCookies));
    return { status: 'logged_out' };
  });
  return { requireUser };
}
