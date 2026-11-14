// Discord Bot（Render にデプロイ）
// Realtime Database を使用。必要な環境変数は2つ:
//   FIREBASE_SERVICE_ACCOUNT : Firebase サービスアカウントJSON（中身をそのまま貼り付け）
//   （任意）FIREBASE_DATABASE_URL : DATABASE_URL をコードに書かない場合のURL指定
//   DISCORD_TOKEN            : Discord Bot トークン
// 画面(bot/public)もこの Bot が配信します。ルームURLは Render のURL（RENDER_EXTERNAL_URL）を自動使用。
// 任意: WEB_BASE_URL（独自ドメインを使う場合）
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getDatabase, ServerValue } from 'firebase-admin/database';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
sa.private_key = sa.private_key.replace(/\\n/g, '\n');
// ★ Realtime Database のURLをここに書く（コンソールの Realtime Database 上部に表示されているURLをそのまま）
//   例: 'https://xxxx-default-rtdb.asia-southeast1.firebasedatabase.app'
//   書かない（'https://' で始まらない）場合は、環境変数 FIREBASE_DATABASE_URL、
//   それも無ければ https://<プロジェクトID>-default-rtdb.firebaseio.com を使います。
const DATABASE_URL = 'https://train-73ddb-default-rtdb.firebaseio.com';
initializeApp({
  credential: cert(sa),
  databaseURL: DATABASE_URL.startsWith('https://') ? DATABASE_URL : (process.env.FIREBASE_DATABASE_URL || `https://${sa.project_id}-default-rtdb.firebaseio.com`),
});
const db = getDatabase();
const TS = () => ServerValue.TIMESTAMP;
// 画面(bot/public)はこの Bot が配信する。URLは Render のURLを自動使用（独自に変えるなら WEB_BASE_URL）
const BASE = (process.env.WEB_BASE_URL || process.env.RENDER_EXTERNAL_URL || 'https://zaisenweb.onrender.com').replace(/\/$/, '');
const TTL_MS = 3 * 24 * 3600 * 1000; // 3日

const safeKey = (no) => 't_' + String(no).replace(/[^0-9A-Za-z_\-぀-ヿ一-鿿]/g, '_');
const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/* ---------- ルーム ---------- */
async function getRoomById(id) {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
  const snap = await db.ref(`zaisen/rooms/${id}`).get();
  if (!snap.exists()) return null;
  const v = snap.val();
  if (!(v.expiresAt > Date.now())) return null;   // 期限切れは無効
  return { id, ref: snap.ref, v };
}
// コマンド利用者が登録されているルーム:
//  1) Web設定「参加者ID」に Discord ID が登録されているルーム（複数なら最新）
//  2) /room で発行 または /join で参加したルーム
async function findUserRoom(userId) {
  const all = (await db.ref('zaisen/participants').get()).val() || {};
  let best = null;
  for (const [rid, parts] of Object.entries(all)) {
    if (!Object.values(parts || {}).some((p) => p && p.discordId === userId)) continue;
    const r = await getRoomById(rid);
    if (r && (!best || r.v.createdAt > best.v.createdAt)) best = r;
  }
  if (best) return best;
  const s = await db.ref(`zaisen/userRooms/${userId}`).get();
  return s.exists() ? getRoomById(s.val().roomId) : null;
}
const urCache = new Map();
async function cachedUserRoom(uid) {
  const c = urCache.get(uid);
  if (c && Date.now() - c.t < 15000) return c.room;
  const room = await findUserRoom(uid);
  urCache.set(uid, { t: Date.now(), room });
  return room;
}
const registerUser = (userId, roomId) => db.ref(`zaisen/userRooms/${userId}`).set({ roomId, joinedAt: TS() });
const roomUrl = (id) => `${BASE}/?room=${id}`;

