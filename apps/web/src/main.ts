import './style.css';
import type { Booking, Session, State, Service } from '../../api/src/booking';
import { VoiceConnection, type VoiceEvent } from './voice';
import { recoverSession } from './recovery';
import { createBookingApi } from './api';
import type { MetricStage } from '../../api/src/metrics';

type Slot = { start: string; end: string; label: string };
const root = document.querySelector<HTMLDivElement>('#app')!;
let session: Session;
let user: { id: string; username: string } | undefined;
let authMode: 'login' | 'signup' = 'login';
let authLoading = true;
let sessionToken = '';
const sessionKey = () => `voiceai.session.${user!.id}`;
let services: Service[] = [];
let timezone = 'Asia/Kolkata';
let slots: Slot[] = [];
let page = 0;
let busy = false;
let notice = '';
let resumed = false;
let voiceReady = false;
let transcript: { role: string; text: string }[] = [];
let partial = '';
let progressRefresh: Promise<void> | undefined;
let sessionExpired = false;
let expirationCleanup: Promise<void> | undefined;
const expiryNotice = 'Your session expired. Start a new session to continue. Existing appointments remain booked.';
const api = createBookingApi(() => sessionToken, () => {
  if (sessionExpired) return;
  sessionExpired = true; notice = expiryNotice;
  expirationCleanup = voice.stop();
  render();
});
const voice = new VoiceConnection(
  () => api('/voice/connect', {}),
  (event: VoiceEvent) => {
    if (event.type === 'transcript' && typeof event.text === 'string') {
      if (event.final) { transcript.push({ role: event.role ?? 'agent', text: event.text }); transcript = transcript.slice(-30); partial = ''; }
      else partial = event.text;
    }
    if (event.type === 'error') {
      notice = sessionExpired ? expiryNotice : event.message ?? 'Voice connection interrupted. Your saved progress is safe.';
      render();
    }
    if (event.type === 'progress') void refreshVoiceProgress();
  },
  (stage, durationMs, result = 'ok') => { void recordMetric(stage, durationMs, result); },
  () => render(),
);
async function recordMetric(stage: MetricStage, durationMs: number, result: 'ok' | 'error' = 'ok') {
  try {
    await api('/metrics', { stage, durationMs, result });
  } catch { /* Telemetry failures must not hide a booking or disrupt audio. */ }
}
async function refreshVoiceProgress() {
  if (progressRefresh) return progressRefresh;
  progressRefresh = (async () => {
    try {
      session = await api('/session');
      const state = session.state;
      if (state.serviceId && state.date && !(state.booking && state.pendingOperationId && !state.confirmed)) {
        const result = await api<{ slots: Slot[] }>(`/availability?serviceId=${encodeURIComponent(state.serviceId)}&date=${encodeURIComponent(state.date)}${state.reference ? `&reference=${encodeURIComponent(state.reference)}` : ''}`);
        slots = result.slots.filter((slot) => state.offeredSlots?.includes(slot.start)); page = 0;
      } else slots = [];
    } catch { /* A later refresh restores durable progress after a connection error. */ }
    finally { render(); progressRefresh = undefined; }
  })();
  return progressRefresh;
}
const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const format = (time: Date | string) => new Intl.DateTimeFormat('en', { timeZone: timezone, weekday: 'long', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(time));
const dateInZone = () => new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function newSession() {
  await expirationCleanup;
  await voice.stop();
  // Drain the old room's poll before switching tokens, so stale state cannot return.
  await progressRefresh;
  const created = await api<Session & { token: string }>('/sessions', {});
  sessionToken = created.token; session = created; sessionExpired = false;
  localStorage.setItem(sessionKey(), sessionToken);
  slots = []; page = 0; resumed = false;
  transcript = []; partial = ''; expirationCleanup = undefined;
  notice = 'New session ready. To move an existing appointment, look it up by reference.';
}
async function save(state: State) {
  session = await api<Session>('/session', { version: session.version, state }, 'PATCH');
}
async function run(work: () => Promise<void>) {
  busy = true; notice = '';
  root.setAttribute('aria-busy', 'true');
  root.querySelectorAll<HTMLButtonElement>('button').forEach((button) => { button.disabled = true; });
  try { await work(); }
  catch (error) {
    const reason = error instanceof Error ? error.message : 'connection_failed';
    if (reason === 'authentication_required') {
      await voice.stop(); user = undefined; sessionToken = '';
      notice = 'Your login expired. Please log in again.'; return;
    }
    const messages: Record<string, string> = {
      slot_unavailable: 'That time was taken. Search again to see current availability.',
      version_conflict: 'Another tab updated this request. Your saved progress has been reloaded.',
      session_expired: expiryNotice,
      not_found: 'Booking reference not found. Check the reference and try again.',
      confirmation_required: 'Please review the appointment details and confirm again.',
    };
    notice = messages[reason] ?? `Could not finish this step (${reason}). Your saved progress is safe. Try again.`;
    if (reason === 'version_conflict') session = await api('/session');
  } finally { busy = false; root.setAttribute('aria-busy', 'false'); render(); }
}
async function search() {
  const serviceId = document.querySelector<HTMLSelectElement>('#service')!.value;
  const date = document.querySelector<HTMLInputElement>('#date')!.value;
  const visitorName = document.querySelector<HTMLInputElement>('#name')!.value.trim();
  if (!visitorName) { notice = 'Enter a fictional visitor name before choosing a time.'; return; }
  const reference = session.state.intent === 'reschedule' ? session.state.reference : undefined;
  const result = await api<{ slots: Slot[] }>(`/availability?serviceId=${encodeURIComponent(serviceId)}&date=${encodeURIComponent(date)}${reference ? `&reference=${encodeURIComponent(reference)}` : ''}`);
  slots = result.slots; page = 0;
  await save({ intent: reference ? 'reschedule' : 'book', serviceId, date, visitorName, reference,
    ...(reference ? { booking: session.state.booking } : {}), offeredSlots: slots.map((s) => s.start), confirmed: false });
  if (!slots.length) notice = 'No times available that day. Try another weekday.';
}
async function commit() {
  const state = session.state;
  if (!state.selectedSlot) return;
  // Persist the operation ID before sending the write. A refresh or lost response
  // can safely retry this exact operation without producing another appointment.
  if (!state.confirmed) await save({ ...state, confirmed: true, pendingOperationId: crypto.randomUUID() });
  const pending = session.state;
  const start = performance.now();
  const result = await api<{ status: string; booking: Booking }>(pending.intent === 'reschedule'
    ? `/bookings/${encodeURIComponent(pending.reference!)}/reschedule` : '/bookings', {
    operationId: pending.pendingOperationId, slot: pending.selectedSlot, confirmed: true,
    ...(pending.intent === 'book' ? { serviceId: pending.serviceId, visitorName: pending.visitorName } : {}),
  }).catch(async (error) => {
    await recordMetric('booking_api', performance.now() - start, 'error');
    throw error;
  });
  const durationMs = performance.now() - start;
  await recordMetric('booking_api', durationMs);
  session = await api('/session');
  slots = [];
  notice = `${result.status === 'already_committed' ? 'Recovered your confirmed appointment.' : pending.intent === 'reschedule' ? 'Appointment moved successfully.' : 'Your appointment is confirmed.'}`;
}
function appointment(booking: Booking) {
  return `<div class="booking"><span class="eyebrow">CONFIRMED APPOINTMENT</span><h3>${escape(services.find((s) => s.id === booking.service_id)?.name)}</h3><p>${escape(format(booking.starts_at))}</p><small>${escape(timezone)} · ${escape(booking.visitor_name)}</small><div class="reference"><span>Booking reference</span><strong>${escape(booking.reference)}</strong></div></div>`;
}
function render() {
  if (!user) { renderAuth(); return; }
  const state = session?.state ?? {};
  const selected = state.selectedSlot;
  const complete = Boolean(state.booking && !state.confirmed && state.pendingOperationId);
  const service = services.find((s) => s.id === state.serviceId);
  const visibleSlots = slots.slice(page * 3, page * 3 + 3);
  const voiceLabel = voice.status === 'requesting_microphone' ? 'Allow microphone access' : voice.status === 'waiting' ? 'Waiting for receptionist' : voice.status.charAt(0).toUpperCase() + voice.status.slice(1);
  root.innerHTML = `
    <header><a class="brand" href="/" aria-label="Juniper home"><span class="brand-mark" aria-hidden="true">j.</span> juniper<span class="brand-caption">A LITTLE TIME FOR YOU</span></a><div class="account-menu"><span>${escape(user.username)}</span><button id="logout" class="text-button" ${busy ? 'disabled' : ''}>Log out</button></div></header>
    <main><div class="intro"><div><span class="eyebrow">LESS PLANNING. MORE LIVING.</span><h1>Your time.<br><em>Taken care of.</em></h1><p>A real conversation. A time that works.<br>Your personal receptionist handles the details.</p></div><div class="business-note"><span class="hours-icon" aria-hidden="true">◷</span><div>Here when you need us.<small>Monday–Friday, 9 am–5 pm<br>${escape(timezone)}</small></div></div></div>
    <div class="workspace"><section class="conversation"><div class="section-top"><div><span class="eyebrow">MEET YOUR RECEPTIONIST</span><h2>${state.intent === 'reschedule' ? 'A new time, same care.' : 'Let’s make a little time.'}</h2></div><span class="connection"><i></i>${sessionExpired ? 'Session expired' : busy ? 'Working' : session ? 'Connected' : 'Connecting'}</span></div>
      <div class="voice-preview ${voice.active ? 'voice-active' : ''}"><div class="orb"><span></span><span></span><span></span><span></span><span></span></div><div><strong>${voice.active ? escape(voiceLabel) : 'Talk to Juniper.'}</strong><p>${voice.active ? voice.status === 'requesting_microphone' ? 'Choose Allow in the browser microphone prompt.<br>End conversation cancels this attempt.' : voice.status === 'waiting' ? 'Audio connected. Waiting for receptionist to join.<br>Keep the voice worker running in your terminal.' : 'Take your time. Speak naturally.<br>You can interrupt whenever you need.' : voiceReady ? 'Tell us what you need. We’ll find your time.<br>Your microphone starts only when you do.' : 'Voice is unavailable right now.<br>You can still book using the form below.'}</p></div><button id="voice-start" ${!voiceReady || !session || busy || sessionExpired ? 'disabled' : ''}>${voice.active ? 'End conversation' : 'Start conversation'}</button></div>
      ${voice.active || transcript.length ? `<section class="transcripts" aria-label="Live conversation"><div class="slot-heading"><span class="eyebrow">LIVE TRANSCRIPT</span><small>Your conversation, as it happens</small></div><div class="transcript-lines">${transcript.map((line) => `<p class="transcript-line ${escape(line.role)}"><strong>${line.role === 'user' ? 'You' : 'Juniper'}</strong><span>${escape(line.text)}</span></p>`).join('')}${partial ? `<p class="transcript-line partial"><strong>You · partial</strong><span>${escape(partial)}</span></p>` : ''}</div>${voice.active ? '<button id="speaker" class="text-button">Enable speaker</button><button id="voice-reconnect" class="text-button">Reconnect conversation</button>' : ''}</section>` : ''}
      ${sessionExpired ? `<div class="notice" role="status">${escape(notice || expiryNotice)}</div>` : ''}<fieldset class="manual-flow" ${voice.active || sessionExpired ? 'disabled' : ''}>
      <div class="form-intro"><span class="eyebrow">OR, TAKE THE QUIET ROUTE</span><p>A few details. Your next visit.</p></div><div class="tabs"><button id="book-tab" class="${state.intent !== 'reschedule' ? 'active' : ''}" ${busy ? 'disabled' : ''}>Book an appointment</button><button id="move-tab" class="${state.intent === 'reschedule' ? 'active' : ''}" ${busy ? 'disabled' : ''}>Move an appointment</button></div>
      ${resumed ? '<div class="resume-note">Welcome back. Your saved request is ready to continue.</div>' : ''}
      ${notice && !sessionExpired ? `<div class="notice" role="status">${escape(notice)}</div>` : ''}
      ${state.intent === 'reschedule' && !state.reference ? `<form id="lookup-form"><label>Booking reference<input id="reference" placeholder="VA-…" required maxlength="80" autocomplete="off"></label><button class="primary" ${busy ? 'disabled' : ''}>Find appointment</button></form>` : `
      <form id="search-form"><div class="form-row"><label>Service<select id="service" ${state.intent === 'reschedule' ? 'disabled' : ''}>${services.map((s) => `<option value="${escape(s.id)}" ${state.serviceId === s.id ? 'selected' : ''}>${escape(s.name)} · ${s.duration_minutes} min</option>`).join('')}</select></label><label>Preferred date<input id="date" type="date" value="${escape(state.date ?? dateInZone())}" required></label></div><label>Your name<input id="name" placeholder="e.g. Alex Demo" value="${escape(state.visitorName ?? '')}" required maxlength="80" autocomplete="off" ${state.intent === 'reschedule' ? 'readonly' : ''}></label><button class="primary" ${busy ? 'disabled' : ''}>Find available times <span aria-hidden="true">↗</span></button></form>
      ${visibleSlots.length ? `<div class="slot-section"><div class="slot-heading"><span class="eyebrow">AVAILABLE TIMES</span><small>Provisional until confirmed</small></div><div class="slots">${visibleSlots.map((slot) => `<button class="slot ${selected === slot.start ? 'selected' : ''}" data-slot="${escape(slot.start)}" ${busy ? 'disabled' : ''}><strong>${escape(new Intl.DateTimeFormat('en', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(new Date(slot.start)))}</strong><small>${escape(service?.duration_minutes ?? services[0]?.duration_minutes)} min</small></button>`).join('')}</div><div class="paging"><span>${page * 3 + 1}–${Math.min(page * 3 + 3, slots.length)} of ${slots.length} times</span><button id="prev" ${page === 0 || busy ? 'disabled' : ''}>Previous</button><button id="next" ${(page + 1) * 3 >= slots.length || busy ? 'disabled' : ''}>More times</button></div></div>` : ''}
      ${selected && !complete ? `<div class="confirm"><span class="eyebrow">REVIEW BEFORE WE ${state.intent === 'reschedule' ? 'MOVE' : 'BOOK'}</span><h3>${escape(service?.name)} · ${escape(state.visitorName)}</h3>${state.intent === 'reschedule' && state.booking ? `<p class="old-time">From ${escape(format(state.booking.starts_at))}</p>` : ''}<p>${escape(format(selected))}<br><small>${escape(timezone)}</small></p><button id="confirm" class="primary" ${busy ? 'disabled' : ''}>${state.confirmed ? 'Retry confirmed request' : state.intent === 'reschedule' ? 'Yes, move my appointment' : 'Yes, book this appointment'}</button><small>We only save an appointment after you confirm.</small></div>` : ''}`}
      </fieldset><div class="privacy">A fictional studio. Please use a demo name. Audio is not recorded.</div>
    </section><aside><section class="progress-card"><span class="eyebrow">YOUR VISIT, AT A GLANCE</span><h2>A little space<br>in your day.</h2><ol class="steps"><li class="${state.serviceId ? 'done' : ''}"><span>01</span><div>Choose a service<small>${escape(service?.name ?? 'Your choice, your pace')}</small></div></li><li class="${selected ? 'done' : ''}"><span>02</span><div>Find your time<small>${selected ? escape(format(selected)) : 'Real availability, checked live'}</small></div></li><li class="${complete ? 'done' : ''}"><span>03</span><div>Make it official<small>${complete ? 'Confirmed and saved' : 'Confirm before anything changes'}</small></div></li></ol>${state.booking ? appointment(state.booking) : '<div class="empty-booking"><span>◷</span><p>A good time is waiting.<br>Your appointment will appear here.</p></div>'}<button class="text-button" id="new-request" ${busy || voice.active || !session ? 'disabled' : ''}>${sessionExpired ? 'Start a new session' : 'Start a new request'}</button><button id="reconnect" class="text-button secondary-link" ${busy || voice.active || sessionExpired ? 'disabled' : ''}>Restore saved progress</button></section>
      <section class="studio-note"><span class="eyebrow">GOOD TO KNOW</span><div><span>Studio hours</span><strong>Mon–Fri, 9 am–5 pm</strong></div><div><span>Your timezone</span><strong>${escape(timezone)}</strong></div><p>Plans change. Keep your booking reference handy to move your appointment.</p></section></aside></div>
    <footer><span>Good care starts with a little time.</span><span>Juniper Studio · A voice appointment demo</span></footer></main>`;
  root.querySelector('#logout')?.addEventListener('click', () => void run(async () => {
    await voice.stop(); await progressRefresh;
    await authRequest('/logout', {});
    localStorage.removeItem(sessionKey());
    user = undefined; sessionToken = ''; session = undefined!;
    slots = []; transcript = []; partial = ''; resumed = false; notice = '';
  }));
  const on = (selector: string, event: string, handler: () => void) => root.querySelector(selector)?.addEventListener(event, handler);
  root.querySelector('#search-form')?.addEventListener('submit', (event) => { event.preventDefault(); void run(search); });
  root.querySelector('#lookup-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const reference = root.querySelector<HTMLInputElement>('#reference')!.value.trim().toUpperCase();
    void run(async () => {
      const { booking } = await api<{ booking: Booking }>(`/bookings/${encodeURIComponent(reference)}`);
      await save({ intent: 'reschedule', reference: booking.reference, serviceId: booking.service_id, visitorName: booking.visitor_name, booking });
    });
  });
  on('#book-tab', 'click', () => void run(async () => { slots = []; await save({ intent: 'book' }); }));
  on('#move-tab', 'click', () => void run(async () => { slots = []; await save({ intent: 'reschedule' }); }));
  on('#new-request', 'click', () => void run(async () => {
    if (sessionExpired) await newSession();
    else { slots = []; resumed = false; await save({ intent: 'book' }); }
  }));
  on('#prev', 'click', () => { page--; render(); });
  on('#next', 'click', () => { page++; render(); });
  root.querySelectorAll<HTMLButtonElement>('[data-slot]').forEach((button) => button.addEventListener('click', () => void run(async () => {
    const { pendingOperationId: _pending, ...state } = session.state;
    await save({ ...state, selectedSlot: button.dataset.slot, confirmed: false });
  })));
  on('#confirm', 'click', () => void run(commit));
  on('#voice-start', 'click', () => {
    if (voice.active) void voice.stop().then(refreshVoiceProgress);
    else { notice = ''; void voice.start(); }
  });
  on('#speaker', 'click', () => void voice.enableSpeaker().catch(() => { notice = 'Speaker playback remains blocked. Check browser audio permission.'; render(); }));
  on('#voice-reconnect', 'click', () => void (async () => {
    await voice.stop(); await refreshVoiceProgress(); await voice.start();
  })());
  on('#reconnect', 'click', () => void run(async () => { await restore(); resumed = true; }));
}
async function restore() {
  const recovery = await recoverSession(api);
  session = recovery.session;
  if (recovery.recovered) notice = 'Recovered your confirmed appointment without creating another booking.';
  if (recovery.issue) notice = 'Your confirmed choice is no longer available. Please choose another time and confirm again.';
  const state = session.state;
  if (state.serviceId && state.date) {
    const result = await api<{ slots: Slot[] }>(`/availability?serviceId=${encodeURIComponent(state.serviceId)}&date=${encodeURIComponent(state.date)}${state.intent === 'reschedule' && state.reference ? `&reference=${encodeURIComponent(state.reference)}` : ''}`);
    const completed = Boolean(state.booking && state.pendingOperationId && !state.confirmed);
    slots = completed ? [] : result.slots; page = 0;
    if (!completed && !state.confirmed) {
      const updated = { ...state, offeredSlots: slots.map((s) => s.start), confirmed: false };
      if (state.selectedSlot && !slots.some((s) => new Date(s.start).getTime() === new Date(state.selectedSlot!).getTime())) {
        delete updated.selectedSlot;
        notice = 'Your previous choice is no longer available. Please choose another time.';
      }
      await save(updated);
    }
  }
}
async function loadBooking() {
  sessionToken = localStorage.getItem(sessionKey()) ?? '';
  try {
    const config = await api<{ services: Service[]; timezone: string }>('/services');
    services = config.services; timezone = config.timezone;
    const voiceConfig = await api<{ ready: boolean; missing: string[] }>('/voice/config').catch(() => ({ ready: false, missing: ['voice API'] }));
    voiceReady = voiceConfig.ready;
    if (sessionToken) {
      try { await restore(); resumed = Boolean(Object.keys(session.state).length); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'session_expired') throw error;
        sessionToken = ''; localStorage.removeItem(sessionKey());
      }
    }
    if (!sessionToken) {
      await newSession();
      if (!sessionExpired) notice = '';
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'authentication_required') { user = undefined; sessionToken = ''; notice = 'Please log in to continue.'; }
    else notice = 'Booking service unavailable. Reload this page to try again.';
  }
  render();
}
async function authRequest(path: string, body?: unknown) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-VoiceAI-Auth': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.status || 'connection_failed');
    return result as { user: { id: string; username: string } };
  } finally { clearTimeout(timer); }
}
function renderAuth() {
  const signup = authMode === 'signup';
  root.innerHTML = `<header><a class="brand" href="/" aria-label="Juniper home"><span class="brand-mark" aria-hidden="true">j.</span> juniper</a><span class="demo-badge">Juniper Studio</span></header>
    <main class="auth-page"><section class="conversation auth-card" aria-labelledby="auth-title">
      <span class="eyebrow">A LITTLE TIME FOR YOU</span>
      <h1 id="auth-title">${signup ? 'Make yourself<br><em>at home.</em>' : 'Welcome<br><em>back.</em>'}</h1>
      <p>${signup ? 'Create an account to book your next visit.' : 'Log in to make a little time for yourself.'}</p>
      <div class="tabs" role="group" aria-label="Account access"><button type="button" id="login-tab" class="${signup ? '' : 'active'}" ${busy || authLoading ? 'disabled' : ''}>Log in</button><button type="button" id="signup-tab" class="${signup ? 'active' : ''}" ${busy || authLoading ? 'disabled' : ''}>Sign up</button></div>
      ${notice ? `<div class="notice" role="alert">${escape(notice)}</div>` : ''}
      ${authLoading ? '<p role="status">Checking your account…</p>' : `<form id="auth-form">
        <label for="username">Username<input id="username" name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[a-zA-Z0-9_]+" autocapitalize="none" spellcheck="false" aria-describedby="username-help"></label>
        <small id="username-help" class="auth-help">3–32 letters, numbers or underscores. Usernames are case-insensitive.</small>
        <label for="password">Password<input id="password" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="8" maxlength="128" aria-describedby="password-help"></label>
        <small id="password-help" class="auth-help">Use 8–128 characters.</small>
        <button class="primary" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : signup ? 'Create account' : 'Log in'}</button>
      </form>`}
    </section></main>`;
  for (const mode of ['login', 'signup'] as const) root.querySelector(`#${mode}-tab`)?.addEventListener('click', () => {
    authMode = mode; notice = ''; render(); root.querySelector<HTMLInputElement>('#username')?.focus();
  });
  root.querySelector('#auth-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const username = root.querySelector<HTMLInputElement>('#username')!.value;
    const password = root.querySelector<HTMLInputElement>('#password')!.value;
    busy = true; notice = '';
    const submit = root.querySelector<HTMLButtonElement>('#auth-form button')!;
    submit.disabled = true; submit.textContent = 'Please wait…';
    root.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((button) => { button.disabled = true; });
    void (async () => {
      try {
        ({ user } = await authRequest(`/${authMode}`, { username, password }));
        await loadBooking();
      } catch (error) {
        const reason = error instanceof Error ? error.message : '';
        notice = ({ username_taken: 'That username is already taken. Choose another or log in.',
          invalid_credentials: 'Username or password is incorrect.',
          invalid_request: 'Check your username and password requirements.',
          too_many_attempts: 'Too many attempts. Please try again in 15 minutes.' } as Record<string, string>)[reason] ?? 'Could not reach the service. Please try again.';
      } finally { busy = false; render(); }
    })();
  });
}
async function init() {
  render();
  try { ({ user } = await authRequest('/me')); }
  catch (error) {
    if (!(error instanceof Error) || error.message !== 'authentication_required') notice = 'Could not reach the service. Please try again.';
  }
  authLoading = false;
  if (user) await loadBooking();
  render();
}
void init();
setInterval(() => { if (voice.active) void refreshVoiceProgress(); }, 2000);
window.addEventListener('pagehide', () => { void voice.stop(); });
