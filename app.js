// ===== 在線表示システム フロント（これ1ファイルで完結）=====
// 設定: 下の firebaseConfig に Firebase コンソールの Web アプリ設定を貼る（公開OKな値）
// データベース: Realtime Database（ルールは database.rules.json）
// デプロイ: firebase deploy --only hosting
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { getDatabase, ref, onValue, set, update, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js';

const firebaseConfig = {
  // Realtime Database のみ使用（ログイン機能は使わない）ので、apiKey 等は不要
  projectId: 'train-73ddb',
  databaseURL: 'https://train-73ddb-default-rtdb.firebaseio.com',
};


/* ================= .oud2 パーサ ================= */
// OuDiaSecond (.oud2) パーサ（ブラウザ / Node 共用）
// 出力: { v, name, dia, stations[], types[], trains[] }
//  - stations[i] = { i, name, core(BrunchCoreEkiIndex|null), tracks[] }
//  - types[i]    = { name, abbr, color }
//  - trains[]    = { id, no(運番), dir:'D'|'U', type, note, stops:[[駅index, 1停車|2通過, 着(秒), 発(秒), 番線index|-1]] }
//    ※ stops は「列車の進行順」。時刻は 0:00 からの秒（24時超は 86400 以上）

function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('shift_jis').decode(buf); // OuDia は Shift_JIS が標準
  }
}

// Firestore のフィールド名に使える運番キー
const safeKey = (no) =>
  't_' + String(no).replace(/[^0-9A-Za-z_\-\u3040-\u30ff\u4e00-\u9fff]/g, '_');

const ABBR = {
  普通: '普', 各駅停車: '普', 急行: '急', 区間急行: '急', 快速急行: '急', 準急: '準',
  快速: '快', 特急: '特', 快速特急: '特', 通勤特急: '特', 回送: '回', 試運転: '回',
};
const PALETTE = { 普: '#767b80', 急: '#0067b3', 特: '#f0303a', 快: '#00b45c', 回: '#e277d8', 準: '#2fa4a4' };

// OuDia の色は Delphi TColor (00BBGGRR)
function bgrToHex(s) {
  if (!s || !/^[0-9A-Fa-f]{8}$/.test(s)) return '#777777';
  return '#' + s.slice(6, 8) + s.slice(4, 6) + s.slice(2, 4);
}

function parseTree(text) {
  const root = { name: 'ROOT', props: [], kids: [] };
  const stack = [root];
  for (const line of text.split(/\r?\n/)) {
    if (line === '') continue;
    if (line === '.') { if (stack.length > 1) stack.pop(); continue; }
    const eq = line.indexOf('=');
    if (eq < 0 && line.endsWith('.')) {
      const n = { name: line.slice(0, -1), props: [], kids: [] };
      stack[stack.length - 1].kids.push(n);
      stack.push(n);
    } else if (eq >= 0) {
      stack[stack.length - 1].props.push([line.slice(0, eq), line.slice(eq + 1)]);
    }
  }
  return root;
}
const get = (n, k) => { const p = n.props.find((q) => q[0] === k); return p ? p[1] : undefined; };

function t2s(s) {
  if (!s) return null;
  s = s.trim();
  if (!/^\d{3,6}$/.test(s)) return null;
  let h, m, sec = 0;
  if (s.length === 3) { h = +s[0]; m = +s.slice(1, 3); }
  else if (s.length === 4) { h = +s.slice(0, 2); m = +s.slice(2, 4); }
  else if (s.length === 5) { h = +s[0]; m = +s.slice(1, 3); sec = +s.slice(3, 5); }
  else { h = +s.slice(0, 2); m = +s.slice(2, 4); sec = +s.slice(4, 6); }
  return h * 3600 + m * 60 + sec;
}

// 例: "1;2003/2004$2" "2$0" "2;2005/" "1;2000$1"
function parseEntry(str) {
  if (!str) return null;
  const m = /^(\d)(?:;([^$]*))?(?:\$(\d*))?$/.exec(str);
  if (!m) return null;
  const type = +m[1];
  if (type !== 1 && type !== 2) return null; // 0=運行なし 3=経由なし
  let arr = null, dep = null;
  const ts = m[2];
  if (ts) {
    if (ts.includes('/')) { const [a, d] = ts.split('/'); arr = t2s(a); dep = t2s(d); }
    else { arr = dep = t2s(ts); }
  }
  return { type, arr, dep, track: m[3] ? +m[3] : m[3] === '0' ? 0 : -1 };
}

function buildTrain(node, dir, n, id) {
  const raw = (get(node, 'EkiJikoku') || '').split(',');
  while (raw.length < n) raw.push('');
  // 上りの EkiJikoku は「最後の駅から」並んでいる → 進行順 k に対する駅 index = n-1-k
  const seq = [];
  for (let k = 0; k < n; k++) {
    const e = parseEntry(raw[k]);
    if (e) seq.push({ i: dir === 'Nobori' ? n - 1 - k : k, ...e });
  }
  // 日跨ぎ補正（単調増加に）
  let prev = -1;
  const fix = (t) => {
    if (t == null) return null;
    if (prev >= 0 && t < prev) { if (prev - t > 12 * 3600) t += 86400; else t = prev; }
    prev = t; return t;
  };
  for (const e of seq) { e.arr = fix(e.arr); e.dep = fix(e.dep); }
  for (const e of seq) { if (e.arr == null) e.arr = e.dep; if (e.dep == null) e.dep = e.arr; }
  // 時刻なし通過駅は前後の時刻から線形補間
  const known = seq.map((e, j) => (e.arr != null ? j : -1)).filter((j) => j >= 0);
  if (known.length < 2) return null;
  for (let j = known[0] + 1; j < known[known.length - 1]; j++) {
    if (seq[j].arr != null) continue;
    let a = j - 1; while (seq[a].arr == null) a--;
    let b = j + 1; while (seq[b].arr == null) b++;
    const t = seq[a].dep + ((seq[b].arr - seq[a].dep) * (j - a)) / (b - a);
    seq[j].arr = seq[j].dep = Math.round(t);
  }
  const used = seq.slice(known[0], known[known.length - 1] + 1);
  return {
    id,
    no: get(node, 'Ressyabangou') || get(node, 'Ressyamei') || `#${id}`,
    dir: dir === 'Kudari' ? 'D' : 'U',
    type: +(get(node, 'Syubetsu') || 0),
    note: get(node, 'Bikou') || '',
    stops: used.map((e) => [e.i, e.type, e.arr, e.dep, e.track]),
  };
}

