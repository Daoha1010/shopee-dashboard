/**
 * harvest.js — Tự động thu thập dữ liệu Shopee
 *
 * Kiến trúc v2 (Date-Controlled Direct URL):
 *  - Date range được tính chính xác theo GMT+7, nhúng thẳng vào URL
 *  - Loại chiến dịch (CPC / GMV Max) điều khiển qua tham số type= trong URL
 *  - Shop context vẫn cần click tile (session-based), nhưng sau khi vào shop:
 *    navigate thẳng đến URL đúng, không chờ Shopee UI redirect lung tung
 *
 * Flow: chọn shop → [CPC] → [CPC tab2] → [GMV Max] → [Đơn hàng] → [SP] → [Traffic]
 *       → chọn shop tiếp theo → ...
 */

const BASE            = 'https://banhang.shopee.vn';
const DEFAULT_SERVER  = 'https://shopee-dashboard-production-f0e1.up.railway.app';
const DEFAULT_API_KEY = 'shopee_dao2024_abc';

// ─── Date helpers ─────────────────────────────────────────────────────────────
function getDateRange() {
  // Tất cả timestamp tính theo múi giờ GMT+7 (Việt Nam)
  const TZ  = 7 * 3600;
  const now = Math.floor(Date.now() / 1000);
  // 00:00:00 GMT+7 hôm nay, quy về UTC epoch
  const todayStart = Math.floor((now + TZ) / 86400) * 86400 - TZ;
  return {
    from: todayStart - 30 * 86400,  // 00:00 GMT+7 cách đây 30 ngày
    to:   todayStart - 1            // 23:59:59 GMT+7 hôm qua
  };
}

// Danh sách trang cần thu thập cho mỗi shop
// Date range được tính lúc bắt đầu harvest, nhúng vào URL → nhất quán
function buildShopPages(dateRange) {
  const { from, to } = dateRange || getDateRange();
  // group=custom + from/to timestamps → ta kiểm soát hoàn toàn, không phụ thuộc Shopee UI
  const DP = `source_page_id=1&from=${from}&to=${to}&group=custom`;
  return [
    {
      url:       `/portal/marketing/pas/index?${DP}&type=new_cpc_homepage`,
      match:     /type=new_cpc_homepage/,
      wait:      7000,
      clickTab2: true,   // CPC có 2 sub-tab, cần click thủ công
      waitTab2:  5000,
      label:     '📢 CPC (cả 2 tab)'
    },
    {
      url:   `/portal/marketing/pas/index?${DP}&type=new_smart_homepage`,
      match: /type=new_smart_homepage/,
      wait:  6000,
      label: '📊 GMV Max'
    },
    {
      url:       `/portal/sale/order`,
      match:     /\/sale\/order/,
      wait:      6000,
      multiPage: 8,     // click next page tối đa 8 lần → ~320 đơn
      pageWait:  3500,  // chờ mỗi trang load
      label:     '📦 Đơn hàng'
    },
    {
      url:   `/portal/datacenter/product/performance`,
      match: /datacenter.*performance/,
      wait:  5000,
      label: '📈 Hiệu quả SP'
    },
    {
      url:   `/portal/datacenter/product/traffic`,
      match: /datacenter.*traffic/,
      wait:  5000,
      label: '🔍 Traffic'
    }
  ];
}

// ─── Overlay UI ───────────────────────────────────────────────────────────────
let _overlay = null;

function showOverlay(html) {
  if (!_overlay) {
    _overlay = document.createElement('div');
    _overlay.id = '__harvest_overlay';
    Object.assign(_overlay.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
      background: '#1a1a2e', color: '#fff', padding: '16px 20px',
      borderRadius: '14px', fontSize: '13px', fontFamily: 'sans-serif',
      boxShadow: '0 6px 30px rgba(0,0,0,.5)', minWidth: '300px', maxWidth: '380px',
      lineHeight: '1.6', border: '1px solid rgba(255,255,255,.1)'
    });
    document.body.appendChild(_overlay);

    const stopBtn = document.createElement('div');
    stopBtn.style.cssText = 'margin-top:10px;text-align:right';
    stopBtn.innerHTML = '<button id="__harvest_stop" style="background:rgba(255,255,255,.15);color:#fff;border:none;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:11px;">⏹ Dừng</button>';
    _overlay.appendChild(stopBtn);
    document.getElementById('__harvest_stop').addEventListener('click', () => {
      clearState().then(() => hideOverlay());
    });
  }
  let body = _overlay.querySelector('#__harvest_body');
  if (!body) {
    body = document.createElement('div');
    body.id = '__harvest_body';
    _overlay.insertBefore(body, _overlay.firstChild);
  }
  body.innerHTML = html;
}

