import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { WebSocket } from 'ws';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
test('private link authenticates and relays desktop media and UTF-8 through the bridge', { timeout: 15000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pet-link-'));
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const token = 'test-token-'.repeat(5);
  const profile = join(dir, 'profile.json');
  for (const file of ['link-server.mjs', 'shared.mjs']) await copyFile(join(root, file), join(dir, file));
  await symlink(join(root, 'node_modules'), join(dir, 'node_modules'), 'junction');
  await writeFile(profile, JSON.stringify({ url: `ws://127.0.0.1:${port}/pet`, token }));
  await writeFile(join(dir, 'bridge.py'), `
process.stdout.write(JSON.stringify({type:'connected'})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const c = JSON.parse(line);
  if (c.operation === 'close') process.exit();
  if (c.operation === 'status') console.log(JSON.stringify({type:'status',phase:'awake',available:true}));
  if (c.operation === 'input') console.log(JSON.stringify({type:'reply',texts:[c.text],outbound_id:'test',generation:1,delivery:'private',extra_received:'extra' in c}));
  if (c.operation === 'input' && c.wait_for_screen) console.log(JSON.stringify({type:'accepted',wait:c.wait_for_screen,clear:c.clear_screen}));
  if (c.operation === 'ack') console.log(JSON.stringify({type:'accepted',index:c.index}));
  if (c.operation === 'observe') console.log(JSON.stringify({type:'observed',screens:c.screens,text:c.text,submitted:c.submitted,message_id:c.message_id}));
  if (c.operation === 'screen_unavailable') console.log(JSON.stringify({type:'observation_finished',message_id:c.message_id}));
  if (c.operation === 'pause_observation') console.log(JSON.stringify({type:'observation_finished'}));
  if (c.operation === 'mic_start') console.log(JSON.stringify({type:'asr_ready'}));
  if (c.operation === 'pcm') console.log(JSON.stringify({type:'transcript',text:'我在说话',pcm:c.pcm}));
  if (c.operation === 'speak') console.log(JSON.stringify({type:'audio_chunk',pcm:'AAA=',deliveryVerified:c.delivery==='private'}));
  if (c.operation === 'audio_receipt') console.log(JSON.stringify({type:'audio_end',complete:c.complete}));
});\n`);
  const server = spawn(process.execPath, [join(dir, 'link-server.mjs')], {
    env: { ...process.env, DWORLD_PET_LINK_FILE: profile, DWORLD_PYTHON: process.execPath }, stdio: ['ignore', 'pipe', 'pipe']
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
    assert.equal('delivery' in reply, false);
    ws.send(JSON.stringify({ operation: 'ack', outbound_id: 'test', index: 0 }));
    await once(ws, 'message');
    assert.equal(messages.shift().index, 0);
    async function exchange(command) {
      const response = once(ws, 'message');
      ws.send(JSON.stringify(command));
      await response;
      return messages.shift();
    }
    const screens = ['a', 'b'].map((display_id, i) => ({
      display_id, captured_at: Date.now() / 1000, scale_factor: 1,
      bounds: { x: i ? -1920 : 0, y: 0, width: 1920, height: 1080 },
      jpeg: Buffer.alloc(32 * 1024, i).toString('base64')
    }));
    assert.deepEqual(await exchange({ operation: 'observe', screens, manual: true, may_speak: false, text: '看看屏幕' }),
      { type: 'observed', screens, text: '看看屏幕', submitted: false });
    ws.send(JSON.stringify({ operation: 'input', text: '看看屏幕', message_id: 'screen-1', wait_for_screen: true }));
    await once(ws, 'message');
    messages.shift();
    if (!messages.length) await once(ws, 'message');
    assert.deepEqual(messages.shift(), { type: 'accepted', wait: true, clear: false });
    assert.deepEqual(await exchange({ operation: 'observe', screens, manual: true, may_speak: false,
      text: '看看屏幕', submitted: true, message_id: 'screen-1' }),
      { type: 'observed', screens, text: '看看屏幕', submitted: true, message_id: 'screen-1' });
    assert.deepEqual(await exchange({ operation: 'screen_unavailable', message_id: 'screen-1' }),
      { type: 'observation_finished', message_id: 'screen-1' });
    assert.equal((await exchange({ operation: 'pause_observation' })).type, 'observation_finished');
    assert.equal((await exchange({ operation: 'mic_start' })).type, 'asr_ready');
    const pcm = Buffer.alloc(32000).toString('base64');
    assert.deepEqual(await exchange({ operation: 'pcm', pcm }), { type: 'transcript', text: '我在说话', pcm });
    assert.deepEqual(await exchange({ operation: 'speak', outbound_id: 'test', generation: 1, delivery: 'forged' }),
      { type: 'audio_chunk', pcm: 'AAA=', deliveryVerified: true });
    assert.deepEqual(await exchange({ operation: 'audio_receipt', outbound_id: 'test', complete: true }),
      { type: 'audio_end', complete: true });
    ws.send(JSON.stringify({ operation: 'observe', screens: ['never sent'] }));
    const [code] = await once(ws, 'close');
    assert.equal(code, 1008);
  } finally {
    server.kill();
    await once(server, 'exit');
    await rm(dir, { recursive: true, force: true });
  }
});
