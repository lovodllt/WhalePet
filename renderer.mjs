import { createSpritePlayer, interactionClips } from './sprites.mjs';

const $ = selector => document.querySelector(selector);
const api = window.pet;
let { settings, preview, remote, observation } = await api.bootstrap();
let connected = false, phase = 'awake', mode = 'idle', dragging = false, recording, continuous = false;
let pointerStart, touched, bubbleTimer, shaping, latestReply;
let playback, gain, sources = [], audioGeneration = -1, audioEnd = false, audioTime = 0;
const action = command => api.action(command);
const sprite = createSpritePlayer($('#character'), head => {
  const canvas = $('#character');
  const scale = Math.min(canvas.clientWidth / canvas.width, canvas.clientHeight / canvas.height);
  const art = $('#character-art');
  art.style.setProperty('--head-x', `${head.x * scale}px`);
  art.style.setProperty('--head-y', `${head.y * scale}px`);
  art.style.setProperty('--head-angle', `${head.angle}deg`);
  shape();
});

function shape() {
  cancelAnimationFrame(shaping);
  shaping = requestAnimationFrame(() => {
    const regions = [];
    const image = $('#character');
    const rect = image.getBoundingClientRect();
    if (image.dataset.ready) {
      const scale = Math.min(rect.width / image.width, rect.height / image.height);
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      const x = rect.x + (rect.width - width) / 2, y = rect.y + (rect.height - height) / 2;
      const margin = Math.ceil((mode === 'hop' ? 28 : 18) * settings.scale);
      for (let row = 0; row < height; row += 3) {
        let first = width, last = -1;
        for (let col = 0; col < width; col++) if (pixels[(row * width + col) * 4 + 3] > 40) { first = Math.min(first, col); last = col; }
        if (last >= first) regions.push({ x: x + first - margin, y: y + row - margin, width: last - first + 1 + margin * 2, height: 3 + margin * 2 });
      }
    }
    for (const selector of ['#state-label', '#bubble', '#chat', '#basin']) {
      const element = $(selector);
      if (!element.hidden) {
        const r = element.getBoundingClientRect();
        regions.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    if (!$('#bubble').hidden) {
      const r = $('#bubble').getBoundingClientRect();
      regions.push({ x: r.x + r.width / 2 - 13, y: r.bottom - 1, width: 26, height: 18 });
    }
    if (!$('#toolbar').hidden) for (const button of $('#toolbar').querySelectorAll('button')) {
      const r = button.getBoundingClientRect();
      regions.push({ x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16 });
    }
    action({ operation: 'shape', regions });
  });
}

function syncSprite(restart = false) {
  const name = ['dragging', 'landing'].includes(mode) ? mode : ['sleeping', 'napping'].includes(phase) ? 'sleeping' : mode === 'moving' ? ($('#avatar').dataset.direction === 'left' ? 'left' : 'right') : mode;
  sprite.play(name, restart);
}

function state(next) {
  if (dragging && next !== 'dragging') return;
  clearTimeout(touched);
  mode = next;
  $('#avatar').dataset.state = next;
  syncSprite(next === 'touched');
  shape();
}

function performMotion(name) {
  const clip = interactionClips.find(item => item.name === name);
  if (!clip || dragging || recording || ['sleeping', 'napping'].includes(phase) || ['thinking', 'speaking', 'moving'].includes(mode)) return;
  state(name);
  touched = setTimeout(() => state('idle'), clip.duration);
}

function layoutMenu() {
  const rect = $('#avatar').getBoundingClientRect();
  const scale = Math.min(rect.width / 192, rect.height / 208);
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + (rect.height - 208 * scale) / 2 + 104 * scale;
  const rx = 133 * scale / 2 + 26, ry = 193 * scale / 2 + 26;
  const buttons = [...$('#toolbar').querySelectorAll('button')];
  buttons.forEach((button, index) => {
    const angle = (-90 + index * 360 / buttons.length) * Math.PI / 180;
    button.style.left = `${Math.max(20, Math.min(innerWidth - 20, cx + rx * Math.cos(angle)))}px`;
    button.style.top = `${Math.max(20, Math.min(innerHeight - 20, cy + ry * Math.sin(angle)))}px`;
  });
}

function syncMenu() {
  const listening = !!recording && continuous;
  $('#quick-mic').setAttribute('aria-pressed', String(listening));
  $('#quick-mic').setAttribute('aria-label', remote ? '远程语音暂未接入' : listening ? '关闭持续听' : '开启持续听');
  $('#quick-mic').title = remote ? '远程语音暂未接入' : listening ? '关闭持续听' : '开启持续听';
  $('#quick-mic').disabled = remote;
  $('#quick-roam').setAttribute('aria-pressed', String(settings.roam));
  $('#quick-roam').setAttribute('aria-label', settings.roam ? '关闭自由移动' : '开启自由移动');
  $('#quick-roam').title = settings.roam ? '关闭自由移动' : '开启自由移动';
  $('#look').setAttribute('aria-pressed', String(observation.enabled));
  $('#look').setAttribute('aria-label', remote ? '远程观察暂未接入' : observation.enabled ? '关闭观察' : '允许观察');
  $('#look').title = remote ? '远程观察暂未接入' : observation.pending ? '等待授权' : observation.enabled ? '关闭观察' : '允许观察';
  $('#look').disabled = remote || observation.pending;
}

function setMenu(open) {
  $('#toolbar').hidden = !open;
  $('#avatar').setAttribute('aria-expanded', String(open));
  if (open) { layoutMenu(); syncMenu(); }
  action({ operation: 'panel', open: open || !$('#chat').hidden });
  shape();
}

function label(text, ready = connected) {
  $('#state-label span').textContent = text;
  $('#state-label').hidden = ['陪伴中', '界面预览', '睡觉中', '补觉中', '吃饭中'].includes(text);
  $('#state-label').dataset.ready = String(ready);
  $('#connection').textContent = preview ? '界面预览' : connected ? '已连接' : '未连接';
  layoutCompanions();
  shape();
}

function message(text, kind = 'other') {
  $('#history .empty')?.remove();
  const element = document.createElement('div');
  element.className = 'message ' + kind;
  element.textContent = text;
  $('#history').append(element);
  while ($('#history').children.length > 80) $('#history').firstElementChild.remove();
  $('#history').scrollTop = $('#history').scrollHeight;
}

function characterPosition() {
  const rect = $('#avatar').getBoundingClientRect();
  const scale = Math.min(rect.width / 192, rect.height / 208);
  const head = $('#basin').hidden ? rect.y + (rect.height - 208 * scale) / 2 + 8 * scale : $('#basin').getBoundingClientRect().top;
  return { head, feet: rect.y + (rect.height - 208 * scale) / 2 + 202 * scale, center: rect.x + rect.width / 2 };
}

function layoutBubble() {
  const { head } = characterPosition();
  $('#bubble').style.bottom = `${Math.max(20, innerHeight - head + 20)}px`;
  $('#bubble').style.setProperty('--bubble-text-max', `${Math.max(28, Math.min(170, head - 70))}px`);
}

function layoutCompanions() {
  const { head, feet, center } = characterPosition();
  const chat = $('#chat');
  if (!chat.hidden) {
    const height = Math.min(322, Math.max(125, head - 20));
    chat.style.height = `${height}px`;
    chat.style.top = `${Math.max(8, head - height - 12)}px`;
    chat.classList.toggle('compact', height < 220);
  }
  const status = $('#state-label');
  if (!status.hidden) {
    status.style.left = `${Math.max(4, Math.min(innerWidth - status.offsetWidth - 4, center - status.offsetWidth / 2))}px`;
    status.style.top = `${Math.max(4, Math.min(innerHeight - status.offsetHeight - 4, feet + 6))}px`;
  }
}

function bubble(text) {
  $('#bubble-text').textContent = text;
  $('#bubble').hidden = !$('#chat').hidden;
  if (!$('#bubble').hidden) layoutBubble();
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => { $('#bubble').hidden = true; shape(); }, 18000);
  shape();
}

function panels(target) {
  $('#chat').hidden = target !== 'chat';
  $('#bubble').hidden = true;
  setMenu(false);
  if (target === 'chat') $('#input').focus();
  layoutCompanions();
  shape();
}

function applySettings() {
  $('#avatar').style.transform = `scale(${settings.scale})`;
  if (!$('#bubble').hidden) layoutBubble();
  if (!$('#toolbar').hidden) layoutMenu();
  layoutCompanions();
  syncMenu();
  if (gain) gain.gain.value = settings.volume;
  shape();
}

function applyObservation() {
  $('#basin').hidden = observation.enabled;
  $('#avatar').dataset.covered = String(!observation.enabled);
  syncMenu();
  if (!$('#bubble').hidden) layoutBubble();
  layoutCompanions();
  shape();
}

function stopPlayback(report = true) {
  const interrupted = sources.length > 0;
  audioGeneration = -1;
  audioEnd = false;
  for (const source of sources) { source.onended = null; try { source.stop(); } catch {} }
  sources = [];
  audioTime = 0;
  if (report && interrupted && latestReply) action({ operation: 'audio_receipt', outbound_id: latestReply.outbound_id, complete: false });
  if (mode === 'speaking') state(recording ? 'listening' : 'idle');
}

async function audioChunk(event) {
  if (event.generation !== audioGeneration) return;
  if (!playback) {
    playback = new AudioContext({ sampleRate: 24000 });
    gain = playback.createGain(); gain.gain.value = settings.volume; gain.connect(playback.destination);
  }
  if (settings.speaker && playback.setSinkId) await playback.setSinkId(settings.speaker);
  await playback.resume();
  if (event.generation !== audioGeneration) return;
  const binary = atob(event.pcm);
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  const view = new DataView(bytes.buffer);
  const samples = new Float32Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
  const buffer = playback.createBuffer(1, samples.length, 24000); buffer.copyToChannel(samples, 0);
  const source = playback.createBufferSource(); source.buffer = buffer; source.connect(gain);
  const generation = audioGeneration;
  source.onended = () => {
    sources = sources.filter(item => item !== source);
    if (!sources.length && audioEnd && generation === audioGeneration) {
      action({ operation: 'audio_receipt', outbound_id: latestReply.outbound_id, complete: true });
      state(recording ? 'listening' : 'idle');
    }
  };
  sources.push(source);
  audioTime = Math.max(audioTime, playback.currentTime + .035);
  source.start(audioTime); audioTime += buffer.duration;
  state('speaking');
}

async function startRecording(handsfree) {
  if (remote) { message('远程语音暂未接入', 'notice'); return; }
  if (preview) { message('界面预览不接收麦克风', 'notice'); return; }
  if (recording) { await stopRecording(true); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: {
      echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      ...(settings.microphone ? { deviceId: { exact: settings.microphone } } : {})
    } });
    const context = new AudioContext({ sampleRate: 16000 });
    await context.audioWorklet.addModule('microphone.mjs');
    const source = context.createMediaStreamSource(stream);
    const processor = new AudioWorkletNode(context, 'pet-microphone');
    const silent = context.createGain(); silent.gain.value = 0;
    source.connect(processor).connect(silent).connect(context.destination);
    recording = { stream, context, processor }; continuous = handsfree;
    action({ operation: 'mic_start' });
    action({ operation: 'mic_active', active: true });
    processor.port.onmessage = event => {
      if (!recording) return;
      const bytes = new Uint8Array(event.data);
      let binary = '';
      for (const value of bytes) binary += String.fromCharCode(value);
      action({ operation: 'pcm', pcm: btoa(binary) });
    };
    $('#record span').textContent = handsfree ? '录音' : '结束';
    $('#record').classList.toggle('active', !handsfree);
    $('#handsfree').classList.toggle('active', handsfree);
    $('#mic-label').textContent = handsfree ? '持续听你说话' : '正在录音';
    $('#mic-label').hidden = false;
    $('#record').setAttribute('aria-pressed', String(!handsfree));
    $('#handsfree').setAttribute('aria-pressed', String(handsfree));
    syncMenu();
    state('listening');
    await context.resume();
    label(handsfree ? '正在听' : '录音中');
  } catch {
    await stopRecording(true);
    message('无法使用麦克风，请检查设备与授权', 'notice');
  }
}

