import { app, BrowserWindow, Menu, Tray, nativeImage, screen, desktopCapturer, ipcMain, powerMonitor, session } from 'electron';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { capturePlan, portalCapturePlan, clampPosition, normalizeSettings } from './shared.mjs';
import { ScreenShare } from './screen-share.mjs';
import { interactionClips } from './sprites.mjs';
import { WebSocket } from 'ws';

const root = dirname(fileURLToPath(import.meta.url));
if (process.env.DWORLD_PET_DATA_DIR) app.setPath('userData', process.env.DWORLD_PET_DATA_DIR);
const preview = process.argv.includes('--preview');
const smoke = process.argv.includes('--smoke');
let pet, settingsWindow, tray, bridge, settings, status = {}, lastReply;
let remote, remoteSocket, reconnectTimer;
let dragging = false, moving = false, panel = false, locked = false, observing = false;
let captureAt = Date.now(), spokeAt = 0, previousPixels = '';
let closing = false, dragStart, movement, shapeTimer, roamAfterSettings = false;
let speechPlaying = false;
let observationTimer, statusTimer, roamTimer;
let captureGeneration = 0;
let observationPending = false;
const wayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland';
const screenShare = wayland ? new ScreenShare(join(root, 'wayland_capture.py')) : undefined;
let captureNeedsUser = wayland;
const settingsFile = () => join(app.getPath('userData'), 'preferences.json');
const send = value => {
  if (remote) {
    if (!['status', 'input', 'ack', 'interrupt'].includes(value.operation)) return;
    if (remoteSocket?.readyState === WebSocket.OPEN) remoteSocket.send(JSON.stringify(value));
    else if (value.operation === 'input') notify({ type: 'error', message: '连接已断开，消息未发送' });
  } else if (bridge?.stdin.writable) bridge.stdin.write(JSON.stringify(value) + '\n');
};
const notify = value => { if (pet && !pet.isDestroyed()) pet.webContents.send('pet:event', value); };
const observationState = () => ({ enabled: !remote && !!settings?.observationEnabled && (preview || !screenShare || !captureNeedsUser), pending: observationPending });
function notifyObservation() {
  const event = { type: 'observation', ...observationState() };
  notify(event);
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('pet:event', event);
}
function stopScreenShare() {
  captureGeneration++;
  observing = false;
  previousPixels = '';
  if (screenShare) captureNeedsUser = true;
  screenShare?.stop();
  notifyObservation();
}

