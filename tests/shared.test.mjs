import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePlan, portalCapturePlan, clampPosition, normalizeSettings } from '../shared.mjs';

const thumbnail = { isEmpty: () => false };
test('all monitors are matched by identity, including a left-side monitor', () => {
  const displays = [{ id: 5, bounds: { x: -1920 } }, { id: 8, bounds: { x: 0 } }];
  const sources = [{ display_id: '8', thumbnail }, { display_id: '5', thumbnail }];
  const result = capturePlan(displays, sources);
  assert.deepEqual(result.map(p => p.source.display_id), ['5', '8']);
});
test('one PipeWire source is not passed off as two screens', () => {
  assert.throws(() => capturePlan([{ id: 1 }, { id: 2 }], [{ display_id: '1', thumbnail }]), /覆盖不足/);
  assert.throws(() => capturePlan([{ id: 1 }], [{ display_id: '', thumbnail }]), /无法对应/);
});
test('portal monitors must match every display by position and size', () => {
  const displays = [{ id: 1, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } },
    { id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } }];
  const frames = [{ position: [0, 0], size: [2560, 1440] }, { position: [-1920, 0], size: [1920, 1080] }];
  assert.deepEqual(portalCapturePlan(displays, frames).map(item => item.frame.position[0]), [-1920, 0]);
  assert.throws(() => portalCapturePlan(displays, frames.slice(0, 1)), /覆盖不足/);
  assert.throws(() => portalCapturePlan(displays, [frames[0], { position: [1, 1], size: [1, 1] }]), /无法对应/);
});
test('unplugged monitor positions are moved into the remaining work area', () => {
  assert.deepEqual(clampPosition({ x: -3000, y: 2000 }, { width: 440, height: 660 }, { x: 0, y: 0, width: 1920, height: 1080 }), { x: 0, y: 420 });
});
test('settings keep capture and speech intervals independent', () => {
  const result = normalizeSettings({ normalCapture: 30, normalSpeech: 600, voice: 'true', scale: 8 });
  assert.equal(result.normalCapture, 30); assert.equal(result.normalSpeech, 600);
  assert.equal(result.voice, false); assert.equal(result.scale, 1.8);
});
