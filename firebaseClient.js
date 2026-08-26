/**
 * firebaseClient.js
 * ------------------------------------------------------------
 * server.js と discord-bot.js の両方から使う共通のFirebase初期化。
 * index.html と同じ「クライアント用 Firebase SDK」(firebase/app, firebase/database)
 * を使い、同じ公開用 firebaseConfig で接続する（サービスアカウント鍵は使わない）。
 * これにより、Bot側での書き込みが index.html 側の既存のリアルタイムリスナーへ
 * そのまま反映される（Web画面への即時自動反映）。
 * ------------------------------------------------------------
 */

const { initializeApp } = require('firebase/app');
const {
    getDatabase,
    ref,
    get,
    set,
    update,
    remove,
    push,
    onValue,
} = require('firebase/database');

// index.html 内の firebaseConfig と同じ値（公開情報。秘密鍵ではない）
const firebaseConfig = {
    apiKey: 'AIzaSyAtC9JwmDhKQ5U75BgtmEmRlxxvyqOxxdU',
    authDomain: 'train-73ddb.firebaseapp.com',
    databaseURL: 'https://train-73ddb-default-rtdb.firebaseio.com',
    projectId: 'train-73ddb',
    storageBucket: 'train-73ddb.firebasestorage.app',
    messagingSenderId: '95255440333',
    appId: '1:95255440333:web:af0ea55d2ee53773e23284',
};

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

module.exports = { db, ref, get, set, update, remove, push, onValue };