async function saveSettings(patch) {
  const wasRoaming = settings.roam;
  if (remote) patch = { ...patch, observationEnabled: false, voice: false };
  settings = normalizeSettings({ ...settings, ...patch });
  if (wasRoaming && !settings.roam) { roamAfterSettings = false; stopMovement(); }
  if (!settings.observationEnabled) {
    stopScreenShare();
    send({ operation: 'pause_observation' });
  }
  await mkdir(dirname(settingsFile()), { recursive: true });
  await writeFile(settingsFile(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  captureAt = Date.now();
  notify({ type: 'settings', settings, preview });
  settingsWindow?.webContents.send('pet:event', { type: 'settings', settings, preview });
  if (!settings.voice) { send({ operation: 'audio_stop' }); notify({ type: 'audio_stop' }); }
  if (!wasRoaming && settings.roam) {
    if (settingsWindow) roamAfterSettings = true;
    else if (!panel) roam(true);
  }
  updateTray();
  notifyObservation();
  return settings;
}

async function setObservation(enabled) {
  if (remote && enabled) { notify({ type: 'notice', message: '远程观察暂未接入' }); return observationState(); }
  if (!enabled) {
    await saveSettings({ observationEnabled: false });
    return observationState();
  }
  if (observationPending || observationState().enabled) return observationState();
  const generation = captureGeneration;
  observationPending = true;
  notifyObservation();
  try {
    await saveSettings({ observationEnabled: true });
    if (generation === captureGeneration && settings.observationEnabled) {
      if (screenShare && !preview) await screenShare.authorize();
      if (generation === captureGeneration && settings.observationEnabled) {
        captureNeedsUser = false;
        captureAt = Date.now();
      }
    }
  } catch (error) {
    if (generation === captureGeneration) {
      stopScreenShare();
      notify({ type: 'error', message: error.message || '屏幕共享未开启' });
    }
  } finally {
    observationPending = false;
    notifyObservation();
    updateTray();
  }
  return observationState();
}

function emitBridge(event) {
  if (event.type === 'status') {
    const epochChanged = status.privacy_epoch !== undefined && status.privacy_epoch !== event.privacy_epoch;
    const becameUnavailable = status.available && !event.available;
    status = { ...event, listening: status.listening };
    if (epochChanged || becameUnavailable) {
      stopMovement();
      stopScreenShare();
      lastReply = undefined;
      send({ operation: 'interrupt' });
      send({ operation: 'pause_observation' });
      notify({ type: 'audio_stop' });
      if (epochChanged) notify({ type: 'clear_history' });
    }
  }
  if (event.type === 'thinking' || event.type === 'audio_start') stopMovement();
  if (event.type === 'reply') {
    lastReply = event;
    spokeAt = Date.now();
  }
  if (event.type === 'transcript' || event.type === 'asr_speech_start') spokeAt = Date.now();
  if (event.type === 'audio_start') speechPlaying = true;
  if (event.type === 'audio_stop') speechPlaying = false;
  if (event.type === 'observation_finished') observing = false;
  notify(event);
}

function startBridge() {
  if (preview) {
    status = { type: 'status', phase: 'awake', clock: 'PREVIEW', available: false };
    notify({ type: 'connected', preview: true });
    notify(status);
    return;
  }
  if (remote) return startRemote();
  bridge = spawn(process.env.DWORLD_PYTHON || 'python3', [join(root, 'bridge.py')], {
    cwd: dirname(root), stdio: ['pipe', 'pipe', 'pipe']
  });
  createInterface({ input: bridge.stdout }).on('line', line => {
    try { emitBridge(JSON.parse(line)); }
    catch { notify({ type: 'error', message: '后端返回了无效数据' }); }
  });
  // Backend stderr is not exposed to the page or persisted with private data.
  bridge.stderr.resume();
  bridge.on('error', () => notify({ type: 'error', message: '无法启动后端连接' }));
  bridge.on('exit', () => {
    status = {};
    if (!closing) notify({ type: 'disconnected' });
  });
  send({ operation: 'status' });
}

function startRemote() {
  let url;
  try {
    url = new URL(remote.url);
    const parts = url.hostname.split('.').map(Number);
    if (url.protocol !== 'ws:' || url.pathname !== '/pet' || url.search || url.hash || url.username || url.password
        || parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)
        || parts[0] !== 100 || parts[1] < 64 || parts[1] > 127 || typeof remote.token !== 'string' || remote.token.length < 40)
      throw new Error();
  } catch { notify({ type: 'error', message: '请检查远程连接配置 remote-link.json' }); return; }
  remoteSocket = new WebSocket(url, { headers: { Authorization: `Bearer ${remote.token}` }, handshakeTimeout: 10000 });
  remoteSocket.on('message', raw => {
    try {
      const event = JSON.parse(raw.toString());
      emitBridge(event);
      if (event.type === 'connected') send({ operation: 'status' });
    }
    catch { notify({ type: 'error', message: '后端返回了无效数据' }); }
  });
  remoteSocket.on('error', () => {});
  remoteSocket.on('close', () => {
    status = {};
    if (!closing) { notify({ type: 'disconnected' }); reconnectTimer = setTimeout(startRemote, 3000); }
  });
}

async function capture(manual = false, text, messageId) {
  if (!observationState().enabled || observing || dragging || locked || (!manual && (panel || !status.available))) return;
  if (preview) {
    notify({ type: 'notice', message: '界面预览不读取屏幕，也不调用人物模型' });
    return;
  }
  if (!status.available) {
    notify({ type: 'notice', message: '她现在不方便看屏幕' });
    return;
  }
  observing = true;
  stopMovement();
  const generation = captureGeneration;
  const visible = pet.isVisible();
  let forwarded = false;
  try {
    const displays = screen.getAllDisplays();
    if (visible) notify({ type: 'capture_visibility', hidden: true });
    await new Promise(resolve => setTimeout(resolve, 90));
    let plan;
    if (screenShare) {
      const shared = await screenShare.capture();
      if (generation !== captureGeneration) return;
      plan = portalCapturePlan(displays, shared).map(({ display, frame }) => ({
        display, image: nativeImage.createFromBuffer(Buffer.from(frame.jpeg, 'base64'))
      }));
    } else {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1536, height: 1536 } });
      if (generation !== captureGeneration) return;
      plan = capturePlan(displays, sources).map(({ display, source }) => ({ display, image: source.thumbnail }));
    }
    if (plan.some(({ image }) => image.isEmpty())) throw new Error('未能读取共享的屏幕画面');
    plan = plan.map(({ display, image }) => {
      const { width, height } = image.getSize();
      const factor = Math.min(1, 1536 / Math.max(width, height));
      return { display, image: factor < 1 ? image.resize({ width: Math.round(width * factor), height: Math.round(height * factor) }) : image };
    });
    if (screenShare && !settings.observationEnabled) {
      screenShare.stop();
      captureNeedsUser = true;
    }
    const capturedAt = Date.now() / 1000;
    const frames = plan.map(({ display, image }) => ({
      display_id: String(display.id), bounds: display.bounds, scale_factor: display.scaleFactor,
      captured_at: capturedAt, jpeg: image.toJPEG(82).toString('base64')
    }));
    const fingerprint = plan.map(({ image }) => image.resize({ width: 64 }).toJPEG(25).toString('base64')).join('|');
    if (!manual && fingerprint === previousPixels) { observing = false; return; }
    previousPixels = fingerprint;
    const gap = settings.mode === 'companion' ? settings.companionSpeech : settings.normalSpeech;
    send({ operation: 'observe', screens: frames, manual, text, message_id: messageId, submitted: !!messageId,
      may_speak: !speechPlaying && Date.now() - spokeAt >= gap * 1000 });
    forwarded = true;
    notify({ type: 'observing', screen_count: frames.length });
  } catch (error) {
    if (generation === captureGeneration) {
      stopScreenShare();
      captureNeedsUser = true;
      notify({ type: 'error', message: error.message || '没有取得全部屏幕，请检查系统采集授权' });
    }
  } finally {
    if (visible && !closing) notify({ type: 'capture_visibility', hidden: false });
    if (manual && messageId && !forwarded && !closing) send({ operation: 'screen_unavailable', message_id: messageId });
  }
}

