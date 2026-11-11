import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../renderer.mjs', import.meta.url), 'utf8');
const playbackCode = source.slice(source.indexOf('function showReply('), source.indexOf('\nasync function startRecording('));
const eventStart = source.indexOf('let audioQueue = Promise.resolve();');
const eventCode = source.slice(eventStart, source.indexOf('\nwindow.addEventListener(', eventStart));

function player(voice = true) {
  const log = { messages: [], actions: [], timers: [], buffers: [], sources: [], labels: [] };
  class FakeAudioContext {
    currentTime = 0;
    destination = {};
    createGain() { return { gain: { value: 0 }, connect() {} }; }
    async resume() {}
    createBuffer(_channels, length, rate) {
      const buffer = { data: new Float32Array(length), duration: length / rate,
        copyToChannel(samples, _channel, offset = 0) { this.data.set(samples, offset); } };
      log.buffers.push(buffer); return buffer;
    }
    createBufferSource() {
      const node = { connect() {}, start(at) { this.started = at; }, stop() { this.stopped = true; } };
      log.sources.push(node); return node;
    }
  }
  const context = { log, AudioContext: FakeAudioContext, Float32Array, Uint8Array, DataView,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout(fn, delay) { const timer = { fn, delay, cancelled: false }; log.timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    message: (text, kind) => log.messages.push({ text, kind }), action: value => log.actions.push(value),
    bubble() {}, state() {}, label: text => log.labels.push(text), stopRecording() {}, applySettings() {},
    api: { onEvent(fn) { context.emit = fn; } } };
  vm.createContext(context);
  vm.runInContext(`let settings = { voice: ${voice}, volume: 1 }, recording, mode = 'idle', connected, phase, latestReply, pendingReply, replyTimer;
    let playback, gain, sources = [], audioGeneration = -1, audioEnd = false, audioTime = 0;
    ${playbackCode}\n${eventCode}`, context);
  return { ...context, flush: () => vm.runInContext('audioQueue', context) };
}
const reply = { type: 'reply', texts: ['你好'], outbound_id: 'one', generation: 1 };

test('text appears when speech begins and the first PCM is preserved after preroll', async () => {
  const p = player();
  p.emit(reply);
  assert.equal(p.log.messages.length, 0);
  assert.equal(p.log.actions[0].operation, 'speak');
  p.emit({ type: 'audio_stop' });
  p.emit({ type: 'audio_start', generation: 1 });
  p.emit({ type: 'audio_chunk', generation: 1, pcm: Buffer.from([0, 64, 0, 192]).toString('base64') });
  await p.flush();
  assert.equal(p.log.messages.length, 0);
  const buffer = p.log.buffers[0];
  assert.equal(buffer.data.length, 6002);
  assert.ok(buffer.data.slice(0, 6000).every(value => value === 0));
  assert.deepEqual([...buffer.data.slice(6000)], [0.5, -0.5]);
  assert.ok(Math.abs(p.log.timers.at(-1).delay - 285) < 1);
  p.emit({ type: 'audio_chunk', generation: 1, pcm: Buffer.from([0, 32]).toString('base64') });
  await p.flush();
  assert.equal(p.log.buffers[1].data.length, 1);
  assert.equal(p.log.buffers[1].data[0], 0.25);
  p.log.timers.at(-1).fn();
  assert.equal(p.log.messages[0].text, '你好');
  assert.equal(p.log.actions.at(-1).operation, 'ack');
  p.emit({ type: 'audio_end', generation: 1, outbound_id: 'one', complete: true });
  await p.flush();
  p.log.sources[0].onended();
  p.log.sources[1].onended();
  assert.equal(p.log.actions.at(-1).operation, 'audio_receipt');
  assert.equal(p.log.actions.at(-1).complete, true);
});

test('failed audio shows the text; interruption before speech does not reveal it', async () => {
  const failed = player();
  failed.emit(reply); failed.emit({ type: 'audio_start', generation: 1 });
  failed.emit({ type: 'audio_end', generation: 1, outbound_id: 'one', complete: false });
  await failed.flush();
  assert.equal(failed.log.messages[0].text, '你好');
  assert.equal(failed.log.actions.some(value => value.operation === 'ack'), true);
  const interrupted = player();
  interrupted.emit(reply); interrupted.emit({ type: 'cancelled' });
  interrupted.emit({ type: 'audio_start', generation: 1 });
  interrupted.emit({ type: 'audio_chunk', generation: 1, pcm: Buffer.from([1, 0]).toString('base64') });
  await interrupted.flush();
  assert.equal(interrupted.log.messages.length, 0);
  assert.equal(interrupted.log.buffers.length, 0);
});

test('text-only replies remain immediate', () => {
  const p = player(false);
  p.emit(reply);
  assert.equal(p.log.messages[0].text, '你好');
  assert.equal(p.log.actions[0].operation, 'ack');
  assert.equal(p.log.actions.some(value => value.operation === 'speak'), false);
});
