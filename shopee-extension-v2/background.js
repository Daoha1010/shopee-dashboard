const DEFAULT_SERVER = 'https://shopee-dashboard-production-f0e1.up.railway.app';
const DEFAULT_API_KEY = 'shopee_dao2024_abc';
const TYPES = ['ads','orders','performance','traffic'];
const SELECTION_URL = 'https://banhang.shopee.vn/portal/';
let serverOnline = false;
let pageStatus = {};
let counts = { ads:0, orders:0, performance:0, traffic:0 };

// ── Config: đọc serverUrl + apiKey từ chrome.storage.sync ──
async function getConfig() {
  const { serverUrl, apiKey } = await chrome.storage.sync.get(['serverUrl','apiKey']);
  return {
    server: (serverUrl || DEFAULT_SERVER).replace(/\/$/, ''),
    apiKey: apiKey || DEFAULT_API_KEY
  };
}
function makeHeaders(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h['X-Api-Key'] = apiKey;
  return h;
}

// ── Dedup cache (url+ts within 5s) ──
const dedup = {};
function isDup(pageType, url, ts) {
  const k = pageType + '|' + url.substring(0, 80);
  if (dedup[k] && Math.abs(dedup[k] - ts) < 5000) return true;
  dedup[k] = ts; return false;
}

// ── Update badge ──
function updateBadge() {
  const total = Object.values(counts).reduce((a,b)=>a+b,0);
  chrome.action.setBadgeText({ text: total > 0 ? String(total) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#EE4D2D' });
}

// ── Check server health ──
async function ping() {
  const { server } = await getConfig();
  try {
    const res = await fetch(server + '/api/ping', { signal: AbortSignal.timeout(3000) });
    const j = await res.json();
    serverOnline = j.ok === true;
  } catch(e) {
    serverOnline = false;
  }
}
ping();
setInterval(ping, 10000);

// ── POST capture to server ──
async function postToServer(payload) {
  const { server, apiKey } = await getConfig();
  try {
    await fetch(server + '/api/capture', {
      method: 'POST',
      headers: makeHeaders(apiKey),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000)
    });
    return true;
  } catch(e) {
    return false;
  }
}

// ── Fallback: chrome.storage.local ──
async function saveLocal(pageType, payload) {
  const key = 'local_' + pageType;
  const res = await chrome.storage.local.get([key]);
  const arr = res[key] || [];
  arr.push(payload);
  if (arr.length > 500) arr.splice(0, arr.length - 500);
  await chrome.storage.local.set({ [key]: arr });
}

// ── Main message handler ──
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'CAPTURE') {
    const { pageType, url, method, json, ts, shopId, shopName, reqBody } = msg;
    if (!pageType || isDup(pageType, url, ts)) { reply({ok:false,reason:'dup'}); return true; }

    pageStatus[pageType] = 'has_data';
    counts[pageType] = (counts[pageType] || 0) + 1;
    updateBadge();

    const payload = { pageType, shopId, shopName, url, method: method||'GET', json, ts, reqBody: reqBody || null };

    if (serverOnline) {
      postToServer(payload).then(ok => {
        if (!ok) saveLocal(pageType, payload);
        reply({ ok: true, server: ok });
      });
    } else {
      saveLocal(pageType, payload).then(() => reply({ ok: true, server: false }));
    }
    return true;
  }

  if (msg.type === 'PAGE_OPENED') {
    const { pageType } = msg;
    if (pageType && !pageStatus[pageType]) pageStatus[pageType] = 'opened';
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'GET_STATUS') {
    getConfig().then(({ server }) => {
      reply({ pageStatus, counts, serverOnline, server });
    });
    return true;
  }

  if (msg.type === 'GET_LOCAL') {
    const keys = TYPES.map(t => 'local_' + t);
    chrome.storage.local.get(keys, res => {
      const out = {};
      TYPES.forEach(t => { out[t] = res['local_' + t] || []; });
      reply({ data: out });
    });
    return true;
  }

  if (msg.type === 'CLEAR_LOCAL') {
    const keys = TYPES.map(t => 'local_' + t);
    chrome.storage.local.remove(keys, () => reply({ ok: true }));
    counts = { ads:0, orders:0, performance:0, traffic:0 };
    pageStatus = {};
    updateBadge();
    return true;
  }

  if (msg.type === 'HARVEST_DONE') {
    const count = msg.count || 0;
    chrome.storage.local.remove('harvest');
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });
    setTimeout(() => updateBadge(), 5000);
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'TEST_CONNECTION') {
    // Popup asks background to test the configured server
    ping().then(() => reply({ ok: serverOnline }));
    return true;
  }
});

// ── Auto-harvest: start ngay cả khi chưa có shop trên server ─────────
async function startHarvestAuto() {
  const { harvest } = await chrome.storage.local.get('harvest');
  if (harvest?.active) return; // đã đang chạy

  const { server, apiKey } = await getConfig();
  let shops = [];
  try {
    const res = await fetch(server + '/api/data', {
      headers: makeHeaders(apiKey),
      signal: AbortSignal.timeout(8000)
    });
    const d = await res.json();
    shops = Object.values(d.shops || {}).map(s => ({ id: s.shopId, name: s.name || s.shopId }));
  } catch(e) {}

  // Nếu chưa có shop trên server, vẫn start — harvest.js sẽ tự detect từ tile
  // Dùng mảng rỗng, harvest.js dùng tiles.length để biết khi nào dừng
  await chrome.storage.local.set({
    harvest: {
      active: true, shops, shopIdx: 0, pageIdx: -1,
      selectionUrl: SELECTION_URL, startedAt: Date.now(), status: 'starting'
    }
  });

  const tabs = await chrome.tabs.query({ url: 'https://banhang.shopee.vn/*' });
  if (tabs.length > 0) {
    chrome.tabs.update(tabs[0].id, { url: SELECTION_URL, active: true });
  } else {
    chrome.tabs.create({ url: SELECTION_URL, active: true });
  }
}

// ── Poll server for harvest command ──────────────────────────────────
async function checkHarvestCommand() {
  const { harvest } = await chrome.storage.local.get('harvest');
  if (harvest?.active) return; // đang harvest rồi, bỏ qua

  const { server } = await getConfig();
  try {
    const res = await fetch(server + '/api/harvest/command', {
      signal: AbortSignal.timeout(5000)
    });
    const j = await res.json();
    if (j.command !== 'start') return;

    const { lastHarvestTrigger } = await chrome.storage.local.get('lastHarvestTrigger');
    if (lastHarvestTrigger && Math.abs(lastHarvestTrigger - j.triggeredAt) < 1000) return;

    await chrome.storage.local.set({ lastHarvestTrigger: j.triggeredAt });
    startHarvestAuto();
  } catch(e) {}
}

// Alarm: backup mỗi 1 phút (khi service worker bị kill rồi restart)
chrome.alarms.create('pollHarvestCommand', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'pollHarvestCommand') checkHarvestCommand();
});

// setInterval: poll mỗi 15 giây khi service worker còn sống
setInterval(checkHarvestCommand, 15000);
