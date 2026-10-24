// Builds data/days.json, the only data file the page reads, from the public XO Data API.
// Two boards, one for XO's markets and one for its convictions: every UTC day, who made how much.
// Profit counts on the day it is locked in, the way XO's own Net PnL does: when shares are sold, or paid out
// (or written off) after the market resolves. Open positions don't count until then.
// Each sale or payout in a trader's own activity feed carries the shares, the price and the position's average
// entry price, so its profit is shares × (price − average entry): checked against XO's own figure to the cent.
// Usage: node scripts/build-board.mjs            incremental
//        ALL=1 node scripts/build-board.mjs      incremental, but re-read every known trader
//        FULL=1 node scripts/build-board.mjs     rebuild the whole window from scratch (thousands of requests: run at home)
// Node 18+, no dependencies.
import { writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const API = "https://api-mainnet.xo.market/api";
const path = (p) => fileURLToPath(new URL(p, import.meta.url));
const CONFIG = path("../config.json");
const STATE = path("../data/state.json");
const OUT = path("../data/days.json");
const DAY = 864e5;
const SPARK = 96; // points in each trader's PnL line for today (the race chart)
const KEEP_DAYS = 60; // finished days kept in the record
const SHOWN_DAYS = 30; // days the page lists
const WATCH = 3 * DAY; // after a market settles, its traders are checked often for this long (payouts land then)
const WATCH_EVERY = 20 * 6e4;
const SWEEP_EVERY = 6 * 36e5; // everyone known is re-read at least this often (limit-order fills leave no public trade)
const SWEEP_MAX = 150; // …but no more than this many per run, oldest first
const KINDS = { m: "onlyClob", c: "onlyConviction" }; // m: markets, c: convictions
const BOT_SALES = 150; // more sales than this in one day is a bot (XO has a swarm of market-making accounts): never ranked, never read again
const isPulse = (slug) => /-\d+min-pulse-\d+$/.test(slug || ""); // onlyClob includes Pulse rounds: those have their own board

class Abort extends Error {}

// XO allows 100 requests per 10 s (x-ratelimit-* headers) and sits behind Cloudflare; stay well under it
const GAP = 125; // ms between request starts, ~8 req/s
let slot = 0, requests = 0;
async function pace() {
  const now = Date.now();
  slot = Math.max(slot + GAP, now);
  if (slot > now) await new Promise((ok) => setTimeout(ok, slot - now));
}
// Anything that isn't data aborts the run, so a rate limit or an outage never turns into "nobody made anything".
async function getJSON(url, tries = 6) {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      await pace();
      requests++;
      const r = await fetch(url, { headers: { "User-Agent": "maco-board" }, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) return null;
      if (r.status === 403 || (r.ok && !(r.headers.get("content-type") || "").includes("json")))
        throw new Abort(`Blocked by XO/Cloudflare (HTTP ${r.status})`);
      if (r.ok) return await r.json();
      last = `HTTP ${r.status}`;
      if (r.status === 429) {
        let reset = Number(r.headers.get("retry-after") || r.headers.get("x-ratelimit-reset")) || 10;
        if (reset > 1e9) reset -= Date.now() / 1000;
        slot = Math.max(slot, Date.now() + (Math.min(Math.max(reset, 1), 60) + 1) * 1000);
        continue;
      }
    } catch (e) {
      if (e instanceof Abort) throw e;
      last = e.message;
    }
    await new Promise((ok) => setTimeout(ok, 1500 * 2 ** i));
  }
  throw new Abort(`Giving up on ${url}: ${last}`);
}
const pool = async (items, n, fn) => {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); }));
};
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10); // UTC day, "YYYY-MM-DD"
const avatarOf = (url) => (url || "").replace("https://pbs.twimg.com/profile_images/", "");

// ---------- window ----------
const cfg = JSON.parse(await readFile(CONFIG, "utf8"));
const now = Date.now();
const start = now - (cfg.windowDays || 7) * DAY;
const EXCLUDE = new Set((cfg.exclude || []).map((u) => u.toLowerCase()));