function parseOud2(text) {
  const root = parseTree(text);
  const rosen = root.kids.find((k) => k.name === 'Rosen');
  if (!rosen) throw new Error('Rosen ブロックが見つかりません（.oud2 ではない可能性）');

  const stations = rosen.kids.filter((k) => k.name === 'Eki').map((e, i) => {
    const core = get(e, 'BrunchCoreEkiIndex');
    const cont = e.kids.find((k) => k.name === 'EkiTrack2Cont');
    return {
      i,
      name: get(e, 'Ekimei') || `駅${i}`,
      core: core !== undefined ? +core : null,
      tracks: cont ? cont.kids.filter((k) => k.name === 'EkiTrack2').map((t) => get(t, 'TrackName') || '') : [],
    };
  });
  if (!stations.length) throw new Error('駅が見つかりません');

  const types = rosen.kids.filter((k) => k.name === 'Ressyasyubetsu').map((t) => {
    const name = get(t, 'Syubetsumei') || '?';
    const abbr = ABBR[name] || [...name][0] || '?';
    return { name, abbr, color: PALETTE[abbr] || bgrToHex(get(t, 'DiagramSenColor')) };
  });

  const diaNodes = rosen.kids.filter((k) => k.name === 'Dia');
  if (!diaNodes.length) throw new Error('Dia（ダイヤ）が見つかりません');
  const dias = diaNodes.map((dia, di) => {
    const trains = [];
    for (const dir of ['Kudari', 'Nobori']) {
      const d = dia.kids.find((k) => k.name === dir);
      if (!d) continue;
      for (const r of d.kids.filter((k) => k.name === 'Ressya')) {
        const t = buildTrain(r, dir, stations.length, trains.length);
        if (t) trains.push(t);
      }
    }
    return { name: get(dia, 'DiaName') || `ダイヤ${di + 1}`, trains };
  });
  return { v: 2, name: get(rosen, 'Rosenmei') || '路線', stations, types, dias };
}

// 旧形式(v1: trains 直下)も dias 形式に揃える
function normalizeOud(o) {
  if (!o.dias) o.dias = [{ name: o.dia || 'ダイヤ', trains: o.trains || [] }];
  return o;
}

/* ================= レイアウト・位置計算 ================= */
// 路線レイアウト・列車コンパイル・位置計算（DOM非依存。ブラウザ/Node共用）
const COLX = [230, 500];
const MAP_W = 620;
const HIDE = /留置/;      // 路線図に出さない駅（留置線など）
const JUNC = /調整用/;    // 分岐合流点として扱う（ラベル非表示）

function buildLayout(oud) {
  const st = oud.stations;
  const canon = (i) => (st[i].core != null && st[st[i].core] ? st[i].core : i);
  const hidden = (i) => HIDE.test(st[canon(i)].name);

  // 路線を「チェーン」に分割（core が前方=合流側 / 後方=分岐側）
  const chains = [[]];
  for (let i = 0; i < st.length; i++) {
    const c = st[i].core;
    const startNew = i > 0 && ((c != null && c < i) || (st[i - 1].core != null && st[i - 1].core > i - 1));
    if (startNew) chains.push([]);
    chains[chains.length - 1].push(i);
  }
  const chainNodes = chains.map((ch) => {
    const out = [];
    for (const i of ch) {
      if (hidden(i)) continue;
      const n = canon(i);
      if (out[out.length - 1] !== n) out.push(n);
    }
    return out;
  });

  // 本線(列0)に行を割り当て
  const placed = new Map();
  let nextRow = 0;
  for (const n of chainNodes[0]) if (!placed.has(n)) placed.set(n, { col: 0, row: nextRow++ });
  // 分岐チェーンの未配置ノード
  const runs = [];
  for (let k = 1; k < chainNodes.length; k++) {
    const L = chainNodes[k];
    let j = 0;
    while (j < L.length) {
      if (placed.has(L[j])) { j++; continue; }
      let e = j;
      while (e < L.length && !placed.has(L[e])) e++;
      const nodes = L.slice(j, e);
      const before = j > 0 ? L[j - 1] : null;
      const after = e < L.length ? L[e] : null;
      if (before != null && after == null) {
        const b = placed.get(before);
        if (b.col === 0 && b.row === nextRow - 1) nodes.forEach((n) => placed.set(n, { col: 0, row: nextRow++ }));
        else runs.push({ nodes, before, after });
      } else if (before == null && after == null) {
        nodes.forEach((n) => placed.set(n, { col: 0, row: nextRow++ }));
      } else runs.push({ nodes, before, after });
      j = e;
    }
  }

  // 行間隔（分岐ノードを挟む区間は広げる）
  const gaps = Array(Math.max(0, nextRow - 1)).fill(100);
  for (const r of runs) {
    if (r.before == null || r.after == null) continue;
    const a = placed.get(r.before).row, b = placed.get(r.after).row;
    const lo = Math.min(a, b), hi = Math.max(a, b);
    if (hi <= lo) continue;
    const need = (r.nodes.length + 1) * 90;
    let have = 0; for (let q = lo; q < hi; q++) have += gaps[q];
    if (have < need) { const add = (need - have) / (hi - lo); for (let q = lo; q < hi; q++) gaps[q] += add; }
  }
  const rowY = []; let y = 70;
  for (let r = 0; r < nextRow; r++) { rowY.push(y); y += gaps[r] ?? 0; }

  const nodes = new Map();
  for (const [id, p] of placed) nodes.set(id, { id, x: COLX[p.col], y: rowY[p.row], col: p.col });
  for (const r of runs) {
    const m = r.nodes.length;
    r.nodes.forEach((n, q) => {
      let yy;
      if (r.before != null && r.after != null) {
        const ya = nodes.get(r.before).y, yb = nodes.get(r.after).y;
        yy = ya + ((yb - ya) * (q + 1)) / (m + 1);
      } else if (r.before != null) yy = nodes.get(r.before).y + 90 * (q + 1);
      else yy = nodes.get(r.after).y - 90 * (m - q);
      nodes.set(n, { id: n, x: COLX[1], y: yy, col: 1 });
    });
  }
  for (const nd of nodes.values()) {
    nd.name = st[nd.id].name;
    nd.label = !JUNC.test(nd.name);
  }

  // エッジ
  const edges = [];
  const seen = new Set();
  const adj = new Map();
  for (const L of chainNodes) {
    for (let q = 0; q + 1 < L.length; q++) {
      const a = L[q], b = L[q + 1];
      if (a === b) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const e = makeEdge(a, b, nodes.get(a), nodes.get(b));
      edges.push(e);
      if (!adj.has(a)) adj.set(a, []); if (!adj.has(b)) adj.set(b, []);
      adj.get(a).push({ to: b, edge: e, rev: false });
      adj.get(b).push({ to: a, edge: e, rev: true });
    }
  }
  const maxY = Math.max(...[...nodes.values()].map((n) => n.y));
  return { nodes, edges, adj, canon, width: MAP_W, height: maxY + 90, routeCache: new Map() };
}