async function stopRecording(immediate = false) {
  if (!recording) return;
  const previous = recording; recording = undefined; continuous = false;
  previous.stream.getTracks().forEach(track => track.stop());
  previous.processor.disconnect(); await previous.context.close();
  $('#record span').textContent = '录音'; $('#record').classList.remove('active'); $('#handsfree').classList.remove('active');
  $('#mic-label').textContent = '文字输入';
  $('#mic-label').hidden = true;
  $('#record').setAttribute('aria-pressed', 'false'); $('#handsfree').setAttribute('aria-pressed', 'false');
  syncMenu();
  action({ operation: 'mic_active', active: false });
  if (immediate) action({ operation: 'mic_stop' });
  else {
    // Silence lets the existing VAD finish a button-recorded phrase before stdin closes.
    const silence = btoa(String.fromCharCode(...new Uint8Array(32000)));
    action({ operation: 'pcm', pcm: silence });
    setTimeout(() => { if (!recording) action({ operation: 'mic_stop' }); }, 2500);
  }
  state('idle'); label('陪伴中');
}

$('#form').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('#input').value.trim();
  if (!text) return;
  stopPlayback(); message(text, 'self'); $('#input').value = '';
  action({ operation: 'input', text, message_id: crypto.randomUUID() });
});
$('#input').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); $('#form').requestSubmit(); }
});
$('#chat-toggle').onclick = () => panels('chat');
$('#chat-close').onclick = () => panels(null);
$('#bubble-close').onclick = () => { $('#bubble').hidden = true; shape(); };
$('#bubble').ondblclick = () => panels('chat');
$('#look').onclick = async () => {
  setMenu(false);
  try { observation = await api.observation(!observation.enabled); applyObservation(); }
  catch { bubble('观察设置未能保存'); }
};
$('#settings-open').onclick = () => { panels(null); action({ operation: 'open_settings' }); };
$('#quick-roam').onclick = async () => {
  settings = await api.settings({ roam: !settings.roam });
  syncMenu();
  if (settings.roam) { setMenu(false); action({ operation: 'roam_now' }); }
};
$('#quick-mic').onclick = async () => {
  setMenu(false);
  if (preview) panels('chat');
  if (recording && !continuous) { await stopRecording(true); await startRecording(true); }
  else if (recording) await stopRecording(true);
  else await startRecording(true);
};
$('#record').onclick = () => recording ? stopRecording(false) : startRecording(false);
$('#handsfree').onclick = () => recording ? stopRecording(true) : startRecording(true);
$('#avatar').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setMenu($('#toolbar').hidden); }
});
$('#avatar').addEventListener('contextmenu', event => {
  event.preventDefault();
  if (dragging) return;
  if (!$('#chat').hidden) panels(null);
  setMenu($('#toolbar').hidden);
});
document.addEventListener('contextmenu', event => event.preventDefault());
document.addEventListener('keydown', event => { if (event.key === 'Escape') panels(null); });
document.addEventListener('pointerdown', event => {
  if (!$('#toolbar').hidden && !event.target.closest('#toolbar, #avatar')) setMenu(false);
});
window.addEventListener('blur', () => { if (!dragging && !$('#toolbar').hidden) setMenu(false); });
$('#avatar').addEventListener('pointerdown', event => {
  if (event.button !== 0) return;
  pointerStart = { x: event.screenX, y: event.screenY }; dragging = false;
  $('#avatar').setPointerCapture(event.pointerId);
  action({ operation: 'drag_start' });
});
$('#avatar').addEventListener('pointermove', event => {
  if (!pointerStart) return;
  if (Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y) > 5) {
    if (!dragging) { dragging = true; setMenu(false); state('dragging'); }
    action({ operation: 'drag' });
  }
});
$('#avatar').addEventListener('pointerup', () => {
  if (!pointerStart) return;
  const wasDragging = dragging; pointerStart = undefined; dragging = false;
  action({ operation: 'drag_end' });
  clearTimeout(touched); state(wasDragging ? 'landing' : 'touched');
  if (!wasDragging) {
    if (!$('#chat').hidden) panels(null);
    if (!$('#toolbar').hidden) setMenu(false);
  }
  touched = setTimeout(() => state(recording ? 'listening' : 'idle'), wasDragging ? 950 : 2850);
});
$('#avatar').addEventListener('pointercancel', () => { pointerStart = undefined; dragging = false; action({ operation: 'drag_end' }); state('idle'); });
$('#avatar').ondblclick = () => panels('chat');
new ResizeObserver(shape).observe(document.body);

