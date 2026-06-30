/**
 * Shopee Dashboard — Server
 * Local:  node server.js  →  http://localhost:3001
 * Cloud:  deploy to Railway/Render, set env vars:
 *   PORT     — auto-set by platform
 *   DATA_DIR — path to persistent disk mount (e.g. /data)
 *   API_KEY  — secret key; extension must send X-Api-Key header
 */
const express = require('express');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');

const app     = express();
const PORT    = process.env.PORT    || 3001;
const DATA    = process.env.DATA_DIR || path.join(__dirname, 'data');
const API_KEY = process.env.API_KEY  || null; // null = no auth (local dev)

// ── API key auth middleware ───────────────────────────────────────────────────
function requireKey(req, res, next) {
  if (!API_KEY) return next(); // local dev: no key needed
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

app.use(cors()); // allow all origins (extension uses chrome-extension:// origin)
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ──────────────────────────────────────────────────────────
if (!fs.existsSync(DATA)) fs.mkdirSync(DATA, { recursive: true });

const FILES = {
  shops:       path.join(DATA, 'shops.json'),
  ads:         path.join(DATA, 'ads.json'),
  orders:      path.join(DATA, 'orders.json'),
  performance: path.join(DATA, 'performance.json'),
  traffic:     path.join(DATA, 'traffic.json'),
};

const PAGE_TYPES = ['ads','orders','performance','traffic'];

function read(file, def) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return def; }
}
function write(file, data) {
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}
function initFiles() {
  if (!fs.existsSync(FILES.shops)) write(FILES.shops, {});
  PAGE_TYPES.forEach(t => { if (!fs.existsSync(FILES[t])) write(FILES[t], []); });
}
initFiles();

// ── Harvest command (in-memory, survives only until restart) ─────────
let harvestCmd = null; // { triggeredAt: timestamp }

// ── Routes ───────────────────────────────────────────────────────────

// Health check — public (no key needed)
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: Date.now() }));

// Trigger harvest on all connected extensions — public (chỉ trigger, không lộ data)
app.post('/api/harvest/trigger', (req, res) => {
  harvestCmd = { command: 'start', triggeredAt: Date.now() };
  console.log('🤖 Harvest trigger sent at', new Date().toLocaleTimeString());
  res.json({ ok: true, triggeredAt: harvestCmd.triggeredAt });
});

// Extensions poll this — public so extension doesn't need key to check
app.get('/api/harvest/command', (req, res) => {
  const TTL = 5 * 60 * 1000; // 5 phút
  if (harvestCmd && (Date.now() - harvestCmd.triggeredAt) < TTL) {
    res.json(harvestCmd);
  } else {
    res.json({ command: null });
  }
});

const GENERIC_NAME = /kênh người bán|shopee seller|seller centre|portal/i;
const isGenericName = n => !n || GENERIC_NAME.test(n);

// Nhận dữ liệu từ Chrome Extension
app.post('/api/capture', requireKey, (req, res) => {
  const { pageType, shopId, shopName, url, method, json, ts, reqBody } = req.body;

  if (!PAGE_TYPES.includes(pageType)) return res.json({ ok: false, error: 'invalid pageType' });

  // Cập nhật registry shop
  const shops = read(FILES.shops, {});
  const sid = shopId || 'unknown';
  const ex = shops[sid] || {};
  const bestName = ex.customName ? ex.name
                 : !isGenericName(shopName) ? shopName
                 : !isGenericName(ex.name)  ? ex.name
                 : sid;
  shops[sid] = { shopId: sid, name: bestName, customName: ex.customName||false,
                 lastSeen: ts, firstSeen: ex.firstSeen||ts };
  write(FILES.shops, shops);

  // Smart upsert: cùng shopId + URL base + collectionDay → REPLACE
  // collectionDay = ngày harvest chạy (YYYY-MM-DD, GMT+7)
  const captures = read(FILES[pageType], []);

  // collectionDay: nhóm theo ngày thu thập, dùng để build time-series
  const tzOffset = 7 * 60; // GMT+7 in minutes
  const localDate = new Date(ts + tzOffset * 60 * 1000);
  const collectionDay = localDate.toISOString().slice(0, 10); // "2026-06-29"

  const dateKey = (() => {
    if (!reqBody) return null;
    const st = Number(reqBody.start_time || reqBody.from_time || 0);
    const et = Number(reqBody.end_time   || reqBody.to_time   || 0);
    return (st && et) ? `${Math.floor(st/86400)}_${Math.floor(et/86400)}` : null;
  })();

  const urlBase = (url||'').split('?')[0];
  // Dedup: cùng shop + URL base + collectionDay = cùng 1 harvest run → upsert
  const existIdx = captures.findIndex(c =>
    c.shopId === sid &&
    (c.url||'').split('?')[0] === urlBase &&
    c.collectionDay === collectionDay
  );

  const newCapture = { shopId: sid, shopName: bestName, url, method: method||'GET', json, ts, reqBody: reqBody||null, dateKey, collectionDay };
  if (existIdx >= 0) {
    captures[existIdx] = newCapture;
  } else {
    captures.push(newCapture);
    if (captures.length > 5000) captures.splice(0, captures.length - 5000);
  }
  write(FILES[pageType], captures);
  res.json({ ok: true, saved: true, replaced: existIdx >= 0 });
});

