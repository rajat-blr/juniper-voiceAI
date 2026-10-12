import type { Room, LocalAudioTrack } from 'livekit-client';

export type VoiceStatus = 'idle' | 'requesting_microphone' | 'connecting' | 'waiting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting';
export interface VoiceEvent { type: string; role?: 'user' | 'agent'; text?: string; final?: boolean; state?: string; message?: string; fatal?: boolean }
export class VoiceConnection {
  room?: Room;
  microphone?: LocalAudioTrack;
  status: VoiceStatus = 'idle';
  private audio = new Set<HTMLMediaElement>();
  private context?: AudioContext;
  private frame = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private waitingTimer?: ReturnType<typeof setTimeout>;
  private startupTimer?: ReturnType<typeof setTimeout>;
  private lastSpeech = 0;
  private awaitingReply = false;
  private lastOutput = 0;
  private interruptionStart = 0;
  private meters: { analyser: AnalyserNode; samples: Float32Array<ArrayBuffer>; source: MediaStreamAudioSourceNode; input: boolean }[] = [];
  private generation = 0;
  constructor(private getCredentials: () => Promise<{ serverUrl: string; participantToken: string; maxDurationSeconds: number; receptionistTimeoutSeconds?: number }>,
    private event: (event: VoiceEvent) => void,
    private metric: (stage: 'audible_reply' | 'interruption' | 'reconnect' | 'connection', durationMs: number, result?: 'ok' | 'error') => void,
    private changed: () => void,
    private options: { loadClient?: () => Promise<typeof import('livekit-client')>; startupTimeoutMs?: number } = {}) {}
  get active() { return this.status !== 'idle'; }

