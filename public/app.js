// ---------- PWA ----------
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

// role of the signed-in user ('admin' or 'salesman'), set during init
let currentRole = 'admin';
const isAdmin = () => currentRole !== 'salesman';

// ---------- helpers ----------
const $ = id => document.getElementById(id);
const api = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
};
const post = (url, body) => api(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});

const rs = n => 'Rs ' + Math.round(parseFloat(n) || 0).toLocaleString('en-PK');
const qty = n => {
  const v = parseFloat(n) || 0;
  return Number.isInteger(v) ? v : v.toFixed(2);
};
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtDate = d => {
  if (!d) return '';
  const s = String(d).slice(0, 10);            // 'YYYY-MM-DD' — parse directly, no timezone shift
  const [y, m, day] = s.split('-').map(Number);
  return `${String(day).padStart(2,'0')}-${MONTHS[m - 1]}-${y}`;
};
const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = cat => `<span class="badge badge-${esc(cat)}">${esc(cat)}</span>`;

const PAY_EMOJI = {
  'Cash': '💵',
  'JazzCash / Easypaisa': '📱',
  'Credit (Udhaar)': '📒',
  'Bank Alfalah': '🏦', 'Bank of Punjab': '🏦', 'Meezan Bank': '🏦'
};
const payLabel = p => p ? `${PAY_EMOJI[p] || '🏦'} ${esc(p)}` : '';

let toastTimer;
function toast(msg, isErr) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.className = 'toast', 3200);
}

// ---------- themed dialog boxes (replace browser alert/confirm/prompt) ----------
let confirmResolve = null;
function uiConfirm(title, messageHtml, okLabel = 'Yes, Delete') {
  return new Promise(resolve => {
    confirmResolve = resolve;
    $('confirmTitle').textContent = title;
    $('confirmMsg').innerHTML = messageHtml;
    $('confirmOk').textContent = okLabel;
    $('confirmModal').classList.add('show');
  });
}
function settleConfirm(v) {
  $('confirmModal').classList.remove('show');
  if (confirmResolve) { confirmResolve(v); confirmResolve = null; }
}
$('confirmOk').addEventListener('click', () => settleConfirm(true));
$('confirmCancel').addEventListener('click', () => settleConfirm(false));
$('confirmModal').addEventListener('click', ev => { if (ev.target === $('confirmModal')) settleConfirm(false); });

let inputResolve = null;
function uiPrompt(title, label, value = '') {
  return new Promise(resolve => {
    inputResolve = resolve;
    $('inputTitle').textContent = title;
    $('inputLabel').textContent = label;
    $('inputField').value = value;
    $('inputModal').classList.add('show');
    setTimeout(() => $('inputField').focus(), 50);
  });
}
function settleInput(v) {
  $('inputModal').classList.remove('show');
  if (inputResolve) { inputResolve(v); inputResolve = null; }
}
$('inputOk').addEventListener('click', () => settleInput($('inputField').value));
$('inputCancel').addEventListener('click', () => settleInput(null));
$('inputModal').addEventListener('click', ev => { if (ev.target === $('inputModal')) settleInput(null); });
$('inputField').addEventListener('keydown', ev => { if (ev.key === 'Enter') settleInput($('inputField').value); });

// ---------- input validation ----------
// number fields: physically block letters and signs ('e' is valid in HTML number inputs!)
document.addEventListener('keydown', ev => {
  if (ev.target.matches && ev.target.matches('input[type="number"]') &&
      ['e', 'E', '+', '-'].includes(ev.key)) ev.preventDefault();
});
document.addEventListener('paste', ev => {
  if (ev.target.matches && ev.target.matches('input[type="number"]')) {
    const text = (ev.clipboardData || window.clipboardData).getData('text');
    if (!/^\s*\d*\.?\d*\s*$/.test(text)) {
      ev.preventDefault();
      toast('Only numbers can go in this field', true);
    }
  }
});

// letters (English or Urdu), spaces, dots, hyphens, apostrophes
const isName = v => /^[\p{L}\s.\-']+$/u.test(v);
const isPhone = v => /^[0-9+\-\s()]{7,20}$/.test(v);

function checkPos(val, label) {
  const n = parseFloat(val);
  if (!(n > 0)) { toast(`${label} must be a number more than 0`, true); return false; }
  if (n > 99999999) { toast(`${label} looks too big — please check it`, true); return false; }
  return true;
}
function checkMoneyOpt(val, label) { // optional money field: blank is fine, else 0 or more
  if (val === '' || val === null || val === undefined) return true;
  const n = parseFloat(val);
  if (isNaN(n) || n < 0) { toast(`${label} must be 0 or more`, true); return false; }
  if (n > 99999999) { toast(`${label} looks too big — please check it`, true); return false; }
  return true;
}
function checkNotFuture(val, label) {
  if (val && val > todayISO()) { toast(`${label} cannot be in the future`, true); return false; }
  return true;
}
function checkCustomer() {
  const name = $('custName').value.trim();
  const phone = $('custPhone').value.trim();
  if (name && !isName(name)) { toast('Customer name should have letters only — no numbers', true); return false; }
  if (phone && !isPhone(phone)) { toast('Phone number should have digits only (7–20 characters)', true); return false; }
  return true;
}

// ---------- navigation ----------
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    $('page-' + btn.dataset.page).classList.add('active');
    refresh(btn.dataset.page);
  });
});

// reload all data shown on whichever page is open — called after every save,
// by the 🔄 button, and by the 60-second background refresh
function refreshCurrentPage() {
  const btn = document.querySelector('.nav-btn.active');
  if (btn) refresh(btn.dataset.page);
}
setInterval(() => {
  if (document.visibilityState === 'visible') refreshCurrentPage();
}, 60000);

function refresh(page) {
  if (page === 'dashboard') loadDashboard();
  if (page === 'products') loadProducts();
  if (page === 'stockin') { loadProductOptions(); loadPurchases(); }
  if (page === 'sales') { loadProductOptions(); loadSales(); loadReplacements(); loadMyDay(); }
  if (page === 'register') { loadProductOptions(); loadRegister(); }
  if (page === 'partners') { loadPartners(); loadInvestments(); fillInvestProducts(); }
  if (page === 'expenses') loadExpenses();
  if (page === 'logs') unlockAndLoadLogs();
}

// the Logs section has its own password on top of the normal login
async function unlockAndLoadLogs() {
  try {
    const st = await api('/api/logs/status');
    if (!st.unlocked) {
      $('logsPw').value = '';
      $('logsModal').classList.add('show');
      setTimeout(() => $('logsPw').focus(), 50);
      return;
    }
    loadLogs();
  } catch (e) { toast(e.message, true); }
}

function closeLogsModal(goBack) {
  $('logsModal').classList.remove('show');
  if (goBack) document.querySelector('.nav-btn[data-page="dashboard"]').click();
}

$('logsPwOk').addEventListener('click', async () => {
  try {
    await post('/api/logs/unlock', { password: $('logsPw').value });
    closeLogsModal(false);
    toast('Logs unlocked ✔');
    loadLogs();
  } catch {
    toast('Wrong logs password', true);
    $('logsPw').value = '';
    $('logsPw').focus();
  }
});
$('logsPw').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('logsPwOk').click(); });
$('logsPwCancel').addEventListener('click', () => closeLogsModal(true));
$('logsModal').addEventListener('click', ev => { if (ev.target === $('logsModal')) closeLogsModal(true); });

// ---------- dashboard ----------
async function loadDashboard() {
  try {
    const d = await api('/api/dashboard');
    $('stStock').textContent = rs(d.stockValue);
    $('stProfit').textContent = rs(d.totalProfit);
    $('stShare').textContent = rs(d.profitShare);
    $('stToday').textContent = rs(d.todaySales);
    $('stTodaySub').textContent = d.todayCount > 0 ? `${d.todayCount} sale${d.todayCount>1?'s':''} today` : 'No sales yet today';
    $('stCash').textContent = rs(d.cashReceived);
    $('stBank').textContent = rs(d.bankReceived);
    $('stBankSub').textContent = d.creditOutstanding > 0
      ? `+ ${rs(d.creditOutstanding)} still owed on credit (udhaar)` : 'credit (udhaar) not counted';
    $('stSales').textContent = rs(d.totalSales);
    $('stPurch').textContent = rs(d.totalPurchases);
    $('stPurchSub').textContent = d.supplierPayable > 0.001
      ? `${rs(d.supplierPayable)} still to pay suppliers` : 'all purchases fully paid';
    $('stExpenses').textContent = rs(d.totalExpenses);
    $('stNet').textContent = rs(d.netProfit);
    $('stNet').style.color = d.netProfit < 0 ? 'var(--red)' : '';

    const medals = ['🥇', '🥈', '🥉'];
    $('bestList').innerHTML = d.bestSellers.length ? d.bestSellers.map((p, i) => `<div class="rank-item">
        <span>${medals[i]} <b>${esc(p.name)}</b> <span class="sub">${qty(p.soldQty)} ${esc(p.unit)} sold</span></span>
        <span class="amt ${p.profit < 0 ? 'neg' : 'pos'}">${rs(p.profit)}</span>
      </div>`).join('') : '<div class="all-good">No sales yet — best sellers will appear here</div>';
    $('slowList').innerHTML = d.slowMovers.length ? d.slowMovers.map(p => `<div class="rank-item">
        <span><b>${esc(p.name)}</b> <span class="sub">${qty(p.soldQty)} ${esc(p.unit)} sold · ${qty(p.remaining)} ${esc(p.unit)} on shelf</span></span>
        <span class="amt gold">${rs(p.stockValue)}</span>
      </div>`).join('') : '<div class="all-good">No stock lying idle</div>';

    last7Cache = d.last7.map(x => ({ label: x.day, amt: x.amt, profit: x.profit }));
    if (chartView === '7d') renderChart(last7Cache, 'day');
    populateChartMonths();

    $('lowStockList').innerHTML = d.lowStock.length
      ? d.lowStock.map(p => `<div class="low-item">
          <span><b>${esc(p.name)}</b> <span class="cat">(${esc(p.category)})</span></span>
          <span class="left-qty">${qty(p.remaining)} ${esc(p.unit)} left</span>
        </div>`).join('')
      : '<div class="all-good">✅ All products are well stocked</div>';
  } catch (e) { toast(e.message, true); }
}

// ---------- dashboard chart views ----------
let chartView = '7d';
let last7Cache = [];

const monthLabel = m => { const [y, mm] = m.split('-').map(Number); return `${MONTHS[mm - 1]} ${y}`; };

function renderChart(data, type) {
  const chart = $('chart7');
  const dense = data.length > 12;
  chart.className = 'chart' + (dense ? ' dense' : '');
  const max = Math.max(...data.map(x => Math.max(x.amt, x.profit || 0)), 1);
  chart.innerHTML = data.map(x => {
    const hS = Math.round((x.amt / max) * 150);
    const profit = x.profit || 0;
    const hP = Math.round((Math.abs(profit) / max) * 150);
    let lbl;
    if (type === 'month') lbl = monthLabel(x.label);
    else {
      const [, m, day] = x.label.split('-').map(Number);
      lbl = dense ? String(day) : `${String(day).padStart(2, '0')} ${MONTHS[m - 1]}`;
    }
    const when = type === 'month' ? monthLabel(x.label) : fmtDate(x.label);
    const tip = `${when} — Sales: ${rs(x.amt)} · Profit: ${rs(profit)}`;
    return `<div class="bar-col" title="${tip}">
      ${x.amt > 0 && !dense ? `<div class="bar-val">${rs(x.amt)}</div>` : ''}
      <div class="bar-pair">
        <div class="bar ${x.amt === 0 ? 'empty' : ''}" style="height:${Math.max(hS, 4)}px"></div>
        <div class="bar profit ${profit === 0 ? 'empty' : (profit < 0 ? 'neg' : '')}" style="height:${Math.max(hP, 4)}px"></div>
      </div>
      <div class="bar-day">${lbl}</div>
    </div>`;
  }).join('');
}

