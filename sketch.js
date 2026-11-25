/* =====================================================================
   Stream Timer — p5.js
   Data model → planner (subscribe/cancel windows) → DOM tables + p5 canvas
   ===================================================================== */

// ---------- Date helpers (all local time, date-only) ----------
const D = (y, m, d) => new Date(y, m - 1, d);
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function addMonths(d, n) {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return t;
}
const dayDiff = (a, b) => Math.round((b - a) / 86400000);
const monthStart = d => new Date(d.getFullYear(), d.getMonth(), 1);
const monthEnd = d => new Date(d.getFullYear(), d.getMonth() + 1, 0);
const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtWeekday = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
const fmtMonth = d => d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const money = n => '$' + n.toFixed(2);
const iso = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
const _now = new Date();
const TODAY = D(_now.getFullYear(), _now.getMonth() + 1, _now.getDate());   // real date, so plans stay current

// ---------- Services & catalog: loaded from shows.json ----------
// SERVICES / SERVICE_ORDER / CATALOG are filled by applyParsed() from the JSON file.
let SERVICES = {};
let SERVICE_ORDER = [];
let CATALOG = [];
let DATA_META = { dataCheckedOn: null, source: '' };
let parsed0 = null;           // data the page started with
let usingImport = false;      // true while a viewer-imported shows.json is in use
const DATA_URL = 'shows.json';
const TRACK_URL = 'tracklist.json';
const SETTINGS_KEY = 'streamTimer';            // planner settings + selection
const SHOWS_KEY = 'streamTimer.shows';         // a shows.json the viewer imported
const TRACK_KEY = 'streamTimer.tracklist';     // the viewer's tracklist
const RATES_URL = 'rates.json';
const RATES_KEY = 'streamTimer.rates';         // the viewer's edited rates
// RATES.by[svc] = { plan, standard, discounts:[{id,label,price,kind:'intro'|'until',months,startsOn,signUpBy,endsOn,enabled,confirmed,note}] }
let RATES = { by: {}, bundles: [], checkedOn: null, currency: 'USD', notes: '', source: '', savedAt: null };
// RATES.bundles = [{ id, label, services:[...], price, status:'keeping'|'off', note }]
// A bundle you're keeping is always on: its services get no subscribe/cancel windows.
// Kept items = bundles you keep + single services set to "Keeping it" (not already in a kept bundle)
function keptBundles() {
  const real = (RATES.bundles || []).filter(b => b.status === 'keeping' && b.services.length && !state.cancelKeep.has(b.id));
  const inReal = new Set(real.flatMap(b => b.services));
  const singles = SERVICE_ORDER.filter(k => RATES.by[k] && RATES.by[k].status === 'keeping' && !inReal.has(k) && SERVICES[k])
    .map(k => ({ id: 'single-' + k, single: true, services: [k], price: priceOf(k), status: 'keeping', note: '',
      label: SERVICES[k].name + (RATES.by[k].plan ? ` (${RATES.by[k].plan})` : '') }));
  return [...real, ...singles.filter(x => !state.cancelKeep.has(x.id))];
}
function bundleFor(svc) { return keptBundles().find(b => b.services.includes(svc)) || null; }
const STATUSES = { watching: 'Watching', plan: 'Plan to watch', waiting: 'Waiting for new season', finished: 'Finished' };

// ---------- Episode schedule builders ----------
// batch(date, n) → n episodes on one day; weekly(start, n) → 1 per week
const batch = (date, n) => Array.from({ length: n }, () => date);
const weekly = (start, n, step = 7) => Array.from({ length: n }, (_, i) => addDays(start, i * step));
const toEps = dates => dates.map((date, i) => ({ n: i + 1, date }));

// ---------- JSON → app data ----------
// Parse "YYYY-MM-DD" as a local date (new Date("2026-12-02") would be UTC midnight).
function parseYMD(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(str));
  if (!m) throw new Error(`Bad date "${str}" (use YYYY-MM-DD)`);
  return D(+m[1], +m[2], +m[3]);
}
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const HEX = /^#[0-9A-Fa-f]{6}$/;
const PATTERNS = ['diag','diagR','horiz','vert','cross','grid','dots','zig'];

// Validate the JSON and turn it into { services, order, catalog, meta }. Throws a readable error.
function parseData(json) {
  if (!json || !Array.isArray(json.services) || !Array.isArray(json.shows)) throw new Error('the file needs "services" and "shows" lists');
  const services = {}, order = [];
  for (const sv of json.services) {
    if (!sv.id || !sv.name) throw new Error('each service needs an id and a name');
    services[sv.id] = {
      name: String(sv.name),
      bg: HEX.test(sv.bg) ? sv.bg : '#444444',
      fg: HEX.test(sv.fg) ? sv.fg : '#FFFFFF',
      price: Math.max(0, +sv.price || 0),
      pattern: PATTERNS.includes(sv.pattern) ? sv.pattern : 'diag'
    };
    order.push(String(sv.id));
  }
  const ids = new Set();
  const catalog = json.shows.map(sh => {
    if (!sh.id || !sh.title) throw new Error('each show needs an id and a title');
    if (ids.has(sh.id)) throw new Error(`show id "${sh.id}" is used twice`);
    ids.add(sh.id);
    if (!services[sh.service]) throw new Error(`"${sh.title}" uses a service that isn't listed ("${sh.service}")`);
    if (!Array.isArray(sh.episodes) || !sh.episodes.length) throw new Error(`"${sh.title}" has no episodes`);
    const eps = sh.episodes.map((e, i) => ({ n: +e.n || i + 1, date: parseYMD(e.date) }))
      .sort((x, y) => x.date - y.date || x.n - y.n);
    return { id: String(sh.id), title: String(sh.title), service: sh.service, type: sh.type === 'movie' ? 'movie' : 'series',
      conf: sh.confidence === 'confirmed' ? 'confirmed' : 'estimated', note: String(sh.note || ''), eps };
  });
  return { services, order, catalog, meta: { dataCheckedOn: json.dataCheckedOn || null, region: json.region || '' } };
}

function applyParsed(d, sourceLabel) {
  SERVICES = d.services; SERVICE_ORDER = d.order; CATALOG = d.catalog;
  DATA_META = { ...d.meta, source: sourceLabel, loadedAt: new Date() };
  for (const k of SERVICE_ORDER) if (RATES.by && !RATES.by[k]) RATES.by[k] = { plan: '', standard: SERVICES[k].price, discounts: [] };
  // drop custom shows / selections that no longer match the data
  state.custom = state.custom.filter(c => SERVICES[c.service]);
  const valid = new Set(allShows().map(s => s.id));
  state.selected = new Set([...state.selected].filter(id => valid.has(id)));
}

// Catalog → JSON (same schema as shows.json). includeCustom adds the viewer's own shows.
function toJSON(includeCustom) {
  const shows = (includeCustom ? allShows() : CATALOG).map(s => ({
    id: s.id, title: s.title, service: s.service, type: s.type || 'series',
    confidence: s.conf === 'confirmed' ? 'confirmed' : 'estimated',
    note: s.note, episodes: s.eps.map(e => ({ n: e.n, date: ymd(e.date) }))
  }));
  return {
    schemaVersion: 1,
    dataCheckedOn: DATA_META.dataCheckedOn,
    region: DATA_META.region || 'US',
    notes: 'Edit this file to update Stream Timer. confidence: confirmed | estimated. Dates are YYYY-MM-DD. Prices are USD per month.',
    services: SERVICE_ORDER.map(k => ({ id: k, ...SERVICES[k], price: priceOf(k) })),
    shows
  };
}

// Compare two catalogs by show id → readable change list
function diffCatalogs(oldC, newC) {
  const o = new Map(oldC.map(s => [s.id, s])), n = new Map(newC.map(s => [s.id, s]));
  const sig = s => s.service + '|' + s.conf + '|' + s.eps.map(e => e.n + '@' + ymd(e.date)).join(',');
  const added = newC.filter(s => !o.has(s.id)).map(s => s.title);
  const removed = oldC.filter(s => !n.has(s.id)).map(s => s.title);
  const changed = newC.filter(s => o.has(s.id) && sig(o.get(s.id)) !== sig(s)).map(s => {
    const was = o.get(s.id), bits = [];
    if (+first(was) !== +first(s)) bits.push(`premiere ${fmtShort(first(was))} → ${fmtShort(first(s))}`);
    if (+last(was) !== +last(s)) bits.push(`finale ${fmtShort(last(was))} → ${fmtShort(last(s))}`);
    if (was.eps.length !== s.eps.length) bits.push(`${was.eps.length} → ${s.eps.length} episodes`);
    if (was.conf !== s.conf) bits.push(s.conf === 'confirmed' ? 'now confirmed' : 'now estimated');
    if (was.service !== s.service) bits.push('moved to another service');
    return `${s.title}: ${bits.join(', ') || 'schedule details changed'}`;
  });
  return { added, removed, changed };
}

// ---------- App state ----------
const state = {
  selected: new Set(['bad-monkey-2','harry-potter-1','frisco-king','ahsoka-2']),
  kind: 'all',            // picker filter: all | series | movie
  skipSvc: new Set(),     // services cancelled from the plan (what-if)
  cancelKeep: new Set(),  // kept bundles/services cancelled in this plan (what-if)
  mode: 'airs',
  bingeDays: 14,
  consolidate: true,
  custom: [],           // shows the viewer added (stored in the tracklist)
  track: { name: 'My tracklist', items: [], source: '', savedAt: null },
  prices: {}            // viewer's own price edits; otherwise the JSON price is used
};
let plan = null;          // computed plan
let markers = [];         // canvas hover targets
let hover = null;
let cnv;
let downloads = null;   // claude.use('downloads') namespace, or null
// standard monthly rate: rates.json first, then the price in shows.json
const priceOf = k => (RATES.by[k] ? RATES.by[k].standard : (SERVICES[k]?.price ?? 0));

// localStorage for one viewer's custom shows/selection (optional)
function saveSettings() {   // not "save": p5.js owns a global save()
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      selected: [...state.selected], skipSvc: [...state.skipSvc], cancelKeep: [...state.cancelKeep], mode: state.mode, bingeDays: state.bingeDays,
      consolidate: state.consolidate, prices: state.prices
    }));
  } catch (e) { /* storage unavailable: app still works */ }
}
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (!s) return;
    // older versions kept custom shows here; carry them over
    if (Array.isArray(s.custom)) state.custom = s.custom.filter(c => c && c.start).map(c => buildCustom(c));
    state.selected = new Set(s.selected || []);
    state.skipSvc = new Set(s.skipSvc || []);
    state.cancelKeep = new Set(s.cancelKeep || []);
    state.mode = s.mode === 'binge' ? 'binge' : 'airs';
    state.bingeDays = +s.bingeDays || 14;
    state.consolidate = s.consolidate !== false;
    Object.assign(state.prices, s.prices || {});
  } catch (e) { /* ignore */ }
}

function buildCustom(c) {
  const [y, m, d] = c.start.split('-').map(Number);
  const s = D(y, m, d);
  let dates;
  if (c.cadence === 'movie') {
    return { ...c, count: 1, type: 'movie', conf: 'custom', eps: toEps([s]), note: `Added by you: movie streaming ${fmt(s)}.` };
  }
  if (c.cadence === 'binge') dates = batch(s, c.count);
  else if (c.cadence === 'two') dates = [...batch(s, Math.min(2, c.count)), ...weekly(addDays(s, 7), Math.max(0, c.count - 2))];
  else if (c.cadence === 'three') dates = [...batch(s, Math.min(3, c.count)), ...weekly(addDays(s, 7), Math.max(0, c.count - 3))];
  else dates = weekly(s, c.count);
  const label = { binge: 'all at once', two: '2-episode premiere, then weekly', three: '3-episode premiere, then weekly', weekly: 'weekly' }[c.cadence];
  return { ...c, type: 'series', conf: 'custom', eps: toEps(dates), note: `Added by you: ${c.count} episodes, ${label}.` };
}

const isMovie = s => s.type === 'movie';
const MOVIE_DAYS = 7;          // a movie needs about a week of access
const allShows = () => [...CATALOG, ...state.custom];
const selectedShows = () => allShows().filter(s => state.selected.has(s.id))
  .sort((a, b) => a.eps[0].date - b.eps[0].date);
