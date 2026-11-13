const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const SOL = "So11111111111111111111111111111111111111112";
const SOL_ICON = "https://static.datapi.jup.ag/token-icons/79a96c7b893fd899512411dd07a8adf6f9e26dd135989f51d46ddb50f0b8bb6c.webp";
// Swap API V2 (/order + /execute). Same request/response shape as Ultra v1, which Jupiter no longer maintains.
const SWAP = "https://api.jup.ag/swap/v2";
const PRICE = "https://api.jup.ag/price/v3";
const SEARCH = "https://api.jup.ag/tokens/v2/search";
const RPC = "https://solana-rpc.publicnode.com";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VeKKdPT7yHdmnMvEGB4ryFHSZH9Ee"];
const PRICE_EVERY_MS = 3000;   // price poll; free plan is 1 RPS shared
const QUOTE_EVERY_MS = 12000;  // background order refresh
const FEED_EVERY_MS = 5000;    // datapi chart + trades (separate host, no key budget)

const state = {
  tab: "trade",
  view: "spot",
  holdingsLoading: false,
  holdingsError: "",
  side: "buy",
  amount: 0.1,
  sellPct: 50,
  tf: "1m",
  showInd: true,
  chartSetOpen: false,
  infoOpen: false,
  infoWin: "24h",
  searchOpen: false,
  marketOpen: false,
  results: [],
  toast: null,
  status: "Connecting to Jupiter…",
  wallet: null,
  provider: null,
  sol: 0,
  quote: null,
  quoting: false,
  busy: false,
  mapReady: false,
  prices: {},
  samples: [],
  tokens: [],
  active: null,
  holdings: [],
  txs: [],
  candles: [],
  candleTimer: 0,
  tape: [],
  holders: [],
  txFilter: "All",
  tool: "cross",
  pointer: null,
  marks: []
};

const tapeVol = (n) => {
  const a = Math.abs(n || 0);
  if (a >= 100) return "$" + a.toFixed(2);
  if (a >= 1) return "$" + a.toFixed(4);
  return "$" + a.toFixed(5);
};
const usd = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1000) return sign + "$" + (a / 1000).toFixed(a >= 10000 ? 1 : 2) + "K";
  if (a >= 1) return sign + "$" + a.toFixed(2);
  if (a >= 0.01) return sign + "$" + a.toFixed(4);
  return sign + "$" + a.toPrecision(3);
};
const qty = (n) => {
  if (!n) return "0";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "K";
  return n >= 1 ? n.toFixed(2) : n.toPrecision(3);
};
const solText = (n) => {
  if (!n) return "0";
  return Number(n).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
};
const compactCount = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 1 : 2) + "K";
  return String(v);
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cls = (n) => (n >= 0 ? "up" : "down");
const signed = (n, d = 2) => (n >= 0 ? "+" : "") + Number(n).toFixed(d);
const moveLabel = (pct) => {
  const n = Number(pct) || 0;
  const mult = Math.abs(1 + n / 100);
  const digits = mult >= 10 ? 0 : 2;
  return (n >= 0 ? "▲ " : "▼ ") + mult.toFixed(digits) + "x (24h)";
};
const raw = (ui, decimals) => Math.round(Number(ui) * 10 ** decimals).toString();
const ui = (amount, decimals) => Number(amount) / 10 ** decimals;

function provider() {
  const w = window;
  return w.phantom?.solana || w.solflare || w.backpack || (w.solana?.isPhantom || w.solana?.signTransaction ? w.solana : null);
}

function entryKey(mint) { return "trench-entry:" + mint; }
function entryOf(mint, price) {
  const saved = localStorage.getItem(entryKey(mint));
  if (saved) return Number(saved);
  if (price) localStorage.setItem(entryKey(mint), String(price));
  return price || 0;
}

function activePnl() {
  const t = state.active;
  if (!t) return { value: 0, d: 0, p: 0, amount: 0 };
  const held = state.holdings.find((h) => h.mint === t.id);
  const amount = held ? held.ui : 0;
  const price = state.prices[t.id] || t.usdPrice || 0;
  const entry = entryOf(t.id, price);
  const value = amount * price;
  const cost = amount * entry;
  const d = value - cost;
  const p = amount && cost ? (d / cost) * 100 : 0;
  return { value, d, p, amount, price, entry };
}

function jupHeaders(url, h = {}) {
  const k = window.JUP_API_KEY;
  return k && String(url).startsWith("https://api.jup.ag/") ? { ...h, "x-api-key": k } : h;
}

// Every call to api.jup.ag goes through one queue so the whole app stays under
// the free plan (1 RPS, 60 s sliding window). /swap/v2/execute has its own bucket.
const MAIN_GAP_MS = 1250;
let coolUntil = 0;
let lastMain = 0;
let mainChain = Promise.resolve();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMain = (url) => String(url).startsWith("https://api.jup.ag/") && !String(url).startsWith(SWAP + "/execute");

function rateNote(res) {
  const rem = Number(res.headers.get("x-ratelimit-remaining"));
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  if (res.status === 429 || (Number.isFinite(rem) && rem <= 0)) {
    const until = Number.isFinite(reset) && reset > 1e9 ? reset * 1000 : Date.now() + 10000;
    coolUntil = Math.max(coolUntil, Math.min(until, Date.now() + 60000), Date.now() + 2000);
  }
}

async function rawFetch(url, opts) {
  const res = await fetch(url, { cache: "no-store", ...opts, headers: jupHeaders(url, opts.headers || {}) });
  rateNote(res);
  return res;
}

function queued(url, opts) {
  const run = async () => {
    const wait = Math.max(coolUntil - Date.now(), lastMain + MAIN_GAP_MS - Date.now(), 0);
    if (wait) await sleep(wait);
    lastMain = Date.now();
    return rawFetch(url, opts);
  };
  const p = mainChain.then(run, run);
  mainChain = p.then(() => {}, () => {});
  return p;
}

async function jup(url, opts = {}) {
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = isMain(url) ? await queued(url, opts) : await rawFetch(url, opts);
    if (res.status !== 429) break;
    if (!isMain(url)) await sleep(2000 * (attempt + 1));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 429 ? "Rate limited by Jupiter, retrying…" : (data.error || data.message || ("Jupiter " + res.status)));
  return data;
}

let loadSeq = 0;
async function loadToken(query) {
  const seq = ++loadSeq;
  const q = String(query).trim();
  const list = await jup(SEARCH + "?query=" + encodeURIComponent(q));
  if (seq !== loadSeq) return;
  const hit = (list || []).find((t) => t.id === q)
    || (list || []).find((t) => t.symbol?.toLowerCase() === q.toLowerCase())
    || (list || [])[0];
  if (!hit) throw new Error("No token found for " + q);
  state.active = hit;
  state.prices[hit.id] = hit.usdPrice;
  state.candles = [];
  state.tape = [];
  state.holders = [];
  state.mapReady = false;
  state.quote = null;
  state.samples = [hit.usdPrice];
  state.status = "Live · Jupiter";
  render();
  datapi("https://datapi.jup.ag/v1/assets/search?query=" + encodeURIComponent(hit.id)).then((extra) => {
    const row = (extra || []).find((t) => t.id === hit.id);
    if (row && row.fees != null && state.active === hit) { hit.fees = row.fees; render(); }
  }).catch(() => {});
  loadCandles().catch(() => {});
  loadTape().catch(() => {});
  loadHolders().catch(() => {});
  scheduleQuote(0);
}

