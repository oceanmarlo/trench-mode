const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const SOL = "So11111111111111111111111111111111111111112";
const SOL_ICON = "https://static.datapi.jup.ag/token-icons/79a96c7b893fd899512411dd07a8adf6f9e26dd135989f51d46ddb50f0b8bb6c.webp";
// ipfs.io sends Cross-Origin-Resource-Policy: same-origin, so the phone blocks the image.
function iconUrl(url) {
  const raw = String(url || "").trim();
  if (!raw || raw.startsWith("data:") || /gateway\.pinata\.cloud\/ipfs\//i.test(raw)) return raw;
  let cid = "";
  const path = raw.match(/\/ipfs\/([A-Za-z0-9]+)/i);
  if (path) cid = path[1];
  else if (/^ipfs:\/\//i.test(raw)) cid = raw.replace(/^ipfs:\/\//i, "").split(/[/?#]/)[0];
  else {
    const sub = raw.match(/^https?:\/\/([a-z0-9]{46,})\.ipfs\./i);
    if (sub) cid = sub[1];
  }
  return cid ? "https://gateway.pinata.cloud/ipfs/" + cid : raw;
}
// Swap API V2 (/order + /execute). Same request/response shape as Ultra v1, which Jupiter no longer maintains.
const SWAP = "https://api.jup.ag/swap/v2";
const PRICE = "https://api.jup.ag/price/v3";
const RPC = (window.HELIUS_API_KEY && !/[?&]nohelius=1/.test(location.search)) ? "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(window.HELIUS_API_KEY) : "https://solana-rpc.publicnode.com";
const TOKEN_PROGRAMS = ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VeKKdPT7yHdmnMvEGB4ryFHSZH9Ee"];
const PRICE_EVERY_MS = 2500;   // keyed price poll, ONLY used while the stream is down (keeps <= 1 req / 2 s)
const QUOTE_EVERY_MS = 12000;  // background order refresh
const FEED_EVERY_MS = 1000;    // datapi chart refresh (separate host, no key budget); trades poll only if stream is down
const TFS = ["Auto", "1s", "15s", "1m", "3m", "5m", "15m", "30m", "1h", "4h", "1D"];
const TF_SEC = { "Auto": 60, "1s": 1, "15s": 15, "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1D": 86400 };
const TF_API = { "1s": "1_SECOND", "15s": "15_SECOND", "1m": "1_MINUTE", "3m": "3_MINUTE", "5m": "5_MINUTE", "15m": "15_MINUTE", "30m": "30_MINUTE", "1h": "1_HOUR", "4h": "4_HOUR", "1D": "1_DAY" };

const state = {
  tab: "holders",
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
  searchQ: "",
  searching: false,
  marketOpen: false,
  orderType: "market",
  slMode: "pct",
  slPct: 10,
  slPrice: "",
  trailPct: 10,
  stops: [],
  trailMark: {},
  stopLive: {},
  results: [],
  spotScan: { kind: "trending", rows: [], loading: false, err: "" },
  toast: null,
  status: "Connecting to Jupiter…",
  wallet: null,
  provider: null,
  sol: 0,
  quote: null,
  quoteOpen: false,
  quoting: false,
  busy: false,
  holdersLoading: false,
  holdersError: "",
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
  txSort: "age",
  txDir: "desc",
  tool: "cross",
  pointer: null,
  marks: []
};

const tapeVol = (n) => {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const a = Math.abs(Number(n));
  if (!(a > 0)) return "$0.00";
  if (a >= 100) return "$" + a.toFixed(2);
  if (a >= 1) return "$" + a.toFixed(4);
  // A 1.74 Bonk fill is about $0.000004. Five decimals printed that as $0.00000.
  const fine = "$" + a.toFixed(5);
  if (fine !== "$0.00000") return fine;
  return usd(a);
};
const usd = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  // $42.5B was printing $42551.05M. Step up before the label rounds to 1000 of the last unit.
  if (a >= 999.995e9) return sign + "$" + (a / 1e12).toFixed(2) + "T";
  if (a >= 999.995e6) return sign + "$" + (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return sign + "$" + (a / 1e6).toFixed(2) + "M";
  if (a >= 1000) return sign + "$" + (a / 1000).toFixed(a >= 10000 ? 1 : 2) + "K";
  if (a >= 1) return sign + "$" + a.toFixed(2);
  if (a >= 0.01) {
    // $0.40 was printing $0.4000 in the holding row.
    let text = a.toFixed(4).replace(/0+$/, "");
    const frac = text.split(".")[1] || "";
    if (frac.length < 2) text += "0".repeat(2 - frac.length);
    return sign + "$" + text;
  }
  if (!(a > 0)) return sign + "$0.00";
  // 5 leading zeros makes toPrecision return "0.00000100", which read as a zero string.
  const m = a.toFixed(18).match(/^0\.(0*)([1-9]\d{0,2})/);
  if (m && m[1].length >= 4) return sign + "$0.0" + String(m[1].length).replace(/\d/g, (d) => SUB[d]) + m[2];
  const raw = a.toPrecision(3);
  if (!/[eE]/.test(raw)) return sign + "$" + raw;
  // 7.37e-8 must not land in Net Vol. Subscript matches the price.
  const em = raw.match(/^(\d(?:\.\d+)?)[eE]([+-]?\d+)$/);
  const exp = em ? Number(em[2]) : NaN;
  const zeros = -exp - 1;
  if (em && zeros >= 2) {
    const digits = em[1].replace(".", "").slice(0, 3);
    return sign + "$0.0" + String(zeros).replace(/\d/g, (d) => SUB[d]) + digits;
  }
  return sign + "$" + a.toFixed(8).replace(/0+$/, "");
};
const qty = (n) => {
  if (!n) return "0";
  const a = Math.abs(n);
  if (a >= 999.995e9) return (n / 1e12).toFixed(2) + "T";
  if (a >= 999.995e6) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1000) return (n / 1000).toFixed(2) + "K";
  if (n >= 1) return n.toFixed(2);
  const t = n.toPrecision(3);
  if (!/[eE]/.test(t)) return t;
  const em = t.match(/^(\d(?:\.\d+)?)[eE]([+-]?\d+)$/);
  const zeros = em ? -Number(em[2]) - 1 : -1;
  if (em && zeros >= 2) {
    const digits = em[1].replace(".", "").slice(0, 3);
    return (n < 0 ? "-" : "") + "0.0" + String(zeros).replace(/\d/g, (d) => SUB[d]) + digits;
  }
  return Math.abs(n).toFixed(8).replace(/0+$/, "");
};
function tradeBal() {
  if (!state.wallet) return "—";
  return state.side === "buy" ? solText(state.sol) : qty(activePnl().amount);
}
const solText = (n) => {
  if (!n) return "0";
  return Number(n).toFixed(9).replace(/0+$/, "").replace(/\.$/, "");
};
const compactCount = (n) => {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 999.995e9) return (v / 1e12).toFixed(2) + "T";
  if (a >= 999.995e6) return (v / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(v >= 1e4 ? 1 : 2) + "K";
  return String(v);
};
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cls = (n) => (n >= 0 ? "up" : "down");
const signed = (n, d = 2) => (n >= 0 ? "+" : "") + Number(n).toFixed(d);
function clockLabel(d = new Date()) {
  const p = (n) => String(Math.abs(n)).padStart(2, "0");
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const hh = Math.floor(Math.abs(off) / 60);
  const mm = Math.abs(off) % 60;
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + " (UTC" + sign + hh + (mm ? ":" + p(mm) : "") + ")";
}
function statMoney(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const a = Math.abs(Number(n));
  if (a > 0 && a < 0.01) return (n < 0 ? "-" : "") + priceLabel(a);
  return usd(n);
}
const moveLabel = (pct) => {
  const n = Number(pct);
  if (pct == null || !Number.isFinite(n)) return "—";
  const mult = Math.abs(1 + n / 100);
  let digits = mult >= 10 ? 0 : mult >= 0.1 ? 2 : mult >= 0.01 ? 3 : 4;
  let text = mult === 0 ? "0" : mult.toFixed(digits);
  // A tiny drop must not read as a down arrow on a flat 1.00x.
  if (n !== 0 && /^1(?:\.0+)?$/.test(text)) {
    for (const d of [3, 4, 5, 6]) {
      text = mult.toFixed(d);
      if (!/^1(?:\.0+)?$/.test(text)) break;
    }
  }
  return (n >= 0 ? "▲ " : "▼ ") + text + "x (24h)";
};
const SUB = "₀₁₂₃₄₅₆₇₈₉";
function livePrice(t) {
  if (!t) return null;
  const live = Number(state.prices[t.id]);
  if (live > 0) return live;
  const p = Number(t.usdPrice);
  return p > 0 ? p : null;
}
function mcapText(t) {
  if (!t) return "—";
  const listed = Number(t.mcap);
  if (listed > 0) return usd(listed);
  const px = livePrice(t);
  const supply = Number(t.circSupply);
  if (px > 0 && supply > 0) return usd(supply * px);
  return "—";
}
const priceLabel = (n) => {
  const v = Number(n);
  if (!(v > 0)) return v === 0 ? "$0" : "—";
  if (v >= 0.01) return usd(v);
  const m = v.toFixed(18).match(/^0\.(0*)([1-9]\d{0,2})/);
  if (!m || m[1].length < 2) return usd(v);
  return "$0.0" + String(m[1].length).replace(/\d/g, (d) => SUB[d]) + m[2];
};
const raw = (ui, decimals) => Math.round(Number(ui) * 10 ** decimals).toString();
const ui = (amount, decimals) => Number(amount) / 10 ** decimals;


function entryKey(mint) { return "trench-entry:" + mint; }
function entryOf(mint) {
  const n = Number(localStorage.getItem(entryKey(mint)));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function holdBar(p) {
  if (!(p.amount > 0)) return { hold: "Holding —", pnl: "—", clsName: "" };
  if (!(p.entry > 0)) return { hold: "Holding " + usd(p.value), pnl: "—", clsName: "" };
  return { hold: "Holding " + usd(p.value), pnl: pnlText(p.d, p.p), clsName: cls(p.p) };
}
function feeHtml(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  return `<img class="fee-ico" alt="" width="12" height="12" src="${SOL_ICON}"><span>${esc(solAmt(n))}</span>`;
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
const MAIN_GAP_MS = 2150; // hard floor: <= 1 keyed request per 2 s (with jitter margin)
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
  const list = await datapi("https://datapi.jup.ag/v1/assets/search?query=" + encodeURIComponent(q));
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
  state.holdersLoading = true;
  state.holdersError = "";
  state.quote = null;
  state.samples = [hit.usdPrice];
  state.status = "Live · Jupiter";
  state.scrollTop = 0;
  render();
  heliusTrack(hit);
  state.tapeIds = new Set();
  streamSync();
  loadCandles().catch(() => {});
  loadTape(true).catch(() => {});
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

let candleBusy = false;
function resolvedTf() {
  if (state.tf !== "Auto") return TF_API[state.tf] ? state.tf : "1m";
  const created = state.active?.createdAt;
  const age = created ? (Date.now() - new Date(created).getTime()) / 1000 : 1e9;
  if (!Number.isFinite(age) || age < 0) return "1m";
  if (age < 1800) return "15s";
  if (age < 6 * 3600) return "1m";
  if (age < 2 * 86400) return "5m";
  if (age < 14 * 86400) return "15m";
  return "1h";
}
async function loadCandles() {
  const t = state.active;
  if (!t || candleBusy) return;
  // While the stream is live the current bar is built from ticks; re-sync with datapi every 5 s.
  if (state.candles.length && streamLive() && Date.now() - (loadCandles.at || 0) < 5000) return;
  loadCandles.at = Date.now();
  const tf = state.tf;
  const interval = TF_API[resolvedTf()] || "1_MINUTE";
  const to = new Date().toISOString();
  // First load: 300 candles. After that: just the last 3 (tiny payload) every second.
  const full = !state.candles.length;
  candleBusy = true;
  try {
    const data = await datapi(`https://datapi.jup.ag/v2/charts/${t.id}?interval=${interval}&to=${encodeURIComponent(to)}&candles=${full ? 300 : 3}`);
    if (state.active !== t || state.tf !== tf) return;
    const got = data.candles || [];
    if (full) state.candles = got;
    else {
      for (const c of got) {
        const i = state.candles.findIndex((x) => Number(x.time) === Number(c.time));
        if (i >= 0) state.candles[i] = c;
        else if (!state.candles.length || Number(c.time) > Number(state.candles[state.candles.length - 1].time)) state.candles.push(c);
      }
      if (state.candles.length > 600) state.candles.splice(0, state.candles.length - 600);
    }
    feedMark("candles");
    setChartData();
  } finally { candleBusy = false; }
}

function ageLabel(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.max(1, Math.floor(s)) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  return Math.floor(s / 3600) + "h";
}

async function loadTape(force = false) {
  const t = state.active;
  if (!t) return;
  if (!force && state.tape.length && streamLive()) return; // trades arrive over the stream
  const data = await datapi(`https://datapi.jup.ag/v1/txs/${t.id}?limit=40`);
  if (state.active !== t) return;
  state.tape = data.txs || [];
  state.tapeIds = new Set(state.tape.map((x) => x.txHash || x.actionId));
  feedMark("tradesPoll");
  const box = $("#tape");
  if (box) box.innerHTML = tapeRows();
  else if (state.tab === "tx") render();
}

async function loadHolders() {
  const t = state.active;
  if (!t) return;
  state.holdersLoading = true;
  state.holdersError = "";
  try {
    const data = await datapi(`https://datapi.jup.ag/v1/holders/${t.id}?limit=40`);
    if (state.active !== t) return;
    state.holders = data.holders || [];
  } catch (_) {
    if (state.active !== t) return;
    state.holdersError = "Couldn't load holders.";
  } finally {
    if (state.active === t) state.holdersLoading = false;
  }
  paintHolders();
}

let searchTimer = 0;
let searchSeq = 0;
function searchRows() {
  return (state.results || []).slice(0, 12).map((t) => `<button class="row" data-pick="${t.id}"><b>${esc(t.symbol)}</b> <span class="k">${esc(t.name || "")}</span> ${lpPullBadge(t)} <span>${usd(t.mcap)}</span></button>`).join("");
}
function searchResultHtml() {
  if (state.searching && !(state.results || []).length) return `<div class="k">Searching…</div>`;
  if (!(state.results || []).length) return `<div class="k">No tokens found.</div>`;
  return searchRows();
}
function paintResults() {
  const box = $("#results");
  if (!box) return;
  if ((state.searchQ || "").trim().length < 2) return;
  box.innerHTML = searchResultHtml();
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
  state.searchQ = q || "";
  if (state.searchQ.length < 2) {
    state.results = [];
    state.searching = false;
    paintScan();
    return;
  }
  state.results = [];
  state.searching = true;
  paintResults();
  searchTimer = setTimeout(async () => {
    try {
      const list = await datapi("https://datapi.jup.ag/v1/assets/search?query=" + encodeURIComponent(state.searchQ));
      if (seq !== searchSeq) return;
      state.results = Array.isArray(list) ? list : [];
      state.searching = false;
      rcWantFront((state.results || []).filter((t) => spotGate(t) === "checking").map((t) => t.id));
      paintResults();
    } catch (err) {
      if (seq !== searchSeq) return;
      state.searching = false;
      const box = $("#results");
      if (box) box.innerHTML = `<div class="k" style="padding:12px 0">${esc(err.message)}</div>`;
    }
  }, 450);
}

const MAJORS = new Set([
  SOL,
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"
]);
const SPOT_LISTS = [["trending", "Trending"], ["top", "Top"]];
function spotAlways(t) {
  if (!t?.id) return false;
  if (MAJORS.has(t.id) || t.isVerified) return true;
  return state.holdings.some((h) => h.mint === t.id);
}
function spotGate(t) {
  if (spotAlways(t)) return "allow";
  return alphaLiqState(t);
}
function lpPullBadge(t) {
  const g = spotGate(t);
  if (g === "allow" || alphaLiqOk(g)) return "";
  if (g === "checking") return `<i class="b wait">LP…</i>`;
  return `<span class="lp-pull">LP can be pulled</span>`;
}
function spotScanParts() {
  const gated = (state.spotScan.rows || []).map((t) => ({ t, g: spotGate(t) }));
  const checking = gated.filter((r) => r.g === "checking").length;
  const hidden = gated.filter((r) => r.g !== "allow" && !alphaLiqOk(r.g)).length;
  rcWantFront(gated.filter((r) => r.g === "checking").map((r) => r.t.id));
  return { list: gated.filter((r) => r.g === "allow" || alphaLiqOk(r.g)), hidden, checking };
}
function spotScanHtml() {
  const s = state.spotScan;
  const { list, hidden, checking } = spotScanParts();
  const note = `<div class="al-lpnote">Only coins whose liquidity can't be pulled · ${hidden} hidden (${checking} checking)</div>`;
  const chips = `<div class="chips scan-chips">${SPOT_LISTS.map(([k, l]) => `<button type="button" data-scan="${k}" class="${s.kind === k ? "on" : ""}">${l}</button>`).join("")}</div>`;
  const body = s.loading && !s.rows.length ? `<div class="k">Loading…</div>` : s.err && !s.rows.length ? `<div class="k">${esc(s.err)}</div>` : list.map(({ t, g }) => `<button class="row" data-pick="${t.id}" data-liq="${g}"><b>${esc(t.symbol)}</b> <span class="k">${esc(t.name || "")}</span> <span>${usd(t.mcap)}</span></button>`).join("");
  return chips + note + body;
}
function paintScan() {
  const box = $("#results");
  if (!box) return;
  // A typed query still has to refresh so RugCheck can replace the waiting badge.
  if ((state.searchQ || "").trim().length >= 2) { paintResults(); return; }
  box.innerHTML = spotScanHtml();
  box.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => pick(b.dataset.pick));
  box.querySelectorAll("[data-scan]").forEach((b) => b.onclick = () => {
    if (state.spotScan.kind === b.dataset.scan) return;
    state.spotScan.kind = b.dataset.scan;
    loadSpotScan().catch(() => {});
  });
}
let spotScanSeq = 0;
async function loadSpotScan() {
  const s = state.spotScan;
  const seq = ++spotScanSeq;
  s.loading = true;
  s.err = "";
  paintScan();
  try {
    const path = s.kind === "top" ? "toptraded" : "toptrending";
    const list = await jup("https://api.jup.ag/tokens/v2/" + path + "/1h");
    if (seq !== spotScanSeq) return;
    s.rows = Array.isArray(list) ? list : [];
  } catch (err) {
    if (seq !== spotScanSeq) return;
    s.err = err.message || String(err);
  } finally {
    if (seq === spotScanSeq) { s.loading = false; paintScan(); }
  }
}

async function pollPrices(force = false) {
  if (!force && streamPricesLive()) return; // prices arrive over the stream
  const t0 = performance.now();
  const ids = new Set([SOL]);
  if (state.active) ids.add(state.active.id);
  state.holdings.forEach((h) => ids.add(h.mint));
  const all = [...ids];
  // price/v3 takes up to 50 ids per call; one call covers everything on screen.
  for (let i = 0; i < all.length; i += 50) {
    const data = await jup(PRICE + "?ids=" + all.slice(i, i + 50).join(","));
    for (const [mint, row] of Object.entries(data || {})) {
      if (row?.usdPrice) notePrice(mint, row.usdPrice, row.blockId, "poll");
    }
  }
  if (state.active && state.prices[state.active.id]) {
    state.active.usdPrice = state.prices[state.active.id];
    state.active.mcap = (state.active.circSupply || 0) * state.active.usdPrice || state.active.mcap;
    state.samples.push(state.active.usdPrice);
    if (state.samples.length > 60) state.samples.shift();
  }
  feedMark("pricesPoll");
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
        for (const [m, r] of Object.entries(data || {})) if (r?.usdPrice) notePrice(m, r.usdPrice, r.blockId, "holdings");
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
  streamSync();
  await pollPrices(true).catch(() => {});
  render();
}

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), ms))]);
}

// ---- Wallets: Wallet Standard (Jupiter Mobile, Solflare, Backpack, Phantom…) + legacy injected ----
// Minimal @wallet-standard/app getWallets(): no bundler, same event protocol.
const WS_CHAIN = "solana:mainnet";
const stdWallets = [];
const stdApi = {
  register(...ws) {
    for (const w of ws) if (w && !stdWallets.includes(w)) stdWallets.push(w);
    walletsChanged();
    return () => { for (const w of ws) { const i = stdWallets.indexOf(w); if (i >= 0) stdWallets.splice(i, 1); } walletsChanged(); };
  },
  get() { return stdWallets.slice(); },
  on() { return () => {}; }
};
try {
  window.addEventListener("wallet-standard:register-wallet", (e) => { try { e.detail(stdApi); } catch (_) {} });
  const ready = new CustomEvent("wallet-standard:app-ready", { detail: stdApi });
  window.dispatchEvent(ready);
  // Legacy registration path: navigator.wallets was an array of callbacks.
  const legacy = window.navigator.wallets;
  if (Array.isArray(legacy)) {
    for (const cb of legacy.splice(0)) { try { cb(stdApi); } catch (_) {} }
    legacy.push = (...cbs) => { for (const cb of cbs) { try { cb(stdApi); } catch (_) {} } return 0; };
  }
} catch (_) {}
function walletsChanged() { if (document.getElementById("wallet-root")) paintWalletPicker(); }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58(bytes) {
  const d = [0];
  for (const byte of bytes) {
    let c = byte;
    for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; }
    while (c) { d.push(c % 58); c = (c / 58) | 0; }
  }
  let s = "";
  for (const byte of bytes) { if (byte) break; s += "1"; }
  for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
  return s;
}

// Every wallet becomes: { id, name, icon, connect(silent) -> address, signTransaction?(bytes) -> bytes,
// signAndSend?(bytes) -> signature, onChange(cb), disconnect() }
function stdAdapter(w) {
  const f = w.features || {};
  const acct = () => (w.accounts || []).find((a) => !a.chains || a.chains.includes(WS_CHAIN) || a.chains.some((c) => c.startsWith("solana:"))) || (w.accounts || [])[0];
  const signTx = f["solana:signTransaction"];
  const sas = f["solana:signAndSendTransaction"];
  return {
    id: "std:" + w.name, name: w.name, icon: w.icon, std: true,
    async connect(silent) {
      if (!acct()) {
        const c = f["standard:connect"];
        if (!c) throw new Error(w.name + " can't connect here.");
        await c.connect(silent ? { silent: true } : undefined);
      }
      const a = acct();
      return a ? a.address : null;
    },
    signTransaction: signTx ? async (bytes) => {
      const out = await signTx.signTransaction({ account: acct(), transaction: bytes, chain: WS_CHAIN });
      return out[0].signedTransaction;
    } : null,
    signMessage: f["solana:signMessage"] ? async (bytes) => {
      const out = await f["solana:signMessage"].signMessage({ account: acct(), message: bytes });
      const row = Array.isArray(out) ? out[0] : out;
      return row?.signature || row;
    } : null,
    signAndSend: sas ? async (bytes) => {
      const out = await sas.signAndSendTransaction({ account: acct(), transaction: bytes, chain: WS_CHAIN });
      return b58(out[0].signature);
    } : null,
    onChange(cb) { const ev = f["standard:events"]; return ev ? ev.on("change", (p) => { if (p && "accounts" in p) cb(acct()?.address || null); }) : null; },
    async disconnect() { try { await f["standard:disconnect"]?.disconnect(); } catch (_) {} }
  };
}
function legacyAdapter(p, name) {
  const key = (r) => (r?.publicKey || p.publicKey)?.toString() || null;
  return {
    id: "legacy:" + name, name, icon: p.icon || null, std: false,
    async connect(silent) { return key(await p.connect(silent ? { onlyIfTrusted: true } : undefined)); },
    signTransaction: p.signTransaction ? async (bytes) => {
      const signed = await p.signTransaction(solanaWeb3.VersionedTransaction.deserialize(bytes));
      return signed.serialize();
    } : null,
    signMessage: p.signMessage ? async (bytes) => {
      const r = await p.signMessage(bytes, "utf8");
      return r?.signature || r;
    } : null,
    signAndSend: p.signAndSendTransaction ? async (bytes) => {
      const r = await p.signAndSendTransaction(solanaWeb3.VersionedTransaction.deserialize(bytes));
      return r?.signature || r;
    } : null,
    onChange(cb) {
      if (!p.on) return null;
      p._trenchCb = cb; // one listener per provider, always pointing at the latest connection
      if (!p._trenchBound) {
        p._trenchBound = true;
        p.on("accountChanged", (pk) => p._trenchCb?.(pk ? pk.toString() : null));
        p.on("disconnect", () => p._trenchCb?.(null));
      }
      return () => { if (p._trenchCb === cb) p._trenchCb = null; };
    },
    async disconnect() { try { await p.disconnect?.(); } catch (_) {} }
  };
}
function legacyName(p) {
  return p.isPhantom ? "Phantom" : p.isSolflare ? "Solflare" : p.isBackpack ? "Backpack" : p.isJupiter ? "Jupiter" : p.isGlow ? "Glow" : "Browser wallet";
}
function walletList() {
  const out = [];
  const seen = new Set();
  for (const w of stdWallets) {
    const f = w.features || {};
    const solana = (w.chains || []).some((c) => c.startsWith("solana:"));
    if (!solana || !f["standard:connect"] || !(f["solana:signTransaction"] || f["solana:signAndSendTransaction"])) continue;
    if (seen.has(w.name.toLowerCase())) continue;
    seen.add(w.name.toLowerCase());
    out.push(stdAdapter(w));
  }
  const W = window;
  const legacy = [];
  if (W.phantom?.solana) legacy.push(W.phantom.solana);
  if (W.solflare) legacy.push(W.solflare);
  if (W.backpack?.solana || W.backpack) legacy.push(W.backpack?.solana || W.backpack);
  if (W.jupiter?.solana || W.jupiter) legacy.push(W.jupiter?.solana || W.jupiter);
  if (W.solana && !legacy.includes(W.solana)) legacy.push(W.solana);
  for (const p of legacy) {
    if (!p || typeof p.connect !== "function" || !(p.signTransaction || p.signAndSendTransaction)) continue;
    const n = legacyName(p);
    // Phantom/Solflare/Backpack also register as Wallet Standard: prefer that one.
    if (seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(legacyAdapter(p, n));
  }
  return out;
}
async function waitForWallets(ms) {
  const end = Date.now() + ms;
  while (!walletList().length && Date.now() < end) await sleep(50);
  return walletList();
}

function isMobile() { return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent); }
function phantomLink() {
  return "https://phantom.app/ul/browse/" + encodeURIComponent(location.href) + "?ref=" + encodeURIComponent(location.origin);
}

const WALLET_PREF = "trench-wallet";
async function connect(silent = false) {
  const list = await waitForWallets(silent ? 800 : 300);
  if (silent) {
    // Reconnect quietly: last used wallet, or the only one injected (in-app browsers).
    const pref = localStorage.getItem(WALLET_PREF);
    const w = list.find((x) => x.id === pref) || (list.length === 1 ? list[0] : null);
    if (w) return useWallet(w, true);
    return;
  }
  if (list.length === 1) return useWallet(list[0], false);
  openWalletPicker();
}

async function useWallet(w, silent) {
  try {
    const addr = await w.connect(silent);
    if (!addr) return;
    closeWalletPicker();
    state.provider = w;
    state.wallet = addr;
    localStorage.setItem(WALLET_PREF, w.id);
    state.status = w.name + " " + addr.slice(0, 4) + "…" + addr.slice(-4);
    if (state.walletOff) state.walletOff();
    state.walletOff = w.onChange((a) => {
      if (state.provider?.id !== w.id || a === state.wallet) return;
      state.wallet = a;
      state.holdings = [];
      state.sol = 0;
      if (!a) state.provider = null;
      if (a) loadHoldings().catch(() => {});
      streamSync();
      render();
      scheduleQuote(0);
    }) || null;
    render();
    streamSync();
    await loadHoldings().catch((err) => { state.status = "Balance load failed: " + err.message; });
    scheduleQuote(0);
  } catch (err) {
    if (!silent) { state.toast = err.message || "Wallet connection rejected"; render(); }
  }
}

async function disconnectWallet() {
  const w = state.provider;
  if (state.walletOff) { try { state.walletOff(); } catch (_) {} state.walletOff = null; }
  state.provider = null; state.wallet = null; state.holdings = []; state.sol = 0;
  localStorage.removeItem(WALLET_PREF);
  closeWalletPicker();
  if (w) await w.disconnect();
  streamSync(); render(); scheduleQuote(0);
}

