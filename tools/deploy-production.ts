import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

// Run from a normal terminal. Secrets use stdin or a private file, never argv.
const values = parseEnv(await readFile('.env.production.local', 'utf8'));
const vercel = resolve('.data/deploy-tools/node_modules/.bin/vercel');
const livekit = resolve('.data/bin/lk');
const project = 'juniper-voice-ai';
const scope = 'rajat-blr';
for (const name of ['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'AGENT_SHARED_SECRET']) {
  if (!values[name]) throw new Error(`Missing ${name} in .env.production.local`);
}
if (!values.BOOKING_API_URL || !/^https:\/\/[^/]+\/api\/?$/.test(values.BOOKING_API_URL)
  || values.BOOKING_API_URL.includes('your-project')) throw new Error('Set the real BOOKING_API_URL in .env.production.local');
if (!existsSync(vercel) || !existsSync(livekit)) throw new Error('Install the official Vercel and LiveKit CLIs in .data first');
if (Buffer.byteLength(values.AGENT_SHARED_SECRET!) < 32) throw new Error('Production shared secret is too short');
await mkdir('.data/deploy', { recursive: true, mode: 0o700 });
await chmod('.env.production.local', 0o600);
const workerNames = ['AGENT_SHARED_SECRET', 'BOOKING_API_URL', 'VOICEAI_ENV',
  'VOICE_STT_MODEL', 'VOICE_LLM_MODEL', 'VOICE_TTS_MODEL', 'VOICE_TTS_VOICE'];
await writeFile('.data/deploy/agent.env', workerNames.map((key) => `${key}=${JSON.stringify(values[key] ?? '')}`).join('\n') + '\n', { mode: 0o600 });
await chmod('.data/deploy/agent.env', 0o600);
if (process.argv.includes('--check')) {
  console.log('Production settings and CLI paths validated. No credentials printed or uploaded.');
  process.exit(0);
}

let step = 0;
async function run(binary: string, args: string[], input?: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const label = `${++step}-${binary === vercel ? 'vercel' : binary === livekit ? 'livekit' : 'git'}`;
  const child = spawn(binary, args, { env: { ...process.env, VERCEL_TELEMETRY_DISABLED: '1', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  child.stdin.end(input);
  const code = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('close', done); });
  // Logs stay private; failure messages deliberately omit provider responses.
  await writeFile(`.data/deploy/${label}.log`, output, { mode: 0o600 });
  if (code !== 0) throw new Error(`${label} failed. Inspect its private .data/deploy log locally. Do not paste credentials.`);
  return output;
}
const common = ['--scope', scope, '--no-color'];
const upload = async (key: string, value: string) => {
  await run(vercel, ['env', 'add', key, 'production', '--project', project, '--sensitive', '--force', '--yes', ...common], value);
  console.log(`Saved ${key} to Vercel production.`);
};
if (existsSync('.data/release/.git')) {
  console.log('Publishing the prepared release commit to the existing GitHub repository.');
  await run('git', ['-C', '.data/release', 'push', 'origin', 'main']);
}
if (!process.argv.includes('--agent-only')) {
  console.log('Linking the existing Vercel project.');
  await run(vercel, ['link', '--yes', '--team', scope, '--project', project, '--no-color']);
  await upload('VOICE_ENABLED', 'false');
  for (const key of ['AGENT_SHARED_SECRET', 'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
    'BUSINESS_TIMEZONE', 'SESSION_TTL_HOURS', 'VOICE_DAILY_LIMIT', 'VOICE_MONTHLY_LIMIT', 'VOICE_SESSION_HOURLY_LIMIT']) {
    if (values[key]) await upload(key, values[key]!);
  }
  console.log('Deploying the API with voice disabled. Neon must already be connected to production.');
  await run(vercel, ['deploy', '--prod', '--yes', ...common]);
}
const health = await fetch(`${values.BOOKING_API_URL}/health`, { signal: AbortSignal.timeout(30000) });
const healthBody = await health.json().catch(() => null) as { status?: string } | null;
if (!health.ok || healthBody?.status !== 'ok') throw new Error('Production API health failed. Connect Neon DATABASE_URL before continuing. Voice remains disabled.');
const livekitEnv = Object.fromEntries(['LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET'].map((key) => [key, values[key]]));
const workerDirectory = 'apps/agent';
const workerSecrets = `--secrets-file=${resolve('.data/deploy/agent.env')}`;
if (existsSync(`${workerDirectory}/livekit.toml`)) {
  console.log('Updating cloud worker secrets and deploying the existing agent.');
  await run(livekit, ['--yes', 'agent', 'update-secrets', workerSecrets, workerDirectory], undefined, livekitEnv);
  await run(livekit, ['--yes', 'agent', 'deploy', workerDirectory], undefined, livekitEnv);
} else {
  console.log('Building and deploying the receptionist on LiveKit Cloud. This can take several minutes.');
  await run(livekit, ['--yes', 'agent', 'create', '--region', 'ap-south', workerSecrets, workerDirectory], undefined, livekitEnv);
}
await run(livekit, ['agent', 'status', '--json', workerDirectory], undefined, livekitEnv);
console.log('LiveKit deployment completed. Voice stays disabled until cloud status is verified.');
console.log('Keep apps/agent/livekit.toml. Tell Codex deployment finished so it can verify status and enable voice.');
