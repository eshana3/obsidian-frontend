'use strict';
// Minimal static file server for the frontend (no npm dependencies)
const http = require('http');
const path = require('path');
const fs   = require('fs');

const PORT    = parseInt(process.env.FRONTEND_PORT, 10) || 8080;
const ROOT    = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
  '.pdf':  'application/pdf',
};

const server = http.createServer((req, res) => {
  // Strip query string
  let urlPath = req.url.split('?')[0];

  // Block access to the backend folder
  if (urlPath.startsWith('/chatbot-server')) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  // Default to index.html
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(ROOT, urlPath);

  // Security: prevent path traversal outside ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`404 Not Found: ${urlPath}`);
      } else {
        res.writeHead(500); res.end('Server error');
      }
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ┌─────────────────────────────────────────┐');
  console.log('  │  Obsidian Frontend Server               │');
  console.log(`  │  http://localhost:${PORT}                  │`);
  console.log('  │                                         │');
  console.log(`  │  Main app:  http://localhost:${PORT}/        │`);
  console.log(`  │  Chatbot:   http://localhost:${PORT}/chatbot.html │`);
  console.log(`  │  Diagnostics: http://localhost:${PORT}/upload-test.html │`);
  console.log('  └─────────────────────────────────────────┘');
  console.log('');
});