// datapi.jup.ag is Jupiter's public data host (charts, trades, holders). It does not
// take the API key and does not count against the key's budget.
async function datapi(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error("datapi " + res.status);
  return res.json();
}

async function loadCandles() {
  const t = state.active;
  if (!t) return;
  const interval = { "15s": "15_SECOND", "1m": "1_MINUTE", "3m": "3_MINUTE", "15m": "15_MINUTE", "1h": "1_HOUR", "4h": "4_HOUR", "1D": "1_DAY" }[state.tf] || "1_MINUTE";
  const to = new Date().toISOString();
  const data = await datapi(`https://datapi.jup.ag/v2/charts/${t.id}?interval=${interval}&to=${encodeURIComponent(to)}&candles=48`);
  if (state.active !== t) return;
  state.candles = data.candles || [];
  drawChart();
}

function ageLabel(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.max(1, Math.floor(s)) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

async function loadTape() {
  const t = state.active;
  if (!t) return;
  const data = await datapi(`https://datapi.jup.ag/v1/txs/${t.id}?limit=40`);
  if (state.active !== t) return;
  state.tape = data.txs || [];
  const box = $("#tape");
  if (box) box.innerHTML = tapeRows();
  else if (state.tab === "tx") render();
}

async function loadHolders() {
  const t = state.active;
  if (!t) return;
  const data = await datapi(`https://datapi.jup.ag/v1/holders/${t.id}?limit=40`);
  if (state.active !== t) return;
  state.holders = data.holders || [];
  state.mapReady = true;
  if ($("#map")) drawMap();
  const note = $("#map-note");
  if (note) note.textContent = "";
}

let searchTimer = 0;
let searchSeq = 0;
function searchRows() {
  return (state.results || []).slice(0, 12).map((t) => `<button class="row" data-pick="${t.id}"><b>${esc(t.symbol)}</b> <span class="k">${esc(t.name || "")}</span> <span>${usd(t.mcap)}</span></button>`).join("");
}
function paintResults() {
  const box = $("#results");
  if (!box) return;
  box.innerHTML = searchRows();
  box.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => pick(b.dataset.pick));
}
function pick(mint) {
  state.searchOpen = false;
  state.view = "spot";
  render();
  loadToken(mint).catch((err) => { state.status = err.message; render(); });
}
function search(q) {
  clearTimeout(searchTimer);
  const seq = ++searchSeq;
  if (!q || q.length < 2) { state.results = []; paintResults(); return; }
  searchTimer = setTimeout(async () => {
    try {
      const list = await jup(SEARCH + "?query=" + encodeURIComponent(q));
      if (seq !== searchSeq) return;
      state.results = list || [];
      paintResults();
    } catch (err) {
      const box = $("#results");
      if (box && seq === searchSeq) box.innerHTML = `<div class="k" style="padding:12px 0">${esc(err.message)}</div>`;
    }
  }, 450);
}

async function pollPrices() {
  const t0 = performance.now();
  const ids = new Set([SOL]);
  if (state.active) ids.add(state.active.id);
  state.holdings.forEach((h) => ids.add(h.mint));
  const all = [...ids];
  // price/v3 takes up to 50 ids per call; one call covers everything on screen.
  for (let i = 0; i < all.length; i += 50) {
    const data = await jup(PRICE + "?ids=" + all.slice(i, i + 50).join(","));
    for (const [mint, row] of Object.entries(data || {})) {
      if (row?.usdPrice) state.prices[mint] = row.usdPrice;
    }
  }
  if (state.active && state.prices[state.active.id]) {
    state.active.usdPrice = state.prices[state.active.id];
    state.active.mcap = (state.active.circSupply || 0) * state.active.usdPrice || state.active.mcap;
    state.samples.push(state.active.usdPrice);
    if (state.samples.length > 60) state.samples.shift();
  }
  paintLive();
  state.lag = Math.round(performance.now() - t0);
  const lag = $("#lag");
  if (lag) lag.textContent = state.lag + "ms";
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "RPC error");
  return data.result;
}

const HOLDINGS = "https://api.jup.ag/ultra/v1/holdings/";
const MAX_TRACKED = 40; // keep the price poll to one call

async function balancesFromJupiter(owner) {
  // Ultra holdings has its own rate bucket, so it doesn't eat the price/search budget.
  const res = await rawFetch(HOLDINGS + owner, {});
  if (!res.ok) throw new Error("holdings " + res.status);
  const d = await res.json();
  const rows = Object.entries(d.tokens || {}).map(([mint, accts]) => {
    // Swaps spend the associated token account, so count that one when it exists.
    const ata = (accts || []).filter((a) => a.isAssociatedTokenAccount);
    const amount = (ata.length ? ata : accts || []).reduce((n, a) => n + Number(a.amount || 0), 0);
    const dec = accts?.[0]?.decimals ?? 0;
    return { mint, amount, decimals: dec, ui: ui(amount, dec) };
  });
  return { sol: Number(d.uiAmount || 0), rows };
}

async function balancesFromRpc(owner) {
  const sol = await rpc("getBalance", [owner]);
  const lists = await Promise.all(TOKEN_PROGRAMS.map((programId) =>
    rpc("getTokenAccountsByOwner", [owner, { programId }, { encoding: "jsonParsed" }]).catch(() => ({ value: [] }))));
  const byMint = new Map();
  lists.flatMap((r) => r?.value || []).forEach((row) => {
    const info = row.account.data.parsed.info;
    const prev = byMint.get(info.mint);
    const amount = Number(info.tokenAmount.amount) + (prev ? prev.amount : 0);
    const dec = info.tokenAmount.decimals;
    byMint.set(info.mint, { mint: info.mint, amount, decimals: dec, ui: ui(amount, dec) });
  });
  return { sol: (sol?.value || 0) / 1e9, rows: [...byMint.values()] };
}

async function loadHoldings() {
  if (!state.wallet) return;
  const owner = state.wallet;
  state.holdingsLoading = true;
  state.holdingsError = "";
  if (state.view === "portfolio" || state.tab === "holdings") render();
  let bal;
  try {
    try { bal = await withTimeout(balancesFromJupiter(owner), 10000); }
    catch (_) { bal = await withTimeout(balancesFromRpc(owner), 12000); }
  } catch (err) {
    if (state.wallet === owner) { state.holdingsError = err.message || String(err); state.holdingsLoading = false; render(); }
    return;
  }
  if (state.wallet !== owner) return;
  state.holdingsLoading = false;
  state.sol = bal.sol;
  let rows = bal.rows.filter((h) => h.ui > 0 && h.mint !== SOL);
  if (rows.length > MAX_TRACKED) {
    // Big wallets: price everything once (50 ids per call, capped), keep the most valuable.
    const ids = rows.slice(0, 200).map((h) => h.mint);
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const data = await jup(PRICE + "?ids=" + ids.slice(i, i + 50).join(","));
        for (const [m, r] of Object.entries(data || {})) if (r?.usdPrice) state.prices[m] = r.usdPrice;
      } catch (_) {}
    }
    rows = rows.map((h) => ({ h, v: h.ui * (state.prices[h.mint] || 0) })).sort((x, y) => y.v - x.v).slice(0, MAX_TRACKED).map((x) => x.h);
  }
  const old = new Map(state.holdings.map((h) => [h.mint, h]));
  state.holdings = rows.map((h) => {
    const o = old.get(h.mint);
    return o ? { ...h, symbol: o.symbol, name: o.name, icon: o.icon } : h;
  });
  const missing = state.holdings.filter((h) => !h.symbol).map((h) => h.mint);
  if (missing.length) {
    // One datapi call for all metadata instead of one keyed search per token.
    try {
      const meta = await datapi("https://datapi.jup.ag/v1/assets?ids=" + missing.join(","));
      (Array.isArray(meta) ? meta : meta?.assets || []).forEach((m) => {
        const h = state.holdings.find((x) => x.mint === m.id);
        if (h) Object.assign(h, { symbol: m.symbol, name: m.name, icon: m.icon });
      });
    } catch (_) {}
  }
  await pollPrices().catch(() => {});
  render();
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}