async function populateChartMonths() {
  try {
    const months = await api('/api/chart?view=months');
    const sel = $('chartMonth'); const v = sel.value;
    sel.innerHTML = '<option value="">📅 Pick a month…</option>' +
      months.slice().reverse().map(m => `<option value="${m.label}">${monthLabel(m.label)}</option>`).join('');
    if ([...sel.options].some(o => o.value === v)) sel.value = v;
  } catch { /* not fatal */ }
}

function setChartChips(view) {
  document.querySelectorAll('#chartChips .chip').forEach(c =>
    c.classList.toggle('active', c.dataset.view === view));
}

$('chartChips').addEventListener('click', async ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  chartView = btn.dataset.view;
  setChartChips(chartView);
  $('chartMonth').value = '';
  if (chartView === '7d') {
    $('chartTitle').textContent = 'Sales — last 7 days';
    renderChart(last7Cache, 'day');
  } else {
    $('chartTitle').textContent = 'Sales — all months';
    try { renderChart(await api('/api/chart?view=months'), 'month'); }
    catch (e) { toast(e.message, true); }
  }
});

$('chartMonth').addEventListener('change', async () => {
  const m = $('chartMonth').value;
  if (!m) return;
  chartView = 'month-days';
  setChartChips('');
  $('chartTitle').textContent = `Sales — ${monthLabel(m)} (day by day)`;
  try { renderChart(await api('/api/chart?month=' + m), 'day'); }
  catch (e) { toast(e.message, true); }
});

// ---------- full analytics view (click the dashboard chart to open) ----------
let bigView = 'months';
let bigMonthsCache = [];

function drawBigChart(data, type) {
  const max = Math.max(...data.map(m => Math.max(m.sales, Math.abs(m.profit))), 1);
  const dense = data.length > 12;
  $('bigChart').innerHTML = data.map(m => {
    const hS = Math.max(Math.round((m.sales / max) * 250), 4);
    const hP = Math.max(Math.round((Math.abs(m.profit) / max) * 250), 4);
    let lbl;
    if (type === 'month') lbl = monthLabel(m.label);
    else {
      const [, mo, day] = m.label.split('-').map(Number);
      lbl = dense ? String(day) : `${String(day).padStart(2, '0')} ${MONTHS[mo - 1]}`;
    }
    const when = type === 'month' ? monthLabel(m.label) : fmtDate(m.label);
    return `<div class="bar-col" title="${when} — Sales: ${rs(m.sales)} · Profit: ${rs(m.profit)}">
      ${!dense && m.sales > 0 ? `<div class="bar-val sales-val">${rs(m.sales)}</div>` : ''}
      ${!dense && m.profit !== 0 ? `<div class="bar-val ${m.profit < 0 ? 'loss-val' : ''}">${rs(m.profit)}</div>` : ''}
      <div class="bar-pair">
        <div class="bar ${m.sales === 0 ? 'empty' : ''}" style="height:${hS}px"></div>
        <div class="bar profit ${m.profit === 0 ? 'empty' : (m.profit < 0 ? 'neg' : '')}" style="height:${hP}px"></div>
      </div>
      <div class="bar-day">${lbl}</div>
    </div>`;
  }).join('');
}

// numbers table under the big chart: one row per period + TOTAL
function renderAnalyticsTable(rows, labelOf, periodHead) {
  const tot = rows.reduce((a, m) => ({
    sales: a.sales + m.sales, profit: a.profit + m.profit,
    purchases: a.purchases + m.purchases, expenses: a.expenses + m.expenses, net: a.net + m.net
  }), { sales: 0, profit: 0, purchases: 0, expenses: 0, net: 0 });
  const cell = (v, signed) => `<td class="r ${signed && v < 0 ? 'red' : ''}">${rs(v)}</td>`;
  $('analyticsPeriodHead').textContent = periodHead;
  $('analyticsRows').innerHTML = rows.map(m => `<tr>
      <td class="b">${labelOf(m.label)}</td>
      ${cell(m.sales)}${cell(m.profit, true)}${cell(m.profit * 0.05, true)}${cell(m.purchases)}${cell(m.expenses)}${cell(m.net, true)}
    </tr>`).join('') +
    `<tr style="font-weight:800"><td class="b">TOTAL</td>
      ${cell(tot.sales)}${cell(tot.profit, true)}${cell(tot.profit * 0.05, true)}${cell(tot.purchases)}${cell(tot.expenses)}${cell(tot.net, true)}</tr>`;
  $('analyticsTableWrap').style.display = '';
}

const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function renderBigView() {
  try {
    if (bigView === 'months') {
      $('analyticsTitle').textContent = '📊 Full Analytics — Month by Month';
      drawBigChart(bigMonthsCache.map(m => ({ label: m.label, sales: m.sales, profit: m.profit })), 'month');
      renderAnalyticsTable(bigMonthsCache, monthLabel, 'Month');
    } else if (bigView === '7d') {
      $('analyticsTitle').textContent = '📊 Full Analytics — Last 7 Days';
      const to = new Date(); const from = new Date(to.getTime() - 6 * 86400000);
      const days = await api(`/api/analytics?from=${isoLocal(from)}&to=${isoLocal(to)}`);
      drawBigChart(days, 'day');
      renderAnalyticsTable(days, fmtDate, 'Day');
    } else { // a specific month, day by day
      $('analyticsTitle').textContent = `📊 Full Analytics — ${monthLabel(bigView)} (day by day)`;
      const [y, m] = bigView.split('-').map(Number);
      const last = new Date(y, m, 0).getDate();
      const days = await api(`/api/analytics?from=${bigView}-01&to=${bigView}-${String(last).padStart(2, '0')}`);
      drawBigChart(days, 'day');
      renderAnalyticsTable(days, fmtDate, 'Day');
    }
  } catch (e) { toast(e.message, true); }
}

async function openAnalytics() {
  try {
    bigMonthsCache = await api('/api/analytics');
    const sel = $('bigMonth');
    sel.innerHTML = '<option value="">📅 Pick a month…</option>' +
      bigMonthsCache.slice().reverse().map(m => `<option value="${m.label}">${monthLabel(m.label)}</option>`).join('');
    bigView = 'months';
    sel.value = '';
    document.querySelectorAll('#bigChips .chip').forEach(c => c.classList.toggle('active', c.dataset.view === 'months'));
    await renderBigView();
    $('analyticsModal').classList.add('show');
  } catch (e) { toast(e.message, true); }
}

$('bigChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  bigView = btn.dataset.view;
  $('bigMonth').value = '';
  document.querySelectorAll('#bigChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderBigView();
});
$('bigMonth').addEventListener('change', () => {
  if (!$('bigMonth').value) return;
  bigView = $('bigMonth').value;
  document.querySelectorAll('#bigChips .chip').forEach(c => c.classList.remove('active'));
  renderBigView();
});

$('chart7').addEventListener('click', openAnalytics);
$('analyticsClose').addEventListener('click', () => $('analyticsModal').classList.remove('show'));
$('analyticsModal').addEventListener('click', ev => {
  if (ev.target === $('analyticsModal')) $('analyticsModal').classList.remove('show');
});

// ---------- products ----------
let productListCache = [];
let productFilter = '';
let productSearchTerm = '';

$('catChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  productFilter = btn.dataset.cat;
  document.querySelectorAll('#catChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderProducts();
});

$('productSearch').addEventListener('input', () => {
  productSearchTerm = $('productSearch').value.trim().toLowerCase();
  $('productSearchClear').style.display = productSearchTerm ? '' : 'none';
  renderProducts();
});
$('productSearchClear').addEventListener('click', () => {
  $('productSearch').value = '';
  productSearchTerm = '';
  $('productSearchClear').style.display = 'none';
  renderProducts();
  $('productSearch').focus();
});

function fillProductDatalist() {
  $('productNames').innerHTML = productListCache
    .map(p => `<option value="${esc(p.name)}">`).join('');
}

async function loadProducts() {
  try {
    productListCache = await api('/api/products');
    fillProductDatalist();
    renderProducts();
  } catch (e) { toast(e.message, true); }
}

function renderProducts() {
  let rows = productFilter
    ? productListCache.filter(p => p.category === productFilter)
    : productListCache;
  if (productSearchTerm) {
    rows = rows.filter(p =>
      p.name.toLowerCase().includes(productSearchTerm) ||
      (p.description || '').toLowerCase().includes(productSearchTerm) ||
      p.category.toLowerCase().includes(productSearchTerm));
  }
  $('productRows').innerHTML = rows.length ? rows.map(p => `<tr>
      <td class="b">${esc(p.name)}</td>
      <td>${badge(p.category)}</td>
      <td>${esc(p.description)}</td>
      <td class="r">${qty(p.purchasedQty)} ${esc(p.unit)}</td>
      <td class="r">${qty(p.soldQty)} ${esc(p.unit)}</td>
      <td class="r ${p.remaining <= 0 ? 'red' : 'b'}">${qty(p.remaining)} ${esc(p.unit)}</td>
      <td class="r">${rs(p.avgCost)}</td>
      <td class="r ${p.salePrice > 0 && p.salePrice < p.avgCost ? 'red' : 'b'}">${p.salePrice > 0 ? rs(p.salePrice) : '—'}</td>
      <td><button class="edit-btn" onclick="editProduct(${p.id})" title="Edit">✏️</button><button class="del-btn" onclick="delProduct(${p.id}, '${esc(p.name)}')">🗑️</button></td>
    </tr>`).join('') : `<tr><td colspan="9" class="empty-row">${productSearchTerm
      ? 'No product matching "' + esc(productSearchTerm) + '"'
      : productFilter
        ? 'No ' + esc(productFilter.toLowerCase()) + ' products yet'
        : 'No products yet — add your first product above'}</td></tr>`;
}

let editProductId = null;