function toggleVisibility() {
  if (pet.isVisible()) { pet.hide(); locked = true; stopScreenShare(); send({ operation: 'pause_observation' }); notify({ type: 'stop_microphone' }); }
  else { locked = false; pet.showInactive(); captureAt = Date.now(); }
}

function findPet() {
  locked = false; stopMovement();
  const area = screen.getPrimaryDisplay().workArea, bounds = pet.getBounds();
  const position = clampPosition({ x: area.x + area.width - bounds.width - 20, y: area.y + area.height - bounds.height - 20 }, bounds, area);
  pet.setPosition(position.x, position.y); pet.show();
}

function openSettings(tab = 'appearance') {
  stopMovement();
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.webContents.send('pet:event', { type: 'settings_tab', tab });
    settingsWindow.show(); settingsWindow.focus();
    return;
  }
  settingsWindow = new BrowserWindow({ width: 760, height: 570, minWidth: 620, minHeight: 460,
    title: '桌面伙伴设置', icon: join(root, 'assets/app-icon.png'), backgroundColor: '#f7f9fc', show: false,
    webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  settingsWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWindow.webContents.on('will-navigate', event => event.preventDefault());
  settingsWindow.once('ready-to-show', () => settingsWindow?.show());
  settingsWindow.on('closed', () => {
    settingsWindow = undefined;
    if (roamAfterSettings && !closing) { roamAfterSettings = false; roam(true); }
  });
  settingsWindow.loadFile(join(root, 'settings.html'), { query: { tab } });
}

function menuItems() {
  return [
    { label: '聊天', click: () => { pet.show(); pet.focus(); notify({ type: 'open_chat' }); } },
    { label: '允许观察', type: 'checkbox', enabled: !remote, checked: observationState().enabled, click: item => setObservation(item.checked) },
    { label: '互动动作', submenu: interactionClips.map(clip => ({ label: clip.label, click: () => notify({ type: 'play_animation', name: clip.name }) })) },
    { type: 'separator' },
    { label: '积极陪伴', type: 'checkbox', checked: settings.mode === 'companion', click: item => saveSettings({ mode: item.checked ? 'companion' : 'normal' }) },
    { label: '持续听', type: 'checkbox', enabled: !remote, checked: !!status.listening, click: item => notify({ type: 'microphone_toggle', enabled: item.checked }) },
    { label: '语音回复', type: 'checkbox', enabled: !remote, checked: settings.voice, click: item => saveSettings({ voice: item.checked }) },
    { label: '自由移动', type: 'checkbox', checked: settings.roam, click: item => saveSettings({ roam: item.checked }) },
    { label: '大小', submenu: [.5, .75, 1, 1.25, 1.5, 1.8].map(scale => ({
      label: `${Math.round(scale * 100)}%`, type: 'radio', checked: Math.abs(settings.scale - scale) < .001,
      click: () => saveSettings({ scale })
    })) },
    { label: '设置', click: () => openSettings() },
    { type: 'separator' },
    { label: pet.isVisible() ? '隐藏' : '显示', click: toggleVisibility },
    { label: '找回', click: findPet },
    { label: '重启', click: () => { app.relaunch(); app.quit(); } },
    { label: '退出', click: () => app.quit() }
  ];
}

function updateTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(menuItems()));
}

