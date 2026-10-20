import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../apps/api/src/db.js';
import { buildApp } from '../apps/api/src/app.js';

const payload = { username: 'Alice_123', password: 'a strong password' };
const headers = { 'x-voiceai-auth': '1' };
const getCookie = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

test('signup stores a salted hash, logs in, rejects duplicates, and requires authentication for booking sessions', async () => {
  const db = await openDatabase(); const { app } = await buildApp(db);
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/sessions', payload: {} })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me' })).statusCode, 401);
    const signup = await app.inject({ method: 'POST', url: '/auth/signup', headers, payload });
    assert.equal(signup.statusCode, 201);
    assert.equal(signup.json().user.username, 'alice_123');
    assert.deepEqual(Object.keys(signup.json().user).sort(), ['id', 'username']);
    const stored = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users')).rows[0];
    assert.match(stored.password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    assert.equal(JSON.stringify(stored).includes(payload.password), false);
    const cookie = getCookie(signup);
    assert.match(String(signup.headers['set-cookie']), /HttpOnly; SameSite=Lax/);
    assert.equal((await db.query('SELECT * FROM auth_sessions WHERE token_hash=$1', [cookie.split('=')[1]])).rows.length, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).json().user.username, 'alice_123');
    assert.equal((await app.inject({ method: 'POST', url: '/auth/signup', headers, payload: { ...payload, username: 'ALICE_123' } })).statusCode, 409);
    const second = await app.inject({ method: 'POST', url: '/auth/signup', headers, payload: { ...payload, username: 'bob' } });
    assert.equal(second.statusCode, 201);
    const hashes = (await db.query<{ password_hash: string }>('SELECT password_hash FROM users')).rows;
    assert.notEqual(hashes[0].password_hash, hashes[1].password_hash);
    for (const attempt of [{ ...payload, password: 'wrong password' }, { ...payload, username: 'missing' }]) {
      const login = await app.inject({ method: 'POST', url: '/auth/login', headers, payload: attempt });
      assert.equal(login.statusCode, 401); assert.equal(login.json().status, 'invalid_credentials');
    }
    const login = await app.inject({ method: 'POST', url: '/auth/login', headers, payload });
    assert.equal(login.statusCode, 200); assert.notEqual(getCookie(login), cookie);
    const session = await app.inject({ method: 'POST', url: '/sessions', headers: { cookie: getCookie(login) }, payload: {} });
    assert.equal(session.statusCode, 201);
    const bearer = { authorization: `Bearer ${session.json().token}` };
    assert.equal((await app.inject({ method: 'GET', url: '/session', headers: bearer })).statusCode, 200);
    const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { ...headers, cookie: getCookie(login) }, payload: {} });
    assert.equal(logout.statusCode, 200); assert.match(String(logout.headers['set-cookie']), /Max-Age=0/);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie: getCookie(login) } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/session', headers: bearer })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode, 200);
    await db.query("UPDATE auth_sessions SET expires_at=now() - interval '1 second'");
    assert.equal((await app.inject({ method: 'GET', url: '/auth/me', headers: { cookie } })).statusCode, 401);
  } finally { await app.close(); await db.close(); }
});

test('auth validates inputs, blocks form submissions, throttles guesses, and sets secure cookies in production', async () => {
  const db = await openDatabase(); const { app } = await buildApp(db, { secureCookies: true });
  try {
    assert.equal((await app.inject({ method: 'POST', url: '/auth/signup', payload })).statusCode, 400);
    for (const invalid of [{ ...payload, username: 'ab' }, { ...payload, username: '<script>' }, { ...payload, password: 'short' }, { ...payload, password: 'x'.repeat(129) }]) {
      assert.equal((await app.inject({ method: 'POST', url: '/auth/signup', headers, payload: invalid })).statusCode, 400);
    }
    const signup = await app.inject({ method: 'POST', url: 'https://example.com/auth/signup', headers, payload });
    assert.equal(signup.statusCode, 201); assert.match(String(signup.headers['set-cookie']), /; Secure/);
    for (let i = 0; i < 14; i++) {
      assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers, payload: { ...payload, password: 'wrong password' } })).statusCode, 401);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/auth/login', headers, payload })).statusCode, 429);
  } finally { await app.close(); await db.close(); }
});

test('credentials persist after a database restart', async () => {
  const path = await mkdtemp(join(tmpdir(), 'voiceai-auth-'));
  let db = await openDatabase({ path }); let built = await buildApp(db);
  try {
    assert.equal((await built.app.inject({ method: 'POST', url: '/auth/signup', headers, payload })).statusCode, 201);
    await built.app.close(); await db.close();
    db = await openDatabase({ path }); built = await buildApp(db);
    assert.equal((await built.app.inject({ method: 'POST', url: '/auth/login', headers, payload })).statusCode, 200);
  } finally { await built.app.close(); await db.close(); await rm(path, { recursive: true, force: true }); }
});