const trainCache = new Map();
// 表示中ダイヤ(diaIndex)の列車を取得（30秒キャッシュ）
async function loadTrains(room) {
  const idx = Number(room.v.diaIndex) || 0, key = `${room.id}:${idx}`;
  const c = trainCache.get(key);
  if (c && Date.now() - c.t < 30000) return c.list;
  const s = await db.ref(`zaisen/oud/${room.id}/json`).get();
  let list = [];
  if (s.exists()) {
    try { const j = JSON.parse(s.val()); list = j.dias ? j.dias[Math.min(idx, j.dias.length - 1)]?.trains || [] : j.trains || []; } catch {}
  }
  trainCache.set(key, { t: Date.now(), list });
  return list;
}
const trainNos = async (room) => [...new Set((await loadTrains(room)).map((t) => t.no))];
// 自分(Discord ID)の呼び名 → 割り当てられた運番
async function myTrainNos(room, uid) {
  const parts = (await db.ref(`zaisen/participants/${room.id}`).get()).val() || {};
  const names = Object.values(parts).filter((p) => p && p.discordId === uid).map((p) => p.name);
  if (!names.length) return [];
  const keys = new Set(Object.entries(room.v.assignments || {}).filter(([, v]) => names.includes(v)).map(([k]) => k));
  return keys.size ? (await trainNos(room)).filter((no) => keys.has(safeKey(no))) : [];
}
// 担当が複数あるとき: 走行中 → 直前(30分以内)に終着したもの → 次に出るもの → 最後 の順で1つ選ぶ
function pickTrain(nos, trains) {
  const now = jstNow(); let running = null, recent = null, next = null, last = null;
  for (const no of nos) {
    const ts = trains.filter((t) => t.no === no);
    const st = Math.min(...ts.map((t) => t.stops[0][2])), en = Math.max(...ts.map((t) => t.stops[t.stops.length - 1][2]));
    if (now >= st - 300 && now <= en) { if (!running || st < running.st) running = { no, st }; }
    else if (now > en && now <= en + 1800) { if (!recent || en > recent.en) recent = { no, en }; }
    else if (st > now) { if (!next || st < next.st) next = { no, st }; }
    if (!last || en > last.en) last = { no, en };
  }
  return (running || recent || next || last).no;
}
const jstNow = () => ((Date.now() / 1000 + 9 * 3600) % 86400);

