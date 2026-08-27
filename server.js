/**
 * server.js
 * ------------------------------------------------------------
 * 列車管理システム Webサーバー
 *
 * 必要な環境変数は DISCORD_TOKEN と GROQ_API_KEY の2つだけです。
 * （API_SECRET_KEYは使用しません。Discord Botはこのサーバーの管理APIを
 *   経由せず、firebaseClient.js経由で直接Firebaseを読み書きします）
 *
 * このファイルの役割:
 *  1. index.html等の静的ファイル配信
 *  2. Renderのリバースプロキシ配下で正しいIPを取得する設定 (trust proxy)
 *  3. IP BANされたIPからのアクセスを遮断するミドルウェア
 *     （BANリストはFirebaseの bannedIps をリアルタイム購読）
 *  4. クライアントの正確なIPをFirebaseへ記録する /api/record-ip
 *  5. Groq APIの呼び出しをサーバー経由にするプロキシ /api/groq
 *     （APIキーをクライアントに一切渡さない。キュー処理と429バックオフ対応）
 *  6. Web画面側の操作（部屋作成・部屋削除・ファイル読み込み）をDiscordの
 *     ログチャンネルへ通知する /api/log
 *  7. Renderの無料プラン等でのスリープ防止のための自己ping（10分間隔）
 * ------------------------------------------------------------
 */

const path = require('path');
const express = require('express');
const { db, ref, get, set, push, onValue } = require('./firebaseClient');
const { isValidRoomId, roomLabel } = require('./roomUtils');

if (!process.env.GROQ_API_KEY) {
    console.error('環境変数 GROQ_API_KEY が設定されていません。');
    process.exit(1);
}

// ------------------------------------------------------------
// 自己ping（Renderのスリープ対策）。10分ごとに自分自身のURLへアクセスする。
// ------------------------------------------------------------
const SELF_PING_URL = 'https://zaisenweb-1.onrender.com';
const SELF_PING_INTERVAL_MS = 10 * 60 * 1000; // 10分
setInterval(() => {
    fetch(SELF_PING_URL)
        .then((res) => console.log(`[keep-alive] ${SELF_PING_URL} へping送信 (status: ${res.status})`))
        .catch((err) => console.warn('[keep-alive] pingに失敗しました:', err.message));
}, SELF_PING_INTERVAL_MS);

// ------------------------------------------------------------
// IP BANリスト（Firebaseをリアルタイム購読してローカルにキャッシュ）
// ------------------------------------------------------------
const bannedIpSet = new Set();
onValue(ref(db, 'bannedIps'), (snap) => {
    bannedIpSet.clear();
    const val = snap.val() || {};
    Object.values(val).forEach((entry) => {
        if (entry && entry.ip) bannedIpSet.add(entry.ip);
    });
});

// ------------------------------------------------------------
// Express アプリ
// ------------------------------------------------------------
const app = express();
app.set('trust proxy', true); // Render等のリバースプロキシ配下で正しい req.ip を取得する
app.use(express.json({ limit: '20mb' })); // ファイル読み込みログでPDF等をBase64送信するため上限を拡大

// --- IP BAN ミドルウェア（全リクエストに適用） ---
app.use((req, res, next) => {
    if (bannedIpSet.has(req.ip)) {
        res.status(403).send('このIPアドレスはアクセスを禁止されています。');
        return;
    }
    next();
});

// ============================================================
// 公開API
// ============================================================

// 部屋の確保・入室時にクライアントが呼び出し、サーバー側で正確に取得した
// IPアドレスを部屋のmetaおよびip_historyに記録する。
app.post('/api/record-ip', async (req, res) => {
    const { roomId, discordName, event } = req.body || {};
    if (!isValidRoomId(roomId)) {
        return res.status(400).json({ error: 'invalid room' });
    }
    const ip = req.ip;
    try {
        await set(ref(db, `rooms/${roomId}/meta/ip`), ip);
        await push(ref(db, 'ip_history'), {
            roomId: String(roomId),
            discordName: discordName || null,
            ip,
            event: event === 'login' ? 'login' : 'created',
            ts: Date.now(),
        });
        res.json({ ok: true });
    } catch (e) {
        console.error('record-ip error:', e.message);
        res.status(500).json({ error: 'internal error' });
    }
});