function walletPickerHtml() {
  const list = walletList();
  const icon = (w) => w.icon && /^data:image\/|^https:\/\//.test(w.icon) ? `<img src="${esc(w.icon)}" alt="">` : `<span class="wp-dot">${esc(w.name[0] || "?")}</span>`;
  const rows = list.map((w, i) => `<button type="button" class="wp-row" data-wp="${i}">${icon(w)}<span>${esc(w.name)}</span>${state.provider?.id === w.id ? `<small>connected</small>` : ""}</button>`).join("");
  const none = `<div class="k" style="padding:6px 0 12px">No Solana wallet found in this browser.</div>
    ${isMobile() ? `<a class="go buy wp-link" href="${esc(phantomLink())}">Open in Phantom</a>
      <div class="k" style="padding:10px 0 0">Jupiter Mobile: open the app, tap the globe icon (top right) and enter this page's address.</div>`
    : `<div class="k">Install Jupiter Wallet, Phantom, Solflare or Backpack, then reload.</div>`}`;
  return `<div class="sheet-backdrop" data-wp-close></div>
  <div class="sheet" role="dialog" aria-modal="true" aria-labelledby="wp-title">
    <div class="sheet-head"><div class="grab"></div><h2 id="wp-title">Connect wallet</h2>
      <button type="button" class="sheet-x" data-wp-close aria-label="Close">✕</button></div>
    <div class="sheet-body" id="wp-body">${list.length ? rows : none}
      ${state.wallet ? `<button type="button" class="go sell sheet-close-btn" data-wp-disconnect>Disconnect</button>` : ""}</div>
  </div>`;
}
function paintWalletPicker() {
  const root = document.getElementById("wallet-root");
  if (root) root.innerHTML = walletPickerHtml();
}
function openWalletPicker() {
  if (document.getElementById("wallet-root")) return paintWalletPicker();
  const root = document.createElement("div");
  root.id = "wallet-root";
  root.className = "sheet-root open";
  root.innerHTML = walletPickerHtml();
  document.body.appendChild(root);
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-wp-close]")) return closeWalletPicker();
    if (e.target.closest("[data-wp-disconnect]")) return disconnectWallet();
    const r = e.target.closest("[data-wp]");
    if (r) { const w = walletList()[Number(r.dataset.wp)]; if (w) useWallet(w, false); }
  });
}
function closeWalletPicker() { document.getElementById("wallet-root")?.remove(); }
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeWalletPicker(); });

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
    // Buying SOL with SOL is not an order. Don't send it and surface the raw API error.
    if (t.id === SOL) return null;
    return { inputMint: SOL, outputMint: t.id, amount: raw(n, 9) };
  }
  const held = state.holdings.find((h) => h.mint === t.id);
  if (!held) return null;
  const pct = Math.min(100, Math.max(0, Number(state.sellPct) || 0));
  // Use integer base units so 100% sells exactly the balance.
  const amount = pct >= 100 ? String(held.amount) : String(Math.floor(held.amount * pct / 100));
  if (amount === "0" || t.id === SOL) return null;
  return { inputMint: t.id, outputMint: SOL, amount };
}

// Jupiter Trigger v2 (api.jup.ag/trigger/v2). Stop and trailing orders live on Jupiter's
// keeper, so they keep working after this tab closes. Market + SL is a Swap API buy, then a
// single below-stop on the tokens received. Trailing Stop is a single order with trailingBps.
const TRIGGER = "https://api.jup.ag/trigger/v2";
const ORDER_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SL_SLIPPAGE = 2000;
const triggerAuth = { access: "", refresh: "", exp: 0, wallet: "" };

function loadOrderPrefs() {
  try {
    const t = localStorage.getItem("trench-order-type");
    if (t === "market" || t === "msl" || t === "trail") state.orderType = t;
    const pct = Number(localStorage.getItem("trench-sl-pct"));
    if (pct > 0 && pct < 100) state.slPct = pct;
    const mode = localStorage.getItem("trench-sl-mode");
    if (mode === "pct" || mode === "price") state.slMode = mode;
    const sp = localStorage.getItem("trench-sl-price");
    if (sp) state.slPrice = sp;
    const tr = Number(localStorage.getItem("trench-trail-pct"));
    if (tr >= 0.5 && tr <= 90) state.trailPct = tr;
    const stops = JSON.parse(localStorage.getItem("trench-stops") || "[]");
    if (Array.isArray(stops)) state.stops = stops.filter((s) => s && s.id && s.mint).slice(0, 20);
  } catch (_) {}
}
function saveOrderPrefs() {
  try {
    localStorage.setItem("trench-order-type", state.orderType);
    localStorage.setItem("trench-sl-pct", String(state.slPct));
    localStorage.setItem("trench-sl-mode", state.slMode);
    localStorage.setItem("trench-sl-price", String(state.slPrice || ""));
    localStorage.setItem("trench-trail-pct", String(state.trailPct));
    localStorage.setItem("trench-stops", JSON.stringify(state.stops.slice(0, 20)));
  } catch (_) {}
}
loadOrderPrefs();

function roundPx(n) {
  const v = Number(n);
  if (!(v > 0)) return 0;
  if (v >= 1) return Math.round(v * 1e8) / 1e8;
  return Number(v.toPrecision(8));
}
function stopFromEntry(entry, mode, pct, price) {
  const e = Number(entry);
  if (!(e > 0)) return { ok: false, reason: "No price yet" };
  if (mode === "price") {
    const p = Number(price);
    if (!(p > 0)) return { ok: false, reason: "Enter a stop price" };
    if (p >= e) return { ok: false, reason: "Stop must be below the price" };
    return { ok: true, stop: p, pct: (1 - p / e) * 100 };
  }
  const n = Number(pct);
  if (!(n > 0) || n >= 100) return { ok: false, reason: "Stop % must be between 0 and 100" };
  return { ok: true, stop: e * (1 - n / 100), pct: n };
}
function trailFromHigh(high, pct) {
  const h = Number(high);
  const n = Number(pct);
  if (!(h > 0)) return { ok: false, reason: "No price yet" };
  if (!(n >= 0.5) || n > 90) return { ok: false, reason: "Trail must be 0.5% to 90%" };
  const bps = Math.round(n * 100);
  if (bps < 50 || bps > 9000) return { ok: false, reason: "Trail must be 0.5% to 90%" };
  return { ok: true, high: h, trigger: h * (1 - n / 100), bps, pct: n };
}
function orderRefPrice() {
  const t = state.active;
  if (!t) return 0;
  const px = Number(state.prices[t.id] || t.usdPrice || 0);
  if (state.side === "buy") return px;
  const saved = Number(localStorage.getItem(entryKey(t.id)));
  return saved > 0 ? saved : px;
}
function armTrailHigh(reset) {
  const t = state.active;
  if (!t) return 0;
  const px = Number(state.prices[t.id] || t.usdPrice || 0);
  if (reset && px > 0) { state.trailMark[t.id] = px; return px; }
  const prev = Number(state.trailMark[t.id]) || 0;
  if (px > prev) state.trailMark[t.id] = px;
  else if (!(prev > 0) && px > 0) state.trailMark[t.id] = px;
  return Number(state.trailMark[t.id]) || px;
}
function openTrail() {
  const t = state.active;
  if (!t) return null;
  return state.stops.find((s) => s.mint === t.id && s.kind === "trail") || null;
}
function trailDisplay() {
  const open = openTrail();
  const live = open && state.stopLive[open.id];
  if (live && Number(live.high) > 0 && Number(live.trigger) > 0) {
    return { ok: true, high: Number(live.high), trigger: Number(live.trigger), source: "jupiter", bps: live.trailingBps, line: "High " + priceLabel(live.high) + " · trigger " + priceLabel(live.trigger) };
  }
  const tr = trailFromHigh(armTrailHigh(false), state.trailPct);
  if (!tr.ok) return { ok: false, line: tr.reason, reason: tr.reason };
  return { ...tr, source: "local", line: "High " + priceLabel(tr.high) + " · trigger " + priceLabel(tr.trigger) };
}
function stopDisplay() {
  const entry = orderRefPrice();
  const sl = stopFromEntry(entry, state.slMode, state.slPct, state.slPrice);
  if (!sl.ok) return { ok: false, line: sl.reason, reason: sl.reason, entry };
  return { ...sl, entry, line: "Stop " + priceLabel(sl.stop) + " (−" + sl.pct.toFixed(1) + "% from " + priceLabel(entry) + ")" };
}
function orderPreview() {
  if (state.orderType === "msl") return { kind: "stop", ...stopDisplay() };
  if (state.orderType === "trail") return { kind: "trail", ...trailDisplay() };
  return { ok: true, kind: "market", line: "" };
}
function buildStopBody({ mint, amount, wallet, stop, now }) {
  const exp = (now || Date.now()) + ORDER_TTL_MS;
  const amt = String(amount);
  return {
    craft: { inputMint: mint, outputMint: SOL, userAddress: wallet, amount: amt, orderType: "price", orderSubType: "single" },
    create: {
      orderType: "single", userPubkey: wallet, inputMint: mint, outputMint: SOL, inputAmount: amt,
      triggerMint: mint, triggerCondition: "below", triggerPriceUsd: roundPx(stop),
      slippageBps: SL_SLIPPAGE, expiresAt: exp
    }
  };
}
function buildTrailBody({ mint, amount, wallet, bps, now }) {
  const exp = (now || Date.now()) + ORDER_TTL_MS;
  const amt = String(amount);
  return {
    craft: { inputMint: mint, outputMint: SOL, userAddress: wallet, amount: amt, orderType: "price", orderSubType: "single" },
    create: {
      orderType: "single", userPubkey: wallet, inputMint: mint, outputMint: SOL, inputAmount: amt,
      triggerMint: mint, triggerCondition: "below", trailingBps: bps,
      slippageBps: SL_SLIPPAGE, expiresAt: exp
    }
  };
}
function protectRaw() {
  const t = state.active;
  if (!t) return "";
  if (state.side === "sell") {
    const p = orderParams();
    return p ? String(p.amount) : "";
  }
  return state.quote?.outAmount ? String(state.quote.outAmount) : "";
}
function buildTriggerOrder(extra = {}) {
  const t = state.active;
  if (!t) return { ok: false, reason: "No token" };
  const wallet = extra.userPubkey || state.wallet || "WALLET";
  const amount = extra.amount != null ? String(extra.amount) : protectRaw();
  if (state.orderType === "msl" || extra.kind === "stop") {
    const entry = extra.entry != null ? Number(extra.entry) : orderRefPrice();
    const sl = stopFromEntry(entry, extra.slMode || state.slMode, extra.slPct != null ? extra.slPct : state.slPct, extra.slPrice != null ? extra.slPrice : state.slPrice);
    if (!sl.ok) return sl;
    const body = buildStopBody({ mint: t.id, amount: amount || "0", wallet, stop: sl.stop, now: extra.now });
    return { ok: true, kind: "stop", ...body, stop: sl.stop, pct: sl.pct, entry, line: "Stop " + priceLabel(sl.stop) + " (−" + sl.pct.toFixed(1) + "%)" };
  }
  if (state.orderType === "trail" || extra.kind === "trail") {
    const high = extra.high != null ? Number(extra.high) : armTrailHigh(false);
    const tr = trailFromHigh(high, extra.trailPct != null ? extra.trailPct : state.trailPct);
    if (!tr.ok) return tr;
    const body = buildTrailBody({ mint: t.id, amount: amount || "0", wallet, bps: tr.bps, now: extra.now });
    return { ok: true, kind: "trail", ...body, high: tr.high, trigger: tr.trigger, bps: tr.bps, line: "High " + priceLabel(tr.high) + " · trigger " + priceLabel(tr.trigger) };
  }
  return { ok: false, reason: "Market order" };
}
function orderMathOk() {
  const a = stopFromEntry(100, "pct", 10, "");
  const b = stopFromEntry(100, "price", 10, 80);
  const c = stopFromEntry(100, "price", 10, 100);
  const d = trailFromHigh(50, 10);
  const e = trailFromHigh(50, 0.4);
  const f = buildStopBody({ mint: "MINT", amount: "5", wallet: "W", stop: 90, now: 1000 });
  const g = buildTrailBody({ mint: "MINT", amount: "5", wallet: "W", bps: 1000, now: 1000 });
  const ttl = 1000 + ORDER_TTL_MS;
  const ok = a.ok && a.stop === 90 && b.ok && b.stop === 80 && !c.ok
    && d.ok && d.trigger === 45 && d.bps === 1000 && !e.ok
    && f.create.triggerCondition === "below" && f.create.triggerPriceUsd === 90 && !("trailingBps" in f.create)
    && f.create.triggerMint === "MINT" && f.craft.orderSubType === "single" && f.create.expiresAt === ttl
    && g.create.trailingBps === 1000 && !("triggerPriceUsd" in g.create)
    && g.create.triggerMint === g.create.inputMint && g.create.triggerCondition === "below";
  return { ok, a, b, c, d, e };
}
function orderTypeLabel() {
  return state.orderType === "msl" ? "Mkt + SL" : state.orderType === "trail" ? "Trail" : "Market";
}
function goLabel() {
  if (!state.wallet) return "Connect";
  if (state.busy) return "…";
  if (state.orderType === "msl") return state.side === "buy" ? "Buy + SL" : "Set stop";
  if (state.orderType === "trail") return state.side === "buy" ? "Buy + trail" : "Set trail";
  return state.side === "buy" ? "Buy" : "Sell";
}
function orderMenu() {
  if (!state.marketOpen) return "";
  const opt = (id, label) => `<button type="button" data-otype="${id}" class="${state.orderType === id ? "on" : ""}">${label}</button>`;
  return `<div class="market-menu">${opt("market", "Market")}${opt("msl", "Market + SL")}${opt("trail", "Trailing Stop")}</div>`;
}
function placeOrderMenu() {
  const menu = document.querySelector(".market-menu");
  const btn = document.getElementById("market");
  if (!menu || !btn) return;
  // The menu is position:fixed. Do not float it over the search sheet.
  if (state.searchOpen || document.getElementById("search-sheet")) { menu.remove(); return; }
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 148;
  const h = menu.offsetHeight || 112;
  const host = document.querySelector(".lwc-host");
  const axisBottom = host ? host.getBoundingClientRect().bottom : 0;
  const est = document.getElementById("est");
  const ultra = document.querySelector(".trade .ultra, .ultra");
  const quote = est ? est.getBoundingClientRect() : null;
  const floorEl = ultra && ultra.getBoundingClientRect().height > 2 ? ultra : est;
  const floor = floorEl ? floorEl.getBoundingClientRect() : null;
  let left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
  const hitsQuote = (top) => floor && floor.width > 2
    && top < floor.bottom - 2 && top + h > (quote ? quote.top : floor.top) + 2
    && left + w > floor.left + 4 && left < floor.right - 4;
  // Prefer above the button, and above the time axis, so Est. Received stays readable.
  let top = r.top - h - 8;
  if (host && axisBottom > 40 && r.top > axisBottom && top + h > axisBottom - 18) top = axisBottom - h - 18;
  if (top < 8 || hitsQuote(top)) {
    const under = floor && floor.bottom > 8 ? floor.bottom + 6 : r.bottom + 6;
    top = under + h <= window.innerHeight - 4 ? under : Math.max(8, window.innerHeight - h - 8);
  }
  menu.style.left = left + "px";
  menu.style.top = top + "px";
}
function orderFields() {
  if (state.orderType === "market") return "";
  const p = orderPreview();
  const stops = state.stops.filter((s) => state.active && s.mint === state.active.id).map((s) =>
    `<div class="stop-row"><span>${esc(s.symbol || "")} ${s.kind === "trail" ? "trail" : "stop"}</span><span class="live-stop">${esc(s.line || "")}</span><button type="button" data-cancel-stop="${esc(s.id)}">Cancel</button></div>`).join("");
  if (state.orderType === "msl") {
    const chips = [5, 10, 25].map((n) => `<button type="button" data-slpct="${n}" class="${state.slMode !== "price" && Number(state.slPct) === n ? "on" : ""}">${n}%</button>`).join("");
    return `<div class="otype" id="otype">
      <div class="otype-row">
        <span class="mini-seg"><button type="button" data-slmode="pct" class="${state.slMode !== "price" ? "on" : ""}">%</button><button type="button" data-slmode="price" class="${state.slMode === "price" ? "on" : ""}">Price</button></span>
        <input id="sl-in" inputmode="decimal" value="${esc(state.slMode === "price" ? state.slPrice : state.slPct)}" aria-label="${state.slMode === "price" ? "Stop price" : "Stop percent"}">
        ${state.slMode === "price" ? "" : `<span class="otype-chips">${chips}</span>`}
      </div>
      <div class="live-stop${p.ok ? "" : " down"}" id="sl-live">${esc(p.line)}</div>
      <div class="note">Jupiter Trigger stop · sells if price falls there · tab can close</div>
      ${stops}
    </div>`;
  }
  const chips = [5, 10, 25].map((n) => `<button type="button" data-trail="${n}" class="${Number(state.trailPct) === n ? "on" : ""}">${n}%</button>`).join("");
  return `<div class="otype" id="otype">
    <div class="otype-row"><span>Trail %</span><input id="trail-in" inputmode="decimal" value="${esc(state.trailPct)}" aria-label="Trail percent"><span class="otype-chips">${chips}</span></div>
    <div class="live-stop${p.ok ? "" : " down"}" id="trail-live">${esc(p.line)}</div>
    <div class="note">Jupiter Trigger trail · sells ${esc(state.trailPct)}% under the high · tab can close</div>
    ${stops}
  </div>`;
}
function paintOrderPreview() {
  const p = orderPreview();
  const el = document.getElementById("sl-live") || document.getElementById("trail-live");
  if (!el) return;
  el.textContent = p.line;
  el.classList.toggle("down", !p.ok);
}
function asSig58(sig) {
  if (!sig) throw new Error("Wallet did not sign.");
  if (typeof sig === "string") return sig;
  const bytes = sig instanceof Uint8Array ? sig : (sig.signature instanceof Uint8Array ? sig.signature : null);
  if (!bytes) throw new Error("Wallet did not sign.");
  return b58(bytes);
}
function saveAuth(r) {
  triggerAuth.access = r.accessToken || r.token || "";
  if (r.refreshToken) triggerAuth.refresh = r.refreshToken;
  triggerAuth.exp = r.expiresAt ? Date.parse(r.expiresAt) : Date.now() + 14 * 60 * 1000;
  triggerAuth.wallet = state.wallet || "";
  if (!triggerAuth.access) throw new Error(r.error || r.message || "Jupiter did not return a session.");
}
async function triggerToken() {
  if (triggerAuth.wallet && triggerAuth.wallet !== state.wallet) {
    triggerAuth.access = ""; triggerAuth.refresh = ""; triggerAuth.exp = 0;
  }
  triggerAuth.wallet = state.wallet || "";
  if (triggerAuth.access && triggerAuth.exp - Date.now() > 60000) return triggerAuth.access;
  if (triggerAuth.refresh) {
    try {
      const r = await jup(TRIGGER + "/auth/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: triggerAuth.refresh })
      });
      saveAuth(r);
      return triggerAuth.access;
    } catch (_) { triggerAuth.refresh = ""; triggerAuth.access = ""; }
  }
  const w = state.provider;
  if (!w) throw new Error("Connect a wallet first.");
  if (w.signMessage) {
    const ch = await jup(TRIGGER + "/auth/challenge", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletPubkey: state.wallet, type: "message" })
    });
    const sig = await w.signMessage(new TextEncoder().encode(ch.challenge));
    const verified = await jup(TRIGGER + "/auth/verify", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "message", walletPubkey: state.wallet, signature: asSig58(sig), authMode: "access_refresh" })
    });
    saveAuth(verified);
    return triggerAuth.access;
  }
  if (!w.signTransaction) throw new Error("This wallet can't sign a Jupiter stop.");
  const ch = await jup(TRIGGER + "/auth/challenge", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletPubkey: state.wallet, type: "transaction" })
  });
  const signed = await w.signTransaction(b64ToBytes(ch.transaction));
  const verified = await jup(TRIGGER + "/auth/verify", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "transaction", walletPubkey: state.wallet, signedTransaction: bytesToB64(signed), authMode: "access_refresh" })
  });
  saveAuth(verified);
  return triggerAuth.access;
}
async function ensureVault(headers) {
  try { return await jup(TRIGGER + "/vault", { headers }); }
  catch (err) {
    try { return await jup(TRIGGER + "/vault/register", { headers }); }
    catch (e2) {
      if (/409|already/i.test(e2.message || "")) return jup(TRIGGER + "/vault", { headers });
      throw e2;
    }
  }
}
function rememberOrder(created, built) {
  state.stops = [{ id: created.id, kind: built.kind, mint: state.active.id, symbol: state.active.symbol, line: built.line }].concat(state.stops.filter((s) => s.id !== created.id)).slice(0, 20);
  saveOrderPrefs();
}
async function submitTrigger(built) {
  if (!built.ok) throw new Error(built.reason || "Can't build that stop.");
  if (!built.create.inputAmount || built.create.inputAmount === "0") throw new Error("No tokens to protect.");
  const token = await triggerToken();
  const headers = { "content-type": "application/json", Authorization: "Bearer " + token };
  await ensureVault(headers);
  state.status = "Confirm the deposit in your wallet…";
  paintLive();
  const deposit = await jup(TRIGGER + "/deposit/craft", { method: "POST", headers, body: JSON.stringify(built.craft) });
  if (!deposit.requestId || !deposit.transaction) throw new Error(deposit.error || deposit.message || "Jupiter did not return a deposit.");
  const signed = await state.provider.signTransaction(b64ToBytes(deposit.transaction));
  const createBody = { ...built.create, depositRequestId: deposit.requestId, depositSignedTx: bytesToB64(signed) };
  if (built.kind === "trail") delete createBody.triggerPriceUsd;
  state.status = "Placing stop…";
  paintLive();
  const created = await jup(TRIGGER + "/orders/price", { method: "POST", headers, body: JSON.stringify(createBody) });
  if (!created.id) throw new Error(created.error || created.message || "Stop was not created.");
  rememberOrder(created, built);
  if (built.kind === "trail") {
    const px = Number(state.prices[state.active.id] || state.active.usdPrice || built.high || 0);
    if (px > 0) state.trailMark[state.active.id] = px;
    state.stopLive[created.id] = { high: px, trigger: px * (1 - built.bps / 10000), trailingBps: built.bps };
  }
  return created;
}
function amountUsd(rawAmt, decimals, price) {
  const n = Number(rawAmt);
  if (!(n > 0) || !(price > 0)) return 0;
  return n / 10 ** (decimals || 0) * price;
}
async function refreshStopLive() {
  if (!triggerAuth.access || !state.stops.length || triggerAuth.exp - Date.now() < 5000) return;
  try {
    const hist = await jup(TRIGGER + "/orders/history?state=active&limit=20", { headers: { Authorization: "Bearer " + triggerAuth.access } });
    for (const o of hist.orders || []) {
      if (o.highWatermark || o.triggerPriceUsd) {
        state.stopLive[o.id] = { high: Number(o.highWatermark) || state.stopLive[o.id]?.high || 0, trigger: Number(o.triggerPriceUsd) || 0, trailingBps: o.trailingBps };
      }
    }
    paintOrderPreview();
  } catch (_) {}
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
  if (!params) {
    state.quote = null;
    if (state.active?.id === SOL) state.status = "SOL is the pay token";
    paintLive();
    return null;
  }
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

async function confirmSig(sig) {
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    try {
      const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSignatureStatuses", params: [[sig], { searchTransactionHistory: false }] }) }).then((x) => x.json());
      const st = r?.result?.value?.[0];
      if (st?.err) return { status: "Failed", error: "Transaction failed on-chain", signature: sig };
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) return { status: "Success", signature: sig };
    } catch (_) {}
  }
  return { status: "Failed", error: "Not confirmed yet, check your wallet", signature: sig };
}

async function heliusSendSigned(signed) {
  if (!HKEY || !signed) return null;
  let tx;
  try { tx = solanaWeb3.VersionedTransaction.deserialize(signed); }
  catch (_) { return null; }
  const need = tx.message.header.numRequiredSignatures;
  const have = tx.signatures.filter((s) => s.some((b) => b)).length;
  if (have < need) return null; // Jupiter still has to co-sign; /execute is the only path
  const sig = await helRpc("sendTransaction", [bytesToB64(signed), { encoding: "base64", skipPreflight: true, maxRetries: 0 }]);
  if (!sig || typeof sig !== "string") throw new Error("Helius send returned no signature");
  return confirmSig(sig);
}

async function sendMarket() {
  const w = state.provider;
  if (!w?.signTransaction && !w?.signAndSend) throw new Error("This wallet can't sign transactions here.");
  // Orders are single-use and expire fast, so always take a fresh one for the click.
  clearTimeout(quoteTimer);
  const order = await refreshQuote();
  if (!order?.transaction) throw new Error(order?.errorMessage || order?.error || "Jupiter did not return a transaction.");
  state.status = "Confirm in your wallet…";
  paintLive();
  const unsigned = b64ToBytes(order.transaction);
  let done;
  if (w.signTransaction) {
    // signTransaction (not signAndSend): JupiterZ/gasless routes need Jupiter to add
    // its signature at /execute, so the wallet must not broadcast it itself.
    const signed = await w.signTransaction(unsigned);
    state.status = "Sending…";
    paintLive();
    done = null;
    if (HKEY) {
      try { done = await heliusSendSigned(signed); }
      catch (_) { done = null; }
    }
    if (!done) {
      done = await jup(SWAP + "/execute", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signedTransaction: bytesToB64(signed), requestId: order.requestId })
      });
    }
  } else {
    // Wallet only offers signAndSend: OK unless Jupiter must co-sign (gasless/RFQ).
    const need = solanaWeb3.VersionedTransaction.deserialize(unsigned).message.header.numRequiredSignatures;
    if (need > 1) throw new Error(w.name + " can only sign-and-send; this route needs Jupiter to co-sign. Try another wallet or a larger amount.");
    const sig = await w.signAndSend(unsigned);
    state.status = "Sent · confirming…";
    paintLive();
    done = await confirmSig(sig);
  }
  if (done.status !== "Success") throw new Error((done.error || "Swap failed") + (done.code != null ? " (code " + done.code + ")" : ""));
  return { done, outAmount: order.outAmount ? String(order.outAmount) : "" };
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
    const { done } = await sendMarket();
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

async function boughtRaw(before, quoted) {
  for (let i = 0; i < 3; i++) {
    await loadHoldings().catch(() => {});
    const now = Number(state.holdings.find((h) => h.mint === state.active?.id)?.amount) || 0;
    if (now > before) return String(Math.floor(now - before));
    await sleep(700);
  }
  return quoted || "";
}

async function placeProtect() {
  if (window.__orderDry) {
    const built = buildTriggerOrder();
    state.lastBuilt = built;
    window.__orderLast = built && built.create ? { kind: built.kind, bps: built.create.trailingBps || 0, hasPrice: "triggerPriceUsd" in built.create, hasSigned: !!built.create.depositSignedTx } : { kind: "", bps: 0, hasSigned: false };
    state.status = built.ok ? ("Built " + built.kind + " · not sent") : (built.reason || "Can't build");
    state.toast = state.status;
    render();
    return;
  }
  if (!state.wallet) return connect();
  if (state.busy) return;
  const t = state.active;
  if (!t) return;
  const preview = orderPreview();
  if (!preview.ok) { state.toast = preview.reason || preview.line; state.status = state.toast; render(); return; }
  state.busy = true;
  const side = state.side;
  state.status = side === "buy" ? "Getting order…" : "Building stop…";
  render();
  let bought = false;
  try {
    let amount = "";
    let entry = orderRefPrice();
    if (side === "buy") {
      if (!state.quote) await refreshQuote().catch(() => {});
      const est = Number(state.quote?.outUsdValue);
      const px = Number(state.prices[t.id] || t.usdPrice || 0);
      const usdEst = Number.isFinite(est) && est > 0 ? est : amountUsd(state.quote?.outAmount, t.decimals || 6, px) || Number(state.amount) * (state.prices[SOL] || 0);
      if (usdEst && usdEst < 10) throw new Error("Jupiter stops need at least $10. This buy is about " + usd(usdEst) + ".");
      const before = Number(state.holdings.find((h) => h.mint === t.id)?.amount) || 0;
      const fill = await sendMarket();
      bought = true;
      entry = Number(state.prices[t.id] || t.usdPrice || entry);
      if (entry) localStorage.setItem(entryKey(t.id), String(entry));
      amount = await boughtRaw(before, fill.outAmount);
    } else {
      const params = orderParams();
      if (!params) throw new Error("No balance to protect.");
      amount = params.amount;
      const px = Number(state.prices[t.id] || t.usdPrice || 0);
      const usdEst = amountUsd(amount, t.decimals || 6, px);
      if (usdEst && usdEst < 10) throw new Error("Jupiter stops need at least $10. This is about " + usd(usdEst) + ".");
    }
    const built = buildTriggerOrder({ amount, entry, userPubkey: state.wallet });
    if (!built.ok) throw new Error(built.reason || "Can't build that stop.");
    await submitTrigger(built);
    state.toast = built.kind === "trail"
      ? "Trailing stop set · Jupiter keeps it with the tab closed"
      : "Stop set at " + priceLabel(built.stop) + " · tab can close";
    state.status = state.toast;
  } catch (err) {
    const msg = err.message || String(err);
    state.status = bought ? ("Bought, stop not set: " + msg) : msg;
    state.toast = state.status;
  } finally {
    state.busy = false;
    render();
    scheduleQuote(QUOTE_EVERY_MS);
  }
}

async function cancelStop(id) {
  if (!id || state.busy) return;
  if (window.__orderDry) { state.toast = "Cancel not sent"; render(); return; }
  state.busy = true;
  state.status = "Cancelling…";
  render();
  try {
    const token = await triggerToken();
    const headers = { Authorization: "Bearer " + token, "content-type": "application/json" };
    const cancel = await jup(TRIGGER + "/orders/price/cancel/" + id, { method: "POST", headers });
    if (!cancel.transaction) throw new Error(cancel.error || cancel.message || "Jupiter did not return a withdrawal.");
    state.status = "Confirm the withdrawal in your wallet…";
    paintLive();
    const signed = await state.provider.signTransaction(b64ToBytes(cancel.transaction));
    await jup(TRIGGER + "/orders/price/confirm-cancel/" + id, {
      method: "POST", headers,
      body: JSON.stringify({ signedTransaction: bytesToB64(signed), cancelRequestId: cancel.requestId })
    });
    state.stops = state.stops.filter((s) => s.id !== id);
    delete state.stopLive[id];
    saveOrderPrefs();
    state.toast = "Stop cancelled · funds return to your wallet";
    state.status = state.toast;
  } catch (err) {
    state.status = err.message || String(err);
    state.toast = state.status;
  } finally {
    state.busy = false;
    render();
  }
}

function pnlText(d, pct) {
  if (!Number.isFinite(d)) return "—";
  const mag = usd(Math.abs(d)).replace(/^-/, "");
  const pctBit = Number.isFinite(pct) ? sheetPct(pct) : "—";
  return "uPnL " + (d < 0 ? "-" : d > 0 ? "+" : "") + mag + " (" + pctBit + ")";
}
function holdPnlHtml(d, pct) {
  if (!Number.isFinite(d) || !Number.isFinite(pct)) return "<b>—</b><span>—</span>";
  const text = usd(d);
  const money = d > 0 ? "+" + text : text;
  let pctHtml = "—";
  if (pct === 0) pctHtml = "0.00%";
  else {
    let dig = 2;
    const av = Math.abs(pct);
    while (dig < 6 && Number(av.toFixed(dig)) === 0) dig++;
    if (Number(av.toFixed(dig)) !== 0) pctHtml = (pct >= 0 ? "▲ " : "▼ ") + av.toFixed(dig) + "%";
  }
  return `<b class="${cls(d)}">${money}</b><span class="${cls(pct)}">${pctHtml}</span>`;
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
  if (mc && t) mc.textContent = mcapText(t);
  const pxEl = $("#stat-px");
  if (pxEl && t) {
    const px = livePrice(t);
    pxEl.textContent = px == null ? "—" : priceLabel(px);
  }
  const feeEl = $("#stat-fees");
  if (feeEl && t) {
    const next = feeHtml(t.fees);
    if (feeEl.innerHTML !== next) feeEl.innerHTML = next;
  }
  if (chg && t) {
    const c = t.stats24h?.priceChange;
    chg.textContent = moveLabel(c);
    chg.className = c == null || !Number.isFinite(Number(c)) ? "chg" : "chg " + cls(c);
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
  if (utc) utc.textContent = clockLabel();
  parkLogo();
  paintAxisEdge();
  const hb = holdBar(p);
  if (barH) barH.textContent = hb.hold;
  if (barP) {
    barP.textContent = hb.pnl;
    barP.className = hb.clsName;
  }
  if (est) est.innerHTML = quoteSummary();
  paintQuoteExtras();
  if (stat) stat.textContent = state.quoting ? "Quoting…" : state.status;
  document.querySelectorAll("[data-mint]").forEach((row) => {
    const h = state.holdings.find((x) => x.mint === row.dataset.mint);
    if (!h) return;
    const price = state.prices[h.mint] || 0;
    const entry = entryOf(h.mint);
    const value = h.ui * price;
    const hn = $(".hold-n", row);
    const pn = $(".pnl", row);
    if (hn) hn.textContent = usd(value);
    if (pn) {
      if (!(entry > 0) || !(price > 0)) pn.innerHTML = "<b>—</b><span>—</span>";
      else pn.innerHTML = holdPnlHtml(value - h.ui * entry, ((price - entry) / entry) * 100);
    }
  });
  tickChart();
  paintEntryLine();
  if (state.orderType === "trail") armTrailHigh(false);
  paintOrderPreview();
}

// ---- TradingView Lightweight Charts (Apache-2.0), created once and re-attached after each render ----
const CHART_H_KEY = "trench-chart-h";
const CHART_MODE_KEY = "trench-chart-mode";
const chartUi = {
  host: null, chart: null, candles: null, volume: null, legend: null, entryLine: null,
  key: "", lastTime: 0, dragging: false, pendingRender: false
};
state.chartH = Number(localStorage.getItem(CHART_H_KEY)) || 260;
state.chartMode = localStorage.getItem(CHART_MODE_KEY) || "mc";
state.chartFull = false;
const IND_KEY = "trench-inds";
const STYLE_KEY = "trench-chart-style";
const SCALE_KEY = "trench-chart-scale";
const DRAW_KEY = "trench-draw";
const INDS = [
  { id: "vol", name: "Volume", group: "Overlay" },
  { id: "ma", name: "MA", group: "Overlay" },
  { id: "ema", name: "EMA", group: "Overlay" },
  { id: "vwap", name: "VWAP", group: "Overlay" },
  { id: "bb", name: "Bollinger", group: "Overlay" },
  { id: "rsi", name: "RSI", group: "Pane" },
  { id: "macd", name: "MACD", group: "Pane" },
  { id: "stoch", name: "Stoch RSI", group: "Pane" },
  { id: "chop", name: "Chop Zone", group: "Pane" }
];
const PANE_INDS = ["rsi", "macd", "stoch", "chop"];
function loadList(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return Array.isArray(v) ? v : fallback;
  } catch (_) { return fallback; }
}
state.inds = INDS.map((i) => i.id).filter((id) => loadList(IND_KEY, ["vol"]).includes(id));
if (!state.inds.length) state.inds = ["vol"];
state.chartStyle = localStorage.getItem(STYLE_KEY) === "line" ? "line" : "candle";
state.scaleMode = ["pct", "log", "auto"].includes(localStorage.getItem(SCALE_KEY)) ? localStorage.getItem(SCALE_KEY) : "auto";

function emaFrom(vals, p) {
  const out = new Array(vals.length).fill(null);
  const k = 2 / (p + 1);
  const buf = [];
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) continue;
    if (prev == null) {
      buf.push(v);
      if (buf.length === p) { prev = buf.reduce((a, b) => a + b, 0) / p; out[i] = prev; }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}
function smaAt(vals, p, i) {
  if (i < p - 1) return null;
  let s = 0;
  for (let j = i - p + 1; j <= i; j++) {
    if (vals[j] == null || !Number.isFinite(vals[j])) return null;
    s += vals[j];
  }
  return s / p;
}
function rsiSeries(vals, p) {
  const out = new Array(vals.length).fill(null);
  if (vals.length <= p) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) {
    const d = vals[i] - vals[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= p; loss /= p;
  out[p] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = p + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    gain = (gain * (p - 1) + Math.max(d, 0)) / p;
    loss = (loss * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}
function macdSeries(closes) {
  const e12 = emaFrom(closes, 12);
  const e26 = emaFrom(closes, 26);
  const macd = closes.map((_, i) => e12[i] != null && e26[i] != null ? e12[i] - e26[i] : null);
  const signal = emaFrom(macd, 9);
  const hist = macd.map((v, i) => v != null && signal[i] != null ? v - signal[i] : null);
  return { macd, signal, hist };
}
function bbSeries(closes, p, mult) {
  const u = new Array(closes.length).fill(null);
  const m = new Array(closes.length).fill(null);
  const l = new Array(closes.length).fill(null);
  for (let i = p - 1; i < closes.length; i++) {
    const mean = smaAt(closes, p, i);
    if (mean == null) continue;
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) { const d = closes[j] - mean; v += d * d; }
    const sd = Math.sqrt(v / p);
    m[i] = mean; u[i] = mean + mult * sd; l[i] = mean - mult * sd;
  }
  return { u, m, l };
}
function stochRsi(closes) {
  const rsi = rsiSeries(closes, 14);
  const raw = rsi.map((v, i) => {
    if (v == null) return null;
    let lo = Infinity, hi = -Infinity, n = 0;
    for (let j = i - 13; j <= i; j++) {
      if (j < 0 || rsi[j] == null) continue;
      n++; lo = Math.min(lo, rsi[j]); hi = Math.max(hi, rsi[j]);
    }
    if (n < 14) return null;
    return hi === lo ? 50 : ((v - lo) / (hi - lo)) * 100;
  });
  const k = raw.map((_, i) => smaAt(raw, 3, i));
  const d = k.map((_, i) => smaAt(k, 3, i));
  return { k, d };
}
function vwapSeries(bars, vols) {
  const out = new Array(bars.length).fill(null);
  let pv = 0, vv = 0, day = "";
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const key = new Date(b.time * 1000).toISOString().slice(0, 10);
    if (key !== day) { day = key; pv = 0; vv = 0; }
    const tp = (b.high + b.low + b.close) / 3;
    const vol = Math.max(Number(vols[i]?.value) || 0, 0);
    pv += tp * (vol || 1);
    vv += vol || 1;
    out[i] = pv / vv;
  }
  return out;
}
function chopPoints(times, closes) {
  const ema = emaFrom(closes, 34);
  const out = [];
  for (let i = 1; i < times.length; i++) {
    if (ema[i] == null || ema[i - 1] == null) continue;
    const slope = (ema[i] - ema[i - 1]) / Math.max(Math.abs(ema[i - 1]), 1e-12);
    let color = "#787b86";
    if (slope > 0.004) color = "#0d9488";
    else if (slope > 0.0015) color = "#22ab94";
    else if (slope > 0) color = "#26a69a";
    else if (slope > -0.0015) color = "#ef5350";
    else if (slope > -0.004) color = "#f23645";
    else color = "#b71c1c";
    out.push({ time: times[i], value: 1, color });
  }
  return out;
}
function finitePts(times, vals, colorOf) {
  const out = [];
  for (let i = 0; i < times.length; i++) {
    if (vals[i] == null || !Number.isFinite(vals[i])) continue;
    const row = { time: times[i], value: vals[i] };
    if (colorOf) row.color = colorOf(vals[i], i);
    out.push(row);
  }
  return out;
}

function clampChartH(h) { return Math.round(Math.min(Math.max(h, 140), Math.max(220, window.innerHeight * 0.85))); }
function chartScale() {
  const t = state.active;
  return state.chartMode === "mc" && t?.circSupply ? t.circSupply : 1;
}
function mcSpan() {
  let hi = -Infinity, lo = Infinity;
  for (const c of state.candles || []) {
    const h = Number(c.high), l = Number(c.low);
    if (h > hi) hi = h;
    if (l < lo) lo = l;
  }
  return hi > lo ? (hi - lo) * chartScale() : 0;
}
function visibleCandleBounds() {
  let from = -Infinity, to = Infinity;
  try {
    const range = chartUi.chart && chartUi.chart.timeScale().getVisibleRange();
    if (range) { from = Number(range.from); to = Number(range.to); }
  } catch (_) {}
  let hi = -Infinity, lo = Infinity, n = 0;
  const take = (c) => {
    const h = Number(c.high), l = Number(c.low);
    if (h > hi) hi = h;
    if (l > 0 && l < lo) lo = l;
    n++;
  };
  for (const c of state.candles || []) {
    const time = Number(c.time);
    if (time < from || time > to) continue;
    take(c);
  }
  if (!n) for (const c of state.candles || []) take(c);
  return { hi, lo };
}
function mcScaleHigh() {
  const k = chartScale();
  const { hi } = visibleCandleBounds();
  let top = hi > 0 ? hi * k : 0;
  const px = livePrice(state.active);
  if (px > 0 && px * k > top) top = px * k;
  return top;
}
// usd() rounds a tight new-coin scale to one label ("2.69K" on every tick).
function fmtMcTick(v) {
  const a = Math.abs(Number(v));
  const sign = v < 0 ? "-" : "";
  if (!Number.isFinite(a) || v < 0) return "";
  // Bottom margin leaves room for volume, and that gutter crosses 0.
  // A 0 there is not a market-cap tick when every candle is far above it.
  let lo = Infinity;
  const k = chartScale();
  const bounds = visibleCandleBounds();
  if (bounds.lo < Infinity) lo = bounds.lo * k;
  if (!(a > 0) || (lo < Infinity && a < lo * 0.5)) return "";
  let unit = 1, suf = "";
  if (a >= 1e9) { unit = 1e9; suf = "B"; }
  else if (a >= 1e6) { unit = 1e6; suf = "M"; }
  else if (a >= 1e3) { unit = 1e3; suf = "K"; }
  // 800.00 under 1.60K reads as the bigger number. A tick on that scale
  // shares the K/M/B unit. A MACD value far below the candles does not.
  const hi = mcScaleHigh();
  const scaleUnit = hi >= 1e9 ? 1e9 : hi >= 1e6 ? 1e6 : hi >= 1e3 ? 1e3 : 1;
  const scaleSuf = scaleUnit >= 1e9 ? "B" : scaleUnit >= 1e6 ? "M" : scaleUnit >= 1e3 ? "K" : "";
  if (a < 1e3 && scaleUnit >= 1e3 && a > hi * 0.05) { unit = scaleUnit; suf = scaleSuf; }
  const step = (mcSpan() || a * 0.01) / 6 / unit;
  let dec = step < 0.005 ? 4 : step < 0.05 ? 3 : 2;
  let text = (a / unit).toFixed(dec);
  while (dec < 6 && a > 0 && Number(text) === 0) { dec++; text = (a / unit).toFixed(dec); }
  if (!(Number(text) > 0)) return "";
  return sign + text + suf;
}
// 0.0₆4623 under 0.0₅1246 looks larger. One subscript for the whole price scale,
// and no decimal: 0.0₅12.00 beside a $0.0₅232 header is the same bug.
function sharedPriceLabel(a) {
  if (state.chartMode === "mc") return null;
  const { hi, lo } = visibleCandleBounds();
  if (!(hi > 0) || !(lo < Infinity) || hi >= 0.01 || !(a > 0)) return null;
  if (a < lo * 0.2 || a > hi * 8) return null;
  const span = Math.max(hi - (lo > 0 ? lo : 0), hi * 0.01);
  // Autoscale adds room above the high. Size the subscript from that top
  // so a tick never prints a mantissa of 12.00.
  const top = hi + span * 0.45;
  let zeros = Math.floor(-Math.log10(top));
  if (zeros > 9) return null;
  if (top >= 10 ** -zeros) zeros -= 1;
  if (zeros < 2 || zeros > 9) return null;
  const step = span / 6;
  let digits = 3;
  while (digits < 5 && step < 2 * 10 ** -(zeros + digits)) digits++;
  const n = Math.round(a * 10 ** (zeros + digits));
  if (!(n > 0) || String(n).length > digits) return "";
  return "0.0" + String(zeros).replace(/\d/g, (d) => SUB[d]) + String(n).padStart(digits, "0");
}
// A $72 scale printed 75.0000 and a pill of 71.9629 beside the header's $71.98.
function fmtDollarTick(v) {
  const a = Math.abs(Number(v));
  if (!(a > 0)) return "";
  if (a >= 1000) return usd(v).replace("$", "");
  const { hi, lo } = visibleCandleBounds();
  const span = hi > lo ? hi - lo : 0;
  const step = span > 0 ? span / 6 : 1;
  let dec = 2;
  if (step < 0.005) dec = 4;
  else if (step < 0.05) dec = 3;
  let text = a.toFixed(dec);
  if (dec > 2) {
    text = text.replace(/0+$/, "");
    const frac = text.split(".")[1] || "";
    if (frac.length < 2) text += "0".repeat(2 - frac.length);
  }
  return (v < 0 ? "-" : "") + text;
}
function fmtAxis(v) {
  if (state.scaleMode !== "pct" && v < 0) return "";
  const a = Math.abs(v);
  if (state.chartMode === "mc" && chartScale() !== 1) return fmtMcTick(v);
  if (a === 0) return "";
  if (a >= 1 && state.scaleMode !== "pct") return fmtDollarTick(v);
  if (a >= 1) return v.toFixed(2);
  const shared = a < 0.01 ? sharedPriceLabel(a) : null;
  if (shared != null) return shared;
  const z = Math.floor(-Math.log10(a));
  if (z >= 4) return "0.0" + String.fromCharCode(8320 + Math.min(9, z)) + Math.round(a * 10 ** (z + 4)).toString().slice(0, 4);
  return v.toPrecision(4);
}

function ensureChart() {
  if (chartUi.chart || !window.LightweightCharts) return chartUi.chart;
  const L = window.LightweightCharts;
  const host = document.createElement("div");
  host.className = "lwc-host";
  const chart = L.createChart(host, {
    autoSize: true,
    layout: { background: { type: "solid", color: "#07090e" }, textColor: "#8b939e", fontSize: 10, attributionLogo: true },
    grid: { vertLines: { color: "rgba(255,255,255,.04)" }, horzLines: { color: "rgba(255,255,255,.06)" } },
    rightPriceScale: { borderVisible: false, entireTextOnly: true, alignLabels: false, scaleMargins: { top: 0.12, bottom: 0.22 } },
    timeScale: {
      borderVisible: false, timeVisible: true, secondsVisible: state.tf === "1s" || state.tf === "15s", rightOffset: 4,
      tickMarkFormatter: (time, type) => tickMarkText(time, type)
    },
    crosshair: { mode: L.CrosshairMode.Normal, vertLine: { labelVisible: false } },
    localization: { priceFormatter: fmtAxis, timeFormatter: (time) => tickMarkText(time, (resolvedTf() === "1s" || resolvedTf() === "15s") ? 4 : 3) },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
    handleScroll: { horzTouchDrag: true, vertTouchDrag: false, pressedMouseMove: true, mouseWheel: true }
  });
  const priceFormat = { type: "custom", formatter: fmtAxis, minMove: 1e-12 };
  const autoscaleInfoProvider = (original) => {
    const res = original();
    if (!res || !res.priceRange || state.scaleMode === "pct") return res;
    let { minValue, maxValue } = res.priceRange;
    if (minValue < 0) minValue = 0;
    const mid = (maxValue + minValue) / 2;
    const span = maxValue - minValue;
    // A one-tick coin otherwise pins every label to the same string (2.1827K)
    // and the top tick is drawn on top of the next one.
    const floor = Math.max(Math.abs(mid) * 0.008, 1e-9);
    if (!(span > floor)) {
      minValue = Math.max(0, mid - floor / 2);
      maxValue = mid + floor / 2;
    }
    // The last-price pill is centered on the high. Without headroom the chart edge cuts it in half.
    const room = Math.max(maxValue - minValue, floor) * 0.18;
    maxValue += room;
    if (minValue > 0) minValue = Math.max(0, minValue - room * 0.25);
    res.priceRange.minValue = minValue;
    res.priceRange.maxValue = maxValue;
    return res;
  };
  const candles = chart.addSeries(L.CandlestickSeries, {
    upColor: "#2ebd85", downColor: "#f6465d", borderVisible: false, wickUpColor: "#2ebd85", wickDownColor: "#f6465d",
    priceFormat, autoscaleInfoProvider, title: "", lastValueVisible: true
  });
  const line = chart.addSeries(L.LineSeries, { color: "#c7f284", lineWidth: 2, priceFormat, autoscaleInfoProvider, visible: false, priceLineVisible: true, title: "" });
  const volume = chart.addSeries(L.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "custom", formatter: () => "", minMove: 1 }, lastValueVisible: false, priceLineVisible: false, title: "" });
  volume.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false, ticksVisible: false });
  const draw = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  draw.setAttribute("class", "draw-layer off");
  host.appendChild(draw);
  const tags = document.createElement("div");
  tags.className = "pane-tags";
  host.appendChild(tags);
  if (chartUi.tagObs) chartUi.tagObs.disconnect();
  chartUi.tagObs = new ResizeObserver(() => schedulePaneTags());
  chartUi.tagObs.observe(host);
  chart.subscribeCrosshairMove((param) => {
    chartUi.cross = param;
    const bar = param?.seriesData?.get(candles) || param?.seriesData?.get(line);
    const vol = param?.seriesData?.get(volume);
    paintLegend(bar, vol?.value, param);
    paintPaneTags(param);
    paintCrosshairTime(param);
    paintScaleClash();
  });
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { paintDrawings(); paintAxisEdge(); paintCrosshairTime(chartUi.cross); });
  Object.assign(chartUi, { host, chart, candles, line, volume, legend: null, draw, tags, extra: [], extraMap: {}, indLayout: "" });
  bindDraw(draw);
  parkLogo();
  requestAnimationFrame(watchDraw);
  return chart;
}
// Keep the TradingView mark a child of the chart library. Reparenting it makes
// lightweight-charts throw removeChild when a pane is added or removed.
function parkLogo() {
  const logo = document.getElementById("tv-attr-logo");
  const host = chartUi.host;
  if (!logo || !host || !host.isConnected) return;
  const r = host.getBoundingClientRect();
  const onScreen = r.width > 2 && r.bottom > 0 && r.top < window.innerHeight;
  logo.style.setProperty("visibility", onScreen ? "visible" : "hidden", "important");
  if (!onScreen) return;
  logo.style.setProperty("position", "fixed", "important");
  logo.style.setProperty("left", Math.round(r.left + 1) + "px", "important");
  logo.style.setProperty("top", Math.round(r.top + 1) + "px", "important");
  logo.style.setProperty("right", "auto", "important");
  logo.style.setProperty("bottom", "auto", "important");
  logo.style.setProperty("margin", "0", "important");
  logo.style.setProperty("z-index", "8", "important");
}
function pad2(n) { return String(n).padStart(2, "0"); }
function visibleSpanSec() {
  try {
    const range = chartUi.chart && chartUi.chart.timeScale().getVisibleRange();
    if (!range) return 0;
    const span = Number(range.to) - Number(range.from);
    return Number.isFinite(span) && span > 0 ? span : 0;
  } catch (_) { return 0; }
}
// Dates only when the window is multi-day. Crossing midnight is not enough:
// a 5m chart of 300 bars is ~25h, and a date on every tick prints "Nov 13" twice.
function axisWantsDay() {
  const tf = resolvedTf();
  if (tf === "4h" || tf === "1D") return true;
  if (tf === "1s" || tf === "15s" || tf === "1m" || tf === "3m" || tf === "5m") return false;
  // 15m of 300 bars is about three days. Clock ticks repeat ("19:00" then "19:00").
  if (tf === "15m") return visibleSpanSec() > 20 * 3600;
  return visibleSpanSec() > 36 * 3600;
}
function axisDay(d, tf) {
  // A daily bar opens at UTC midnight. Local time is the previous evening,
  // so today's coin would read as yesterday (Nov 13 at 1pm on Nov 14).
  const opt = { month: "short", day: "numeric" };
  if (tf === "1D") opt.timeZone = "UTC";
  return d.toLocaleDateString(undefined, opt);
}
function axisClock(ts) {
  const d = new Date(Number(ts) * 1000);
  if (!Number.isFinite(d.getTime())) return "";
  const tf = resolvedTf();
  if (axisWantsDay()) return axisDay(d, tf);
  const sec = tf === "1s" || tf === "15s";
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (sec ? ":" + pad2(d.getSeconds()) : "");
}
// lightweight-charts labels are UTC unless we format them. Match the footer clock (local).
// TickMarkType: 0 year, 1 month, 2 day, 3 time, 4 time with seconds.
function tickMarkText(time, type) {
  const d = new Date(Number(time) * 1000);
  if (!Number.isFinite(d.getTime())) return null;
  const tf = resolvedTf();
  if (type === 0) return String(tf === "1D" ? d.getUTCFullYear() : d.getFullYear());
  const sec = type === 4 || tf === "1s" || tf === "15s";
  const clock = pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + (sec ? ":" + pad2(d.getSeconds()) : "");
  // A month tick is a UTC boundary. Locally that is often the previous evening,
  // so a month-only label sits after a later day ("Oct 12" then "Oct"). Always print the day.
  // On an overnight 5m chart a day tick beside a clock tick collides, so those stay clocks.
  if (axisWantsDay()) return axisDay(d, tf);
  if ((type === 1 || type === 2) && tf !== "1s" && tf !== "15s" && tf !== "1m" && tf !== "3m" && tf !== "5m" && tf !== "15m") return axisDay(d, tf);
  return clock;
}
function timePaneWidth(host) {
  let w = 0;
  for (const c of host.querySelectorAll("canvas")) {
    if (c.clientHeight > 8 && c.clientHeight < 48 && c.clientWidth > w) w = c.clientWidth;
  }
  return w || host.querySelector("canvas")?.clientWidth || 0;
}
function timeLabelGroups(host) {
  const canvas = [...host.querySelectorAll("canvas")].find((c) => c.clientHeight > 8 && c.clientHeight < 48 && c.clientWidth > 80);
  if (!canvas) return null;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  let img;
  try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (_) { return null; }
  const d = img.data;
  const scale = canvas.clientWidth / canvas.width;
  const xs = [];
  for (let x = 0; x < canvas.width; x++) {
    let ink = 0;
    for (let y = 0; y < canvas.height; y++) {
      const i = (y * canvas.width + x) * 4;
      if (d[i] + d[i + 1] + d[i + 2] > 180) ink++;
    }
    if (ink > 2) xs.push(x * scale);
  }
  if (!xs.length) return [];
  const groups = [[xs[0], xs[0]]];
  for (const x of xs) {
    const g = groups[groups.length - 1];
    if (x - g[1] > 12) groups.push([x, x]);
    else g[1] = x;
  }
  return groups;
}
function paintAxisEdge() {
  const host = chartUi.host;
  const chart = chartUi.chart;
  if (!host || !chart) return;
  let bar = host.querySelector(".axis-edge");
  if (!bar) {
    bar = document.createElement("div");
    bar.className = "axis-edge";
    host.appendChild(bar);
  }
  const range = chart.timeScale().getVisibleRange();
  const toX = range ? chart.timeScale().timeToCoordinate(range.to) : null;
  const paneW = timePaneWidth(host);
  const rightClipped = toX != null && paneW && toX > paneW - 28;
  const label = range ? axisClock(range.from) : "";
  bar.textContent = label;
  bar.style.maxWidth = "";
  const textW = label ? (bar.scrollWidth || label.length * 6 + 6) : 0;
  // Native ticks are painted on the time canvas. Only cover a label that actually starts off the left edge,
  // and never stop in the middle of the next one ("04:00:45" must not become ":45").
  const groups = timeLabelGroups(host);
  const sliced = groups && groups.length && groups[0][0] <= 6;
  let show = false;
  let cover = 0;
  if (sliced && label && textW && !(rightClipped && range.from === range.to)) {
    let end = groups[0][1];
    let i = 1;
    // Width must paint past the text. max-width alone leaves the box at the
    // text width, so the next glyph peeks out ("05:34:30 )").
    cover = Math.max(textW, end + 6);
    while (i < groups.length && cover >= groups[i][0] - 3) {
      end = groups[i][1];
      i++;
      cover = Math.max(cover, end + 6);
    }
    const room = i < groups.length ? groups[i][0] - 4 : 120;
    show = cover <= room + 1 && cover <= 120;
  }
  bar.textContent = show ? label : "";
  bar.style.width = show ? cover + "px" : "";
  bar.style.maxWidth = show ? cover + "px" : "";
  let right = host.querySelector(".axis-edge-r");
  if (!right) {
    right = document.createElement("div");
    right.className = "axis-edge axis-edge-r";
    host.appendChild(right);
  }
  right.textContent = range && rightClipped ? axisClock(range.to) : "";
  // Cover the clipped native tick, and swallow any label the cover would otherwise cut in half.
  if (right.textContent && paneW) {
    right.style.right = "auto";
    right.style.width = "auto";
    const textW = right.scrollWidth || 46;
    let cover = Math.max(textW + 8, 72);
    if (groups && groups.length) {
      let i = groups.length - 1;
      cover = Math.max(cover, paneW - groups[i][0] + 4);
      while (i > 0) {
        const prev = groups[i - 1];
        const coverLeft = paneW - cover;
        if (coverLeft < prev[1] + 2) {
          i--;
          cover = Math.max(cover, paneW - groups[i][0] + 4);
        } else break;
      }
      const earlier = i > 0 ? groups[i - 1][1] + 6 : 0;
      cover = Math.min(160, cover, paneW - earlier);
    } else cover = Math.min(160, cover);
    right.style.width = cover + "px";
    right.style.left = Math.max(0, paneW - cover) + "px";
  } else {
    right.style.left = "";
    right.style.width = "";
  }
  parkLogo();
  paintScaleClash();
}
// The last-price pill is painted on the scale canvas. A tick that sits on it
// shows as a sliced label (800.00M under the pill). Cover that tick only.
function paintScaleClash() {
  if (chartUi.scaleClash) return;
  chartUi.scaleClash = requestAnimationFrame(() => {
    chartUi.scaleClash = requestAnimationFrame(() => {
      chartUi.scaleClash = 0;
      paintScaleClashNow();
    });
  });
}
function paintScaleClashNow() {
  const host = chartUi.host;
  if (!host || !host.isConnected) return;
  host.querySelectorAll(".scale-cut").forEach((n) => n.remove());
  const hostR = host.getBoundingClientRect();
  const scales = [];
  for (const canvas of host.querySelectorAll("canvas")) {
    if (canvas.clientWidth < 36 || canvas.clientWidth > 110 || canvas.clientHeight < 48) continue;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    let img;
    try { img = ctx.getImageData(0, 0, canvas.width, canvas.height); } catch (_) { continue; }
    const d = img.data;
    const W = canvas.width;
    const H = canvas.height;
    if (!W || !H) continue;
    let pill0 = Infinity, pill1 = -1;
    const ticks = [];
    for (let y = 0; y < H; y++) {
      let tick = 0, color = 0;
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const R = d[i], G = d[i + 1], B = d[i + 2], A = d[i + 3];
        if (A < 30) continue;
        const red = R > 180 && G < 140 && B < 160 && R > G + 50;
        const green = G > 140 && R < 140 && G > R + 30 && B < 200;
        if (red || green) { color++; continue; }
        const sum = R + G + B;
        if (R < 210 && sum > 320 && sum < 560 && Math.abs(R - G) < 40 && Math.abs(G - B) < 40) tick++;
      }
      if (color > 8) { if (y < pill0) pill0 = y; pill1 = y; }
      if (tick > 2) ticks.push(y);
    }
    const bands = [];
    for (const y of ticks) {
      const last = bands[bands.length - 1];
      if (last && y - last[1] <= 4) last[1] = y;
      else bands.push([y, y]);
    }
    scales.push({ canvas, W, H, pill0, pill1, bands });
  }
  // The last-price pill and the tick it collides with are often on different stacked canvases.
  let pill0 = Infinity, pill1 = -1;
  for (const s of scales) {
    if (s.pill1 >= 0) { pill0 = Math.min(pill0, s.pill0); pill1 = Math.max(pill1, s.pill1); }
  }
  for (const s of scales) {
    if (!s.bands.length) continue;
    const sy = s.canvas.clientHeight / s.H;
    const cr = s.canvas.getBoundingClientRect();
    const baseTop = cr.top - hostR.top;
    const left = cr.left - hostR.left;
    // 4px left a tick that started just under the pill ("6.00K" sliced by 6.91K).
    // One label height covers that tick, and the crosshair price label too.
    const px = s.W / (s.canvas.clientWidth || 1);
    const near = Math.round(14 * px);
    let crossY = null;
    const pt = chartUi.cross && chartUi.cross.point;
    if (pt && Number.isFinite(pt.y)) {
      const local = (hostR.top + pt.y - cr.top) * (s.H / (s.canvas.clientHeight || 1));
      if (local > -near && local < s.H + near) crossY = local;
    }
    const hide = new Set();
    for (let i = 0; i < s.bands.length; i++) {
      const [y0, y1] = s.bands[i];
      if (y0 <= 1 || y1 >= s.H - 2) hide.add(i);
      if (pill1 >= 0 && y1 >= pill0 - near && y0 <= pill1 + near) hide.add(i);
      if (crossY != null && y1 >= crossY - near && y0 <= crossY + near) hide.add(i);
    }
    for (const i of hide) {
      const [y0, y1] = s.bands[i];
      const cut = document.createElement("div");
      cut.className = "scale-cut";
      cut.style.top = Math.max(0, baseTop + y0 * sy - 1) + "px";
      cut.style.height = ((y1 - y0 + 1) * sy + 2) + "px";
      cut.style.left = left + "px";
      cut.style.width = s.canvas.clientWidth + "px";
      host.appendChild(cut);
    }
  }
}

// The library's crosshair time is painted on the tick canvas, so it slices the
// tick beside it ("06" left of "06:17:45"). Draw the time ourselves and cover
// any tick the pill would cut.
function paintCrosshairTime(param) {
  const host = chartUi.host;
  const chart = chartUi.chart;
  if (!host || !chart) return;
  let el = host.querySelector(".axis-cross");
  if (!el) {
    el = document.createElement("div");
    el.className = "axis-edge axis-cross";
    host.appendChild(el);
  }
  host.querySelectorAll(".axis-cut").forEach((n) => n.remove());
  const time = param && param.time;
  const ts = typeof time === "number" ? time : time && time.timestamp;
  const x = ts != null ? chart.timeScale().timeToCoordinate(ts) : null;
  const label = x != null ? axisClock(ts) : "";
  if (!label || !Number.isFinite(x)) {
    el.textContent = "";
    host.querySelectorAll(".axis-edge:not(.axis-cross)").forEach((lab) => { lab.style.visibility = ""; });
    return;
  }
  el.textContent = label;
  const textW = el.scrollWidth || label.length * 6 + 8;
  const left = Math.max(0, Math.round(x - textW / 2));
  el.style.left = left + "px";
  el.style.width = textW + "px";
  const right = left + textW;
  const groups = timeLabelGroups(host) || [];
  for (const g of groups) {
    const overlap = Math.min(g[1], right) - Math.max(g[0], left);
    if (overlap < 1) continue;
    if (g[0] >= left - 1 && g[1] <= right + 1) continue;
    const cut = document.createElement("div");
    cut.className = "axis-cut";
    const cLeft = Math.max(0, g[0] - 2);
    cut.style.left = cLeft + "px";
    cut.style.width = (g[1] + 3 - cLeft) + "px";
    host.appendChild(cut);
  }
  // The pill sits above the edge labels. Overlap was leaving "08:00:0".
  // Hide the label and cover its box so neither a slice nor the native tick shows.
  host.querySelectorAll(".axis-edge:not(.axis-cross)").forEach((lab) => {
    if (!lab.textContent) { lab.style.visibility = ""; return; }
    const labLeft = lab.offsetLeft;
    const labRight = labLeft + lab.offsetWidth;
    const overlap = Math.min(labRight, right) - Math.max(labLeft, left);
    if (overlap <= 0) { lab.style.visibility = ""; return; }
    lab.style.visibility = "hidden";
    const cut = document.createElement("div");
    cut.className = "axis-cut";
    cut.style.left = Math.max(0, labLeft) + "px";
    cut.style.width = Math.max(4, labRight - labLeft) + "px";
    host.appendChild(cut);
  });
}

function paintLegend(bar, vol, param) {
  const ohlc = document.getElementById("ohlc");
  const inds = document.getElementById("ind-leg");
  if (ohlc) {
    if (!bar) ohlc.replaceChildren();
    else if (bar.open == null) {
      ohlc.innerHTML = `<span>C</span><b>${fmtAxis(bar.value)}</b>${vol != null ? `<span>V</span><b>${usd(vol).replace("$", "")}</b>` : ""}`;
    } else {
      const c = bar.close >= bar.open ? "up" : "down";
      ohlc.innerHTML = `<span>O</span><b class="${c}">${fmtAxis(bar.open)}</b><span>H</span><b class="${c}">${fmtAxis(bar.high)}</b><span>L</span><b class="${c}">${fmtAxis(bar.low)}</b><span>C</span><b class="${c}">${fmtAxis(bar.close)}</b>${vol != null ? `<span>V</span><b>${usd(vol).replace("$", "")}</b>` : ""}`;
    }
  }
  if (!inds) return;
  const names = { ma: "MA", ema: "EMA", vwap: "VWAP", bbM: "BB", rsi: "RSI", macd: "MACD", stochK: "Stoch" };
  const parts = [];
  const data = param?.seriesData;
  if (data && chartUi.extraMap) {
    for (const [id, label] of Object.entries(names)) {
      const series = chartUi.extraMap[id];
      if (!series) continue;
      const row = data.get(series);
      const v = row && (row.value != null ? row.value : row.close);
      if (v == null || !Number.isFinite(Number(v))) continue;
      const text = id === "rsi" || id === "stochK" ? Number(v).toFixed(1) : fmtAxis(v);
      parts.push(label + " " + text);
    }
  }
  inds.textContent = parts.join("  ");
}

function toBars(list) {
  const k = chartScale();
  const bars = [];
  const vols = [];
  let last = 0;
  for (const c of list || []) {
    const time = Number(c.time);
    if (!time || time <= last) continue;
    last = time;
    bars.push({ time, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k });
    vols.push({ time, value: Number(c.volume) || 0, color: c.close >= c.open ? "rgba(46,189,133,.45)" : "rgba(246,70,93,.45)" });
  }
  return { bars, vols };
}

// Full data load (token, interval, or mode change) vs incremental update (polling).
function setChartData() {
  if (!ensureChart()) return;
  const t = state.active;
  const key = (t?.id || "") + "|" + state.tf + "|" + resolvedTf() + "|" + state.chartMode;
  const { bars, vols } = toBars(state.candles);
  const linePts = bars.map((b) => ({ time: b.time, value: b.close }));
  const full = key !== chartUi.key || !chartUi.lastTime;
  if (full) {
    chartUi.candles.setData(bars);
    chartUi.line.setData(linePts);
    chartUi.volume.setData(vols);
    chartUi.key = key;
    frameCandles(bars.length);
  } else {
    bars.forEach((b, i) => {
      if (b.time >= chartUi.lastTime) {
        chartUi.candles.update(b);
        chartUi.line.update(linePts[i]);
        chartUi.volume.update(vols[i]);
      }
    });
  }
  chartUi.lastTime = bars.length ? bars[bars.length - 1].time : 0;
  applyStyle();
  applyScale();
  fillIndicators(full);
  syncMarks();
  paintEntryLine();
  paintDrawings();
}

// fitContent stretches a handful of bars across the whole plot, so a new coin's
// only candle becomes a slab that covers the drawing toolbar. Keep a normal width.
function frameCandles(n) {
  const ts = chartUi.chart && chartUi.chart.timeScale();
  if (!ts) return;
  const sec = resolvedTf() === "1s" || resolvedTf() === "15s";
  if (n > 0 && n < 40) {
    ts.applyOptions({ secondsVisible: sec, barSpacing: 8, rightOffset: 8, minBarSpacing: 4 });
    const to = n - 1 + 8;
    try { ts.setVisibleLogicalRange({ from: to - 48, to }); }
    catch (_) { ts.fitContent(); }
  } else {
    ts.applyOptions({ secondsVisible: sec, barSpacing: 6, rightOffset: 4, minBarSpacing: 0.5 });
    ts.fitContent();
  }
}
function priceSeries() {
  return state.chartStyle === "line" && chartUi.line ? chartUi.line : chartUi.candles;
}

function paintEntryLine() {
  const t = state.active;
  const series = priceSeries();
  if (!series || !t) return;
  const p = activePnl();
  const want = p.amount && p.entry ? p.entry * chartScale() : 0;
  if (chartUi.entryLine && (chartUi.entrySeries !== series || !want || chartUi.entryLine.options().price !== want)) {
    try { chartUi.entrySeries.removePriceLine(chartUi.entryLine); } catch (_) {}
    chartUi.entryLine = null;
    chartUi.entrySeries = null;
  }
  if (want && !chartUi.entryLine) {
    chartUi.entryLine = series.createPriceLine({ price: want, color: "#5ed68c", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "Avg Entry" });
    chartUi.entrySeries = series;
  }
}

function tickChart(addVolume = 0) {
  const t = state.active;
  if (!chartUi.candles || !t || !chartUi.lastTime || !state.candles.length) return;
  const price = state.prices[t.id];
  if (!price) return;
  const sec = TF_SEC[resolvedTf()] || 60;
  const bucket = Math.floor(Date.now() / 1000 / sec) * sec;
  let last = state.candles[state.candles.length - 1];
  if (Number(last.time) !== chartUi.lastTime) return;
  if (bucket > chartUi.lastTime) {
    last = { time: bucket, open: last.close, high: price, low: price, close: price, volume: 0 };
    state.candles.push(last);
    chartUi.lastTime = bucket;
  }
  last.close = price;
  last.high = Math.max(last.high, price);
  last.low = Math.min(last.low, price);
  if (addVolume) last.volume = (Number(last.volume) || 0) + addVolume;
  const k = chartScale();
  const bar = { time: chartUi.lastTime, open: last.open * k, high: last.high * k, low: last.low * k, close: price * k };
  chartUi.candles.update(bar);
  if (chartUi.line) chartUi.line.update({ time: chartUi.lastTime, value: price * k });
  chartUi.volume.update({ time: chartUi.lastTime, value: Number(last.volume) || 0, color: last.close >= last.open ? "rgba(46,189,133,.45)" : "rgba(246,70,93,.45)" });
  const now = Date.now();
  if (now - (tickChart.indAt || 0) > 250) {
    tickChart.indAt = now;
    fillIndicators(false);
  }
}

function pushSeries(series, points, full) {
  if (!series) return;
  try {
    if (full || !points.length) { series.setData(points); return; }
    series.update(points[points.length - 1]);
  } catch (_) {
    try { series.setData(points); } catch (__) {}
  }
}
function indLayout() { return state.inds.join(","); }
function paneIds() { return PANE_INDS.filter((id) => state.inds.includes(id)); }
function ensurePaneRoom() {
  const n = paneIds().length;
  if (!n || state.chartFull) return;
  const need = clampChartH(230 + n * 76);
  if (state.chartH >= need) return;
  state.chartH = need;
  const wrap = $("#chart-wrap");
  if (wrap) wrap.style.height = need + "px";
}
function schedulePaneTags() {
  if (chartUi.tagFrame) cancelAnimationFrame(chartUi.tagFrame);
  chartUi.tagFrame = requestAnimationFrame(() => paintPaneTags(chartUi.cross));
  clearTimeout(chartUi.tagTimer);
  chartUi.tagTimer = setTimeout(() => paintPaneTags(chartUi.cross), 60);
}
function applyPaneHeights() {
  if (!chartUi.chart) return;
  const panes = chartUi.chart.panes();
  for (let i = 1; i < panes.length; i++) {
    try { panes[i].setHeight(68); } catch (_) {}
  }
  schedulePaneTags();
}
function paintPaneTags(param) {
  const box = chartUi.tags;
  if (!box || !chartUi.chart) return;
  const names = { rsi: "RSI 14", macd: "MACD 12 26 9", stoch: "Stoch RSI", chop: "Chop Zone" };
  const seriesId = { rsi: "rsi", macd: "macd", stoch: "stochK", chop: "chop" };
  const order = paneIds();
  const panes = chartUi.chart.panes();
  let y = 0;
  const html = [];
  panes.forEach((p, i) => {
    const h = p.getHeight();
    const id = i > 0 ? order[i - 1] : "";
    if (id && names[id]) {
      let extra = "";
      const series = chartUi.extraMap && chartUi.extraMap[seriesId[id]];
      const row = series && param?.seriesData?.get(series);
      const v = row && (row.value != null ? row.value : row.close);
      if (id !== "chop" && v != null && Number.isFinite(Number(v))) extra = " " + (id === "rsi" || id === "stoch" ? Number(v).toFixed(1) : fmtAxis(v));
      html.push(`<div class="pane-tag" style="top:${y + 2}px">${names[id]}${extra}</div>`);
    }
    y += h;
  });
  box.innerHTML = html.join("");
}
function buildIndSeries() {
  const chart = chartUi.chart;
  const L = window.LightweightCharts;
  for (const s of chartUi.extra || []) { try { chart.removeSeries(s); } catch (_) {} }
  chartUi.extra = [];
  chartUi.extraMap = {};
  const want = new Set(state.inds);
  const fmt = { type: "custom", formatter: fmtAxis, minMove: 1e-12 };
  const addLine = (opt, pane) => {
    const s = chart.addSeries(L.LineSeries, { priceLineVisible: false, lastValueVisible: false, lineWidth: 1, ...opt }, pane || 0);
    chartUi.extra.push(s);
    return s;
  };
  if (want.has("ma")) chartUi.extraMap.ma = addLine({ color: "#f5c542", title: "", priceFormat: fmt });
  if (want.has("ema")) chartUi.extraMap.ema = addLine({ color: "#5b8def", title: "", priceFormat: fmt });
  if (want.has("vwap")) chartUi.extraMap.vwap = addLine({ color: "#c7f284", title: "", priceFormat: fmt });
  if (want.has("bb")) {
    chartUi.extraMap.bbU = addLine({ color: "rgba(179,136,255,.85)", title: "", priceFormat: fmt });
    chartUi.extraMap.bbM = addLine({ color: "#b388ff", title: "", lineStyle: 2, priceFormat: fmt });
    chartUi.extraMap.bbL = addLine({ color: "rgba(179,136,255,.85)", title: "", priceFormat: fmt });
  }
  const panes = paneIds();
  const paneOf = Object.fromEntries(panes.map((id, i) => [id, i + 1]));
  if (want.has("rsi")) {
    const s = addLine({ color: "#c7f284", title: "", priceFormat: { type: "price", precision: 1, minMove: 0.1 } }, paneOf.rsi);
    s.createPriceLine({ price: 70, color: "rgba(139,147,158,.55)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    s.createPriceLine({ price: 30, color: "rgba(139,147,158,.55)", lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: "" });
    chartUi.extraMap.rsi = s;
  }
  if (want.has("macd")) {
    const p = paneOf.macd;
    const hist = chart.addSeries(L.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, title: "" }, p);
    chartUi.extra.push(hist);
    chartUi.extraMap.macdHist = hist;
    chartUi.extraMap.macd = addLine({ color: "#5b8def", title: "" }, p);
    chartUi.extraMap.macdSig = addLine({ color: "#f5c542", title: "" }, p);
  }
  if (want.has("stoch")) {
    const p = paneOf.stoch;
    chartUi.extraMap.stochK = addLine({ color: "#5b8def", title: "" }, p);
    chartUi.extraMap.stochD = addLine({ color: "#f5c542", title: "" }, p);
  }
  if (want.has("chop")) {
    // Hiding this pane's price scale throws "Value is null" inside lightweight-charts on resize.
    const s = chart.addSeries(L.HistogramSeries, {
      priceLineVisible: false, lastValueVisible: false, title: "",
      priceFormat: { type: "custom", formatter: () => "", minMove: 1 }
    }, paneOf.chop);
    chartUi.extra.push(s);
    chartUi.extraMap.chop = s;
  }
  chartUi.volume.applyOptions({ visible: want.has("vol") });
  chartUi.indLayout = indLayout();
  requestAnimationFrame(() => applyPaneHeights());
}
function fillIndicators(full) {
  if (!chartUi.chart) return;
  ensurePaneRoom();
  if (chartUi.indLayout !== indLayout()) buildIndSeries();
  else chartUi.volume.applyOptions({ visible: state.inds.includes("vol") });
  const { bars, vols } = toBars(state.candles);
  const times = bars.map((b) => b.time);
  const closes = bars.map((b) => b.close);
  const m = chartUi.extraMap || {};
  if (m.ma) pushSeries(m.ma, finitePts(times, closes.map((_, i) => smaAt(closes, 20, i))), full);
  if (m.ema) pushSeries(m.ema, finitePts(times, emaFrom(closes, 21)), full);
  if (m.vwap) pushSeries(m.vwap, finitePts(times, vwapSeries(bars, vols)), full);
  if (m.bbU) {
    const bb = bbSeries(closes, 20, 2);
    pushSeries(m.bbU, finitePts(times, bb.u), full);
    pushSeries(m.bbM, finitePts(times, bb.m), full);
    pushSeries(m.bbL, finitePts(times, bb.l), full);
  }
  if (m.rsi) pushSeries(m.rsi, finitePts(times, rsiSeries(closes, 14)), full);
  if (m.macd) {
    const macd = macdSeries(closes);
    pushSeries(m.macd, finitePts(times, macd.macd), full);
    pushSeries(m.macdSig, finitePts(times, macd.signal), full);
    pushSeries(m.macdHist, finitePts(times, macd.hist, (v) => v >= 0 ? "rgba(46,189,133,.8)" : "rgba(246,70,93,.8)"), full);
  }
  if (m.stochK) {
    const st = stochRsi(closes);
    pushSeries(m.stochK, finitePts(times, st.k), full);
    pushSeries(m.stochD, finitePts(times, st.d), full);
  }
  if (m.chop) {
    pushSeries(m.chop, chopPoints(times, closes), full);
    try { m.chop.priceScale().applyOptions({ textColor: "#07090e", borderVisible: false }); } catch (_) {}
  }
  if (full) requestAnimationFrame(paintPaneTags);
}
function applyStyle() {
  if (!chartUi.candles || !chartUi.line) return;
  const line = state.chartStyle === "line";
  chartUi.candles.applyOptions({ visible: !line });
  chartUi.line.applyOptions({ visible: line });
}
function applyScale() {
  if (!chartUi.chart || !window.LightweightCharts) return;
  const L = window.LightweightCharts;
  const mode = state.scaleMode === "log" ? L.PriceScaleMode.Logarithmic
    : state.scaleMode === "pct" ? L.PriceScaleMode.Percentage
    : L.PriceScaleMode.Normal;
  try { chartUi.chart.priceScale("right").applyOptions({ mode, autoScale: true, alignLabels: false }); }
  catch (_) { try { chartUi.chart.priceScale("right").applyOptions({ mode: L.PriceScaleMode.Normal, autoScale: true, alignLabels: false }); } catch (__) {} }
}
function loadMarks(id) {
  try {
    const all = JSON.parse(localStorage.getItem(DRAW_KEY)) || {};
    return Array.isArray(all[id]) ? all[id] : [];
  } catch (_) { return []; }
}
function saveMarks() {
  const id = state.active?.id;
  if (!id) return;
  let all = {};
  try { all = JSON.parse(localStorage.getItem(DRAW_KEY)) || {}; } catch (_) {}
  all[id] = (state.marks || []).slice(-40);
  const keys = Object.keys(all);
  while (keys.length > 24) delete all[keys.shift()];
  try { localStorage.setItem(DRAW_KEY, JSON.stringify(all)); } catch (_) {}
}
function syncMarks() {
  const id = state.active?.id || "";
  if (chartUi.markId === id) return;
  chartUi.markId = id;
  state.marks = loadMarks(id);
  chartUi.draft = null;
}
function timeNum(t) {
  if (typeof t === "number") return t;
  if (t && t.year) return Date.UTC(t.year, t.month - 1, t.day) / 1000;
  return null;
}
function xy(p) {
  if (!p || !chartUi.chart || !chartUi.candles) return null;
  const x = chartUi.chart.timeScale().timeToCoordinate(p.time);
  const y = chartUi.candles.priceToCoordinate(p.price);
  if (x == null || y == null) return null;
  return { x, y };
}
function pointFromEvent(ev) {
  const rect = chartUi.host.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  const paneH = chartUi.chart.panes()[0]?.getHeight?.() || rect.height;
  if (x < 0 || x > rect.width || y < 0) return null;
  const yy = Math.max(0, Math.min(y, Math.max(0, paneH - 2)));
  const time = timeNum(chartUi.chart.timeScale().coordinateToTime(x));
  const price = chartUi.candles.coordinateToPrice(yy);
  if (time == null || price == null || !Number.isFinite(price)) return null;
  return { time, price };
}
function markSvg(m) {
  if (!m) return "";
  if (m.type === "trend") {
    const A = xy(m.a), B = xy(m.b);
    if (!A || !B) return "";
    return `<line x1="${A.x}" y1="${A.y}" x2="${B.x}" y2="${B.y}" stroke="#7eb6ff" stroke-width="1.6"/>`;
  }
  if (m.type === "hline") {
    const A = xy(m.a);
    if (!A) return "";
    const w = chartUi.host.clientWidth || 0;
    return `<line x1="0" y1="${A.y}" x2="${w}" y2="${A.y}" stroke="#e6c84a" stroke-width="1" stroke-dasharray="4 3"/>`;
  }
  if (m.type === "fib") {
    const A = xy(m.a), B = xy(m.b);
    if (!A || !B) return "";
    const x1 = Math.min(A.x, B.x), x2 = Math.max(A.x, B.x);
    return [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1].map((lv) => {
      const price = m.a.price + (m.b.price - m.a.price) * lv;
      const y = chartUi.candles.priceToCoordinate(price);
      if (y == null) return "";
      return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#c7f284" stroke-width="1" stroke-dasharray="3 3"/><text x="${x2 + 3}" y="${y - 2}" fill="#c7f284" font-size="9">${lv}</text>`;
    }).join("");
  }
  if (m.type === "rect") {
    const A = xy(m.a), B = xy(m.b);
    if (!A || !B) return "";
    const x = Math.min(A.x, B.x), y = Math.min(A.y, B.y);
    return `<rect x="${x}" y="${y}" width="${Math.abs(B.x - A.x)}" height="${Math.abs(B.y - A.y)}" fill="rgba(126,182,255,.12)" stroke="#7eb6ff" stroke-width="1"/>`;
  }
  if (m.type === "text") {
    const A = xy(m.a);
    if (!A || !m.text) return "";
    return `<text x="${A.x}" y="${A.y}" fill="#fff" font-size="12">${esc(m.text)}</text>`;
  }
  return "";
}
function paintDrawings() {
  const svg = chartUi.draw;
  if (!svg || !chartUi.chart) return;
  const w = chartUi.host.clientWidth || 1;
  const h = chartUi.host.clientHeight || 1;
  svg.setAttribute("width", w);
  svg.setAttribute("height", h);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const marks = chartUi.draft ? (state.marks || []).concat([chartUi.draft]) : (state.marks || []);
  svg.innerHTML = marks.map(markSvg).join("");
}
function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len));
  const x = a.x + t * dx, y = a.y + t * dy;
  return Math.hypot(p.x - x, p.y - y);
}
function eraseAt(pt) {
  const P = xy(pt);
  if (!P) return;
  let best = -1, bestD = 18;
  (state.marks || []).forEach((m, i) => {
    let d = 99;
    if (m.type === "trend" || m.type === "rect" || m.type === "fib") {
      const A = xy(m.a), B = xy(m.b);
      if (A && B) d = distSeg(P, A, B);
    } else if (m.type === "hline") {
      const A = xy(m.a);
      if (A) d = Math.abs(P.y - A.y);
    } else if (m.type === "text") {
      const A = xy(m.a);
      if (A) d = Math.hypot(P.x - A.x, P.y - A.y);
    }
    if (d < bestD) { bestD = d; best = i; }
  });
  if (best >= 0) {
    state.marks.splice(best, 1);
    saveMarks();
    paintDrawings();
  }
}
function askText(ev, pt) {
  const wrap = $("#chart-wrap");
  if (!wrap) return;
  const wr = wrap.getBoundingClientRect();
  const inp = document.createElement("input");
  inp.className = "draw-text-inp";
  inp.placeholder = "Text";
  inp.setAttribute("enterkeyhint", "done");
  inp.style.left = Math.max(8, ev.clientX - wr.left) + "px";
  inp.style.top = Math.max(8, ev.clientY - wr.top) + "px";
  wrap.appendChild(inp);
  inp.focus();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    const text = inp.value.trim();
    inp.remove();
    if (!text) return;
    state.marks.push({ type: "text", a: pt, b: pt, text });
    saveMarks();
    paintDrawings();
  };
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") finish();
    if (e.key === "Escape") { done = true; inp.remove(); }
  });
  inp.addEventListener("blur", () => setTimeout(finish, 0));
}
function commitMark(mark) {
  state.marks.push(mark);
  saveMarks();
  paintDrawings();
}
function bindDraw(svg) {
  let pointerAt = 0;
  const down = (ev) => {
    if (ev.pointerType) pointerAt = Date.now();
    else if (Date.now() - pointerAt < 400) return;
    if (state.tool === "cross") return;
    const pt = pointFromEvent(ev);
    if (!pt) return;
    ev.preventDefault();
    if (ev.pointerId != null) { try { svg.setPointerCapture(ev.pointerId); } catch (_) {} }
    if (state.tool === "erase") { eraseAt(pt); return; }
    if (state.tool === "text") { askText(ev, pt); return; }
    if (state.tool === "hline") { commitMark({ type: "hline", a: pt, b: pt }); return; }
    chartUi.draft = { type: state.tool, a: pt, b: pt };
  };
  const move = (ev) => {
    if (!ev.pointerType && Date.now() - pointerAt < 400) return;
    if (!chartUi.draft) return;
    const pt = pointFromEvent(ev);
    if (!pt) return;
    chartUi.draft.b = pt;
    paintDrawings();
  };
  const end = (ev) => {
    if (ev && !ev.pointerType && Date.now() - pointerAt < 400) return;
    const d = chartUi.draft;
    if (!d) return;
    chartUi.draft = null;
    const A = xy(d.a), B = xy(d.b);
    if (A && B && Math.hypot(A.x - B.x, A.y - B.y) >= 6) commitMark(d);
    else paintDrawings();
  };
  svg.addEventListener("pointerdown", down);
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("mousedown", down);
  svg.addEventListener("mousemove", move);
  window.addEventListener("mouseup", end);
}
function setTool(tool) {
  state.tool = tool;
  if (chartUi.draw) chartUi.draw.classList.toggle("off", tool === "cross");
  document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === tool));
}
function watchDraw() {
  if (!document.hidden && chartUi.candles && (state.marks.length || chartUi.draft)) {
    const last = state.candles[state.candles.length - 1];
    const y = last ? chartUi.candles.priceToCoordinate(last.close * chartScale()) : null;
    const x = last ? chartUi.chart.timeScale().timeToCoordinate(Number(last.time)) : null;
    if (y !== chartUi.watchY || x !== chartUi.watchX) {
      chartUi.watchY = y;
      chartUi.watchX = x;
      paintDrawings();
    }
  }
  requestAnimationFrame(watchDraw);
}
function flash(msg) {
  let t = $("#toast-lite");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast-lite";
    t.className = "toast";
    app.appendChild(t);
  }
  t.textContent = msg;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => t.remove(), 1400);
}
function closeIndSheet() { $("#ind-sheet")?.remove(); }
function paintIndList() {
  const q = ($("#ind-q")?.value || "").trim().toLowerCase();
  const box = $("#ind-list");
  if (!box) return;
  const rows = INDS.filter((i) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q));
  box.innerHTML = rows.map((i) => {
    const on = state.inds.includes(i.id);
    return `<button type="button" class="ind-row ${on ? "on" : ""}" data-ind="${i.id}"><span>${i.name}</span><span class="ind-kind">${i.group}</span><span class="ind-check">${on ? "✓" : ""}</span></button>`;
  }).join("") || `<div class="k">No indicators</div>`;
  box.querySelectorAll("[data-ind]").forEach((b) => b.onclick = () => { toggleInd(b.dataset.ind); paintIndList(); });
}
function openIndSheet() {
  closeIndSheet();
  const root = document.createElement("div");
  root.className = "sheet";
  root.id = "ind-sheet";
  root.innerHTML = `<div class="grab"></div><h2>Indicators <button type="button" id="ind-close" aria-label="Close">✕</button></h2><input id="ind-q" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search indicators" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#12171e;color:#fff;font-size:16px"><div id="ind-list"></div>`;
  app.appendChild(root);
  $("#ind-close").onclick = closeIndSheet;
  $("#ind-q").oninput = paintIndList;
  paintIndList();
}
function toggleInd(id) {
  const set = new Set(state.inds);
  if (set.has(id)) set.delete(id); else set.add(id);
  state.inds = INDS.map((i) => i.id).filter((x) => set.has(x));
  if (!state.inds.length) state.inds = [];
  try { localStorage.setItem(IND_KEY, JSON.stringify(state.inds)); } catch (_) {}
  const fx = $("#fx");
  if (fx) fx.classList.toggle("on", state.inds.length > 0);
  ensurePaneRoom();
  fillIndicators(true);
}
function styleIcon() {
  if (state.chartStyle === "line") return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 12l4-4 3 2 7-7"/></svg>`;
  return `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 2v12M5 5h3v7H5M11 3v10M11 6h3v5h-3"/></svg>`;
}
function chartToolsHtml() {
  const tools = [
    ["cross", "Crosshair", "M8 1v14M1 8h14"],
    ["trend", "Trend line", "M2 14 L14 2"],
    ["hline", "Horizontal line", "M1 8h14"],
    ["fib", "Fib retracement", "M2 3h12M2 7h12M2 11h12M2 14h12"],
    ["rect", "Rectangle", "M2 3h12v10H2z"],
    ["text", "Text", "M3 3h10M8 3v11"],
    ["erase", "Eraser, tap again to clear", "M4 12l5-8 4 4-5 8H4z"]
  ];
  return `<div class="tools" id="draw-tools">${tools.map(([id, label, d]) => `<button type="button" data-tool="${id}" class="${state.tool === id ? "on" : ""}" aria-label="${label}" title="${label}"><svg viewBox="0 0 16 16"><path d="${d}"/></svg></button>`).join("")}</div>`;
}
function tfButtons() {
  return TFS.map((x) => `<button type="button" data-tf="${x}" class="${state.tf === x ? "on" : ""}">${x}</button>`).join("");
}
function scaleButtons() {
  return `<span class="scale-btns">${[["pct", "%"], ["log", "log"], ["auto", "auto"]].map(([id, label]) => `<button type="button" data-scale="${id}" class="${state.scaleMode === id ? "on" : ""}">${label}</button>`).join("")}</span>`;
}