function isMobile() { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent); }
function phantomLink() {
  return "https://phantom.app/ul/browse/" + encodeURIComponent(location.href) + "?ref=" + encodeURIComponent(location.origin);
}

async function connect(silent = false) {
  const injected = provider();
  if (!injected) {
    if (silent) return;
    if (isMobile()) { location.href = phantomLink(); return; }
    state.toast = "No Solana wallet found. Install Phantom (phantom.app) or open this page in Phantom's browser.";
    render();
    return;
  }
  try {
    state.provider = injected;
    const res = await injected.connect(silent ? { onlyIfTrusted: true } : undefined);
    const key = res?.publicKey || injected.publicKey;
    if (!key) return;
    state.wallet = key.toString();
    state.status = "Wallet " + state.wallet.slice(0, 4) + "…" + state.wallet.slice(-4);
    if (!injected._trenchBound && injected.on) {
      injected._trenchBound = true;
      injected.on("accountChanged", (pk) => {
        state.wallet = pk ? pk.toString() : null;
        state.holdings = [];
        state.sol = 0;
        if (state.wallet) loadHoldings().catch(() => {});
        render();
        scheduleQuote(0);
      });
      injected.on("disconnect", () => { state.wallet = null; state.holdings = []; state.sol = 0; render(); });
    }
    render();
    await loadHoldings().catch((err) => { state.status = "Balance load failed: " + err.message; });
    scheduleQuote(0);
  } catch (err) {
    if (!silent) { state.toast = err.message || "Wallet connection rejected"; render(); }
  }
}

function sellTokens() {
  const t = state.active;
  if (!t) return 0;
  const held = state.holdings.find((h) => h.mint === t.id);
  const pct = Math.min(100, Math.max(0, Number(state.sellPct) || 0));
  return held ? held.ui * pct / 100 : 0;
}

function orderParams() {
  const t = state.active;
  if (!t) return null;
  if (state.side === "buy") {
    const n = Number(state.amount);
    if (!n || n <= 0) return null;
    return { inputMint: SOL, outputMint: t.id, amount: raw(n, 9) };
  }
  const held = state.holdings.find((h) => h.mint === t.id);
  if (!held) return null;
  const pct = Math.min(100, Math.max(0, Number(state.sellPct) || 0));
  // Use integer base units so 100% sells exactly the balance.
  const amount = pct >= 100 ? String(held.amount) : String(Math.floor(held.amount * pct / 100));
  if (amount === "0") return null;
  return { inputMint: t.id, outputMint: SOL, amount };
}

let quoteTimer = 0;
let quoteSeq = 0;
function scheduleQuote(ms = 400) {
  clearTimeout(quoteTimer);
  quoteTimer = setTimeout(() => refreshQuote().catch(() => {}), ms);
}

async function refreshQuote() {
  const params = orderParams();
  const seq = ++quoteSeq;
  if (!params) { state.quote = null; paintLive(); return null; }
  state.quoting = true;
  paintLive();
  try {
    const q = new URLSearchParams(params);
    if (state.wallet) q.set("taker", state.wallet);
    const order = await jup(SWAP + "/order?" + q.toString());
    if (seq !== quoteSeq) return order;
    order._at = Date.now();
    order._params = q.toString();
    state.quote = order;
    state.status = order.errorMessage ? order.errorMessage : "Live · Jupiter";
    return order;
  } catch (err) {
    if (seq === quoteSeq) { state.quote = null; state.status = err.message; }
    throw err;
  } finally {
    if (seq === quoteSeq) { state.quoting = false; paintLive(); }
  }
}

function b64ToBytes(b64) { return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); }
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function trade() {
  if (!state.wallet) return connect();
  if (state.busy) return;
  const t = state.active;
  if (!t) return;
  state.busy = true;
  const side = state.side;
  const soldQty = sellTokens();
  const solIn = state.amount;
  state.status = "Getting order…";
  render();
  try {
    if (!state.provider?.signTransaction) throw new Error("This wallet can't sign here. Open the page in Phantom.");
    // Orders are single-use and expire fast, so always take a fresh one for the click.
    clearTimeout(quoteTimer);
    const order = await refreshQuote();
    if (!order?.transaction) throw new Error(order?.errorMessage || order?.error || "Jupiter did not return a transaction.");
    state.status = "Confirm in your wallet…";
    paintLive();
    const tx = solanaWeb3.VersionedTransaction.deserialize(b64ToBytes(order.transaction));
    // signTransaction (not signAndSend): JupiterZ/gasless routes need Jupiter to add
    // its signature at /execute, so the wallet must not broadcast it itself.
    const signed = await state.provider.signTransaction(tx);
    state.status = "Sending…";
    paintLive();
    const done = await jup(SWAP + "/execute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedTransaction: bytesToB64(signed.serialize()), requestId: order.requestId })
    });
    if (done.status !== "Success") throw new Error((done.error || "Swap failed") + (done.code != null ? " (code " + done.code + ")" : ""));
    const price = state.prices[t.id] || t.usdPrice;
    if (side === "buy" && price) localStorage.setItem(entryKey(t.id), String(price));
    state.txs.unshift({ side, symbol: t.symbol, sig: done.signature, sol: solIn, t: "now" });
    state.toast = (side === "buy" ? "Bought: " + solIn + " SOL of " : "Sold: " + qty(soldQty) + " ") + t.symbol;
    state.status = "Done · " + String(done.signature || "").slice(0, 8) + "…";
    await sleep(1500);
    await loadHoldings().catch(() => {});
  } catch (err) {
    state.status = err.message || String(err);
    state.toast = state.status;
  } finally {
    state.busy = false;
    render();
    scheduleQuote(QUOTE_EVERY_MS);
  }
}

