import { openDatabase } from '../apps/api/src/db.js';
if (!process.env.DATABASE_URL) throw new Error('Set DATABASE_URL before running migrations');
const db = await openDatabase({ url: process.env.DATABASE_URL, requireTLS: process.env.DATABASE_REQUIRE_TLS !== 'false' });
await db.close();
console.log('Database schema initialized. No credentials were printed.');