// ---------- state ----------
// users: lowercase username -> { u, a (avatar), v (verified), c (rooster colour), p (private),
//          chk: { m, c } newest activity read per board (ms), seen: keys at that time, last check (ms), watch (ms),
//          ev: { key: [ms, board, marketId, pnl, stake] } every sale or payout in the window }
// markets: id -> { k: board, t: title, s: slug, i: image, st: status, v: volume, seen (ms), tr: [traders] }
// days: "YYYY-MM-DD" -> { m: rows, c: rows }, kept after the day has left the window
// meta: username -> [avatar, verified, colour]
let state = { from: start, conv: 0, users: {}, markets: {}, days: {}, meta: {} };
try { state = { ...state, ...JSON.parse(await readFile(STATE, "utf8")) }; } catch (e) { if (e.code !== "ENOENT") throw e; }
const FULL = !!process.env.FULL || start < state.from - DAY;
if (FULL) state = { from: start, conv: 0, users: {}, markets: {}, days: state.days, meta: state.meta };
const user = (name) => (state.users[name.toLowerCase()] ??= { u: name, a: "", v: 0, c: "", p: 0, chk: {}, seen: {}, last: 0, watch: 0, ev: {} });
const dirty = new Set();
function saw(u) { // a trader in a market's trade feed
  if (!u || !u.username || EXCLUDE.has(u.username.toLowerCase())) return null;
  const s = user(u.username);
  s.u = u.username; s.a = avatarOf(u.profilePictureUrl); s.v = u.verified ? 1 : 0; s.c = u.roosterColor || "";
  dirty.add(s.u.toLowerCase());
  return s.u.toLowerCase();
}
const trade = (mk, key) => { if (key && !mk.tr.includes(key)) mk.tr.push(key); };

async function write(file, value) {
  await mkdir(path("../data"), { recursive: true });
  await writeFile(file + ".tmp", JSON.stringify(value));
  await rename(file + ".tmp", file);
}

// ---------- 1. the markets and convictions that are open (or just settled) ----------
const listed = new Map(); // id -> market row, for the markets XO lists as open or resolved right now
for (const [k, scope] of Object.entries(KINDS)) {
  for (const st of ["ACTIVE", "RESOLVED"]) {
    for (let page = 1; page <= 40; page++) {
      const d = await getJSON(`${API}/markets?marketScope=${scope}&statuses=${st}&page=${page}&take=50`);
      if (!d || !d.data) throw new Abort("Market list came back empty");
      for (const m of d.data) if (m.type !== 3) listed.set(m.id, { ...m, k });
      if (!d.meta || !d.meta.hasNextPage) break;
    }
  }
}
// on a full rebuild, also markets that closed inside the window (the closed list is mostly Pulse rounds)
if (FULL) {
  for (let page = 1; page <= 200; page++) {
    const d = await getJSON(`${API}/markets?marketScope=onlyClob&statuses=CLOSED&sortBy=updatedAt&sortOrder=DESC&page=${page}&take=50`);
    if (!d || !d.data || !d.data.length) break;
    let newest = 0;
    for (const m of d.data) { newest = Math.max(newest, Date.parse(m.updatedAt)); if (m.type === 2 && Date.parse(m.updatedAt) >= start) listed.set(m.id, { ...m, k: "m" }); }
    if (newest < start || !d.meta || !d.meta.hasNextPage) break;
  }
}
let settled = 0;
for (const [id, mk] of Object.entries(state.markets)) {
  const m = listed.get(+id);
  const st = m ? m.status : "CLOSED";
  // a market that has resolved (or left the list) since the last run: its traders' payouts land over the next days
  if (mk.st === "ACTIVE" && st !== "ACTIVE") { settled++; for (const key of mk.tr) if (state.users[key]) state.users[key].watch = now + WATCH; }
  mk.st = st;
}
for (const m of listed.values()) {
  const mk = (state.markets[m.id] ??= { k: m.k, t: "", s: "", i: "", st: m.status, v: -1, seen: 0, tr: [] });
  mk.t = m.title; mk.s = m.slug; mk.i = m.imageUrl || ""; mk.k = m.k;
  if (mk.st === "ACTIVE" && m.status !== "ACTIVE") { settled++; for (const key of mk.tr) if (state.users[key]) state.users[key].watch = now + WATCH; }
  mk.st = m.status;
}
console.log(`${listed.size} open or just-resolved markets and convictions, ${settled} settled since the last run`);

