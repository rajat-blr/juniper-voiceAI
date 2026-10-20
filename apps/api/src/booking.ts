import { createHash, randomBytes } from 'node:crypto';
import { DateTime } from 'luxon';
import type { Database, Queryable } from './db.js';

export interface Service { id: string; name: string; duration_minutes: number }
export interface Booking {
  reference: string; service_id: string; visitor_name: string;
  starts_at: Date | string; ends_at: Date | string; timezone: string; status: string;
}
export interface State {
  intent?: 'book' | 'reschedule'; serviceId?: string; date?: string;
  offeredSlots?: string[]; selectedSlot?: string; visitorName?: string;
  reference?: string; confirmed?: boolean; pendingOperationId?: string; booking?: Booking;
}
export interface Session { version: number; state: State; expires_at: Date | string }
export interface WriteRequest {
  operationId: string; serviceId?: string; slot: string; visitorName?: string; confirmed: true;
}
export class Outcome extends Error {
  constructor(public status: string, public http = 409) { super(status); }
}
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const iso = (value: Date | string) => new Date(value).toISOString();

export class BookingService {
  constructor(public db: Database, public timezone = 'Asia/Kolkata', public ttlHours = 24,
    public clock: () => DateTime = () => DateTime.utc()) {
    if (!DateTime.now().setZone(timezone).isValid) throw new Error('Invalid BUSINESS_TIMEZONE');
    if (!Number.isFinite(ttlHours) || ttlHours <= 0) throw new Error('Invalid SESSION_TTL_HOURS');
  }
  async services(tx: Queryable = this.db) {
    return (await tx.query<Service>('SELECT id, name, duration_minutes FROM services WHERE active ORDER BY duration_minutes')).rows;
  }
  async createSession() {
    const token = randomBytes(32).toString('base64url');
    const expires = this.clock().plus({ hours: this.ttlHours }).toISO();
    await this.db.query('INSERT INTO sessions (token_hash, expires_at) VALUES ($1, $2)', [tokenHash(token), expires]);
    return { token, ...(await this.session(token)) };
  }
  async session(token: string, tx: Queryable = this.db, lock = false): Promise<Session> {
    const row = (await tx.query<Session>(
      `SELECT version, state, expires_at FROM sessions WHERE token_hash=$1 AND (auth_session_hash IS NULL OR EXISTS (SELECT 1 FROM auth_sessions WHERE auth_sessions.token_hash=sessions.auth_session_hash AND auth_sessions.expires_at > now())) ${lock ? 'FOR UPDATE' : ''}`, [tokenHash(token)])).rows[0];
    if (!row || new Date(row.expires_at).getTime() <= this.clock().toMillis()) throw new Outcome('session_expired', 401);
    return row;
  }
  async saveState(token: string, version: number, state: State) {
    return this.db.transaction(async (tx) => {
      const current = await this.session(token, tx, true);
      if (current.version !== version) throw new Outcome('version_conflict');
      // Confirmation is tied to exact details. Changing any detail invalidates it.
      if (state.confirmed) {
        if (!state.intent || !state.serviceId || !state.selectedSlot || !state.visitorName || !state.pendingOperationId)
          throw new Outcome('confirmation_incomplete', 400);
        if (!state.offeredSlots?.includes(state.selectedSlot)) throw new Outcome('slot_not_offered', 400);
        if (state.intent === 'reschedule' && !state.reference) throw new Outcome('confirmation_incomplete', 400);
        for (const field of ['intent', 'serviceId', 'selectedSlot', 'visitorName', 'reference'] as const) {
          if (state[field] !== current.state[field]) throw new Outcome('confirmation_details_changed', 400);
        }
      }
      await tx.query('UPDATE sessions SET state=$1, version=version+1 WHERE token_hash=$2', [JSON.stringify(state), tokenHash(token)]);
      return this.session(token, tx);
    });
  }
  async lookup(reference: string, tx: Queryable = this.db) {
    const row = (await tx.query<Booking>('SELECT * FROM appointments WHERE reference=$1', [reference])).rows[0];
    if (!row) throw new Outcome('not_found', 404);
    return row;
  }
  async slots(serviceId: string, date: string, excludeReference?: string, tx: Queryable = this.db) {
    const service = (await this.services(tx)).find((s) => s.id === serviceId);
    if (!service) throw new Outcome('service_not_found', 404);
    const day = DateTime.fromISO(date, { zone: this.timezone });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !day.isValid || day.toISODate() !== date) throw new Outcome('invalid_date', 400);
    if (day.weekday > 5) return [];
    const start = day.set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
    const close = day.set({ hour: 17, minute: 0, second: 0, millisecond: 0 });
    const bookings = (await tx.query<Booking>(
      'SELECT * FROM appointments WHERE starts_at < $1 AND ends_at > $2 AND ($3::text IS NULL OR reference <> $3)',
      [close.toUTC().toISO(), start.toUTC().toISO(), excludeReference ?? null])).rows;
    const slots: { start: string; end: string; label: string }[] = [];
    for (let time = start; time.plus({ minutes: service.duration_minutes }) <= close; time = time.plus({ minutes: 30 })) {
      const end = time.plus({ minutes: service.duration_minutes });
      if (time <= this.clock() || bookings.some((b) => time.toMillis() < new Date(b.ends_at).getTime() && end.toMillis() > new Date(b.starts_at).getTime())) continue;
      slots.push({ start: time.toISO()!, end: end.toISO()!, label: `${time.toFormat('cccc, d LLL • h:mm a')} (${this.timezone})` });
    }
    return slots;
  }
  async operation(token: string, id: string) {
    await this.session(token);
    const row = (await this.db.query<{ result: unknown }>('SELECT result FROM operations WHERE operation_id=$1 AND session_hash=$2', [id, tokenHash(token)])).rows[0];
    if (!row) throw new Outcome('not_found', 404);
    return row.result;
  }
  async write(token: string, request: WriteRequest, reference?: string) {
    const action = reference ? 'reschedule' : 'book';
    const fingerprint = tokenHash(JSON.stringify([action, reference ?? null, request.serviceId ?? null,
      iso(request.slot), request.visitorName ?? null]));
    try {
      return await this.db.transaction(async (tx) => {
        const session = await this.session(token, tx, true);
        // Serialize the one bookable resource across API processes. The exclusion
        // constraint independently protects against writes outside this service.
        await tx.query('LOCK TABLE appointments IN SHARE ROW EXCLUSIVE MODE');
        const previous = (await tx.query<{ fingerprint: string; session_hash: string; result: { booking: Booking } }>(
          'SELECT * FROM operations WHERE operation_id=$1', [request.operationId])).rows[0];
        if (previous) {
          if (previous.session_hash !== tokenHash(token) || previous.fingerprint !== fingerprint) throw new Outcome('operation_conflict');
          return { ...previous.result, status: 'already_committed' };
        }
        const state = session.state;
        if (!request.confirmed || !state.confirmed || state.intent !== action || state.pendingOperationId !== request.operationId ||
          !state.selectedSlot || iso(state.selectedSlot) !== iso(request.slot) ||
          (reference ? state.reference !== reference : state.serviceId !== request.serviceId || state.visitorName !== request.visitorName))
          throw new Outcome('confirmation_required', 400);
        const old = reference ? await this.lookup(reference, tx) : undefined;
        const serviceId = old?.service_id ?? request.serviceId!;
        if (state.serviceId !== serviceId) throw new Outcome('confirmation_required', 400);
        const time = DateTime.fromISO(request.slot, { setZone: true }).setZone(this.timezone);
        const service = (await this.services(tx)).find((s) => s.id === serviceId);
        if (!service || !time.isValid || time <= this.clock() || time.weekday > 5 || time.second !== 0 || time.millisecond !== 0 ||
          time.minute % 30 !== 0 || time.hour < 9 || time.plus({ minutes: service.duration_minutes }).toMillis() > time.startOf('day').plus({ hours: 17 }).toMillis())
          throw new Outcome('invalid_time', 400);
        const end = time.plus({ minutes: service.duration_minutes });
        const conflict = await tx.query('SELECT reference FROM appointments WHERE starts_at < $1 AND ends_at > $2 AND ($3::text IS NULL OR reference <> $3)',
          [end.toUTC().toISO(), time.toUTC().toISO(), reference ?? null]);
        if (conflict.rows.length) throw new Outcome('slot_unavailable');
        const booking = reference
          ? (await tx.query<Booking>('UPDATE appointments SET starts_at=$1, ends_at=$2, updated_at=now() WHERE reference=$3 RETURNING *',
              [time.toUTC().toISO(), end.toUTC().toISO(), reference])).rows[0]
          : (await tx.query<Booking>('INSERT INTO appointments (reference, service_id, visitor_name, starts_at, ends_at, timezone) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
              [`VA-${randomBytes(6).toString('hex').toUpperCase()}`, serviceId, request.visitorName, time.toUTC().toISO(), end.toUTC().toISO(), this.timezone])).rows[0];
        const result = { status: 'committed', booking };
        await tx.query('INSERT INTO operations (operation_id, session_hash, action, fingerprint, result) VALUES ($1,$2,$3,$4,$5)',
          [request.operationId, tokenHash(token), action, fingerprint, JSON.stringify(result)]);
        await tx.query('UPDATE sessions SET version=version+1, state=$1 WHERE token_hash=$2',
          [JSON.stringify({ ...state, confirmed: false, booking, reference: booking.reference }), tokenHash(token)]);
        return result;
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23P01') throw new Outcome('slot_unavailable');
      throw error;
    }
  }
}