// Called by render(): move the persistent chart into the freshly rendered slot.
function drawChart() {
  const slot = $("#chart-slot");
  if (!slot) return;
  if (!ensureChart()) { slot.innerHTML = `<div class="k" style="padding:20px">Chart library failed to load.</div>`; return; }
  if (chartUi.host.parentNode !== slot) slot.appendChild(chartUi.host);
  parkLogo();
  setChartData();
  paintAxisEdge();
}

function bindChartResize() {
  const wrap = $("#chart-wrap");
  const grip = $("#chart-grip");
  if (!wrap || !grip) return;
  let startY = 0, startH = 0;
  grip.onpointerdown = (ev) => {
    ev.preventDefault();
    grip.setPointerCapture(ev.pointerId);
    chartUi.dragging = true;
    startY = ev.clientY;
    startH = wrap.getBoundingClientRect().height;
    wrap.classList.add("resizing");
  };
  grip.onpointermove = (ev) => {
    if (!chartUi.dragging) return;
    state.chartH = clampChartH(startH + ev.clientY - startY);
    wrap.style.height = state.chartH + "px";
  };
  const end = () => {
    if (!chartUi.dragging) return;
    chartUi.dragging = false;
    wrap.classList.remove("resizing");
    localStorage.setItem(CHART_H_KEY, String(state.chartH));
    applyPaneHeights();
    if (chartUi.pendingRender) { chartUi.pendingRender = false; render(); }
  };
  grip.onpointerup = end;
  grip.onpointercancel = end;
  grip.onlostpointercapture = end;
  grip.ondblclick = () => { state.chartH = 260; localStorage.setItem(CHART_H_KEY, "260"); wrap.style.height = "260px"; };
}
// Re-clamp to the viewport on rotation, but keep the user's saved preference.
window.addEventListener("resize", () => {
  const pref = Number(localStorage.getItem(CHART_H_KEY)) || state.chartH;
  state.chartH = clampChartH(pref);
  const w = $("#chart-wrap");
  if (w && !state.chartFull && !chartUi.dragging) w.style.height = state.chartH + "px";
  parkLogo();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.chartFull) { state.chartFull = false; render(); } });