// ---------- 2. who traded them ----------
// Markets: each one's trade feed, read only when its volume has moved since the last run.
const busy = [...listed.values()].filter((m) => m.k === "m" && Number(m.totalVolumeInUSD || 0) !== state.markets[m.id].v);
await pool(busy, 4, async (m) => {
  const mk = state.markets[m.id];
  let newest = mk.seen;
  outer: for (let page = 1; page <= 40; page++) {
    const d = await getJSON(`${API}/markets/${m.id}/activity?page=${page}&take=50`);
    if (!d || !d.data || !d.data.length) break;
    for (const a of d.data) {
      const t = Date.parse(a.createdAt || a.executedAt);
      if (t <= mk.seen) break outer;
      newest = Math.max(newest, t);
      if (a.activityType === "USER_TRADE") trade(mk, saw(a.user));
    }
    if (!d.meta || !d.meta.hasNextPage) break;
  }
  mk.seen = newest;
  mk.v = Number(m.totalVolumeInUSD || 0);
});
// Convictions: XO has one trade feed for all of them, newest first.
{
  let newest = state.conv;
  outer: for (let page = 1; page <= 100; page++) {
    const d = await getJSON(`${API}/markets/activities?marketScope=onlyConviction&page=${page}&take=50`);
    if (!d || !d.data || !d.data.length) break;
    for (const a of d.data) {
      const t = Date.parse(a.createdAt || a.executedAt);
      if (t <= state.conv) break outer;
      newest = Math.max(newest, t);
      if (a.activityType !== "USER_TRADE" || !a.market) continue;
      const mk = (state.markets[a.market.id] ??= { k: "c", t: a.market.title || "", s: a.market.slug || "", i: a.market.imageUrl || "", st: a.market.status || "ACTIVE", v: -1, seen: 0, tr: [] });
      trade(mk, saw(a.user));
    }
    if (!d.meta || !d.meta.hasNextPage) break;
  }
  state.conv = newest;
}
console.log(`${busy.length} markets with new trades, ${dirty.size} traders seen trading`);

