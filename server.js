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
 * ------------------------------------------------------------
 */

const path = require('path');
const express = require('express');
const { db, ref, get, set, push, onValue } = require('./firebaseClient');
const { isValidRoomId } = require('./roomUtils');

if (!process.env.GROQ_API_KEY) {
    console.error('環境変数 GROQ_API_KEY が設定されていません。');
    process.exit(1);
}

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
app.use(express.json());

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
