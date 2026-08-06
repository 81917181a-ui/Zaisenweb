const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
    // ルート( / )にアクセスされたら index.html を返す
    let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);

    fs.readFile(filePath, (err, content) => {
        if (err) {
            res.writeHead(404);
            res.end('Not Found');
        } else {
            res.writeHead(200);
            res.end(content);
        }
    });
}).listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