function editProduct(id) {
  const p = productListCache.find(x => x.id === id);
  if (!p) return;
  editProductId = id;
  $('pName').value = p.name; $('pCategory').value = p.category;
  $('pUnit').value = p.unit; $('pDesc').value = p.description;
  $('pSalePrice').value = p.salePrice > 0 ? p.salePrice : '';
  $('pSaveBtn').textContent = '✔ Update Product';
  $('pCancel').style.display = '';
  $('pName').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetProductForm() {
  editProductId = null;
  $('pName').value = ''; $('pDesc').value = ''; $('pSalePrice').value = '';
  $('pSaveBtn').textContent = '+ Save Product';
  $('pCancel').style.display = 'none';
}
$('pCancel').addEventListener('click', resetProductForm);

$('productForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!checkMoneyOpt($('pSalePrice').value, 'Fixed sale price')) return;
  const body = {
    name: $('pName').value, category: $('pCategory').value,
    unit: $('pUnit').value, description: $('pDesc').value,
    sale_price: $('pSalePrice').value || 0
  };
  try {
    if (editProductId) {
      await api('/api/products/' + editProductId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      toast('Product updated ✔');
    } else {
      await post('/api/products', body);
      toast('Product saved ✔');
    }
    resetProductForm();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function delProduct(id, name) {
  if (!(await uiConfirm('Delete Product?',
    `Delete <b>"${esc(name)}"</b> and ALL its purchases &amp; sales?<br>This cannot be undone.`))) return;
  try { await api('/api/products/' + id, { method: 'DELETE' }); toast('Product deleted'); refreshCurrentPage(); }
  catch (e) { toast(e.message, true); }
}

// product dropdowns (stock in, sales, register filter)
let productCache = [];
async function loadProductOptions() {
  try {
    productCache = await api('/api/products');
    const opts = productCache.map(p => `<option value="${p.id}">${esc(p.name)} (${esc(p.category)})</option>`).join('');
    const keep = (sel, first) => {
      const v = sel.value;
      sel.innerHTML = first + opts;
      if ([...sel.options].some(o => o.value === v)) sel.value = v;
    };
    keep($('buyProduct'), '<option value="">— choose product —</option>');
    keep($('sellProduct'), '<option value="">— choose product —</option>');
    keep($('regProduct'), '<option value="">All products</option>');
    $('saleProducts').innerHTML = productCache.map(p => `<option value="${esc(p.name)}">`).join('');
  } catch (e) { /* server not ready */ }
}

// ---------- printable rate list ----------
$('rateListBtn').addEventListener('click', () => {
  const priced = productListCache.filter(p => p.salePrice > 0)
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  if (!priced.length) { toast('No products have a fixed sale price yet — set them in the form above', true); return; }
  const w = window.open('', '_blank', 'width=600,height=760');
  w.document.write(`<!DOCTYPE html><html><head><title>Rate List</title><style>
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 26px; color: #000; background: #fff; }
    .rc { max-width: 480px; margin: 0 auto; }
    h1 { font-size: 26px; text-align: center; margin: 0; }
    .sub { text-align: center; font-size: 12.5px; color: #333; margin: 3px 0; }
    table { width: 100%; font-size: 14.5px; border-collapse: collapse; margin-top: 14px; }
    th { background: #2a1b52; color: #fff; text-align: left; padding: 7px 10px; font-size: 12px; text-transform: uppercase; }
    td { padding: 7px 10px; border-bottom: 1px solid #ddd; }
    td.r, th.r { text-align: right; }
    tr:nth-child(even) td { background: #f7f5fc; }
    .cat { font-weight: 700; background: #ece7f8 !important; }
    .foot { text-align: center; font-size: 12px; color: #555; margin-top: 16px; }
  </style></head><body><div class="rc">
    <img src="${location.origin}/logo.svg" width="84" height="84" style="display:block;margin:0 auto 6px" alt="">
    <h1>Kisan Depot — Rate List</h1>
    <div class="sub">Fertilizers • Seeds • Pesticides</div>
    <div class="sub" style="direction:rtl">وڈانہ اڈا، مین فیروزپور روڈ، قصور۔</div>
    <div class="sub">📞 0305-9191759 &nbsp;•&nbsp; ${fmtDate(todayISO())}</div>
    <table>
      <tr><th>Product</th><th>Unit</th><th class="r">Price</th></tr>
      ${(() => {
        let lastCat = ''; let rows = '';
        priced.forEach(p => {
          if (p.category !== lastCat) {
            lastCat = p.category;
            rows += `<tr><td class="cat" colspan="3">${esc(p.category)}s</td></tr>`;
          }
          rows += `<tr><td>${esc(p.name)}</td><td>per ${esc(p.unit)}</td><td class="r"><b>${rs(p.salePrice)}</b></td></tr>`;
        });
        return rows;
      })()}
    </table>
    <div class="foot">Prices can change with market rates — please confirm at the counter.</div>
  </div><script>window.onload = () => window.print();<\/script></body></html>`);
  w.document.close();
  w.focus();
});

// ---------- stock in ----------
let purchaseCache = [];
let purchaseCatFilter = '';
let purchaseSearchTerm = '';

$('buyChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  purchaseCatFilter = btn.dataset.cat;
  document.querySelectorAll('#buyChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderPurchases();
});

$('purchaseSearch').addEventListener('input', () => {
  purchaseSearchTerm = $('purchaseSearch').value.trim().toLowerCase();
  $('purchaseSearchClear').style.display = purchaseSearchTerm ? '' : 'none';
  renderPurchases();
});
$('purchaseSearchClear').addEventListener('click', () => {
  $('purchaseSearch').value = '';
  purchaseSearchTerm = '';
  $('purchaseSearchClear').style.display = 'none';
  renderPurchases();
  $('purchaseSearch').focus();
});

function fillPurchaseDatalist() {
  const names = [...new Set(purchaseCache.map(r => r.name))].sort();
  $('purchaseProductNames').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

async function loadPurchases() {
  try {
    purchaseCache = await api('/api/purchases');
    fillPurchaseDatalist();
    const today = todayISO();
    const todayTotal = purchaseCache
      .filter(r => String(r.purchase_date).slice(0, 10) === today)
      .reduce((s, r) => s + parseFloat(r.qty) * parseFloat(r.unit_price) + (parseFloat(r.transport) || 0), 0);
    $('purchTodayPill').textContent = `Today's Purchases: ${rs(todayTotal)}`;
    renderPurchases();
  } catch (e) { toast(e.message, true); }
}

function renderPurchases() {
  // salesmen see arrival dates and quantities only — cost columns are admin-only
  $('purchaseRows').closest('table').classList.toggle('hide-costs', !isAdmin());
  let rows = purchaseCatFilter
    ? purchaseCache.filter(r => r.category === purchaseCatFilter)
    : purchaseCache;
  if (purchaseSearchTerm) {
    rows = rows.filter(r =>
      r.name.toLowerCase().includes(purchaseSearchTerm) ||
      r.category.toLowerCase().includes(purchaseSearchTerm));
  }
  $('purchaseRows').innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${fmtDate(r.purchase_date)}</td>
      <td class="b">${esc(r.name)} ${badge(r.category)}</td>
      <td class="r">${qty(r.qty)} ${esc(r.unit)}</td>
      <td class="r">${rs(r.unit_price)}</td>
      <td class="r">${rs(r.transport)}</td>
      <td class="r b">${rs(r.qty * r.unit_price + parseFloat(r.transport || 0))}</td>
      <td class="r">${rs(r.paid)}</td>
      <td class="r">${r.remaining > 0.001
        ? `<span class="due">${rs(r.remaining)}</span>
           <button class="pay-btn" onclick="openPay('purchases', ${r.id}, '${esc(r.name)}', ${r.remaining})">💰 Pay</button>`
        : '<span class="paid-ok">✓ Paid</span>'}</td>
      <td>${isAdmin() ? `<button class="del-btn" onclick="delPurchase(${r.id})">🗑️</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="9" class="empty-row">${purchaseSearchTerm
      ? 'No purchases matching "' + esc(purchaseSearchTerm) + '"'
      : purchaseCatFilter
        ? 'No ' + esc(purchaseCatFilter.toLowerCase()) + ' purchases yet'
        : 'No purchases recorded yet'}</td></tr>`;
}

const updBuyTotal = () => $('buyTotal').textContent =
  rs((parseFloat($('buyQty').value) || 0) * (parseFloat($('buyPrice').value) || 0)
     + (parseFloat($('buyTransport').value) || 0));
$('buyQty').addEventListener('input', updBuyTotal);
$('buyPrice').addEventListener('input', updBuyTotal);
$('buyTransport').addEventListener('input', updBuyTotal);

const setLocked = (ids, locked) => ids.forEach(i => { $(i).disabled = locked; });

$('purchaseForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!checkNotFuture($('buyDate').value, 'Purchase date')) return;
  if (!checkPos($('buyQty').value, 'Quantity')) return;
  if (!checkPos($('buyPrice').value, 'Unit price')) return;
  if (!checkMoneyOpt($('buyTransport').value, 'Transport charges')) return;
  if (!checkMoneyOpt($('buyPaid').value, 'Amount paid now')) return;
  try {
    await post('/api/purchases', {
      product_id: $('buyProduct').value, purchase_date: $('buyDate').value,
      qty: $('buyQty').value, unit_price: $('buyPrice').value,
      transport: $('buyTransport').value, paid_now: $('buyPaid').value
    });
    toast('Purchase saved ✔');
    $('buyQty').value = ''; $('buyPrice').value = ''; $('buyTransport').value = ''; $('buyPaid').value = '';
    $('buySearch').value = ''; $('buyStockHint').innerHTML = '';
    updBuyTotal();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function delPurchase(id) {
  if (!(await uiConfirm('Delete Purchase?', 'This purchase entry and its payment records will be removed.'))) return;
  try { await api('/api/purchases/' + id, { method: 'DELETE' }); toast('Purchase deleted'); refreshCurrentPage(); }
  catch (e) { toast(e.message, true); }
}

// ---------- sales ----------
let saleCache = [];
let saleCatFilter = '';
let saleSearchTerm = '';

$('sellChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  saleCatFilter = btn.dataset.cat;
  document.querySelectorAll('#sellChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderSales();
});

$('saleSearch').addEventListener('input', () => {
  saleSearchTerm = $('saleSearch').value.trim().toLowerCase();
  $('saleSearchClear').style.display = saleSearchTerm ? '' : 'none';
  renderSales();
});
$('saleSearchClear').addEventListener('click', () => {
  $('saleSearch').value = '';
  saleSearchTerm = '';
  $('saleSearchClear').style.display = 'none';
  renderSales();
  $('saleSearch').focus();
});

function fillCustomerDatalist() {
  const names = [...new Set(saleCache.map(r => r.customer_name).filter(n => n && n.trim()))].sort();
  $('customerNames').innerHTML = names.map(n => `<option value="${esc(n)}">`).join('');
}

async function loadSales() {
  try {
    saleCache = await api('/api/sales');
    fillCustomerDatalist();
    const today = todayISO();
    const todayTotal = saleCache
      .filter(r => String(r.sale_date).slice(0, 10) === today)
      .reduce((s, r) => s + (parseFloat(r.effTotal) || 0), 0);
    $('salesTodayPill').textContent = `Today's Sales: ${rs(todayTotal)}`;
    renderSales();
  } catch (e) { toast(e.message, true); }
}

function renderSales() {
  let rows = saleCatFilter
    ? saleCache.filter(r => r.category === saleCatFilter)
    : saleCache;
  if (saleSearchTerm) {
    rows = rows.filter(r =>
      (r.customer_name || '').toLowerCase().includes(saleSearchTerm) ||
      (r.phone || '').toLowerCase().includes(saleSearchTerm));
  }
  $('saleRows').innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${fmtDate(r.sale_date)}</td>
      <td class="b">${esc(r.name)} ${badge(r.category)}${r.replaced_note
        ? `<br><span class="ret-note">🔁 ${esc(r.replaced_note)}</span>` : ''}</td>
      <td class="r">${qty(r.effQty)} ${esc(r.unit)}${r.returned > 0
        ? ` <span class="ret-note">↩ ${qty(r.returned)} ret.</span>` : ''}</td>
      <td class="r">${rs(r.sale_price)}</td>
      <td class="r b">${rs(r.effTotal)}</td>
      <td class="r">${rs(r.paidNet)}</td>
      <td class="r">${r.remaining > 0.001
        ? `<span class="due">${rs(r.remaining)}</span>
           <button class="pay-btn" onclick="openPay('sales', ${r.id}, '${esc(r.customer_name) || esc(r.name)}', ${r.remaining})">💰 Receive</button>`
        : '<span class="paid-ok">✓ Paid</span>'}</td>
      <td>${payLabel(r.payment)}</td>
      <td>${esc(r.customer_name)}</td>
      <td>${esc(r.phone)}</td>
      <td>${r.effQty > 0.001 && withinReturnWindow(r.sale_date) ? `<button class="ret-btn" onclick="openReplace(${r.id})" title="Replace product (within 3 days)">🔁</button>` : ''}<button class="print-btn" onclick="printReceipt(${r.id})" title="Print receipt">🖨️</button>${isAdmin() ? `<button class="edit-btn" onclick="editSale(${r.id})" title="Edit">✏️</button><button class="del-btn" onclick="delSale(${r.id})">🗑️</button>` : ''}</td>
    </tr>`).join('') : `<tr><td colspan="11" class="empty-row">${saleSearchTerm
      ? 'No sales matching "' + esc(saleSearchTerm) + '"'
      : saleCatFilter
        ? 'No ' + esc(saleCatFilter.toLowerCase()) + ' sales yet'
        : 'No sales recorded yet'}</td></tr>`;
}

// live guards: digits can't be typed into the name, letters can't be typed into the phone
$('custName').addEventListener('input', () => {
  const clean = $('custName').value.replace(/[0-9]/g, '');
  if (clean !== $('custName').value) { $('custName').value = clean; toast('Names cannot contain numbers', true); }
});
$('custPhone').addEventListener('input', () => {
  const clean = $('custPhone').value.replace(/[^\d+\-\s()]/g, '');
  if (clean !== $('custPhone').value) { $('custPhone').value = clean; toast('Phone numbers cannot contain letters', true); }
});

const updSellTotal = () => {
  let total = (parseFloat($('sellQty').value) || 0) * (parseFloat($('sellPrice').value) || 0);
  document.querySelectorAll('#extraItems .extra-item').forEach(row => {
    total += (parseFloat(row.querySelector('.xQty').value) || 0) *
             (parseFloat(row.querySelector('.xPrice').value) || 0);
  });
  $('sellTotal').textContent = rs(total);
};
$('sellQty').addEventListener('input', updSellTotal);
$('sellPrice').addEventListener('input', updSellTotal);

// extra product lines for one receipt
function extraItemRow() {
  const div = document.createElement('div');
  div.className = 'form-row extra-item';
  div.innerHTML = `
    <div class="field"><label>Product</label>
      <input type="text" class="product-search xSearch" list="saleProducts" placeholder="🔍 Type to search…" autocomplete="off">
      <select class="xProduct"><option value="">— choose product —</option>${productCache.map(p =>
        `<option value="${p.id}">${esc(p.name)} (${esc(p.category)})</option>`).join('')}</select>
      <div class="hint xStock"></div></div>
    <div class="field"><label>Quantity</label>
      <input type="number" class="xQty" min="0" step="any" placeholder="0"></div>
    <div class="field"><label>Sale Price per unit (Rs)</label>
      <input type="number" class="xPrice" min="0" step="any" placeholder="0.00"></div>
    <div class="field btn-field"><button type="button" class="btn-ghost xRemove">✖ Remove</button></div>`;
  return div;
}
$('addItemBtn').addEventListener('click', () => { $('extraItems').appendChild(extraItemRow()); });
$('extraItems').addEventListener('click', ev => {
  if (ev.target.classList.contains('xRemove')) {
    ev.target.closest('.extra-item').remove();
    updSellTotal();
  }
});
$('extraItems').addEventListener('input', ev => {
  if (ev.target.classList && ev.target.classList.contains('xSearch')) {
    const p = findProductByText(ev.target.value);
    if (p) {
      const sel = ev.target.closest('.field').querySelector('.xProduct');
      sel.value = p.id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }
  updSellTotal();
});

$('extraItems').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter' || !ev.target.classList || !ev.target.classList.contains('xSearch')) return;
  ev.preventDefault();
  const p = bestProductMatch(ev.target.value);
  if (!p) return;
  ev.target.value = p.name;
  const row = ev.target.closest('.extra-item');
  const sel = row.querySelector('.xProduct');
  sel.value = p.id;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  row.querySelector('.xQty').focus();
});

function gatherSaleItems() {
  const items = [{ product_id: $('sellProduct').value, qty: $('sellQty').value, sale_price: $('sellPrice').value }];
  document.querySelectorAll('#extraItems .extra-item').forEach(row => {
    items.push({
      product_id: row.querySelector('.xProduct').value,
      qty: row.querySelector('.xQty').value,
      sale_price: row.querySelector('.xPrice').value
    });
  });
  return items;
}

// choosing Bank Transfer reveals the bank picker
$('sellPayment').addEventListener('change', () => {
  $('bankField').style.display = $('sellPayment').value === 'Bank' ? '' : 'none';
});

// type-to-search: matches a product by name and selects it in the dropdown
function findProductByText(t) {
  const q = String(t || '').trim().toLowerCase();
  if (!q) return null;
  const exact = productCache.find(p => p.name.toLowerCase() === q);
  if (exact) return exact;
  const starts = productCache.filter(p => p.name.toLowerCase().startsWith(q));
  if (starts.length === 1) return starts[0];
  const contains = productCache.filter(p => p.name.toLowerCase().includes(q));
  return contains.length === 1 ? contains[0] : (starts[0] || null);
}

function bestProductMatch(t) {
  const q = String(t || '').trim().toLowerCase();
  if (!q) return null;
  return productCache.find(p => p.name.toLowerCase() === q) ||
         productCache.find(p => p.name.toLowerCase().startsWith(q)) ||
         productCache.find(p => p.name.toLowerCase().includes(q)) || null;
}

$('sellSearch').addEventListener('input', () => {
  const p = findProductByText($('sellSearch').value);
  if (p) {
    $('sellProduct').value = p.id;
    $('sellProduct').dispatchEvent(new Event('change'));
  }
});

// Enter accepts the best suggestion and jumps to the quantity field
$('sellSearch').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault(); // don't submit the form
  const p = bestProductMatch($('sellSearch').value);
  if (!p) return;
  $('sellSearch').value = p.name;
  $('sellProduct').value = p.id;
  $('sellProduct').dispatchEvent(new Event('change'));
  $('sellQty').focus();
});

// same type-to-search on the New Purchase form
$('buySearch').addEventListener('input', () => {
  const p = findProductByText($('buySearch').value);
  if (p) {
    $('buyProduct').value = p.id;
    $('buyProduct').dispatchEvent(new Event('change'));
  }
});
$('buySearch').addEventListener('keydown', ev => {
  if (ev.key !== 'Enter') return;
  ev.preventDefault();
  const p = bestProductMatch($('buySearch').value);
  if (!p) return;
  $('buySearch').value = p.name;
  $('buyProduct').value = p.id;
  $('buyProduct').dispatchEvent(new Event('change'));
  $('buyQty').focus();
});
$('buyProduct').addEventListener('change', () => {
  const p = productCache.find(x => String(x.id) === $('buyProduct').value);
  $('buyStockHint').innerHTML = stockHintHtml(p);
});

// picking a product auto-fills its fixed price and shows remaining stock
const stockHintHtml = p => p
  ? `<span class="${p.remaining <= 10 ? 'due' : 'paid-ok'}">${qty(p.remaining)} ${esc(p.unit)} in stock</span>`
  : '';

$('sellProduct').addEventListener('change', () => {
  const p = productCache.find(x => String(x.id) === $('sellProduct').value);
  if (p && p.salePrice > 0) { $('sellPrice').value = p.salePrice; updSellTotal(); }
  $('sellStockHint').innerHTML = stockHintHtml(p);
});
$('extraItems').addEventListener('change', ev => {
  if (ev.target.classList && ev.target.classList.contains('xProduct')) {
    const p = productCache.find(x => String(x.id) === ev.target.value);
    if (p && p.salePrice > 0) {
      ev.target.closest('.extra-item').querySelector('.xPrice').value = p.salePrice;
      updSellTotal();
    }
    ev.target.closest('.field').querySelector('.xStock').innerHTML = stockHintHtml(p);
  }
});

// ---------- My Day: today's counter summary + day-close slip ----------
let mydayCache = null;

async function loadMyDay() {
  try {
    const d = await api('/api/myday');
    mydayCache = d;
    $('mydayStats').innerHTML =
      `<span class="tot">Sales: <b>${rs(d.salesTotal)}</b> (${d.salesCount})</span>` +
      `<span class="tot">Cash in: <b>${rs(d.cashIn)}</b></span>` +
      `<span class="tot">Bank in: <b>${rs(d.bankIn)}</b></span>` +
      (d.refundsOut > 0 ? `<span class="tot">Refunds out: <b class="due">${rs(d.refundsOut)}</b></span>` : '') +
      (d.supplierCashOut > 0 ? `<span class="tot">Supplier cash out: <b class="due">${rs(d.supplierCashOut)}</b></span>` : '') +
      `<span class="tot">Net cash in drawer: <b>${rs(d.netCash)}</b></span>`;
  } catch (e) { $('mydayStats').textContent = ''; }
}

$('dayCloseBtn').addEventListener('click', () => {
  const d = mydayCache;
  if (!d) { toast('Summary not loaded yet', true); return; }
  const now = new Date();
  let h = now.getHours(); const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  const w = window.open('', '_blank', 'width=440,height=680');
  w.document.write(`<!DOCTYPE html><html><head><title>Day-Close Slip</title><style>
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 24px; color: #000; background: #fff; }
    .rc { max-width: 340px; margin: 0 auto; border: 1.5px solid #000; padding: 18px 20px; }
    h1 { font-size: 22px; text-align: center; margin: 0; }
    .sub { text-align: center; font-size: 12.5px; color: #333; margin: 3px 0 12px; }
    table { width: 100%; font-size: 15px; border-collapse: collapse; }
    td { padding: 6px 2px; border-bottom: 1px dashed #ccc; }
    td.r { text-align: right; font-weight: 600; }
    .net td { font-weight: bold; font-size: 17px; border-top: 1.5px solid #000; border-bottom: none; padding-top: 10px; }
    .sign { display: flex; justify-content: space-between; margin-top: 34px; font-size: 13px; }
    .sign span { border-top: 1px solid #000; padding-top: 5px; width: 45%; text-align: center; }
  </style></head><body><div class="rc">
    <img src="${location.origin}/logo.svg" width="72" height="72" style="display:block;margin:0 auto 6px" alt="">
    <h1>Day-Close Slip</h1>
    <div class="sub">${fmtDate(todayISO())} • ${h}:${String(now.getMinutes()).padStart(2, '0')} ${ampm}<br>
      Closed by: <b>${esc($('whoami').textContent.replace('Signed in as ', ''))}</b></div>
    <table>
      <tr><td>Sales today (${d.salesCount} entries)</td><td class="r">${rs(d.salesTotal)}</td></tr>
      <tr><td>Cash received</td><td class="r">${rs(d.cashIn)}</td></tr>
      <tr><td>Bank / wallet received</td><td class="r">${rs(d.bankIn)}</td></tr>
      <tr><td>Cash paid to suppliers</td><td class="r">− ${rs(d.supplierCashOut)}</td></tr>
      ${d.purchasesCount > 0 ? `<tr><td>Purchases recorded (${d.purchasesCount})</td><td class="r">${rs(d.purchasesTotal)}</td></tr>` : ''}
      <tr class="net"><td>NET CASH TO HAND OVER</td><td class="r">${rs(d.netCash)}</td></tr>
    </table>
    <div class="sign"><span>Salesman</span><span>Admin</span></div>
  </div><script>window.onload = () => window.print();<\/script></body></html>`);
  w.document.close();
  w.focus();
});

let editSaleId = null;
const BANKS = ['Bank Alfalah', 'Bank of Punjab', 'Meezan Bank'];

function editSale(id) {
  const r = saleCache.find(x => x.id === id);
  if (!r) return;
  editSaleId = id;
  $('sellProduct').value = r.product_id;
  $('sellDate').value = String(r.sale_date).slice(0, 10);
  $('sellQty').value = parseFloat(r.qty);
  $('sellPrice').value = parseFloat(r.sale_price);
  if (BANKS.includes(r.payment)) {
    $('sellPayment').value = 'Bank'; $('sellBank').value = r.payment;
    $('bankField').style.display = '';
  } else {
    $('sellPayment').value = r.payment;
    $('bankField').style.display = 'none';
  }
  $('custName').value = r.customer_name; $('custPhone').value = r.phone; $('custAddress').value = r.address;
  $('extraItems').innerHTML = '';
  $('addItemBtn').style.display = 'none';
  // only date and customer details are editable — item, price and payment are locked
  setLocked(['sellProduct', 'sellQty', 'sellPrice', 'sellPayment', 'sellBank'], true);
  $('sellPaidField').style.display = 'none'; // payments are edited with the 💰 button, not here
  $('sellSaveBtn').textContent = '✔ Update Details';
  $('sellCancel').style.display = '';
  updSellTotal();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetSaleForm() {
  editSaleId = null;
  $('sellQty').value = ''; $('sellPrice').value = ''; $('sellPaid').value = '';
  $('sellSearch').value = ''; $('sellStockHint').innerHTML = '';
  $('extraItems').innerHTML = '';
  $('addItemBtn').style.display = '';
  $('custName').value = ''; $('custPhone').value = ''; $('custAddress').value = '';
  setLocked(['sellProduct', 'sellQty', 'sellPrice', 'sellPayment', 'sellBank'], false);
  $('sellPaidField').style.display = '';
  $('sellSaveBtn').textContent = '+ Save Sale';
  $('sellCancel').style.display = 'none';
  updSellTotal();
}
$('sellCancel').addEventListener('click', resetSaleForm);

$('saleForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!checkNotFuture($('sellDate').value, 'Sale date')) return;
  if (!checkCustomer()) return;
  const items = editSaleId ? [] : gatherSaleItems();
  if (!editSaleId) {
    for (const it of items) {
      if (!it.product_id) { toast('Choose a product for every line', true); return; }
      if (!checkPos(it.qty, 'Quantity')) return;
      if (!checkPos(it.sale_price, 'Sale price')) return;
    }
    if (!checkMoneyOpt($('sellPaid').value, 'Amount received now')) return;
  }
  const payMethod = $('sellPayment').value === 'Bank' ? $('sellBank').value : $('sellPayment').value;
  try {
    if (editSaleId) {
      await api('/api/sales/' + editSaleId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sale_date: $('sellDate').value, customer_name: $('custName').value,
          phone: $('custPhone').value, address: $('custAddress').value
        })
      });
      toast('Sale details updated ✔');
    } else if (items.length === 1) {
      await post('/api/sales', {
        product_id: items[0].product_id, sale_date: $('sellDate').value,
        qty: items[0].qty, sale_price: items[0].sale_price,
        payment: payMethod, paid_now: $('sellPaid').value,
        customer_name: $('custName').value, phone: $('custPhone').value, address: $('custAddress').value
      });
      toast('Sale saved ✔');
    } else {
      const r = await post('/api/sales/multi', {
        sale_date: $('sellDate').value, payment: payMethod, paid_now: $('sellPaid').value,
        customer_name: $('custName').value, phone: $('custPhone').value, address: $('custAddress').value,
        items
      });
      toast(`Sale saved ✔ — ${r.items} items on receipt KD-${r.id}`);
    }
    resetSaleForm();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

// ---------- returns ----------
let returnTarget = null;
const RETURN_DAYS = 3; // shop policy: returns accepted within 3 days of the sale

function withinReturnWindow(saleDate) {
  const diff = (new Date(todayISO() + 'T00:00:00') - new Date(String(saleDate).slice(0, 10) + 'T00:00:00')) / 86400000;
  return diff <= RETURN_DAYS;
}

// ---------- replacements: no refunds, exchange within 3 days ----------
function openReplace(id) {
  const r = saleCache.find(x => x.id === id);
  if (!r) return;
  returnTarget = r;
  const lastDay = new Date(new Date(String(r.sale_date).slice(0, 10)).getTime() + RETURN_DAYS * 86400000);
  const lastDayStr = fmtDate(`${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`);
  $('replaceInfo').innerHTML =
    `<b>${esc(r.name)}</b> — ${esc(r.customer_name) || 'customer'} bought ${qty(r.effQty)} ${esc(r.unit)} @ ${rs(r.sale_price)}.<br>` +
    `✅ Eligible — replacements accepted until <b>${esc(lastDayStr)}</b> (${RETURN_DAYS}-day policy).<br>` +
    `<span class="share">No refunds: the replacement must be of equal or higher value.</span>`;
  $('repProduct').innerHTML = productCache.map(p =>
    `<option value="${p.id}" ${p.id === r.product_id ? 'selected' : ''}>${esc(p.name)} (${esc(p.category)}) — ${qty(p.remaining)} ${esc(p.unit)} in stock</option>`).join('');
  $('repQty').value = '';
  $('repPrice').value = r.sale_price;
  $('repDate').value = todayISO();
  $('repDate').disabled = !isAdmin();
  $('repReason').value = 'Damaged';
  $('repDetails').value = '';
  updateReplaceHint();
  $('replaceModal').classList.add('show');
  $('repQty').focus();
}

function updateReplaceHint() {
  if (!returnTarget) return;
  const q = parseFloat($('repQty').value) || 0;
  const price = parseFloat($('repPrice').value) || 0;
  if (!q) { $('repHint').textContent = ''; return; }
  const back = q * returnTarget.sale_price, fresh = q * price;
  if (fresh + 0.001 < back) {
    $('repHint').innerHTML = `<span class="due">✖ Not allowed — ${rs(fresh)} is less than the ${rs(back)} being returned (no refunds)</span>`;
  } else if (fresh - back > 0.001) {
    $('repHint').innerHTML = `Returned value ${rs(back)} → replacement ${rs(fresh)} — <b>customer pays extra ${rs(fresh - back)}</b>`;
  } else {
    $('repHint').innerHTML = `<span class="paid-ok">✓ Equal value — no money changes hands</span>`;
  }
}
$('repQty').addEventListener('input', updateReplaceHint);
$('repPrice').addEventListener('input', updateReplaceHint);
$('repProduct').addEventListener('change', () => {
  const p = productCache.find(x => String(x.id) === $('repProduct').value);
  // same product keeps the original price; a different product suggests its fixed price
  if (p && returnTarget) $('repPrice').value = p.id === returnTarget.product_id ? returnTarget.sale_price : (p.salePrice > 0 ? p.salePrice : returnTarget.sale_price);
  updateReplaceHint();
});

function closeReplace() { $('replaceModal').classList.remove('show'); returnTarget = null; }
$('repCancel').addEventListener('click', closeReplace);
$('replaceModal').addEventListener('click', ev => { if (ev.target === $('replaceModal')) closeReplace(); });

$('repSave').addEventListener('click', async () => {
  if (!returnTarget) return;
  if (!checkNotFuture($('repDate').value, 'Replacement date')) return;
  if (!checkPos($('repQty').value, 'Quantity')) return;
  if (!checkPos($('repPrice').value, 'Replacement price')) return;
  const reason = $('repReason').value + ($('repDetails').value.trim() ? ' — ' + $('repDetails').value.trim() : '');
  try {
    const r = await post(`/api/sales/${returnTarget.id}/replace`, {
      qty: $('repQty').value, new_product_id: $('repProduct').value,
      new_price: $('repPrice').value, rep_date: $('repDate').value, reason
    });
    toast(r.extra > 0.001 ? `Replacement saved ✔ — customer pays extra ${rs(r.extra)}` : 'Replacement saved ✔');
    closeReplace();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function loadReplacements() {
  try {
    const rows = await api('/api/replacements');
    $('replaceRows').innerHTML = rows.length ? rows.map(r => {
      const extra = parseFloat(r.qty) * (parseFloat(r.to_price) - parseFloat(r.from_price));
      return `<tr>
      <td>${fmtDate(r.rep_date)}</td>
      <td class="b">KD-${r.receipt_group || r.sale_id}</td>
      <td>${esc(r.customer_name)}</td>
      <td class="r b">${qty(r.qty)}</td>
      <td>${esc(r.from_product)} <span class="share">@ ${rs(r.from_price)}</span></td>
      <td><b>${esc(r.to_product)}</b> <span class="share">@ ${rs(r.to_price)}</span></td>
      <td class="r">${extra > 0.001 ? rs(extra) : '—'}</td>
      <td>${esc(r.reason)}</td>
    </tr>`; }).join('') : '<tr><td colspan="8" class="empty-row">No replacements recorded</td></tr>';
  } catch (e) { toast(e.message, true); }
}

// ---------- printable receipt (all items sold on one receipt print together) ----------
function printReceipt(id) {
  const r = saleCache.find(x => x.id === id);
  if (!r) return;
  const group = r.receipt_group || r.id;
  const items = saleCache.filter(x => (x.receipt_group || x.id) === group).sort((a, b) => a.id - b.id);
  const total = items.reduce((s, x) => s + (parseFloat(x.effTotal) || 0), 0);
  const paidNet = items.reduce((s, x) => s + (parseFloat(x.paidNet) || 0), 0);
  const refunded = items.reduce((s, x) => s + (parseFloat(x.refunded) || 0), 0);
  const remaining = items.reduce((s, x) => s + (parseFloat(x.remaining) || 0), 0);
  const now = new Date();
  let h = now.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const timeStr = `${h}:${String(now.getMinutes()).padStart(2, '0')} ${ampm}`;

  const itemRows = items.map(x => {
    const ret = parseFloat(x.returned) || 0;
    return `<tr><td><b>${esc(x.name)}</b> <span style="font-size:12px;color:#444">(${esc(x.category)})</span><br>
        <span style="font-size:12.5px;color:#444">${qty(x.qty)} ${esc(x.unit)} × ${rs(x.sale_price)}</span></td>
        <td class="r">${rs(x.qty * x.sale_price)}</td></tr>` +
      (ret > 0 ? `<tr><td style="color:#b00020">↩ Returned ${qty(ret)} ${esc(x.unit)}</td>
        <td class="r" style="color:#b00020">− ${rs(ret * x.sale_price)}</td></tr>` : '') +
      (x.replaced_note ? `<tr><td colspan="2" style="font-size:12px;color:#444">🔁 ${esc(x.replaced_note)}</td></tr>` : '');
  }).join('');

  const w = window.open('', '_blank', 'width=440,height=680');
  w.document.write(`<!DOCTYPE html><html><head><title>Receipt KD-${id}</title><style>
    body { font-family: "Segoe UI", Arial, sans-serif; margin: 0; padding: 24px; color: #000; background: #fff; }
    .rc { max-width: 340px; margin: 0 auto; }
    h1 { font-size: 24px; text-align: center; margin: 0; }
    .sub { text-align: center; font-size: 12.5px; color: #444; margin: 4px 0 14px; }
    hr { border: none; border-top: 1px dashed #888; margin: 12px 0; }
    table { width: 100%; font-size: 15px; border-collapse: collapse; }
    td { padding: 5px 0; }
    td.r { text-align: right; }
    .tot td { font-weight: bold; font-size: 17px; border-top: 1.5px solid #000; padding-top: 9px; }
    .due { color: #b00020; font-weight: bold; }
    .foot { text-align: center; font-size: 12.5px; margin-top: 18px; color: #444; }
    .crest { display: block; margin: 0 auto 8px; }
  </style></head><body><div class="rc">
    <img class="crest" src="${location.origin}/logo.svg" width="92" height="92" alt="">
    <h1>Kisan Depot</h1>
    <div class="sub">Fertilizers • Seeds • Pesticides</div>
    <div class="sub" style="direction:rtl;font-size:13.5px">وڈانہ اڈا، مین فیروزپور روڈ، قصور۔</div>
    <div class="sub">📞 0305-9191759</div>
    <table>
      <tr><td>Receipt No.</td><td class="r"><b>KD-${group}</b></td></tr>
      <tr><td>Date</td><td class="r">${fmtDate(r.sale_date)} &nbsp;•&nbsp; ${timeStr}</td></tr>
      ${r.customer_name ? `<tr><td>Customer</td><td class="r">${esc(r.customer_name)}</td></tr>` : ''}
      ${r.phone ? `<tr><td>Phone</td><td class="r">${esc(r.phone)}</td></tr>` : ''}
      ${r.address ? `<tr><td>Address</td><td class="r">${esc(r.address)}</td></tr>` : ''}
    </table>
    <hr>
    <table>
      ${itemRows}
      <tr class="tot"><td>Total${items.length > 1 ? ` (${items.length} items)` : ''}</td><td class="r">${rs(total)}</td></tr>
      <tr><td>Paid${refunded > 0 ? ` (after ${rs(refunded)} refund)` : ''}</td><td class="r">${rs(paidNet)}</td></tr>
      ${remaining > 0.001 ? `<tr><td class="due">Balance Due</td><td class="r due">${rs(remaining)}</td></tr>` : ''}
      <tr><td>Payment</td><td class="r">${esc(r.payment)}</td></tr>
    </table>
    <hr>
    <div class="foot">
      <span style="display:inline-block;margin-bottom:7px">Thank you for your purchase! — شکریہ</span><br>
      <b style="font-size:13.5px;direction:rtl">تبدیلی صرف 3 دن کے اندر قابلِ قبول ہے</b><br>
      <span style="display:inline-block;margin-top:7px;border-top:1px dashed #999;padding-top:7px;font-size:13px;direction:rtl">
        زرعی ادویات اور بیج کو موقع پر چیک کر کے ہی لیں، بعد میں کسی بھی قسم کا کلیم قبول نہیں کیا جائے گا۔
      </span></div>
  </div><script>window.onload = () => window.print();<\/script></body></html>`);
  w.document.close();
  w.focus();
}

async function delSale(id) {
  if (!(await uiConfirm('Delete Sale?', 'This sale, its payment records and any returns on it will be removed.'))) return;
  try { await api('/api/sales/' + id, { method: 'DELETE' }); toast('Sale deleted'); refreshCurrentPage(); }
  catch (e) { toast(e.message, true); }
}

// ---------- expenses ----------
let expenseCache = [];
let editExpenseId = null;
let expPartnersCache = [];

async function loadExpenses() {
  try {
    expenseCache = await api('/api/expenses');
    try { expPartnersCache = await api('/api/partners'); } catch { expPartnersCache = []; }
    fillExpMonths();
    renderExpenses();
  } catch (e) { toast(e.message, true); }
}

function fillExpMonths() {
  const sel = $('expMonth'); const v = sel.value;
  const months = [...new Set(expenseCache.map(r => r.exp_date.slice(0, 7)))].sort().reverse();
  sel.innerHTML = '<option value="">All months</option>' +
    months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join('');
  if ([...sel.options].some(o => o.value === v)) sel.value = v;
}
$('expMonth').addEventListener('change', renderExpenses);

function renderExpenses() {
  const month = $('expMonth').value;
  const rows = month ? expenseCache.filter(r => r.exp_date.startsWith(month)) : expenseCache;
  const shownTotal = rows.reduce((s, r) => s + parseFloat(r.amount), 0);
  const allTotal = expenseCache.reduce((s, r) => s + parseFloat(r.amount), 0);
  $('expTotals').innerHTML = month
    ? `<span class="tot">${monthLabel(month)}: <b>${rs(shownTotal)}</b> (${rows.length} entr${rows.length === 1 ? 'y' : 'ies'})</span>`
    : `<span class="tot">All time: <b>${rs(allTotal)}</b> (${rows.length} entr${rows.length === 1 ? 'y' : 'ies'})</span>`;

  // split the shown expenses between partners by investment share
  const totalInvested = expPartnersCache.reduce((s, p) => s + (parseFloat(p.totalInvested) || 0), 0);
  $('expSplitList').innerHTML = totalInvested > 0 ? expPartnersCache
    .filter(p => p.totalInvested > 0)
    .sort((a, b) => b.totalInvested - a.totalInvested)
    .map(p => {
      const share = p.totalInvested / totalInvested;
      return `<div class="rank-item">
        <span><b>${esc(p.name)}</b> <span class="sub">invested ${rs(p.totalInvested)} — ${(share * 100).toFixed(1)}% share</span></span>
        <span class="amt neg">${rs(share * shownTotal)}</span>
      </div>`;
    }).join('')
    : '<div class="all-good">No partner investments yet — expenses cannot be divided</div>';

  $('expenseRows').innerHTML = rows.length ? rows.map(r => `<tr>
    <td>${fmtDate(r.exp_date)}</td>
    <td><span class="badge-exp">${esc(r.category)}</span></td>
    <td>${esc(r.description)}</td>
    <td class="r b">${rs(r.amount)}</td>
    <td><button class="edit-btn" onclick="editExpense(${r.id})" title="Edit">✏️</button><button class="del-btn" onclick="delExpense(${r.id})">🗑️</button></td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty-row">No expenses recorded yet</td></tr>';
}

function editExpense(id) {
  const r = expenseCache.find(x => x.id === id);
  if (!r) return;
  editExpenseId = id;
  $('expDate').value = r.exp_date;
  $('expCategory').value = r.category;
  $('expDesc').value = r.description;
  $('expAmount').value = parseFloat(r.amount);
  $('expAmount').disabled = true; // the amount is locked once recorded
  $('expSaveBtn').textContent = '✔ Update Details';
  $('expCancel').style.display = '';
  $('expDesc').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function resetExpenseForm() {
  editExpenseId = null;
  $('expDesc').value = ''; $('expAmount').value = '';
  $('expAmount').disabled = false;
  $('expSaveBtn').textContent = '+ Save Expense';
  $('expCancel').style.display = 'none';
}
$('expCancel').addEventListener('click', resetExpenseForm);

$('expenseForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (!checkNotFuture($('expDate').value, 'Expense date')) return;
  if (!checkPos($('expAmount').value, 'Amount')) return;
  const body = {
    exp_date: $('expDate').value, category: $('expCategory').value,
    description: $('expDesc').value, amount: $('expAmount').value
  };
  try {
    if (editExpenseId) {
      await api('/api/expenses/' + editExpenseId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      toast('Expense updated ✔');
    } else {
      await post('/api/expenses', body);
      toast('Expense saved ✔');
    }
    resetExpenseForm();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function delExpense(id) {
  if (!(await uiConfirm('Delete Expense?', 'This expense entry will be removed from the books.'))) return;
  try { await api('/api/expenses/' + id, { method: 'DELETE' }); toast('Expense deleted'); refreshCurrentPage(); }
  catch (e) { toast(e.message, true); }
}

// ---------- payment dialog ----------
let payTarget = null; // { kind: 'sales'|'purchases', id, remaining }

function openPay(kind, id, label, remaining) {
  payTarget = { kind, id, remaining };
  $('payTitle').textContent = kind === 'sales' ? 'Receive Payment' : 'Pay Supplier';
  $('payInfo').innerHTML = `${esc(label)} — remaining: <b>${rs(remaining)}</b>`;
  $('payAmount').value = remaining;
  $('payDate').value = todayISO();
  $('payDate').disabled = !isAdmin();
  $('payMethod').value = 'Cash';
  $('payModal').classList.add('show');
  $('payAmount').focus();
}

function closePay() { $('payModal').classList.remove('show'); payTarget = null; }

$('payCancel').addEventListener('click', closePay);
$('payModal').addEventListener('click', ev => { if (ev.target === $('payModal')) closePay(); });

$('paySave').addEventListener('click', async () => {
  if (!payTarget) return;
  if (!checkNotFuture($('payDate').value, 'Payment date')) return;
  if (!checkPos($('payAmount').value, 'Amount')) return;
  try {
    await post(`/api/${payTarget.kind}/${payTarget.id}/payments`, {
      amount: $('payAmount').value,
      pay_date: $('payDate').value,
      method: $('payMethod').value
    });
    toast('Payment saved ✔');
    closePay();
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

// ---------- full register ----------
let registerCache = [];
let registerCatFilter = '';

$('regChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  registerCatFilter = btn.dataset.cat;
  document.querySelectorAll('#regChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderRegister();
});

async function loadRegister() {
  try {
    const params = new URLSearchParams();
    if ($('regProduct').value) params.set('product_id', $('regProduct').value);
    if ($('regFrom').value) params.set('from', $('regFrom').value);
    if ($('regTo').value) params.set('to', $('regTo').value);
    registerCache = await api('/api/register?' + params.toString());
    renderRegister();
  } catch (e) { toast(e.message, true); }
}

function renderRegister() {
  const rows = registerCatFilter
    ? registerCache.filter(r => r.category === registerCatFilter)
    : registerCache;
  const u = r => esc(r.unit);
    $('registerRows').innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${r.sr}</td>
      <td class="b">${esc(r.description)} — ${esc(r.category)}</td>
      <td>${r.pDate ? fmtDate(r.pDate) : ''}</td>
      <td class="r">${r.pQty != null ? qty(r.pQty) + ' ' + u(r) : ''}</td>
      <td class="r">${r.pUnitPrice != null ? rs(r.pUnitPrice) : ''}</td>
      <td class="r b">${r.pTotal != null ? rs(r.pTotal) : ''}</td>
      <td class="r">${qty(r.totalStock)} ${u(r)}</td>
      <td>${r.sDate ? fmtDate(r.sDate) : ''}</td>
      <td class="r">${r.sQty != null ? qty(r.sQty) + ' ' + u(r) : ''}</td>
      <td class="r">${r.sPrice != null ? rs(r.sPrice) : ''}</td>
      <td class="r b">${r.sTotal != null ? rs(r.sTotal) : ''}</td>
      <td>${payLabel(r.payment)}${r.sDue > 0.001 ? ` <span class="due">(${rs(r.sDue)} due)</span>` : ''}</td>
      <td class="r ${r.profit != null && r.profit < 0 ? 'red' : 'green'}">${r.profit != null ? rs(r.profit) : ''}</td>
      <td>${esc(r.name ?? '')}</td>
      <td>${esc(r.phone ?? '')}</td>
      <td>${esc(r.address ?? '')}</td>
      <td class="r b">${qty(r.remainingStock)} ${u(r)}</td>
      <td class="r">${r.profitShare != null ? rs(r.profitShare) : ''}</td>
      <td class="r">${rs(r.stockPrice)}</td>
    </tr>`).join('') : `<tr><td colspan="19" class="empty-row">${registerCatFilter
      ? 'No ' + esc(registerCatFilter.toLowerCase()) + ' entries in this view'
      : 'No entries yet — record purchases and sales first'}</td></tr>`;
}

$('regApply').addEventListener('click', loadRegister);
$('regClear').addEventListener('click', () => {
  $('regProduct').value = ''; $('regFrom').value = ''; $('regTo').value = '';
  loadRegister();
});
$('regPrint').addEventListener('click', () => window.print());

// ---------- partners ----------
async function loadPartners() {
  try {
    const partners = await api('/api/partners');
    let totalProducts = 0;
    try { totalProducts = (await api('/api/products')).length; } catch {}
    // partner dropdown for the investment form
    const sel = $('invPartner'); const v = sel.value;
    sel.innerHTML = '<option value="">— choose partner —</option>' +
      partners.filter(p => p.active).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if ([...sel.options].some(o => o.value === v)) sel.value = v;

    const active = partners.filter(p => p.active);
    const former = partners.filter(p => !p.active);

    $('formerSection').style.display = former.length ? '' : 'none';
    $('formerCards').innerHTML = former.map(p => `<div class="partner-card former">
      <div class="partner-head">
        <div class="partner-name">👋 ${esc(p.name)}</div>
        <span class="share">left on ${fmtDate(p.leftDate)}</span>
      </div>
      <div class="partner-stats">
        <div class="partner-stat"><div class="lbl">Invested (final)</div><div class="val">${rs(p.finalInvested)}</div></div>
        <div class="partner-stat"><div class="lbl">Profit (final)</div>
          <div class="val" style="color:${p.finalProfit < 0 ? 'var(--red)' : 'var(--green)'}">${rs(p.finalProfit)}</div></div>
      </div>
      <div class="partner-stats">
        <div class="partner-stat"><div class="lbl">Expense Share (final)</div>
          <div class="val" style="color:var(--red)">${rs(p.finalExpenseShare)}</div></div>
        <div class="partner-stat"><div class="lbl">Net Profit (final)</div>
          <div class="val" style="color:${p.finalNet < 0 ? 'var(--red)' : 'var(--green)'}">${rs(p.finalNet)}</div></div>
      </div>
    </div>`).join('');

    $('partnerCards').innerHTML = active.map(p => `<div class="partner-card">
      <div class="partner-head">
        <div class="partner-name">🤝 ${esc(p.name)}</div>
        <span>
          <button class="edit-name-btn" onclick="renamePartner(${p.id}, '${esc(p.name)}')" title="Edit name">✏️</button>
          <button class="edit-name-btn" onclick="markPartnerLeft(${p.id}, '${esc(p.name)}')" title="Partner leaves — keep their history">👋</button>
          <button class="edit-name-btn" onclick="delPartner(${p.id}, '${esc(p.name)}')" title="Delete (mistakes only — removes history)">🗑️</button>
        </span>
      </div>
      <div class="partner-stats">
        <div class="partner-stat"><div class="lbl">Total Invested</div><div class="val">${rs(p.totalInvested)}</div></div>
        <div class="partner-stat"><div class="lbl">Their Profit</div>
          <div class="val" style="color:${p.totalProfit < 0 ? 'var(--red)' : 'var(--green)'}">${rs(p.totalProfit)}</div></div>
      </div>
      <div class="partner-stats">
        <div class="partner-stat"><div class="lbl">Expense Share (${(p.investShare * 100).toFixed(1)}%)</div>
          <div class="val" style="color:var(--red)">${rs(p.expenseShare)}</div></div>
        <div class="partner-stat"><div class="lbl">Net Profit</div>
          <div class="val" style="color:${p.netAfterExpenses < 0 ? 'var(--red)' : 'var(--green)'}">${rs(p.netAfterExpenses)}</div></div>
      </div>
      <button class="details-toggle" onclick="togglePartnerItems(${p.id}, this)">▾ Show Product Details</button>
      <div class="partner-items" id="pitems-${p.id}" style="display:none">
        ${(() => {
          if (!p.items.length) return '<div class="partner-none">No investments yet</div>';
          const itemLine = it => `<div class="partner-item">
            <span><b>${esc(it.product)}</b> <span class="share">${it.sharePct.toFixed(0)}% share</span></span>
            <span>${rs(it.invested)} → <span class="profit ${it.profit < 0 ? 'neg' : 'pos'}">${rs(it.profit)}</span></span>
          </div>`;
          // invested across the whole shop: skip the long product list
          if (totalProducts > 0 && p.items.length >= totalProducts) {
            return `<div class="partner-item"><span>🌐 <b>Invested in all ${p.items.length} products</b></span>
              <span class="profit ${p.totalProfit < 0 ? 'neg' : 'pos'}">${rs(p.totalProfit)}</span></div>`;
          }
          // long lists: show the biggest few, summarise the rest
          if (p.items.length > 6) {
            const top = p.items.slice(0, 5);
            const rest = p.items.slice(5);
            const restProfit = rest.reduce((s, x) => s + x.profit, 0);
            return top.map(itemLine).join('') +
              `<div class="partner-item"><span class="share">…and ${rest.length} more products</span>
                <span class="profit ${restProfit < 0 ? 'neg' : 'pos'}">${rs(restProfit)}</span></div>`;
          }
          return p.items.map(itemLine).join('');
        })()}
      </div>
    </div>`).join('');
  } catch (e) { toast(e.message, true); }
}

$('addPartnerBtn').addEventListener('click', async () => {
  const name = await uiPrompt('🤝 Add Partner', "Partner's Name");
  if (name === null || !name.trim()) return;
  if (!isName(name.trim())) { toast('Partner name should have letters only — no numbers', true); return; }
  try {
    await post('/api/partners', { name: name.trim() });
    toast('Partner added ✔');
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function markPartnerLeft(id, name) {
  if (!(await uiConfirm('👋 Partner Leaving?',
    `<b>${esc(name)}</b> is leaving the business?<br><br>` +
    `Their final figures (invested, profit, expense share, net) will be <b>frozen and kept forever</b> ` +
    `in the Former Partners section.<br><br>` +
    `Their investment share passes to the remaining partners. Settle any money with them before doing this.`,
    'Yes, Partner Left'))) return;
  try {
    await post(`/api/partners/${id}/leave`, {});
    toast(`${name} moved to Former Partners — history kept ✔`);
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
}

async function delPartner(id, name) {
  if (!(await uiConfirm('Delete Partner?',
    `Delete partner <b>"${esc(name)}"</b>?<br><br>All their investment records will be deleted too, and their profit share goes back to the remaining investors of those products.`))) return;
  try {
    await api('/api/partners/' + id, { method: 'DELETE' });
    toast('Partner deleted');
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
}

function togglePartnerItems(id, btn) {
  const box = document.getElementById('pitems-' + id);
  const open = box.style.display === 'none';
  box.style.display = open ? '' : 'none';
  btn.textContent = open ? '▴ Hide Product Details' : '▾ Show Product Details';
}

async function renamePartner(id, current) {
  const name = await uiPrompt('✏️ Rename Partner', "Partner's Name", current);
  if (name === null || !name.trim()) return;
  if (!isName(name.trim())) { toast('Partner name should have letters only — no numbers', true); return; }
  try {
    await api('/api/partners/' + id, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim() })
    });
    toast('Name updated ✔');
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
}

// product checklist for investments (tick one, several, a whole category, or all)
async function fillInvestProducts() {
  try {
    const products = await api('/api/products');
    const checked = new Set([...document.querySelectorAll('#invProducts input[data-pid]:checked')].map(c => c.dataset.pid));
    const CATS = [
      ['Fertilizer', '🌱 All Fertilizers'], ['Seed', '🌾 All Seeds'],
      ['Pesticide', '🐛 All Pesticides']
    ].filter(([c]) => products.some(p => p.category === c));
    $('invProducts').innerHTML =
      `<label class="all-row"><input type="checkbox" id="invAll"> 🌐 All Products</label>` +
      `<div class="cat-quick">` + CATS.map(([c, label]) =>
        `<label><input type="checkbox" data-catsel="${c}"> ${label}</label>`).join('') + `</div>` +
      products.map(p => `<label><input type="checkbox" data-pid="${p.id}" data-cat="${esc(p.category)}" ${checked.has(String(p.id)) ? 'checked' : ''}> ${esc(p.name)} <span style="color:var(--muted);font-size:12.5px">(${esc(p.category)})</span></label>`).join('');
    syncInvestSelectors();
    updateSplitHint();
  } catch { /* server not ready */ }
}

// keep the All / category boxes in step with the individual product ticks
function syncInvestSelectors() {
  const prods = [...document.querySelectorAll('#invProducts input[data-pid]')];
  document.querySelectorAll('#invProducts input[data-catsel]').forEach(cb => {
    const mine = prods.filter(p => p.dataset.cat === cb.dataset.catsel);
    cb.checked = mine.length > 0 && mine.every(p => p.checked);
  });
  const all = document.getElementById('invAll');
  if (all) all.checked = prods.length > 0 && prods.every(p => p.checked);
}

$('invProducts').addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'invAll') {
    document.querySelectorAll('#invProducts input[data-pid]').forEach(c => { c.checked = t.checked; });
  } else if (t.dataset && t.dataset.catsel) {
    document.querySelectorAll(`#invProducts input[data-pid][data-cat="${t.dataset.catsel}"]`)
      .forEach(c => { c.checked = t.checked; });
  }
  syncInvestSelectors();
  updateSplitHint();
});

function updateSplitHint() {
  const ids = [...document.querySelectorAll('#invProducts input[data-pid]:checked')];
  const amt = parseFloat($('invAmount').value) || 0;
  if (!ids.length) { $('invSplitHint').textContent = ''; return; }
  $('invSplitHint').textContent = ids.length === 1
    ? `Whole amount goes to 1 product`
    : `Split equally across ${ids.length} products` + (amt > 0 ? ` — about ${rs(amt / ids.length)} each` : '');
}
$('invAmount').addEventListener('input', updateSplitHint);

async function loadInvestments() {
  try {
    const rows = await api('/api/investments');
    $('investRows').innerHTML = rows.length ? rows.map(r => `<tr>
      <td>${fmtDate(r.inv_date)}</td>
      <td class="b">${esc(r.partner_name)}</td>
      <td>${esc(r.product_name)} ${badge(r.category)}</td>
      <td class="r b">${rs(r.amount)}</td>
      <td><button class="del-btn" onclick="delInvestment(${r.id})">🗑️</button></td>
    </tr>`).join('') : '<tr><td colspan="5" class="empty-row">No investments recorded yet</td></tr>';
  } catch (e) { toast(e.message, true); }
}

$('investForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const product_ids = [...document.querySelectorAll('#invProducts input[data-pid]:checked')]
    .map(c => parseInt(c.dataset.pid, 10));
  if (!product_ids.length) { toast('Tick at least one product', true); return; }
  if (!checkNotFuture($('invDate').value, 'Investment date')) return;
  if (!checkPos($('invAmount').value, 'Amount')) return;
  try {
    const r = await post('/api/investments/batch', {
      partner_id: $('invPartner').value, product_ids,
      inv_date: $('invDate').value, amount: $('invAmount').value
    });
    $('invAmount').value = '';
    document.querySelectorAll('#invProducts input').forEach(c => { c.checked = false; });
    updateSplitHint();
    toast(r.products > 1 ? `Investment saved across ${r.products} products ✔` : 'Investment saved ✔');
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
});

async function delInvestment(id) {
  if (!(await uiConfirm('Delete Investment?', 'This investment entry will be removed and profit shares will recalculate.'))) return;
  try {
    await api('/api/investments/' + id, { method: 'DELETE' });
    toast('Investment deleted');
    refreshCurrentPage();
  } catch (e) { toast(e.message, true); }
}

// ---------- activity logs ----------
let logsCache = [];
let logActFilter = '';
let logSearchTerm = '';
const MAIN_ACTIONS = ['created', 'deleted', 'edited', 'payment', 'return'];
const LOG_LABEL = {
  created: '✔ Saved', deleted: '🗑 Deleted', edited: '✏ Edited',
  payment: '💰 Payment', return: '🔁 Replacement',
  login: '🔓 Login', password: '🔑 Password', restore: '📦 Restore'
};

let logWindow = '3h'; // '3h' | 'today' | '7d' | 'all' | 'range'

async function loadLogs() {
  try {
    let qs = '';
    if (logWindow === '3h') qs = '?hours=3';
    else if (logWindow === 'today') qs = '?from=' + todayISO() + 'T00:00';
    else if (logWindow === '7d') qs = '?hours=168';
    else if (logWindow === 'range') {
      const p = new URLSearchParams();
      if ($('logFrom').value) p.set('from', $('logFrom').value);
      if ($('logTo').value) p.set('to', $('logTo').value);
      qs = '?' + p.toString();
    }
    logsCache = await api('/api/logs' + qs);
    const sel = $('logUserSel'); const v = sel.value;
    const users = [...new Set(logsCache.map(r => r.username))].sort();
    sel.innerHTML = '<option value="">👥 All users</option>' +
      users.map(u => `<option value="${esc(u)}">${esc(u)}</option>`).join('');
    if ([...sel.options].some(o => o.value === v)) sel.value = v;
    renderLogs();
  } catch (e) { toast(e.message, true); }
}
$('logUserSel').addEventListener('change', renderLogs);

$('logTimeChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  logWindow = btn.dataset.window;
  $('logFrom').value = ''; $('logTo').value = '';
  document.querySelectorAll('#logTimeChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  loadLogs();
});

$('logRangeApply').addEventListener('click', () => {
  if (!$('logFrom').value && !$('logTo').value) { toast('Pick a From or To date first', true); return; }
  logWindow = 'range';
  document.querySelectorAll('#logTimeChips .chip').forEach(c => c.classList.remove('active'));
  loadLogs();
});

function renderLogs() {
  let rows = logsCache;
  if ($('logUserSel').value) rows = rows.filter(r => r.username === $('logUserSel').value);
  if (logActFilter === 'other') rows = rows.filter(r => !MAIN_ACTIONS.includes(r.action));
  else if (logActFilter) rows = rows.filter(r => r.action === logActFilter);
  if (logSearchTerm) {
    rows = rows.filter(r =>
      r.details.toLowerCase().includes(logSearchTerm) ||
      r.username.toLowerCase().includes(logSearchTerm) ||
      r.d.toLowerCase().includes(logSearchTerm));
  }
  $('logRows').innerHTML = rows.length ? rows.map(r => {
    const cls = MAIN_ACTIONS.includes(r.action) ? 'log-' + r.action : 'log-other';
    return `<tr>
      <td>${esc(r.d)}</td>
      <td>${esc(r.t)}</td>
      <td class="b">${esc(r.username)}</td>
      <td><span class="log-badge ${cls}">${LOG_LABEL[r.action] || esc(r.action)}</span></td>
      <td>${esc(r.details)}</td>
    </tr>`;
  }).join('') : `<tr><td colspan="5" class="empty-row">${logSearchTerm || logActFilter
    ? 'No log entries match this filter'
    : logWindow === '3h' ? 'Nothing happened in the last 3 hours — pick a longer period above'
    : 'No log entries in this time period'}</td></tr>`;
}

$('logChips').addEventListener('click', ev => {
  const btn = ev.target.closest('.chip');
  if (!btn) return;
  logActFilter = btn.dataset.act;
  document.querySelectorAll('#logChips .chip').forEach(c => c.classList.toggle('active', c === btn));
  renderLogs();
});

$('logSearch').addEventListener('input', () => {
  logSearchTerm = $('logSearch').value.trim().toLowerCase();
  $('logSearchClear').style.display = logSearchTerm ? '' : 'none';
  renderLogs();
});
$('logSearchClear').addEventListener('click', () => {
  $('logSearch').value = ''; logSearchTerm = '';
  $('logSearchClear').style.display = 'none';
  renderLogs(); $('logSearch').focus();
});

$('logsCsv').addEventListener('click', () => { window.location.href = '/api/logs/export.csv'; });
$('logsPdf').addEventListener('click', () => {
  toast('Preparing PDF…');
  window.location.href = '/api/logs/export.pdf';
});

// 🔄 icon in every page title
document.addEventListener('click', ev => {
  const b = ev.target.closest && ev.target.closest('.icon-refresh');
  if (!b) return;
  b.classList.add('spin');
  setTimeout(() => b.classList.remove('spin'), 700);
  refreshCurrentPage();
  toast('Refreshed ✔');
});

// ---------- backup ----------
$('backupBtn').addEventListener('click', () => { window.location.href = '/api/backup'; });

// ---------- import (restore) a backup file ----------
$('importBtn').addEventListener('click', () => { $('importFile').value = ''; $('importFile').click(); });

$('importFile').addEventListener('change', () => {
  const file = $('importFile').files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    let b;
    try { b = JSON.parse(reader.result); } catch { toast('This file is not a Kisan Depot backup', true); return; }
    if (!b || !Array.isArray(b.products) || !Array.isArray(b.purchases) || !Array.isArray(b.sales)) {
      toast('This file is not a Kisan Depot backup', true); return;
    }
    const when = b.exportedAt ? fmtDate(String(b.exportedAt).slice(0, 10)) : 'unknown date';
    const ok = await uiConfirm('📥 Import Backup?',
      `This backup is from <b>${esc(when)}</b> and contains:<br><br>` +
      `<b>${b.products.length}</b> products, <b>${b.purchases.length}</b> purchases, ` +
      `<b>${b.sales.length}</b> sales, <b>${(b.expenses || []).length}</b> expenses, ` +
      `<b>${(b.partners || []).length}</b> partners.<br><br>` +
      `⚠️ ALL current data in the app will be REPLACED by this file.<br>` +
      `(A safety copy of today's data is saved automatically first.)`,
      'Yes, Replace Everything');
    if (!ok) return;
    try {
      toast('Importing… please wait');
      const r = await post('/api/restore', b);
      toast(`Import complete ✔ (previous data saved as ${r.safetyFile})`);
      setTimeout(() => location.reload(), 1500);
    } catch (e) { toast(e.message, true); }
  };
  reader.readAsText(file);
});

// ---------- staff accounts (admin only) ----------
async function loadStaffList() {
  const users = await api('/api/staff');
  $('staffList').innerHTML = users.map(u => `<div class="rank-item">
    <span><b>${esc(u.username)}</b> <span class="sub">${u.role === 'admin' ? '👑 admin' : '🧑‍💼 salesman'}</span></span>
    <span>${u.role === 'salesman'
      ? `<button class="pay-btn" onclick="resetStaffPw(${u.id}, '${esc(u.username)}')">🔑 Reset</button>
         <button class="del-btn" onclick="delStaff(${u.id}, '${esc(u.username)}')">🗑️</button>`
      : ''}</span>
  </div>`).join('');
}

$('staffAdd').addEventListener('click', async () => {
  try {
    await post('/api/staff', { username: $('staffUser').value, password: $('staffPw').value });
    toast('Salesman account created ✔');
    $('staffUser').value = ''; $('staffPw').value = '';
    loadStaffList();
  } catch (e) { toast(e.message, true); }
});

async function resetStaffPw(id, name) {
  $('pwModal').classList.remove('show');
  const pw = await uiPrompt('🔑 Reset Password', `New password for ${name} (at least 6 characters)`);
  $('pwModal').classList.add('show');
  if (pw === null) return;
  try {
    await post(`/api/staff/${id}/password`, { password: pw });
    toast(`Password reset for ${name} ✔`);
  } catch (e) { toast(e.message, true); }
}

async function delStaff(id, name) {
  $('pwModal').classList.remove('show');
  const ok = await uiConfirm('Delete Staff Account?', `Delete the salesman account "<b>${esc(name)}</b>"?<br>Their past actions stay in the log.`);
  $('pwModal').classList.add('show');
  if (!ok) return;
  try {
    await api('/api/staff/' + id, { method: 'DELETE' });
    toast('Account deleted');
    await loadStaffList();
  } catch (e) { toast(e.message, true); }
}

// ---------- account ----------
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

$('passwordBtn').addEventListener('click', async () => {
  $('pwCurrent').value = ''; $('pwNew').value = '';
  $('staffUser').value = ''; $('staffPw').value = '';
  try { await loadStaffList(); } catch { $('staffList').innerHTML = ''; }
  $('pwModal').classList.add('show');
  setTimeout(() => $('pwCurrent').focus(), 50);
});

$('pwSave').addEventListener('click', async () => {
  if (String($('pwNew').value).length < 6) {
    toast('New password must be at least 6 characters', true);
    $('pwNew').focus();
    return;
  }
  try {
    await post('/api/change-password', {
      current_password: $('pwCurrent').value, new_password: $('pwNew').value
    });
    $('pwModal').classList.remove('show');
    toast('Password changed ✔');
  } catch (e) { toast(e.message, true); }
});
$('pwCancel').addEventListener('click', () => $('pwModal').classList.remove('show'));
$('pwModal').addEventListener('click', ev => { if (ev.target === $('pwModal')) $('pwModal').classList.remove('show'); });
$('pwNew').addEventListener('keydown', ev => { if (ev.key === 'Enter') $('pwSave').click(); });

// ---------- init ----------
(async function init() {
  try {
    const me = await api('/api/me');
    currentRole = me.role || 'admin';
    $('whoami').textContent = `Signed in as ${me.username}${isAdmin() ? '' : ' (salesman)'}`;
  } catch {
    window.location.href = '/login.html';
    return;
  }
  if (!isAdmin()) {
    // salesman sees only Sales and Purchases
    ['dashboard', 'products', 'register', 'partners', 'expenses', 'logs'].forEach(p => {
      const b = document.querySelector(`.nav-btn[data-page="${p}"]`);
      if (b) b.style.display = 'none';
    });
    ['backupBtn', 'importBtn', 'passwordBtn'].forEach(id => { $(id).style.display = 'none'; });
    // salesman records for today only — dates are fixed
    $('sellDate').value = todayISO(); $('sellDate').disabled = true;
    $('buyDate').value = todayISO(); $('buyDate').disabled = true;
    document.querySelector('.nav-btn[data-page="sales"]').click();
    return; // skip the dashboard load below
  }
  const now = new Date();
  $('todayPill').textContent = now.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
  $('buyDate').value = todayISO();
  $('sellDate').value = todayISO();
  $('invDate').value = todayISO();
  $('expDate').value = todayISO();
  loadDashboard();
  loadProductOptions();
})();
