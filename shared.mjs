export const MAX_LINK_MESSAGE_BYTES = 16 * 1024 * 1024;
export const MAX_LINK_DISPLAYS = 16;

export const defaults = {
  mode: 'normal', observationEnabled: true, voice: false, roam: true, scale: 1, volume: .75, fps: 30,
  normalCapture: 300, companionCapture: 60, normalSpeech: 600, companionSpeech: 120,
  microphone: '', speaker: ''
};

export function normalizeSettings(input) {
  const result = { ...defaults };
  for (const name of ['observationEnabled', 'voice', 'roam']) if (typeof input[name] === 'boolean') result[name] = input[name];
  if (['normal', 'companion'].includes(input.mode)) result.mode = input.mode;
  for (const name of ['normalCapture', 'companionCapture', 'normalSpeech', 'companionSpeech']) {
    if (Number.isFinite(input[name])) result[name] = Math.round(Math.max(15, Math.min(86400, input[name])));
  }
  for (const [name, low, high] of [['scale', .5, 1.8], ['volume', 0, 1]]) {
    if (Number.isFinite(input[name])) result[name] = Math.max(low, Math.min(high, input[name]));
  }
  if (Number.isFinite(input.fps)) result.fps = Math.round(Math.max(1, Math.min(60, input.fps)));
  for (const name of ['microphone', 'speaker']) if (typeof input[name] === 'string') result[name] = input[name].slice(0, 300);
  return result;
}

export function capturePlan(displays, sources) {
  if (sources.length !== displays.length || !displays.length || sources.some(s => s.thumbnail.isEmpty())) {
    throw new Error(`屏幕覆盖不足：取得 ${sources.length} 个来源，系统有 ${displays.length} 块屏幕`);
  }
  const ids = sources.map(s => s.display_id);
  if (new Set(ids).size !== ids.length) throw new Error('屏幕来源无法区分，请检查采集授权');
  return displays.map(display => {
    const source = sources.find(s => String(s.display_id) === String(display.id));
    if (!source) throw new Error('无法对应全部显示器，请检查当前桌面会话的多屏采集能力');
    return { display, source };
  });
}

export function portalCapturePlan(displays, frames) {
  if (!displays.length || frames.length !== displays.length) {
    throw new Error(`屏幕覆盖不足：选择了 ${frames.length} 块屏幕，系统有 ${displays.length} 块屏幕`);
  }
  if (displays.length === 1) return [{ display: displays[0], frame: frames[0] }];
  const remaining = [...frames];
  return displays.map(display => {
    const { x, y, width, height } = display.bounds;
    const index = remaining.findIndex(frame => frame.position?.[0] === x && frame.position?.[1] === y &&
      frame.size?.[0] === width && frame.size?.[1] === height);
    if (index < 0) throw new Error('无法对应全部显示器，请检查屏幕共享选择和显示布局');
    return { display, frame: remaining.splice(index, 1)[0] };
  });
}

export function clampPosition(position, size, area) {
  return {
    x: Math.round(Math.max(area.x, Math.min(area.x + area.width - size.width, position.x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - size.height, position.y)))
  };
}
