import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import { agentSecret } from './voice.js';

export function runtimeConfig(env: NodeJS.ProcessEnv = process.env) {
  const serverless = env.VERCEL === '1';
  const production = serverless && env.VERCEL_ENV === 'production';
  if (serverless && !env.DATABASE_URL) throw new Error('DATABASE_URL is required on Vercel');
  const voiceEnabled = serverless ? production && env.VOICE_ENABLED === 'true' : env.VOICE_ENABLED !== 'false';
  if (serverless && voiceEnabled && (!env.AGENT_SHARED_SECRET || Buffer.byteLength(env.AGENT_SHARED_SECRET) < 32)) {
    throw new Error('Production voice requires AGENT_SHARED_SECRET with at least 32 bytes');
  }
  const limit = (name: string, fallback: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isInteger(value) || value < 1 || value > 10000) throw new Error(`Invalid ${name}`);
    return value;
  };
  return { serverless, production, voiceEnabled, databaseUrl: env.DATABASE_URL,
    timezone: env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata', ttlHours: Number(env.SESSION_TTL_HOURS ?? 24),
    secret: env.AGENT_SHARED_SECRET,
    limits: production ? { daily: limit('VOICE_DAILY_LIMIT', 5), monthly: limit('VOICE_MONTHLY_LIMIT', 20), sessionHourly: limit('VOICE_SESSION_HOURLY_LIMIT', 5) } : undefined };
}

export async function createRuntimeApplication(env: NodeJS.ProcessEnv = process.env, databaseFactory = openDatabase) {
  const config = runtimeConfig(env);
  const db = await databaseFactory({ url: config.databaseUrl, ...(config.serverless ? {} : { path: '.data/booking' }),
    migrate: !config.serverless, requireTLS: config.serverless });
  try {
    const secret = config.secret ?? (config.serverless ? 'voice-disabled' : await agentSecret());
    const { app } = await buildApp(db, { secureCookies: config.serverless || env.NODE_ENV === 'production', timezone: config.timezone, ttlHours: config.ttlHours,
      origin: config.serverless ? false : env.WEB_ORIGIN ?? 'http://127.0.0.1:5173',
      voice: { secret, enabled: config.voiceEnabled, limits: config.limits,
        receptionistTimeoutSeconds: config.serverless ? 90 : 30,
        livekit: { url: env.LIVEKIT_URL ?? '', apiKey: env.LIVEKIT_API_KEY ?? '', apiSecret: env.LIVEKIT_API_SECRET ?? '' } } });
    await app.ready();
    return { app, db };
  } catch (error) { await db.close(); throw error; }
}