/* ---------- コマンド定義 ---------- */
const commands = [
  new SlashCommandBuilder().setName('room').setDescription('部屋作成'),
  new SlashCommandBuilder().setName('join').setDescription('部屋参加')
    .addStringOption((o) => o.setName('room').setDescription('ルームのURL（/link で出るもの）').setRequired(true)),
  new SlashCommandBuilder().setName('link').setDescription('作った部屋のコード'),
  new SlashCommandBuilder().setName('delay').setDescription('電車を遅らせる')
    .addIntegerOption((o) => o.setName('minutes').setDescription('遅れる分数（0で解除）').setRequired(true).setMinValue(0).setMaxValue(999))
    .addStringOption((o) => o.setName('train').setDescription('運番（省略すると自分の担当）').setAutocomplete(true)),
  new SlashCommandBuilder().setName('delayclear').setDescription('遅延コマンドの削除')
    .addStringOption((o) => o.setName('train').setDescription('運番（省略すると自分の担当。担当がなければ全列車）').setAutocomplete(true)),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const registerFor = (g) => g.commands.set(commands)
  .then(() => console.log('commands registered:', g.name, g.id))
  .catch((e) => console.error('register FAILED:', g.name, g.id, e.message, '→ 招待時に applications.commands が必要'));
// discord.js の版によって起動完了のイベント名が違う（ready / clientReady）ので両方で待ち、1回だけ実行する
let started = false;
const onReady = async () => {
  if (started) return;
  started = true;
  console.log('ready', client.user.tag, 'servers:', client.guilds.cache.size, BASE);
  if (!client.guilds.cache.size) console.warn('Bot はどのサーバーにも参加していません。招待URLで追加してください。');
  for (const g of client.guilds.cache.values()) await registerFor(g);
};
client.once('clientReady', onReady);
client.once('ready', onReady);
client.on('error', (e) => console.error('client error:', e.message));
client.on('warn', (m) => console.warn('client warn:', m));
client.on('guildCreate', registerFor);

const ephemeral = MessageFlags.Ephemeral;

client.on('interactionCreate', async (i) => {
  try {
    if (!i.guildId) return;
    if (i.isAutocomplete()) {
      const room = await cachedUserRoom(i.user.id);
      const q = String(i.options.getFocused()).toLowerCase();
      const list = room ? (await trainNos(room)).filter((n) => n.toLowerCase().includes(q)).slice(0, 25) : [];
      return i.respond(list.map((n) => ({ name: n, value: n })));
    }
    if (!i.isChatInputCommand()) return;
    // 先に「応答中…」を表示して、処理が遅くても「応答しませんでした」にならないようにする
    await i.deferReply(['join', 'link'].includes(i.commandName) ? { flags: ephemeral } : {});

    if (i.commandName === 'room') {
      const id = randomBytes(18).toString('base64url');
      const now = Date.now();
      await db.ref(`zaisen/rooms/${id}`).set({
        guildId: i.guildId,
        createdBy: { id: i.user.id, name: i.user.username },
        createdAt: now,
        expiresAt: now + TTL_MS,
        updatedAt: TS(),
      });
      await registerUser(i.user.id, id);
      return i.editReply('部屋を作成しました。\n3日後にリンクが消えます。\n/linkのコマンドでリンクを発行して他の人が/joinで入れるようになります。\nリンク開いて設定からファイル読み込めます。');
    }

    if (i.commandName === 'join') {
      const raw = i.options.getString('room', true).trim();
      const id = (/[?&]room=([A-Za-z0-9_-]+)/.exec(raw) || /^([A-Za-z0-9_-]{8,64})$/.exec(raw) || [])[1];
      const target = id ? await getRoomById(id) : null;
      if (!target) return i.editReply('ルームが見つからないか、有効期限（3日）が切れています。URLを確認してください。');
      await registerUser(i.user.id, target.id);
      return i.editReply(`ルームに登録しました。以後あなたの /delay はこのルームに反映されます。\n${roomUrl(target.id)}\n有効期限: ${jst.format(target.v.expiresAt)} JST`);
    }

    const room = await findUserRoom(i.user.id);
    if (!room) return i.editReply('登録されている有効なルームがありません。/room で発行するか、/join でルームのURLを登録してください。');

    if (i.commandName === 'link') {
      return i.editReply(`${roomUrl(room.id)}\n有効期限: ${jst.format(room.v.expiresAt)} JST`);
    }

    if (i.commandName === 'delay') {
      const min = i.options.getInteger('minutes', true);
      const given = (i.options.getString('train') || '').trim();
      const all = await loadTrains(room);
      let train = given;
      if (!train) {
        const nos = await myTrainNos(room, i.user.id);
        if (!nos.length) return i.editReply('担当の運番がありません。運番を指定する（/delay minutes:3 train:運番）か、Webの設定「参加者ID」に自分のDiscord IDを登録して運番を割り当ててください。');
        train = pickTrain(nos, all);
      }
      const trains = all.filter((t) => t.no === train);
      if (!trains.length) return i.editReply(`運番「${train}」はダイヤにありません。（候補は入力補完に出ます）`);
      const start = Math.min(...trains.map((t) => t.stops[0][2])), end = Math.max(...trains.map((t) => t.stops[t.stops.length - 1][2]));
      const now = jstNow();
      const state = now < start ? '（まだ出発前です。出発がその分遅れます）' : now > end ? '（すでに終着済みのため、まもなく自動で0に戻ります）' : '';
      await room.ref.update({ [`delays/${safeKey(train)}`]: min, updatedAt: TS() });
      return i.editReply(min === 0 ? `${train} の遅延を解除しました。` : `${train} を **+${min}分** 遅延に設定しました。${state}\n終点到着後は自動で遅延0に戻り、折り返し列車も遅延0で出発します。`);
    }

    if (i.commandName === 'delayclear') {
      const given = (i.options.getString('train') || '').trim();
      if (given) {
        await room.ref.update({ [`delays/${safeKey(given)}`]: 0, updatedAt: TS() });
        return i.editReply(`${given} の遅延を解除しました。`);
      }
      const mine = await myTrainNos(room, i.user.id);
      if (mine.length) {
        const up = { updatedAt: TS() };
        for (const no of mine) up[`delays/${safeKey(no)}`] = 0;
        await room.ref.update(up);
        return i.editReply(`担当の遅延を解除しました（${mine.join('、')}）。`);
      }
      await room.ref.update({ delays: null, updatedAt: TS() });
      return i.editReply('全列車の遅延を解除しました。');
    }
  } catch (e) {
    console.error(e);
    const msg = 'エラーが発生しました。しばらくしてからもう一度お試しください。';
    if (i.isAutocomplete?.()) i.respond([]).catch(() => {});
    else if (i.deferred) i.editReply(msg).catch(() => {});
    else if (i.isRepliable?.() && !i.replied) i.reply({ content: msg, flags: ephemeral }).catch(() => {});
  }
});

/* ---------- 期限切れルームの削除（1時間毎） ---------- */
async function cleanup() {
  // インデックス不要: ルームは小さいので全件読んで期限切れを抽出
  const snap = await db.ref('zaisen/rooms').get();
  const now = Date.now(), del = {};
  let n = 0;
  snap.forEach((ch) => {
    if (!(ch.val().expiresAt > now)) { n++; del[`zaisen/rooms/${ch.key}`] = null; del[`zaisen/oud/${ch.key}`] = null; del[`zaisen/participants/${ch.key}`] = null; }
  });
  if (n) { await db.ref().update(del); console.log('deleted rooms:', n); }
}
setInterval(() => cleanup().catch(console.error), 3600 * 1000);
cleanup().catch(console.error);

// Render の Web Service 用ヘルスチェック（/health）。Background Worker なら不要
// 画面ファイルの置き場所: index.js と同じフォルダ、または public/ フォルダのどちらでも可
const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC = { 'index.html': 'text/html; charset=utf-8', 'app.js': 'text/javascript; charset=utf-8' }; // 配信するのはこの2つだけ
async function readStatic(name) {
  for (const dir of [path.join(HERE, 'public'), HERE]) {
    try { return await fs.readFile(path.join(dir, name)); } catch {}
  }
  return null;
}
http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const data = Object.hasOwn(STATIC, name) ? await readStatic(name) : null;
    if (!data) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(200, { 'content-type': STATIC[name], 'cache-control': 'no-cache' });
    res.end(data);
  } catch {
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('error');
  }
}).listen(process.env.PORT || 3000);

// スリープ防止: 起動中は10分ごとに自分の公開URLへアクセス（RENDER_EXTERNAL_URL は Render が自動設定）
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || 'https://zaisenweb.onrender.com').replace(/\/$/, '');
setInterval(() => {
  fetch(SELF_URL + '/health').then((r) => console.log('self-ping', r.status)).catch((e) => console.error('self-ping failed', e.message));
}, 10 * 60 * 1000);

console.log('Discord にログイン中...', process.env.DISCORD_TOKEN ? '(トークンあり)' : '(トークンが未設定！ DISCORD_TOKEN を確認)');
client.login(process.env.DISCORD_TOKEN).then(() => console.log('Discord login OK')).catch((e) => console.error('Discord login FAILED:', e.message, '→ DISCORD_TOKEN を確認'));
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