const first = s => s.eps[0].date;
const last = s => s.eps[s.eps.length - 1].date;

// Split a show's episodes into runs separated by breaks longer than 30 days
function runsOf(s) {
  const runs = [];
  let cur = { start: first(s), end: first(s) };
  for (const e of s.eps) {
    if (dayDiff(cur.end, e.date) > 30) { runs.push(cur); cur = { start: e.date, end: e.date }; }
    else cur.end = e.date;
  }
  runs.push(cur);
  return runs;
}

// =====================================================================
// PLANNER
// For each show we need access over an interval [start, end]:
//   airs  → premiere .. finale
//   binge → finale .. finale + bingeDays - 1
// Intervals on the same service are merged when a later one starts while
// you're still paid up. Billing = calendar months from the subscribe date.
// =====================================================================
function buildWindow(svc, start, needEnd, shows) {
  let months = 1;
  while (addDays(addMonths(start, months), -1) < needEnd) months++;
  return { svc, start, needEnd, months, accessEnd: addDays(addMonths(start, months), -1), shows };
}

// Subscription windows for one service, given the picked shows on it.
// airs: one interval per run of episodes (a gap over 30 days = mid-season break)
// binge: one interval starting at the finale. Nothing starts before today.
function windowsFor(svc, list) {
  let ivs = [];
  const movieIvs = [];
  for (const s of list) {
    if (isMovie(s)) {                       // same in both modes: about a week from release (or from today)
      const st = first(s) < TODAY ? TODAY : first(s);
      movieIvs.push({ start: st, end: addDays(st, MOVIE_DAYS - 1), shows: [s] });
      continue;
    }
    if (state.mode === 'airs') {
      for (const run of runsOf(s)) {
        if (run.end < TODAY) continue;
        ivs.push({ start: run.start < TODAY ? TODAY : run.start, end: run.end, shows: [s] });
      }
      if (last(s) < TODAY) ivs.push({ start: TODAY, end: addDays(TODAY, state.bingeDays - 1), shows: [s] });
    } else {
      const st = last(s) < TODAY ? TODAY : last(s);
      ivs.push({ start: st, end: addDays(st, state.bingeDays - 1), shows: [s] });
    }
  }
  if (state.mode === 'binge' && state.consolidate && ivs.length > 1) {
    const series = ivs.flatMap(i => i.shows);
    const start = new Date(Math.max(...ivs.map(i => i.start)));
    ivs = [{ start, end: addDays(start, state.bingeDays * series.length - 1), shows: series }];
  }
  ivs.push(...movieIvs);
  ivs.sort((x, y) => x.start - y.start);
  const out = [];
  let cur = null;
  for (const iv of ivs) {
    if (cur && iv.start <= cur.accessEnd) {
      cur = buildWindow(svc, cur.start, new Date(Math.max(cur.needEnd, iv.end)), [...cur.shows, ...iv.shows]);
      out[out.length - 1] = cur;
    } else {
      cur = buildWindow(svc, iv.start, iv.end, iv.shows);
      out.push(cur);
    }
  }
  return out;
}

function computePlan() {
  const shows = selectedShows().filter(x => !state.skipSvc.has(x.service));
  const bySvc = {};
  for (const s of shows) (bySvc[s.service] ||= []).push(s);

  const windows = [];
  const covered = new Map();            // kept item id -> shows it covers
  for (const svc of SERVICE_ORDER) {
    const list = bySvc[svc];
    if (!list) continue;
    const kb = bundleFor(svc);
    if (kb) { covered.set(kb.id, [...(covered.get(kb.id) || []), ...list]); continue; }
    windows.push(...windowsFor(svc, list));
  }
  windows.sort((x, y) => x.start - y.start);

  const charges = [];
  for (const w of windows) {
    priceWindow(w);
    w.charges.forEach(c => charges.push(c));
    w.tip = dealTip(w);
  }

  // horizon: whole months covering shows and windows, starting this month
  let lo = D(2026, 12, 1), hi = D(2027, 6, 30);
  if (shows.length) {
    lo = monthStart(new Date(Math.max(+monthStart(TODAY), Math.min(...shows.map(first), ...windows.map(w => w.start)))));
    hi = monthEnd(new Date(Math.max(...shows.map(last), ...windows.map(w => w.accessEnd), +lo)));
  }
  const months = [];
  for (let m = new Date(lo); m <= hi; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) months.push(new Date(m));

  // kept items: charged every month of the plan (billing day unknown, so dated the 1st), plus a keep-or-cancel check
  const bundles = keptBundles().map(kb => {
    const cov = covered.get(kb.id) || [];
    const keptCost = r2(kb.price * months.length);
    // what starting/cancelling each included service as needed would cost instead
    let altCost = 0; const altWins = [];
    for (const k of kb.services) {
      const list = cov.filter(x => x.service === k);
      if (!list.length) continue;
      for (const w of windowsFor(k, list)) { priceWindow(w); altCost += w.cost; altWins.push(w); }
    }
    altCost = r2(altCost);
    const busy = months.filter(m => cov.some(x => x.eps.some(e => e.date >= monthStart(m) && e.date <= monthEnd(m))));
    const idle = months.filter(m => !busy.includes(m));
    let verdict, keep;
    if (!cov.length) {
      keep = false;
      verdict = `None of your picked shows are on it. Keeping it costs ${money(keptCost)} over these ${months.length} months. (This only looks at the shows you picked.)`;
    } else if (altCost + 0.005 < keptCost) {
      keep = false;
      verdict = `Starting and cancelling as needed would cost ${money(altCost)} instead of ${money(keptCost)} (saves ${money(r2(keptCost - altCost))}). ` +
        (idle.length ? `No new episodes for your picks in ${idle.map(m => m.toLocaleDateString('en-US', { month: 'short' })).join(', ')}.` : '');
    } else {
      keep = true;
      verdict = `Keeping it makes sense: starting and cancelling as needed would cost ${money(altCost)}, not less than ${money(keptCost)}.`;
    }
    return { ...kb, shows: cov, keptCost, altCost, altWins, busy, idle, keep, verdict };
  });
  for (const kb of bundles) for (const m of months) charges.push({ svc: 'bundle', bundle: kb, date: new Date(m), amount: kb.price, label: kb.label });
  const bundleTotal = r2(bundles.reduce((acc, kb) => acc + kb.keptCost, 0));
  const total = r2(charges.reduce((acc, c) => acc + c.amount, 0));
  const usedSvcs = [...new Set(windows.map(w => w.svc))];
  const baseline = usedSvcs.reduce((acc, k) => acc + priceOf(k) * months.length, 0);
  return { shows, windows, charges, months, lo, hi, total, baseline, usedSvcs, bundles, bundleTotal };
}

// =====================================================================
// DOM RENDERING
// =====================================================================
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const chip = svc => `<span class="chip" style="background:${SERVICES[svc].bg};color:${SERVICES[svc].fg}">${SERVICES[svc].name}</span>`;
const badge = conf => conf === 'confirmed' ? '<span class="badge b-conf">Confirmed</span>'
  : conf === 'custom' ? '<span class="badge b-custom">Your show</span>'
  : '<span class="badge b-est">Partly estimated</span>';

function cadenceText(s) {
  if (isMovie(s)) return `Movie · streaming ${fmtShort(first(s))}${first(s) < TODAY ? ' (out now)' : ''}`;
  const n = s.eps.length;
  const days = new Set(s.eps.map(e => +e.date)).size;
  if (days === 1) return `${n} episodes, all on ${fmtShort(first(s))}`;
  return `${n} episodes, ${fmtShort(first(s))} – ${fmtShort(last(s))}`;
}

function renderPicker() {
  const shows = allShows();
  let html = '';
  for (const svc of SERVICE_ORDER) {
    const list = shows.filter(s => s.service === svc && (state.kind === 'all' || (state.kind === 'movie') === isMovie(s))).sort((a, b) => first(a) - first(b));
    if (!list.length) continue;
    html += `<div class="svc-group" role="group" aria-labelledby="g-${svc}">
      <h3 class="svc-head" id="g-${svc}">${chip(svc)} <span class="sr-only">shows</span></h3><ul class="show-list">`;
    for (const s of list) {
      const cid = 'cb-' + s.id;
      html += `<li><input type="checkbox" id="${cid}" data-id="${esc(s.id)}" ${state.selected.has(s.id) ? 'checked' : ''}>
        <label for="${cid}"><b>${esc(s.title)}</b>${isMovie(s) ? '<span class="badge b-movie">Movie</span>' : ''}${badge(s.conf)}
        <span class="show-meta">${cadenceText(s)}</span></label>
        <button type="button" class="trk" data-id="${esc(s.id)}" aria-pressed="${isTracked(s.id)}" aria-label="Track ${esc(s.title)}">${isTracked(s.id) ? '★ Tracking' : '☆ Track'}</button>
        ${s.conf === 'custom' ? `<button type="button" class="rm" data-id="${esc(s.id)}" aria-label="Remove ${esc(s.title)}" style="min-height:36px;padding:.2rem .6rem">Remove</button>` : ''}
      </li>`;
    }
    html += '</ul></div>';
  }
  $('showPicker').innerHTML = html;
  $('showPicker').querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', e => {
      e.target.checked ? state.selected.add(e.target.dataset.id) : state.selected.delete(e.target.dataset.id);
      update();
    }));
  $('showPicker').querySelectorAll('button.trk').forEach(b =>
    b.addEventListener('click', e => toggleTrack(e.currentTarget.dataset.id)));
  $('showPicker').querySelectorAll('button.rm').forEach(b =>
    b.addEventListener('click', e => {
      const id = e.currentTarget.dataset.id;
      state.custom = state.custom.filter(c => c.id !== id);
      state.selected.delete(id);
      saveTrackLocal();
      renderPicker(); renderTracklist(); update();
      $('addDetails').querySelector('summary').focus();
    }));
}

function renderPrices() {
  $('priceGrid').innerHTML = SERVICE_ORDER.map(k => `
    <label for="p-${k}">${SERVICES[k].name}</label>
    <input type="number" id="p-${k}" min="0" step="0.01" value="${priceOf(k)}" inputmode="decimal">`).join('');
  SERVICE_ORDER.forEach(k => $('p-' + k).addEventListener('input', e => {
    const v = parseFloat(e.target.value);
    if (isNaN(v)) delete state.prices[k]; else state.prices[k] = Math.max(0, v);
    update();
  }));
}

// Things cancelled from the plan, each with a Restore button
function renderRemoved() {
  const box = $('removedBox');
  const items = [];
  for (const k of state.skipSvc) if (SERVICES[k]) {
    const n = selectedShows().filter(x => x.service === k).length;
    items.push({ act: 'restore-svc', id: k, text: `${SERVICES[k].name}: cancelled from the plan${n ? ` (${n} picked show${n > 1 ? 's' : ''} left out)` : ''}` });
  }
  for (const id of state.cancelKeep) {
    const real = (RATES.bundles || []).find(b => b.id === id);
    const svc = id.startsWith('single-') ? id.slice(7) : null;
    const name = real ? real.label : (svc && SERVICES[svc] ? SERVICES[svc].name : null);
    if (name) items.push({ act: 'restore-keep', id, text: `${name}: cancelled in this plan (normally kept)` });
  }
  if (!items.length) { box.textContent = ''; return; }
  box.innerHTML = `<div class="removed"><h3 style="margin:0">Removed from this plan</h3>
    <p class="hint">These are what-ifs for this plan only. Your rates.json and tracklist don’t change.</p>
    <ul>${items.map(i => `<li><span>${esc(i.text)}</span><button type="button" data-act="${i.act}" data-id="${esc(i.id)}" style="min-height:36px;padding:.2rem .6rem">Restore</button></li>`).join('')}</ul>
    <div class="card-actions"><button type="button" data-act="restore-all">Restore everything</button></div></div>`;
}