function shortAddr(a) {
  if (!a || a.length < 8) return a || "—";
  return a.slice(0, 4) + "…" + a.slice(-4);
}
function holderAmt(n) {
  const v = Number(n) || 0;
  const a = Math.abs(v);
  if (a >= 1e12) return (v / 1e12).toFixed(2) + "T";
  if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
  return qty(v);
}
function holderPct(h, token) {
  const amt = Number(h.amount);
  if (!(amt > 0)) return null;
  const total = Number(token.totalSupply);
  const circ = Number(token.circSupply);
  // Amounts are shares of total supply. circSupply on a bonding curve is only
  // the sold float, so amount/circ prints over 100% for the curve escrow.
  const supply = total > 0 ? total : circ;
  if (!(supply > 0)) return null;
  const p = (amt / supply) * 100;
  if (!(p > 0) || p > 100.05) return null;
  return p;
}
function holderPctText(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  if (p > 0 && p < 0.01) return "<0.01%";
  return p.toFixed(2) + "%";
}
// LP and Dev only when the payload proves it. Rank is not proof.
function holderMarks(h, token) {
  const blobs = [];
  for (const raw of h.tags || []) {
    if (typeof raw === "string") blobs.push(raw);
    else if (raw) blobs.push(raw.id || "", raw.name || "");
  }
  for (const raw of h.holderTags || []) blobs.push(String(raw));
  const pool = typeof token.graduatedPool === "string" ? token.graduatedPool : "";
  const lp = (pool && h.address === pool) || blobs.some((s) => {
    const v = String(s).toLowerCase();
    return v === "pool" || v === "lp" || v.includes("liquidity pool");
  });
  const dev = (token.dev && h.address === token.dev) || blobs.some((s) => /^dev(eloper)?$/i.test(String(s)));
  return [lp ? "LP" : "", dev ? "Dev" : ""].filter(Boolean);
}
function holderRows() {
  const t = state.active || {};
  if (!state.holders.length) {
    const n = Number(t.holderCount);
    const msg = state.holdersError
      || (state.holdersLoading ? "Loading holders…" : (n > 0 ? "Addresses not in yet." : "No holders yet."));
    return `<div class="k" style="padding:12px 0">${esc(msg)}</div>`;
  }
  return state.holders.slice(0, 40).map((h, i) => {
    const addr = h.address || "";
    const tags = holderMarks(h, t).map((tag) => `<span class="htag ${tag === "LP" ? "lp" : "dev"}">${tag}</span>`).join("");
    const who = addr
      ? `<a class="haddr" href="https://solscan.io/account/${esc(addr)}" target="_blank" rel="noopener noreferrer" data-copy="${esc(addr)}">${esc(shortAddr(addr))}</a>${tags}`
      : `<span class="haddr">—</span>`;
    return `<div class="hrow"><span class="hrank">${i + 1}</span><span class="hwho">${who}</span><span class="hpct">${holderPctText(holderPct(h, t))}</span><span class="hamt">${holderAmt(h.amount)}</span></div>`;
  }).join("");
}
function paintHolders() {
  const box = $("#holder-list");
  if (!box || state.view !== "spot" || state.tab !== "holders") return;
  box.innerHTML = holderRows();
  box.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => { state.toast = "Copied"; render(); }).catch(() => {});
  });
}

function stat(win) {
  const t = state.active || {};
  return t["stats" + win] || {};
}