function pnlText(d, pct) {
  const mag = usd(Math.abs(d || 0)).replace(/^-/, "");
  return "uPnL " + (d < 0 ? "-" : "+") + mag + " (" + signed(pct || 0) + "%)";
}
function paintLive() {
  const t = state.active;
  const pf = $("#pf-total");
  if (pf && state.wallet) pf.textContent = usd(state.sol * (state.prices[SOL] || 0) + state.holdings.reduce((n, h) => n + h.ui * (state.prices[h.mint] || 0), 0));
  const p = activePnl();
  const solPx = $("#sol-px");
  if (solPx) solPx.textContent = usd(state.prices[SOL] || 0);
  const chg = $("#chg");
  const live = $("#live");
  const barH = $("#bar-hold");
  const barP = $("#bar-pnl");
  const est = $("#est");
  const stat = $("#status");
  const mc = $("#mc");
  if (mc && t) mc.textContent = usd(t.mcap || (t.circSupply || 0) * (state.prices[t.id] || 0));
  if (chg && t) {
    const c = t.stats24h?.priceChange || 0;
    chg.textContent = moveLabel(c);
    chg.className = "chg " + cls(c);
  }
  if (live && t) {
    const supply = t.circSupply || 0;
    const price = state.prices[t.id] || t.usdPrice || 0;
    const base = state.candles.length ? state.candles[0].open : price;
    const mc = supply ? price * supply : (t.mcap || 0);
    const prev = supply ? base * supply : base;
    const dUsd = mc - prev;
    const pct = prev ? (dUsd / prev) * 100 : 0;
    const bare = (n) => usd(Math.abs(n)).replace("$", "");
    live.textContent = bare(mc) + "  " + bare(dUsd) + " (" + signed(pct) + "%)";
    live.className = "chart-live " + cls(pct);
  }
  const utc = $("#utc");
  if (utc) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    utc.textContent = p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + ":" + p(d.getUTCSeconds()) + " (UTC)";
  }
  if (barH) barH.textContent = "Holding " + usd(p.value);
  if (barP) {
    barP.textContent = pnlText(p.d, p.p);
    barP.className = cls(p.p);
  }
  if (est) est.innerHTML = quoteSummary();
  if (stat) stat.textContent = state.quoting ? "Quoting…" : state.status;
  document.querySelectorAll("[data-mint]").forEach((row) => {
    const h = state.holdings.find((x) => x.mint === row.dataset.mint);
    if (!h) return;
    const price = state.prices[h.mint] || 0;
    const entry = entryOf(h.mint, price);
    const value = h.ui * price;
    const d = value - h.ui * entry;
    const pct = entry ? ((price - entry) / entry) * 100 : 0;
    const hn = $(".hold-n", row);
    const pn = $(".pnl", row);
    if (hn) hn.textContent = usd(value);
    if (pn) pn.innerHTML = `<b class="${cls(d)}">${signed(d)}</b><span class="${cls(pct)}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%</span>`;
  });
  drawChart();
}

function drawChart() {
  const c = $("#chart");
  if (!c) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = c.clientWidth || 360;
  const h = c.clientHeight || 280;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const cs = state.candles.length ? state.candles : [];
  if (!cs.length) return;
  const padR = 70;
  const padL = 40;
  const volH = state.showInd ? 28 : 0;
  const chopH = state.showInd ? 12 : 0;
  const macdH = state.showInd ? 14 : 0;
  const top = 20;
  const plotB = h - volH - chopH - macdH - 6;
  const max = Math.max(...cs.map((x) => x.high));
  const min = Math.min(...cs.map((x) => x.low));
  const Y = (v) => top + ((max - v) / (max - min || 1)) * (plotB - top);
  const slot = (w - padR - padL) / cs.length;
  cs.forEach((cd, i) => {
    const up = cd.close >= cd.open;
    const x = padL + i * slot;
    g.strokeStyle = up ? "#5ed68c" : "#e5546f";
    g.fillStyle = up ? "#5ed68c" : "#e5546f";
    g.beginPath();
    g.moveTo(x + slot / 2, Y(cd.high));
    g.lineTo(x + slot / 2, Y(cd.low));
    g.stroke();
    const y1 = Y(Math.max(cd.open, cd.close));
    const y2 = Y(Math.min(cd.open, cd.close));
    g.fillRect(x + 1, y1, Math.max(2, slot - 3), Math.max(1, y2 - y1));
    const vmax = Math.max(...cs.map((x) => x.volume || 0)) || 1;
    g.globalAlpha = 0.85;
    const vx = Math.max(x + 1, 64);
    if (vx < w - padR) g.fillRect(vx, plotB + 4, Math.max(2, slot - 3), ((cd.volume || 0) / vmax) * (volH - 6));
    g.globalAlpha = 1;
    g.fillStyle = up ? "#e6c84a" : "#5ed6e0";
    g.fillRect(Math.max(x + 1, 78), h - macdH - chopH, Math.max(2, slot - 2), chopH - 2);
  });
  const entry = activePnl().entry;
  if (entry && entry >= min && entry <= max) {
    g.setLineDash([3, 3]);
    g.strokeStyle = "#5ed68c";
    g.beginPath();
    g.moveTo(padL, Y(entry));
    g.lineTo(w - padR, Y(entry));
    g.stroke();
    g.setLineDash([]);
  }
  const supply = state.active?.circSupply || 0;
  const axis = (v) => (supply ? usd(v * supply) : usd(v)).replace("$", "");
  g.font = "10px -apple-system, sans-serif";
  g.textAlign = "right";
  g.fillStyle = "#8b939e";
  [0.2, 0.5, 0.8].forEach((t) => {
    const v = max - (max - min) * t;
    const y = Y(v);
    g.strokeStyle = "rgba(255,255,255,.06)";
    g.beginPath();
    g.moveTo(padL, y);
    g.lineTo(w - 28, y);
    g.stroke();
    g.fillText(axis(v), w - 28, y - 2);
  });
  g.textAlign = "left";
  const last = cs[cs.length - 1].close;
  const priceLabel = axis(last);
  g.font = "9px -apple-system, sans-serif";
  const pw = g.measureText(priceLabel).width + 8;
  const px = w - pw - 48;
  const tagY = Math.min(Math.max(Y(last), top + 10), plotB - 10);
  g.fillStyle = last >= cs[cs.length - 1].open ? "#143024" : "#3a1520";
  g.fillRect(px, tagY - 8, pw, 16);
  g.fillStyle = "#fff";
  g.fillText(priceLabel, px + 4, tagY + 3);
  if (entry && entry >= min && entry <= max) {
    g.fillStyle = "#5ed68c";
    g.font = "11px -apple-system, sans-serif";
    const entryLabel = "Avg Entry";
    const lw = g.measureText(entryLabel).width;
    const entryY = Math.min(Math.max(Y(entry) - 6, top + 12), plotB - 4);
    g.fillText(entryLabel, Math.max(padL, px - lw - 8), entryY);
  }
  if (state.showInd) {
    g.fillStyle = "#8b939e";
    g.font = "11px -apple-system, sans-serif";
    g.fillText("Volume", 4, plotB + 12);
    g.fillText("Chop Zone", 4, h - macdH - 2);
    g.fillText("MACD 12 26 close 9", 4, h - 3);
  }
  if (state.pointer && state.tool === "cross") {
    g.strokeStyle = "rgba(255,255,255,.5)";
    g.setLineDash([2, 2]);
    g.beginPath();
    g.moveTo(state.pointer.x, 0);
    g.lineTo(state.pointer.x, plotB);
    g.moveTo(28, state.pointer.y);
    g.lineTo(w - 30, state.pointer.y);
    g.stroke();
    g.setLineDash([]);
  }
  g.lineWidth = 1.5;
  state.marks.forEach((m) => {
    if (!m.a) return;
    if (m.kind === "text") {
      g.fillStyle = "#fff";
      g.font = "12px -apple-system, sans-serif";
      g.fillText(m.text || "Note", m.a.x, m.a.y);
      return;
    }
    if (!m.b) return;
    g.strokeStyle = m.kind === "trend" ? "#e6c84a" : "#9aa3ad";
    g.beginPath();
    if (m.kind === "range") {
      g.strokeRect(Math.min(m.a.x, m.b.x), Math.min(m.a.y, m.b.y), Math.abs(m.b.x - m.a.x), Math.abs(m.b.y - m.a.y));
    } else {
      g.moveTo(m.a.x, m.a.y);
      g.lineTo(m.b.x, m.b.y);
      g.stroke();
    }
  });
}