// One handler for every plan button (cards + removed list), via event delegation
function planAction(e) {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const { act, id, name } = btn.dataset;
  const before = plan.total;
  let what = '';
  if (act === 'skip-svc') { state.skipSvc.add(id); what = `Cancelled ${name} from the plan.`; }
  else if (act === 'cancel-keep') { state.cancelKeep.add(id); what = `Planned without ${name}. Its services now get dates only when your shows need them.`; }
  else if (act === 'rm-show') { state.selected.delete(id); renderPicker(); what = `Removed ${name} from the plan.`; }
  else if (act === 'restore-svc') { state.skipSvc.delete(id); what = `Restored ${SERVICES[id] ? SERVICES[id].name : id}.`; }
  else if (act === 'restore-keep') { state.cancelKeep.delete(id); what = 'Restored the kept subscription.'; }
  else if (act === 'restore-all') { state.skipSvc.clear(); state.cancelKeep.clear(); what = 'Restored everything you cancelled from the plan.'; }
  else return;
  update();
  const after = plan.total, diff = r2(after - before);
  $('planMsg').textContent = `${what} Plan total ${money(before)} → ${money(after)}` +
    (diff ? ` (${diff < 0 ? 'saves' : 'adds'} ${money(Math.abs(diff))}).` : ` (no change${act === 'rm-show' ? ': that show is on something you keep, so its cost stays the same' : ''}).`);
  $('recHead').focus();     // the pressed button is gone after the redraw
}

function renderResults() {
  const p = plan;
  renderRemoved();
  if (!p.shows.length) {
    $('liveSummary').innerHTML = `<p class="empty">${state.skipSvc.size ? 'Everything you picked is on a service you cancelled from the plan. Restore one below, or pick more shows.' : 'Pick at least one show to see your plan.'}</p>`;
    $('totals').innerHTML = ''; $('cards').innerHTML = '';
    $('monthTable').innerHTML = '<p class="empty">No shows selected.</p>';
    $('episodeGuides').innerHTML = '<p class="empty">No shows selected.</p>';
    return;
  }
  const saved = Math.max(0, p.baseline - (p.total - p.bundleTotal));
  $('liveSummary').innerHTML = `<p>${p.shows.length} show${p.shows.length>1?'s':''} on ${p.usedSvcs.length} service${p.usedSvcs.length>1?'s':''}.
    Strategy: <b>${state.mode === 'airs' ? 'watch as it airs' : 'binge after the finale'}</b>. Estimated total <b>${money(p.total)}</b>.</p>`;
  $('totals').innerHTML = `
    <div class="stat"><b>${money(p.total)}</b><span>Total with this plan${p.bundleTotal ? ` (includes ${money(p.bundleTotal)} for what you keep)` : ''}</span></div>
    <div class="stat"><b>${money(p.total - p.bundleTotal)}</b><span>Extra subscriptions to start and cancel</span></div>
    <div class="stat"><b>${money(saved)}</b><span>Saved vs. keeping ${p.usedSvcs.length ? `these ${p.usedSvcs.length} extra service${p.usedSvcs.length>1?'s':''}` : 'extra services'} for all ${p.months.length} months</span></div>`;

  $('cards').innerHTML = p.bundles.map(b => `<article class="card" style="border-left-color:${b.single ? SERVICES[b.services[0]].bg : '#3D3D46'}" aria-label="${esc(b.label)}, kept">
      <h3>${b.single ? chip(b.services[0]) : '<span class="chip" style="background:#3D3D46;color:#fff">Bundle</span>'} ${esc(b.single ? (RATES.by[b.services[0]].plan || '') : b.label)} <span class="show-meta" style="display:inline">· kept</span></h3>
      <dl>
        <dt>Status</dt><dd>Keeping it. No need to subscribe or cancel.</dd>
        ${b.single ? '' : `<dt>Includes</dt><dd>${b.services.map(k => SERVICES[k] ? SERVICES[k].name : esc(k)).join(', ')}</dd>`}
        <dt>Cost</dt><dd>${money(b.price)}/mo × ${p.months.length} months = <b>${money(r2(b.price * p.months.length))}</b></dd>
        <dt>Covers</dt><dd>${b.shows.length ? `<ul class="for-list">${b.shows.map(x => `<li><span>${esc(x.title)}</span>
          <button type="button" class="rm-show" data-act="rm-show" data-id="${esc(x.id)}" data-name="${esc(x.title)}" aria-label="Remove ${esc(x.title)} from the plan">Remove</button></li>`).join('')}</ul>` : '<span class="show-meta">None of your picked shows right now</span>'}</dd>
        <dt>Keep?</dt><dd><div class="tip" style="${b.keep ? '' : 'background:#FFF4DC;border-color:#E2C27A;color:#3D2A00'}"><b>${b.keep ? 'Worth keeping.' : 'Worth a second look.'}</b> ${esc(b.verdict)}</div></dd>
      </dl>
      <div class="card-actions"><button type="button" data-act="cancel-keep" data-id="${esc(b.id)}" data-name="${esc(b.label)}">Cancel it in this plan</button></div>
      </article>`).join('') + p.windows.map(w => {
    const S = SERVICES[w.svc];
    return `<article class="card" style="border-left-color:${S.bg}" aria-label="${S.name} window">
      <h3>${chip(w.svc)}</h3>
      <dl>
        <dt>Subscribe</dt><dd>${fmtWeekday(w.start)}</dd>
        <dt>Cancel by</dt><dd>${fmtWeekday(w.accessEnd)} <span class="show-meta">Renews on ${fmtShort(addDays(w.accessEnd,1))}. You can cancel right after subscribing and keep access until then.</span></dd>
        <dt>Cost</dt><dd>${breakdownText(w)} = <b>${money(w.cost)}</b>
          ${w.revert ? `<span class="show-meta">If you stay subscribed, the rate goes back to ${money(w.revert.amount)} on ${fmtShort(w.revert.date)}.</span>` : ''}
          ${w.tip ? `<div class="tip">${esc(w.tip)}</div>` : ''}</dd>
        <dt>For</dt><dd><ul class="for-list">${w.shows.map(x => `<li><span>${esc(x.title)}</span>
          <button type="button" class="rm-show" data-act="rm-show" data-id="${esc(x.id)}" data-name="${esc(x.title)}" aria-label="Remove ${esc(x.title)} from the plan">Remove</button></li>`).join('')}</ul></dd>
      </dl>
      <div class="card-actions"><button type="button" data-act="skip-svc" data-id="${w.svc}" data-name="${S.name}" aria-label="Cancel ${S.name} from the plan">Cancel ${S.name} from plan</button></div>
      </article>`;
  }).join('');

  // ---- month table ----
  let rows = '';
  for (const m of p.months) {
    const ms = monthStart(m), me = monthEnd(m);
    const subs = p.windows.filter(w => w.start >= ms && w.start <= me);
    const cancels = p.windows.filter(w => w.accessEnd >= ms && w.accessEnd <= me);
    const active = p.windows.filter(w => w.start <= me && w.accessEnd >= ms);
    const ch = p.charges.filter(c => c.date >= ms && c.date <= me);
    const eps = p.shows.flatMap(s => s.eps.filter(e => e.date >= ms && e.date <= me).map(() => s));
    const epCount = {};
    const movieTitles = new Set(eps.filter(isMovie).map(x => x.title));
    eps.forEach(s => epCount[s.title] = (epCount[s.title] || 0) + 1);
    rows += `<tr>
      <th scope="row">${fmtMonth(m)}</th>
      <td>${subs.length ? subs.map(w => `<b>${SERVICES[w.svc].name}</b> on ${fmtShort(w.start)}`).join('<br>') : '—'}</td>
      <td>${cancels.length ? cancels.map(w => `<b>${SERVICES[w.svc].name}</b> by ${fmtShort(w.accessEnd)}`).join('<br>') : '—'}</td>
      <td>${[...p.bundles.map(b => esc(b.label) + ' (kept)'), ...active.map(w => SERVICES[w.svc].name)].join(', ') || 'None'}</td>
      <td>${Object.keys(epCount).length ? Object.entries(epCount).map(([t,n]) => movieTitles.has(t) ? `${esc(t)}: movie` : `${esc(t)}: ${n}`).join('<br>') : '—'}</td>
      <td class="num">${money(ch.reduce((a,c)=>a+c.amount,0))}${ch.some(c => c.disc) ? '<br><span class="show-meta">includes discount</span>' : ''}${ch.some(c => c.bundle) ? `<br><span class="show-meta">includes ${money(ch.filter(c => c.bundle).reduce((a, c) => a + c.amount, 0))} for what you keep</span>` : ''}</td></tr>`;
  }
  $('monthTable').innerHTML = `<table>
    <caption>What to do each month, which services you’ll have, and how many new episodes come out</caption>
    <thead><tr><th scope="col">Month</th><th scope="col">Subscribe</th><th scope="col">Cancel</th>
    <th scope="col">Subscribed to</th><th scope="col">New episodes &amp; movies (selected)</th><th scope="col" class="num">Charges</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><th scope="row" colspan="5">Total</th><td class="num"><b>${money(p.total)}</b></td></tr></tfoot></table>`;

  // ---- episode guides ----
  $('episodeGuides').innerHTML = p.shows.map(s => `
    <details>
      <summary>${esc(s.title)} — ${SERVICES[s.service].name} ${isMovie(s) ? '<span class="badge b-movie">Movie</span>' : ''}${badge(s.conf)}</summary>
      <p class="hint">${esc(s.note)}</p>
      <div class="table-wrap"><table>
        <caption>${esc(s.title)} ${isMovie(s) ? 'streaming release' : 'episode release dates'}</caption>
        <thead><tr><th scope="col">${isMovie(s) ? 'Release' : 'Episode'}</th><th scope="col">Date</th></tr></thead>
        <tbody>${isMovie(s) ? `<tr><td>Movie</td><td>${fmtWeekday(first(s))}</td></tr>` : s.eps.map(e => `<tr><td>${e.n}${e.n === s.eps.length ? ' (finale)' : ''}</td><td>${fmtWeekday(e.date)}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`).join('');
}

function renderSpotlight() {
  const shows = allShows();
  const items = SERVICE_ORDER.map(svc => {
    const list = shows.filter(s => s.service === svc);
    if (!list.length) return null;
    // best single month: most finales within that month or the 60 days before it
    const months = [...new Set(list.map(s => +monthStart(last(s))))].map(t => new Date(t));
    let best = null, bestShows = [];
    for (const m of months) {
      const me = monthEnd(m), floor = addDays(monthStart(m), -60);
      const caught = list.filter(s => last(s) <= me && last(s) >= floor);
      if (caught.length > bestShows.length) { best = m; bestShows = caught; }
    }
    const eps = list.filter(x => !isMovie(x)).reduce((a, s) => a + s.eps.length, 0);
    const nMovies = list.filter(isMovie).length, nSeries = list.length - nMovies;
    return { svc, list, eps, best, bestShows, nMovies, nSeries };
  }).filter(Boolean).sort((a, b) => b.list.length - a.list.length || b.eps - a.eps);

  $('spotlight').innerHTML = items.map(it => `
    <li style="border-left-color:${SERVICES[it.svc].bg}">
      ${chip(it.svc)} <b>${[it.nSeries ? `${it.nSeries} series (${it.eps} episodes)` : '', it.nMovies ? `${it.nMovies} movie${it.nMovies > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ')}</b>
      <span class="show-meta">${it.list.sort((a,b)=>first(a)-first(b)).map(s => `${esc(s.title)} (${fmtShort(first(s))}–${fmtShort(last(s))})`).join('; ')}</span>
      <span class="show-meta"><b>Best single month:</b> ${fmtMonth(it.best)}. Catches ${it.bestShows.map(s => esc(s.title)).join(', ')}.</span>
    </li>`).join('');
}

function renderLegend() {
  $('legend').innerHTML = SERVICE_ORDER.map(k => {
    const S = SERVICES[k];
    return `<li><span class="swatch" style="background:${S.bg};background-image:${cssPattern(S.pattern, S.fg)}" aria-hidden="true"></span>${S.name}</li>`;
  }).join('') + `<li><span class="swatch" style="background:#fff;border-style:dashed" aria-hidden="true"></span>Today</li>`;
}
function cssPattern(p, c) {
  const a = c === '#FFFFFF' ? 'rgba(255,255,255,.55)' : 'rgba(0,0,0,.45)';
  return ({
    diag:  `repeating-linear-gradient(45deg,${a} 0 2px,transparent 2px 6px)`,
    diagR: `repeating-linear-gradient(-45deg,${a} 0 2px,transparent 2px 6px)`,
    horiz: `repeating-linear-gradient(0deg,${a} 0 2px,transparent 2px 5px)`,
    vert:  `repeating-linear-gradient(90deg,${a} 0 2px,transparent 2px 5px)`,
    cross: `repeating-linear-gradient(45deg,${a} 0 2px,transparent 2px 7px),repeating-linear-gradient(-45deg,${a} 0 2px,transparent 2px 7px)`,
    grid:  `repeating-linear-gradient(0deg,${a} 0 1px,transparent 1px 5px),repeating-linear-gradient(90deg,${a} 0 1px,transparent 1px 5px)`,
    dots:  `radial-gradient(${a} 1.3px,transparent 1.6px)`,
    zig:   `repeating-linear-gradient(60deg,${a} 0 2px,transparent 2px 7px)`
  })[p] + (p === 'dots' ? ';background-size:6px 6px' : '');
}

// ---------- Copy plan / ICS ----------
function planText() {
  const p = plan;
  if (!p.shows.length) return 'No shows selected.';
  let t = `STREAM TIMER PLAN (${state.mode === 'airs' ? 'watch as it airs' : 'binge after finale'})\n`;
  t += `Total: ${money(p.total)}${p.bundleTotal ? ` (includes ${money(p.bundleTotal)} for what you keep)` : ''}\n\n`;
  for (const b of p.bundles) t += `${b.label} (keeping): ${money(b.price)}/mo. Covers: ${b.shows.map(s => s.title).join('; ') || 'none of the picked shows'}\n   Keep check: ${b.verdict}\n`;
  for (const w of p.windows) {
    t += `${SERVICES[w.svc].name}: subscribe ${fmt(w.start)}, cancel by ${fmt(w.accessEnd)} — ${breakdownText(w)} = ${money(w.cost)}\n`;
    if (w.revert) t += `   Rate goes back to ${money(w.revert.amount)} on ${fmt(w.revert.date)} if you stay.\n`;
    t += `   For: ${w.shows.map(s => s.title).join('; ')}\n`;
  }
  t += '\nEPISODE SCHEDULES\n';
  for (const s of p.shows) t += `${s.title} (${SERVICES[s.service].name}): ${s.eps.map(e => `E${e.n} ${fmtShort(e.date)}`).join(', ')}\n`;
  return t;
}
function icsText() {
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Stream Timer//EN','CALSCALE:GREGORIAN'];
  const ev = (d, summary, desc, uid) => lines.push('BEGIN:VEVENT', `UID:${uid}@streamtimer`, `DTSTAMP:${iso(TODAY)}T120000Z`,
    `DTSTART;VALUE=DATE:${iso(d)}`, `DTEND;VALUE=DATE:${iso(addDays(d,1))}`, `SUMMARY:${summary}`, `DESCRIPTION:${desc}`, 'END:VEVENT');
  plan.windows.forEach((w, i) => {
    const n = SERVICES[w.svc].name, shows = w.shows.map(s => s.title).join('; ');
    ev(w.start, `Subscribe to ${n}`, `For: ${shows}`, `sub-${w.svc}-${i}-${iso(w.start)}`);
    ev(addDays(w.accessEnd, -2), `Cancel ${n} (renews ${fmtShort(addDays(w.accessEnd,1))})`, `Watched: ${shows}`, `can-${w.svc}-${i}-${iso(w.accessEnd)}`);
  });
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}
async function copyOut(text, label, msgEl) {
  const out = msgEl || $('copyMsg');
  const ta = $('copyFallback');
  try {
    await navigator.clipboard.writeText(text);
    ta.hidden = true;
    out.textContent = `${label} copied to your clipboard.`;
  } catch (e) {
    ta.hidden = false; ta.value = text; ta.focus(); ta.select();
    out.textContent = `Couldn’t copy automatically. The ${label.toLowerCase()} is in the box below and already selected, so press Ctrl+C or Cmd+C.`;
  }
}

// ---------- Data panel: update / export / import ----------
function renderDataInfo() {
  const checked = DATA_META.dataCheckedOn ? fmt(parseYMD(DATA_META.dataCheckedOn)) : 'unknown';
  $('dataInfo').textContent = `${CATALOG.length} shows · schedules checked ${checked} · loaded from ${DATA_META.source} at ` +
    DATA_META.loadedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '.';
}

function rebuildAll() {
  renderPicker(); renderPrices(); renderLegend(); renderSpotlight(); renderDataInfo(); renderTracklist(); update();
}

function announceChanges(prefix, d) {
  const box = $('updateMsg');
  box.textContent = '';
  const n = d.added.length + d.removed.length + d.changed.length;
  const p = document.createElement('p');
  p.textContent = n ? `${prefix} ${n} change${n > 1 ? 's' : ''}:` : `${prefix} No schedule changes.`;
  box.appendChild(p);
  if (!n) return;
  const ul = document.createElement('ul');
  const add = t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); };
  d.added.forEach(t => add(`New: ${t}`));
  d.changed.forEach(add);
  d.removed.forEach(t => add(`Removed: ${t}`));
  box.appendChild(ul);
}