  async start() {
    if (this.active) return;
    const generation = ++this.generation;
    const started = performance.now();
    let stage = 'microphone';
    this.status = 'connecting'; this.changed();
    this.startupTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.metric('connection', performance.now() - started, 'error');
      this.event({ type: 'error', message: stage === 'microphone'
        ? 'Microphone request timed out. Choose Allow in the browser microphone prompt, then start conversation again.'
        : `Voice startup timed out at ${stage}. Your booking progress is saved. Start conversation again.` });
      void this.stop();
    }, this.options.startupTimeoutMs ?? 60_000);
    try {
      const { Room, RoomEvent, Track, createLocalAudioTrack } = await (this.options.loadClient?.() ?? import('livekit-client'));
      if (generation !== this.generation) return;
      // Capture only after the visitor presses Start. Keys never reach the browser.
      this.status = 'requesting_microphone'; this.changed();
      const microphone = await createLocalAudioTrack({
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      });
      if (generation !== this.generation) { microphone.stop(); return; }
      this.microphone = microphone;
      this.status = 'connecting'; this.changed();
      stage = 'booking API';
      const credentials = await this.getCredentials();
      if (generation !== this.generation) return;
      this.context = new AudioContext(); await this.context.resume();
      if (generation !== this.generation) return;
      this.addMeter(new MediaStream([microphone.mediaStreamTrack]), true);
      const room = new Room(); this.room = room;
      let receptionistReady = false;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (generation !== this.generation || this.room !== room) return;
        if (track.kind !== Track.Kind.Audio) return;
        const audio = track.attach(); audio.hidden = true; document.body.append(audio); this.audio.add(audio);
        if (track.mediaStreamTrack) this.addMeter(new MediaStream([track.mediaStreamTrack]), false);
        void audio.play().catch(() => this.event({ type: 'error', message: 'Audio playback blocked. Press Enable speaker to hear the receptionist.' }));
      });
      room.on(RoomEvent.DataReceived, (data, participant, _kind, topic) => {
        if (generation !== this.generation || this.room !== room) return;
        if (topic !== 'voiceai' || participant?.identity === room.localParticipant.identity || !participant) return;
        try {
          const event = JSON.parse(new TextDecoder().decode(data)) as VoiceEvent;
          if (event.type === 'agent_state' && ['listening', 'thinking', 'speaking'].includes(event.state ?? '')) {
            if (!receptionistReady) this.metric('connection', performance.now() - started);
            receptionistReady = true;
            this.status = event.state as VoiceStatus;
            if (this.waitingTimer) clearTimeout(this.waitingTimer);
            if (event.state === 'speaking') for (const audio of this.audio) void audio.play().catch(() => {});
          }
          this.event(event); this.changed();
          if (event.type === 'error' && event.fatal === true) void this.stop();
        } catch { /* Ignore malformed provider packets without exposing their contents. */ }
      });
      let reconnectStart = 0;
      room.on(RoomEvent.Reconnecting, () => {
        if (generation !== this.generation || this.room !== room) return;
        reconnectStart = performance.now(); this.status = 'reconnecting'; this.changed();
      });
      room.on(RoomEvent.Reconnected, () => {
        if (generation !== this.generation || this.room !== room) return;
        this.status = 'listening'; this.metric('reconnect', performance.now() - reconnectStart); this.event({ type: 'progress' }); this.changed();
      });
      let connected = false;
      room.on(RoomEvent.Disconnected, () => {
        // connect() rejects with the specific cause on initial connection failure.
        // Let its catch own cleanup so a disconnect cannot hide that error.
        if (this.room === room && connected) {
          this.event({ type: 'error', message: 'Voice connection closed. Your booking progress is saved. Start again to reconnect.' });
          void this.stop();
        }
      });
      stage = 'LiveKit connection';
      await room.connect(credentials.serverUrl, credentials.participantToken);
      if (generation !== this.generation) { await room.disconnect(); return; }
      connected = true;
      stage = 'microphone publication';
      await room.localParticipant.publishTrack(microphone);
      if (generation !== this.generation) return;
      if (this.startupTimer) clearTimeout(this.startupTimer);
      if (!receptionistReady) this.status = 'waiting';
      this.changed();
      this.monitor();
      this.timer = setTimeout(() => {
        this.event({ type: 'error', message: 'Five-minute demo limit reached. Your booking progress is saved.' });
        void this.stop();
      }, credentials.maxDurationSeconds * 1000);
      if (!receptionistReady) this.waitingTimer = setTimeout(() => {
        this.metric('connection', performance.now() - started, 'error');
        this.event({ type: 'error', message: 'Receptionist did not become ready. Run npm run dev:agent in a terminal and check its startup log, then start conversation again.' });
        void this.stop();
      }, Math.min(120, Math.max(10, credentials.receptionistTimeoutSeconds ?? 30)) * 1000);
    } catch (error) {
      if (generation !== this.generation) return;
      this.metric('connection', performance.now() - started, 'error');
      const failure = error as { reasonName?: string; status?: number };
      const details = [failure?.reasonName?.replace(/[^A-Za-z0-9_]/g, ''),
        typeof failure?.status === 'number' ? `HTTP ${failure.status}` : ''].filter(Boolean).join(', ');
      await this.stop();
      const reason = error instanceof Error ? error.name : 'Error';
      const outcome = error instanceof Error ? error.message : '';
      if (outcome === 'voice_demo_limit' || outcome === 'voice_session_limit') {
        this.event({ type: 'error', message: 'Voice demo limit reached. You can still book with the form or try voice later.' });
        return;
      }
      this.event({ type: 'error', message: stage === 'LiveKit connection' && failure?.status === 401
        ? 'LiveKit rejected the connection token (HTTP 401). Check that LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET come from the same project, then restart the API and voice worker.'
        : reason === 'NotAllowedError'
        ? 'Microphone access denied. Allow microphone access in browser settings, then press Start conversation again.'
        : reason === 'NotFoundError' || reason === 'OverconstrainedError'
          ? 'No microphone available. Check your browser and system input settings, then start again.'
          : `Could not start voice at ${stage}${details ? ` (${details})` : ''}. Check the LiveKit project and Python agent, then try again.` });
    }
  }
  private addMeter(stream: MediaStream, input: boolean) {
    if (!this.context) return;
    const source = this.context.createMediaStreamSource(stream);
    const analyser = this.context.createAnalyser(); analyser.fftSize = 512; source.connect(analyser);
    // Keep the analysis graph active without playing the microphone or doubling audio.
    const silent = this.context.createGain(); silent.gain.value = 0;
    analyser.connect(silent); silent.connect(this.context.destination);
    this.meters.push({ source, analyser, samples: new Float32Array(analyser.fftSize), input });
  }
  private monitor = () => {
    if (!this.active) return;
    const now = performance.now();
    for (const meter of this.meters) {
      meter.analyser.getFloatTimeDomainData(meter.samples);
      const rms = Math.sqrt(meter.samples.reduce((sum, value) => sum + value * value, 0) / meter.samples.length);
      if (rms < 0.015) continue;
      if (meter.input) {
        this.lastSpeech = now; this.awaitingReply = true;
        if (this.status === 'speaking' && this.lastOutput > 0 && now - this.lastOutput < 200 && !this.interruptionStart)
          this.interruptionStart = now;
      }
      else {
        if (this.room?.canPlaybackAudio && this.awaitingReply && now - this.lastSpeech > 150) {
          this.awaitingReply = false;
          this.metric('audible_reply', now - this.lastSpeech);
        }
        this.lastOutput = now;
      }
    }
    if (this.interruptionStart && now - this.lastOutput > 80) {
      this.metric('interruption', now - this.interruptionStart);
      this.interruptionStart = 0;
    } else if (this.interruptionStart && now - this.interruptionStart > 2500) this.interruptionStart = 0;
    this.frame = requestAnimationFrame(this.monitor);
  };
  async enableSpeaker() { await this.room?.startAudio(); for (const audio of this.audio) await audio.play(); }
  async stop() {
    ++this.generation;
    this.status = 'idle';
    if (this.timer) clearTimeout(this.timer);
    if (this.waitingTimer) clearTimeout(this.waitingTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    cancelAnimationFrame(this.frame);
    const room = this.room; this.room = undefined;
    // Detach the old room before ending capture so late packets cannot update
    // a replacement session's status or transcript.
    room?.removeAllListeners();
    this.microphone?.stop(); this.microphone = undefined;
    try { await room?.disconnect(); }
    catch { /* Local cleanup must finish even if the old room is unreachable. */ }
    for (const audio of this.audio) audio.remove(); this.audio.clear();
    for (const meter of this.meters) meter.source.disconnect(); this.meters = [];
    try { await this.context?.close(); }
    catch { /* The audio context may already have closed during another stop. */ }
    this.context = undefined;
    this.awaitingReply = false; this.lastSpeech = 0; this.lastOutput = 0; this.interruptionStart = 0;
    this.changed();
  }
}
