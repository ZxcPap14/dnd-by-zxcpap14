// serve.mjs — минимальный статический сервер для dist/ (ноль зависимостей).

import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const root = join(process.cwd(), 'dist');
const port = process.env.PORT || 8080;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

createServer((req, res) => {
  let path = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = join(root, path);
  if (!existsSync(file)) {
    res.writeHead(404); res.end('404'); return;
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}).listen(port, () => {
  console.log(`dnd by ZxcPap14 → http://localhost:${port}`);
});
