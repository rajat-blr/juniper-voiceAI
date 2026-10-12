import { mkdir } from 'node:fs/promises';
import { openDatabase } from './db.js';
import { buildApp } from './app.js';
import { agentSecret } from './voice.js';

await mkdir('.data', { recursive: true });
const db = await openDatabase({ url: process.env.DATABASE_URL, path: '.data/booking' });
const { app } = await buildApp(db, {
  timezone: process.env.BUSINESS_TIMEZONE ?? 'Asia/Kolkata',
  ttlHours: Number(process.env.SESSION_TTL_HOURS ?? 24),
  voice: { secret: await agentSecret() },
});
await app.listen({ port: Number(process.env.PORT ?? 3001), host: '127.0.0.1' });
console.log('Booking API ready at http://127.0.0.1:3001');
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, async () => {
  await app.close(); await db.close(); process.exit(0);
});
