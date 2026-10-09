import { createReadStream } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const contentTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8'
};

const server = createServer(async (request, response) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    response.writeHead(400).end();
    return;
  }
  if (pathname === '/api/analytics' && request.method === 'POST') {
    response.writeHead(204).end();
    return;
  }
  let filename = pathname === '/' ? path.join(root, 'index.html') : path.resolve(root, `.${pathname}`);
  if (!filename.startsWith(`${root}${path.sep}`) && filename !== path.join(root, 'index.html')) {
    response.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
    await access(filename);
  } catch {
    filename = path.join(root, '404.html');
    response.statusCode = 404;
  }
  response.setHeader('Content-Type', contentTypes[path.extname(filename)] || 'application/octet-stream');
  createReadStream(filename).pipe(response);
});

const port = Number(process.env.PORT || 4173);
server.listen(port, '127.0.0.1', () => console.log(`Preview server listening on 127.0.0.1:${port}`));