import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { ScreenShare } from '../screen-share.mjs';

test('reuses a capture process and stops pending requests', async () => {
  let starts = 0;
  const helper = `const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      if (request.id !== 3) console.log(JSON.stringify({id: request.id, frames: [process.pid]}));
    });`;
  const share = new ScreenShare('', () => { starts++; return spawn(process.execPath, ['-e', helper]); });
  try {
    const first = await share.capture();
    const second = await share.capture();
    assert.deepEqual(first, second);
    assert.equal(starts, 1);
    const pending = share.capture();
    share.stop();
    await assert.rejects(pending, /已停止/);
    const resumed = await share.capture();
    assert.equal(starts, 2);
    assert.notDeepEqual(resumed, first);
  } finally { share.stop(); }
});

test('authorization opens the session without requesting a frame', async () => {
  const helper = `const readline = require('node:readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const request = JSON.parse(line);
      console.log(JSON.stringify({id: request.id, frames: [request.operation]}));
    });`;
  const share = new ScreenShare('', () => spawn(process.execPath, ['-e', helper]));
  try {
    assert.deepEqual(await share.authorize(), ['start']);
    assert.deepEqual(await share.capture(), ['capture']);
  } finally { share.stop(); }
});