// ---------- 3. each trader's sales and payouts ----------
// The activity feed can be asked for sales only and for payouts only, which skips the buys (most of a Pulse trader's feed);
// Pulse rounds still come with the markets and are dropped by their slug. A market with a new sale or payout is then
// worked out from the trader's whole history in it: XO's average-entry figure is missing once a position is sold out,
// so the cost is kept the way XO keeps it (average price per outcome), and each sale or payout makes
// shares × (price − average cost). Checked against XO's own PnL to the cent.
const TRADE = /(Bought|Sold|Redeemed) ([\d.]+) (.+?) shares @ \$([\d.]+)/;
const FEEDS = [["m", "SELL"], ["m", "REDEEM"], ["c", "SELL"], ["c", "REDEEM"]];
const actId = (a) => `${a.date}|${a.marketId}|${a.positionType}|${a.description}`;
async function settle(s, key, name, k, id) {
  const hist = [];
  for (let page = 1; page <= 20; page++) {
    const d = await getJSON(`${API}/profiles/${name}/activities?marketScope=${KINDS[k]}&marketId=${id}&sortBy=executedAt&sortOrder=DESC&page=${page}&take=100`, 3);
    if (!d || !d.data || !d.data.length) break;
    hist.push(...d.data);
    if (!d.meta || !d.meta.hasNextPage) break;
  }
  for (const [eid, e] of Object.entries(s.ev)) if (e[2] === id && e[1] === k) delete s.ev[eid]; // worked out again from scratch
  const held = {}; // outcome -> { q: shares, c: cost }
  for (const a of hist.reverse()) { // oldest first
    const x = (a.description || "").match(TRADE);
    if (!x) continue;
    const sh = Number(x[2]), px = Number(x[4]), p = (held[x[3]] ??= { q: 0, c: 0 });
    if (x[1] === "Bought") { p.q += sh; p.c += sh * px; continue; }
    const avg = p.q > 1e-9 ? p.c / p.q : Number(a.avgEntryPrice || 0) / 1e6, t = Date.parse(a.date);
    p.c -= Math.min(sh, p.q) * avg; p.q -= sh;
    if (p.q < 1e-6) { p.q = 0; p.c = 0; }
    if (t >= start && sh > 0) s.ev[actId(a)] = [t, k, id, r4(sh * (px - avg)), r4(sh * avg)];
    const mk = (state.markets[id] ??= { k, t: "", s: "", i: "", st: "CLOSED", v: -1, seen: 0, tr: [] });
    if (!mk.t) { mk.t = a.marketTitle || ""; mk.s = a.slug || ""; mk.i = a.picture || ""; }
    trade(mk, key);
  }
}
async function refresh(key) {
  const s = state.users[key];
  const name = encodeURIComponent(s.u);
  const sales = {}, touched = new Set(); // day -> sales read this time; "board:marketId" with something new
  for (const [k, type] of FEEDS) {
    const f = k + type[0]; // mS, mR, cS, cR
    const from = Math.max(start, s.chk[f] || 0), seen = new Set(s.seen[f] || []);
    let newest = s.chk[f] || 0, keys = [...seen];
    outer: for (let page = 1; page <= 30; page++) {
      const d = await getJSON(`${API}/profiles/${name}/activities?marketScope=${KINDS[k]}&positionType=${type}&sortBy=executedAt&sortOrder=DESC&page=${page}&take=100`, 3);
      if (!d || !d.data) return; // renamed or deleted account
      if (d.data.length) s.p = 0; // a private profile answers with empty feeds, so any activity means it is public now
      for (const a of d.data) {
        const t = Date.parse(a.date), id = actId(a);
        if (t < from || (t === from && seen.has(id))) break outer;
        if (t > newest) { newest = t; keys = [id]; } else if (t === newest) keys.push(id);
        if (k === "m" && isPulse(a.slug)) continue;
        if (type === "SELL" && (sales[dayKey(t)] = (sales[dayKey(t)] || 0) + 1) > BOT_SALES) { s.bot = 1; s.ev = {}; s.chk = {}; s.seen = {}; s.last = now; return; }
        touched.add(`${k}:${a.marketId}`);
      }
      if (!d.meta || !d.meta.hasNextPage) break;
    }
    s.chk[f] = newest; s.seen[f] = keys;
  }
  for (const t of touched) { const [k, id] = t.split(":"); await settle(s, key, name, k, +id); }
  // a private profile answers with empty feeds: ask once a day whether that's why
  if (!Object.keys(s.ev).length && now - (s.pchk || 0) > DAY) {
    const p = await getJSON(`${API}/profiles/${name}`);
    s.pchk = now;
    s.p = p && p.isPrivate ? 1 : 0;
    if (s.p) { s.ev = {}; s.chk = {}; s.seen = {}; }
  }
  s.last = now;
}
for (const k of Object.keys(state.users)) if (EXCLUDE.has(k)) delete state.users[k];
for (const k of Object.keys(state.users)) if (state.users[k].bot) dirty.delete(k);
const all = Object.keys(state.users).filter((k) => !state.users[k].bot);
// a private profile can be made public at any time: ask every run (one request each) and read it at once when it is
await pool(all.filter((k) => state.users[k].p), 4, async (k) => {
  const s = state.users[k];
  let p;
  try { p = await getJSON(`${API}/profiles/${encodeURIComponent(s.u)}`, 2); } catch (e) { if (/Blocked/.test(e.message)) throw e; return; }
  s.pchk = now;
  if (p && !p.isPrivate) { s.p = 0; dirty.add(k); }
});
const sweep = all.filter((k) => !dirty.has(k) && (process.env.ALL || now - state.users[k].last >= SWEEP_EVERY)).sort((a, b) => state.users[a].last - state.users[b].last).slice(0, FULL || process.env.ALL ? Infinity : SWEEP_MAX);
const todo = [...new Set([
  ...dirty,
  ...all.filter((k) => state.users[k].watch > now && now - state.users[k].last >= WATCH_EVERY),
  ...sweep,
])];
console.log(`Refreshing ${todo.length} of ${all.length} traders`);
let done = 0, failed = 0;
await pool(todo, 4, async (k) => {
  // XO answers some accounts' feeds with an error every time: skip those (they are read again next run), but a wider
  // failure is an outage, and then nothing is published
  try { await refresh(k); } catch (e) {
    if (!(e instanceof Abort) || /Blocked/.test(e.message) || ++failed > Math.max(10, todo.length / 10)) throw e;
    console.log(`skipped ${state.users[k].u}: ${e.message.replace(/^.*: /, "")}`);
  }
  if (++done % 200 === 0) { console.log(`…${done} traders`); await write(STATE, state); }
});

// ---------- 4. drop what has left the window ----------
for (const [k, s] of Object.entries(state.users)) {
  for (const id of Object.keys(s.ev)) if (s.ev[id][0] < start) delete s.ev[id];
  if (!s.p && !s.bot && !Object.keys(s.ev).length && now - s.last > 30 * DAY) delete state.users[k]; // quiet for a month
}
const keep = new Set(Object.values(state.users).flatMap((s) => Object.values(s.ev).map((e) => String(e[2]))));
for (const [id, mk] of Object.entries(state.markets)) if (mk.st !== "ACTIVE" && !keep.has(id) && !listed.has(+id)) delete state.markets[id];
state.from = start;

