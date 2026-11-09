import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpritePlayer } from '../sprites.mjs';

function playerFixture(t, reducedMotion = false) {
  const originals = { Image: globalThis.Image, matchMedia: globalThis.matchMedia, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  const timers = new Map(), draws = [], heads = [];
  let timerId = 0;
  globalThis.Image = class {
    set src(_value) { this.complete = true; this.naturalWidth = 1536; this.onload(); }
  };
  globalThis.matchMedia = () => ({ matches: reducedMotion });
  globalThis.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  const context = { clearRect() {}, drawImage(...args) { draws.push(args.slice(1)); } };
  const canvas = { dataset: {}, getContext: () => context };
  const player = createSpritePlayer(canvas, head => heads.push(head));
  t.after(() => { player.stop(); for (const [key, value] of Object.entries(originals)) globalThis[key] = value; });
  return { player, draws, timers, heads };
}

test('head attachment tracks walking frames and returns to the resting position', t => {
  const { player, heads, timers } = playerFixture(t);
  assert.deepEqual(heads.at(-1), { x: 0, y: 0, angle: 0 });
  player.play('right');
  assert.ok(heads.at(-1).x > 20);
  player.play('left');
  assert.ok(heads.at(-1).x < -20);
  const [id, timer] = timers.entries().next().value;
  timers.delete(id); timer.callback();
  assert.notEqual(heads.at(-1).y, -2);
  player.play('sleeping');
  assert.ok(heads.at(-1).y > 0);
  player.play('idle');
  assert.deepEqual(heads.at(-1), { x: 0, y: 0, angle: 0 });
});

test('landing and positional motions retain the standing frame', t => {
  const { player, draws } = playerFixture(t);
  const standing = draws.at(-1);
  for (const motion of ['landing', 'hop', 'peek', 'sway', 'bow']) {
    player.play(motion);
    assert.deepEqual(draws.at(-1), standing, motion);
  }
});

test('dragging keeps one original hanging pose at a fixed scale and aligned head position', t => {
  const { player, draws, timers } = playerFixture(t);
  player.play('dragging');
  const [sourceX, sourceY, , , , destinationY, width, height] = draws.at(-1);
  assert.equal(sourceX, 192);
  assert.equal(sourceY, 4 * 208);
  assert.equal(width, 192 * 1.17);
  assert.equal(height, 208 * 1.17);
  assert.ok(Math.abs(destinationY + 37 * 1.17 - 8) < 1e-9);
  assert.equal(timers.size, 0);
});

test('click shows a raised hand immediately and walks use the matching original direction', t => {
  const { player, draws, timers } = playerFixture(t);
  player.play('touched');
  assert.equal(draws.at(-1)[0], 192);
  assert.equal(draws.at(-1)[1], 3 * 208);
  const [id, timer] = timers.entries().next().value;
  timers.delete(id); timer.callback();
  assert.equal(draws.at(-1)[0], 2 * 192);
  player.play('touched', true);
  assert.equal(draws.at(-1)[0], 192);
  for (const [name, row] of [['right', 1], ['left', 2]]) {
    player.play(name);
    assert.equal(draws.at(-1)[1], row * 208);
    assert.deepEqual(draws.at(-1).slice(-2), [192, 208]);
  }
});

test('switching clips cancels the previous timer', t => {
  const regular = playerFixture(t);
  regular.player.play('touched');
  assert.equal(regular.timers.size, 1);
  regular.player.play('thinking');
  assert.equal(regular.timers.size, 1);
  regular.player.stop();
  assert.equal(regular.timers.size, 0);
});

test('reduced motion never starts frame loops', t => {
  const reduced = playerFixture(t, true);
  reduced.player.play('right');
  assert.equal(reduced.timers.size, 0);
});
