const dns = require('dns');
if (dns.setDefaultResultOrder) { dns.setDefaultResultOrder('ipv4first'); }

// 【追加対応】setDefaultResultOrderだけでは効かない場合があるため、
// dns.lookup自体をIPv4専用(family:4)へ強制的に上書きする。
// これはNode標準のhttp/https/net/tlsを使うモジュールすべてに効くため、
// REST（undici）とWebSocketゲートウェイ接続（wsパッケージ）の両方に対して有効。
const originalDnsLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') {
        callback = options;
        options = {};
    }
    return originalDnsLookup.call(dns, hostname, { ...options, family: 4 }, callback);
};

/**
 * discord-bot.js
 * ------------------------------------------------------------
 * 列車管理システム 管理用Discord Bot
 *
 * 必要な環境変数は DISCORD_TOKEN のみ（GROQ_API_KEYはserver.js側で使用）。
 * サーバーAPIを経由せず、firebaseClient.js経由で直接Firebaseを読み書きする。
 *
 * 【対応済みの既知の問題】
 * Render等のコンテナ環境では、discord.js内部（undici/RESTモジュール、および
 * ゲートウェイ接続に使われるwsモジュール）がIPv6アドレスを優先して接続を試み、
 * そのままハングすることがある。上記のdns.lookupの上書きに加え、REST側には
 * undiciのAgentでconnect.family:4を明示的に渡し、二重に対策している。
 * ------------------------------------------------------------
 */

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { Agent: UndiciAgent } = require('undici');
const { db, ref, get, set, update, remove, push } = require('./firebaseClient');
const {
    roomLabel,
    parseRoomName,
    parseDuration,
    getRoomExpiresAt,
    ipToKey,
    sanitizeUsernameKey,
    ALL_ROOM_IDS,
} = require('./roomUtils');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

// ↓固定値（変更したい場合はここを直接書き換えてください。秘密情報ではありません）
// 【改修】対象サーバー(GUILD_ID)・対象チャンネル(ALLOWED_CHANNEL_ID)による制限は削除しました。
// Botが参加しているどのサーバー・どのチャンネルからでもコマンドを実行できます。
// （ロールIDによる実行権限チェックのみ残しています）
const REQUIRED_ROLE_ID = '1510405214811852900'; // このロールを持つメンバーのみコマンド実行可
const LOG_CHANNEL_ID = '1526289865719943329'; // 変更内容の通知先チャンネル

if (!DISCORD_TOKEN) {
    console.error('環境変数 DISCORD_TOKEN が設定されていません。');
    process.exit(1);
}

const MUTATING_COMMANDS = ['!expand', '!leave', '!ipban', '!unipban'];
const ALL_COMMANDS = [...MUTATING_COMMANDS, '!ips', '!ipbanlist', '!roompassword'];

console.log('discord-bot.js を読み込みました。Discordクライアントを初期化します...');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
    ],
    partials: [Partials.Channel],
    rest: {
        // REST(undici)側でも明示的にIPv4を強制する（dns.lookup上書きと二重の対策）
        agent: new UndiciAgent({
            connect: { family: 4 },
        }),
    },
});

client.on('error', (err) => {
    console.error('Discordクライアントでエラーが発生しました:', err);
});
client.on('shardError', (err) => {
    console.error('Discordゲートウェイ接続でエラーが発生しました:', err);
});
client.on('warn', (msg) => {
    console.warn('Discord警告:', msg);
});

// 【一時的なデバッグ用】WebSocket接続の詳細をすべて出力する。
// 原因が判明したら、ログが膨大になるためこのブロックは削除して構わない。
client.on('debug', (msg) => {
    console.log('[discord.js debug]', msg);
});

// Discordのユーザーネーム/表示名から、部屋のdiscordNameと合致するメンバーを探す
async function findMemberByName(guild, name) {
    if (!name) return null;
    const target = String(name).trim().toLowerCase();
    const members = await guild.members.fetch();
    return (
        members.find(
            (m) =>
                m.user.username.toLowerCase() === target ||
                (m.nickname && m.nickname.toLowerCase() === target) ||
                (m.displayName && m.displayName.toLowerCase() === target)
        ) || null
    );
}

// Discordログチャンネルへ任意のテキスト（＋任意でファイル添付）を送信する汎用関数。
// サーバー側(server.js)からWeb操作のログを送る際にもこの関数を使う。
async function sendRawLog(text, files) {
    try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased()) return;
        await logChannel.send(files && files.length ? { content: text, files } : { content: text });
    } catch (e) {
        console.error('ログ送信に失敗しました:', e.message);
    }
}