function drawMap() {
  const c = $("#map");
  if (!c) return;
  const dpr = 2;
  const w = c.clientWidth || 360;
  const h = c.clientHeight || 280;
  c.width = w * dpr;
  c.height = h * dpr;
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = "#070b12";
  g.fillRect(0, 0, w, h);
  g.strokeStyle = "rgba(160,180,200,.28)";
  for (let i = 0; i < 36; i++) {
    const x = (i * 83) % w;
    const y = (i * 47) % h;
    g.beginPath();
    g.arc(x, y, 5 + (i % 7), 0, 7);
    g.stroke();
  }
  const hs = state.holders.slice(0, 28);
  if (hs.length) {
    const maxA = Math.max(...hs.map((h) => h.amount || 0), 1);
    const pts = hs.map((holder, i) => {
      const n = [...(holder.address || "x")].reduce((s, ch) => s + ch.charCodeAt(0), 0);
      return {
        x: 28 + (n % 15) * ((w - 56) / 15),
        y: 24 + ((n * 3) % 9) * ((h - 48) / 9),
        r: 4 + 14 * Math.sqrt((holder.amount || 0) / maxA),
        i
      };
    });
    const link = (group, color) => {
      g.strokeStyle = color;
      g.lineWidth = 1.2;
      g.beginPath();
      group.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.stroke();
    };
    link(pts.slice(0, 6), "#e6c84a");
    link(pts.slice(6, 12), "#3DDC84");
    pts.forEach((p) => {
      g.fillStyle = p.i < 6 ? "#e6c84a" : p.i < 12 ? "#3DDC84" : "rgba(160,180,200,.35)";
      g.globalAlpha = p.i < 12 ? 0.95 : 0.55;
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, 7);
      g.fill();
      g.globalAlpha = 1;
    });
    return;
  }
}

function stat(win) {
  const t = state.active || {};
  return t["stats" + win] || {};
}

function render() {
  const t = state.active;
  const p = activePnl();
  const price = t ? (state.prices[t.id] || t.usdPrice || 0) : 0;
  const chg = t && p.entry ? ((price - p.entry) / p.entry) * 100 : (t?.stats24h?.priceChange || 0);
  app.innerHTML = `
    <div class="browser">
      <div class="avatar">🐨</div>
      <button class="url" id="search-open"><span class="lock">🔒</span> jup.ag</button>
      <button class="icon-btn" id="connect" aria-label="Wallet">${state.wallet ? state.wallet.slice(0, 4) : "＋"}</button>
    </div>
    <div class="scroll">
      ${state.view === "portfolio" ? portfolioView() : `
      ${t ? tokenHead(t, price, chg) : `<div class="panel">${esc(state.status || "Search a token to trade.")}</div>`}
      <div class="tabs" role="tablist" aria-label="Token details">
        ${[["trade","Overview"],["holders","Holders"],["tx","Trades"],["holdings","Holding"]].map(([id,label]) => `<button type="button" role="tab" data-tab="${id}" class="${state.tab===id?"on":""}" aria-selected="${state.tab===id}">${label}${id==="holders" && t?.holderCount ? ` <span class="tab-n">${compactCount(t.holderCount)}</span>` : ""}</button>`).join("")}
      </div>
      <div class="panel">${panel()}</div>`}
    </div>
    <div class="bar">
      <span id="bar-hold">Holding ${usd(p.value)}</span>
      <span id="bar-pnl" class="${cls(p.d)}">${pnlText(p.d, p.p)}</span>
    </div>
    <nav class="nav">
      <button type="button" data-nav="spot" class="${state.view==="spot"?"on":""}"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>Spot</button>
      <button type="button" data-nav="soon"><svg viewBox="0 0 24 24"><path d="M4 16l5-6 4 3 7-8"/></svg>Perps</button>
      <button type="button" data-nav="soon"><svg viewBox="0 0 24 24"><path d="M4 10h16v8H4zM8 10V7a4 4 0 0 1 8 0v3"/></svg>Lend</button>
      <button type="button" data-nav="soon"><svg viewBox="0 0 24 24"><path d="M5 19V5M5 19h14M9 15l3-4 2 2 4-5"/></svg>Predict</button>
      <button type="button" data-nav="portfolio" class="${state.view==="portfolio"?"on":""}"><svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM8 7V5h8v2"/></svg>Portfolio</button>
    </nav>
    ${state.infoOpen ? sheet() : ""}
    ${state.searchOpen ? searchSheet() : ""}
    ${state.toast ? `<div class="toast"><span>${/^(Bought|Sold)/.test(state.toast) ? "✓ " : ""}${esc(state.toast)}</span><button id="toast-x">✕</button></div>` : ""}
  `;
  bind();
  drawChart();
  if (state.view === "spot" && state.tab === "holders") drawMap();
}

