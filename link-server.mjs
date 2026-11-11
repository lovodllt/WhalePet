import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';
import { MAX_LINK_MESSAGE_BYTES, MAX_LINK_DISPLAYS } from './shared.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const profilePath = process.env.DWORLD_PET_LINK_FILE;
if (!profilePath) throw new Error('DWORLD_PET_LINK_FILE is required');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const secret = Buffer.from(profile.token || '');
if (secret.length < 40) throw new Error('Invalid link token');
const port = Number(new URL(profile.url).port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid link port');

const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_LINK_MESSAGE_BYTES });
let activeBridge;
server.on('upgrade', (request, socket, head) => {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
  if (request.url !== '/pet' || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  if (activeBridge || sockets.clients.size) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
});

const eventTypes = new Set([
  'connected', 'status', 'thinking', 'accepted', 'reply', 'quiet', 'error', 'cancelled',
  'observed', 'observation_finished', 'transcript', 'asr_ready', 'asr_speech_start', 'asr_error',
  'audio_start', 'audio_chunk', 'audio_end', 'audio_stop'
]);
const simpleOperations = new Set(['status', 'interrupt', 'pause_observation', 'mic_start', 'mic_stop', 'audio_stop']);
const replyOperations = new Set(['ack', 'speak', 'audio_receipt']);
const base64 = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit
  && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
const validText = value => typeof value === 'string' && value.length <= 4000 && value.trim();
const validMessageId = value => typeof value === 'string' && value.length > 0 && value.length <= 120;
const optionalBoolean = value => value === undefined || typeof value === 'boolean';

function screenFor(frame) {
  if (!frame || typeof frame.display_id !== 'string' || !frame.display_id || frame.display_id.length > 64
      || !Number.isFinite(frame.captured_at) || !Number.isFinite(frame.scale_factor) || frame.scale_factor <= 0
      || !base64(frame.jpeg, 3 * 1024 * 1024)) return;
  const { x, y, width, height } = frame.bounds || {};
  if (![x, y, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0) return;
  return { display_id: frame.display_id, captured_at: frame.captured_at,
    scale_factor: frame.scale_factor, bounds: { x, y, width, height }, jpeg: frame.jpeg };
}

function commandFor(value, reply) {
  if (!value || typeof value !== 'object') return;
  if (simpleOperations.has(value.operation)) return { operation: value.operation };
  if (value.operation === 'input' && validText(value.text) && validMessageId(value.message_id)
      && optionalBoolean(value.clear_screen) && optionalBoolean(value.wait_for_screen))
    return { operation: 'input', text: value.text, message_id: value.message_id,
      clear_screen: value.clear_screen, wait_for_screen: value.wait_for_screen };
  if (value.operation === 'screen_unavailable' && validMessageId(value.message_id))
    return { operation: 'screen_unavailable', message_id: value.message_id };
  if (value.operation === 'observe' && Array.isArray(value.screens) && value.screens.length > 0
      && value.screens.length <= MAX_LINK_DISPLAYS && typeof value.manual === 'boolean' && typeof value.may_speak === 'boolean'
      && optionalBoolean(value.submitted)
      && (value.submitted ? value.manual && validMessageId(value.message_id) : value.message_id === undefined)
      && (value.text === undefined || (value.manual && validText(value.text)))) {
    const screens = value.screens.map(screenFor);
    if (screens.every(Boolean) && new Set(screens.map(frame => frame.display_id)).size === screens.length)
      return { operation: 'observe', screens, manual: value.manual, text: value.text, may_speak: value.may_speak,
        message_id: value.message_id, submitted: value.submitted };
  }
  if (value.operation === 'pcm' && base64(value.pcm, 65536) && Buffer.from(value.pcm, 'base64').length % 2 === 0)
    return { operation: 'pcm', pcm: value.pcm };
  if (!reply || typeof value.outbound_id !== 'string' || value.outbound_id !== reply.outbound_id) return;
  if (value.operation === 'ack'
      && Number.isInteger(value.index) && value.index >= 0 && value.index < 100)
    return { operation: 'ack', outbound_id: value.outbound_id, index: value.index };
  if (value.operation === 'speak' && Number.isInteger(value.generation) && value.generation === reply.generation)
    return { operation: 'speak', outbound_id: value.outbound_id, generation: value.generation, delivery: reply.delivery };
  if (value.operation === 'audio_receipt' && typeof value.complete === 'boolean')
    return { operation: 'audio_receipt', outbound_id: value.outbound_id, complete: value.complete };
}

sockets.on('connection', ws => {
  const child = spawn(process.env.DWORLD_PYTHON || 'python3', [join(root, 'bridge.py')], {
    cwd: dirname(root), stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  activeBridge = child;
  let lastReply, alive = true;
  const heartbeat = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || !alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15000);
  ws.on('pong', () => { alive = true; });
  child.stdin.on('error', () => ws.close(1011));
  child.on('error', () => ws.close(1011));
  child.on('close', () => { activeBridge = undefined; ws.close(1011); });
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'reply') {
        lastReply = { outbound_id: event.outbound_id, generation: event.generation, delivery: event.delivery };
        delete event.delivery;
      }
      if (eventTypes.has(event.type) && ws.readyState === WebSocket.OPEN) {
        if (ws.bufferedAmount > MAX_LINK_MESSAGE_BYTES) return ws.terminate();
        ws.send(JSON.stringify(event));
      }
    } catch { ws.close(1011); }
  });
  ws.on('message', (raw, isBinary) => {
    try {
      if (isBinary) return ws.close(1008, 'Expected JSON text');
      const value = JSON.parse(raw.toString());
      // A newer reply may be on the wire while the client acknowledges the previous one.
      if (replyOperations.has(value?.operation) && value.outbound_id !== lastReply?.outbound_id) return;
      const command = commandFor(value, lastReply);
      if (!command) return ws.close(1008, 'Unsupported operation');
      if (child.stdin.writableLength > MAX_LINK_MESSAGE_BYTES) return ws.terminate();
      child.stdin.write(JSON.stringify(command) + '\n');
    } catch { ws.close(1008, 'Invalid request'); }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    clearInterval(heartbeat);
    if (child.stdin.writable) child.stdin.end('{"operation":"close"}\n');
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000).unref();
  });
});
server.listen(port, '127.0.0.1', () => console.log('Private desktop link is listening.'));
