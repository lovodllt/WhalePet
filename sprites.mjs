const animations = {
  idle: { row: 0, durations: [3600, 200, 140, 180, 180, 700] },
  right: { row: 1, durations: [150, 150, 150, 150, 150, 150, 150, 230] },
  left: { row: 2, durations: [150, 150, 150, 150, 150, 150, 150, 230] },
  touched: { row: 3, frames: [1, 2, 1, 2, 1, 2, 3], durations: [240, 350, 300, 350, 300, 350, 960] },
  dragging: { row: 4, frames: [1], durations: [1000], scale: 1.17, tops: [37] },
  landing: { row: 0, frames: [0], durations: [950] },
  hop: { row: 0, frames: [0], durations: [2800] },
  peek: { row: 0, frames: [0], durations: [4000] },
  sway: { row: 0, frames: [0], durations: [4500] },
  bow: { row: 0, frames: [0], durations: [3200] },
  failed: { row: 5, durations: [220, 220, 220, 900, 900, 400, 400, 500] },
  sleeping: { row: 5, frames: [3], durations: [1000] },
  listening: { row: 6, durations: [380, 400, 450, 450, 450, 900] },
  speaking: { row: 6, durations: [220, 220, 220, 220, 220, 700] },
  thinking: { row: 7, durations: [380, 400, 400, 400, 450, 900] },
  review: { row: 8, durations: [380, 400, 450, 450, 450, 900] }
};

// Head anchors follow the original sprite frames, in 192×208 canvas coordinates.
const heads = [
  [[94,35],[94,34],[93,36],[93,42],[94,37],[94,36]],
  [[120,33],[119,33],[119,37],[119,39],[122,41],[123,41],[122,42],[121,43]],
  [[70,33],[65,35],[67,36],[67,37],[68,38],[71,40],[70,39],[71,39]],
  [[94,35],[95,34],[94,34],[94,35]],
  [[84,89],[89,58],[95,30],[86,62],[93,81]],
  [[90,36],[89,36],[88,39],[87,44],[88,43],[88,43],[89,43],[91,36]],
  [[94,34],[93,34],[94,34],[94,34],[93,34],[94,34]],
  [[95,34],[94,34],[94,35],[94,33],[95,34],[94,34]],
  [[93,33],[86,42,-10],[92,34],[93,39,10],[93,35],[91,37]]
];

export const interactionClips = [
  { name: 'touched', label: '招招手', duration: 2850 },
  { name: 'hop', label: '跳一跳', duration: 2800 },
  { name: 'peek', label: '探头', duration: 4000 },
  { name: 'sway', label: '摇摆', duration: 4500 },
  { name: 'bow', label: '欠身', duration: 3200 }
];

export function createSpritePlayer(canvas, onFrame) {
  const context = canvas.getContext('2d');
  const sheet = new Image();
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let current = 'idle', index = 0, timer;
  function draw() {
    const animation = animations[current];
    const frame = animation.frames?.[index] ?? index;
    context.clearRect(0, 0, 192, 208);
    if (animation.scale) {
      const scale = animation.scale;
      context.drawImage(sheet, frame * 192, animation.row * 208, 192, 208, 96 * (1 - scale), 8 - animation.tops[index] * scale, 192 * scale, 208 * scale);
    } else context.drawImage(sheet, frame * 192, animation.row * 208, 192, 208, 0, 0, 192, 208);
    canvas.dataset.animation = current;
    canvas.dataset.frame = String(frame);
    let [x, y, angle = 0] = heads[animation.row][frame];
    if (animation.scale) {
      x = 96 + (x - 96) * animation.scale;
      y = 8 + (y - animation.tops[index]) * animation.scale;
    }
    onFrame({ x: x - 94, y: y - 35, angle });
    if (animation.durations.length > 1 && !reducedMotion) timer = setTimeout(() => {
      index = (index + 1) % animation.durations.length;
      draw();
    }, animation.durations[index]);
  }
  sheet.onload = () => { canvas.dataset.ready = 'true'; draw(); };
  sheet.onerror = () => { canvas.setAttribute('aria-label', '人物素材加载失败'); };
  sheet.src = 'assets/ds-pet-sprites.png';
  return {
    play(name, restart = false) {
      if (name === current && !restart) return;
      clearTimeout(timer); current = name; index = 0;
      if (sheet.complete && sheet.naturalWidth) draw();
    },
    stop() { clearTimeout(timer); }
  };
}