// Web画面側の操作（部屋作成・部屋削除・ファイル読み込み）をDiscordの
// ログチャンネルへ通知する。Discord Botが起動していない場合は何もしない。
app.post('/api/log', async (req, res) => {
    const { type, roomId, discordName, filename, content, contentType } = req.body || {};

    let bot;
    if (process.env.DISCORD_TOKEN) {
        try {
            bot = require('./discord-bot'); // 既に起動済みならNodeのrequireキャッシュから同じインスタンスが返る
        } catch (e) {
            console.error('discord-bot モジュールの取得に失敗しました:', e.message);
        }
    }
    if (!bot || !bot.sendRawLog) {
        return res.json({ ok: false, skipped: 'bot not running' });
    }

    const roomText = roomId ? roomLabel(roomId) : '(不明な部屋)';
    const who = discordName || '(未記録)';
    let text;
    let files;

    if (type === 'room-created') {
        text = `🆕 **部屋作成**\n部屋: ${roomText}\n作成者(Discord): ${who}`;
    } else if (type === 'room-deleted') {
        text = `🗑️ **部屋削除**\n部屋: ${roomText}\n利用者(Discord): ${who}`;
    } else if (type === 'file-loaded') {
        text = `📄 **ファイル読み込み**\n部屋: ${roomText}\n実行者(Discord): ${who}\nファイル名: ${filename || '不明'}`;
        if (typeof content === 'string' && content.length > 0) {
            const buffer = contentType === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8');
            files = [{ attachment: buffer, name: filename || 'file.dat' }];
        }
    } else {
        return res.status(400).json({ error: 'invalid type' });
    }

    try {
        await bot.sendRawLog(text, files);
        res.json({ ok: true });
    } catch (e) {
        console.error('log送信エラー:', e.message);
        res.status(500).json({ error: 'internal error' });
    }
});

// ============================================================
// Groq プロキシ（APIキーをクライアントへ渡さないため。キュー処理＋429バックオフ）
// ============================================================
const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'groq/compound-mini';
const GROQ_MAX_RETRIES = 4;

// 直列キュー: 一度に1リクエストずつGroqへ送ることで、こちら側からのバースト
// による429（レートリミット）をそもそも起きにくくする。
let groqQueueTail = Promise.resolve();
function enqueueGroq(task) {
    const run = groqQueueTail.then(task, task);
    // 失敗してもキューを止めないようにcatchしておく
    groqQueueTail = run.then(
        () => {},
        () => {}
    );
    return run;
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function callGroq(messages, attempt = 0) {
    const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            temperature: 0.4,
            max_completion_tokens: 4096,
            compound_custom: { tools: { enabled_tools: [] } },
        }),
    });

    if (res.status === 429 && attempt < GROQ_MAX_RETRIES) {
        const retryAfterHeader = res.headers.get('retry-after');
        const delayMs = retryAfterHeader
            ? Math.round(parseFloat(retryAfterHeader) * 1000)
            : Math.min(1000 * 2 ** attempt, 15000); // 1s,2s,4s,8s...上限15s
        console.warn(`Groq 429エラーを受信。${delayMs}ms待機してリトライします (試行${attempt + 1}/${GROQ_MAX_RETRIES})`);
        await sleep(delayMs);
        return callGroq(messages, attempt + 1);
    }

    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
}

app.post('/api/groq', async (req, res) => {
    const { messages } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messagesが不正です。' });
    }
    try {
        const result = await enqueueGroq(() => callGroq(messages));
        if (!result.ok) {
            const msg = (result.data && result.data.error && result.data.error.message) || `HTTPエラー ${result.status}`;
            return res.status(result.status || 500).json({ error: msg });
        }
        res.json(result.data);
    } catch (e) {
        console.error('groq proxy error:', e.message);
        res.status(500).json({ error: '通信エラーが発生しました: ' + e.message });
    }
});

// ------------------------------------------------------------
// 静的ファイル配信（index.html等）
// ------------------------------------------------------------
app.use(express.static(path.join(__dirname)));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

// ------------------------------------------------------------
// 予期しないエラーが「無言でプロセスを止める／何も表示しない」ことがないよう、
// トップレベルで必ずログに出す。
// ------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
    console.error('未処理のPromiseエラー(unhandledRejection):', reason);
});
process.on('uncaughtException', (err) => {
    console.error('未処理の例外(uncaughtException):', err);
});

// ------------------------------------------------------------
// Discord Bot も同じプロセス内で起動する（Renderのサービスを1つにまとめるため）。
// ------------------------------------------------------------
console.log(`DISCORD_TOKEN の設定状況: ${process.env.DISCORD_TOKEN ? '設定あり(' + process.env.DISCORD_TOKEN.length + '文字)' : '未設定'}`);
if (process.env.DISCORD_TOKEN) {
    try {
        require('./discord-bot');
    } catch (e) {
        console.error('discord-bot.js の読み込み中にエラーが発生しました:', e);
    }
} else {
    console.warn('DISCORD_TOKEN が未設定のため、Discord Botは起動しませんでした。');
}