function revealTab() {
  const sc = document.querySelector(".scroll");
  const tabs = sc && sc.querySelector(".tabs");
  if (!sc || !tabs) return;
  sc.scrollTop = Math.max(0, tabs.offsetTop - 2);
}
function render() {
  if (chartUi.dragging) { chartUi.pendingRender = true; return; }
  const prevScroll = document.querySelector(".scroll");
  const keep = state.scrollTop != null ? state.scrollTop : (prevScroll ? prevScroll.scrollTop : 0);
  state.scrollTop = null;
  const jumpTab = state.scrollToTab;
  state.scrollToTab = false;
  const t = state.active;
  const p = activePnl();
  const hb = holdBar(p);
  const price = t ? (state.prices[t.id] || t.usdPrice || 0) : 0;
  const chg = t && p.entry ? ((price - p.entry) / p.entry) * 100 : (t?.stats24h?.priceChange || 0);
  app.innerHTML = `
    <div class="browser">
      <div class="avatar">🐨</div>
      <button class="url" id="search-open"><span class="lock">🔒</span> jup.ag</button>
      <button class="icon-btn" id="connect" aria-label="Wallet">${state.wallet ? state.wallet.slice(0, 4) : "＋"}</button>
    </div>
    <div class="scroll">
      ${state.view === "portfolio" ? portfolioView() : state.view === "alpha" ? alphaView() : `
      ${t ? tokenHead(t, price, chg) : `<div class="panel">${esc(state.status || "Search a token to trade.")}</div>`}
      ${t ? `<div class="panel trade-dock" id="trade-dock">${tradePanel()}</div>` : ""}
      <div class="tabs" role="tablist" aria-label="Token details">
        ${[["holders","Holders"],["tx","Trades"],["holdings","Holding"]].map(([id,label]) => `<button type="button" role="tab" data-tab="${id}" class="${state.tab===id?"on":""}" aria-selected="${state.tab===id}">${label}${id==="holders" && t?.holderCount ? ` <span class="tab-n">${compactCount(t.holderCount)}</span>` : ""}</button>`).join("")}
      </div>
      <div class="panel">${panel()}</div>`}
    </div>
    <div class="bar">
      <span id="bar-hold">${hb.hold}</span>
      <span id="bar-pnl" class="${hb.clsName}">${hb.pnl}</span>
    </div>
    <nav class="nav">
      <button type="button" data-nav="spot" class="${state.view==="spot"?"on":""}"><svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>Spot</button>
      <button type="button" data-nav="alpha" class="${state.view==="alpha"?"on":""}"><svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6L20 9.5l-4 4 1 5.8L12 16.6 7 19.3l1-5.8-4-4 5.4-.9z"/></svg>Alpha</button>
      <button type="button" data-nav="portfolio" class="${state.view==="portfolio"?"on":""}"><svg viewBox="0 0 24 24"><path d="M4 7h16v12H4zM8 7V5h8v2"/></svg>Portfolio</button>
    </nav>
    ${state.searchOpen ? searchSheet() : ""}
    ${state.view === "alpha" && state.alpha.open ? alphaFilterSheet() : ""}
    ${state.toast ? `<div class="toast"><span>${/^(Bought|Sold)/.test(state.toast) ? "✓ " : ""}${esc(state.toast)}</span><button id="toast-x">✕</button></div>` : ""}
  `;
  bind();
  if (state.view === "alpha") bindAlpha();
  if (state.infoOpen) openSheet(); else if (document.getElementById("sheet-root")) closeSheet();
  drawChart();
  const sc = document.querySelector(".scroll");
  if (sc) {
    if (jumpTab) revealTab();
    else if (keep) sc.scrollTop = keep;
  }
  if (state.view === "spot" && state.active) rcWant([state.active.id]);
  if (state.marketOpen) placeOrderMenu();
}

function tokenAge(iso) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.max(1, Math.floor(s)) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m";
  if (s < 86400) return Math.floor(s / 3600) + "h";
  return Math.floor(s / 86400) + "d";
}
function starList() {
  try { return JSON.parse(localStorage.getItem("trench-stars")) || []; } catch (_) { return []; }
}
function isStarred(id) { return starList().includes(id); }
function toggleStar(id) {
  const list = starList().filter((x) => x !== id);
  if (!isStarred(id)) list.push(id);
  localStorage.setItem("trench-stars", JSON.stringify(list.slice(-200)));
}
function socialHref(kind, raw) {
  const v = String(raw || "").trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  if (kind === "x") return "https://x.com/" + v.replace(/^@/, "");
  if (kind === "tg") return "https://t.me/" + v.replace(/^@/, "");
  return "";
}
function socialsHtml(t) {
  const x = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 10.3 22 2h-2.2l-6.2 7.1L8.2 2H2l7.7 11.1L2 22h2.2l6.8-7.8L15.6 22H22z"/></svg>`;
  const web = `<svg class="stroke" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.8 3.8 6 3.8 9s-1.3 6.2-3.8 9c-2.5-2.8-3.8-6-3.8-9s1.3-6.2 3.8-9z"/></svg>`;
  const tg = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 4 3 11.5l6.2 2.1L18 7.5l-7 7.2.2 4.3 3-3.2L19 18z"/></svg>`;
  const items = [
    ["x", t.twitter || t.primaryTwitter, "X", x],
    ["web", t.website, "Website", web],
    ["tg", t.telegram, "Telegram", tg]
  ];
  return items.map(([kind, raw, label, svg]) => {
    const href = socialHref(kind, raw);
    return href ? `<a class="soc" href="${esc(href)}" target="_blank" rel="noopener noreferrer" aria-label="${label}">${svg}</a>` : "";
  }).join("");
}
function rcView(t) {
  const r = t && rcGet(t.id);
  if (!r || r.missing) return { cls: "wait", mark: "…", label: "RugCheck loading" };
  if (r.level === "danger") return { cls: "bad", mark: "✕", label: "RugCheck danger" };
  return { cls: "ok", mark: "✓", label: "RugCheck safe" };
}
function rcLineInner(t) {
  const r = rcGet(t.id);
  const a = t.audit || {};
  const score = r && !r.missing && r.score != null ? String(Math.round(r.score)) : "…";
  const lp = r && !r.missing && r.lp != null ? pctShown(r.lp) : "…";
  const auth = (off) => off == null ? "—" : (off ? `<span class="ok">off</span>` : `<span class="bad">on</span>`);
  const top = pctShown(a.topHoldersPercentage);
  return `RC ${score} · LP ${lp} · Mint ${auth(a.mintAuthorityDisabled)} · Freeze ${auth(a.freezeAuthorityDisabled)} · Top ${top}`;
}
function tokenHead(t, price, chg) {
  const mint = t.id || "";
  const short = mint ? `${mint.slice(0, 4)}…${mint.slice(-4)}` : "";
  const starred = isStarred(mint);
  return `<div class="token-head">
      <div class="tok-av">${t.icon ? `<img src="${esc(iconUrl(t.icon))}" alt="" width="42" height="42">` : "●"}<button type="button" class="badge rc ${rcView(t).cls}" id="rc-badge" aria-label="${rcView(t).label}">${rcView(t).mark}</button></div>
      <div class="tok-name">
        <div class="sym">${esc(t.symbol)} <span class="tok-full">${esc(t.name || "")}</span><button type="button" class="copy" data-copy="${esc(mint)}" aria-label="Copy mint"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 16V6a2 2 0 0 1 2-2h10"/></svg></button></div>
        <div class="sub"><span class="age">${tokenAge(t.createdAt)}</span><span class="mint">${esc(short)}</span>${socialsHtml(t)}<button type="button" class="copy" id="token-search" aria-label="Search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg></button></div>
      </div>
      <div class="tok-actions">
        <button type="button" class="round" id="share" aria-label="Share"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7 8l5-5 5 5M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/></svg></button>
        <button type="button" class="round star ${starred ? "on" : ""}" id="star" aria-label="${starred ? "Unstar" : "Star"}" aria-pressed="${starred}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l2.6 5.6L20 9.5l-4 4 1 5.8L12 16.6 7 19.3l1-5.8-4-4 5.4-.9z"/></svg></button>
      </div>
    </div>
    <div class="rc-line" id="rc-line">${rcLineInner(t)}</div>
    <div class="mc-line">
      <span class="px" id="mc">${mcapText(t)}</span>
      <span class="chg ${t.stats24h?.priceChange == null ? "" : cls(t.stats24h.priceChange)}" id="chg">${moveLabel(t.stats24h?.priceChange)}</span>
    </div>
    <div class="stats">
      <div><div class="k">Price</div><div class="v" id="stat-px">${livePrice(t) == null ? "—" : priceLabel(livePrice(t))}</div></div>
      <div><div class="k">Liquidity</div><div class="v">${t.liquidity == null ? "—" : usd(t.liquidity)}</div></div>
      <div><div class="k">1h Vol</div><div class="v">${t.stats1h && (t.stats1h.buyVolume != null || t.stats1h.sellVolume != null) ? usd((Number(t.stats1h.buyVolume) || 0) + (Number(t.stats1h.sellVolume) || 0)) : "—"}</div></div>
      <div><div class="k">Fees Paid</div><div class="v fee-sol" id="stat-fees">${feeHtml(t.fees)}</div></div>
      <div><div class="k">Org Score</div><div class="v">${t.organicScore == null ? "—" : Number(t.organicScore).toFixed(1)}</div></div>
      <button type="button" class="stat-more" id="info" aria-label="Token info">⌄</button>
    </div>
    <div class="tf"><div class="tf-scroll">${tfButtons()}</div><span class="tf-tools"><button type="button" id="chart-style" class="${state.chartStyle === "line" ? "on" : ""}" aria-label="${state.chartStyle === "line" ? "Show candles" : "Show line"}">${styleIcon()}</button><button type="button" id="fx" class="${state.inds.length ? "on" : ""}" aria-label="Indicators">fx</button><button type="button" class="chart-full-btn" id="chart-full" aria-label="Full screen">⤢</button></span></div>
    <div class="chart-wrap ${state.chartFull ? "full" : ""}" id="chart-wrap" style="height:${state.chartFull ? "auto" : clampChartH(state.chartH) + "px"}">
      ${chartToolsHtml()}
      <div id="chart-slot" class="chart-slot"></div>
      <div class="chart-label" id="chart-legend"><div class="lg-sym">${esc(t.symbol)}/${state.chartMode === "mc" ? "MC" : "USD"} · ${resolvedTf()} · jup.ag</div><div class="lg-ohlc" id="ohlc"></div><div class="lg-inds" id="ind-leg"></div></div>
      ${state.chartFull ? `<div class="tf tf-full"><div class="tf-scroll">${tfButtons()}</div><button type="button" class="chart-full-btn" aria-label="Exit full screen">✕</button></div>` : `<div class="chart-grip" id="chart-grip" role="separator" aria-orientation="horizontal" aria-label="Drag to resize chart" title="Drag to resize · double-click to reset"><span></span></div>`}
    </div>
    <div class="chart-foot">${scaleButtons()}<span id="utc">${clockLabel()}</span><button type="button" id="chart-mode" class="${state.chartMode === "mc" ? "on" : ""}">${state.chartMode === "mc" ? "MCap" : "Price"} ⇄</button></div>`;
}

function panel() {
  if (state.tab === "tx") return txPanel();
  if (state.tab === "holdings") return holdingsPanel();
  return holdersPanel();
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
    const entry = entryOf(h.mint);
    const value = h.ui * price;
    const pnl = !(entry > 0) || !(price > 0)
      ? `<b>—</b><span>—</span>`
      : holdPnlHtml(value - h.ui * entry, ((price - entry) / entry) * 100);
    return `<div class="row" data-mint="${h.mint}">
      <div class="who"><div class="tok-av">${h.icon ? `<img src="${esc(iconUrl(h.icon))}" alt="">` : "●"}</div><div class="meta"><b>${esc(h.symbol || h.mint.slice(0, 4))}</b><span>—</span></div></div>
      <div><div class="hold-n">${usd(value)}</div><div class="hold-q">${qty(h.ui)}</div></div>
      <div class="pnl">${pnl}</div>
      <div class="actions"><button class="sell" data-sell="${h.mint}">Sell</button></div>
    </div>`;
  }).join("");
  return head + rows;
}

// ---------------- Alpha: Jupiter AlphaScan (New / Graduating / Graduated) ----------------
// Same feed as jup.ag/spot/alphascan (jup.ag/alpha is a 404). Snapshot: POST
// api.jup.ag/_datapi/v1/assets/gems (no key, same as their page, not the 1 RPS budget).
// Live: subscribe:assets,recent on the existing Jupiter stream. PumpPortal is only a
// fallback for the New column if that feed fails. Extra filters stay client-side.
const ALPHA_KEY = "trench-alpha";
const ALPHA_PRESETS_KEY = "trench-alpha-presets";
const ALPHA_SOURCES = [["recent", "New"], ["aboutToGraduate", "Graduating"], ["graduated", "Graduated"]];
const ALPHA_COL_KEYS = ["recent", "aboutToGraduate", "graduated"];
const GEMS_URL = "https://api.jup.ag/_datapi/v1/assets/gems";
const GEMS_BODY = JSON.stringify({ recent: { timeframe: "24h" }, aboutToGraduate: { timeframe: "24h" }, graduated: { timeframe: "24h" } });
const ALPHA_IVS = ["5m", "1h", "6h", "24h"];
const ALPHA_NUM = [
  ["mcapMin", "MCap min"], ["mcapMax", "MCap max"], ["liqMin", "Liquidity min"], ["volMin", "24h vol min"],
  ["ageMinH", "Age min (h)"], ["ageMaxH", "Age max (h)"], ["holdersMin", "Holders min"], ["top10Max", "Top-10 % max"],
  ["devMax", "Dev hold % max"], ["chgMin", "Chg % min"], ["chgMax", "Chg % max"], ["scoreMin", "Organic min"],
  ["rcMax", "RugCheck score max"]
];
const ALPHA_RC_KEYS = ["rcMax", "noDanger"];
const ALPHA_BOOL = [["noFreeze", "Freeze off"], ["noMint", "Mint off"], ["verified", "Verified"], ["noDanger", "No RugCheck dangers"]];
const ALPHA_SECS = [
  ["market", "Market", ["mcapMin", "mcapMax", "liqMin", "volMin", "chgMin", "chgMax"]],
  ["age", "Age & Holders", ["ageMinH", "ageMaxH", "holdersMin", "top10Max", "devMax"]],
  ["safety", "Safety (Audit)", ["noFreeze", "noMint", "verified", "scoreMin"]],
  ["rug", "RugCheck", ["noDanger", "rcMax"]]
];
const ALPHA_SORTS = [["mcap", "MCap"], ["liq", "Liq"], ["vol", "Vol 24h"], ["chg", "Chg"], ["age", "Age"], ["holders", "Holders"], ["top10", "Top10"], ["score", "Organic"], ["lp", "LP lock"], ["rc", "RugCheck"]];
const ALPHA_BUILTIN = {
  "Safer": { noFreeze: true, noMint: true, top10Max: "30", liqMin: "25k", holdersMin: "300", noDanger: true },
  "Fresh": { ageMaxH: "24", mcapMax: "2m", holdersMin: "100", noFreeze: true, noMint: true },
  "Movers": { chgMin: "20", volMin: "100k", liqMin: "50k" }
};
const alphaSaved = (() => { try { return JSON.parse(localStorage.getItem(ALPHA_KEY)) || {}; } catch (_) { return {}; } })();
const alphaSrcOk = (s) => ALPHA_SOURCES.some(([k]) => k === s);
state.alpha = {
  src: alphaSrcOk(alphaSaved.src) ? alphaSaved.src : "recent", iv: ALPHA_IVS.includes(alphaSaved.iv) ? alphaSaved.iv : "24h",
  sort: alphaSaved.sort || "feed", dir: alphaSaved.dir || "desc",
  ageUnit: alphaSaved.ageUnit === "m" || alphaSaved.ageUnit === "d" ? alphaSaved.ageUnit : "h",
  sec: Object.prototype.hasOwnProperty.call(alphaSaved, "sec") ? alphaSaved.sec : "market",
  f: alphaSaved.f || {}, open: false, rows: [], loading: false, err: "", at: 0,
  cols: { recent: [], aboutToGraduate: [], graduated: [] }, jupOk: false, pumpFallback: false
};
function saveAlpha() {
  const a = state.alpha;
  localStorage.setItem(ALPHA_KEY, JSON.stringify({ src: a.src, iv: a.iv, sort: a.sort, dir: a.dir, f: a.f, ageUnit: a.ageUnit, sec: a.sec }));
}
function alphaPresets() { try { return JSON.parse(localStorage.getItem(ALPHA_PRESETS_KEY)) || {}; } catch (_) { return {}; } }

function parseAmt(v) {
  if (v == null || String(v).trim() === "") return null;
  const m = String(v).trim().toLowerCase().replace(/[$,%\s]/g, "").match(/^(-?\d*\.?\d+)([kmb]?)$/);
  if (!m) return null;
  return Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
}

// ---- RugCheck (api.rugcheck.xyz): free, keyless, CORS *, ~15-request burst bucket ----
// Only GET /v1/tokens/{mint}/report/summary (~300 B). Fetched lazily for rows that pass
// the other filters, max 3 in flight, >=340 ms apart (<= 3/s), cached 30 min in memory + localStorage.
const RC_URL = "https://api.rugcheck.xyz/v1/tokens/";
const RC_STORE = "trench-rugcheck";
const RC_TTL = 30 * 60 * 1000;
const RC_MAX_INFLIGHT = 3;
const RC_GAP_MS = 340; // <= 3 req/s (RugCheck free tier)
const rc = {
  cache: (() => {
    try {
      const raw = JSON.parse(localStorage.getItem(RC_STORE)) || {};
      const now = Date.now();
      return new Map(Object.entries(raw).filter(([, v]) => v && now - v.at < RC_TTL));
    } catch (_) { return new Map(); }
  })(),
  queue: [], queued: new Set(), inflight: 0, last: 0, coolUntil: 0, saveTimer: 0, paintTimer: 0
};
function rcGet(mint) {
  const v = rc.cache.get(mint);
  return v && Date.now() - v.at < RC_TTL ? v : null;
}
function rcSave() {
  clearTimeout(rc.saveTimer);
  rc.saveTimer = setTimeout(() => {
    const entries = [...rc.cache.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, 600);
    try { localStorage.setItem(RC_STORE, JSON.stringify(Object.fromEntries(entries))); } catch (_) {}
  }, 1000);
}
function rcRepaint() {
  clearTimeout(rc.paintTimer);
  rc.paintTimer = setTimeout(() => {
    if (state.view === "alpha") paintAlphaList();
    if (state.searchOpen) paintScan();
    paintRcHead();
  }, 300);
}
function paintRcHead() {
  const t = state.active;
  const badge = document.getElementById("rc-badge");
  if (!t || !badge) return;
  const v = rcView(t);
  badge.className = "badge rc " + v.cls;
  badge.textContent = v.mark;
  badge.setAttribute("aria-label", v.label);
  const line = document.getElementById("rc-line");
  if (line) line.innerHTML = rcLineInner(t);
}
function rcWantFront(mints) {
  const want = [];
  for (const m of mints) {
    if (!m || rcGet(m) || rc.queued.has(m)) continue;
    rc.queued.add(m);
    want.push(m);
  }
  if (want.length) rc.queue = [...want, ...rc.queue];
  rcPump();
}
function rcWant(mints) { rcWantFront(mints); }
function rcPump() {
  while (rc.inflight < RC_MAX_INFLIGHT && rc.queue.length) {
    // Sliding window: never more than 3 request starts in any 1000 ms, plus the min gap.
    const now = Date.now();
    rc.starts = (rc.starts || []).filter((t) => now - t < 1000);
    const winWait = rc.starts.length >= 3 ? 1000 - (now - rc.starts[0]) + 20 : 0;
    const wait = Math.max(rc.coolUntil - now, rc.last + RC_GAP_MS - now, winWait);
    if (wait > 0) { clearTimeout(rc.timer); rc.timer = setTimeout(rcPump, wait); return; }
    const mint = rc.queue.shift();
    rc.busy = rc.busy || new Set();
    if (rc.busy.has(mint) || rcGet(mint)) { if (rcGet(mint)) rc.queued.delete(mint); continue; }
    rc.busy.add(mint);
    rc.last = now;
    rc.starts.push(now);
    rc.inflight++;
    rcFetch(mint).finally(() => { rc.inflight--; rcPump(); });
  }
}
async function rcFetch(mint) {
  let retry = false;
  try {
    const res = await fetch(RC_URL + mint + "/report/summary", { cache: "no-store" });
    if (res.status === 429) {
      retry = true;
      const ra = Number(res.headers.get("retry-after"));
      rc.coolUntil = Date.now() + (Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10000);
      if (!rc.queue.includes(mint)) rc.queue.unshift(mint);
      return;
    }
    if (!res.ok) { rc.cache.set(mint, { at: Date.now(), missing: true }); return; }
    const d = await res.json();
    const risks = (d.risks || []).map((r) => ({ name: r.name, level: r.level }));
    const level = risks.some((r) => r.level === "danger") ? "danger" : risks.some((r) => r.level === "warn") ? "warn" : "good";
    rc.cache.set(mint, {
      at: Date.now(),
      lp: typeof d.lpLockedPct === "number" ? d.lpLockedPct : null,
      score: typeof d.score_normalised === "number" ? d.score_normalised : null,
      level,
      risks: risks.slice(0, 6)
    });
  } catch (_) {
    rc.cache.set(mint, { at: Date.now() - RC_TTL + 60000, missing: true }); // retry after a minute
  } finally {
    if (!retry) rc.queued.delete(mint);
    rc.busy?.delete(mint);
    rcSave();
    rcRepaint();
  }
}

function alphaFields(t, iv) {
  const win = ALPHA_IVS.includes(iv) ? iv : "24h";
  // 24h keeps the old fallback. Other windows use only that window so a 5m filter cannot read 1h stats.
  const st = t["stats" + win] || (win === "24h" ? (t.stats1h || {}) : {});
  const s24 = t.stats24h || {};
  const volSt = win === "24h" ? s24 : (t["stats" + win] || {});
  const born = t.firstPool?.createdAt || t.createdAt;
  const a = t.audit || {};
  return {
    mcap: t.mcap ?? (t.circSupply && t.usdPrice ? t.circSupply * t.usdPrice : null),
    liq: t.liquidity ?? null,
    // Missing buy and sell volume is unknown, not zero. A real 0 still prints $0.00.
    vol: volSt.buyVolume == null && volSt.sellVolume == null
      ? null
      : (Number(volSt.buyVolume) || 0) + (Number(volSt.sellVolume) || 0),
    chg: st.priceChange ?? null,
    ageH: born ? (Date.now() - new Date(born).getTime()) / 3.6e6 : null,
    holders: t.holderCount ?? null,
    top10: a.topHoldersPercentage ?? null,
    dev: a.devBalancePercentage ?? null,
    score: t.organicScore ?? null,
    lp: rcGet(t.id)?.lp ?? null,
    rc: rcGet(t.id)?.score ?? null,
    rcLevel: rcGet(t.id)?.level || null,
    freezeOff: a.freezeAuthorityDisabled === true,
    mintOff: a.mintAuthorityDisabled === true,
    verified: !!t.isVerified
  };
}

function alphaPass(x, f) {
  const n = (k) => parseAmt(f[k]);
  const need = (val, lo, hi) => {
    if (lo == null && hi == null) return true;
    if (val == null || Number.isNaN(val)) return false; // missing data fails an active filter
    return (lo == null || val >= lo) && (hi == null || val <= hi);
  };
  return need(x.mcap, n("mcapMin"), n("mcapMax"))
    && need(x.liq, n("liqMin"), null)
    && need(x.vol, n("volMin"), null)
    && need(x.ageH, n("ageMinH"), n("ageMaxH"))
    && need(x.holders, n("holdersMin"), null)
    && need(x.top10, null, n("top10Max"))
    && need(x.dev, null, n("devMax"))
    && need(x.chg, n("chgMin"), n("chgMax"))
    && need(x.score, n("scoreMin"), null)
    && (!f.noFreeze || x.freezeOff)
    && (!f.noMint || x.mintOff)
    && (!f.verified || x.verified);
}
function alphaRcActive(f) { return parseAmt(f.rcMax) != null || !!f.noDanger; }
function alphaRcPass(x, f) {
  const hi = parseAmt(f.rcMax);
  if (hi != null && (x.rc == null || x.rc > hi)) return false;
  if (f.noDanger && x.rcLevel !== "good" && x.rcLevel !== "warn") return false;
  return true;
}
const LP_LOCK_MIN = 99.9;
// Launchpads whose program holds the curve liquidity, so it cannot be pulled. Ids seen on the AlphaScan payload, plus the names the task listed.
const CURVE_PADS = new Set(["pump.fun", "met-dbc", "raydium-launchlab", "letsbonk.fun", "letsbonk", "moonshot", "believe"]);
function alphaGraduated(t) { return !!(t && (t.graduatedAt || t.graduatedPool || t._migrated)); }
function alphaAuthOff(t) {
  const audit = t?.audit || {};
  return audit.mintAuthorityDisabled === true && audit.freezeAuthorityDisabled === true;
}
function alphaOnCurvePad(t) {
  if (!t || alphaGraduated(t)) return false;
  if (!Number.isFinite(Number(t.bondingCurve))) return false;
  const pad = String(t.launchpad || t.metaLaunchpad || "").toLowerCase();
  return CURVE_PADS.has(pad);
}
// curve = (a) program-held bonding curve and authorities off. locked = (b) graduated, LP >= 99.9, authorities off.
function alphaLiqState(t) {
  if (alphaOnCurvePad(t)) return alphaAuthOff(t) ? "curve" : "auth";
  if (!alphaGraduated(t)) return "nolp";
  if (!alphaAuthOff(t)) return "auth";
  const r = rcGet(t.id);
  if (!r) return "checking";
  if (r.missing || typeof r.lp !== "number" || r.lp < LP_LOCK_MIN) return "unlocked";
  return "locked";
}
function alphaLiqOk(s) { return s === "curve" || s === "locked"; }

function alphaList() {
  const a = state.alpha;
  const iv = ALPHA_IVS.includes(a.iv) ? a.iv : "24h";
  const feed = a.sort === "feed";
  const key = { mcap: "mcap", liq: "liq", vol: "vol", chg: "chg", age: "ageH", holders: "holders", top10: "top10", score: "score", lp: "lp", rc: "rc" }[a.sort] || "vol";
  const dir = a.dir === "asc" ? 1 : -1;
  // Hard gate, before user filters: curve with mint+freeze off, or graduated with LP locked >= 99.9 and mint+freeze off.
  const gated = a.rows.map((t) => ({ t, lp: alphaLiqState(t) }));
  const hidden = gated.filter((r) => !alphaLiqOk(r.lp)).length;
  const checking = gated.filter((r) => r.lp === "checking").length;
  const front = [];
  for (const src of [a.src, ...ALPHA_COL_KEYS.filter((k) => k !== a.src)]) {
    for (const t of (src === a.src ? a.rows : (a.cols[src] || []))) {
      if (alphaLiqState(t) === "checking") front.push(t.id);
    }
  }
  rcWantFront(front);
  const base = gated.filter((r) => alphaLiqOk(r.lp)).map((r) => ({ t: r.t, x: alphaFields(r.t, iv) })).filter((r) => alphaPass(r.x, a.f));
  if (!feed) base.sort((p, q) => {
    const u = p.x[key], v = q.x[key];
    if (u == null && v == null) return 0;
    if (u == null) return 1;
    if (v == null) return -1;
    return (u - v) * dir;
  });
  // RugCheck for the LP gate is already queued above, newest column first. User RugCheck filters only see rows that passed it.
  const rcOn = alphaRcActive(a.f) || a.sort === "lp" || a.sort === "rc";
  if (!rcOn) return { list: base, pending: 0, hidden, checking };
  const pending = base.filter((r) => !rcGet(r.t.id)).length;
  return { list: alphaRcActive(a.f) ? base.filter((r) => rcGet(r.t.id) && alphaRcPass(r.x, a.f)) : base, pending, hidden, checking };
}

let alphaSeq = 0;
function alphaBorn(t) { return new Date(t?.firstPool?.createdAt || t?.createdAt || 0).getTime(); }
function alphaSortCols() {
  const c = state.alpha.cols;
  c.recent.sort((a, b) => alphaBorn(b) - alphaBorn(a));
  c.recent.splice(30);
  c.aboutToGraduate.sort((a, b) => (b.bondingCurve || 0) - (a.bondingCurve || 0));
  c.aboutToGraduate.splice(30);
  c.graduated.sort((a, b) => new Date(b.graduatedAt || 0) - new Date(a.graduatedAt || 0));
  c.graduated.splice(30);
  state.alpha.rows = c[state.alpha.src] || [];
}
function alphaMergeSnap(key, fresh) {
  const old = state.alpha.cols[key] || [];
  const have = new Set(fresh.map((r) => r.id));
  const byId = new Map(old.map((r) => [r.id, r]));
  const merged = fresh.map((r) => {
    const o = byId.get(r.id);
    return o && o.updatedAt && r.updatedAt && new Date(o.updatedAt) > new Date(r.updatedAt) ? { ...r, ...o } : r;
  });
  // Keep a streamed launch that the 30s snapshot has not indexed yet.
  const extra = old.filter((r) => r._streamed && !have.has(r.id));
  state.alpha.cols[key] = key === "recent" ? [...extra, ...merged] : merged.concat(extra);
}
function alphaUpsert(list, row) {
  const i = list.findIndex((r) => r.id === row.id);
  if (i >= 0) list[i] = { ...list[i], ...row, _streamed: true };
  return i;
}
// Place one stream frame the way AlphaScan does: new -> New, graduated -> Graduated,
// bonding-curve inserts into Graduating only when they beat the last row.
function alphaIngest(msg) {
  const raw = msg?.asset;
  if (!raw?.id) return;
  const c = state.alpha.cols;
  const row = { ...raw, _streamed: true };
  if (msg.type === "new") {
    if (alphaUpsert(c.recent, row) < 0) c.recent.unshift(row);
  } else if (msg.type === "graduated") {
    c.recent = c.recent.filter((r) => r.id !== row.id);
    c.aboutToGraduate = c.aboutToGraduate.filter((r) => r.id !== row.id);
    if (alphaUpsert(c.graduated, row) < 0) c.graduated.unshift(row);
  } else if (msg.type === "update") {
    ALPHA_COL_KEYS.forEach((k) => alphaUpsert(c[k], row));
    if (row.graduatedPool != null) {
      c.recent = c.recent.filter((r) => r.id !== row.id);
      c.aboutToGraduate = c.aboutToGraduate.filter((r) => r.id !== row.id);
      if (alphaUpsert(c.graduated, row) < 0) c.graduated.unshift(row);
    }
  } else return;
  if (msg.type !== "graduated" && row.graduatedPool == null && row.bondingCurve > 0) {
    const g = c.aboutToGraduate;
    const i = g.findIndex((r) => r.id === row.id);
    if (i >= 0) g[i] = { ...g[i], ...row, _streamed: true };
    else {
      const floor = g.length >= 30 ? (g[g.length - 1]?.bondingCurve || 0) : 0;
      if (g.length < 30 || row.bondingCurve > floor) g.push({ ...row, _streamed: true });
    }
  }
  alphaSortCols();
}
async function gemsFetch() {
  const res = await fetch(GEMS_URL, {
    method: "POST", cache: "no-store",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: GEMS_BODY
  });
  if (!res.ok) throw new Error("gems " + res.status);
  return res.json();
}
async function loadAlpha() {
  const a = state.alpha;
  const seq = ++alphaSeq;
  a.loading = true;
  a.err = "";
  streamSync();
  paintAlphaList();
  try {
    const d = await gemsFetch();
    if (seq !== alphaSeq) return;
    a.jupOk = true;
    a.pumpFallback = false;
    pumpStop();
    for (const k of ALPHA_COL_KEYS) alphaMergeSnap(k, d?.[k]?.assets || []);
    alphaSortCols();
    a.at = Date.now();
    feedMark("alphaList");
    streamSync();
  } catch (err) {
    if (seq !== alphaSeq) return;
    a.jupOk = false;
    a.err = err.message || String(err);
    // Jupiter feed down: PumpPortal covers New only. Graduating/Graduated stay empty until it recovers.
    if (!stream.open || a.src === "recent") { a.pumpFallback = true; pumpConnect(); }
  } finally {
    if (seq === alphaSeq) { a.loading = false; paintAlphaList(); }
  }
}