function hideOverlay() { _overlay?.remove(); _overlay = null; }

function progressBar(cur, total) {
  const pct = Math.round((cur / Math.max(total, 1)) * 100);
  return `
    <div style="background:rgba(255,255,255,.15);border-radius:4px;height:6px;margin-top:10px;overflow:hidden;">
      <div style="background:#EE4D2D;height:100%;width:${pct}%;transition:width .3s;"></div>
    </div>
    <div style="font-size:10px;color:#94a3b8;margin-top:4px">${cur}/${total} shop</div>`;
}

// ─── State ────────────────────────────────────────────────────────────────────
async function getState()        { const { harvest } = await chrome.storage.local.get('harvest'); return harvest || null; }
async function setState(s)       { await chrome.storage.local.set({ harvest: s }); }
async function clearState()      { await chrome.storage.local.remove('harvest'); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Click next page để thu thêm đơn hàng ────────────────────────────────────
async function clickNextPages(page, curShop, shopIdx, totalShops) {
  const maxPages = page.multiPage || 5;
  const pageWait = page.pageWait  || 3500;

  // Tìm nút "next page" với nhiều selector fallback
  const findNextBtn = () => {
    // Các selector phổ biến của Shopee seller center
    const sels = [
      'li.shopee-page-controller__page--next:not(.shopee-page-controller__page--disabled) button',
      'li[class*="next"]:not([class*="disabled"]) button',
      'button[class*="next"]:not(:disabled)',
      '[class*="page-next"]:not([disabled])',
      '[class*="pageNext"]:not([disabled])',
      '.ant-pagination-next:not(.ant-pagination-disabled) button',
      '.ant-pagination-next:not(.ant-pagination-disabled)',
      '[aria-label="Next Page"]:not([disabled])',
      '[title="Next Page"]',
    ];
    for (const sel of sels) {
      try {
        const el = document.querySelector(sel);
        if (el && !el.disabled && el.offsetParent !== null) return el;
      } catch(e) {}
    }
    // Fallback: tìm button/li chứa ký tự > hoặc svg mũi tên phải
    for (const el of document.querySelectorAll('li, button')) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      if (el.classList.toString().toLowerCase().includes('disabled')) continue;
      const txt = el.textContent.trim();
      if (txt === '>' || txt === '›' || txt === '»') return el;
      // SVG arrow right
      if (el.querySelector('svg') && /next|right|forward/i.test(el.className)) return el;
    }
    return null;
  };

  for (let p = 1; p <= maxPages; p++) {
    showOverlay(
      `🤖 <b>Thu thập tự động</b><br>` +
      `Shop <b>${shopIdx + 1}/${totalShops}</b>: ${curShop.name}<br>` +
      `${page.label} — Trang <b>${p + 1}</b>/<b>${maxPages + 1}</b><br>` +
      `<span style="font-size:11px;color:#94a3b8">Đang tải đơn hàng...</span>` +
      progressBar(shopIdx, totalShops)
    );

    const btn = findNextBtn();
    if (!btn) break;   // Không tìm thấy → hết trang hoặc đã trang cuối

    btn.click();
    await sleep(pageWait);
  }
}

// ─── Shop tile detection ──────────────────────────────────────────────────────
function findShopTiles() {
  const SELS = [
    '[class*="shop-item"]','[class*="shopItem"]','[class*="shop_item"]',
    '[class*="ShopItem"]','[class*="shop-card"]','[class*="shopCard"]',
    '[class*="item-wrap"]','[class*="itemWrap"]'
  ];
  for (const sel of SELS) {
    const els = [...document.querySelectorAll(sel)];
    if (els.length >= 2) return els;
  }
  // Fallback DOM scan
  return [...document.querySelectorAll('div,li,a')].filter(el => {
    if (el.children.length < 1 || el.children.length > 8) return false;
    const hasAvatar = el.querySelector('[class*="avatar"],[class*="Avatar"],[class*="icon"],[class*="logo"]');
    const txt = el.textContent.trim();
    return hasAvatar && txt.length > 3 && txt.length < 60;
  });
}

function isSelectionPage(state) {
  const href = location.href;
  if (state?.selectionUrl) {
    const a = state.selectionUrl.split('?')[0].replace(/\/+$/, '');
    const b = href.split('?')[0].replace(/\/+$/, '');
    if (a === b) return true;
  }
  if (/banhang\.shopee\.vn\/portal\/?$/.test(href.replace(/\?.*/, ''))) return true;
  if (/shop_select|switch_shop|shop_switch/.test(href)) return true;
  return findShopTiles().length >= 2;
}

