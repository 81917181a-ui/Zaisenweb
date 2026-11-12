// Discord Bot（Render にデプロイ）
// 必要な環境変数は2つだけ:
//   FIREBASE_SERVICE_ACCOUNT : Firebase サービスアカウントJSON（中身をそのまま貼り付け）
//   DISCORD_TOKEN            : Discord Bot トークン
// 任意: WEB_BASE_URL（独自ドメインを使う場合。未設定なら https://<projectId>.web.app）
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { Client, GatewayIntentBits, SlashCommandBuilder, MessageFlags } from 'discord.js';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp, FieldValue } from 'firebase-admin/firestore';

const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
sa.private_key = sa.private_key.replace(/\\n/g, '\n');
initializeApp({ credential: cert(sa) });
const db = getFirestore();
const BASE = (process.env.WEB_BASE_URL || `https://${sa.project_id}.web.app`).replace(/\/$/, '');
const TTL_MS = 3 * 24 * 3600 * 1000; // 3日

const safeKey = (no) => 't_' + String(no).replace(/[^0-9A-Za-z_\-぀-ヿ一-鿿]/g, '_');
const jst = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });

/* ---------- ルーム ---------- */
async function findActiveRoom(guildId) {
  const snap = await db.collection('rooms').where('guildId', '==', guildId).get();
  const now = Date.now();
  const alive = snap.docs.filter((d) => d.data().expiresAt.toMillis() > now);
  alive.sort((a, b) => b.data().createdAt.toMillis() - a.data().createdAt.toMillis());
  return alive[0] || null;
}
const roomUrl = (id) => `${BASE}/?room=${id}`;

const trainCache = new Map();
// 表示中ダイヤ(diaIndex)の列車を取得（30秒キャッシュ）
async function loadTrains(room) {
  const idx = Number(room.data().diaIndex) || 0, key = `${room.id}:${idx}`;
  const c = trainCache.get(key);
  if (c && Date.now() - c.t < 30000) return c.list;
  const s = await db.doc(`rooms/${room.id}/data/oud`).get();
  let list = [];
  if (s.exists) {
    try { const j = JSON.parse(s.data().json); list = j.dias ? j.dias[Math.min(idx, j.dias.length - 1)]?.trains || [] : j.trains || []; } catch {}
  }
  trainCache.set(key, { t: Date.now(), list });
  return list;
}
const trainNos = async (room) => [...new Set((await loadTrains(room)).map((t) => t.no))];
const jstNow = () => ((Date.now() / 1000 + 9 * 3600) % 86400);