function ageText(h) {
  if (h == null) return "—";
  if (h < 1) return Math.max(1, Math.round(h * 60)) + "m";
  if (h < 48) return Math.round(h) + "h";
  if (h < 24 * 60) return Math.round(h / 24) + "d";
  return Math.round(h / 24 / 30) + "mo";
}
function pctText(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n === 0) return "0%";
  const abs = Math.abs(n);
  let digits = abs >= 100 ? 0 : 1;
  let text = n.toFixed(digits);
  // -99.96 must not print as -100.
  if (abs < 100 && Math.abs(Number(text)) >= 100) {
    digits = 2;
    text = n.toFixed(digits);
  }
  // A real move must not print as +0.0% or -0.0%.
  while (digits < 3 && Number(text) === 0) {
    digits += 1;
    text = n.toFixed(digits);
  }
  if (Number(text) === 0) {
    const m = abs.toFixed(12).match(/^0\.(0*)([1-9])/);
    if (!m) return "—";
    return (n < 0 ? "-" : "+") + "0.0" + String(m[1].length).replace(/\d/g, (d) => SUB[d]) + m[2] + "%";
  }
  if (n > 0) text = "+" + text;
  return text + "%";
}

function alphaRowsHtml() {
  const a = state.alpha;
  const { list, pending, hidden = 0, checking = 0 } = alphaList();
  const note = `<div class="al-lpnote">Only coins whose liquidity can't be pulled · ${hidden} hidden (${checking} checking)</div>`;
  const head = note + `<div class="al-count">${a.loading && !a.rows.length ? "Loading…" : `${list.length} of ${a.rows.length} tokens`}${a.loading && a.rows.length ? " · refreshing" : ""}${a.at ? ` · ${new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</div>`;
  if (a.err && !a.rows.length) return head + `<div class="k" style="padding:16px 0">Couldn't load: ${esc(a.err)} <button type="button" class="copy" data-alpha-retry>Retry</button></div>`;
  if (!list.length) {
    if (checking || !a.rows.length || hidden === a.rows.length) return head;
    return head + `<div class="k" style="padding:16px 0">No tokens match these filters.</div>`;
  }
  return head + list.map(({ t, x }) => {
    const badges = [
      `<i class="b ${x.mintOff ? "ok" : "bad"}" title="Mint authority ${x.mintOff ? "disabled" : "enabled"}">M</i>`,
      `<i class="b ${x.freezeOff ? "ok" : "bad"}" title="Freeze authority ${x.freezeOff ? "disabled" : "enabled"}">F</i>`
    ].join("") + (t._migrated ? `<i class="b ok" title="Migrated from pump.fun">🎓</i>` : t._pump ? `<i class="b wait" title="New on pump.fun (PumpPortal)">pump</i>` : "");
    const lpb = lpBadge(t.id);
    return `<button type="button" class="al-row" data-alpha-open="${esc(t.id)}" data-liq="${alphaLiqState(t)}">
      <span class="al-tok"><span class="tok-av">${t.icon ? `<img src="${esc(iconUrl(t.icon))}" alt="" loading="lazy">` : "●"}</span>
        <span class="al-meta"><b>${x.verified ? `<i class="vf" title="Verified">✓</i>` : ""}${esc(t.symbol || t.id.slice(0, 4))}</b><span>${ageText(x.ageH)} ${badges}</span>${lpb ? `<span class="al-rc">${lpb}</span>` : ""}</span></span>
      <span class="al-num"><b>${usd(x.mcap)}</b><span>L ${usd(x.liq)}</span></span>
      <span class="al-num"><b>${usd(x.vol)}</b><span>${x.holders == null ? "—" : "Hld " + compactCount(x.holders)}</span></span>
      <span class="al-num"><b class="${x.chg == null ? "" : cls(x.chg)}">${pctText(x.chg)}</b><span>T10 ${x.top10 == null ? "—" : pctShown(x.top10)}</span></span>
    </button>`;
  }).join("");
}

function lpBadgeNum(lp) {
  if (lp == null || !Number.isFinite(Number(lp))) return "?";
  const v = Number(lp);
  const a = Math.abs(v);
  if (!(a > 0)) return "0";
  if (a < 0.05) return "<0.1";
  if (a < 10) return v.toFixed(1).replace(/\.0$/, "");
  // 99.9 and 99.96 must not print as 100. A real 100 stays 100.
  if (a < 100 && Math.abs(Number(v.toFixed(0))) >= 100) {
    let d = 1;
    while (d < 4 && Math.abs(Number(v.toFixed(d))) >= 100) d++;
    return v.toFixed(d).replace(/0+$/, "").replace(/\.$/, "");
  }
  return String(Math.round(v));
}
function lpBadge(mint) {
  const r = rcGet(mint);
  if (!r) return rc.queued.has(mint) ? `<i class="b wait" title="Checking RugCheck">LP…</i>` : "";
  if (r.missing) return `<i class="b wait" title="No RugCheck data">LP?</i>`;
  const lp = r.lp;
  const lpCls = lp == null ? "wait" : lp >= 90 ? "ok" : lp >= 50 ? "mid" : "bad";
  const tip = `LP locked/burned ${lp == null ? "unknown" : lp.toFixed(1) + "%"} · RugCheck ${r.score ?? "?"}${r.risks?.length ? " · " + r.risks.map((x) => x.name).join(", ") : ""}`;
  return `<i class="b ${lpCls}" title="${esc(tip)}">LP${lpBadgeNum(lp)}</i><i class="b ${r.level === "danger" ? "bad" : r.level === "warn" ? "mid" : "ok"}" title="${esc(tip)}">RC${r.score ?? "?"}</i>`;
}

function paintAlphaList() {
  const box = $("#alpha-list");
  if (!box) return;
  box.innerHTML = alphaRowsHtml();
  box.querySelectorAll("[data-alpha-open]").forEach((b) => b.onclick = () => {
    state.view = "spot";
    state.tab = "holders";
    render();
    loadToken(b.dataset.alphaOpen).catch((err) => { state.status = err.message; render(); });
  });
  const r = box.querySelector("[data-alpha-retry]");
  if (r) r.onclick = () => loadAlpha().catch(() => {});
  paintFilterChrome();
}

function alphaActiveCount() {
  const f = state.alpha.f;
  return ALPHA_NUM.filter(([k]) => parseAmt(f[k]) != null).length + ALPHA_BOOL.filter(([k]) => f[k]).length;
}
function alphaSecCount(id) {
  const keys = (ALPHA_SECS.find(([k]) => k === id) || [])[2] || [];
  const f = state.alpha.f;
  return keys.filter((k) => ALPHA_BOOL.some(([b]) => b === k) ? !!f[k] : parseAmt(f[k]) != null).length;
}
function alphaFEq(f, p) {
  const keys = new Set([...Object.keys(f || {}), ...Object.keys(p || {})]);
  for (const k of keys) {
    const av = f?.[k], bv = p?.[k];
    if (av === bv || (!av && !bv)) continue;
    return false;
  }
  return true;
}
function ageMul() {
  return state.alpha.ageUnit === "m" ? 1 / 60 : state.alpha.ageUnit === "d" ? 24 : 1;
}
// ageMinH / ageMaxH stay in hours so old saves and the Fresh preset keep working. The unit dropdown only changes what the box shows.
function ageStore(display) {
  const n = parseAmt(display);
  if (n == null) return String(display ?? "");
  return String(Math.round(n * ageMul() * 1e8) / 1e8);
}
function ageShow(stored) {
  if (stored == null || stored === "") return "";
  const n = parseAmt(stored);
  if (n == null) return String(stored);
  return String(Math.round((n / ageMul()) * 1e6) / 1e6);
}
function paintFilterChrome() {
  const n = alphaActiveCount();
  const cnt = document.getElementById("alpha-fcount");
  if (cnt) { cnt.textContent = n ? String(n) : ""; cnt.hidden = !n; }
  document.querySelectorAll("[data-sec-n]").forEach((el) => {
    const c = alphaSecCount(el.dataset.secN);
    el.textContent = c ? String(c) : "";
    el.hidden = !c;
  });
  const ap = document.querySelector("[data-alpha-apply] .n");
  if (ap) ap.textContent = n ? "(" + n + ")" : "";
}
function afInput(key, placeholder) {
  const age = key === "ageMinH" || key === "ageMaxH";
  const val = age ? ageShow(state.alpha.f[key]) : (state.alpha.f[key] ?? "");
  return `<input data-alpha-f="${key}" value="${esc(val)}" inputmode="decimal" autocomplete="off" placeholder="${esc(placeholder)}">`;
}
function afSwitch(key, label) {
  return `<label class="af-sw"><input type="checkbox" data-alpha-b="${key}" ${state.alpha.f[key] ? "checked" : ""}><span class="knob"></span><span>${label}</span></label>`;
}

function alphaFilterSheet() {
  const a = state.alpha;
  const presets = { ...ALPHA_BUILTIN, ...alphaPresets() };
  const user = alphaPresets();
  const n = alphaActiveCount();
  const iv = ALPHA_IVS.includes(a.iv) ? a.iv : "24h";
  const unit = a.ageUnit || "h";
  const sortOpts = [["feed", "Feed order"], ...ALPHA_SORTS];
  const bodies = {
    market: `<label class="af-field">Vol / Chg window
        <select data-alpha-iv>${ALPHA_IVS.map((w) => `<option value="${w}"${w === iv ? " selected" : ""}>${w}</option>`).join("")}</select>
      </label>
      <div class="af-lab">MCap</div>
      <div class="af-pair">${afInput("mcapMin", "e.g. 50k")}<span>–</span>${afInput("mcapMax", "e.g. 2m")}</div>
      <div class="af-row">
        <label class="af-field">Liquidity min${afInput("liqMin", "e.g. 25k")}</label>
        <label class="af-field">${iv} Vol min${afInput("volMin", "e.g. 100k")}</label>
      </div>
      <div class="af-lab">Chg % (${iv})</div>
      <div class="af-pair">${afInput("chgMin", "e.g. 20")}<span>–</span>${afInput("chgMax", "e.g. 500")}</div>`,
    age: `<div class="af-age">
        <label class="af-field">Age min${afInput("ageMinH", "e.g. 5")}</label>
        <label class="af-field">Age max${afInput("ageMaxH", "e.g. 24")}</label>
        <label class="af-field">Unit
          <select data-alpha-age-unit>
            <option value="m"${unit === "m" ? " selected" : ""}>m</option>
            <option value="h"${unit === "h" ? " selected" : ""}>h</option>
            <option value="d"${unit === "d" ? " selected" : ""}>d</option>
          </select>
        </label>
      </div>
      <div class="af-row">
        <label class="af-field">Holders min${afInput("holdersMin", "e.g. 100")}</label>
        <label class="af-field">Top-10 % max${afInput("top10Max", "e.g. 30")}</label>
      </div>
      <label class="af-field">Dev hold % max${afInput("devMax", "e.g. 5")}</label>`,
    safety: `<div class="af-bools">
        ${afSwitch("noFreeze", "Freeze off")}${afSwitch("noMint", "Mint off")}${afSwitch("verified", "Verified")}
      </div>
      <label class="af-field">Organic score min${afInput("scoreMin", "e.g. 50")}</label>`,
    rug: `${afSwitch("noDanger", "No dangers")}
      <label class="af-field">RugCheck score max${afInput("rcMax", "e.g. 20")}</label>
      <div class="k af-note">Score and danger flags load slowly (max 3/s, cached 30 min). Lower score is safer. The list only shows a coin when a launchpad bonding curve still holds the liquidity and mint plus freeze are off, or RugCheck confirms at least 99.9% of LP is locked or burned and mint plus freeze are off. <a href="https://rugcheck.xyz" target="_blank" rel="noopener">RugCheck.xyz</a></div>`
  };
  const secs = ALPHA_SECS.map(([id, title]) => {
    const c = alphaSecCount(id);
    const on = a.sec === id;
    return `<button type="button" class="af-sec${on ? " on" : ""}" data-alpha-sec="${id}" aria-expanded="${on}">
      <span>${title}</span><span class="af-badge" data-sec-n="${id}" ${c ? "" : "hidden"}>${c || ""}</span><span class="chev">${on ? "▴" : "▾"}</span>
    </button>${on ? `<div class="af-body">${bodies[id]}</div>` : ""}`;
  }).join("");
  const presetHtml = Object.keys(presets).map((name) => {
    const on = alphaFEq(a.f, presets[name]);
    return `<span class="preset"><button type="button" data-alpha-preset="${esc(name)}" class="${on ? "on" : ""}">${esc(name)}</button>${user[name] ? `<button type="button" class="x" data-alpha-del="${esc(name)}" aria-label="Delete preset">✕</button>` : ""}</span>`;
  }).join("");
  return `<div class="sheet-root open af-root" id="alpha-sheet">
    <div class="sheet-backdrop" data-alpha-apply></div>
    <div class="sheet af-sheet" role="dialog" aria-label="Alpha filters">
      <div class="sheet-head"><div class="grab"></div><h2>Filters</h2><button type="button" class="sheet-x" data-alpha-apply aria-label="Close">✕</button></div>
      <div class="af-top">
        <div class="chips small presets-row">${presetHtml}</div>
        <div class="af-sortrow">
          <label class="af-field">Sort
            <select data-alpha-sort-sel>${sortOpts.map(([k, l]) => `<option value="${k}"${a.sort === k ? " selected" : ""}>${k === "vol" ? "Vol " + iv : l}</option>`).join("")}</select>
          </label>
          <button type="button" data-alpha-dir class="af-dir" aria-label="Sort direction">${a.dir === "asc" ? "Asc ↑" : "Desc ↓"}</button>
        </div>
      </div>
      <div class="sheet-body">${secs}</div>
      <div class="af-foot">
        <button type="button" data-alpha-clear>Reset</button>
        <button type="button" data-alpha-save>Save</button>
        <button type="button" class="apply" data-alpha-apply>Apply <span class="n">${n ? "(" + n + ")" : ""}</span></button>
      </div>
    </div>
  </div>`;
}

function alphaView() {
  const a = state.alpha;
  const n = alphaActiveCount();
  const ivLabel = ALPHA_IVS.includes(a.iv) ? a.iv : "24h";
  const feedNote = a.pumpFallback ? `<div class="k al-feed">Jupiter feed failed — New is on PumpPortal until it recovers.</div>` : "";
  return `<div class="alpha">
    <div class="al-top"><h2>Alpha</h2><button type="button" class="al-refresh" data-alpha-refresh aria-label="Refresh">↻</button></div>
    <div class="chips">${ALPHA_SOURCES.map(([k, l]) => `<button type="button" data-alpha-src="${k}" class="${a.src === k ? "on" : ""}">${l}</button>`).join("")}</div>
    <div class="al-tools">
      <button type="button" class="al-filter-btn ${a.open ? "on" : ""}" data-alpha-filters>Filters <span id="alpha-fcount" class="af-badge" ${n ? "" : "hidden"}>${n || ""}</span></button>
    </div>
    ${feedNote}
    <div class="al-head">${[["age", "Token · age"], ["mcap", "MCap / Liq"], ["vol", `Vol ${ivLabel}`], ["chg", `Chg ${ivLabel}`]].map(([k, l]) => `<button type="button" data-alpha-sort="${k}" class="${a.sort === k ? "on" : ""}">${l}${a.sort === k ? (a.dir === "asc" ? " ↑" : " ↓") : ""}</button>`).join("")}</div>
    <div id="alpha-list">${alphaRowsHtml()}</div>
  </div>`;
}

function bindAlpha() {
  const a = state.alpha;
  const rerender = () => { saveAlpha(); render(); };
  document.querySelectorAll("[data-alpha-src]").forEach((b) => b.onclick = () => {
    if (a.src === b.dataset.alphaSrc) return;
    a.src = b.dataset.alphaSrc;
    a.rows = a.cols[a.src] || [];
    rerender();
  });
  document.querySelectorAll("[data-alpha-sort]").forEach((b) => b.onclick = () => {
    const k = b.dataset.alphaSort;
    if (a.sort === k) a.dir = a.dir === "asc" ? "desc" : "asc";
    else { a.sort = k; a.dir = k === "age" || k === "top10" || k === "rc" ? "asc" : "desc"; }
    rerender();
  });
  const fb = $("[data-alpha-filters]");
  if (fb) fb.onclick = () => { a.open = !a.open; render(); };
  const rf = $("[data-alpha-refresh]");
  if (rf) rf.onclick = () => { loadAlpha().catch(() => {}); };
  const sortSel = document.querySelector("[data-alpha-sort-sel]");
  if (sortSel) sortSel.onchange = () => {
    const k = sortSel.value;
    a.sort = k;
    if (k === "age" || k === "top10" || k === "rc") a.dir = "asc";
    else if (k !== "feed") a.dir = "desc";
    rerender();
  };
  const dir = document.querySelector("[data-alpha-dir]");
  if (dir) dir.onclick = () => { a.dir = a.dir === "asc" ? "desc" : "asc"; rerender(); };
  const ivSel = document.querySelector("[data-alpha-iv]");
  if (ivSel) ivSel.onchange = () => { if (ALPHA_IVS.includes(ivSel.value)) a.iv = ivSel.value; rerender(); };
  const unitSel = document.querySelector("[data-alpha-age-unit]");
  if (unitSel) unitSel.onchange = () => {
    if (unitSel.value === "m" || unitSel.value === "h" || unitSel.value === "d") a.ageUnit = unitSel.value;
    rerender();
  };
  document.querySelectorAll("[data-alpha-sec]").forEach((b) => b.onclick = () => {
    a.sec = a.sec === b.dataset.alphaSec ? "" : b.dataset.alphaSec;
    rerender();
  });
  document.querySelectorAll("[data-alpha-apply]").forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    a.open = false;
    render();
  });
  // Typing only repaints the list so the input keeps focus. Age boxes store hours.
  document.querySelectorAll("[data-alpha-f]").forEach((i) => i.oninput = () => {
    const k = i.dataset.alphaF;
    a.f[k] = (k === "ageMinH" || k === "ageMaxH") ? ageStore(i.value) : i.value;
    i.classList.toggle("bad", i.value.trim() !== "" && parseAmt(i.value) == null);
    saveAlpha();
    paintAlphaList();
  });
  document.querySelectorAll("[data-alpha-b]").forEach((i) => i.onchange = () => { a.f[i.dataset.alphaB] = i.checked; saveAlpha(); paintAlphaList(); });
  const clr = $("[data-alpha-clear]");
  if (clr) clr.onclick = () => { a.f = {}; rerender(); };
  const sv = $("[data-alpha-save]");
  if (sv) sv.onclick = () => {
    const name = (prompt("Preset name") || "").trim().slice(0, 24);
    if (!name) return;
    const all = alphaPresets();
    all[name] = { ...a.f };
    localStorage.setItem(ALPHA_PRESETS_KEY, JSON.stringify(all));
    state.toast = "Saved preset " + name;
    render();
  };
  document.querySelectorAll("[data-alpha-preset]").forEach((b) => b.onclick = () => {
    const n = b.dataset.alphaPreset;
    const p = alphaPresets()[n] || ALPHA_BUILTIN[n];
    if (!p) return;
    a.f = { ...p };
    a.open = true;
    rerender();
  });
  document.querySelectorAll("[data-alpha-del]").forEach((b) => b.onclick = (ev) => {
    ev.stopPropagation();
    const all = alphaPresets();
    delete all[b.dataset.alphaDel];
    localStorage.setItem(ALPHA_PRESETS_KEY, JSON.stringify(all));
    render();
  });
}

function portfolioView() {
  const w = state.wallet;
  const solPx = state.prices[SOL] || 0;
  const tokUsd = state.holdings.reduce((n, h) => n + h.ui * (state.prices[h.mint] || 0), 0);
  const total = state.sol * solPx + tokUsd;
  const top = `<div class="token-head"><div class="tok-name"><div class="sym">Portfolio</div>
      <div class="sub">${w ? `<span>${w.slice(0, 4)}…${w.slice(-4)}</span><button type="button" class="copy" data-copy="${w}" aria-label="Copy">⧉</button>` : `<span>No wallet connected</span>`}</div></div>
      <div class="mc"><div class="px" id="pf-total">${w ? usd(total) : "—"}</div><div class="k">Net worth</div></div></div>`;
  if (!w) return top + `<div class="panel">${connectPrompt("Connect your Solana wallet (Jupiter, Phantom, Solflare, Backpack…) to see your balances.")}</div>`;
  const solRow = `<div class="row" data-pf-sol><div class="who"><div class="tok-av"><img src="${SOL_ICON}" alt=""></div><div class="meta"><b>SOL</b><span>${usd(solPx)}</span></div></div>
      <div><div class="hold-n">${usd(state.sol * solPx)}</div><div class="hold-q">${solText(state.sol)}</div></div><div></div><div></div></div>`;
  return top + `<div class="panel">${solRow}${holdingsPanel()}</div>`;
}

function quoteBits(q) {
  const plan = Array.isArray(q?.routePlan) ? q.routePlan : [];
  const labels = [];
  for (const s of plan) {
    const label = s?.swapInfo?.label;
    if (label && !labels.includes(label)) labels.push(label);
  }
  const parts = [];
  if (labels.length) parts.push(labels.join(" · "));
  const impact = Number(q?.priceImpact);
  if (Number.isFinite(impact)) parts.push("Impact " + signed(impact) + "%");
  const fee = Number(q?.feeBps);
  if (Number.isFinite(fee) && fee > 0) parts.push("Fee " + (fee / 100).toFixed(2) + "%");
  return { hops: plan.length, line: parts.join(" · ") };
}
function paintQuoteExtras() {
  const bits = quoteBits(state.quote);
  const n = $("#route-n");
  if (n) {
    n.hidden = !bits.hops;
    if (bits.hops) n.textContent = String(bits.hops);
  }
  const det = $("#quote-detail");
  if (det) {
    const show = state.quoteOpen && !!bits.line;
    det.hidden = !show;
    det.textContent = show ? bits.line : "";
  }
}
function quoteSummary() {
  const t = state.active;
  if (!t) return "—";
  if (state.quote?.errorMessage && state.wallet) return `<span class="down">${esc(state.quote.errorMessage)}</span>`;
  if (!state.quote?.outAmount) return state.quoting ? "…" : "—";
  const outDec = state.side === "buy" ? (t.decimals || 6) : 9;
  const outUi = ui(state.quote.outAmount, outDec);
  const qUsd = Number(state.quote.outUsdValue);
  const inQuote = Number(state.quote.inUsdValue);
  const solPx = Number(state.prices[SOL]) || 0;
  const tokPx = livePrice(t) || 0;
  // A missing token price makes Jupiter report $0 out. That is not a -100% fill.
  let outUsd = qUsd > 0 ? qUsd : 0;
  if (!(outUsd > 0)) outUsd = state.side === "buy" ? outUi * tokPx : outUi * solPx;
  let inUsd = inQuote > 0 ? inQuote : 0;
  if (!(inUsd > 0)) inUsd = state.side === "buy" ? Number(state.amount) * solPx : sellTokens() * tokPx;
  const pct = outUsd > 0 && inUsd > 0 ? ((outUsd - inUsd) / inUsd) * 100 : null;
  const icon = state.side === "buy" ? (t.icon ? `<img src="${esc(iconUrl(t.icon))}" alt="">` : "●") : `<img src="${SOL_ICON}" alt="">`;
  const more = quoteBits(state.quote).line
    ? `<button type="button" id="est-more" aria-label="Route details" aria-expanded="${state.quoteOpen}"><span class="chev">${state.quoteOpen ? "⌄" : "›"}</span></button>`
    : "";
  const usdBit = outUsd > 0 ? usd(outUsd) : "—";
  const pctBit = pct == null ? `<span class="est-usd">—</span>` : `<span class="${cls(pct)}">(${signed(pct)}%)</span>`;
  return `<span class="mini">${icon}</span><b>${qty(outUi)}</b> <span class="est-usd">${usdBit}</span> ${pctBit}${more}`;
}
function tradePanel() {
  const t = state.active;
  if (!t) return "";
  const bal = tradeBal();
  const balIcon = iconUrl(state.side === "buy" ? SOL_ICON : t.icon);
  const label = goLabel();
  const engine = state.orderType === "market" ? "Jupiter Swap" : "Jupiter Trigger";
  return `<div class="trade-top">
      <span class="bal"><span class="mini">${balIcon ? `<img src="${balIcon}" alt="">` : "●"}</span> <span id="trade-bal">${bal}</span></span>
      <span class="trade-right"><span class="market-wrap"><button class="market" type="button" id="market" aria-expanded="${state.marketOpen}">${orderTypeLabel()} <span>▾</span></button>${orderMenu()}</span>
      <div class="seg">
        <button class="buy ${state.side==="buy"?"on":""}" data-side="buy">Buy</button>
        <button class="sell ${state.side==="sell"?"on":""}" data-side="sell">Sell</button>
      </div></span>
    </div>
    <div class="presets">${state.side === "buy" ? [0.1, 0.5, 1, 10].map((n)=>`<button data-amt="${n}" class="${Number(state.amount)===n?"on":""}">${n < 1 ? n.toFixed(1) : String(n)}</button>`).join("") : [10, 25, 50, 100].map((n)=>`<button data-pct="${n}" class="${Number(state.sellPct)===n?"on":""}">${n}%</button>`).join("")}</div>
    <div class="amt-row">
      <label class="amt-box"><span class="k">${state.side === "buy" ? "AMOUNT" : "PERCENT"}</span><input id="amt" inputmode="decimal" value="${state.side === "buy" ? state.amount : state.sellPct}">${state.side === "buy" ? `<span class="mini"><img src="${SOL_ICON}" alt=""></span>` : `<span class="pct-unit">%</span>`}</label>
      <button class="go ${state.side}" id="go" ${state.busy ? "disabled" : ""}>${state.busy ? "…" : label}</button>
    </div>
    ${orderFields()}
    <div class="fine"><span>Est. Received <span class="badge" id="route-n" hidden></span></span><span id="est" class="est-right">${quoteSummary()}</span></div>
    <div class="quote-detail" id="quote-detail" hidden></div>
    <div class="ultra">✦ ${engine} · <span id="status">${esc(state.status)}</span></div>`;
}

function tapeRows() {
  const t = state.active || {};
  const supply = t.circSupply || 0;
  let rows = state.tape.slice();
  if (state.txFilter === "You") rows = rows.filter((x) => state.wallet && x.traderAddress === state.wallet);
  else if (state.txFilter === "Dev") rows = rows.filter((x) => t.dev && x.traderAddress === t.dev);
  else if (state.txFilter !== "All") {
    const key = state.txFilter.toLowerCase();
    rows = rows.filter((x) => (x.walletCategories || []).some((c) => String(c).toLowerCase().includes(key)));
  }
  const dir = state.txDir === "asc" ? 1 : -1;
  rows.sort((a, b) => {
    const va = state.txSort === "mc" ? (a.usdPrice || 0) : (a.timestamp || 0);
    const vb = state.txSort === "mc" ? (b.usdPrice || 0) : (b.timestamp || 0);
    return (va - vb) * dir;
  });
  if (!rows.length) return `<div class="k" style="padding:12px 0">No ${state.txFilter.toLowerCase()} trades in the latest tape.</div>`;
  return rows.slice(0, 40).map((x) => {
    const buy = x.type === "buy";
    const mc = supply && x.usdPrice ? usd(supply * x.usdPrice) : "—";
    const addr = x.traderAddress || "";
    const trader = addr
      ? `<a class="trader" href="https://solscan.io/account/${esc(addr)}" target="_blank" rel="noopener noreferrer" aria-label="Trader on Solscan">${esc(addr.slice(-4))}</a>`
      : `<span class="trader">—</span>`;
    return `<div class="trow"><span class="age">${ageLabel(x.timestamp)}</span><span>${mc}</span><span class="${buy ? "up" : "down"}">${qty(x.amount)}</span><span class="vol ${buy ? "up" : "down"}">${tapeVol(x.usdVolume)}</span>${trader}</div>`;
  }).join("");
}

function txPanel() {
  const chips = ["All", "You", "Dev"];
  const arrow = (k) => state.txSort === k ? (state.txDir === "asc" ? " ↑" : " ↓") : "";
  return `<div class="filters">${chips.map((f) => `<button data-txf="${f}" class="${state.txFilter === f ? "on" : ""}">${f}</button>`).join("")}</div>
    <div class="tcols"><button type="button" data-txsort="age">Age${arrow("age")}</button><button type="button" data-txsort="mc">MC${arrow("mc")}</button><span>${esc(state.active?.symbol || "")}</span><span>Vol</span><span>Trader</span></div>
    <div id="tape">${state.tape.length ? tapeRows() : `<div class="k">Loading trades…</div>`}</div>`;
}

function holdersPanel() {
  const t = state.active || {};
  const audit = t.audit || {};
  const top = audit.topHoldersPercentage;
  const mint = t.id || "";
  const bubble = mint
    ? `<a class="bubblemaps" href="https://app.bubblemaps.io/sol/token/${esc(mint)}" target="_blank" rel="noopener noreferrer">Bubblemaps</a>`
    : "";
  return `<div class="holder-stats holder-head">
      <div>Holders: ${(t.holderCount || 0).toLocaleString()} &nbsp; Top 10: <span class="down">${top != null ? top.toFixed(2) + "%" : "—"}</span></div>
      ${bubble}
    </div>
    <div class="hcols"><span>#</span><span>Address</span><span>Supply</span><span>Amount</span></div>
    <div id="holder-list">${holderRows()}</div>`;
}