function tokenAge(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.max(1, Math.floor(s)) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function tokenHead(t, price, chg) {
  const s1 = t.stats1h || {};
  return `<div class="token-head">
      <div class="tok-av">${t.icon ? `<img src="${esc(t.icon)}" alt="" width="36" height="36">` : "●"}</div>
      <div class="tok-name">
        <div class="sym">${esc(t.symbol)} <span style="font-weight:500;color:var(--muted)">${esc(t.name || "")}</span></div>
        <div class="sub"><span class="age">${tokenAge(t.createdAt)}</span><span>${(t.id || "").slice(0, 4)}…${(t.id || "").slice(-4)}</span><button type="button" class="copy" data-copy="${t.id}" aria-label="Copy">⧉</button><button type="button" class="copy" id="token-search" aria-label="Search">⌕</button></div>
      </div>
      <div class="mc">
        <div class="px" id="mc">${usd(t.mcap || 0)}</div>
        <div class="chg ${cls(t.stats24h?.priceChange || 0)}" id="chg">${moveLabel(t.stats24h?.priceChange || 0)}</div>
      </div>
    </div>
    <div class="stats">
      <div><div class="k">Price</div><div class="v">${usd(price)}</div></div>
      <div><div class="k">Liquidity</div><div class="v">${usd(t.liquidity || 0)}</div></div>
      <div><div class="k">1h Vol</div><div class="v">${usd((s1.buyVolume || 0) + (s1.sellVolume || 0))}</div></div>
      <div><div class="k">Fees Paid</div><div class="v">${t.fees == null ? "—" : usd(t.fees)}</div></div>
      <div><div class="k">Org Score</div><div class="v">${t.organicScore == null ? "—" : Number(t.organicScore).toFixed(1)} <button id="info">⌄</button></div></div>
    </div>
    <div class="tf">${["Auto","15s","1m","3m","15m","1h","4h","1D"].map((x)=>`<button data-tf="${x}" class="${state.tf===x?"on":""}">${x}</button>`).join("")}<span class="tf-tools"><button type="button" id="ind" aria-label="Indicators">▦</button><button type="button" id="chart-set" aria-label="Chart settings">⚙</button></span></div>
    <div class="chart-wrap">
      <div class="tools">
        <button type="button" data-tool="cross" class="${state.tool==="cross"?"on":""}" aria-label="Crosshair"><svg viewBox="0 0 16 16"><path d="M8 1v14M1 8h14"/></svg></button>
        <button type="button" data-tool="trend" class="${state.tool==="trend"?"on":""}" aria-label="Trend"><svg viewBox="0 0 16 16"><path d="M2 12l4-5 3 2 5-7"/></svg></button>
        <button type="button" data-tool="range" class="${state.tool==="range"?"on":""}" aria-label="Range"><svg viewBox="0 0 16 16"><path d="M3 3h10M3 8h10M3 13h10"/></svg></button>
        <button type="button" data-tool="text" class="${state.tool==="text"?"on":""}" aria-label="Text"><svg viewBox="0 0 16 16"><path d="M3 3h10M8 3v10"/></svg></button>
      </div>
      <canvas class="chart" id="chart"></canvas>
      <div class="chart-label">${esc(t.symbol)}/USD · jup.ag<div id="live"></div></div>
      <div class="al al-price"><button class="on">A</button><button>L</button></div>
      <div class="al al-vol"><button>A</button><button>L</button></div>
      <div class="al al-chop"><button>A</button><button>L</button></div>
    </div>
    <div class="chart-foot"><span></span><button type="button" class="range">Date Range ▾</button><span id="utc">${new Date().toISOString().slice(11, 19)} (UTC)</span><span>% log auto</span></div>
    <div class="subnav"><button type="button" data-tab="holders">‹ Holders (${(t.holderCount || 0).toLocaleString()})</button><button type="button">Top Traders</button><button type="button">Dev Tokens${t.audit?.devMints == null ? "" : ` (${Number(t.audit.devMints).toLocaleString()})`}</button></div>`;
}

function panel() {
  if (state.tab === "trade") return tradePanel();
  if (state.tab === "tx") return txPanel();
  if (state.tab === "holders") return holdersPanel();
  if (state.tab === "holdings") return holdingsPanel();
  return tradePanel();
}

function connectPrompt(text) {
  return `<div class="k" style="padding:16px 0">${text}</div><button type="button" class="go buy" data-connect style="width:100%;padding:12px 0">Connect wallet</button>`;
}
function holdingsPanel() {
  const head = `<div class="cols"><span>Last Traded</span><span>Holding</span><span>Unrealised</span><span>Actions</span></div>`;
  if (!state.wallet) return head + connectPrompt("Connect your wallet to see your holdings.");
  if (state.holdingsLoading && !state.holdings.length) return head + `<div class="k" style="padding:16px 0">Loading holdings…</div>`;
  if (state.holdingsError && !state.holdings.length) return head + `<div class="k" style="padding:16px 0">Couldn't load holdings: ${esc(state.holdingsError)} <button type="button" data-reload-holdings class="copy">Retry</button></div>`;
  if (!state.holdings.length) return head + `<div class="k" style="padding:16px 0">No token balances in this wallet yet. Tokens you buy will appear here.</div>`;
  const rows = [...state.holdings].sort((a, b) => b.ui * (state.prices[b.mint] || 0) - a.ui * (state.prices[a.mint] || 0)).map((h) => {
    const price = state.prices[h.mint] || 0;
    const entry = entryOf(h.mint, price);
    const value = h.ui * price;
    const d = value - h.ui * entry;
    const pct = entry ? ((price - entry) / entry) * 100 : 0;
    return `<div class="row" data-mint="${h.mint}">
      <div class="who"><div class="tok-av">${h.icon ? `<img src="${esc(h.icon)}" alt="">` : "●"}</div><div class="meta"><b>${esc(h.symbol || h.mint.slice(0, 4))}</b><span>now</span></div></div>
      <div><div class="hold-n">${usd(value)}</div><div class="hold-q">${qty(h.ui)}</div></div>
      <div class="pnl"><b class="${cls(d)}">${signed(d)}</b><span class="${cls(pct)}">${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(2)}%</span></div>
      <div class="actions"><span class="share" aria-hidden="true">↗</span><button class="sell" data-sell="${h.mint}">Sell</button></div>
    </div>`;
  }).join("");
  return head + rows;
}

function portfolioView() {
  const w = state.wallet;
  const solPx = state.prices[SOL] || 0;
  const tokUsd = state.holdings.reduce((n, h) => n + h.ui * (state.prices[h.mint] || 0), 0);
  const total = state.sol * solPx + tokUsd;
  const top = `<div class="token-head"><div class="tok-name"><div class="sym">Portfolio</div>
      <div class="sub">${w ? `<span>${w.slice(0, 4)}…${w.slice(-4)}</span><button type="button" class="copy" data-copy="${w}" aria-label="Copy">⧉</button>` : `<span>No wallet connected</span>`}</div></div>
      <div class="mc"><div class="px" id="pf-total">${w ? usd(total) : "—"}</div><div class="k">Net worth</div></div></div>`;
  if (!w) return top + `<div class="panel">${connectPrompt("Connect your Solana wallet (Phantom, Solflare or Backpack) to see your balances.")}</div>`;
  const solRow = `<div class="row" data-pf-sol><div class="who"><div class="tok-av"><img src="${SOL_ICON}" alt=""></div><div class="meta"><b>SOL</b><span>${usd(solPx)}</span></div></div>
      <div><div class="hold-n">${usd(state.sol * solPx)}</div><div class="hold-q">${solText(state.sol)}</div></div><div></div><div></div></div>`;
  return top + `<div class="panel">${solRow}${holdingsPanel()}</div>`;
}

function quoteSummary() {
  const t = state.active;
  if (!t) return "—";
  if (state.quote?.errorMessage && state.wallet) return `<span class="down">${esc(state.quote.errorMessage)}</span>`;
  if (!state.quote?.outAmount) return state.quoting ? "…" : "—";
  const outDec = state.side === "buy" ? (t.decimals || 6) : 9;
  const outUi = ui(state.quote.outAmount, outDec);
  const solPx = state.prices[SOL] || 0;
  const tokPx = state.prices[t.id] || t.usdPrice || 0;
  const outUsd = state.side === "buy" ? outUi * tokPx : outUi * solPx;
  const inUsd = state.side === "buy" ? Number(state.amount) * solPx : sellTokens() * tokPx;
  const pct = inUsd ? ((outUsd - inUsd) / inUsd) * 100 : 0;
  const icon = state.side === "buy" ? (t.icon ? `<img src="${esc(t.icon)}" alt="">` : "●") : `<img src="${SOL_ICON}" alt="">`;
  return `<span class="mini">${icon}</span><b>${qty(outUi)}</b> <span class="est-usd">${usd(outUsd)}</span> <span class="${cls(pct)}">(${signed(pct)}%)</span> <span class="chev">›</span>`;
}
function tradePanel() {
  const t = state.active;
  if (!t) return "";
  const bal = state.side === "buy" ? solText(state.sol) : qty(activePnl().amount);
  const balIcon = state.side === "buy" ? SOL_ICON : t.icon;
  const label = state.wallet ? (state.side === "buy" ? "Buy" : "Sell") : "Connect";
  return `<div class="trade-top">
      <span class="bal"><span class="mini">${balIcon ? `<img src="${balIcon}" alt="">` : "●"}</span> ${bal} <button class="pencil" type="button" aria-label="Edit">✎</button></span>
      <span class="trade-right"><span class="market-wrap"><button class="market" type="button" id="market">Market <span>▾</span></button>${state.marketOpen ? `<div class="market-menu"><button type="button" class="on">Market</button></div>` : ""}</span>
      <div class="seg">
        <button class="buy ${state.side==="buy"?"on":""}" data-side="buy">Buy</button>
        <button class="sell ${state.side==="sell"?"on":""}" data-side="sell">Sell</button>
      </div></span>
    </div>
    <div class="presets">${state.side === "buy" ? [0.1, 0.5, 1, 10].map((n)=>`<button data-amt="${n}" class="${Number(state.amount)===n?"on":""}">${n.toFixed(n < 1 ? 1 : 2)}</button>`).join("") : [10, 25, 50, 100].map((n)=>`<button data-pct="${n}" class="${Number(state.sellPct)===n?"on":""}">${n.toFixed(2)}%</button>`).join("")}</div>
    <div class="amt-row">
      <label class="amt-box"><span class="k">${state.side === "buy" ? "AMOUNT" : "PERCENT"}</span><input id="amt" inputmode="decimal" value="${state.side === "buy" ? state.amount : state.sellPct}">${state.side === "buy" ? `<span class="mini"><img src="${SOL_ICON}" alt=""></span>` : `<span class="pct-unit">%</span>`}<span class="chev">▾</span></label>
      <button class="go ${state.side}" id="go" ${state.busy ? "disabled" : ""}>${state.busy ? "…" : label}</button>
    </div>
    <div class="fine"><span>Est. Received <span class="badge">2</span></span><span id="est" class="est-right">${quoteSummary()}</span></div>
    <div class="ultra">✦ Jupiter Swap · <span id="status">${esc(state.status)}</span></div>`;
}

function tapeRows() {
  const t = state.active || {};
  const supply = t.circSupply || 0;
  let rows = state.tape;
  if (state.txFilter === "You") rows = rows.filter((x) => state.wallet && x.traderAddress === state.wallet);
  else if (state.txFilter === "Dev") rows = rows.filter((x) => t.dev && x.traderAddress === t.dev);
  else if (state.txFilter !== "All") {
    const key = state.txFilter.toLowerCase();
    rows = rows.filter((x) => (x.walletCategories || []).some((c) => String(c).toLowerCase().includes(key)));
  }
  if (!rows.length) return `<div class="k" style="padding:12px 0">No ${state.txFilter.toLowerCase()} trades in the latest tape.</div>`;
  return rows.slice(0, 40).map((x) => {
    const buy = x.type === "buy";
    const mc = supply && x.usdPrice ? usd(supply * x.usdPrice) : "—";
    return `<div class="trow"><span class="age">${ageLabel(x.timestamp)}</span><span>${mc}</span><span class="${buy ? "up" : "down"}">${qty(x.amount)}</span><span class="vol ${buy ? "up" : "down"}">${tapeVol(x.usdVolume)}</span><span class="trader">${(x.traderAddress || "").slice(-3)} ▾</span></div>`;
  }).join("");
}

function txPanel() {
  const chips = ["All", "You", "Dev", "Followed", "Sniper", "Insider", "Bundler"];
  return `<div class="filters">${chips.map((f) => `<button data-txf="${f}" class="${state.txFilter === f ? "on" : ""}">${f}</button>`).join("")}</div>
    <div class="tcols"><span>Age ↕</span><span>MC ↕</span><span>${esc(state.active?.symbol || "")}</span><span>Vol</span><span>Trader</span></div>
    <div id="tape">${state.tape.length ? tapeRows() : `<div class="k">Loading trades…</div>`}</div>`;
}

function holdersPanel() {
  const t = state.active || {};
  const audit = t.audit || {};
  const top = audit.topHoldersPercentage;
  return `<div class="holder-stats">
      <div>Holders: ${(t.holderCount || 0).toLocaleString()} &nbsp; Top 10 holders: <span class="down">${top != null ? top.toFixed(2) + "%" : "—"}</span></div>
    </div>
    <div class="filters">
      ${["All","Dev","Followed","Sniper","Insider"].map((f,i)=>`<button class="${i===0?"on":""}">${f}</button>`).join("")}
      <button class="boost">⚡ BOOST</button>
    </div>
    <div class="map-tools"><span class="tok-av">${t.icon ? `<img src="${esc(t.icon)}" alt="">` : "●"}</span><span>just now</span></div>
    <div class="map-wrap"><canvas class="map" id="map"></canvas><div class="map-note" id="map-note">${state.mapReady ? "" : "Enhancing map…"}</div></div>`;
}

function sheet() {
  const t = state.active || {};
  const audit = t.audit || {};
  const s = stat(state.infoWin);
  const buy = (s.buyVolume || 0);
  const sell = (s.sellVolume || 0);
  const buyPct = buy + sell ? Math.round(100 * buy / (buy + sell)) : 0;
  return `<div class="sheet" id="sheet">
    <div class="grab"></div>
    <h2>${esc(t.name || t.symbol)} Token Info</h2>
    <div class="grid3">
      <div><div class="k">Price</div><div class="v">${usd(t.usdPrice)}</div></div>
      <div><div class="k">FDV</div><div class="v">${usd(t.fdv || t.mcap)}</div></div>
      <div><div class="k">Liquidity</div><div class="v">${usd(t.liquidity)}</div></div>
      <div><div class="k">Holders</div><div class="v">${t.holderCount ?? "—"}</div></div>
      <div><div class="k">Org Score</div><div class="v">${t.organicScore == null ? "—" : Number(t.organicScore).toFixed(1)}</div></div>
    </div>
    <div class="grid4">
      ${["5m","1h","6h","24h"].map((w)=>`<button data-win="${w}" class="${state.infoWin===w?"on":""}">${w}<small class="${cls(stat(w).priceChange||0)}">${signed(stat(w).priceChange||0)}%</small></button>`).join("")}
    </div>
    <div class="grid3">
      <div><div class="k">${state.infoWin} Vol</div><div class="v">${usd(buy + sell)}</div></div>
      <div><div class="k">Net Vol</div><div class="v ${cls(buy-sell)}">${usd(buy - sell)}</div></div>
      <div><div class="k">Buy</div><div class="v up">${buyPct}%</div></div>
      <div><div class="k">Traders</div><div class="v">${s.numTraders ?? "—"}</div></div>
      <div><div class="k">Net Buyers</div><div class="v">${s.numNetBuyers ?? "—"}</div></div>
    </div>
    <div class="tiles">
      <div class="tile"><b class="down">${audit.topHoldersPercentage != null ? audit.topHoldersPercentage.toFixed(2) + "%" : "—"}</b>Top 10 H.</div>
      <div class="tile"><b class="up">${audit.devBalancePercentage != null ? audit.devBalancePercentage.toFixed(2) + "%" : "—"}</b>Dev H.</div>
      <div class="tile"><b class="${audit.freezeAuthorityDisabled ? "up" : "down"}">${audit.freezeAuthorityDisabled ? "No" : "Yes"}</b>Freeze Auth</div>
      <div class="tile"><b class="${audit.mintAuthorityDisabled ? "up" : "down"}">${audit.mintAuthorityDisabled ? "No" : "Yes"}</b>Mint Auth</div>
    </div>
    <button id="sheet-close" class="go buy">Close</button>
  </div>`;
}

function searchSheet() {
  return `<div class="sheet" id="search-sheet"><div class="grab"></div><h2>Search <button type="button" id="search-close" aria-label="Close" style="float:right;background:none;border:0;color:var(--muted);font-size:18px">✕</button></h2><input id="q" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Name, ticker or contract address" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#12171e;color:#fff;font-size:16px"><div id="results">${searchRows()}</div></div>`;
}

function bind() {
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => { state.tab = b.dataset.tab; render(); });
  document.querySelectorAll("[data-tf]").forEach((b) => b.onclick = () => { state.tf = b.dataset.tf; render(); loadCandles(); });
  document.querySelectorAll("[data-side]").forEach((b) => b.onclick = () => { state.side = b.dataset.side; state.quote = null; render(); scheduleQuote(0); });
  document.querySelectorAll("[data-amt]").forEach((b) => b.onclick = () => { state.amount = Number(b.dataset.amt); render(); scheduleQuote(0); });
  document.querySelectorAll("[data-pct]").forEach((b) => b.onclick = () => { state.sellPct = Number(b.dataset.pct); render(); scheduleQuote(0); });
  const amt = $("#amt");
  if (amt) amt.oninput = () => {
    const v = Number(String(amt.value).replace(",", "."));
    if (!Number.isFinite(v)) return;
    if (state.side === "sell") state.sellPct = Math.min(100, Math.max(0, v));
    else state.amount = v;
    state.quote = null;
    scheduleQuote(700);
  };
  const go = $("#go");
  if (go) go.onclick = () => state.wallet ? trade() : connect();
  const market = $("#market");
  if (market) market.onclick = (e) => { e.stopPropagation(); state.marketOpen = !state.marketOpen; render(); };
  const ind = $("#ind");
  if (ind) ind.onclick = () => { state.showInd = !state.showInd; render(); };
  const tokenSearch = $("#token-search");
  if (tokenSearch) tokenSearch.onclick = () => { state.searchOpen = true; render(); };
  document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => { state.toast = "Copied"; render(); }).catch(() => {});
  });
  const info = $("#info");
  if (info) info.onclick = () => { state.infoOpen = true; render(); };
  const close = $("#sheet-close");
  if (close) close.onclick = () => { state.infoOpen = false; render(); };
  document.querySelectorAll("[data-win]").forEach((b) => b.onclick = () => { state.infoWin = b.dataset.win; render(); });
  document.querySelectorAll("[data-sell]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const mint = b.dataset.sell;
    state.side = "sell";
    state.tab = "trade";
    state.sellPct = 100;
    state.view = "spot";
    await loadToken(mint).catch((err) => { state.status = err.message; render(); });
  });
  document.querySelectorAll("[data-mint]").forEach((r) => r.onclick = (e) => {
    if (e.target.closest("[data-sell]")) return;
    state.tab = "trade";
    state.view = "spot";
    loadToken(r.dataset.mint).catch((err) => { state.status = err.message; render(); });
  });
  document.querySelectorAll("[data-nav]").forEach((b) => b.onclick = () => {
    const v = b.dataset.nav;
    if (v === "soon") { state.toast = "Only Spot and Portfolio are in this app. Use jup.ag for the rest."; render(); return; }
    state.view = v;
    render();
    $(".scroll") && ($(".scroll").scrollTop = 0);
    if (v === "portfolio" && state.wallet && !state.holdingsLoading) loadHoldings().catch(() => {});
  });
  document.querySelectorAll("[data-connect]").forEach((b) => b.onclick = () => connect());
  document.querySelectorAll("[data-reload-holdings]").forEach((b) => b.onclick = () => loadHoldings().catch(() => {}));
  const c = $("#connect");
  if (c) c.onclick = () => connect();
  const so = $("#search-open");
  if (so) so.onclick = () => { state.searchOpen = true; render(); };
  const q = $("#q");
  if (q) {
    q.oninput = () => search(q.value.trim());
    q.onkeydown = (e) => {
      if (e.key === "Escape") { state.searchOpen = false; render(); }
      if (e.key === "Enter" && q.value.trim()) pick((state.results[0] && state.results[0].id) || q.value.trim());
    };
    setTimeout(() => q.focus(), 0);
  }
  const sc = $("#search-close");
  if (sc) sc.onclick = () => { state.searchOpen = false; render(); };
  document.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => pick(b.dataset.pick));
  document.querySelectorAll("[data-tool]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    state.tool = b.dataset.tool;
    document.querySelectorAll("[data-tool]").forEach((x) => x.classList.toggle("on", x.dataset.tool === state.tool));
  });
  const chart = $("#chart");
  if (chart) {
    const pt = (ev) => {
      const r = chart.getBoundingClientRect();
      const src = ev.touches ? ev.touches[0] : ev;
      return { x: src.clientX - r.left, y: src.clientY - r.top };
    };
    chart.onpointerdown = (ev) => {
      const p = pt(ev);
      if (state.tool === "cross") { state.pointer = p; drawChart(); return; }
      if (state.tool === "text") { state.marks.push({ kind: "text", a: p, text: "Note" }); drawChart(); return; }
      const open = state.marks.find((m) => m.kind === state.tool && !m.b);
      if (!open) state.marks.push({ kind: state.tool, a: p });
      else open.b = p;
      drawChart();
    };
    chart.onpointermove = (ev) => {
      if (state.tool !== "cross") return;
      state.pointer = pt(ev);
      drawChart();
    };
  }
  document.querySelectorAll("[data-txf]").forEach((b) => b.onclick = () => {
    state.txFilter = b.dataset.txf;
    const box = $("#tape");
    if (box) box.innerHTML = tapeRows();
    document.querySelectorAll("[data-txf]").forEach((x) => x.classList.toggle("on", x.dataset.txf === state.txFilter));
  });
  const tx = $("#toast-x");
  if (tx) tx.onclick = () => { state.toast = null; render(); };
}

let started = false;
function every(ms, fn) {
  const tick = async () => {
    if (!document.hidden) { try { await fn(); } catch (_) {} }
    setTimeout(tick, Math.max(ms, coolUntil - Date.now()));
  };
  setTimeout(tick, ms);
}

async function boot() {
  try {
    const start = new URLSearchParams(location.search).get("token") || "BONK";
    await loadToken(start);
    if (started) return;
    started = true;
    connect(true);
    every(PRICE_EVERY_MS, pollPrices);
    every(QUOTE_EVERY_MS, () => { if (!state.busy) return refreshQuote(); });
    every(FEED_EVERY_MS, () => Promise.all([loadTape().catch(() => {}), loadCandles().catch(() => {})]));
    every(30000, () => Promise.all([loadHolders().catch(() => {}), state.wallet ? loadHoldings() : null]));
  } catch (err) {
    state.status = err.message || String(err);
    render();
    setTimeout(boot, Math.max(5000, coolUntil - Date.now()));
  }
}
boot();
