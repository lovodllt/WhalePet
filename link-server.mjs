import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { WebSocketServer, WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
const profilePath = process.env.DWORLD_PET_LINK_FILE;
if (!profilePath) throw new Error('DWORLD_PET_LINK_FILE is required');
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const secret = Buffer.from(profile.token || '');
if (secret.length < 40) throw new Error('Invalid link token');
const port = Number(new URL(profile.url).port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid link port');

const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
const sockets = new WebSocketServer({ noServer: true, maxPayload: 32768 });
server.on('upgrade', (request, socket, head) => {
  const supplied = Buffer.from(request.headers.authorization?.replace(/^Bearer /, '') || '');
  if (request.url !== '/pet' || supplied.length !== secret.length || !timingSafeEqual(supplied, secret)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    return;
  }
  if (sockets.clients.size) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
    return;
  }
  sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
});

const eventTypes = new Set(['connected', 'status', 'thinking', 'accepted', 'reply', 'quiet', 'error', 'cancelled']);
function commandFor(value) {
  if (!value || typeof value !== 'object') return;
  if (value.operation === 'status' || value.operation === 'interrupt') return { operation: value.operation };
  if (value.operation === 'input' && typeof value.text === 'string' && value.text.trim() && value.text.length <= 4000
      && typeof value.message_id === 'string' && value.message_id.length > 0 && value.message_id.length <= 120)
    return { operation: 'input', text: value.text, message_id: value.message_id };
  if (value.operation === 'ack' && typeof value.outbound_id === 'string' && value.outbound_id.length <= 256
      && Number.isInteger(value.index) && value.index >= 0 && value.index < 100)
    return { operation: 'ack', outbound_id: value.outbound_id, index: value.index };
}

sockets.on('connection', ws => {
  const child = spawn(process.env.DWORLD_PYTHON || 'python3', [join(root, 'bridge.py')], {
    cwd: dirname(root), stdio: ['pipe', 'pipe', 'ignore'],
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  });
  child.stdin.on('error', () => ws.close(1011));
  child.on('error', () => ws.close(1011));
  child.on('exit', () => ws.close(1011));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.type === 'reply') delete event.delivery;
      if (eventTypes.has(event.type) && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event));
    } catch { ws.close(1011); }
  });
  ws.on('message', raw => {
    try {
      const command = commandFor(JSON.parse(raw.toString()));
      if (!command) return ws.close(1008, 'Unsupported operation');
      child.stdin.write(JSON.stringify(command) + '\n');
    } catch { ws.close(1008, 'Invalid request'); }
  });
  ws.on('error', () => {});
  ws.on('close', () => {
    if (child.stdin.writable) child.stdin.end('{"operation":"close"}\n');
    setTimeout(() => { if (child.exitCode === null) child.kill(); }, 5000).unref();
  });
});
server.listen(port, '127.0.0.1', () => console.log('Private desktop link is listening.'));
