import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Room, LocalAudioTrack } from 'livekit-client';
import { VoiceConnection } from '../apps/web/src/voice.js';

test('stopping an unreachable room detaches its events and releases the microphone for a new session', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  try {
    const events: string[] = [];
    const voice = new VoiceConnection(async () => { throw new Error('No connection expected'); }, () => {}, () => {}, () => events.push('changed'));
    voice.status = 'speaking';
    voice.room = { removeAllListeners: () => events.push('detach'), disconnect: async () => {
      events.push('disconnect'); throw new Error('Room unreachable');
    } } as unknown as Room;
    voice.microphone = { stop: () => events.push('microphone stopped') } as unknown as LocalAudioTrack;
    await voice.stop();
    assert.deepEqual(events, ['detach', 'microphone stopped', 'disconnect', 'changed']);
    assert.equal(voice.status, 'idle'); assert.equal(voice.active, false);
    assert.equal(voice.room, undefined); assert.equal(voice.microphone, undefined);
    await voice.stop();
    assert.equal(events.filter((event) => event === 'microphone stopped').length, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'cancelAnimationFrame', original);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});

test('pending microphone permission times out and a late grant stops capture without connecting', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  try {
    let grant!: (track: LocalAudioTrack) => void;
    let ended!: () => void;
    const stopped = new Promise<void>((resolve) => { ended = resolve; });
    let credentials = 0; let captureStops = 0;
    const messages: string[] = [];
    const outcomes: (string | undefined)[] = [];
    const client = { createLocalAudioTrack: () => new Promise<LocalAudioTrack>((resolve) => { grant = resolve; }) } as unknown as typeof import('livekit-client');
    const voice = new VoiceConnection(async () => { credentials++; throw new Error('Must not connect'); },
      (event) => { if (event.message) messages.push(event.message); }, (_stage, _duration, result) => outcomes.push(result),
      () => { if (voice.status === 'idle') ended(); }, { loadClient: async () => client, startupTimeoutMs: 15 });
    const pending = voice.start();
    await stopped;
    assert.equal(voice.active, false);
    assert.match(messages[0], /Microphone request timed out/);
    assert.deepEqual(outcomes, ['error']);
    grant({ stop: () => { captureStops++; } } as unknown as LocalAudioTrack);
    await pending;
    assert.equal(credentials, 0); assert.equal(captureStops, 1);
    assert.equal(voice.microphone, undefined);
  } finally {
    if (original) Object.defineProperty(globalThis, 'cancelAnimationFrame', original);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});

test('microphone denial has a retry message and does not request connection credentials', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame');
  Object.defineProperty(globalThis, 'cancelAnimationFrame', { configurable: true, value: () => {} });
  try {
    let credentials = 0; const messages: string[] = [];
    const client = { createLocalAudioTrack: async () => { throw new DOMException('Permission denied', 'NotAllowedError'); } } as unknown as typeof import('livekit-client');
    const voice = new VoiceConnection(async () => { credentials++; throw new Error('Must not connect'); },
      (event) => { if (event.message) messages.push(event.message); }, () => {}, () => {}, { loadClient: async () => client });
    await voice.start();
    assert.equal(voice.status, 'idle'); assert.equal(credentials, 0);
    assert.match(messages[0], /Microphone access denied/);
    assert.match(messages[0], /Start conversation again/);
  } finally {
    if (original) Object.defineProperty(globalThis, 'cancelAnimationFrame', original);
    else Reflect.deleteProperty(globalThis, 'cancelAnimationFrame');
  }
});