function stopMovement() {
  if (movement) clearInterval(movement);
  movement = undefined;
  if (moving) notify({ type: 'moving', active: false });
  moving = false;
}

function roam(immediate = false) {
  if (!settings.roam || dragging || panel || settingsWindow || locked || (!preview && !status.available) || !pet.isVisible()) return false;
  if (moving) return true;
  if (!immediate && Math.random() > .4) return false;
  const from = pet.getBounds();
  const display = screen.getDisplayMatching(from);
  const area = display.workArea;
  const left = Math.max(0, from.x - area.x), right = Math.max(0, area.x + area.width - from.width - from.x);
  const top = Math.max(0, from.y - area.y), bottom = Math.max(0, area.y + area.height - from.height - from.y);
  const angle = Math.random() * 2 * Math.PI, distance = 120 + Math.random() * 150;
  let dx = Math.cos(angle), dy = Math.sin(angle);
  if ((dx < 0 && left < 40) || (dx > 0 && right < 40)) dx = -dx;
  if ((dy < 0 && top < 40) || (dy > 0 && bottom < 40)) dy = -dy;
  const target = clampPosition({ x: from.x + dx * distance, y: from.y + dy * distance }, from, area);
  const travel = Math.hypot(target.x - from.x, target.y - from.y);
  if (travel < 1) return false;
  const duration = Math.max(1000, travel * 1000 / (45 * settings.scale));
  const started = Date.now();
  moving = true;
  notify({ type: 'moving', active: true, direction: dx < 0 ? 'left' : 'right' });
  movement = setInterval(() => {
    if (!settings.roam || dragging || panel || locked || (!preview && !status.available)) return stopMovement();
    const t = Math.min(1, (Date.now() - started) / duration);
    const ease = t * t * (3 - 2 * t);
    pet.setPosition(Math.round(from.x + (target.x - from.x) * ease), Math.round(from.y + (target.y - from.y) * ease));
    if (t === 1) stopMovement();
  }, 16);
  return true;
}

