import { interactionClips } from './sprites.mjs';

const api = window.pet;
const $ = selector => document.querySelector(selector);
let { settings, remote, observation } = await api.bootstrap();
const dirty = new Set();
const pages = {
  appearance: ['外观', '大小与行动'],
  companion: ['陪伴', '观察与发言'],
  'voice-settings': ['语音', '回复与设备'],
  'pet-actions': ['互动', '动作与管理']
};

function selectTab(name) {
  if (!pages[name]) name = 'appearance';
  for (const tab of document.querySelectorAll('[data-tab]')) {
    const selected = tab.dataset.tab === name;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    document.getElementById(tab.dataset.tab).hidden = !selected;
  }
  [$('#page-title').textContent, $('#page-description').textContent] = pages[name];
  $('footer span').textContent = name === 'appearance' ? '大小立即生效' : '';
}

function sync() {
  for (const [key, value] of Object.entries(settings)) {
    const element = document.getElementById(key);
    if (!element || key === 'observationEnabled' || dirty.has(key)) continue;
    if (element.type === 'checkbox') element.checked = value;
    else element.value = value;
  }
  $('#observationEnabled').checked = observation.enabled;
  $('#observationEnabled').disabled = remote || observation.pending;
  if (remote) for (const id of ['voice', 'microphone', 'speaker']) $(`#${id}`).disabled = true;
  $('#scale-value').value = `${Math.round(Number($('#scale').value) * 100)}%`;
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.onclick = () => selectTab(tab.dataset.tab);
  tab.onkeydown = event => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll('[data-tab]')];
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (tabs.indexOf(tab) + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : tabs.length - 1)) % tabs.length;
    tabs[index].click(); tabs[index].focus();
  };
}

for (const control of document.querySelectorAll('input:not(#observationEnabled), select')) {
  control.addEventListener('input', () => dirty.add(control.id));
  control.addEventListener('change', () => dirty.add(control.id));
}
$('#observationEnabled').addEventListener('change', async event => {
  try { observation = await api.observation(event.target.checked); }
  finally { sync(); }
});
$('#scale').addEventListener('input', () => { $('#scale-value').value = `${Math.round(Number($('#scale').value) * 100)}%`; });
$('#scale').addEventListener('change', async () => {
  settings = await api.settings({ scale: Number($('#scale').value) });
  dirty.delete('scale'); sync();
});
$('#save-settings').onclick = async () => {
  const patch = {};
  for (const key of dirty) {
    const element = document.getElementById(key);
    patch[key] = element.type === 'checkbox' ? element.checked : ['number', 'range'].includes(element.type) ? Number(element.value) : element.value;
  }
  if (Object.keys(patch).length) await api.settings(patch);
  api.action({ operation: 'close_settings' });
};
for (const clip of interactionClips) {
  const button = document.createElement('button');
  button.type = 'button'; button.textContent = clip.label;
  button.onclick = () => { api.action({ operation: 'close_settings' }); api.action({ operation: 'play_animation', name: clip.name }); };
  $('#motion-list').append(button);
}
for (const [id, operation] of [['find-pet', 'find'], ['hide-pet', 'hide'], ['restart-pet', 'restart'], ['quit-pet', 'quit']]) {
  document.getElementById(id).onclick = () => { api.action({ operation: 'close_settings' }); api.action({ operation }); };
}
api.onEvent(event => {
  if (event.type === 'settings') { settings = event.settings; sync(); }
  if (event.type === 'observation') { observation = event; sync(); }
  if (event.type === 'settings_tab') selectTab(event.tab);
});
window.addEventListener('keydown', event => { if (event.key === 'Escape') api.action({ operation: 'close_settings' }); });
selectTab(new URLSearchParams(location.search).get('tab'));
sync();
navigator.mediaDevices.enumerateDevices().then(devices => {
  for (const [id, kind] of [['microphone', 'audioinput'], ['speaker', 'audiooutput']]) {
    const select = document.getElementById(id);
    select.replaceChildren(new Option('系统默认', ''));
    devices.filter(device => device.kind === kind).forEach((device, index) => select.add(new Option(device.label || `设备 ${index + 1}`, device.deviceId)));
  }
  sync();
}).catch(() => {});