// Botコマンドの変更内容をログチャンネルへ通知する（guild引数は使用していないため廃止）
async function sendLog({ command, detail, executor }) {
    await sendRawLog(
        [`🛠️ **コマンド実行**: \`${command}\``, `**変更内容**: ${detail}`, `**実行者**: ${executor}`].join('\n')
    );
}

client.once('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith('!')) return;
    const args = message.content.trim().split(/\s+/);
    const cmd = args[0].toLowerCase();
    if (!ALL_COMMANDS.includes(cmd)) return;

    // --- ロール制限（権限がない場合は無視） ---
    const member = message.member;
    if (!member || !member.roles.cache.has(REQUIRED_ROLE_ID)) {
        return;
    }

    const executor = `${member.toString()} (${message.author.tag})`;
    const guild = message.guild;

    try {
        if (cmd === '!expand') {
            const [, roomInput, durationInput] = args;
            if (!roomInput || !durationInput) {
                return message.reply('使い方: `!expand (部屋) (時間)`　例: `!expand VIP1 1d`');
            }
            const roomId = parseRoomName(roomInput);
            const durationMs = parseDuration(durationInput);
            if (!roomId) return message.reply(`不明な部屋名です: ${roomInput}`);
            if (!durationMs) return message.reply(`時間指定が不正です: ${durationInput}`);

            const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
            const meta = metaSnap.val();
            if (!meta) return message.reply(`${roomLabel(roomId)} は現在空室です。`);

            const base = Math.max(getRoomExpiresAt(meta) || Date.now(), Date.now());
            const newExpiresAt = base + durationMs;
            await update(ref(db, `rooms/${roomId}/meta`), { expiresAt: newExpiresAt });

            const newDateStr = new Date(newExpiresAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
            await message.reply(`✅ ${roomLabel(roomId)} の有効期限を延長しました。\n新しい有効期限: ${newDateStr}`);
            await sendLog({
                command: '!expand',
                detail: `${roomLabel(roomId)} の有効期限を ${durationInput} 延長 → 新しい有効期限: ${newDateStr}`,
                executor,
            });
            return;
        }

        if (cmd === '!leave') {
            const roomInput = args[1];
            const reason = args.slice(2).join(' ') || '(理由なし)';
            if (!roomInput) {
                return message.reply('使い方: `!leave (部屋) (理由)`　例: `!leave 部屋1 悪用`');
            }
            const roomId = parseRoomName(roomInput);
            if (!roomId) return message.reply(`不明な部屋名です: ${roomInput}`);

            const metaSnap = await get(ref(db, `rooms/${roomId}/meta`));
            const meta = metaSnap.val();
            if (!meta) return message.reply(`${roomLabel(roomId)} は現在空室です。`);

            const updates = {};
            updates[`rooms/${roomId}`] = null;
            if (meta.discordName) {
                updates[`usernames/${sanitizeUsernameKey(meta.discordName)}`] = null;
            }
            await update(ref(db), updates);
            await push(ref(db, 'ip_history'), {
                roomId: String(roomId),
                discordName: meta.discordName || null,
                ip: meta.ip || null,
                event: 'evicted',
                reason,
                ts: Date.now(),
            });
            // ※在室中クライアントへの反映は既存のFirebase realtimeリスナー
            //   （rooms/{roomId} が null になったことを検知）により自動的に行われる。

            let resultLines = [`✅ ${roomLabel(roomId)} を解散しました。`];
            let dmResult = '(送信対象なし)';

            if (meta.discordName) {
                const targetMember = await findMemberByName(guild, meta.discordName);
                if (targetMember) {
                    try {
                        await targetMember.send(
                            `【強制退去のお知らせ】\n列車管理システムの ${roomLabel(roomId)} について、以下の理由により部屋を解散させていただきました。\n\n理由: ${reason}`
                        );
                        resultLines.push(`📩 ${meta.discordName} さんへDMを送信しました。`);
                        dmResult = `${meta.discordName} へDM送信成功`;
                    } catch (dmErr) {
                        resultLines.push(`⚠️ ${meta.discordName} さんはDM受信を許可していないため、DM送信に失敗しました。`);
                        dmResult = `${meta.discordName} へDM送信失敗`;
                    }
                } else {
                    resultLines.push(
                        `⚠️ Discordユーザー「${meta.discordName}」はサーバー内で見つかりませんでした。` +
                            (meta.ip ? `\n記録されているIPアドレス: \`${meta.ip}\`` : '\n記録されているIPアドレスもありません。')
                    );
                    dmResult = `${meta.discordName} が見つからず(記録IP: ${meta.ip || '不明'})`;
                }
            } else {
                resultLines.push('⚠️ この部屋には作成者情報が記録されていませんでした。');
            }

            await message.reply(resultLines.join('\n'));
            await sendLog({
                command: '!leave',
                detail: `${roomLabel(roomId)} を強制解散（理由: ${reason}） / ${dmResult}`,
                executor,
            });
            return;
        }

        if (cmd === '!ips') {
            const roomsSnap = await get(ref(db, 'rooms'));
            const activeRooms = roomsSnap.val() || {};
            const activeLines = Object.entries(activeRooms)
                .filter(([, room]) => room && room.meta && room.meta.discordName)
                .map(([roomId, room]) => `・${roomLabel(roomId)}: ${room.meta.discordName} / IP: ${room.meta.ip || '不明'}`);

            const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
            const historySnap = await get(ref(db, 'ip_history'));
            const historyVal = historySnap.val() || {};
            const historyLines = Object.values(historyVal)
                .filter((h) => h && h.ts >= thirtyDaysAgo)
                .sort((a, b) => b.ts - a.ts)
                .slice(0, 30)
                .map(
                    (h) =>
                        `・[${new Date(h.ts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}] ${roomLabel(h.roomId)} (${h.event}) ${
                            h.discordName || '-'
                        } / IP: ${h.ip || '不明'}`
                );

            const parts = [
                '**■ 現在利用中の部屋**',
                activeLines.length ? activeLines.join('\n') : '(現在利用中の部屋はありません)',
                '**■ 過去30日の履歴（最新30件）**',
                historyLines.length ? historyLines.join('\n') : '(履歴はありません)',
            ];
            return message.reply(parts.join('\n').slice(0, 1900));
        }

        if (cmd === '!ipban') {
            const ip = args[1];
            if (!ip) return message.reply('使い方: `!ipban (IP)`　例: `!ipban 192.168.1.100`');
            await set(ref(db, `bannedIps/${ipToKey(ip)}`), {
                ip,
                bannedAt: Date.now(),
                bannedBy: message.author.tag,
            });
            await message.reply(`🚫 IPアドレス \`${ip}\` をBANしました。`);
            await sendLog({ command: '!ipban', detail: `IPアドレス \`${ip}\` をBAN`, executor });
            return;
        }

        if (cmd === '!unipban') {
            const ip = args[1];
            if (!ip) return message.reply('使い方: `!unipban (IP)`　例: `!unipban 192.168.1.100`');
            await remove(ref(db, `bannedIps/${ipToKey(ip)}`));
            await message.reply(`✅ IPアドレス \`${ip}\` のBANを解除しました。`);
            await sendLog({ command: '!unipban', detail: `IPアドレス \`${ip}\` のBANを解除`, executor });
            return;
        }

        if (cmd === '!ipbanlist') {
            const snap = await get(ref(db, 'bannedIps'));
            const val = snap.val() || {};
            const list = Object.values(val).sort((a, b) => b.bannedAt - a.bannedAt);
            if (!list.length) return message.reply('現在BANされているIPアドレスはありません。');
            const lines = list.map(
                (e) =>
                    `・\`${e.ip}\` (BAN日時: ${new Date(e.bannedAt).toLocaleString('ja-JP', {
                        timeZone: 'Asia/Tokyo',
                    })}${e.bannedBy ? ` / by ${e.bannedBy}` : ''})`
            );
            return message.reply(['**■ IP BANリスト**', ...lines].join('\n').slice(0, 1900));
        }

        if (cmd === '!roompassword') {
            const roomsSnap = await get(ref(db, 'rooms'));
            const roomsVal = roomsSnap.val() || {};
            const lines = ALL_ROOM_IDS.map((roomId) => {
                const room = roomsVal[roomId];
                if (!room || !room.meta) {
                    return `・${roomLabel(roomId)}: 空室`;
                }
                const meta = room.meta;
                return (
                    `・${roomLabel(roomId)}: ${meta.discordName || '(名前未記録)'}\n` +
                    `　　管理者PW: \`${meta.adminPassword || '(未設定)'}\` / 利用者PW: \`${meta.userPassword || '(未設定)'}\``
                );
            });
            return message.reply(['**■ 全部屋のパスワード一覧**', ...lines].join('\n').slice(0, 1900));
        }
    } catch (e) {
        console.error(e);
        return message.reply(`❌ エラー: ${e.message}`);
    }
});

console.log('Discordへログインを試みます...');
client.login(DISCORD_TOKEN)
    .then(() => console.log('client.login() の呼び出しに成功しました（ゲートウェイ接続待ち）。'))
    .catch((err) => {
        console.error('Discordへのログインに失敗しました。DISCORD_TOKENの値、およびDeveloper PortalのIntent設定を確認してください。');
        console.error(err);
    });

// server.js からWeb操作のログ送信に使えるよう、clientとsendRawLogを公開する。
module.exports = { client, sendRawLog };