function setShape(regions) {
  if (!pet || pet.isDestroyed() || process.platform === 'darwin') return;
  const rects = regions.filter(r => Number.isFinite(r.x + r.y + r.width + r.height) && r.width > 0 && r.height > 0)
    .map(r => ({ x: Math.max(0, Math.round(r.x)), y: Math.max(0, Math.round(r.y)), width: Math.ceil(r.width), height: Math.ceil(r.height) }));
  if (rects.length) pet.setShape(rects);
}

function setupIPC() {
  ipcMain.handle('pet:bootstrap', () => ({ settings, preview, remote: !!remote, observation: observationState() }));
  ipcMain.handle('pet:settings', (_event, patch) => saveSettings(patch));
  ipcMain.handle('pet:observation', (_event, enabled) => setObservation(!!enabled));
  ipcMain.on('pet:action', (_event, command) => {
    switch (command.operation) {
      case 'find': findPet(); break;
      case 'open_settings': openSettings(command.tab); break;
      case 'close_settings': settingsWindow?.close(); break;
      case 'play_animation': notify({ type: 'play_animation', name: command.name }); break;
      case 'hide': if (pet.isVisible()) toggleVisibility(); break;
      case 'quit': app.quit(); break;
      case 'restart': app.relaunch(); app.quit(); break;
      case 'shape': clearTimeout(shapeTimer); shapeTimer = setTimeout(() => setShape(command.regions), 10); break;
      case 'panel': panel = !!command.open; if (panel) stopMovement(); break;
      case 'drag_start': dragging = true; stopMovement(); dragStart = { pointer: screen.getCursorScreenPoint(), bounds: pet.getBounds() }; break;
      case 'drag': if (dragging) { const p = screen.getCursorScreenPoint(); pet.setPosition(dragStart.bounds.x + p.x - dragStart.pointer.x, dragStart.bounds.y + p.y - dragStart.pointer.y); } break;
      case 'drag_end': dragging = false; break;
      case 'roam_now': if (!roam(true)) notify({ type: 'notice', message: '她现在不方便移动。' }); break;
      case 'input': {
        if (typeof command.text !== 'string' || !command.text.trim() || command.text.length > 4000) break;
        spokeAt = Date.now();
        if (preview) { notify({ type: 'notice', message: '界面预览：消息未提交人物后端' }); break; }
        if (observationState().enabled && !observing && !dragging && !locked && status.available) {
          send({ operation: 'input', text: command.text, message_id: command.message_id, wait_for_screen: true });
          capture(true, command.text, command.message_id);
        } else send({ operation: 'input', text: command.text, message_id: command.message_id, clear_screen: true });
        break;
      }
      case 'ack': if (!preview && lastReply?.outbound_id === command.outbound_id) send(command); break;
      case 'speak': if (!preview && settings.voice && lastReply?.outbound_id === command.outbound_id) send({ ...command, delivery: lastReply.delivery }); break;
      case 'interrupt': send(command); break;
      case 'mic_start': if (preview) notify({ type: 'notice', message: '界面预览不接收麦克风' }); else send(command); break;
      case 'mic_stop': status.listening = false; send(command); updateTray(); break;
      case 'mic_active': status.listening = !!command.active; updateTray(); break;
      case 'pcm': if (!preview && typeof command.pcm === 'string' && command.pcm.length < 100000) send(command); break;
      case 'audio_receipt': speechPlaying = false; if (!preview && lastReply?.outbound_id === command.outbound_id) send(command); break;
    }
  });
}

