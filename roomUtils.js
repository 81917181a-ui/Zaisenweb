/**
 * roomUtils.js
 * ------------------------------------------------------------
 * 部屋定義・表記変換など、server.js と discord-bot.js で共通の処理。
 * ------------------------------------------------------------
 */

const NORMAL_ROOM_IDS = ['1', '2', '3', '4', '5'];
const VIP_ROOM_IDS = ['vip1', 'vip2'];
const ALL_ROOM_IDS = [...NORMAL_ROOM_IDS, ...VIP_ROOM_IDS];
const ROOM_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000; // 部屋の初期有効期限（最長2週間）

function isValidRoomId(id) {
    return ALL_ROOM_IDS.includes(String(id));
}

function roomLabel(roomId) {
    roomId = String(roomId);
    if (roomId === 'vip1') return 'VIP1';
    if (roomId === 'vip2') return 'VIP2';
    return '部屋' + roomId;
}

// 「部屋1」「部屋 1」「VIP1」「vip1」のような表記ゆれをroomIdへ変換する
function parseRoomName(input) {
    if (!input) return null;
    const s = String(input).trim();
    const vipMatch = s.match(/^vip\s*([12])$/i);
    if (vipMatch) return 'vip' + vipMatch[1];
    const normalMatch = s.match(/^部屋\s*([1-5])$/) || s.match(/^([1-5])$/);
    if (normalMatch) return normalMatch[1];
    return null;
}

// 「10min」「2h」「1d」のような表記をミリ秒へ変換する
function parseDuration(input) {
    if (!input) return null;
    const m = String(input).trim().match(/^(\d+)\s*(min|h|d)$/i);
    if (!m) return null;
    const value = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    if (unit === 'min') return value * 60 * 1000;
    if (unit === 'h') return value * 60 * 60 * 1000;
    if (unit === 'd') return value * 24 * 60 * 60 * 1000;
    return null;
}

function getRoomExpiresAt(meta) {
    if (!meta) return null;
    if (meta.expiresAt) return meta.expiresAt;
    if (meta.createdAt) return meta.createdAt + ROOM_EXPIRY_MS;
    return null;
}

// RTDBのキーには . # $ [ ] / が使えないため、IPアドレスをキー化する
function ipToKey(ip) {
    return String(ip).replace(/[.#$[\]/:]/g, '_');
}

// usernames索引のキー化（index.html側の sanitizeUsernameKey と同じロジック）
function sanitizeUsernameKey(name) {
    return String(name).trim().toLowerCase().replace(/[.#$[\]/]/g, '_');
}

module.exports = {
    NORMAL_ROOM_IDS,
    VIP_ROOM_IDS,
    ALL_ROOM_IDS,
    ROOM_EXPIRY_MS,
    isValidRoomId,
    roomLabel,
    parseRoomName,
    parseDuration,
    getRoomExpiresAt,
    ipToKey,
    sanitizeUsernameKey,
};
