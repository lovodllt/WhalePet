import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('private link authenticates and forwards only supported messages', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-link-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = 'test-token-'.repeat(5);
  const profile = join(dir, 'profile.json');
  const fake = join(dir, 'fake-bridge');
  await writeFile(profile, JSON.stringify({ url: `ws://127.0.0.1:${port}/pet`, token }));
  await writeFile(fake, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'connected'})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c = JSON.parse(line);
  if (c.operation === 'close') process.exit();
  if (c.operation === 'status') console.log(JSON.stringify({type:'status',phase:'awake',available:true}));
  if (c.operation === 'input') console.log(JSON.stringify({type:'reply',texts:[c.text],outbound_id:'test',generation:1,extra_received:'extra' in c}));
  if (c.operation === 'ack') console.log(JSON.stringify({type:'accepted',index:c.index}));
});\n`, { mode: 0o700 });
  const server = spawn(process.execPath, [join(root, 'link-server.mjs')], {
    env: { ...process.env, DWORLD_PET_LINK_FILE: profile, DWORLD_PYTHON: fake }, stdio: ['ignore', 'pipe', 'pipe']
  });
  try {
    await once(server.stdout, 'data');
    const address = `ws://127.0.0.1:${port}/pet`;
    const denied = new WebSocket(address, { headers: { Authorization: 'Bearer wrong' } });
    const [error] = await once(denied, 'error');
    assert.match(error.message, /401/);
    const ws = new WebSocket(address, { headers: { Authorization: `Bearer ${token}` } });
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw)));
    await once(ws, 'open');
    await once(ws, 'message');
    assert.equal(messages.shift().type, 'connected');
    ws.send(JSON.stringify({ operation: 'status' }));
    await once(ws, 'message');
    assert.equal(messages.shift().phase, 'awake');
    ws.send(JSON.stringify({ operation: 'input', text: '测试', message_id: '1', extra: 'not forwarded' }));
    await once(ws, 'message');
    const reply = messages.shift();
    assert.deepEqual(reply.texts, ['测试']);
    assert.equal(reply.extra_received, false);
    ws.send(JSON.stringify({ operation: 'ack', outbound_id: 'test', index: 0 }));
    await once(ws, 'message');
    assert.equal(messages.shift().index, 0);
    ws.send(JSON.stringify({ operation: 'observe', screens: ['never sent'] }));
    const [code] = await once(ws, 'close');
    assert.equal(code, 1008);
  } finally {
    server.kill();
    await once(server, 'exit');
    await rm(dir, { recursive: true, force: true });
  }
});
