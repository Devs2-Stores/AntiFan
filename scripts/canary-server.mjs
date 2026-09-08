import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const port = 20139;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`
    <!DOCTYPE html>
    <html>
      <head><title>Offline Canary Probe</title></head>
      <body>
        <h1>AntiFan Zero Network Gate Canary</h1>
      </body>
    </html>
  `);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Canary HTTP server ready at http://127.0.0.1:${port}`);
});