function makeEdge(a, b, na, nb) {
  let d; const pts = [];
  if (na.x === nb.x) {
    d = `M${na.x} ${na.y}L${nb.x} ${nb.y}`;
    pts.push({ x: na.x, y: na.y }, { x: nb.x, y: nb.y });
  } else {
    const dy = nb.y - na.y, c1 = na.y + dy * 0.5, c2 = nb.y - dy * 0.5;
    d = `M${na.x} ${na.y}C${na.x} ${c1} ${nb.x} ${c2} ${nb.x} ${nb.y}`;
    for (let i = 0; i <= 40; i++) {
      const t = i / 40, m = 1 - t;
      pts.push({
        x: m ** 3 * na.x + 3 * m * m * t * na.x + 3 * m * t * t * nb.x + t ** 3 * nb.x,
        y: m ** 3 * na.y + 3 * m * m * t * c1 + 3 * m * t * t * c2 + t ** 3 * nb.y,
      });
    }
  }
  let cum = 0; pts[0].c = 0;
  for (let i = 1; i < pts.length; i++) { cum += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); pts[i].c = cum; }
  return { a, b, d, pts, len: cum };
}

function getRoute(L, u, v) {
  const key = u + '>' + v;
  if (L.routeCache.has(key)) return L.routeCache.get(key);
  let route = null;
  if (u === v) route = [];
  else {
    const prev = new Map([[u, null]]); const q = [u];
    while (q.length && !prev.has(v)) {
      const cur = q.shift();
      for (const x of L.adj.get(cur) || []) if (!prev.has(x.to)) { prev.set(x.to, { from: cur, x }); q.push(x.to); }
    }
    if (prev.has(v)) {
      route = []; let c = v;
      while (prev.get(c)) { const p = prev.get(c); route.unshift({ edge: p.x.edge, rev: p.x.rev }); c = p.from; }
    }
  }
  L.routeCache.set(key, route);
  return route;
}

function pointAt(edge, dist, rev) {
  const d = rev ? edge.len - dist : dist;
  const P = edge.pts;
  for (let i = 1; i < P.length; i++) {
    if (d <= P[i].c || i === P.length - 1) {
      const span = P[i].c - P[i - 1].c || 1;
      const f = Math.min(1, Math.max(0, (d - P[i - 1].c) / span));
      return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * f, y: P[i - 1].y + (P[i].y - P[i - 1].y) * f };
    }
  }
  return { x: P[0].x, y: P[0].y };
}

function routePoint(L, u, v, f) {
  const nu = L.nodes.get(u), nv = L.nodes.get(v);
  const route = getRoute(L, u, v);
  if (route === null) return { x: nu.x + (nv.x - nu.x) * f, y: nu.y + (nv.y - nu.y) * f };
  if (!route.length) return { x: nu.x, y: nu.y };
  const total = route.reduce((s, r) => s + r.edge.len, 0);
  let d = f * total;
  for (const r of route) {
    if (d <= r.edge.len + 1e-6) return pointAt(r.edge, Math.min(d, r.edge.len), r.rev);
    d -= r.edge.len;
  }
  return { x: nv.x, y: nv.y };
}

// 列車を「表示可能な駅ノード列」に変換
function compileTrains(trains, L) {
  const out = [];
  for (const t of trains) {
    const pts = [];
    for (const [i, type, arr, dep, track] of t.stops) {
      const node = L.canon(i);
      if (!L.nodes.has(node)) continue;
      const last = pts[pts.length - 1];
      if (last && last.node === node) {
        last.dep = dep; last.stop = last.stop || type === 1;
        if (track >= 0 && (i === node || last.track < 0)) last.track = track;
      } else pts.push({ node, arr, dep, stop: type === 1, track });
    }
    if (pts.length < 2) continue;
    for (const p of pts) if (p.dep < p.arr) p.dep = p.arr;
    out.push({ id: t.id, no: t.no, dir: t.dir, type: t.type, note: t.note, pts, start: pts[0].arr, end: pts[pts.length - 1].arr, holdUntil: 0 });
  }
  // 同一運番の次区間（種別変更など）まで終点で待機表示
  const g = new Map();
  for (const t of out) { if (!g.has(t.no)) g.set(t.no, []); g.get(t.no).push(t); }
  for (const list of g.values()) {
    list.sort((a, b) => a.start - b.start);
    list.forEach((t, k) => {
      const nx = list[k + 1];
      t.holdUntil = nx && nx.start - t.end <= 1800 ? nx.start : t.end + 60;
    });
  }
  return out;
}

// 現在位置 → { u, v, f } / 非表示なら null。shift は遅延秒
function locate(tr, t, shift = 0) {
  const P = tr.pts;
  if (t < P[0].arr + shift) return null;
  for (let k = 0; k < P.length; k++) {
    const A = P[k].arr + shift, D = P[k].dep + shift;
    if (t >= A && t <= D) return { u: P[k].node, v: P[k].node, f: 0, k };
    if (k < P.length - 1) {
      const A2 = P[k + 1].arr + shift;
      if (t > D && t < A2) return { u: P[k].node, v: P[k + 1].node, f: (t - D) / (A2 - D), k };
    }
  }
  if (t <= tr.holdUntil + shift) { const n = P[P.length - 1].node; return { u: n, v: n, f: 0, k: P.length - 1 }; }
  return null;
}

/* ================= 時刻表PNG ================= */
// 駅別時刻表を PNG 画像として生成（canvas）。行は 4〜23時 → 0〜3時、交互に灰色の帯。
const HOURS = [...Array(20)].map((_, i) => i + 4).concat([0, 1, 2, 3]);
const FONT = '"Noto Sans JP","Hiragino Sans","Meiryo",sans-serif';

// 指定ノードに停車（または始発/終着）する列車の時刻を収集
function collectTimes(trains, nodeId, nameOf, types) {
  const out = { D: [], U: [] };
  for (const tr of trains) {
    const k = tr.pts.findIndex((p) => p.node === nodeId);
    if (k < 0) continue;
    const p = tr.pts[k];
    const first = k === 0, last = k === tr.pts.length - 1;
    if (!p.stop && !first && !last) continue;
    const t = last ? p.arr : p.dep;
    const T = types[tr.type] || { abbr: '?', color: '#555' };
    out[tr.dir].push({
      h: Math.floor(t / 3600) % 24, m: Math.floor((t % 3600) / 60),
      color: T.color, abbr: T.abbr,
      dest: [...nameOf(tr.pts[tr.pts.length - 1].node)][0] || '', last,
    });
  }
  for (const d of ['D', 'U']) out[d].sort((a, b) => a.h - b.h || a.m - b.m);
  return out;
}