let audioQueue = Promise.resolve();
api.onEvent(event => {
  switch (event.type) {
    case 'connected': connected = !event.preview; label(preview ? '界面预览' : '陪伴中'); break;
    case 'disconnected': connected = false; label('连接已断开', false); stopPlayback(); stopRecording(true); break;
    case 'status': {
      phase = event.phase; $('#avatar').dataset.phase = phase;
      syncSprite(); shape();
      label(preview ? '界面预览' : ({ sleeping: '睡觉中', napping: '补觉中', eating: '吃饭中' }[phase] || (event.clock === 'PAUSED' ? '世界已暂停' : recording ? '正在听' : '陪伴中')));
      if (!event.available && recording) stopRecording(true);
      break;
    }
    case 'settings': settings = event.settings; applySettings(); break;
    case 'observation': observation = event; applyObservation(); break;
    case 'capture_visibility': document.documentElement.style.visibility = event.hidden ? 'hidden' : ''; break;
    case 'open_chat': panels('chat'); break;
    case 'play_animation': performMotion(event.name); break;
    case 'moving':
      if (event.active) { $('#avatar').dataset.direction = event.direction; state('moving'); }
      else if (mode === 'moving') { state('landing'); touched = setTimeout(() => state(recording ? 'listening' : 'idle'), 950); }
      break;
    case 'thinking': state('thinking'); label('想一想'); break;
    case 'accepted': if (event.held) message('消息已留下，等她方便时再回复。', 'notice'); break;
    case 'reply': {
      latestReply = event; stopPlayback(false);
      event.texts.forEach((text, index) => {
        message(text); action({ operation: 'ack', outbound_id: event.outbound_id, index });
      });
      bubble(event.texts.join('\n')); state(recording ? 'listening' : 'idle'); label('陪伴中');
      if (settings.voice) action({ operation: 'speak', outbound_id: event.outbound_id, generation: event.generation });
      break;
    }
    case 'quiet': state(recording ? 'listening' : 'idle'); label('陪伴中'); break;
    case 'cancelled': stopPlayback(); break;
    case 'observing': state('thinking'); label(`看看 ${event.screen_count} 块屏幕`); break;
    case 'observed': label(`已看过 ${event.screen_count} 块屏幕`); break;
    case 'observation_finished': if (mode === 'thinking') state(recording ? 'listening' : 'idle'); break;
    case 'transcript': message(event.text, 'self'); break;
    case 'asr_speech_start': stopPlayback(); state('listening'); break;
    case 'asr_ready': label('正在听'); break;
    case 'asr_error': message('这句语音未能识别，请再说一次。', 'notice'); break;
    case 'microphone_toggle': event.enabled ? startRecording(true) : stopRecording(true); break;
    case 'stop_microphone': stopRecording(true); stopPlayback(); break;
    case 'audio_start': stopPlayback(false); audioGeneration = event.generation; audioEnd = false; break;
    case 'audio_chunk': audioQueue = audioQueue.then(() => audioChunk(event)).catch(() => message('语音播放失败', 'notice')); break;
    case 'audio_end':
      audioQueue = audioQueue.then(() => {
        if (event.generation !== audioGeneration) return;
        audioEnd = event.complete;
        if (!event.complete) { stopPlayback(); message('语音播放未完成', 'notice'); }
        else if (!sources.length) { action({ operation: 'audio_receipt', outbound_id: event.outbound_id, complete: true }); state(recording ? 'listening' : 'idle'); }
      });
      break;
    case 'audio_stop': stopPlayback(); break;
    case 'clear_history': $('#history').replaceChildren(); latestReply = undefined; break;
    case 'notice': message(event.message, 'notice'); bubble(event.message); break;
    case 'error':
      if (event.source === 'microphone') stopRecording(true);
      message(event.message + (event.detail ? `（${event.detail}）` : ''), 'notice'); label(event.message, false); state('failed'); break;
  }
});

window.addEventListener('beforeunload', () => { sprite.stop(); stopPlayback(); if (recording) recording.stream.getTracks().forEach(track => track.stop()); });
if (remote) for (const id of ['record', 'handsfree']) { $(`#${id}`).disabled = true; $(`#${id}`).title = '远程语音暂未接入'; }
document.body.classList.toggle('preview', preview);
applySettings();
applyObservation();
