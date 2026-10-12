import pg from 'pg';
import { readFile } from 'node:fs/promises';

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}
export interface Database extends Queryable {
  transaction<T>(work: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDatabase(options: { url?: string; path?: string; migrate?: boolean; requireTLS?: boolean } = {}): Promise<Database> {
  let db: Database;
  if (options.url) {
    const connection = new URL(options.url);
    if (options.requireTLS) {
      // URL SSL flags can override pg's ssl object. Production always verifies TLS.
      for (const field of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert']) connection.searchParams.delete(field);
    }
    const pool = new pg.Pool({ connectionString: connection.toString(), max: 3, idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000, ...(options.requireTLS ? { ssl: { rejectUnauthorized: true } } : {}) });
    db = {
      query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await pool.query(sql, params)).rows as T[] }),
      async transaction(work) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await work({ query: async <T>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as T[] }) });
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally { client.release(); }
      },
      close: () => pool.end(),
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const embedded = new PGlite(options.path);
    await embedded.waitReady;
    db = {
      query: (sql, params) => embedded.query(sql, params),
      transaction: (work) => embedded.transaction((tx) => work(tx)),
      close: () => embedded.close(),
    };
  }
  if (options.migrate === false) return db;
  const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  // Run each statement on the same connection inside one migration transaction.
  await db.transaction(async (tx) => {
    for (const statement of schema.split(';').filter((s) => s.trim())) await tx.query(statement);
  });
  return db;
}