/* ---------- コマンド定義 ---------- */
const commands = [
  new SlashCommandBuilder().setName('room').setDescription('在線表示ルームを発行します（有効期限3日）'),
  new SlashCommandBuilder().setName('link').setDescription('このサーバーの有効なルームのURLを表示します'),
  new SlashCommandBuilder().setName('delay').setDescription('列車の遅延を設定します')
    .addStringOption((o) => o.setName('train').setDescription('運番').setRequired(true).setAutocomplete(true))
    .addIntegerOption((o) => o.setName('minutes').setDescription('遅延分数（0で解除）').setRequired(true).setMinValue(0).setMaxValue(999)),
  new SlashCommandBuilder().setName('delayclear').setDescription('遅延を解除します（運番省略で全列車）')
    .addStringOption((o) => o.setName('train').setDescription('運番').setAutocomplete(true)),
].map((c) => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const registerFor = (g) => g.commands.set(commands).catch((e) => console.error('register', g.id, e.message));
client.once('ready', async () => {
  console.log('ready', client.user.tag, BASE);
  for (const g of client.guilds.cache.values()) await registerFor(g);
});
client.on('guildCreate', registerFor);

const ephemeral = MessageFlags.Ephemeral;

client.on('interactionCreate', async (i) => {
  try {
    if (!i.guildId) return;
    if (i.isAutocomplete()) {
      const room = await findActiveRoom(i.guildId);
      const q = String(i.options.getFocused()).toLowerCase();
      const list = room ? (await trainNos(room)).filter((n) => n.toLowerCase().includes(q)).slice(0, 25) : [];
      return i.respond(list.map((n) => ({ name: n, value: n })));
    }
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'room') {
      const id = randomBytes(18).toString('base64url');
      const now = Date.now();
      await db.collection('rooms').doc(id).set({
        guildId: i.guildId,
        createdBy: { id: i.user.id, name: i.user.username },
        createdAt: Timestamp.fromMillis(now),
        expiresAt: Timestamp.fromMillis(now + TTL_MS),
        assignments: {}, delays: {},
        updatedAt: FieldValue.serverTimestamp(),
      });
      return i.reply(`在線表示ルームを発行しました。\n${roomUrl(id)}\n有効期限: ${jst.format(now + TTL_MS)} JST（3日間）\n設定パネル(歯車)の「.oud2」タブからダイヤを読み込んでください。`);
    }

    const room = await findActiveRoom(i.guildId);
    if (!room) return i.reply({ content: '有効なルームがありません。/room で発行してください。', flags: ephemeral });

    if (i.commandName === 'link') {
      return i.reply({ content: `${roomUrl(room.id)}\n有効期限: ${jst.format(room.data().expiresAt.toMillis())} JST`, flags: ephemeral });
    }

    if (i.commandName === 'delay') {
      const train = i.options.getString('train', true).trim();
      const min = i.options.getInteger('minutes', true);
      const trains = (await loadTrains(room)).filter((t) => t.no === train);
      if (!trains.length) return i.reply({ content: `運番「${train}」はダイヤにありません。（候補は入力補完に出ます）`, flags: ephemeral });
      const start = Math.min(...trains.map((t) => t.stops[0][2])), end = Math.max(...trains.map((t) => t.stops[t.stops.length - 1][2]));
      const now = jstNow();
      const state = now < start ? '（まだ出発前です。出発がその分遅れます）' : now > end ? '（すでに終着済みのため、まもなく自動で0に戻ります）' : '';
      await room.ref.set({ delays: { [safeKey(train)]: min }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      return i.reply(min === 0 ? `${train} の遅延を解除しました。` : `${train} を **+${min}分** 遅延に設定しました。${state}\n終点到着後は自動で遅延0に戻り、折り返し列車も遅延0で出発します。`);
    }

    if (i.commandName === 'delayclear') {
      const train = i.options.getString('train');
      if (train) await room.ref.set({ delays: { [safeKey(train.trim())]: 0 }, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      else await room.ref.update({ delays: {}, updatedAt: FieldValue.serverTimestamp() });
      return i.reply(train ? `${train} の遅延を解除しました。` : '全列車の遅延を解除しました。');
    }
  } catch (e) {
    console.error(e);
    if (i.isRepliable() && !i.replied && !i.deferred) i.reply({ content: 'エラーが発生しました。', flags: ephemeral }).catch(() => {});
  }
});

/* ---------- 期限切れルームの削除（1時間毎） ---------- */
async function cleanup() {
  const snap = await db.collection('rooms').where('expiresAt', '<', Timestamp.now()).get();
  for (const d of snap.docs) await db.recursiveDelete(d.ref).catch((e) => console.error('cleanup', e.message));
  if (snap.size) console.log('deleted rooms:', snap.size);
}
setInterval(() => cleanup().catch(console.error), 3600 * 1000);
cleanup().catch(console.error);

// Render の Web Service 用ヘルスチェック（/health）。Background Worker なら不要
http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }).listen(process.env.PORT || 3000);

// スリープ防止: 起動中は10分ごとに自分の公開URLへアクセス（RENDER_EXTERNAL_URL は Render が自動設定）
const SELF_URL = (process.env.RENDER_EXTERNAL_URL || 'https://zaisenweb.onrender.com').replace(/\/$/, '');
setInterval(() => {
  fetch(SELF_URL + '/health').then((r) => console.log('self-ping', r.status)).catch((e) => console.error('self-ping failed', e.message));
}, 10 * 60 * 1000);

client.login(process.env.DISCORD_TOKEN);