function updateShows(silent) {
  silent = silent === true;
  const btn = $('updateShows');
  btn.disabled = true; btn.textContent = 'Updating…';
  if (!silent) $('updateMsg').textContent = 'Checking for new schedules…';
  const done = () => { btn.disabled = false; btn.textContent = 'Update shows'; };
  // p5 loadJSON with a cache-busting query so the newest published file is fetched
  loadJSON(`${DATA_URL}?v=${Date.now()}`, json => {
    try {
      const parsed = parseData(json);
      if (silent && usingImport) {
        // keep the viewer's imported data; just say if the online file is newer
        const online = parsed.meta.dataCheckedOn, mine = DATA_META.dataCheckedOn;
        if (online && (!mine || online > mine)) $('updateMsg').textContent =
          `A newer online shows.json is available (checked ${fmt(parseYMD(online))}). Press Update shows to switch to it.`;
        done(); return;
      }
      if (!silent) { lsDel(SHOWS_KEY); usingImport = false; }
      const d = diffCatalogs(CATALOG, parsed.catalog);
      const wasChecked = DATA_META.dataCheckedOn;
      applyParsed(parsed, 'shows.json');
      rebuildAll();
      if (!silent || d.added.length + d.removed.length + d.changed.length) announceChanges(parsed.meta.dataCheckedOn && parsed.meta.dataCheckedOn !== wasChecked
        ? `Updated to schedules checked ${fmt(parseYMD(parsed.meta.dataCheckedOn))}.`
        : 'Show data reloaded. You have the latest published schedules.', d);
    } catch (e) {
      $('updateMsg').textContent = `The data file has a problem, so nothing changed: ${e.message}.`;
    }
    done();
  }, () => {
    if (!silent) $('updateMsg').textContent = 'Couldn’t reach shows.json right now, so your schedules are unchanged. Try again in a moment.';
    else if (!usingImport) { DATA_META.source = 'the built-in copy (shows.json not reachable)'; renderDataInfo(); }
    done();
  });
}

// Downloads: inside claude.ai the page asks the platform (claude.use('downloads'));
// on a normal website (GitHub Pages, a local server) it saves files with a Blob link.
const browserDownloads = {
  save({ filename, data }) {
    const type = filename.endsWith('.json') ? 'application/json'
      : filename.endsWith('.ics') ? 'text/calendar' : 'text/plain';
    const url = URL.createObjectURL(new Blob([data], { type: type + ';charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return Promise.resolve({ status: 'saved' });
  }
};
let canSaveIcs = false;   // claude.ai refuses .ics files; a normal website can save them

async function initDownloads() {
  const inClaude = !!(window.claude && window.claude.use);
  try { downloads = inClaude ? await window.claude.use('downloads') : browserDownloads; } catch (e) { downloads = null; }
  if (!downloads && !inClaude) downloads = browserDownloads;
  canSaveIcs = downloads === browserDownloads;
  $('copyPlan').textContent = downloads ? 'Download plan (.txt)' : 'Copy plan as text';
  $('exportJson').textContent = downloads ? 'Export JSON' : 'Copy JSON';
  $('saveTrack').textContent = downloads ? 'Save tracklist.json' : 'Copy tracklist JSON';
  $('saveRates').textContent = downloads ? 'Save rates.json' : 'Copy rates JSON';
  $('copyIcs').textContent = canSaveIcs ? 'Download calendar reminders (.ics)' : 'Copy calendar reminders (.ics)';
}

async function saveOrCopy(filename, text, label, msgEl) {
  const out = msgEl || $('copyMsg');
  if (downloads) {
    try {
      await downloads.save({ filename, data: text });
      out.textContent = `${label} saved as ${filename}.`;
      return;
    } catch (e) {
      if (e && e.code === 'declined') { out.textContent = 'Download canceled.'; return; }
      if (e && e.code === 'rate_limited') { out.textContent = 'A download prompt is already open. Try again in a moment.'; return; }
      // any other code: fall back to copying
    }
  }
  copyOut(text, label, out);
}

function importJSONFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = parseData(JSON.parse(reader.result));
      const d = diffCatalogs(CATALOG, parsed.catalog);
      const fileIds = new Set(parsed.catalog.map(s => s.id));
      state.custom = state.custom.filter(c => !fileIds.has(c.id));   // the file's version wins
      applyParsed(parsed, `your imported file “${file.name}” (saved in this browser)`);
      lsSet(SHOWS_KEY, JSON.stringify({ name: file.name, json: JSON.parse(reader.result) }));
      rebuildAll();
      announceChanges(`Imported ${file.name}. It stays in this browser until you press Update shows.`, d);
    } catch (e) {
      $('updateMsg').textContent = `Couldn’t import ${file.name}: ${e.message}.`;
    }
    $('importFile').value = '';
  };
  reader.onerror = () => { $('updateMsg').textContent = `Couldn’t read ${file.name}.`; };
  reader.readAsText(file);
}

