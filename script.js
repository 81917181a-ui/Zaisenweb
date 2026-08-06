// 路線データの読み込み処理例
function loadRouteData() {
    const data = localStorage.getItem('savedRoute');
    return data ? JSON.parse(data) : null;
}

// 電車を路線上に表示する関数
function renderTrains(trains) {
    trains.forEach(train => {
        const stationEl = document.getElementById(train.currentStation);
        // 駅の要素に電車アイコンを追加する処理などをここに書く
        console.log(`${train.name} が ${train.currentStation} にいます`);
    });
}