// ---- Token Info sheet: a persistent overlay outside #app, so re-renders never touch it ----
// Change fields from datapi (stats5m/1h/6h/24h) are already percent points, not fractions.
// fees is SOL. bondingCurve is a 0–100 percent; graduated tokens are not still on the curve.
const netTrend = { mint: "", samples: { "5m": [], "1h": [], "6h": [], "24h": [] } };
let netTrendTimer = 0;
function onCurve(t) {
  if (!t || t.bondingCurve == null || !Number.isFinite(Number(t.bondingCurve))) return false;
  if (t.graduatedAt || t.graduatedPool) return false;
  return Number(t.bondingCurve) < 100;
}
function solAmt(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const a = Math.abs(Number(n));
  if (a === 0) return "0";
  if (a >= 999.995e9) return (a / 1e12).toFixed(2) + "T";
  if (a >= 999.995e6) return (a / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (a / 1e6).toFixed(2) + "M";
  if (a >= 1000) return (a / 1000).toFixed(a >= 10000 ? 1 : 2) + "K";
  if (a >= 100) return a.toFixed(1);
  if (a >= 1) return a.toFixed(2);
  if (a >= 0.01) return a.toFixed(3);
  if (a >= 0.001) return a.toFixed(4).replace(/0+$/, "");
  // The header cell clips "0.000157" to "0.0000". Use the price subscript so a real fee is not a fake zero.
  const m = a.toFixed(12).match(/^0\.(0*)([1-9]\d?)/);
  if (m && m[1].length >= 2) return "0.0" + String(m[1].length).replace(/\d/g, (d) => SUB[d]) + m[2];
  return a.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}
function shareText(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "0.00%";
  if (Math.abs(v) < 0.01) return "<0.01%";
  return v.toFixed(2) + "%";
}
// Header and Alpha rows are one line. An integer round turns 0.70 into 1 and 99.6 into 100.
function pctShown(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  const abs = Math.abs(v);
  if (abs === 0) return "0%";
  if (abs < 0.01) return "<0.01%";
  if (abs < 1) return v.toFixed(2) + "%";
  if (abs < 10) {
    let text = v.toFixed(1);
    if (Math.abs(Number(text)) >= 10) text = v.toFixed(2);
    return text.replace(/\.0$/, "") + "%";
  }
  if (abs < 100 && Math.abs(Math.round(v)) >= 100) return v.toFixed(2).replace(/0$/, "").replace(/\.$/, "") + "%";
  return Math.round(v) + "%";
}
// Buy and sell pills share one basis so 100% Buy is never paired with a dash.
function splitPct(a, b) {
  const aOk = a != null && Number.isFinite(Number(a));
  const bOk = b != null && Number.isFinite(Number(b));
  if (!aOk && !bOk) return null;
  const av = aOk ? Number(a) : 0;
  const bv = bOk ? Number(b) : 0;
  if (!(av + bv > 0)) return null;
  const left = Math.round(100 * av / (av + bv));
  return [left, 100 - left];
}
function shareShown(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  return Math.abs(v) < 0.01 ? 0 : Number(v.toFixed(2));
}
function sheetPct(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "0.00%";
  let d = 2;
  while (d < 6 && Number(v.toFixed(d)) === 0) d++;
  if (Number(v.toFixed(d)) === 0) return "—";
  return signed(v, d) + "%";
}
function deltaText(n) {
  if (n == null || !Number.isFinite(Number(n))) return "-";
  return sheetPct(n);
}
function deltaCls(n) {
  if (n == null || !Number.isFinite(Number(n))) return "v flat";
  return "v " + cls(Number(n));
}
function noteNetTrend() {
  const t = state.active;
  if (!t || !document.getElementById("sheet-root")) return;
  if (netTrend.mint !== t.id) {
    netTrend.mint = t.id;
    netTrend.samples = { "5m": [], "1h": [], "6h": [], "24h": [] };
  }
  const now = Date.now();
  for (const w of ["5m", "1h", "6h", "24h"]) {
    const s = t["stats" + w];
    if (!s || (s.buyVolume == null && s.sellVolume == null)) continue;
    const v = (Number(s.buyVolume) || 0) - (Number(s.sellVolume) || 0);
    if (!Number.isFinite(v)) continue;
    const arr = netTrend.samples[w];
    const last = arr[arr.length - 1];
    if (last && last.v === v && now - last.t < 3000) continue;
    arr.push({ t: now, v });
    if (arr.length > 80) arr.shift();
  }
}
function armNetTrend() {
  if (netTrendTimer) return;
  netTrendTimer = setInterval(() => {
    if (!document.getElementById("sheet-root")) { stopNetTrend(); return; }
    noteNetTrend();
    drawNetTrend();
  }, 3000);
}
function stopNetTrend() {
  if (netTrendTimer) { clearInterval(netTrendTimer); netTrendTimer = 0; }
}
function drawNetTrend() {
  const box = document.getElementById("net-trend");
  if (!box) return;
  const arr = netTrend.samples[state.infoWin] || [];
  if (arr.length < 2) {
    if (!box.querySelector(".collecting")) box.innerHTML = '<div class="collecting">collecting…</div>';
    return;
  }
  const w = Math.max(120, box.clientWidth || 320);
  const h = 96;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let canvas = box.querySelector("canvas");
  if (!canvas) {
    box.innerHTML = "";
    canvas = document.createElement("canvas");
    box.appendChild(canvas);
  }
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const vals = arr.map((p) => p.v);
  const rawLo = Math.min(...vals), rawHi = Math.max(...vals);
  let lo = rawLo, hi = rawHi;
  if (lo === hi) {
    const pad = Math.max(Math.abs(lo) * 0.05, 1);
    lo -= pad;
    hi += pad;
  }
  const crosses = rawLo < 0 && rawHi > 0;
  if (crosses) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
  const top = 16, bot = h - 16;
  const yOf = (v) => top + (hi - v) / (hi - lo) * (bot - top);
  const xOf = (i) => (i / (arr.length - 1)) * (w - 8) + 4;
  const zeroY = crosses ? yOf(0) : bot;
  ctx.save();
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = "rgba(255,255,255,.18)";
  ctx.beginPath();
  ctx.moveTo(0, top); ctx.lineTo(w, top);
  ctx.moveTo(0, bot); ctx.lineTo(w, bot);
  if (crosses) { ctx.moveTo(0, zeroY); ctx.lineTo(w, zeroY); }
  ctx.stroke();
  ctx.restore();
  ctx.beginPath();
  arr.forEach((p, i) => { const x = xOf(i), y = yOf(p.v); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.lineTo(xOf(arr.length - 1), zeroY);
  ctx.lineTo(xOf(0), zeroY);
  ctx.closePath();
  if (!crosses) {
    const up = vals[vals.length - 1] >= 0;
    const grad = ctx.createLinearGradient(0, top, 0, bot);
    grad.addColorStop(0, up ? "rgba(61,220,132,.40)" : "rgba(255,77,141,.08)");
    grad.addColorStop(1, up ? "rgba(61,220,132,.04)" : "rgba(255,77,141,.40)");
    ctx.fillStyle = grad;
    ctx.fill();
  } else {
    const zy = yOf(0);
    ctx.save();
    ctx.clip();
    ctx.fillStyle = "rgba(61,220,132,.32)";
    ctx.fillRect(0, 0, w, zy);
    ctx.fillStyle = "rgba(255,77,141,.32)";
    ctx.fillRect(0, zy, w, h - zy);
    ctx.restore();
  }
  ctx.lineWidth = 1.6;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (let i = 1; i < arr.length; i++) {
    ctx.strokeStyle = (vals[i - 1] + vals[i]) / 2 >= 0 ? "#3DDC84" : "#ff4d8d";
    ctx.beginPath();
    ctx.moveTo(xOf(i - 1), yOf(vals[i - 1]));
    ctx.lineTo(xOf(i), yOf(vals[i]));
    ctx.stroke();
  }
  ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.fillStyle = "rgba(243,245,247,.8)";
  ctx.textBaseline = "top";
  ctx.fillText(usd(vals[vals.length - 1]), 2, 1);
  ctx.textBaseline = "bottom";
  ctx.fillText(usd(rawLo), 2, h - 1);
}
function sheetVals() {
  const t = state.active || {};
  const audit = t.audit || {};
  const s = stat(state.infoWin);
  const buy = Number(s.buyVolume) || 0, sell = Number(s.sellVolume) || 0;
  const volSum = buy + sell;
  // Volume share when we have it; otherwise buyer/seller counts. Never mix the two.
  const pair = splitPct(s.buyVolume, s.sellVolume) || splitPct(s.numBuys, s.numSells);
  const buyPct = pair ? pair[0] : null;
  const sellPct = pair ? pair[1] : null;
  const curveOn = onCurve(t);
  const snipOn = audit.sniperPct != null && Number.isFinite(Number(audit.sniperPct));
  return {
    title: (t.name || t.symbol || "").replace(/\s*token\s*$/i, "") + " Token Info",
    price: (() => { const px = livePrice(t); return px == null ? "—" : priceLabel(px); })(), fdv: t.fdv > 0 ? usd(t.fdv) : (t.mcap > 0 ? usd(t.mcap) : "—"), liq: usd(t.liquidity),
    holders: t.holderCount != null ? Number(t.holderCount).toLocaleString() : "—",
    fees: solAmt(t.fees),
    curve: curveOn ? Number(t.bondingCurve).toFixed(2) + "%" : "",
    curveOn,
    vol: usd(volSum), net: usd(buy - sell), netCls: cls(buy - sell),
    buyPct, sellPct,
    buyTxt: buyPct == null ? "—" : buyPct + "% Buy",
    sellTxt: sellPct == null ? "—" : sellPct + "% Sell",
    traders: s.numTraders != null ? Number(s.numTraders).toLocaleString() : "—",
    netBuyers: s.numNetBuyers != null ? Number(s.numNetBuyers).toLocaleString() : "—",
    volD: deltaText(s.volumeChange), volDCls: deltaCls(s.volumeChange),
    liqD: deltaText(s.liquidityChange), liqDCls: deltaCls(s.liquidityChange),
    holdD: deltaText(s.holderChange), holdDCls: deltaCls(s.holderChange),
    top10: shareText(audit.topHoldersPercentage),
    top10Cls: shareShown(audit.topHoldersPercentage) > 0 ? "down" : "flat",
    dev: shareText(audit.devBalancePercentage),
    devCls: shareShown(audit.devBalancePercentage) == null ? "flat" : (shareShown(audit.devBalancePercentage) > 0 ? "down" : "up"),
    snip: snipOn ? Number(audit.sniperPct).toFixed(2) + "%" : "",
    snipOn, snipCls: snipOn && Number(audit.sniperPct) > 0 ? "down" : "up",
    freeze: audit.freezeAuthorityDisabled == null ? "—" : (audit.freezeAuthorityDisabled ? "No" : "Yes"),
    freezeCls: audit.freezeAuthorityDisabled == null ? "flat" : (audit.freezeAuthorityDisabled ? "up" : "down"),
    mint: audit.mintAuthorityDisabled == null ? "—" : (audit.mintAuthorityDisabled ? "No" : "Yes"),
    mintCls: audit.mintAuthorityDisabled == null ? "flat" : (audit.mintAuthorityDisabled ? "up" : "down"),
    wins: Object.fromEntries(["5m", "1h", "6h", "24h"].map((w) => {
      const n = stat(w).priceChange;
      return [w, n == null || !Number.isFinite(Number(n)) ? null : Number(n)];
    }))
  };
}
function sheetHtml() {
  const f = (k, label, extra = "") => `<div><div class="k">${label}</div><div class="v ${extra}" data-sf="${k}"></div></div>`;
  return `<div class="sheet-backdrop" data-sheet-close></div>
  <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet-head" id="sheet-head"><div class="grab"></div><h2 id="sheet-title" data-sf="title"></h2>
      <button type="button" class="sheet-x" data-sheet-close aria-label="Close">✕</button></div>
    <div class="sheet-body" id="sheet-body">
      <div class="grid3">${f("price", "Price")}${f("fdv", "FDV")}${f("liq", "Liquidity")}${f("holders", "Holders")}
        <div><div class="k">Fees Paid</div><div class="v fee-sol"><img class="fee-ico" alt="" width="14" height="14" src="${SOL_ICON}"><span data-sf="fees"></span></div></div>
        <div data-sf-curve hidden><div class="k">B. Curve</div><div class="v up" data-sf="curve"></div></div>
      </div>
      <div class="grid4">${["5m", "1h", "6h", "24h"].map((w) => `<button type="button" data-win="${w}">${w}<small data-sw="${w}"></small></button>`).join("")}</div>
      <div class="sheet-stats">
        <div><div class="k"><span data-sf="win"></span> Vol</div><div class="v" data-sf="vol"></div></div>
        ${f("net", "Net Vol")}
        <div class="mix-pill buy"><span class="mix-fill" data-sfw="buyPct"></span><span class="lab" data-sf="buyTxt"></span></div>
        <div><div class="k"><span data-sf="win"></span> Traders</div><div class="v" data-sf="traders"></div></div>
        <div><div class="k">Net Buyers</div><div class="v pink" data-sf="netBuyers"></div></div>
        <div class="mix-pill sell"><span class="mix-fill" data-sfw="sellPct"></span><span class="lab" data-sf="sellTxt"></span></div>
      </div>
      <div class="trend-box"><div class="k"><span data-sf="win"></span> Net Buy Trend</div><div class="trend" id="net-trend"></div></div>
      <div class="delta3">
        <div><div class="k">Vol %Δ</div><div class="v" data-sf="volD"></div></div>
        <div><div class="k">Liquidity %Δ</div><div class="v" data-sf="liqD"></div></div>
        <div><div class="k">Holders %Δ</div><div class="v" data-sf="holdD"></div></div>
      </div>
      <div class="tiles">
        <div class="tile"><b data-sf="top10"></b>Top 10 H.</div>
        <div class="tile"><b data-sf="dev"></b>Dev H.</div>
        <div class="tile" data-sf-snip hidden><b data-sf="snip"></b>Snipers H.</div>
        <div class="tile"><b data-sf="freeze"></b>Freeze Auth</div>
        <div class="tile"><b data-sf="mint"></b>Mint Auth</div>
      </div>
      <button type="button" class="go buy sheet-close-btn" data-sheet-close>Close</button>
    </div>
  </div>`;
}
// Update values in place (called on every stream paint).
function paintSheet() {
  const root = document.getElementById("sheet-root");
  if (!root) return;
  noteNetTrend();
  armNetTrend();
  const v = sheetVals();
  root.querySelectorAll("[data-sf]").forEach((el) => {
    const k = el.dataset.sf;
    const val = k === "win" ? state.infoWin : v[k];
    if (val != null && el.textContent !== String(val)) el.textContent = val;
  });
  const net = root.querySelector('[data-sf="net"]');
  if (net) net.className = "v " + v.netCls;
  const t10 = root.querySelector('[data-sf="top10"]'); if (t10) t10.className = v.top10Cls || "";
  const dv = root.querySelector('[data-sf="dev"]'); if (dv) dv.className = v.devCls || "";
  const fr = root.querySelector('[data-sf="freeze"]'); if (fr) fr.className = v.freezeCls;
  const mi = root.querySelector('[data-sf="mint"]'); if (mi) mi.className = v.mintCls;
  for (const k of ["volD", "liqD", "holdD"]) {
    const el = root.querySelector(`[data-sf="${k}"]`);
    if (el) el.className = v[k + "Cls"];
  }
  const snip = root.querySelector('[data-sf="snip"]');
  if (snip) snip.className = v.snipCls || "";
  const curve = root.querySelector("[data-sf-curve]");
  if (curve) curve.hidden = !v.curveOn;
  const snipTile = root.querySelector("[data-sf-snip]");
  if (snipTile) snipTile.hidden = !v.snipOn;
  const ico = root.querySelector(".fee-ico");
  if (ico) ico.hidden = v.fees === "—";
  root.querySelectorAll("[data-sfw]").forEach((el) => {
    const n = v[el.dataset.sfw];
    el.style.width = n == null ? "0%" : Math.max(0, Math.min(100, n)) + "%";
  });
  root.querySelectorAll("[data-sw]").forEach((el) => {
    const pc = v.wins[el.dataset.sw];
    const txt = pc == null ? "—" : sheetPct(pc);
    if (el.textContent !== txt) el.textContent = txt;
    el.className = pc == null ? "flat" : cls(pc);
  });
  root.querySelectorAll("[data-win]").forEach((b) => b.classList.toggle("on", b.dataset.win === state.infoWin));
  drawNetTrend();
}
let sheetPrevOverflow = null;
function openSheet() {
  if (document.getElementById("sheet-root")) {
    const sc = $(".scroll"); // render() may have rebuilt the page behind the sheet: keep it locked
    if (sc) sc.style.overflow = "hidden";
    paintSheet();
    return;
  }
  const root = document.createElement("div");
  root.id = "sheet-root";
  root.className = "sheet-root";
  root.innerHTML = sheetHtml();
  document.body.appendChild(root);
  // Lock background scroll; restored in closeSheet().
  const sc = $(".scroll");
  sheetPrevOverflow = { body: document.body.style.overflow, scroll: sc ? sc.style.overflow : "" };
  document.body.style.overflow = "hidden";
  if (sc) sc.style.overflow = "hidden";
  // One delegated handler on the stable root: survives any number of value updates.
  root.addEventListener("click", (e) => {
    if (e.target.closest("[data-sheet-close]")) { e.preventDefault(); closeSheet(); return; }
    const w = e.target.closest("[data-win]");
    if (w) { state.infoWin = w.dataset.win; paintSheet(); }
  });
  bindSheetSwipe(root);
  paintSheet();
  requestAnimationFrame(() => root.classList.add("open"));
}
function closeSheet() {
  state.infoOpen = false;
  stopNetTrend();
  const root = document.getElementById("sheet-root");
  if (root) root.remove();
  if (sheetPrevOverflow) {
    document.body.style.overflow = sheetPrevOverflow.body;
    const sc = $(".scroll");
    if (sc) sc.style.overflow = sheetPrevOverflow.scroll;
    sheetPrevOverflow = null;
  }
}
function bindSheetSwipe(root) {
  const head = root.querySelector("#sheet-head");
  const sheetEl = root.querySelector("#sheet");
  let y0 = null, dy = 0, t0 = 0;
  head.addEventListener("pointerdown", (e) => {
    if (e.target.closest("[data-sheet-close]")) return;
    y0 = e.clientY; dy = 0; t0 = Date.now();
    head.setPointerCapture(e.pointerId);
    sheetEl.style.transition = "none";
  });
  head.addEventListener("pointermove", (e) => {
    if (y0 == null) return;
    dy = Math.max(0, e.clientY - y0);
    sheetEl.style.transform = `translateY(${dy}px)`;
  });
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    sheetEl.style.transition = "";
    const fast = dy > 30 && Date.now() - t0 < 250;
    if (dy > 90 || fast) closeSheet();
    else sheetEl.style.transform = "";
  };
  head.addEventListener("pointerup", end);
  head.addEventListener("pointercancel", end);
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.infoOpen) closeSheet(); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("#est-more")) return;
  e.preventDefault();
  state.quoteOpen = !state.quoteOpen;
  const est = $("#est");
  if (est) est.innerHTML = quoteSummary();
  paintQuoteExtras();
});
document.addEventListener("click", (e) => {
  if (!state.marketOpen || e.target.closest(".market-wrap")) return;
  state.marketOpen = false;
  document.querySelector(".market-menu")?.remove();
});

function openSearch() {
  state.infoOpen = false;
  state.marketOpen = false;
  if (state.alpha) state.alpha.open = false;
  state.searchOpen = true;
  state.scrollTop = 0;
  render();
  loadSpotScan().catch(() => {});
}
function searchSheet() {
  const q = state.searchQ || "";
  const body = q.length >= 2 ? searchResultHtml() : spotScanHtml();
  return `<div class="sheet" id="search-sheet"><div class="grab"></div><h2>Search <button type="button" id="search-close" aria-label="Close" style="float:right;background:none;border:0;color:var(--muted);font-size:18px">✕</button></h2><input id="q" value="${esc(q)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Name, ticker or contract address" style="width:100%;padding:12px;border-radius:10px;border:1px solid var(--line);background:#12171e;color:#fff;font-size:16px"><div id="results">${body}</div></div>`;
}

function bind() {
  document.querySelectorAll("[data-tab]").forEach((b) => b.onclick = () => {
    state.tab = b.dataset.tab;
    state.scrollToTab = true;
    render();
  });
  document.querySelectorAll("[data-tf]").forEach((b) => b.onclick = () => { if (state.tf === b.dataset.tf) return; state.tf = b.dataset.tf; state.candles = []; render(); loadCandles().catch(() => {}); });
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
  if (go) go.onclick = () => {
    if (!state.wallet) return connect();
    if (state.orderType === "market") return trade();
    return placeProtect();
  };
  const market = $("#market");
  if (market) market.onclick = (e) => {
    e.stopPropagation();
    if (state.searchOpen) return;
    state.marketOpen = !state.marketOpen;
    render();
  };
  const scMenu = document.querySelector(".scroll");
  if (scMenu) scMenu.addEventListener("scroll", () => { if (state.marketOpen) placeOrderMenu(); }, { passive: true });
  document.querySelectorAll("[data-otype]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    state.orderType = b.dataset.otype;
    if (state.orderType === "trail") armTrailHigh(true);
    state.marketOpen = false;
    state.quote = null;
    saveOrderPrefs();
    render();
    scheduleQuote(0);
  });
  document.querySelectorAll("[data-slmode]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    state.slMode = b.dataset.slmode;
    saveOrderPrefs();
    render();
  });
  document.querySelectorAll("[data-slpct]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    state.slMode = "pct";
    state.slPct = Number(b.dataset.slpct);
    saveOrderPrefs();
    render();
  });
  document.querySelectorAll("[data-trail]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    state.trailPct = Number(b.dataset.trail);
    saveOrderPrefs();
    const inp = $("#trail-in");
    if (inp) inp.value = state.trailPct;
    document.querySelectorAll("[data-trail]").forEach((x) => x.classList.toggle("on", Number(x.dataset.trail) === Number(state.trailPct)));
    paintOrderPreview();
  });
  const slIn = $("#sl-in");
  if (slIn) slIn.oninput = () => {
    const v = slIn.value.replace(",", ".");
    if (state.slMode === "price") state.slPrice = v;
    else state.slPct = v;
    saveOrderPrefs();
    paintOrderPreview();
  };
  const trailIn = $("#trail-in");
  if (trailIn) trailIn.oninput = () => {
    const v = trailIn.value.replace(",", ".");
    state.trailPct = v === "" ? "" : Number(v);
    saveOrderPrefs();
    paintOrderPreview();
  };
  document.querySelectorAll("[data-cancel-stop]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    cancelStop(b.dataset.cancelStop);
  });
  const fx = $("#fx");
  if (fx) fx.onclick = (e) => { e.stopPropagation(); openIndSheet(); };
  const chartStyleBtn = $("#chart-style");
  if (chartStyleBtn) chartStyleBtn.onclick = (e) => {
    e.stopPropagation();
    state.chartStyle = state.chartStyle === "line" ? "candle" : "line";
    try { localStorage.setItem(STYLE_KEY, state.chartStyle); } catch (_) {}
    applyStyle();
    paintEntryLine();
    chartStyleBtn.classList.toggle("on", state.chartStyle === "line");
    chartStyleBtn.setAttribute("aria-label", state.chartStyle === "line" ? "Show candles" : "Show line");
    chartStyleBtn.innerHTML = styleIcon();
  };
  document.querySelectorAll("[data-tool]").forEach((b) => b.onclick = (e) => {
    e.stopPropagation();
    if (b.dataset.tool === "erase" && state.tool === "erase") {
      state.marks = [];
      saveMarks();
      paintDrawings();
      flash("Drawings cleared");
      return;
    }
    setTool(b.dataset.tool);
  });
  document.querySelectorAll("[data-scale]").forEach((b) => b.onclick = () => {
    state.scaleMode = b.dataset.scale;
    try { localStorage.setItem(SCALE_KEY, state.scaleMode); } catch (_) {}
    applyScale();
    if (state.scaleMode === "auto") frameCandles(state.candles.length);
    document.querySelectorAll("[data-scale]").forEach((x) => x.classList.toggle("on", x.dataset.scale === state.scaleMode));
  });
  document.querySelector(".tf-scroll .on")?.scrollIntoView({ inline: "center", block: "nearest" });
  if (chartUi.draw) chartUi.draw.classList.toggle("off", state.tool === "cross");
  const tokenSearch = $("#token-search");
  if (tokenSearch) tokenSearch.onclick = () => openSearch();
  const share = $("#share");
  if (share) share.onclick = () => {
    const t = state.active;
    if (!t) return;
    const url = location.origin + location.pathname + "?token=" + encodeURIComponent(t.id);
    const done = () => { state.toast = "Link copied"; render(); };
    if (navigator.share) navigator.share({ title: t.symbol || "Token", url }).catch(() => {});
    else navigator.clipboard.writeText(url).then(done).catch(() => {});
  };
  const star = $("#star");
  if (star) star.onclick = () => {
    const t = state.active;
    if (!t) return;
    toggleStar(t.id);
    render();
  };
  document.querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => {
    navigator.clipboard.writeText(b.dataset.copy).then(() => { state.toast = "Copied"; render(); }).catch(() => {});
  });
  const info = $("#info");
  if (info) info.onclick = (e) => { e.stopPropagation(); state.searchOpen = false; document.getElementById("search-sheet")?.remove(); state.infoOpen = true; openSheet(); };
  const rcBadge = $("#rc-badge");
  if (rcBadge) rcBadge.onclick = (e) => { e.stopPropagation(); state.searchOpen = false; document.getElementById("search-sheet")?.remove(); state.infoOpen = true; openSheet(); };
  document.querySelectorAll("[data-sell]").forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const mint = b.dataset.sell;
    state.side = "sell";
    if (state.tab === "trade") state.tab = "holders";
    state.sellPct = 100;
    state.view = "spot";
    await loadToken(mint).catch((err) => { state.status = err.message; render(); });
    document.getElementById("trade-dock")?.scrollIntoView({ block: "nearest" });
  });
  document.querySelectorAll("[data-mint]").forEach((r) => r.onclick = (e) => {
    if (e.target.closest("[data-sell]")) return;
    state.tab = "holders";
    state.view = "spot";
    loadToken(r.dataset.mint).catch((err) => { state.status = err.message; render(); });
  });
  document.querySelectorAll("[data-nav]").forEach((b) => b.onclick = () => {
    const v = b.dataset.nav;
    state.view = v;
    render();
    streamSync();
    $(".scroll") && ($(".scroll").scrollTop = 0);
    if (v === "portfolio" && state.wallet && !state.holdingsLoading) loadHoldings().catch(() => {});
    if (v === "alpha") loadAlpha().catch(() => {});
  });
  document.querySelectorAll("[data-connect]").forEach((b) => b.onclick = () => connect());
  document.querySelectorAll("[data-reload-holdings]").forEach((b) => b.onclick = () => loadHoldings().catch(() => {}));
  const c = $("#connect");
  if (c) c.onclick = () => (state.wallet ? openWalletPicker() : connect());
  const so = $("#search-open");
  if (so) so.onclick = () => openSearch();
  const q = $("#q");
  if (q) {
    q.oninput = () => search(q.value.trim());
    q.onkeydown = (e) => {
      if (e.key === "Escape") { state.searchOpen = false; state.searchQ = ""; state.results = []; state.searching = false; render(); }
      if (e.key === "Enter" && q.value.trim()) pick((state.results[0] && state.results[0].id) || q.value.trim());
    };
    setTimeout(() => q.focus(), 0);
  }
  const sc = $("#search-close");
  if (sc) sc.onclick = () => { state.searchOpen = false; state.searchQ = ""; state.results = []; state.searching = false; render(); };
  document.querySelectorAll("[data-pick]").forEach((b) => b.onclick = () => pick(b.dataset.pick));
  bindChartResize();
  $(".scroll")?.addEventListener("scroll", parkLogo, { passive: true });
  document.querySelectorAll(".chart-full-btn").forEach((cf) => cf.onclick = () => { state.chartFull = !state.chartFull; render(); });
  const cm = $("#chart-mode");
  if (cm) cm.onclick = () => { state.chartMode = state.chartMode === "mc" ? "price" : "mc"; localStorage.setItem(CHART_MODE_KEY, state.chartMode); render(); };
  document.querySelectorAll("[data-txf]").forEach((b) => b.onclick = () => {
    state.txFilter = b.dataset.txf;
    const box = $("#tape");
    if (box) box.innerHTML = tapeRows();
    document.querySelectorAll("[data-txf]").forEach((x) => x.classList.toggle("on", x.dataset.txf === state.txFilter));
  });
  document.querySelectorAll("[data-txsort]").forEach((b) => b.onclick = () => {
    const k = b.dataset.txsort;
    if (state.txSort === k) state.txDir = state.txDir === "asc" ? "desc" : "asc";
    else { state.txSort = k; state.txDir = "desc"; }
    render();
  });
  const tx = $("#toast-x");
  if (tx) tx.onclick = () => { state.toast = null; render(); };
}

// ---------------- Jupiter stream (wss://api.jup.ag/stream/v1/ws) ----------------
// One websocket for live prices, trades and token stats. Opening it is one connection,
// not a request per update, so it does not eat the 1 RPS REST budget.
const STREAM_URL = "wss://api.jup.ag/stream/v1/ws";
const stream = {
  ws: null, open: false, retry: 0, lastMsg: 0, lastPrice: 0, lastAct: 0,
  sent: { prices: new Set(), txns: new Set(), assets: new Set(), pnl: new Set(), "user-trades": new Set(), recent: false },
  dirty: { live: false, tape: false, alpha: false }, raf: 0, alphaAt: 0
};

// ---- Helius: pool-account pushes (processed) for the open token's main pool ----
// Pool decoders: Uint8Array account data -> what we need. Shared by node test + trench.js.
const PD = (() => {
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58(bytes) {
    const d = [0];
    for (const byte of bytes) { let c = byte; for (let j = 0; j < d.length; j++) { c += d[j] << 8; d[j] = c % 58; c = (c / 58) | 0; } while (c) { d.push(c % 58); c = (c / 58) | 0; } }
    let s = ""; for (const byte of bytes) { if (byte) break; s += "1"; }
    for (let i = d.length - 1; i >= 0; i--) s += B58[d[i]];
    return s;
  }
  const u64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
  const u128 = (b, o) => (u64(b, o + 8) << 64n) | u64(b, o);
  const u16 = (b, o) => b[o] | (b[o + 1] << 8);
  const i32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24));
  const i128 = (b, o) => { const v = u128(b, o); return v >= (1n << 127n) ? v - (1n << 128n) : v; };
  const pk = (b, o) => b58(b.subarray(o, o + 32));
  const sqrtToPrice = (sq) => { const x = Number(sq) / 2 ** 64; return x * x; }; // token1 per token0, raw units
  // Each returns { mintA, mintB, vaults?:[vA,vB], raw?: () => price of A in B (raw units) }
  const pools = {
    // pump.fun bonding curve: virtual reserves in the account; quote is always SOL
    // (datapi gives the mint as the pool id; the account is PDA ["bonding-curve", mint] of the pump program)
    "pumpfun": (b) => ({ curve: true, vTok: u64(b, 8), vSol: u64(b, 16), complete: !!b[48], quoteMint: b.length >= 115 ? pk(b, 83) : null }),
    // PumpSwap: reserves live in the two vault token accounts
    // effective quote = quote vault + virtual_quote_reserves (signed i128; fees kept in the vault are netted out)
    "pumpfun-amm": (b) => ({ mintA: pk(b, 43), mintB: pk(b, 75), vaults: [pk(b, 139), pk(b, 171)], adj: [0n, b.length >= 261 ? i128(b, 245) : 0n] }),
    // Raydium AMM v4
    "raydium": (b) => ({ mintA: pk(b, 400), mintB: pk(b, 432), vaults: [pk(b, 336), pk(b, 368)] }),
    // Raydium CPMM
    // vaults also hold protocol, fund and creator fees: subtract them
    "raydium-cp-swaps": (b) => {
      const cr = b.length >= 413;
      return { mintA: pk(b, 168), mintB: pk(b, 200), vaults: [pk(b, 72), pk(b, 104)],
        adj: [-(u64(b, 341) + u64(b, 357) + (cr ? u64(b, 397) : 0n)), -(u64(b, 349) + u64(b, 365) + (cr ? u64(b, 405) : 0n))] };
    },
    // Raydium CLMM: sqrtPriceX64 of token1 per token0
    "raydium-clmm": (b) => ({ mintA: pk(b, 73), mintB: pk(b, 105), decA: b[233], decB: b[234], ratio: sqrtToPrice(u128(b, 253)) }),
    // Orca Whirlpool
    "orca-whirlpool": (b) => ({ mintA: pk(b, 101), mintB: pk(b, 181), ratio: sqrtToPrice(u128(b, 65)) }),
    // Meteora DLMM: price per bin = (1 + binStep/1e4)^activeId (Y per X, raw)
    "meteora-dlmm": (b) => ({ mintA: pk(b, 88), mintB: pk(b, 120), ratio: Math.pow(1 + u16(b, 80) / 10000, i32(b, 76)) }),
  };
  const tokenAmount = (b) => u64(b, 64); // SPL token account amount
  return { pools, tokenAmount, b58, u64 };
})();
const HKEY = (/[?&]nohelius=1/.test(location.search) ? "" : (window.HELIUS_API_KEY || ""));
const HRPC = HKEY ? "https://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(HKEY) : "";
const HWS = HKEY ? "wss://mainnet.helius-rpc.com/?api-key=" + encodeURIComponent(HKEY) : "";
const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const USD_QUOTES = { EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6 };
const HEL_POOLS = 2;               // follow the 2 busiest pools of the open token (<= 6 account subs)
const HEL_DAY_CREDITS = 20000;     // websocket: 2 credits / 0.1 MB -> <= 1 GB/day, far inside 1M/month
const HEL_TEST = /[?&]heltest=1/.test(location.search); // adds a logsSubscribe to measure per-trade lead
const hel = { ws: null, open: false, backoff: 1000, reqId: 1, req: new Map(), subs: new Map(), tracks: [], seq: 0,
  lastAt: 0, jupPx: 0, jupSlot: 0, shown: null, reason: HKEY ? "" : "no key", rpcAt: 0, hiddenAt: 0, helSig: new Map(), jupSig: new Map(), leads: [] };