app.whenReady().then(async () => {
if (!app.requestSingleInstanceLock() && !smoke) { app.quit(); }
else {
  const remoteFile = process.env.DWORLD_PET_LINK_FILE || (process.platform === 'win32' ? join(app.getPath('userData'), 'remote-link.json') : '');
  if (remoteFile) {
    try { remote = JSON.parse(await readFile(remoteFile, 'utf8')) || {}; }
    catch (error) { if (error.code !== 'ENOENT' || process.platform === 'win32') remote = {}; }
  }
  try { settings = normalizeSettings(JSON.parse(await readFile(settingsFile(), 'utf8'))); }
  catch { settings = normalizeSettings({}); }
  if (remote) settings = normalizeSettings({ ...settings, observationEnabled: false, voice: false });
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'media'));
  setupIPC();
  const area = screen.getPrimaryDisplay().workArea;
  const size = { width: 440, height: 660 };
  const position = clampPosition({ x: area.x + area.width - 460, y: area.y + area.height - 680 }, size, area);
  const iconPath = join(root, 'assets/app-icon.png');
  pet = new BrowserWindow({ ...size, ...position,
    ...(process.platform === 'linux' ? { type: 'dock' } : {}),
    frame: false, transparent: true, resizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, hasShadow: false,
    title: 'Dworld 桌面伙伴', icon: iconPath, webPreferences: { preload: join(root, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  pet.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  pet.webContents.on('will-navigate', event => event.preventDefault());
  await pet.loadFile(join(root, 'index.html'));
  pet.showInactive();
  const icon = nativeImage.createFromPath(iconPath).resize({ height: 28 });
  tray = new Tray(icon); tray.setToolTip('Dworld 桌面伙伴'); updateTray();
  tray.on('double-click', () => { locked = false; pet.showInactive(); });
  startBridge();
  if (screenShare && settings.observationEnabled && !preview) {
    notify({ type: 'notice', message: '开启观察并授权后，她才会看屏幕。' });
  }
  statusTimer = setInterval(() => send({ operation: 'status' }), 2500);
  observationTimer = setInterval(() => {
    const interval = settings.mode === 'companion' ? settings.companionCapture : settings.normalCapture;
    if (Date.now() - captureAt >= interval * 1000) { captureAt = Date.now(); capture(); }
  }, 1000);
  roamTimer = setInterval(roam, 35000);
  powerMonitor.on('lock-screen', () => { locked = true; stopScreenShare(); send({ operation: 'pause_observation' }); notify({ type: 'stop_microphone' }); });
  powerMonitor.on('unlock-screen', () => { locked = false; captureAt = Date.now(); });
  powerMonitor.on('suspend', () => { locked = true; stopScreenShare(); send({ operation: 'pause_observation' }); notify({ type: 'stop_microphone' }); });
  powerMonitor.on('resume', () => { locked = false; captureAt = Date.now(); });
  screen.on('display-added', stopScreenShare);
  screen.on('display-metrics-changed', stopScreenShare);
  screen.on('display-removed', () => { stopScreenShare(); const d = screen.getPrimaryDisplay(); const b = pet.getBounds(); const p = clampPosition(b, b, d.workArea); pet.setPosition(p.x, p.y); });
  app.on('second-instance', () => { locked = false; pet.show(); });
  if (smoke) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    await pet.webContents.executeJavaScript("document.querySelector('#chat-toggle').click()");
    await new Promise(resolve => setTimeout(resolve, 300));
    const path = process.env.DWORLD_PET_SMOKE_OUTPUT;
    if (path) await writeFile(path, (await pet.webContents.capturePage()).toPNG());
    const result = await pet.webContents.executeJavaScript("({title:document.title, image:document.querySelector('#character').dataset.ready === 'true', chat:!document.querySelector('#chat').hidden, observationDisabled:document.querySelector('#look').disabled, voiceDisabled:document.querySelector('#record').disabled})");
    console.log(JSON.stringify({ smoke: result, displays: screen.getAllDisplays().length }));
    app.quit();
  }
}
}).catch(error => { console.error(error); app.quit(); });

app.on('before-quit', () => {
  closing = true;
  clearTimeout(reconnectTimer);
  stopScreenShare();
  clearInterval(statusTimer); clearInterval(observationTimer); clearInterval(roamTimer); stopMovement();
  send({ operation: 'close' });
  remoteSocket?.close();
  if (bridge) { bridge.stdin.end(); setTimeout(() => bridge?.kill(), 2500).unref(); }
  tray?.destroy();
});