// ---------- Browser storage helpers (may be unavailable: always try/catch) ----------
function lsGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
function lsSet(key, val) { try { localStorage.setItem(key, val); return true; } catch (e) { return false; } }
function lsDel(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

// ---------- Tracklist (tracklist.json) ----------
// Schema: { schemaVersion, type:"stream-timer-tracklist", name, savedOn,
//           tracked:[{id,title,service,status,notes,addedOn}], customShows:[shows.json show objects] }
const showToJSON = s => ({ id: s.id, title: s.title, service: s.service, type: s.type || 'series',
  confidence: s.conf === 'confirmed' ? 'confirmed' : 'estimated', note: s.note,
  episodes: s.eps.map(e => ({ n: e.n, date: ymd(e.date) })) });

function tracklistJSON() {
  return {
    schemaVersion: 1,
    type: 'stream-timer-tracklist',
    name: state.track.name,
    savedOn: ymd(TODAY),
    tracked: state.track.items.map(i => ({ ...i })),
    customShows: state.custom.map(showToJSON)
  };
}

function parseTracklist(json) {
  if (!json || !Array.isArray(json.tracked)) throw new Error('a tracklist needs a "tracked" list');
  const seen = new Set();
  const items = [];
  for (const t of json.tracked) {
    if (!t || !t.id || seen.has(String(t.id))) continue;
    seen.add(String(t.id));
    items.push({
      id: String(t.id),
      title: String(t.title || t.id).slice(0, 200),
      service: String(t.service || ''),
      status: STATUSES[t.status] ? t.status : 'plan',
      notes: String(t.notes || '').slice(0, 500),
      addedOn: /^\d{4}-\d{2}-\d{2}$/.test(t.addedOn) ? t.addedOn : ymd(TODAY)
    });
  }
  const custom = [];
  for (const sh of (Array.isArray(json.customShows) ? json.customShows : [])) {
    try {
      if (!sh.id || !sh.title || !Array.isArray(sh.episodes) || !sh.episodes.length) continue;
      const eps = sh.episodes.map((e, i) => ({ n: +e.n || i + 1, date: parseYMD(e.date) })).sort((a, b) => a.date - b.date || a.n - b.n);
      custom.push({ id: String(sh.id), title: String(sh.title), service: String(sh.service), conf: 'custom', type: sh.type === 'movie' ? 'movie' : 'series',
        note: String(sh.note || 'Added by you.'), eps });
    } catch (e) { /* skip a bad custom show, keep the rest */ }
  }
  return { name: String(json.name || 'My tracklist').slice(0, 80), items, custom };
}

function applyTracklist(t, source) {
  state.track.name = t.name;
  state.track.items = t.items;
  state.track.source = source;
  // custom shows travel with the tracklist; keep any the page already had that the file lacks
  const ids = new Set(t.custom.map(c => c.id));
  state.custom = [...t.custom, ...state.custom.filter(c => !ids.has(c.id))].filter(c => SERVICES[c.service]);
}

// Save to this browser (called after every tracklist change)
function saveTrackLocal() {
  if (lsSet(TRACK_KEY, JSON.stringify(tracklistJSON()))) {
    state.track.savedAt = new Date();
    state.track.source = 'saved in this browser';
  }
  renderTrackInfo();
}

const isTracked = id => state.track.items.some(i => i.id === id);
function toggleTrack(id) {
  if (isTracked(id)) state.track.items = state.track.items.filter(i => i.id !== id);
  else {
    const s = allShows().find(x => x.id === id);
    if (!s) return;
    const st = last(s) < TODAY ? 'finished' : (first(s) <= TODAY ? 'watching' : 'plan');
    state.track.items.push({ id: s.id, title: s.title, service: s.service, status: st, notes: '', addedOn: ymd(TODAY) });
  }
  saveTrackLocal(); renderPicker(); renderTracklist();
  const btn = document.querySelector(`button.trk[data-id="${CSS.escape(id)}"]`);
  if (btn) btn.focus();
}

// One-line status for a tracked show based on the current schedule data
function trackProgress(item) {
  const s = allShows().find(x => x.id === item.id);
  if (!s) return 'Not in the current schedule data. Kept in your tracklist.';
  if (isMovie(s)) return first(s) < TODAY ? `Movie · streaming since ${fmt(first(s))}.` : `Movie · streams ${fmtWeekday(first(s))}.`;
  const next = s.eps.find(e => e.date >= TODAY);
  const out = s.eps.filter(e => e.date < TODAY).length;
  if (!next) return `All ${s.eps.length} episodes out (finale ${fmt(last(s))}).`;
  const sameDay = s.eps.filter(e => +e.date === +next.date).length;
  const what = sameDay > 1 ? `Episodes ${next.n}–${next.n + sameDay - 1}` : `Episode ${next.n}`;
  return `${out} of ${s.eps.length} out. Next: ${what} on ${fmtWeekday(next.date)}${next.n === s.eps.length ? ' (finale)' : ''}.`;
}

function renderTrackInfo() {
  const n = state.track.items.length;
  const when = state.track.savedAt ? ` at ${state.track.savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  $('trackInfo').textContent = `${state.track.name}: ${n} show${n === 1 ? '' : 's'} · ${state.track.source}${when}.`;
}

function renderTracklist() {
  renderTrackInfo();
  const ul = $('trackList');
  ul.textContent = '';
  if (!state.track.items.length) {
    const li = document.createElement('li');
    li.className = 'empty'; li.style.borderLeftWidth = '1px';
    li.textContent = 'Nothing tracked yet. Use ☆ Track next to a show.';
    ul.appendChild(li);
    return;
  }
  state.track.items.forEach((item, idx) => {
    const svc = SERVICES[item.service];
    const li = document.createElement('li');
    li.style.borderLeftColor = svc ? svc.bg : '#767680';
    const head = document.createElement('div');
    if (svc) { head.innerHTML = chip(item.service) + ' '; }
    const b = document.createElement('b'); b.textContent = item.title; head.appendChild(b);
    const prog = document.createElement('span'); prog.className = 'show-meta'; prog.textContent = trackProgress(item);
    head.appendChild(prog);
    li.appendChild(head);

    const row = document.createElement('div'); row.className = 'track-row';
    const selId = `ts-${idx}`, noteId = `tn-${idx}`;
    const sl = document.createElement('label'); sl.htmlFor = selId; sl.className = 'sr-only'; sl.textContent = `Status for ${item.title}`;
    const sel = document.createElement('select'); sel.id = selId;
    for (const [k, v] of Object.entries(STATUSES)) {
      const o = document.createElement('option'); o.value = k; o.textContent = v; o.selected = item.status === k; sel.appendChild(o);
    }
    sel.addEventListener('change', () => { item.status = sel.value; saveTrackLocal(); });
    const nl = document.createElement('label'); nl.htmlFor = noteId; nl.className = 'sr-only'; nl.textContent = `Notes for ${item.title}`;
    const note = document.createElement('input'); note.type = 'text'; note.id = noteId; note.placeholder = 'Notes'; note.value = item.notes; note.maxLength = 500;
    note.addEventListener('change', () => { item.notes = note.value; saveTrackLocal(); });
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Untrack';
    rm.setAttribute('aria-label', `Stop tracking ${item.title}`);
    rm.addEventListener('click', () => {
      state.track.items = state.track.items.filter(i => i.id !== item.id);
      saveTrackLocal(); renderPicker(); renderTracklist();
      $('trackMsg').textContent = `Stopped tracking ${item.title}.`;
      $('trackHead').focus();
    });
    row.append(sl, sel, nl, note, rm);
    li.appendChild(row);
    ul.appendChild(li);
  });
}

// Message with an optional Undo button (used when a load replaces the tracklist)
let trackUndo = null;
function trackMessage(text, undoable) {
  const box = $('trackMsg'); box.textContent = '';
  const p = document.createElement('span'); p.textContent = text + ' '; box.appendChild(p);
  if (undoable && trackUndo) {
    const u = document.createElement('button'); u.type = 'button'; u.textContent = 'Undo';
    u.style.minHeight = '36px'; u.style.padding = '.1rem .6rem';
    u.addEventListener('click', () => {
      const prev = trackUndo; trackUndo = null;
      applyTracklist(prev.t, prev.source); state.custom = prev.custom;
      saveTrackLocal(); renderPicker(); renderTracklist(); renderSpotlight(); update();
      box.textContent = 'Restored your previous tracklist.';
    });
    box.appendChild(u);
  }
}
function snapshotTrack() {
  trackUndo = { t: parseTracklist(tracklistJSON()), source: state.track.source, custom: state.custom.slice() };
}

// Load the default tracklist.json from the page's folder.
// startup=true: only used when this browser has no saved tracklist; not saved until you change it.
function loadDefaultTracklist(startup) {
  loadJSON(`${TRACK_URL}?v=${Date.now()}`, json => {
    try {
      const t = parseTracklist(json);
      if (!startup) snapshotTrack();
      applyTracklist(t, 'default tracklist.json');
      if (!startup) saveTrackLocal();
      renderPicker(); renderTracklist(); renderSpotlight(); update();
      if (!startup) trackMessage(`Loaded the default tracklist (${t.items.length} shows).`, true);
    } catch (e) {
      trackMessage(`The default tracklist.json has a problem: ${e.message}.`);
    }
  }, () => {
    if (startup) { state.track.source = 'new empty tracklist (no default tracklist.json found)'; renderTrackInfo(); }
    else trackMessage('No default tracklist.json was found next to this page.');
  });
}

function openTrackFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const t = parseTracklist(JSON.parse(reader.result));
      snapshotTrack();
      applyTracklist(t, `opened from ${file.name}`);
      saveTrackLocal();
      renderPicker(); renderTracklist(); renderSpotlight(); update();
      trackMessage(`Opened ${file.name}: ${t.items.length} tracked show${t.items.length === 1 ? '' : 's'}${t.custom.length ? `, ${t.custom.length} of your own` : ''}.`, true);
    } catch (e) {
      trackMessage(`Couldn’t open ${file.name}: ${e.message}.`);
    }
    $('openTrackFile').value = '';
  };
  reader.onerror = () => trackMessage(`Couldn’t read ${file.name}.`);
  reader.readAsText(file);
}

function planTracked() {
  const avail = new Set(allShows().map(s => s.id));
  const ids = state.track.items.filter(i => avail.has(i.id) && i.status !== 'finished').map(i => i.id);
  if (!ids.length) { trackMessage('None of your tracked shows (other than finished ones) are in the current schedule data.'); return; }
  state.selected = new Set(ids);
  renderPicker(); update();
  trackMessage(`Planning ${ids.length} tracked show${ids.length === 1 ? '' : 's'} (finished ones left out).`);
  $('results').focus();
}

// Startup order for the tracklist: this browser → default tracklist.json → empty
function initTracklist() {
  const raw = lsGet(TRACK_KEY);
  if (raw) {
    try { applyTracklist(parseTracklist(JSON.parse(raw)), 'saved in this browser'); return false; }
    catch (e) { /* corrupted: fall through to the default */ }
  }
  state.track.source = 'checking for a default tracklist.json…';
  if (state.custom.length) saveTrackLocal();     // migrate old custom shows into the tracklist
  return true;                                   // caller should load the default
}

// =====================================================================
// RATES (rates.json): standard rate + discounts, billed per charge date
// =====================================================================
const optDate = str => (str ? parseYMD(str) : null);
const r2 = n => Math.round(n * 100) / 100;

// Rate for one monthly charge. winStart = subscribe date, k = 0-based charge number.
function rateFor(svc, chargeDate, winStart, k) {
  const r = RATES.by[svc];
  const std = priceOf(svc);
  let best = { amount: std, label: 'standard', disc: null };
  if (!r) return best;
  for (const d of r.discounts) {
    if (!d.enabled || !(d.price >= 0)) continue;
    let ok = false;
    try {
      const st = optDate(d.startsOn);
      if (d.kind === 'intro') {
        const by = optDate(d.signUpBy);
        ok = (!st || winStart >= st) && (!by || winStart <= by) && k < (d.months || 0);
      } else {
        const end = optDate(d.endsOn);
        ok = (!st || chargeDate >= st) && (!end || chargeDate <= end);
      }
    } catch (e) { ok = false; }   // a half-typed date: ignore that discount
    if (ok && d.price < best.amount) best = { amount: d.price, label: d.label || 'discount', disc: d };
  }
  return best;
}

// Fill w.charges / w.cost / w.breakdown / w.revert for a subscription window
function priceWindow(w) {
  w.charges = []; w.cost = 0;
  for (let k = 0; k < w.months; k++) {
    const date = addMonths(w.start, k);
    const r = rateFor(w.svc, date, w.start, k);
    w.charges.push({ svc: w.svc, date, amount: r.amount, label: r.label, disc: r.disc });
    w.cost += r.amount;
  }
  w.cost = r2(w.cost);
  // group: "2 × $2.99 (Black Friday) + 1 × $10.99"
  const groups = [];
  for (const c of w.charges) {
    const g = groups[groups.length - 1];
    if (g && g.amount === c.amount && g.label === c.label) g.n++;
    else groups.push({ n: 1, amount: c.amount, label: c.label });
  }
  w.breakdown = groups;
  // when the price goes back to standard (if a discount is still running at the end)
  const lastC = w.charges[w.charges.length - 1];
  w.revert = null;
  if (lastC && lastC.disc) {
    const d = lastC.disc;
    const back = d.kind === 'intro' ? addMonths(w.start, d.months) : addDays(optDate(d.endsOn) || lastC.date, 1);
    w.revert = { date: back, amount: priceOf(w.svc), label: d.label };
  }
}
const breakdownText = w => w.breakdown.map(g => `${g.n} × ${money(g.amount)}${g.label !== 'standard' ? ` (${g.label})` : ''}`).join(' + ');

// If an intro deal needs you to sign up before this window starts, say what subscribing early would cost
function dealTip(w) {
  const r = RATES.by[w.svc];
  if (!r) return null;
  let best = null;
  for (const d of r.discounts) {
    if (!d.enabled || d.kind !== 'intro') continue;
    let by, st;
    try { by = optDate(d.signUpBy); st = optDate(d.startsOn); } catch (e) { continue; }
    if (!by || by < TODAY || w.start <= by) continue;          // already applies, or expired
    const alt = st && st > TODAY ? st : TODAY;
    if (alt > by) continue;
    const aw = buildWindow(w.svc, alt, w.needEnd, w.shows);
    priceWindow(aw);
    if (aw.cost + 0.005 < w.cost && (!best || aw.cost < best.cost)) best = { d, alt, by, cost: aw.cost, months: aw.months };
  }
  return best && `Deal tip: “${best.d.label}” needs you to subscribe by ${fmt(best.by)}. Subscribing on ${fmtShort(best.alt)} instead costs ${money(best.cost)} for ${best.months} month${best.months > 1 ? 's' : ''}, compared with ${money(w.cost)}.`;
}

// Plain-language "right now" summary for a service
function rateNow(svc) {
  const std = priceOf(svc), r = RATES.by[svc];
  const kb = bundleFor(svc);
  const bits = !kb ? [`Standard ${money(std)}/mo`]
    : kb.single ? [`Kept: ${money(std)}/mo, always on`]
    : [`In your ${kb.label} (${money(kb.price)}/mo, kept). Standard on its own ${money(std)}/mo`];
  if (r) for (const d of r.discounts) {
    if (!d.enabled) continue;
    try {
      if (d.kind === 'until') {
        const end = optDate(d.endsOn), st = optDate(d.startsOn);
        if ((!st || st <= TODAY) && (!end || end >= TODAY)) bits.push(`now ${money(d.price)} until ${end ? fmt(end) : 'further notice'}, then back to ${money(std)}`);
        else if (st && st > TODAY) bits.push(`${money(d.price)} from ${fmt(st)}${end ? ` to ${fmt(end)}` : ''}`);
      } else {
        const by = optDate(d.signUpBy);
        if (!by || by >= TODAY) bits.push(`deal: ${money(d.price)}/mo for ${d.months} month${d.months > 1 ? 's' : ''}${by ? ` if you subscribe by ${fmt(by)}` : ''}`);
      }
    } catch (e) { /* half-typed date */ }
  }
  return bits.join(' · ');
}

// ---------- rates.json parse / build ----------
function parseRates(json) {
  if (!json || !Array.isArray(json.rates)) throw new Error('a rates file needs a "rates" list');
  const by = {};
  for (const r of json.rates) {
    if (!r || !r.service) continue;
    const std = Number(r.standard);
    if (!(std >= 0)) throw new Error(`"${r.service}" needs a standard rate of 0 or more`);
    const discounts = (Array.isArray(r.discounts) ? r.discounts : []).map((d, i) => {
      const kind = d.kind === 'until' ? 'until' : 'intro';
      for (const f of ['startsOn', 'signUpBy', 'endsOn']) if (d[f]) parseYMD(d[f]);   // throws a readable error
      return {
        id: String(d.id || `${r.service}-d${i + 1}`), label: String(d.label || 'Discount').slice(0, 80),
        price: Math.max(0, Number(d.price) || 0), kind, months: Math.max(1, Math.min(36, parseInt(d.months) || 1)),
        startsOn: d.startsOn || '', signUpBy: d.signUpBy || '', endsOn: d.endsOn || '',
        enabled: d.enabled === true, confirmed: d.confirmed === true, note: String(d.note || '').slice(0, 400)
      };
    });
    by[String(r.service)] = { plan: String(r.plan || '').slice(0, 80), standard: r2(std), status: r.status === 'keeping' ? 'keeping' : 'as-needed', discounts };
  }
  const bundles = (Array.isArray(json.bundles) ? json.bundles : []).filter(b => b && Array.isArray(b.services)).map((b, i) => {
    const price = Number(b.price);
    if (!(price >= 0)) throw new Error(`bundle "${b.label || i + 1}" needs a price of 0 or more`);
    return { id: String(b.id || `bundle-${i + 1}`), label: String(b.label || 'Bundle').slice(0, 80),
      services: [...new Set(b.services.map(String))], price: r2(price),
      status: b.status === 'keeping' ? 'keeping' : 'off', note: String(b.note || '').slice(0, 400) };
  });
  return { by, bundles, checkedOn: json.checkedOn || null, currency: json.currency || 'USD', notes: String(json.notes || '') };
}

function builtinRates() {
  try { return parseRates(JSON.parse(document.getElementById('fallbackRates').textContent)); } catch (e) { /* none embedded */ }
  const by = {};
  for (const k of SERVICE_ORDER) by[k] = { plan: '', standard: SERVICES[k].price, discounts: [] };
  return { by, bundles: [], checkedOn: DATA_META.dataCheckedOn, currency: 'USD', notes: '' };
}

function ratesJSON() {
  return {
    schemaVersion: 1, type: 'stream-timer-rates', checkedOn: RATES.checkedOn || ymd(TODAY), currency: RATES.currency,
    notes: RATES.notes || "standard = normal monthly price. discounts: kind 'intro' = promo price for the first N monthly charges if you subscribe between startsOn and signUpBy; kind 'until' = promo price on every charge dated up to endsOn, then standard. Only discounts with enabled:true change the plan.",
    rates: Object.entries(RATES.by).map(([service, r]) => ({ service, plan: r.plan, standard: r.standard, status: r.status || 'as-needed', discounts: r.discounts.map(d => ({ ...d })) })),
    bundles: (RATES.bundles || []).map(b => ({ ...b, services: b.services.slice() }))
  };
}

function applyRates(parsed, source) {
  // make sure every current service has an entry
  for (const k of SERVICE_ORDER) if (!parsed.by[k]) parsed.by[k] = { plan: '', standard: SERVICES[k].price, discounts: [] };
  RATES = { ...parsed, source, savedAt: null };
  // older versions kept price edits in settings: fold them in once
  if (Object.keys(state.prices).length) {
    for (const [k, v] of Object.entries(state.prices)) if (RATES.by[k] && v >= 0) RATES.by[k].standard = r2(v);
    state.prices = {};
    saveRatesLocal();
  }
}

function saveRatesLocal() {
  if (lsSet(RATES_KEY, JSON.stringify(ratesJSON()))) { RATES.savedAt = new Date(); RATES.source = 'saved in this browser'; }
  renderRatesInfo();
}

function renderRatesInfo() {
  const when = RATES.savedAt ? ` at ${RATES.savedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : '';
  const active = Object.values(RATES.by).reduce((a, r) => a + r.discounts.filter(d => d.enabled).length, 0);
  const kb = keptBundles().length;
  $('ratesInfo').textContent = `Rates checked ${RATES.checkedOn ? fmt(parseYMD(RATES.checkedOn)) : 'unknown'} · ${kb} kept (bundles and services) · ${active} discount${active === 1 ? '' : 's'} in use · ${RATES.source}${when}.`;
}

// ---------- rates editor (DOM, labeled inputs) ----------
let rateUid = 0;
function field(labelText, input, cls) {
  const l = document.createElement('label'); if (cls) l.className = cls;
  if (cls === 'inline') { l.append(input, document.createTextNode(' ' + labelText)); }
  else { l.append(document.createTextNode(labelText), input); }
  return l;
}
function mkInput(type, value, attrs = {}) {
  const i = document.createElement('input'); i.type = type;
  if (type === 'checkbox') i.checked = !!value; else i.value = value ?? '';
  Object.entries(attrs).forEach(([k, v]) => i.setAttribute(k, v));
  return i;
}

function ratesChanged(svc) {
  saveRatesLocal();
  const sum = document.getElementById('rsum-' + svc);
  if (sum) sum.textContent = rateNow(svc);
  update();
}

function renderRates() {
  renderRatesInfo();
  const host = $('ratesEditor');
  const openNow = new Set([...host.querySelectorAll('details[open]')].map(d => d.dataset.svc));
  host.textContent = '';
  renderBundles(host);
  for (const svc of SERVICE_ORDER) {
    const r = RATES.by[svc]; if (!r) continue;
    const det = document.createElement('details'); det.className = 'rate-svc'; det.dataset.svc = svc;
    if (openNow.has(svc)) det.open = true;
    const sm = document.createElement('summary');
    sm.innerHTML = chip(svc);
    const meta = document.createElement('span'); meta.className = 'show-meta'; meta.id = 'rsum-' + svc; meta.textContent = rateNow(svc);
    sm.appendChild(meta);
    det.appendChild(sm);

    const grid = document.createElement('div'); grid.className = 'rate-grid';
    const plan = mkInput('text', r.plan, { maxlength: 80 });
    plan.addEventListener('change', () => { r.plan = plan.value; ratesChanged(svc); });
    const std = mkInput('number', r.standard, { min: 0, step: '0.01', inputmode: 'decimal' });
    std.addEventListener('input', () => { const v = parseFloat(std.value); if (v >= 0) { r.standard = r2(v); ratesChanged(svc); } });
    const keepSel = document.createElement('select');
    [['as-needed', 'Subscribe only when needed'], ['keeping', 'Keeping it (always on)']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = (r.status || 'as-needed') === v; keepSel.appendChild(o);
    });
    keepSel.addEventListener('change', () => { r.status = keepSel.value; bundlesChanged(); renderRatesInfo(); });
    grid.append(field(`${SERVICES[svc].name} plan name`, plan), field('Standard rate ($/month)', std), field('How you pay', keepSel));
    det.appendChild(grid);

    r.discounts.forEach((d, i) => det.appendChild(discountEditor(svc, r, d, i)));

    const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add a discount';
    add.setAttribute('aria-label', `Add a discount for ${SERVICES[svc].name}`);
    add.addEventListener('click', () => {
      r.discounts.push({ id: `${svc}-${Date.now()}`, label: 'New discount', price: r2(r.standard / 2), kind: 'intro', months: 3,
        startsOn: ymd(TODAY), signUpBy: '', endsOn: '', enabled: true, confirmed: true, note: '' });
      det.open = true; ratesChanged(svc); renderRates();
      const f = document.querySelector(`details[data-svc="${svc}"] .disc:last-of-type input[type=text]`); if (f) f.focus();
    });
    det.appendChild(add);
    host.appendChild(det);
  }
}

function discountEditor(svc, r, d, idx) {
  const fs = document.createElement('fieldset'); fs.className = 'disc';
  const lg = document.createElement('legend');
  lg.textContent = `${SERVICES[svc].name} discount ${idx + 1}: ${d.label} `;
  if (!d.confirmed) { const t = document.createElement('span'); t.className = 'tag-unconf'; t.textContent = 'Not confirmed'; lg.appendChild(t); }
  fs.appendChild(lg);
  if (d.note) { const n = document.createElement('p'); n.className = 'hint'; n.textContent = d.note; fs.appendChild(n); }

  const g = document.createElement('div'); g.className = 'rate-grid';
  const use = mkInput('checkbox', d.enabled);
  use.addEventListener('change', () => { d.enabled = use.checked; ratesChanged(svc); });
  const label = mkInput('text', d.label, { maxlength: 80 });
  label.addEventListener('change', () => { d.label = label.value || 'Discount'; ratesChanged(svc); });
  const price = mkInput('number', d.price, { min: 0, step: '0.01', inputmode: 'decimal' });
  price.addEventListener('input', () => { const v = parseFloat(price.value); if (v >= 0) { d.price = r2(v); ratesChanged(svc); } });
  const kind = document.createElement('select');
  [['intro', 'Intro: first few months for new sign-ups'], ['until', 'Until a date, then standard']].forEach(([v, t]) => {
    const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = d.kind === v; kind.appendChild(o);
  });
  const months = mkInput('number', d.months, { min: 1, max: 36, step: 1 });
  months.addEventListener('input', () => { const v = parseInt(months.value); if (v >= 1) { d.months = Math.min(36, v); ratesChanged(svc); } });
  const starts = mkInput('date', d.startsOn);
  starts.addEventListener('change', () => { d.startsOn = starts.value; ratesChanged(svc); });
  const signBy = mkInput('date', d.signUpBy);
  signBy.addEventListener('change', () => { d.signUpBy = signBy.value; ratesChanged(svc); });
  const ends = mkInput('date', d.endsOn);
  ends.addEventListener('change', () => { d.endsOn = ends.value; ratesChanged(svc); });

  const fMonths = field('Months at this price', months), fSign = field('Subscribe by', signBy), fEnds = field('Ends on (back to standard after)', ends);
  const showKind = () => { const intro = kind.value === 'intro'; fMonths.hidden = !intro; fSign.hidden = !intro; fEnds.hidden = intro; };
  kind.addEventListener('change', () => { d.kind = kind.value; showKind(); ratesChanged(svc); });
  showKind();

  g.append(field('Use this discount', use, 'inline'), field('Name', label), field('Discount rate ($/month)', price),
    field('Kind', kind), fMonths, field('Starts on (optional)', starts), fSign, fEnds);
  fs.appendChild(g);

  const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Remove discount';
  rm.setAttribute('aria-label', `Remove ${d.label} from ${SERVICES[svc].name}`);
  rm.addEventListener('click', () => {
    r.discounts = r.discounts.filter(x => x !== d);
    ratesChanged(svc); renderRates();
    const det = document.querySelector(`details[data-svc="${svc}"]`); if (det) det.querySelector('summary').focus();
    $('ratesMsg').textContent = `Removed ${d.label} from ${SERVICES[svc].name}.`;
  });
  fs.appendChild(rm);
  return fs;
}
function bundlesChanged() {
  saveRatesLocal();
  SERVICE_ORDER.forEach(k => { const el = document.getElementById('rsum-' + k); if (el) el.textContent = rateNow(k); });
  update();
}

function renderBundles(host) {
  const box = document.createElement('div');
  const h = document.createElement('h3'); h.textContent = 'Bundles'; box.appendChild(h);
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = 'A bundle set to “Keeping it” counts as always on: its services never get subscribe or cancel dates, and its monthly price is added to every month of your plan.';
  box.appendChild(hint);
  (RATES.bundles || []).forEach((b, idx) => {
    const fs = document.createElement('fieldset'); fs.className = 'disc';
    const lg = document.createElement('legend'); lg.textContent = `Bundle ${idx + 1}: ${b.label}`; fs.appendChild(lg);
    if (b.note) { const n = document.createElement('p'); n.className = 'hint'; n.textContent = b.note; fs.appendChild(n); }
    const g = document.createElement('div'); g.className = 'rate-grid';
    const name = mkInput('text', b.label, { maxlength: 80 });
    name.addEventListener('change', () => { b.label = name.value || 'Bundle'; bundlesChanged(); });
    const price = mkInput('number', b.price, { min: 0, step: '0.01', inputmode: 'decimal' });
    price.addEventListener('input', () => { const v = parseFloat(price.value); if (v >= 0) { b.price = r2(v); bundlesChanged(); } });
    const st = document.createElement('select');
    [['keeping', 'Keeping it (always on)'], ['off', 'Not using']].forEach(([v, t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; o.selected = b.status === v; st.appendChild(o);
    });
    st.addEventListener('change', () => { b.status = st.value; bundlesChanged(); });
    g.append(field('Bundle name', name), field('Bundle rate ($/month)', price), field('Status', st));
    fs.appendChild(g);
    const svcBox = document.createElement('fieldset'); svcBox.className = 'disc'; svcBox.style.background = '#fff';
    const sl = document.createElement('legend'); sl.textContent = 'Services included'; svcBox.appendChild(sl);
    const sg = document.createElement('div'); sg.className = 'rate-grid';
    for (const k of SERVICE_ORDER) {
      const cb = mkInput('checkbox', b.services.includes(k));
      cb.addEventListener('change', () => {
        b.services = cb.checked ? [...new Set([...b.services, k])] : b.services.filter(x => x !== k);
        bundlesChanged();
      });
      sg.appendChild(field(SERVICES[k].name, cb, 'inline'));
    }
    svcBox.appendChild(sg); fs.appendChild(svcBox);
    const rm = document.createElement('button'); rm.type = 'button'; rm.textContent = 'Remove bundle';
    rm.setAttribute('aria-label', `Remove ${b.label}`);
    rm.addEventListener('click', () => {
      RATES.bundles = RATES.bundles.filter(x => x !== b);
      bundlesChanged(); renderRates();
      $('ratesMsg').textContent = `Removed ${b.label}.`; $('ratesHead').focus();
    });
    fs.appendChild(rm);
    box.appendChild(fs);
  });
  const add = document.createElement('button'); add.type = 'button'; add.textContent = 'Add a bundle';
  add.addEventListener('click', () => {
    (RATES.bundles ||= []).push({ id: `bundle-${Date.now()}`, label: 'New bundle', services: [], price: 0, status: 'keeping', note: '' });
    bundlesChanged(); renderRates();
    const inputs = $('ratesEditor').querySelectorAll('.bundles-box fieldset.disc input[type=text]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  box.appendChild(add);
  box.className = 'bundles-box';
  host.appendChild(box);
  const h2 = document.createElement('h3'); h2.textContent = 'Single services'; host.appendChild(h2);
}
function renderPrices() { renderRates(); }

// ---------- rates load / open ----------
function loadDefaultRates(startup) {
  loadJSON(`${RATES_URL}?v=${Date.now()}`, json => {
    try {
      applyRates(parseRates(json), 'default rates.json');
      if (!startup) { saveRatesLocal(); $('ratesMsg').textContent = 'Loaded the default rates.json.'; }
      renderRates(); update();
    } catch (e) { $('ratesMsg').textContent = `The default rates.json has a problem: ${e.message}.`; }
  }, () => {
    if (startup) { RATES.source = 'built-in copy of rates.json (no online rates.json found)'; renderRatesInfo(); }
    else $('ratesMsg').textContent = 'No default rates.json was found next to this page.';
  });
}

function openRatesFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      applyRates(parseRates(JSON.parse(reader.result)), `opened from ${file.name}`);
      saveRatesLocal(); renderRates(); update();
      $('ratesMsg').textContent = `Opened ${file.name}.`;
    } catch (e) { $('ratesMsg').textContent = `Couldn’t open ${file.name}: ${e.message}.`; }
    $('openRatesFile').value = '';
  };
  reader.onerror = () => { $('ratesMsg').textContent = `Couldn’t read ${file.name}.`; };
  reader.readAsText(file);
}

// Startup: this browser → default rates.json → built-in prices. Returns true if the default should be fetched.
function initRates() {
  const raw = lsGet(RATES_KEY);
  if (raw) {
    try { applyRates(parseRates(JSON.parse(raw)), 'saved in this browser'); return false; } catch (e) { /* fall through */ }
  }
  applyRates(builtinRates(), 'checking for a default rates.json…');
  return true;
}

// ---------- Update cycle ----------
function update() {
  plan = computePlan();
  renderResults();
  saveSettings();
  if (cnv) { resizeForPlan(); redraw(); }
}

// =====================================================================
// p5 CANVAS TIMELINE
// =====================================================================
const ROW_H = 34, HEAD_H = 44, SUB_HEAD = 34, PAD_B = 16;
function labelW() { return Math.min(210, Math.max(130, width * 0.28)); }
function canvasHeight() {
  const n = plan ? plan.shows.length : 0, w = plan ? plan.windows.length : 0;
  const nb = plan ? plan.bundles.length : 0;
  return HEAD_H + Math.max(1, n) * ROW_H + SUB_HEAD + Math.max(1, w + nb) * ROW_H + PAD_B;
}
function resizeForPlan() {
  const w = $('canvasHolder').clientWidth || 800;
  resizeCanvas(w, canvasHeight());
}

// Start instantly from the copy of shows.json embedded in <script id="fallbackData">,
// then fetch the live shows.json right after setup (see updateShows(true)).
const embeddedData = () => JSON.parse(document.getElementById('fallbackData').textContent);

function setup() {
  loadSettings();
  // shows.json startup order: imported copy in this browser → online shows.json (fetched below) → built-in copy
  applyParsed(parsed0 = parseData(embeddedData()), 'the built-in copy');
  const imported = lsGet(SHOWS_KEY);
  if (imported) {
    try {
      const rec = JSON.parse(imported);
      applyParsed(parseData(rec.json), `your imported file “${rec.name}” (saved in this browser)`);
      usingImport = true;
    } catch (e) { lsDel(SHOWS_KEY); }
  }
  // tracklist startup order: this browser → default tracklist.json (fetched below) → empty
  const needDefaultTrack = initTracklist();
  // rates startup order: this browser → default rates.json (fetched below) → built-in prices
  const needDefaultRates = initRates();
  // sync controls to state
  $(state.mode === 'binge' ? 'modeBinge' : 'modeAirs').checked = true;
  $('bingeDays').value = state.bingeDays;
  $('consolidate').checked = state.consolidate;
  $('fService').innerHTML = SERVICE_ORDER.map(k => `<option value="${k}">${SERVICES[k].name}</option>`).join('');

  plan = computePlan();
  cnv = createCanvas($('canvasHolder').clientWidth || 800, canvasHeight());
  cnv.parent('canvasHolder');
  pixelDensity(Math.min(2, window.devicePixelRatio || 1));
  textFont('Arial');
  noLoop();

  renderPicker(); renderPrices(); renderLegend(); renderSpotlight(); renderResults(); renderDataInfo(); renderTracklist();
  wireControls();
  initDownloads();
  updateShows(true);            // quietly check the online shows.json
  if (needDefaultTrack) loadDefaultTracklist(true);
  if (needDefaultRates) loadDefaultRates(true);
}

function windowResized() { resizeForPlan(); redraw(); }

function draw() {
  clear(); background(255);
  markers = [];
  const p = plan;
  const x0 = labelW(), x1 = width - 14;
  const total = dayDiff(p.lo, p.hi) + 1;
  const X = d => map(dayDiff(p.lo, d), 0, total, x0, x1);

  // month grid + labels
  textSize(12); textStyle(BOLD);
  for (const m of p.months) {
    const xa = X(m), xb = X(addDays(monthEnd(m), 1));
    noStroke(); fill(p.months.indexOf(m) % 2 ? '#F3F3F7' : '#FFFFFF');
    rect(xa, HEAD_H - 6, xb - xa, height - HEAD_H + 6 - PAD_B);
    stroke('#C9C9D2'); strokeWeight(1); line(xa, 8, xa, height - PAD_B);
    noStroke(); fill('#16161A'); textAlign(CENTER, CENTER);
    const lab = (xb - xa) > 70 ? m.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : m.toLocaleDateString('en-US', { month: 'short' });
    text(lab, (xa + xb) / 2, 22);
  }

  // today
  if (TODAY >= p.lo && TODAY <= p.hi) {
    const xt = X(TODAY);
    stroke('#16161A'); strokeWeight(1.5); drawingContext.setLineDash([4, 4]);
    line(xt, HEAD_H - 6, xt, height - PAD_B); drawingContext.setLineDash([]);
  }

  // show rows
  if (!p.shows.length) {
    noStroke(); fill('#45454F'); textStyle(ITALIC); textAlign(LEFT, CENTER); textSize(14);
    text('Pick shows on the left to see their release schedules.', x0, HEAD_H + ROW_H / 2);
  }
  p.shows.forEach((s, i) => {
    const y = HEAD_H + i * ROW_H + ROW_H / 2;
    const S = SERVICES[s.service];
    // label
    noStroke(); fill('#16161A'); textStyle(BOLD); textSize(12); textAlign(LEFT, CENTER);
    text(truncate(s.title, x0 - 18), 8, y - 7);
    textStyle(NORMAL); fill('#45454F'); textSize(11);
    text(S.name + (s.conf === 'estimated' ? ' · partly est.' : ''), 8, y + 8);
    // run bar
    const earlier = s.eps.filter(e => e.date < p.lo).length;
    if (earlier === s.eps.length) {                 // everything already released
      noStroke(); fill('#45454F'); textStyle(ITALIC); textSize(11); textAlign(LEFT, CENTER);
      text(`All ${s.eps.length} episodes already out (finale ${fmtShort(last(s))})`, x0 + 6, y);
      return;
    }
    // one bar per run of episodes, so mid-season breaks show as gaps (movies: no bar)
    for (const run of (isMovie(s) ? [] : runsOf(s))) {
      if (run.end < p.lo) continue;
      const xa = X(run.start < p.lo ? p.lo : run.start), xb = Math.max(X(run.end), xa + 2);
      fill(S.bg); stroke('#16161A'); strokeWeight(1);
      rect(xa - 4, y - 7, xb - xa + 8, 14, 7);
    }
    if (earlier) {
      noStroke(); fill('#16161A'); textStyle(NORMAL); textSize(10); textAlign(LEFT, CENTER);
      text(`◀ ${earlier} earlier`, x0 + 2, y - 12);
    }
    // episode markers grouped by day
    const byDay = {};
    s.eps.forEach(e => (byDay[+e.date] ||= []).push(e));
    for (const [t, list] of Object.entries(byDay)) {
      const d = new Date(+t);
      if (d < p.lo) continue;
      const x = X(d), r = list.length > 1 ? 9 : 6;
      if (isMovie(s)) {
        stroke(S.bg); strokeWeight(3); fill('#FFFFFF'); rectMode(CENTER); rect(x, y, 18, 18, 3); rectMode(CORNER);
        noStroke(); fill('#16161A'); textSize(10); textStyle(BOLD); textAlign(CENTER, CENTER); text('M', x, y + 0.5);
        markers.push({ x, y, r: 12, text: `${s.title} (movie) streams ${fmtWeekday(d)}` });
        continue;
      }
      stroke(S.bg); strokeWeight(2); fill('#FFFFFF'); circle(x, y, r * 2);
      if (list.length > 1) { noStroke(); fill('#16161A'); textSize(10); textStyle(BOLD); textAlign(CENTER, CENTER); text(list.length, x, y + 0.5); }
      const isFinale = list.some(e => e.n === s.eps.length);
      markers.push({ x, y, r: r + 3, text: `${s.title} — ${list.length > 1 ? `Episodes ${list[0].n}–${list[list.length-1].n}` : `Episode ${list[0].n}`}${isFinale ? ' (finale)' : ''}: ${fmtWeekday(d)}` });
    }
  });

  // windows section
  const yW0 = HEAD_H + Math.max(1, p.shows.length) * ROW_H;
  stroke('#16161A'); strokeWeight(1); line(0, yW0 + 4, width, yW0 + 4);
  noStroke(); fill('#16161A'); textStyle(BOLD); textSize(13); textAlign(LEFT, CENTER);
  text('Subscribed', 8, yW0 + SUB_HEAD / 2 + 2);
  p.bundles.forEach((b, i) => {
    const y = yW0 + SUB_HEAD + i * ROW_H + ROW_H / 2;
    noStroke(); fill('#16161A'); textStyle(BOLD); textSize(12); textAlign(LEFT, CENTER);
    text(truncate(b.single ? `${SERVICES[b.services[0]].name} (kept)` : 'Bundle (kept)', x0 - 18), 8, y - 7);
    textStyle(NORMAL); fill('#45454F'); textSize(11); text(`${money(b.price)}/mo`, 8, y + 8);
    const xa = X(p.lo), xb = X(addDays(p.hi, 1));
    const KS = b.single ? SERVICES[b.services[0]] : { bg: '#3D3D46', fg: '#FFFFFF', pattern: 'horiz' };
    patternRect(xa, y - 11, xb - xa, 22, KS);
    const lab = `${b.label} · always on`;
    textSize(11); textStyle(BOLD);
    fill(KS.bg); noStroke(); rect(xa + 4, y - 8, textWidth(lab) + 10, 16, 4);
    fill(KS.fg); textAlign(LEFT, CENTER); text(lab, xa + 9, y);
    markers.push({ x: (xa + xb) / 2, y, r: 12, rect: [xa, y - 11, xb - xa, 22], text: `${b.label}: kept all plan long at ${money(b.price)}/mo` });
  });
  p.windows.forEach((w, i0) => {
    const i = i0 + p.bundles.length;
    const y = yW0 + SUB_HEAD + i * ROW_H + ROW_H / 2;
    const S = SERVICES[w.svc];
    noStroke(); fill('#16161A'); textStyle(BOLD); textSize(12); textAlign(LEFT, CENTER);
    text(S.name, 8, y - 7);
    textStyle(NORMAL); fill('#45454F'); textSize(11); text(`${w.months} mo · ${money(w.cost)}`, 8, y + 8);
    const xa = X(w.start), xb = X(addDays(w.accessEnd, 1));
    patternRect(xa, y - 11, xb - xa, 22, S);
    const lab = `${fmtShort(w.start)} → cancel by ${fmtShort(w.accessEnd)}`;
    textSize(11); textStyle(BOLD);
    const tw = textWidth(lab) + 10;
    if (tw < xb - xa) {
      fill(S.bg); noStroke(); rect(xa + 4, y - 8, tw, 16, 4);
      fill(S.fg); textAlign(LEFT, CENTER); text(lab, xa + 9, y);
    } else {
      fill('#16161A'); noStroke(); textAlign(LEFT, CENTER);
      const tx = xb + 6 + tw < width ? xb + 6 : xa - tw - 2;
      text(lab, Math.max(x0, tx), y);
    }
    markers.push({ x: (xa + xb) / 2, y, r: Math.max(12, (xb - xa) / 2), rect: [xa, y - 11, xb - xa, 22],
      text: `${S.name}: subscribe ${fmtWeekday(w.start)}, cancel by ${fmtWeekday(w.accessEnd)} (${w.months} mo, ${money(w.cost)})` });
  });

  if (hover) drawTooltip(hover);
  describe(canvasSummary(), FALLBACK);
}

function patternRect(x, y, w, h, S) {
  fill(S.bg); stroke('#16161A'); strokeWeight(1); rect(x, y, w, h, 4);
  const ctx = drawingContext;
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  stroke(S.fg === '#FFFFFF' ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)'); strokeWeight(2);
  const p = S.pattern;
  if (p === 'diag' || p === 'cross' || p === 'zig') for (let i = -h; i < w + h; i += 7) line(x + i, y + h, x + i + h, y);
  if (p === 'diagR' || p === 'cross') for (let i = -h; i < w + h; i += 7) line(x + i, y, x + i + h, y + h);
  if (p === 'horiz' || p === 'grid') for (let j = 3; j < h; j += 5) line(x, y + j, x + w, y + j);
  if (p === 'vert' || p === 'grid') for (let i = 3; i < w; i += 5) line(x + i, y, x + i, y + h);
  if (p === 'dots') { noStroke(); fill(S.fg === '#FFFFFF' ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)'); for (let i = 3; i < w; i += 6) for (let j = 3; j < h; j += 6) circle(x + i, y + j, 2.6); }
  ctx.restore();
}

function truncate(str, maxW) {
  if (textWidth(str) <= maxW) return str;
  let s = str;
  while (s.length > 3 && textWidth(s + '…') > maxW) s = s.slice(0, -1);
  return s + '…';
}

function drawTooltip(m) {
  textSize(12); textStyle(NORMAL);
  const tw = Math.min(textWidth(m.text) + 16, width - 16);
  let tx = constrain(mouseX + 12, 8, width - tw - 8), ty = mouseY - 34;
  if (ty < 4) ty = mouseY + 16;
  fill('#16161A'); noStroke(); rect(tx, ty, tw, 26, 5);
  fill('#FFFFFF'); textAlign(LEFT, CENTER); text(m.text, tx + 8, ty + 13, tw - 12);
}

function mouseMoved() {
  if (mouseX < 0 || mouseY < 0 || mouseX > width || mouseY > height) { if (hover) { hover = null; redraw(); } return; }
  let found = null;
  for (const m of markers) {
    if (m.rect) { const [rx, ry, rw, rh] = m.rect; if (mouseX >= rx && mouseX <= rx + rw && mouseY >= ry && mouseY <= ry + rh) found = m; }
    else if (dist(mouseX, mouseY, m.x, m.y) <= m.r) { found = m; break; }
  }
  if (found !== hover) { hover = found; redraw(); }
}

function canvasSummary() {
  const p = plan;
  if (!p.shows.length) return 'Release timeline. No shows selected.';
  return 'Release timeline from ' + fmtMonth(p.lo) + ' to ' + fmtMonth(p.hi) + '. ' +
    p.shows.map(s => `${s.title} on ${SERVICES[s.service].name}: ${s.eps.length} episodes from ${fmt(first(s))} to ${fmt(last(s))}.`).join(' ') +
    (p.bundles.length ? ' Kept bundles: ' + p.bundles.map(b => `${b.label} at ${money(b.price)} a month.`).join(' ') : '') +
    ' Subscription windows: ' + p.windows.map(w => `${SERVICES[w.svc].name} from ${fmt(w.start)}, cancel by ${fmt(w.accessEnd)}.`).join(' ') +
    ' Full details are in the month-by-month table.';
}

// ---------- Controls ----------
function wireControls() {
  document.querySelectorAll('input[name=mode]').forEach(r => r.addEventListener('change', e => { state.mode = e.target.value; update(); }));
  $('bingeDays').addEventListener('input', e => { state.bingeDays = constrain(parseInt(e.target.value) || 14, 1, 60); update(); });
  $('consolidate').addEventListener('change', e => { state.consolidate = e.target.checked; update(); });
  $('kindFilter').addEventListener('change', e => { state.kind = e.target.value; renderPicker(); });
  $('selAll').addEventListener('click', () => {
    allShows().filter(s => state.kind === 'all' || (state.kind === 'movie') === isMovie(s)).forEach(s => state.selected.add(s.id));
    renderPicker(); update();
  });
  $('selNone').addEventListener('click', () => { state.selected.clear(); renderPicker(); update(); });
  $('copyPlan').addEventListener('click', () => saveOrCopy('stream-timer-plan.txt', planText(), 'Plan'));
  $('updateShows').addEventListener('click', updateShows);
  $('exportJson').addEventListener('click', () => saveOrCopy('shows.json', JSON.stringify(toJSON(true), null, 2), 'Show data', $('updateMsg')));
  $('importBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', e => { if (e.target.files[0]) importJSONFile(e.target.files[0]); });
  $('copyIcs').addEventListener('click', () => canSaveIcs
    ? saveOrCopy('stream-timer-reminders.ics', icsText(), 'Calendar reminders')
    : copyOut(icsText(), 'Calendar file text'));
  $('planTracked').addEventListener('click', planTracked);
  $('cards').addEventListener('click', planAction);
  $('removedBox').addEventListener('click', planAction);
  $('saveTrack').addEventListener('click', () => saveOrCopy('tracklist.json', JSON.stringify(tracklistJSON(), null, 2), 'Tracklist', $('trackMsg')));
  $('openTrackBtn').addEventListener('click', () => $('openTrackFile').click());
  $('openTrackFile').addEventListener('change', e => { if (e.target.files[0]) openTrackFile(e.target.files[0]); });
  $('defaultTrack').addEventListener('click', () => loadDefaultTracklist(false));
  $('saveRates').addEventListener('click', () => saveOrCopy('rates.json', JSON.stringify(ratesJSON(), null, 2), 'Rates', $('ratesMsg')));
  $('openRatesBtn').addEventListener('click', () => $('openRatesFile').click());
  $('openRatesFile').addEventListener('change', e => { if (e.target.files[0]) openRatesFile(e.target.files[0]); });
  $('defaultRates').addEventListener('click', () => loadDefaultRates(false));

  $('addForm').addEventListener('submit', e => {
    e.preventDefault();
    const title = $('fTitle').value.trim(), start = $('fStart').value, count = parseInt($('fCount').value);
    const problems = [];
    if (!title) problems.push('a title');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) problems.push('a premiere date');
    if (!(count >= 1 && count <= 60)) problems.push('an episode count from 1 to 60');
    if (problems.length) {
      $('formMsg').textContent = 'Please enter ' + problems.join(', ') + '.';
      (!title ? $('fTitle') : !start ? $('fStart') : $('fCount')).focus();
      return;
    }
    const c = buildCustom({ id: 'custom-' + Date.now(), title, service: $('fService').value, start, count, cadence: $('fCadence').value });
    state.custom.push(c); state.selected.add(c.id);
    saveTrackLocal();
    renderPicker(); renderSpotlight(); renderTracklist(); update();
    $('formMsg').textContent = `Added “${title}” and selected it.`;
    $('addForm').reset();
  });
  // keep the update() → canvas link alive after first render
  update();
}