// ---------- 5. rank every day, per board ----------
// row: [username, pnl, staked, positions settled, won, lost, best market, best market id]
const today = dayKey(now), todayStart = Date.parse(today + "T00:00:00Z"), todaySpan = Math.max(now - todayStart, 1);
const perDay = {}; // day -> board -> username -> marketId -> { pnl, stake, last }
for (const s of Object.values(state.users)) {
  if (s.p || s.bot) continue;
  state.meta[s.u] = [s.a, s.v, s.c];
  for (const [t, k, id, pnl, stake] of Object.values(s.ev)) {
    const m = ((((perDay[dayKey(t)] ??= {})[k] ??= {})[s.u] ??= {})[id] ??= { pnl: 0, stake: 0, last: 0 });
    m.pnl += pnl; m.stake += stake; m.last = Math.max(m.last, t);
  }
}
const out = { updatedAt: 0, today, users: {}, markets: {}, m: null, c: null };
const names = new Set(), marketsShown = new Set();
for (const [d, boards] of Object.entries(perDay)) {
  if (Date.parse(d + "T00:00:00Z") < start) continue; // the window only covers part of this day
  const rec = (state.days[d] = { m: [], c: [] });
  for (const [k, people] of Object.entries(boards)) {
    rec[k] = Object.entries(people).map(([u, ms]) => {
      const list = Object.entries(ms);
      const best = list.reduce((b, x) => (x[1].pnl > b[1].pnl ? x : b), list[0]);
      return [u, r2(list.reduce((a, [, m]) => a + m.pnl, 0)), r2(list.reduce((a, [, m]) => a + m.stake, 0)), list.length,
        list.filter(([, m]) => m.pnl > 0.005).length, list.filter(([, m]) => m.pnl < -0.005).length, r2(best[1].pnl), +best[0]];
    }).sort((a, b) => b[1] - a[1] || b[2] - a[2]);
  }
}
for (const k of Object.keys(state.days)) {
  for (const b of ["m", "c"]) state.days[k][b] = (state.days[k][b] || []).filter(([u]) => !EXCLUDE.has(u.toLowerCase()) && !(state.users[u.toLowerCase()] || {}).p && !(state.users[u.toLowerCase()] || {}).bot);
  if (!state.days[k].m.length && !state.days[k].c.length) delete state.days[k];
}
for (const k of Object.keys(state.days).sort().slice(0, -KEEP_DAYS)) delete state.days[k];

const shown = Object.keys(state.days).sort().reverse().slice(0, SHOWN_DAYS);
for (const k of ["m", "c"]) {
  // today's race: each trader's running profit from 00:00 UTC to now
  const spark = {}, big = [];
  for (const [u, ms] of Object.entries((perDay[today] || {})[k] || {})) {
    const steps = Object.values(state.users[u.toLowerCase()].ev).filter((e) => e[1] === k && dayKey(e[0]) === today).sort((a, b) => a[0] - b[0]);
    const line = new Array(SPARK).fill(null);
    let run = 0;
    for (const [t, , , pnl] of steps) { run += pnl; line[Math.min(SPARK - 1, Math.floor(((t - todayStart) / todaySpan) * SPARK))] = run; }
    run = 0;
    for (let i = 0; i < SPARK; i++) { if (line[i] == null) line[i] = run; else run = line[i]; line[i] = r2(line[i]); }
    spark[u] = line;
    for (const [id, m] of Object.entries(ms)) big.push([u, +id, r2(m.pnl), m.last]);
  }
  big.sort((a, b) => b[2] - a[2]);
  out[k] = {
    days: shown.map((d) => ({ d, rows: state.days[d][k] || [] })).filter((x) => x.rows.length || x.d === today),
    spark,
    big: big.slice(0, 6), // today's biggest single wins: [username, marketId, pnl, when]
    open: [...listed.values()].filter((m) => m.k === k && m.status === "ACTIVE").length,
  };
  for (const x of out[k].days) for (const r of x.rows) { names.add(r[0]); marketsShown.add(r[7]); }
  for (const b of out[k].big) { names.add(b[0]); marketsShown.add(b[1]); }
}
out.users = Object.fromEntries([...names].map((u) => [u, state.meta[u] || ["", 0, ""]]));
out.markets = Object.fromEntries([...marketsShown].filter((id) => state.markets[id]).map((id) => { const m = state.markets[id]; return [id, [m.t, m.s, m.i]]; }));
out.updatedAt = Date.now(); // when the run finished: a run on GitHub can take minutes

await write(STATE, state);
await write(OUT, out);
const td = state.days[today] || { m: [], c: [] };
console.log(`Done: today ${td.m.length} on markets, ${td.c.length} on convictions; ${Object.keys(state.users).length} traders known (${Object.values(state.users).filter((u) => u.bot).length} bots), ${shown.length} days listed, ${requests} requests`);