// ─── Main harvest step ────────────────────────────────────────────────────────
async function runHarvestStep() {
  const state = await getState();
  if (!state?.active) return;

  const dateRange = state.dateRange || getDateRange();
  const pages     = buildShopPages(dateRange);
  const shops     = state.shops    || [];
  const shopIdx   = state.shopIdx  || 0;
  const pageIdx   = typeof state.pageIdx === 'number' ? state.pageIdx : -1;
  const href      = location.href;

  // ── Xong hết shop ────────────────────────────────────────────────────────────
  if (shops.length > 0 && shopIdx >= shops.length) {
    await clearState();
    hideOverlay();
    showDoneToast(shops.length);
    return;
  }

  const curShop = shops[shopIdx] || { id: `shop_${shopIdx}`, name: `Shop ${shopIdx + 1}` };

  // ── Case A: Trang chọn shop → discover hoặc click tile ───────────────────────
  if (isSelectionPage(state)) {
    await sleep(2500);
    const tiles = findShopTiles();

    // Lần đầu: discover danh sách shop từ tiles DOM
    if (shops.length === 0) {
      if (tiles.length === 0) {
        showOverlay('⚠️ Không tìm được shop nào. Kiểm tra đăng nhập Shopee.');
        return;
      }
      const discovered = tiles.map((t, i) => ({
        id:   'shop_' + i,
        name: t.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) || `Shop ${i + 1}`
      }));
      // Tính date range một lần, dùng cho toàn bộ harvest
      const dr = getDateRange();
      await setState({ ...state, shops: discovered, dateRange: dr });
      setTimeout(runHarvestStep, 500);
      return;
    }

    // Click tile của shop hiện tại
    showOverlay(
      `🤖 <b>Thu thập tự động</b><br>` +
      `Chọn shop <b>${shopIdx + 1}/${shops.length}</b>: <b>${curShop.name}</b>` +
      progressBar(shopIdx, shops.length)
    );
    await sleep(800);

    let target = null;
    const shopName = (curShop.name || '').toLowerCase().trim();
    if (shopName.length >= 3) {
      for (const t of tiles) {
        if (t.textContent.toLowerCase().includes(shopName.slice(0, 6))) { target = t; break; }
      }
    }
    if (!target) target = tiles[shopIdx] || tiles[tiles.length - 1];
    if (!target) {
      showOverlay(`⚠️ Không tìm được tile shop #${shopIdx + 1}.`);
      return;
    }

    // Sau khi click tile, sẽ redirect vào shop → ta sẽ tự navigate tiếp đến đúng URL
    await setState({ ...state, shopIdx, pageIdx: 0, status: 'entering_shop' });
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await sleep(500);
    const link = target.querySelector('a') || target.closest('a');
    if (link?.href && link.href !== location.href && link.href.includes('shopee.vn')) {
      location.href = link.href;
    }
    return;
  }

  // ── Case B: Đang ở trong shop, thu thập theo pageIdx ─────────────────────────
  if (pageIdx >= 0 && pageIdx < pages.length) {
    const page = pages[pageIdx];

    // Nếu không đúng trang → navigate thẳng đến URL đã tính sẵn (có date range)
    if (!page.match.test(href)) {
      showOverlay(
        `🤖 <b>Thu thập tự động</b><br>` +
        `Shop <b>${shopIdx + 1}/${shops.length}</b>: ${curShop.name}<br>` +
        `→ Chuyển đến ${page.label}...`
      );
      await sleep(1200);
      location.href = BASE + page.url;
      return;
    }

    // Đang đúng trang → đợi API load
    showOverlay(
      `🤖 <b>Thu thập tự động</b><br>` +
      `Shop <b>${shopIdx + 1}/${shops.length}</b>: ${curShop.name}<br>` +
      `Trang <b>${pageIdx + 1}/${pages.length}</b>: ${page.label}<br>` +
      `<span style="font-size:11px;color:#94a3b8">Đợi dữ liệu load... (${page.wait / 1000}s)</span>` +
      progressBar(shopIdx, shops.length)
    );
    await sleep(page.wait);

    // Click next page để load thêm đơn hàng
    if (page.multiPage) {
      await clickNextPages(page, curShop, shopIdx, shops.length);
    }

    // CPC: click tab 2 (Tự Động Chọn Sản phẩm cấp độ Shop)
    if (page.clickTab2) {
      const TAB2 = ['Tự Động', 'cấp độ Shop', 'Tự động chọn', 'Auto'];
      let tab2 = null;
      for (const el of document.querySelectorAll('[role="tab"]')) {
        if (TAB2.some(t => el.textContent.includes(t))) { tab2 = el; break; }
      }
      if (!tab2) {
        for (const el of document.querySelectorAll('[class*="tab"]')) {
          if (TAB2.some(t => el.textContent.includes(t))) { tab2 = el; break; }
        }
      }
      if (tab2) {
        showOverlay(
          `🤖 <b>Thu thập tự động</b><br>` +
          `Shop <b>${shopIdx + 1}/${shops.length}</b>: ${curShop.name}<br>` +
          `${page.label} — Tab 2: Tự Động Chọn SP...<br>` +
          `<span style="font-size:11px;color:#94a3b8">Đợi... (${(page.waitTab2 || 5000) / 1000}s)</span>` +
          progressBar(shopIdx, shops.length)
        );
        tab2.click();
        await sleep(page.waitTab2 || 5000);
      }
    }

    // Chuyển trang kế
    const next = pageIdx + 1;
    if (next < pages.length) {
      await setState({ ...state, shopIdx, pageIdx: next, status: 'visiting' });
      location.href = BASE + pages[next].url;
    } else {
      // Xong shop này → shop tiếp theo
      const nextShop = shopIdx + 1;
      if (nextShop >= shops.length) {
        await clearState();
        hideOverlay();
        showDoneToast(shops.length);
      } else {
        showOverlay(
          `✅ <b>Shop ${shopIdx + 1} xong!</b><br>` +
          `Chuyển sang shop ${nextShop + 1}/${shops.length}...` +
          progressBar(nextShop, shops.length)
        );
        await setState({ ...state, shopIdx: nextShop, pageIdx: -1, status: 'switching' });
        await sleep(1200);
        location.href = state.selectionUrl || (BASE + '/portal/');
      }
    }
    return;
  }

  // ── Case C: pageIdx = -1, không ở selection page → quay về selection ──────────
  showOverlay(`🤖 <b>Thu thập tự động</b><br>Đang quay về trang chọn shop...`);
  await sleep(1800);
  location.href = state.selectionUrl || (BASE + '/portal/');
}