function drawNum(ctx, num, cx, cy) {
  ctx.beginPath(); ctx.arc(cx, cy, 30, 0, Math.PI * 2);
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 5; ctx.strokeStyle = '#19aee8'; ctx.stroke();
  ctx.fillStyle = '#1d2a66'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const m = /^([A-Za-z]+)\s*(\d+)$/.exec(num);
  if (m) {
    ctx.font = `700 14px ${FONT}`; ctx.fillText(m[1].toUpperCase(), cx, cy - 15);
    ctx.font = `700 28px ${FONT}`; ctx.fillText(m[2], cx, cy + 7);
  } else { ctx.font = `700 18px ${FONT}`; ctx.fillText(num.slice(0, 4), cx, cy); }
}

function drawTimetable({ name, num, times, types }) {
  const COLW = 620, HOURW = 70, PER = 10, ENTW = 52, LH = 34;
  const W = COLW * 2, HEAD = 120;
  // 時間帯ごとの行高（折り返し対応）
  const rowH = HOURS.map((h) => {
    const n = Math.max(times.D.filter((e) => e.h === h).length, times.U.filter((e) => e.h === h).length);
    return Math.max(58, Math.ceil(n / PER) * LH + 20);
  });
  const total = HEAD + rowH.reduce((a, b) => a + b, 0) + 70;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = total;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, total);

  // ヘッダ
  let x = 24;
  if (num) { drawNum(ctx, num, 54, 54); x = 100; }
  ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.font = `700 40px ${FONT}`; ctx.fillText(name, x, 54);
  ctx.font = `400 18px ${FONT}`; ctx.fillStyle = '#666';
  ctx.fillText('時刻表（停車・始発・終着）', x + ctx.measureText(name).width * 0 + 4, 100);

  const cols = [['D', '下り'], ['U', '上り']];
  cols.forEach(([d, label], ci) => {
    const ox = ci * COLW;
    ctx.fillStyle = '#4f5b6e'; ctx.fillRect(ox, HEAD - 36, COLW, 34);
    ctx.fillStyle = '#fff'; ctx.font = `700 20px ${FONT}`; ctx.textAlign = 'left'; ctx.fillText(label, ox + 20, HEAD - 19);
    let y = HEAD;
    HOURS.forEach((h, ri) => {
      const H = rowH[ri];
      if (ri % 2 === 0) { ctx.fillStyle = '#dfdfdf'; ctx.fillRect(ox, y, COLW, H); }
      ctx.fillStyle = '#4a4a4a'; ctx.font = `400 30px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(String(h), ox + 18, y + 29);
      times[d].filter((e) => e.h === h).forEach((e, k) => {
        const ex = ox + HOURW + 16 + (k % PER) * ENTW, ey = y + 10 + Math.floor(k / PER) * LH + LH / 2;
        ctx.fillStyle = e.color; ctx.font = `700 24px ${FONT}`; ctx.textAlign = 'left';
        ctx.fillText(String(e.m).padStart(2, '0'), ex, ey);
        ctx.font = `400 12px ${FONT}`; ctx.fillText(e.dest + (e.last ? '着' : ''), ex + 28, ey - 8);
      });
      y += H;
    });
  });
  // 凡例
  let lx = 24; const ly = total - 34;
  ctx.textBaseline = 'middle';
  for (const T of types) {
    if (T.name === '回送') continue;
    ctx.fillStyle = T.color; ctx.fillRect(lx, ly - 13, 26, 26);
    ctx.fillStyle = '#fff'; ctx.font = `700 16px ${FONT}`; ctx.textAlign = 'center'; ctx.fillText(T.abbr, lx + 13, ly);
    ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.font = `400 16px ${FONT}`; ctx.fillText(T.name, lx + 32, ly);
    lx += 40 + ctx.measureText(T.name).width + 14;
  }
  ctx.fillStyle = '#888'; ctx.textAlign = 'right'; ctx.font = `400 13px ${FONT}`;
  ctx.fillText('小さい文字＝行先（着＝終着）', W - 20, ly);
  return cv;
}

function downloadCanvas(cv, filename) {
  return new Promise((res) => cv.toBlob((b) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000); res();
  }, 'image/png'));
}


/* ================= 共通 ================= */
const $ = (s, r = document) => r.querySelector(s);
const NS = 'http://www.w3.org/2000/svg';
const sv = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};
const DAY = 86400;
const pad = (n) => String(n).padStart(2, '0');
const fmtHMS = (s) => { s = Math.floor(((s % DAY) + DAY) % DAY); return `${pad((s / 3600) | 0)}:${pad(((s % 3600) / 60) | 0)}:${pad(s % 60)}`; };
const fmtHM = (s) => { s = Math.floor((((s % DAY) + DAY) % DAY) / 60) * 60; return `${pad((s / 3600) | 0)}:${pad((s % 3600) / 60 | 0)}`; };
const jstFmt = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const realJstSec = () => ((Date.now() / 1000 + 9 * 3600) % DAY);
const strLen = (s) => Array.from(s).length;
let toastTimer;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), 2600); }
function fatal(html) { const f = $('#fatal'); f.innerHTML = html; f.hidden = false; }
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ================= 状態 ================= */
const S = {
  roomId: new URLSearchParams(location.search).get('room') || location.hash.replace('#', ''),
  room: null, oud: null, layout: null, trains: [], participants: [], icons: new Map(),
  selected: null, pending: null,
  myName: '',
  partRows: [],
};
let sim = null; // テスト時刻 {realStart, simStart, speed}
const nowSec = () => (sim ? sim.simStart + ((Date.now() - sim.realStart) / 1000) * sim.speed : realJstSec());

/* ================= Firebase ================= */
if (!S.roomId) {
  fatal('ルームが指定されていません。<br>Discord で <b>/room</b> コマンドを実行し、発行されたURLを開いてください。');
  throw new Error('no room');
}
if (!firebaseConfig.databaseURL || firebaseConfig.databaseURL.includes('YOUR_PROJECT')) {
  fatal('app.js 先頭の firebaseConfig に databaseURL を設定してください。');
  throw new Error('no config');
}
const db = getDatabase(initializeApp(firebaseConfig));
const roomRef = ref(db, `zaisen/rooms/${S.roomId}`);
const oudRef = ref(db, `zaisen/oud/${S.roomId}`);
const partsRef = ref(db, `zaisen/participants/${S.roomId}`);
let partDraft = [], partDirty = false;   // 参加者の編集中データ
const stamp = () => serverTimestamp();

function expiredScreen() {
  fatal('このルームは有効期限（発行から3日）が切れたか、存在しません。<br>Discord で <b>/room</b> から新しいルームを発行してください。');
}
let unsubs = [];
// 存在しない・期限切れのルームはルールで読み取り拒否 → エラー側に来る
unsubs.push(onValue(roomRef, (snap) => {
  if (!snap.exists()) return expiredScreen();
  S.room = snap.val();
  onRoomChange();
}, () => expiredScreen()));
unsubs.push(onValue(oudRef, (snap) => {
  if (!snap.exists()) { S.oud = null; $('#map').innerHTML = ''; return; }
  try { S.oud = normalizeOud(JSON.parse(snap.val().json)); renderMap(); } catch (e) { toast('ダイヤデータの読み込みに失敗: ' + e.message); }
}, () => {}));
unsubs.push(onValue(partsRef, (snap) => {
  S.partRows = Object.entries(snap.val() || {}).map(([pid, d]) => ({ pid, name: (d && d.name) || '', discordId: (d && d.discordId) || '' }));
  S.participants = S.partRows.map((r) => r.name).filter(Boolean);
  if (!partDirty) { partDraft = S.partRows.map((r) => ({ ...r })); renderPartRows(); }
  refreshOpsIfIdle(); if (S.selected != null) renderModal();
}, () => {}));

setInterval(() => {
  const exp = S.room?.expiresAt;
  if (exp && Date.now() > exp) { expiredScreen(); unsubs.forEach((u) => u()); }
}, 30000);

const delayOf = (no) => Number(S.room?.delays?.[safeKey(no)] || 0);
const driverOf = (no) => S.room?.assignments?.[safeKey(no)] || '';
// 駅名・ナンバリングの編集（ルームに保存して全員に反映）
const stEdit = (id) => S.room?.stationEdits?.['s_' + id] || {};
const stName = (id) => stEdit(id).name || S.layout?.nodes.get(id)?.name || '';
const stNum = (id) => stEdit(id).num || '';
let editSig = '';
const diaIdx = () => Math.min(Math.max(0, Number(S.room?.diaIndex) || 0), (S.oud?.dias.length || 1) - 1);
const curTrains = () => S.oud.dias[diaIdx()].trains;

function onRoomChange() {
  $('#inGuild').value ||= S.room.guildId || '';
  const m = S.room.oudMeta;
  $('#oudMeta').textContent = m ? `現在のダイヤ: ${m.fileName}（${m.dias ? m.dias + 'ダイヤ / ' : ''}${m.trains}本 / ${m.stations}駅）` : '';
  const sig = JSON.stringify(S.room.stationEdits || {}) + '|' + diaIdx();
  if (sig !== editSig) { editSig = sig; if (S.oud) renderMap(); }
  refreshOpsIfIdle();
  if (S.selected != null) renderModal();
}

async function setDelay(no, min) {
  min = Math.max(0, Math.min(999, Math.round(min)));
  await update(roomRef, { ['delays/' + safeKey(no)]: min, updatedAt: stamp() });
}
async function setDriver(no, name) {
  await update(roomRef, { ['assignments/' + safeKey(no)]: name, updatedAt: stamp() });
}

/* ================= 路線図描画 ================= */
let gTrains = null;
const svgEl = $('#map');

function renderMap() {
  const oud = S.oud;
  $('#ttl').textContent = oud.name;
  const L = (S.layout = buildLayout(oud));
  S.trains = compileTrains(curTrains(), L);
  linkTurnarounds(S.trains);
  renderDiaSel();
  svgEl.innerHTML = '';
  svgEl.setAttribute('viewBox', `0 0 ${L.width} ${L.height}`);
  S.icons.clear();

  // 駅ごとの停車種別
  const stopTypes = new Map();
  for (const t of curTrains()) for (const [i, type] of t.stops) {
    if (type !== 1) continue;
    const n = L.canon(i);
    if (!stopTypes.has(n)) stopTypes.set(n, new Set());
    stopTypes.get(n).add(t.type);
  }
  for (const e of L.edges) sv('path', { d: e.d, class: 'rail' }, svgEl);
  for (const nd of L.nodes.values()) {
    if (!nd.label) continue;
    sv('circle', { cx: nd.x, cy: nd.y, r: 9, class: 'dot' }, svgEl);
    const lx = nd.col === 0 ? 12 : 318;
    const num = stNum(nd.id);
    let tx0 = lx;
    if (num) {
      tx0 = lx + 38;
      sv('circle', { cx: lx + 16, cy: nd.y - 6, r: 16, fill: '#fff', stroke: '#19aee8', 'stroke-width': 3 }, svgEl);
      const m = /^([A-Za-z]+)\s*(\d+)$/.exec(num);
      if (m) {
        const a = sv('text', { x: lx + 16, y: nd.y - 12, class: 'numa' }, svgEl); a.textContent = m[1].toUpperCase();
        const b = sv('text', { x: lx + 16, y: nd.y + 1, class: 'numb' }, svgEl); b.textContent = m[2];
      } else { const a = sv('text', { x: lx + 16, y: nd.y - 6, class: 'numa', 'dominant-baseline': 'central' }, svgEl); a.textContent = num.slice(0, 4); }
    }
    const tx = sv('text', { x: tx0, y: nd.y + 2, class: 'sname' }, svgEl);
    tx.textContent = stName(nd.id);
    let bx = lx;
    for (const ti of [...(stopTypes.get(nd.id) || [])].sort((a, b) => a - b)) {
      const T = oud.types[ti]; if (!T || T.name === '回送') continue;
      sv('rect', { x: bx, y: nd.y + 12, width: 22, height: 22, rx: 3, fill: T.color }, svgEl);
      const bt = sv('text', { x: bx + 11, y: nd.y + 28, class: 'bdg-t' }, svgEl);
      bt.textContent = T.abbr; bx += 25;
    }
    // タップ領域（駅名・ナンバリング）
    const hit = sv('rect', { x: lx - 4, y: nd.y - 26, width: 150, height: 34, fill: 'transparent', class: 'sthit', 'data-node': nd.id }, svgEl);
  }
  gTrains = sv('g', {}, svgEl);
  tick();
}

/* ---- 列車アイコン（種別バッジ型） ---- */
function iconGroup(tr, d, mine) {
  const T = S.oud.types[tr.type] || { abbr: '?', color: '#777' };
  const up = tr.dir === 'U';
  const g = sv('g', { class: 'train', 'data-id': tr.id });
  const c = T.color;
  sv('polygon', { points: up ? '-9,-27 9,-27 0,-36' : '-9,27 9,27 0,36', fill: up ? c : c }, g);
  sv('polygon', { points: '-15,19 -5,19 -10,25', fill: c }, g);
  sv('polygon', { points: '5,19 15,19 10,25', fill: c }, g);
  sv('rect', { x: -19, y: -19, width: 38, height: 38, rx: 9, fill: c, stroke: mine ? '#111' : 'none', 'stroke-width': 3 }, g);
  const t = sv('text', { x: 0, y: 1, class: 'ibtxt' }, g); t.textContent = T.abbr;
  if (d > 0) {
    const by = up ? -56 : -42;
    sv('path', { d: `M-5 ${by + 11}L0 ${by + 17}L5 ${by + 11}Z`, fill: '#fde4e4' }, g);
    sv('rect', { x: -22, y: by - 11, width: 44, height: 22, rx: 11, fill: '#fde4e4', stroke: '#f2a6a6', 'stroke-width': 1.5 }, g);
    const dt = sv('text', { x: 0, y: by, class: 'dly' }, g); dt.textContent = '+' + d;
  }
  const drv = driverOf(tr.no);
  if (drv) { const n = sv('text', { x: 0, y: up ? 40 : 50, class: 'dname' }, g); n.textContent = drv; }
  return g;
}

function tick() {
  const now = nowSec();
  $('#clock').textContent = fmtHMS(now) + (sim ? ' (テスト)' : ' JST');
  if (!S.layout || !gTrains) return;
  const act = [];
  for (const tr of S.trains) {
    const d = delayOf(tr.no), shift = d * 60;
    if (d === 0) clearing.delete(tr.no); else if (tr.isFinal) autoReset(tr, now, shift);
    let loc = locate(tr, now, shift) || locate(tr, now + DAY, shift);
    if (!loc) { const ic = S.icons.get(tr.id); if (ic) { ic.g.remove(); S.icons.delete(tr.id); } continue; }
    const p = routePoint(S.layout, loc.u, loc.v, loc.f);
    act.push({ tr, d, x: p.x, y: p.y, col: p.x > 365 ? 1 : 0 });
  }
  // 重なり回避
  const groups = new Map();
  for (const a of act) { const k = a.col + a.tr.dir; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(a); }
  for (const list of groups.values()) {
    list.sort((a, b) => a.y - b.y);
    let idx = 0, last = -1e9;
    for (const a of list) { idx = a.y - last < 46 ? idx + 1 : 0; last = a.y; a.off = idx * 44; }
  }
  for (const a of act) {
    const { tr, d } = a;
    const mine = !!S.myName && driverOf(tr.no) === S.myName;
    const sig = `${tr.type}|${d}|${driverOf(tr.no)}|${mine}`;
    let ic = S.icons.get(tr.id);
    if (!ic || ic.sig !== sig) {
      if (ic) ic.g.remove();
      const g = iconGroup(tr, d, mine); gTrains.appendChild(g);
      ic = { g, sig, fresh: !ic }; S.icons.set(tr.id, ic);
      ic.g.style.transition = 'none';
      requestAnimationFrame(() => requestAnimationFrame(() => { ic.g.style.transition = ''; ic.g.classList.add('ready'); }));
    }
    const x = a.x + (tr.dir === 'U' ? -40 - a.off : 40 + a.off);
    ic.g.style.transform = `translate(${x}px,${a.y}px)`;
  }
}
setInterval(tick, 1000);

svgEl.addEventListener('click', (e) => {
  const hit = e.target.closest('.sthit');
  if (hit) return openStEdit(Number(hit.dataset.node));
  const g = e.target.closest('.train'); if (!g) return;
  S.selected = Number(g.dataset.id); renderModal(); $('#modal').hidden = false;
});

/* ================= 列車詳細モーダル ================= */
function driverOptions(cur) {
  const names = [...new Set([...S.participants, ...(cur ? [cur] : [])])].sort();
  return `<option value="">（未割当）</option>` + names.map((n) => `<option ${n === cur ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function renderModal() {
  const tr = S.trains[S.trains.findIndex((t) => t.id === S.selected)];
  if (!tr) { $('#modal').hidden = true; return; }
  const L = S.layout, T = S.oud.types[tr.type] || { abbr: '?', color: '#777' };
  const d = delayOf(tr.no), shift = d * 60;
  const now = nowSec();
  const first = { name: stName(tr.pts[0].node) }, lastN = { name: stName(tr.pts[tr.pts.length - 1].node) };
  const rows = tr.pts.filter((p) => L.nodes.get(p.node).label).map((p, i) => {
    const nd = L.nodes.get(p.node);
    const t0 = i === 0 ? p.dep : p.arr;
    const tk = p.stop && p.track >= 0 ? (S.oud.stations[p.node].tracks[p.track] || `${p.track + 1}番線`) : '';
    const past = (t0 + shift) % DAY < now && (now - (t0 + shift) % DAY) < 43200;
    const time = d > 0
      ? `<div class="tm late"><b style="color:#e60012">${fmtHM(t0 + shift)}</b><s>${fmtHM(t0)}</s></div>`
      : `<div class="tm">${fmtHM(t0)}</div>`;
    return `<div class="m-row ${past ? 'past' : ''}"><span class="nm">${esc(stName(p.node))}</span>${tk ? `<span class="tk ${d > 0 ? 'late' : ''}">${esc(tk)}</span>` : ''}${time}</div>`;
  }).join('');
  const drv = driverOf(tr.no);
  $('#mBody').innerHTML = `
    <div class="m-from">${esc(first.name)} <small>始発</small></div>
    <div class="m-head">
      <svg width="52" height="62" viewBox="-26 -32 52 62"><polygon points="-9,-27 9,-27 0,-34" fill="${T.color}" ${tr.dir === 'U' ? '' : 'style="display:none"'}/><polygon points="-9,27 9,27 0,34" fill="${T.color}" ${tr.dir === 'D' ? '' : 'style="display:none"'}/><rect x="-19" y="-19" width="38" height="38" rx="9" fill="${T.color}"/><text x="0" y="1" text-anchor="middle" dominant-baseline="central" font-size="22" font-weight="700" fill="#fff">${esc(T.abbr)}</text></svg>
      <div class="dest">${esc(lastN.name)} <small>行</small></div>
      <div class="m-no">${esc(tr.no)}</div>
    </div>
    <div class="m-sub">${esc(T.name)} / 運転士: <b>${esc(drv || '未割当')}</b>${d > 0 ? ` / <span style="color:#e60012">+${d}分</span>` : ''}</div>
    ${tr.note ? `<div class="m-sub">${esc(tr.note)}</div>` : ''}
    ${tr.isFinal && tr.nextNo ? `<div class="m-sub">終点到着後、折り返し <b>${esc(tr.nextNo)}</b> は遅延0で出発します</div>` : ''}
    <div class="m-ctl">
      <span>遅延</span><button data-d="-1">−1</button><button data-d="1">+1</button><button data-d="5">+5</button><button data-d="0">解除</button>
      <select id="mDrv">${driverOptions(drv)}</select>
    </div>
    <div class="m-cap">到着時刻（定刻・見込み）／始発駅は発車時刻</div>
    ${rows}`;
  $('#mBody').querySelectorAll('[data-d]').forEach((b) => b.onclick = () => {
    const v = Number(b.dataset.d);
    setDelay(tr.no, v === 0 ? 0 : delayOf(tr.no) + v).catch((e) => toast('更新失敗: ' + e.code));
  });
  $('#mDrv').onchange = (e) => setDriver(tr.no, e.target.value).catch((er) => toast('更新失敗: ' + er.code));
}
$('#mClose').onclick = () => { $('#modal').hidden = true; S.selected = null; };
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal') $('#mClose').click(); });

/* ================= 運番設定パネル ================= */
function opsGroups() {
  const m = new Map();
  for (const t of S.trains) { if (!m.has(t.no)) m.set(t.no, []); m.get(t.no).push(t); }
  return [...m.entries()].map(([no, segs]) => { segs.sort((a, b) => a.start - b.start); return { no, segs }; })
    .sort((a, b) => a.segs[0].start - b.segs[0].start);
}
function renderOps() {
  if (!S.layout) { $('#opsTbl tbody').innerHTML = '<tr><td colspan="4">ダイヤ未読み込み</td></tr>'; return; }
  const q = $('#opsFilter').value.trim().toLowerCase();
  const L = S.layout, tb = $('#opsTbl tbody'); tb.innerHTML = '';
  for (const g of opsGroups()) {
    const f = g.segs[0], l = g.segs[g.segs.length - 1];
    const fn = stName(f.pts[0].node), ln = stName(l.pts[l.pts.length - 1].node);
    if (q && !(g.no.toLowerCase().includes(q) || fn.includes(q) || ln.includes(q))) continue;
    const types = [...new Set(g.segs.map((s) => s.type))].map((ti) => { const T = S.oud.types[ti] || { abbr: '?', color: '#777' }; return `<span class="tb" style="background:${T.color}">${esc(T.abbr)}</span>`; }).join('');
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><b>${esc(g.no)}</b><br><small>${f.dir === 'D' ? '下り' : '上り'}</small></td><td>${types}</td>
      <td class="mono">${esc(fn)} ${fmtHM(f.pts[0].dep)}発<br>→ ${esc(ln)} ${fmtHM(l.end)}着</td>
      <td><select>${driverOptions(driverOf(g.no))}</select></td>`;
    tr.querySelector('select').onchange = (e) => setDriver(g.no, e.target.value).then(() => toast(`${g.no}: ${e.target.value || '未割当'}`)).catch((er) => toast('更新失敗: ' + er.code));
    tb.appendChild(tr);
  }
}
function refreshOpsIfIdle() {
  if ($('#panelOps').hidden) return;
  if (document.activeElement?.tagName === 'SELECT' && $('#panelOps').contains(document.activeElement)) return;
  renderOps();
}
$('#opsFilter').oninput = renderOps;

/* ================= 右下パネル開閉・タブ ================= */
function togglePanel(id, show) {
  for (const p of ['panelSet', 'panelOps']) $('#' + p).hidden = p !== id ? true : show === undefined ? !$('#' + p).hidden : !show;
  if (id === 'panelOps' && !$('#panelOps').hidden) renderOps();
}
$('#btnSet').onclick = () => togglePanel('panelSet');
$('#btnOps').onclick = () => togglePanel('panelOps');
document.querySelectorAll('[data-close]').forEach((b) => b.onclick = () => ($('#' + b.dataset.close).hidden = true));
function showTab(id) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  document.querySelectorAll('#panelSet .tab').forEach((t) => t.classList.toggle('on', t.id === id));
}
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => showTab(b.dataset.tab));

/* ================= ① DiscordサーバーID ================= */
$('#saveGuild').onclick = async () => {
  const v = $('#inGuild').value.trim();
  if (!/^\d{15,22}$/.test(v)) return toast('サーバーIDは数字(17〜20桁程度)で入力してください');
  try { await update(roomRef, { guildId: v, updatedAt: stamp() }); toast('サーバーIDを保存しました'); }
  catch (e) { toast('保存失敗: ' + e.code); }
};

/* ================= ② 参加者（Discord ID と呼び名） ================= */
const newPid = () => 'p' + Math.random().toString(36).slice(2, 10);
function renderPartRows() {
  const box = $('#prows'); box.innerHTML = '';
  partDraft.forEach((r, i) => {
    const d = document.createElement('div'); d.className = 'prow';
    d.innerHTML = `<label>参加者Discord ID：</label><input class="pd" inputmode="numeric" autocomplete="off" placeholder="（記入）" value="${esc(r.discordId)}">
      <label>呼び名：</label><input class="pn" autocomplete="off" placeholder="（記入）" value="${esc(r.name)}">
      <button class="x pdel" type="button">削除</button>`;
    d.querySelector('.pd').oninput = (e) => { r.discordId = e.target.value.trim(); partDirty = true; };
    d.querySelector('.pn').oninput = (e) => { r.name = e.target.value.trim(); partDirty = true; };
    d.querySelector('.pdel').onclick = () => { partDraft.splice(i, 1); partDirty = true; renderPartRows(); };
    box.appendChild(d);
  });
}
$('#pAdd').onclick = () => { partDraft.push({ pid: newPid(), name: '', discordId: '' }); partDirty = true; renderPartRows(); };
$('#pSave').onclick = async () => {
  const rows = partDraft.filter((r) => r.name || r.discordId);
  for (const r of rows) {
    if (!/^\d{15,22}$/.test(r.discordId)) return toast('Discord ID は数字（18桁前後）で入力してください');
    if (!r.name) return toast('呼び名を入力してください');
    if (strLen(r.name) > 7) return toast('呼び名は7文字以内です');
  }
  if (new Set(rows.map((r) => r.name)).size !== rows.length) return toast('同じ呼び名があります');
  if (new Set(rows.map((r) => r.discordId)).size !== rows.length) return toast('同じDiscord IDがあります');
  const up = {};
  for (const old of S.partRows) if (!rows.some((r) => r.pid === old.pid)) up[old.pid] = null;
  for (const r of rows) up[r.pid] = { name: r.name, discordId: r.discordId, updatedAt: stamp() };
  try {
    if (Object.keys(up).length) await update(partsRef, up);
    partDirty = false; toast('参加者を保存しました');
  } catch (e) { toast('保存失敗: ' + e.code); }
};

/* ================= ③ ファイル読み込み（選ぶと自動で解析・保存） ================= */
$('#inFile').onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return;
  const info = $('#fileInfo'); info.textContent = '読み込み中…';
  try {
    const oud = parseOud2(decodeBuffer(await f.arrayBuffer()));
    const json = JSON.stringify(oud);
    if (new Blob([json]).size > 900000) { info.textContent = 'ダイヤが大きすぎます（約900KBまで）'; return; }
    await set(oudRef, { json, updatedAt: stamp() });
    await update(roomRef, { oudMeta: { fileName: f.name, dias: oud.dias.length, trains: oud.dias.reduce((n, d) => n + d.trains.length, 0), stations: oud.stations.length }, updatedAt: stamp() });
    info.innerHTML = `読み込みました: ${esc(oud.name)} / ${oud.stations.length}駅 / ${oud.dias.length}ダイヤ<br>` + oud.dias.map((d) => `・${esc(d.name)}: ${d.trains.length}本（運番${new Set(d.trains.map((t) => t.no)).size}種）`).join('<br>');
    toast('ダイヤを読み込みました');
  } catch (er) { info.textContent = '読み込み失敗: ' + (er.code ? '保存できませんでした(' + er.code + ')' : er.message); }
  e.target.value = '';
};

/* ================= テスト時刻 ================= */
$('#simApply').onclick = () => {
  if (!$('#simOn').checked) { sim = null; $('#map').classList.remove('fast'); return toast('実時刻(JST)に戻しました'); }
  const [h, m, s] = $('#simTime').value.split(':').map(Number);
  const speed = Number($('#simSpeed').value);
  sim = { realStart: Date.now(), simStart: h * 3600 + m * 60 + (s || 0), speed };
  $('#map').classList.toggle('fast', speed > 1);
  toast('テスト時刻を適用しました');
};

/* ================= 駅名・ナンバリング編集 ================= */
let editNode = null;
function openStEdit(id) {
  editNode = id;
  $('#seOrig').textContent = `元の駅名: ${S.layout.nodes.get(id).name}`;
  $('#seNum').value = stNum(id);
  $('#seName').value = stEdit(id).name || S.layout.nodes.get(id).name;
  $('#stEdit').hidden = false;
}
$('#seCancel').onclick = () => ($('#stEdit').hidden = true);
$('#stEdit').addEventListener('click', (e) => { if (e.target.id === 'stEdit') $('#seCancel').click(); });
async function saveStEdit(num, name) {
  const orig = S.layout.nodes.get(editNode).name;
  const v = { num: num.trim(), name: name.trim() === orig ? '' : name.trim() };
  try {
    await update(roomRef, { ['stationEdits/s_' + editNode]: v, updatedAt: stamp() });
    $('#stEdit').hidden = true; toast('駅情報を保存しました');
  } catch (e) { toast('保存失敗: ' + e.code); }
}
$('#seSave').onclick = () => saveStEdit($('#seNum').value, $('#seName').value);
$('#seReset').onclick = () => saveStEdit('', S.layout.nodes.get(editNode).name);

/* ================= 駅別時刻表 画像ダウンロード ================= */
function stationNodes() { return [...S.layout.nodes.values()].filter((n) => n.label).sort((a, b) => a.y - b.y || a.x - b.x); }
function dlStation(id) {
  const times = collectTimes(S.trains, id, stName, S.oud.types);
  const cv = drawTimetable({ name: stName(id), num: stNum(id), times, types: S.oud.types });
  return downloadCanvas(cv, `${stNum(id) ? stNum(id) + '_' : ''}${stName(id)}_時刻表.png`);
}
$('#ttAll').onclick = async () => {
  if (!S.layout) return toast('ダイヤ未読み込み');
  for (const nd of stationNodes()) { await dlStation(nd.id); await new Promise((r) => setTimeout(r, 500)); }
  toast('全駅の画像を出力しました（複数DLの許可を求められたら許可）');
};

/* ================= ダイヤ（複数）切替 ================= */
function renderDiaSel() {
  const sel = $('#diaSel');
  const dias = S.oud?.dias || [];
  sel.hidden = dias.length < 2;
  sel.innerHTML = dias.map((d, i) => `<option value="${i}" ${i === diaIdx() ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}
$('#diaSel').onchange = (e) => update(roomRef, { diaIndex: Number(e.target.value), updatedAt: stamp() })
  .then(() => toast('表示ダイヤを切り替えました（全員に反映）')).catch((er) => toast('切替失敗: ' + er.code));

/* ================= 折り返し判定・遅延の自動リセット ================= */
// 各運番の「最終区間」が終点に着いたら、その運番の遅延を0に戻す。
// あわせて、その終点から折り返す次の列車（別運番・逆方向・最も早く出る列車）も遅延0で出発させる。
function linkTurnarounds(trains) {
  const g = new Map();
  for (const t of trains) { if (!g.has(t.no)) g.set(t.no, []); g.get(t.no).push(t); }
  for (const list of g.values()) list.sort((a, b) => a.start - b.start);
  const finals = [], starts = [];
  for (const [no, list] of g) {
    list[list.length - 1].isFinal = true; finals.push(list[list.length - 1]);
    starts.push(list[0]);
  }
  for (const t of trains) { t.nextNo = null; }
  const used = new Set();
  finals.sort((a, b) => a.end - b.end);
  for (const f of finals) {
    const node = f.pts[f.pts.length - 1].node;
    let best = null;
    for (const s of starts) {
      if (s.no === f.no || used.has(s.no) || s.dir === f.dir || s.pts[0].node !== node) continue;
      const gap = s.start - f.end;
      if (gap < 0 || gap > 3600) continue;
      if (!best || s.start < best.start) best = s;
    }
    if (best) { f.nextNo = best.no; used.add(best.no); }
  }
}
const clearing = new Set();
function autoReset(tr, now, shift) {
  const end = tr.holdUntil + shift;
  const ok = [now, now + DAY].some((t) => t - end >= 0 && t - end < 6 * 3600);
  if (!ok || clearing.has(tr.no)) return;
  clearing.add(tr.no);
  setDelay(tr.no, 0)
    .then(() => { if (tr.nextNo && delayOf(tr.nextNo) > 0) return setDelay(tr.nextNo, 0); })
    .catch(() => clearing.delete(tr.no));
}

/* ================= このページを開いている間は、サーバー(Bot)を起こし続ける ================= */
// ページが4分ごとに自分のサーバーの /health にアクセスする（無料枠は約15分アクセスが無いとスリープするため）
const keepAlive = () => fetch('/health', { cache: 'no-store' }).catch(() => {});
setInterval(keepAlive, 4 * 60 * 1000);
