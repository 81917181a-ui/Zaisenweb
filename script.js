// 1. データの保存処理
function saveRoute() {
    const name = document.getElementById('route-name').value;
    const stations = document.getElementById('station-list').value.split(',');
    
    const routeData = { name, stations, trains: [] }; // 電車データもここに入れる
    localStorage.setItem('route_' + name, JSON.stringify(routeData));
    alert('保存完了');
}

// 2. 路線図の描画処理
function renderRoute(route) {
    const display = document.getElementById('route-display');
    display.innerHTML = ''; // 一度リセット
    route.stations.forEach(station => {
        display.innerHTML += `<div class="station">${station}</div>`;
    });
}

// 3. 電車アイコンのクリック処理（詳細表示）
function showTrainDetail(trainId) {
    const popup = document.getElementById('popup');
    popup.classList.remove('hidden');
    // ここでクリックされた電車の詳細（時刻表など）をHTMLに流し込む
}

function closePopup() {
    document.getElementById('popup').classList.add('hidden');
}