// ─── Done toast ───────────────────────────────────────────────────────────────
function showDoneToast(count) {
  const d = document.createElement('div');
  Object.assign(d.style, {
    position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
    background: '#16a34a', color: '#fff', padding: '14px 20px',
    borderRadius: '12px', fontSize: '14px', fontWeight: '700',
    fontFamily: 'sans-serif', boxShadow: '0 4px 20px rgba(0,0,0,.3)'
  });
  const { from, to } = getDateRange();
  const fmt = ts => new Date(ts * 1000).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
  d.textContent = `✅ Đã thu thập xong ${count} shop! (${fmt(from)} → ${fmt(to)})`;
  document.body.appendChild(d);
  setTimeout(() => d.remove(), 7000);
  chrome.runtime.sendMessage({ type: 'HARVEST_DONE', count });
}

// ─── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === 'STOP_HARVEST') {
    clearState().then(() => { hideOverlay(); reply({ ok: true }); });
    return true;
  }
  if (msg.type === 'GET_HARVEST_STATE') {
    getState().then(s => reply({ state: s }));
    return true;
  }
});

// ─── Entry point ──────────────────────────────────────────────────────────────
async function checkCommandAndStart() {
  const state = await getState();

  // Đang harvest → tiếp tục
  if (state?.active) {
    setTimeout(runHarvestStep, 1800);
    return;
  }

  // Poll server xem có lệnh harvest mới không
  try {
    const { serverUrl } = await chrome.storage.sync.get(['serverUrl']);
    const server = (serverUrl || DEFAULT_SERVER).replace(/\/$/, '');
    const res = await fetch(server + '/api/harvest/command', {
      signal: AbortSignal.timeout(6000)
    });
    const j = await res.json();

    if (j.command === 'start') {
      const { lastHarvestTrigger } = await chrome.storage.local.get('lastHarvestTrigger');
      const alreadyDone = lastHarvestTrigger && Math.abs(lastHarvestTrigger - j.triggeredAt) < 1000;
      if (!alreadyDone) {
        await chrome.storage.local.set({ lastHarvestTrigger: j.triggeredAt });
        const dr = getDateRange();
        await setState({
          active: true, shops: [], shopIdx: 0, pageIdx: -1,
          dateRange: dr,
          selectionUrl: BASE + '/portal/',
          startedAt: Date.now(), status: 'starting'
        });
        location.href = BASE + '/portal/';
        return;
      }
    }
  } catch(e) { /* server không reach được */ }

  setTimeout(runHarvestStep, 1800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => setTimeout(checkCommandAndStart, 1800));
} else {
  setTimeout(checkCommandAndStart, 1800);
}