// Reset generic shop names
app.post('/api/shops/reset-names', requireKey, (req, res) => {
  const shops = read(FILES.shops, {});
  let count = 0;
  Object.values(shops).forEach(s => {
    if (!s.customName && GENERIC_NAME.test(s.name || '')) {
      s.name = s.shopId; count++;
    }
  });
  write(FILES.shops, shops);
  res.json({ ok: true, reset: count });
});

// Auto-update shop name from DOM scan
app.post('/api/shops/:id/autoname', requireKey, (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.json({ ok: false, error: 'name required' });
  const shops = read(FILES.shops, {});
  const s = shops[id];
  if (!s) return res.json({ ok: false, error: 'shop not found' });
  if (!s.customName && isGenericName(s.name)) {
    s.name = name.trim();
    write(FILES.shops, shops);
    return res.json({ ok: true, updated: true });
  }
  res.json({ ok: true, updated: false, reason: 'already has real name' });
});

// Đổi tên shop thủ công — public (ai biết URL cũng đổi được, chấp nhận vì là tool nội bộ)
app.patch('/api/shops/:id', (req, res) => {
  const { id } = req.params;
  const { name } = req.body;
  if (!name || !name.trim()) return res.json({ ok: false, error: 'name required' });
  const shops = read(FILES.shops, {});
  if (!shops[id]) shops[id] = { shopId: id, firstSeen: Date.now() };
  shops[id].name = name.trim();
  shops[id].customName = true;
  write(FILES.shops, shops);
  res.json({ ok: true });
});

// Lấy tất cả dữ liệu — public (dashboard đọc)
app.get('/api/data', (req, res) => {
  const { shopId } = req.query;
  const result = { shops: read(FILES.shops, {}) };
  PAGE_TYPES.forEach(t => {
    let d = read(FILES[t], []);
    if (shopId && shopId !== 'all') d = d.filter(c => c.shopId === shopId);
    result[t] = d;
  });
  res.json(result);
});

// Thống kê nhanh — public
app.get('/api/stats', (_, res) => {
  const shops = read(FILES.shops, {});
  const stats = { shopCount: Object.keys(shops).length };
  PAGE_TYPES.forEach(t => { stats[t] = read(FILES[t], []).length; });
  res.json(stats);
});

// Xóa dữ liệu
app.delete('/api/clear', (req, res) => {
  const { shopId } = req.query;
  if (shopId && shopId !== 'all') {
    PAGE_TYPES.forEach(t => {
      const d = read(FILES[t], []).filter(c => c.shopId !== shopId);
      write(FILES[t], d);
    });
    const shops = read(FILES.shops, {});
    delete shops[shopId];
    write(FILES.shops, shops);
  } else {
    write(FILES.shops, {});
    PAGE_TYPES.forEach(t => write(FILES[t], []));
  }
  res.json({ ok: true });
});

// Fallback về index.html
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  const isCloud = !!process.env.API_KEY;
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  🛒 Shopee Dashboard đã khởi động!   ║');
  console.log('╠══════════════════════════════════════╣');
  if (isCloud) {
    console.log(`║  ☁️  Cloud mode — PORT ${PORT}            ║`);
    console.log(`║  🔑 API_KEY: đã thiết lập             ║`);
  } else {
    console.log(`║  👉 Mở: http://localhost:${PORT}        ║`);
    console.log('║  ⚠️  Local mode — không cần API key   ║');
  }
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  // Tự mở browser chỉ trên local Windows
  if (!isCloud && process.platform === 'win32') {
    const { exec } = require('child_process');
    setTimeout(() => exec(`start http://localhost:${PORT}`), 1500);
  }
});
