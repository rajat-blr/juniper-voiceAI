import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

// Only explicitly selected values leave the local development environment.
const local = parseEnv(await readFile('.env', 'utf8').catch(() => ''));
const path = '.env.production.local';
const existing = parseEnv(await readFile(path, 'utf8').catch(() => ''));
const template = parseEnv(await readFile('.env.production.example', 'utf8'));
const values = { ...template, ...existing };
for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET']) {
  if (!values[name] && local[name]) values[name] = local[name];
}
if (!values.AGENT_SHARED_SECRET) values.AGENT_SHARED_SECRET = randomBytes(32).toString('base64url');
const encode = (entries: Record<string, string | undefined>) => Object.entries(entries)
  .map(([key, value]) => `${key}=${JSON.stringify(value ?? '')}`).join('\n') + '\n';
await writeFile(path, encode(values), { mode: 0o600 });
await chmod(path, 0o600);
await chmod('.env', 0o600).catch(() => {});
if (values.BOOKING_API_URL && values.BOOKING_API_URL !== template.BOOKING_API_URL && /^https:\/\/[^/]+\/api\/?$/.test(values.BOOKING_API_URL)) {
  await mkdir('.data/deploy', { recursive: true, mode: 0o700 });
  const workerNames = ['AGENT_SHARED_SECRET', 'BOOKING_API_URL', 'VOICEAI_ENV',
    'VOICE_STT_MODEL', 'VOICE_LLM_MODEL', 'VOICE_TTS_MODEL', 'VOICE_TTS_VOICE'];
  const worker = Object.fromEntries(workerNames.map((key) => [key, values[key]]));
  await writeFile('.data/deploy/agent.env', encode(worker), { mode: 0o600 });
  await chmod('.data/deploy/agent.env', 0o600);
  console.log('Private production environment and worker secret file prepared.');
} else {
  console.log('Private production environment prepared. Set BOOKING_API_URL after Vercel deployment, then run again.');
}