const helToday = () => new Date().toISOString().slice(0, 10);
const helUsage = (() => { try { const u = JSON.parse(localStorage.getItem("trench-helius") || "{}"); return u.d === helToday() ? u : { d: helToday(), b: 0 }; } catch (_) { return { d: helToday(), b: 0 }; } })();
function helCredits() { if (helUsage.d !== helToday()) { helUsage.d = helToday(); helUsage.b = 0; } return helUsage.b / 1e5 * 2; }
setInterval(() => { try { localStorage.setItem("trench-helius", JSON.stringify(helUsage)); } catch (_) {} }, 10000);

// Helius RPC, serialized at <= 5 RPS (free plan allows 10).
let helRpcChain = Promise.resolve();
function helRpc(method, params) {
  const run = async () => {
    const wait = hel.rpcAt + 200 - Date.now();
    if (wait > 0) await sleep(wait);
    hel.rpcAt = Date.now();
    const r = await fetch(HRPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message || "Helius RPC error");
    return d.result;
  };
  const p = helRpcChain.then(run, run);
  helRpcChain = p.catch(() => {});
  return p;
}
const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const POOL_PROGRAMS = {
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: "pumpfun-amm",
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pumpfun",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C: "raydium-cp-swaps",
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: "raydium-clmm",
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: "orca-whirlpool",
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: "meteora-dlmm"
};
function curvePda(mint) {
  return solanaWeb3.PublicKey.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new solanaWeb3.PublicKey(mint).toBytes()], new solanaWeb3.PublicKey(PUMP_PROGRAM))[0].toBase58();
}
// Price moves first where people trade (routes spread over pools): rank pools by trade
// count in the token's last 100 swaps (keyless datapi), not by liquidity.
async function heliusCandidates(token) {
  const counts = new Map();
  try {
    const tx = await datapi("https://datapi.jup.ag/v1/txs/" + token.id + "?limit=100");
    for (const x of tx?.txs || []) if (x.poolId) counts.set(x.poolId, (counts.get(x.poolId) || 0) + 1);
  } catch (_) {}
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id).slice(0, 6);
  // Busiest pools can be prop AMMs we can't decode: Jupiter's main pool is the fallback.
  const d = await datapi("https://datapi.jup.ag/v1/pools?assetIds=" + token.id).catch(() => null);
  const main = (d?.pools || []).find((p) => p.baseAsset?.id === token.id);
  if (main && !ranked.includes(main.id)) ranked.push(main.id);
  return { ranked, counts };
}
async function heliusTrack(token, keep = false) {
  const seq = ++hel.seq;
  if (!keep) { heliusUnsubAll(); hel.tracks = []; hel.lastAt = 0; hel.jupPx = 0; hel.jupSlot = 0; hel.helSig.clear(); hel.jupSig.clear(); }
  if (!HKEY || !token) return;
  if (helCredits() >= HEL_DAY_CREDITS) { hel.reason = "daily credit cap reached"; return; }
  try {
    const { ranked, counts } = await heliusCandidates(token);
    if (seq !== hel.seq) return;
    if (!ranked.length) { hel.reason = "no pool"; return; }
    const accts = ranked.map((id) => (id === token.id ? curvePda(token.id) : id));
    const info = await helRpc("getMultipleAccounts", [accts, { encoding: "base64", commitment: "processed" }]);
    if (seq !== hel.seq) return;
    const picked = [];
    for (let i = 0; i < accts.length && picked.length < HEL_POOLS; i++) {
      const v = info.value[i];
      const type = v && POOL_PROGRAMS[v.owner];
      if (!type) continue;
      const t = await heliusBuild(token, type, accts[i], b64bytes(v.data[0]), seq);
      if (seq !== hel.seq) return;
      if (t) { t.trades = counts.get(ranked[i]) || 0; picked.push(t); }
    }
    if (!picked.length) { if (!keep) hel.reason = "no decodable pool among the active ones"; return; }
    if (keep && picked.map((t) => t.pool).join() === hel.tracks.map((t) => t.pool).join()) return;
    heliusUnsubAll();
    hel.tracks = picked; hel.reason = "";
    heliusConnect();
    heliusSubAll();
  } catch (e) {
    if (seq === hel.seq && !keep) hel.reason = "setup failed: " + (e.message || e);
  }
}
async function heliusBuild(token, type, acct, poolBytes, seq) {
  const spec = PD.pools[type](poolBytes);
  const t = { mint: token.id, type, pool: acct, dec: token.decimals ?? 6, data: { [acct]: poolBytes }, accts: [acct], n: 0, bad: 0, calcT: 0 };
  if (spec.curve) {
    if (spec.complete) return null;
    if (spec.quoteMint && spec.quoteMint !== "11111111111111111111111111111111" && spec.quoteMint !== SOL) return null;
    t.quote = SOL; t.qdec = 9;
  } else {
    if (spec.mintA !== token.id && spec.mintB !== token.id) return null;
    t.baseIsA = spec.mintA === token.id;
    t.quote = t.baseIsA ? spec.mintB : spec.mintA;
    t.qdec = t.quote === SOL ? 9 : USD_QUOTES[t.quote];
    if (t.qdec == null) return null;
    if (spec.vaults) {
      const va = await helRpc("getMultipleAccounts", [spec.vaults, { encoding: "base64", commitment: "processed" }]);
      if (seq !== hel.seq) return null;
      spec.vaults.forEach((v, i) => { t.data[v] = b64bytes(va.value[i].data[0]); });
      t.vaults = spec.vaults;
      // AMM v4 reserves come from the vaults only; the others also need the pool (fees / virtual reserves).
      t.accts = type === "raydium" ? spec.vaults.slice() : [acct, ...spec.vaults];
    }
  }
  for (let i = 0; i < 50 && t.quote === SOL && !(state.prices[SOL] > 0); i++) await sleep(100); // first boot: SOL price not in yet
  const px = helPrice(t);
  const ref = hel.jupPx || state.prices[token.id];
  if (!(px > 0)) return null;
  if (ref > 0 && Math.abs(px / ref - 1) > 0.08) return null; // wrong decode or a stale side pool
  return t;
}
// Follow the flow: re-rank every 2 min while a token is open (1 keyless datapi call + 1-3 RPC calls).
setInterval(() => { if (HKEY && state.active && !document.hidden && helCredits() < HEL_DAY_CREDITS) heliusTrack(state.active, true); }, 120000);

function helPrice(t) {
  const spec = PD.pools[t.type](t.data[t.pool]);
  let baseInQuote;
  if (spec.curve) baseInQuote = (Number(spec.vSol) / 1e9) / (Number(spec.vTok) / 10 ** t.dec);
  else {
    const decA = t.baseIsA ? t.dec : t.qdec, decB = t.baseIsA ? t.qdec : t.dec;
    let bPerA;
    if (t.vaults) {
      const amt = t.vaults.map((v, i) => Number(PD.tokenAmount(t.data[v]) + (spec.adj ? spec.adj[i] : 0n)));
      bPerA = amt[1] / amt[0];
    } else bPerA = spec.ratio;
    const aInB = bPerA * 10 ** (decA - decB);
    baseInQuote = t.baseIsA ? aInB : 1 / aInB;
  }
  const q = t.quote === SOL ? state.prices[SOL] : 1;
  return q > 0 && isFinite(baseInQuote) ? baseInQuote * q : 0;
}

function heliusConnect() {
  if (!HKEY || (hel.ws && hel.ws.readyState <= 1)) return;
  let ws;
  try { ws = new WebSocket(HWS); } catch (_) { return; }
  hel.ws = ws;
  ws.onopen = () => { hel.open = true; hel.backoff = 1000; heliusSubAll(); };
  ws.onmessage = (ev) => {
    helUsage.b += ev.data.length;
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id != null && hel.req.has(m.id)) {
      const target = hel.req.get(m.id); hel.req.delete(m.id);
      if (typeof m.result === "number" && target) hel.subs.set(m.result, target);
      return;
    }
    if (m.method === "logsNotification") { heliusNoteSig(m.params?.result?.value?.signature); return; }
    if (m.method !== "accountNotification") return;
    const target = hel.subs.get(m.params?.subscription);
    if (!target || !target.t || !hel.tracks.includes(target.t)) return;
    const t = target.t;
    t.data[target.acct] = b64bytes(m.params.result.value.data[0]);
    t.slot = m.params?.result?.context?.slot || t.slot || 0;
    // A swap touches pool + both vaults: let them all land before pricing (no half-updated tick).
    clearTimeout(t.calcT);
    t.calcT = setTimeout(() => heliusApply(t), t.vaults ? 25 : 0);
    if (helCredits() >= HEL_DAY_CREDITS) { hel.reason = "daily credit cap reached"; heliusClose(); }
  };
  ws.onclose = () => {
    hel.open = false; hel.subs.clear(); hel.req.clear();
    if (hel.ws !== ws) return;
    hel.ws = null;
    if (!hel.tracks.length || document.hidden || helCredits() >= HEL_DAY_CREDITS) return;
    setTimeout(heliusConnect, hel.backoff);
    hel.backoff = Math.min(hel.backoff * 2, 30000);
  };
  ws.onerror = () => {};
}
function heliusSend(method, params, target) {
  if (!hel.ws || hel.ws.readyState !== 1) return;
  const id = hel.reqId++;
  hel.req.set(id, target || null);
  hel.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
}
function heliusSubAll() {
  if (!hel.tracks.length || !hel.open || hel.subs.size || hel.req.size) return;
  for (const t of hel.tracks) {
    for (const a of t.accts) heliusSend("accountSubscribe", [a, { encoding: "base64", commitment: "processed" }], { t, acct: a });
    if (HEL_TEST) heliusSend("logsSubscribe", [{ mentions: [t.pool] }, { commitment: "processed" }], { t, logs: true });
  }
}
function heliusUnsubAll() {
  for (const [id, target] of hel.subs) heliusSend(target.logs ? "logsUnsubscribe" : "accountUnsubscribe", [id]);
  hel.subs.clear();
}
function heliusClose() { heliusUnsubAll(); const ws = hel.ws; hel.ws = null; hel.open = false; try { ws?.close(); } catch (_) {} }
// Idle keepalive (Helius drops silent sockets). Browser WebSocket cannot send ping
// frames, so a getHealth request every 30 s is the ping. Pause in background tabs.
setInterval(() => { if (hel.open) heliusSend("getHealth", []); }, 30000);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { hel.hiddenAt = Date.now(); setTimeout(() => { if (document.hidden && Date.now() - hel.hiddenAt >= 30000) heliusClose(); }, 30500); }
  else if (hel.tracks.length && !hel.ws) heliusConnect();
});

// Merge rule: Helius accountSubscribe context.slot and Jupiter price blockId are the
// same Solana slot. The screen keeps whichever of those two is newer. Jupiter stream
// and the keyed price poll stay as fallbacks. A print with no slot must not clobber
// a slotted price. With no Helius key, helLive is false and this path is Jupiter-only.
const priceSlot = {};
function actionSlot(x) {
  const direct = Number(x && (x.blockId || x.priceBlockId)) || 0;
  if (direct > 1e8) return direct;
  const id = String((x && x.actionId) || "");
  if (!/^\d{16,}$/.test(id)) return 0;
  return Number(id.slice(0, id.length - 9)) || 0;
}
function notePrice(mint, price, slot, source) {
  if (!mint || !(price > 0)) return false;
  const s = Number(slot) || 0;
  const prev = priceSlot[mint] || 0;
  if (s && prev && s < prev) return false;
  if (!s && prev) {
    const fallback = source === "poll" || source === "holdings";
    const helLive = !!(HKEY && hel.lastAt && Date.now() - hel.lastAt < 8000 && hel.tracks.some((t) => t.mint === mint));
    if (!fallback || helLive || streamPricesLive()) return false;
  }
  if (s) priceSlot[mint] = s;
  state.prices[mint] = price;
  if (state.active && state.active.id === mint) hel.shown = { slot: s || prev, source: source || "", at: Date.now() };
  return true;
}
function heliusApply(t) {
  try {
    const a = state.active;
    if (!a || a.id !== t.mint || !hel.tracks.includes(t)) return;
    const px = helPrice(t);
    if (!(px > 0)) return;
    // Safety net: a decode gone wrong must not drive the UI. Compare with Jupiter's latest.
    if (hel.jupPx > 0 && Math.abs(px / hel.jupPx - 1) > 0.15) {
      if (++t.bad >= 5) { hel.tracks = hel.tracks.filter((x) => x !== t); hel.reason = "pool price drifted from Jupiter"; heliusUnsubAll(); hel.subs.clear(); heliusSubAll(); }
      return;
    }
    t.bad = 0; t.n++;
    hel.lastAt = Date.now();
    if (!notePrice(a.id, px, t.slot || 0, "helius")) return;
    a.usdPrice = px;
    if (a.circSupply) a.mcap = a.circSupply * px;
    feedMark("heliusPrice");
    stream.dirty.live = true;
    streamFlush();
  } catch (_) { hel.reason = "decode failed"; }
}
// Per-trade lead (heltest only): the same signature seen by Helius logs vs Jupiter's txns stream.
function heliusNoteSig(sig) {
  if (!sig) return;
  const now = performance.now();
  if (hel.jupSig.has(sig)) { hel.leads.push(-(now - hel.jupSig.get(sig))); hel.jupSig.delete(sig); return; }
  hel.helSig.set(sig, now);
  if (hel.helSig.size > 500) hel.helSig.delete(hel.helSig.keys().next().value);
}
function heliusNoteJupTx(sig) {
  if (!sig || !HEL_TEST) return;
  const now = performance.now();
  if (hel.helSig.has(sig)) { hel.leads.push(now - hel.helSig.get(sig)); hel.helSig.delete(sig); return; }
  hel.jupSig.set(sig, now);
  if (hel.jupSig.size > 500) hel.jupSig.delete(hel.jupSig.keys().next().value);
}
window.__orders = (cmd) => {
  if (cmd === "ratchet" && state.active) {
    const id = state.active.id;
    const px = Number(state.prices[id] || state.active.usdPrice || 0);
    state.orderType = "trail";
    state.trailPct = 10;
    state.prices[id] = px;
    armTrailHigh(true);
    state.prices[id] = px * 1.2;
    armTrailHigh(false);
    state.prices[id] = px * 1.05;
    const d = trailDisplay();
    state.prices[id] = px;
    armTrailHigh(true);
    return { px, high: d.high, trigger: d.trigger, line: d.line };
  }
  const px = state.active ? Number(state.prices[state.active.id] || state.active.usdPrice || 0) : 0;
  const extra = { amount: "1000", userPubkey: "WALLET", now: 1700000000000, high: px || 2, entry: px || 2 };
  return {
    math: orderMathOk(),
    type: state.orderType,
    preview: orderPreview(),
    px,
    stop: state.active ? buildTriggerOrder({ ...extra, kind: "stop" }) : null,
    trail: state.active ? buildTriggerOrder({ ...extra, kind: "trail" }) : null
  };
};
window.__helius = () => {
  const l = [...hel.leads].sort((x, y) => x - y);
  const q = (f) => (l.length ? Math.round(l[Math.min(l.length - 1, Math.floor(l.length * f))]) : null);
  return { on: hel.tracks.length > 0, open: hel.open, reason: hel.reason, shown: hel.shown,
    mint: state.active?.id || "", symbol: state.active?.symbol || "",
    price: state.active ? (state.prices[state.active.id] || 0) : 0,
    pools: hel.tracks.map((t) => ({ type: t.type, pool: t.pool.slice(0, 6), recentTrades: t.trades, updates: t.n })),
    subs: hel.subs.size, creditsToday: Math.round(helCredits() * 10) / 10, bytesToday: helUsage.b,
    tradeLeadMs: { n: l.length, median: q(0.5), p10: q(0.1), p90: q(0.9), heliusFirstPct: l.length ? Math.round(l.filter((x) => x > 0).length / l.length * 100) : null } };
};
window.__priceMerge = () => {
  const id = state.active?.id;
  if (!id) return { ok: false, why: "no token" };
  const set = notePrice(id, 1.23, 500000100, "jup");
  const older = notePrice(id, 9.99, 500000050, "helius");
  const newer = notePrice(id, 1.5, 500000200, "helius");
  const slotless = notePrice(id, 7.77, 0, "trade");
  const same = notePrice(id, 1.25, 500000200, "jup");
  return {
    ok: set === true && older === false && newer === true && slotless === false && same === true && state.prices[id] === 1.25,
    set, older, newer, slotless, same, shown: state.prices[id]
  };
};

const feeds = {};
function feedMark(name) {
  const f = feeds[name] || (feeds[name] = { n: 0, last: 0, gaps: [] });
  const now = performance.now();
  if (f.last) { f.gaps.push(now - f.last); if (f.gaps.length > 200) f.gaps.shift(); }
  f.last = now;
  f.n++;
}
window.__feeds = () => Object.fromEntries(Object.entries(feeds).map(([k, f]) => {
  const g = [...f.gaps].sort((a, b) => a - b);
  return [k, { n: f.n, medianMs: g.length ? Math.round(g[g.length >> 1]) : null, p90Ms: g.length ? Math.round(g[Math.floor(g.length * 0.9)]) : null }];
}));
function streamLive() { return stream.open && Date.now() - stream.lastMsg < 5000; }
function streamPricesLive() { return stream.open && Date.now() - stream.lastPrice < 4000; }

function streamConnect() {
  if (stream.ws && (stream.ws.readyState === 0 || stream.ws.readyState === 1)) return;
  const k = window.JUP_API_KEY;
  let ws;
  try { ws = new WebSocket(STREAM_URL + (k ? "?apiKey=" + encodeURIComponent(k) : "")); }
  catch (_) { streamRetry(); return; }
  stream.ws = ws;
  ws.onopen = () => {
    stream.open = true;
    stream.retry = 0;
    stream.lastMsg = Date.now();
    stream.sent = { prices: new Set(), txns: new Set(), assets: new Set(), pnl: new Set(), "user-trades": new Set(), recent: false };
    streamSync();
  };
  ws.onmessage = (e) => {
    stream.lastMsg = Date.now();
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.type === "prices") onStreamPrices(d.data || []);
    else if (d.type === "actions") onStreamActions(d.data || []);
    else if (d.type === "asset-updates") onStreamAssets(d.data || []);
    else if (d.type === "pnl") onStreamPnl(d.data || {});
    else if (d.type === "user-trades") onStreamUserTrades(d.data || []);
  };
  ws.onclose = () => { stream.open = false; if (stream.ws === ws) stream.ws = null; streamRetry(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function streamRetry() {
  const ms = Math.min(10000, 1000 * 2 ** stream.retry++);
  setTimeout(() => { if (!document.hidden) streamConnect(); }, ms);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) streamConnect(); });

function streamSend(type, payload) {
  if (stream.ws?.readyState === 1) stream.ws.send(JSON.stringify({ type, ...payload }));
}
function syncSet(kind, want, field = "assets") {
  const sent = stream.sent[kind];
  const add = [...want].filter((x) => !sent.has(x));
  const del = [...sent].filter((x) => !want.has(x));
  if (del.length) streamSend("unsubscribe:" + kind, { [field]: del });
  if (add.length) streamSend("subscribe:" + kind, { [field]: add });
  stream.sent[kind] = new Set(want);
}
// Subscribe to exactly what is on screen.
function streamSync() {
  if (!stream.open) return;
  const a = state.active?.id;
  const prices = new Set([SOL]);
  if (a) prices.add(a);
  state.holdings.slice(0, 40).forEach((h) => prices.add(h.mint));
  const assets = new Set(a ? [a] : []);
  if (state.view === "alpha") state.alpha.rows.slice(0, 100).forEach((t) => assets.add(t.id));
  syncSet("prices", prices);
  syncSet("txns", new Set(a ? [a] : []));
  syncSet("assets", assets);
  const wallets = new Set(state.wallet ? [state.wallet] : []);
  syncSet("pnl", wallets, "addresses");
  syncSet("user-trades", wallets, "addresses");
  const recent = state.view === "alpha";
  if (recent !== stream.sent.recent) {
    streamSend((recent ? "subscribe" : "unsubscribe") + ":assets,recent", {});
    stream.sent.recent = recent;
  }
  if (recent && state.alpha.pumpFallback) pumpConnect();
}

// Wallet push: balances + average cost for every token the wallet holds.
const NATIVE_SOL = "So11111111111111111111111111111111111111111";
let pnlRenderTimer = 0;
function onStreamPnl(data) {
  const w = state.wallet;
  const mine = w && data[w];
  if (!mine) return;
  feedMark("walletPnlStream");
  let changed = false;
  const missing = [];
  for (const [mint, row] of Object.entries(mine)) {
    const bal = row?.balance;
    if (row?.pnl?.averageCost > 0 && mint !== NATIVE_SOL && mint !== SOL) localStorage.setItem(entryKey(mint), String(row.pnl.averageCost));
    if (!bal) continue;
    if (mint === NATIVE_SOL) { state.sol = Number(bal.balance) || 0; changed = true; continue; }
    if (mint === SOL) continue;
    const ui = Number(bal.balance) || 0;
    const i = state.holdings.findIndex((h) => h.mint === mint);
    if (ui <= 0) { if (i >= 0) { state.holdings.splice(i, 1); changed = true; } continue; }
    const next = { mint, amount: Number(bal.amount) || 0, decimals: bal.decimals ?? 0, ui };
    if (i >= 0) Object.assign(state.holdings[i], next);
    else { state.holdings.push(next); missing.push(mint); }
    changed = true;
  }
  if (missing.length) {
    datapi("https://datapi.jup.ag/v1/assets?ids=" + missing.join(",")).then((meta) => {
      (Array.isArray(meta) ? meta : meta?.assets || []).forEach((m) => {
        const h = state.holdings.find((x) => x.mint === m.id);
        if (h) Object.assign(h, { symbol: m.symbol, name: m.name, icon: m.icon });
      });
      streamSync();
      render();
    }).catch(() => {});
  }
  if (!changed) return;
  // Balance screens re-render at most twice a second; elsewhere just repaint live numbers.
  if (state.view === "portfolio" || state.tab === "holdings") {
    clearTimeout(pnlRenderTimer);
    pnlRenderTimer = setTimeout(() => render(), 500);
  } else {
    const balEl = $("#trade-bal");
    if (balEl) {
      const bal = tradeBal();
      if (balEl.textContent !== bal) balEl.textContent = bal;
    }
    stream.dirty.live = true;
    streamFlush();
  }
}
function onStreamUserTrades(list) {
  feedMark("walletTradesStream");
  onStreamActions(list);
}

// ---------------- PumpPortal (wss://pumpportal.fun/api/data) ----------------
// Fallback only, if the Jupiter AlphaScan feed fails. ONE connection (their rule).
const pump = { ws: null, retry: 0, wanted: false };
function pumpStop() {
  pump.wanted = false;
  const ws = pump.ws;
  pump.ws = null;
  if (ws) { try { ws.close(); } catch (_) {} }
}
function pumpConnect() {
  pump.wanted = true;
  if (pump.ws && pump.ws.readyState <= 1) return;
  let ws;
  try { ws = new WebSocket("wss://pumpportal.fun/api/data"); } catch (_) { return pumpRetry(); }
  pump.ws = ws;
  ws.onopen = () => {
    pump.retry = 0;
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeMigration" }));
  };
  ws.onmessage = (e) => {
    let d;
    try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.txType === "create" && d.mint) onPumpNew(d);
    else if (d.txType === "migrate" && d.mint) onPumpMigrate(d);
  };
  ws.onclose = () => { if (pump.ws === ws) pump.ws = null; pumpRetry(); };
  ws.onerror = () => { try { ws.close(); } catch (_) {} };
}
function pumpRetry() {
  if (!pump.wanted) return;
  setTimeout(pumpConnect, Math.min(60000, 5000 * 2 ** pump.retry++));
}
function onPumpNew(d) {
  if (!state.alpha.pumpFallback) return;
  feedMark("pumpNew");
  alphaIngest({
    type: "new",
    asset: {
      id: d.mint, symbol: d.symbol, name: d.name, launchpad: "pump.fun", createdAt: new Date().toISOString(),
      mcap: d.marketCapSol && state.prices[SOL] ? d.marketCapSol * state.prices[SOL] : null,
      dev: d.traderPublicKey, _pump: true, stats1h: {}, stats24h: {}, audit: {}
    }
  });
  stream.dirty.alpha = true;
  streamFlush();
  streamSync();
}
function onPumpMigrate(d) {
  feedMark("pumpMigrate");
  const r = state.alpha.rows.find((x) => x.id === d.mint);
  if (r) { r._migrated = true; stream.dirty.alpha = true; streamFlush(); }
}

function onStreamPrices(list) {
  const a = state.active;
  for (const p of list) {
    if (!p?.assetId || !(p.price > 0)) continue;
    const slot = Number(p.blockId) || 0;
    if (a && p.assetId === a.id && (!hel.jupSlot || !slot || slot >= hel.jupSlot)) {
      hel.jupPx = p.price;
      if (slot) hel.jupSlot = slot;
    }
    if (!notePrice(p.assetId, p.price, slot, "jup")) continue;
    if (a && p.assetId === a.id) {
      a.usdPrice = p.price;
      if (a.circSupply) a.mcap = a.circSupply * p.price;
      feedMark("pricesStream");
    }
  }
  stream.lastPrice = Date.now();
  stream.dirty.live = true;
  streamFlush();
}
function onStreamActions(list) {
  const a = state.active;
  if (!a) return;
  if (!state.tapeIds) state.tapeIds = new Set();
  let added = 0, vol = 0;
  for (const x of list) {
    if (x.asset !== a.id) continue;
    const id = x.txHash || x.actionId;
    if (state.tapeIds.has(id)) continue;
    state.tapeIds.add(id);
    state.tape.unshift(x);
    vol += Number(x.usdVolume) || 0;
    heliusNoteJupTx(x.txHash);
    if (x.usdPrice > 0) notePrice(a.id, x.usdPrice, actionSlot(x), "trade");
    added++;
  }
  if (!added) return;
  feedMark("tradesStream");
  if (state.tape.length > 80) state.tape.length = 80;
  if (state.tapeIds.size > 2000) state.tapeIds = new Set(state.tape.map((x) => x.txHash || x.actionId));
  stream.lastAct = Date.now();
  stream.pendingVol = (stream.pendingVol || 0) + vol;
  stream.dirty.tape = true;
  stream.dirty.live = true;
  streamFlush();
}
function onStreamAssets(list) {
  const a = state.active;
  const alphaOn = state.view === "alpha";
  for (const u of list) {
    const t = u?.asset;
    if (!t?.id) continue;
    if (a && t.id === a.id) {
      const fees = a.fees;
      const curve = a.bondingCurve, gradAt = a.graduatedAt, gradPool = a.graduatedPool;
      const sniper = a.audit && a.audit.sniperPct;
      Object.assign(a, t);
      if (fees != null && t.fees == null) a.fees = fees;
      if (curve != null && t.bondingCurve == null) a.bondingCurve = curve;
      if (gradAt != null && t.graduatedAt == null) a.graduatedAt = gradAt;
      if (gradPool != null && t.graduatedPool == null) a.graduatedPool = gradPool;
      if (sniper != null && (!a.audit || a.audit.sniperPct == null)) {
        a.audit = a.audit || {};
        a.audit.sniperPct = sniper;
      }
      if (t.usdPrice > 0) notePrice(t.id, t.usdPrice, t.priceBlockId || t.blockId, "asset");
      if (state.prices[a.id]) a.usdPrice = state.prices[a.id];
      feedMark("tokenStatsStream");
      stream.dirty.live = true;
    }
    if (!alphaOn) continue;
    alphaIngest(u);
    stream.dirty.alpha = true;
    feedMark(u.type === "new" ? "alphaNewStream" : "alphaRowStream");
  }
  if (stream.dirty.live || stream.dirty.alpha) streamFlush();
}
// Coalesce bursts into one paint per animation frame (Alpha list: at most every 250 ms).
function streamFlush() {
  if (stream.raf) return;
  stream.raf = requestAnimationFrame(() => {
    stream.raf = 0;
    if (chartUi.dragging) { stream.dirty.live = true; return; }
    if (stream.dirty.live) {
      stream.dirty.live = false;
      const v = stream.pendingVol || 0;
      stream.pendingVol = 0;
      if (v) tickChart(v);
      paintLive();
      paintHeadStats();
      paintSheet();
    }
    if (stream.dirty.tape) {
      stream.dirty.tape = false;
      const box = $("#tape");
      if (box) box.innerHTML = tapeRows();
    }
    if (stream.dirty.alpha) {
      const wait = 250 - (Date.now() - stream.alphaAt);
      if (wait > 0) { setTimeout(streamFlush, wait); return; }
      stream.dirty.alpha = false;
      stream.alphaAt = Date.now();
      if (state.view === "alpha") paintAlphaList();
      feedMark("alphaPaint");
    }
  });
}
// Price / liquidity / volume cells in the token header, without a full re-render.
function paintHeadStats() {
  const t = state.active;
  const st = document.querySelectorAll(".stats .v");
  if (!t || st.length < 3) return;
  const px = livePrice(t);
  st[0].textContent = px == null ? "—" : priceLabel(px);
  st[1].textContent = t.liquidity == null ? "—" : usd(t.liquidity);
  st[2].textContent = t.stats1h && (t.stats1h.buyVolume != null || t.stats1h.sellVolume != null)
    ? usd((Number(t.stats1h.buyVolume) || 0) + (Number(t.stats1h.sellVolume) || 0))
    : "—";
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
    streamConnect();
    every(PRICE_EVERY_MS, () => pollPrices());
    every(QUOTE_EVERY_MS, () => { if (!state.busy) return refreshQuote(); });
    every(FEED_EVERY_MS, () => Promise.all([loadTape().catch(() => {}), loadCandles().catch(() => {})]));
    every(30000, () => (state.view === "alpha" ? loadAlpha() : null));
    every(30000, () => Promise.all([loadHolders().catch(() => {}), state.wallet ? loadHoldings() : null]));
    every(20000, () => refreshStopLive());
  } catch (err) {
    state.status = err.message || String(err);
    render();
    setTimeout(boot, Math.max(5000, coolUntil - Date.now()));
  }
}
boot();
