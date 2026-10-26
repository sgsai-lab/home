import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const config = await readFile(new URL('../config/nginx.conf', import.meta.url), 'utf8');

function locationBlocks(text) {
  const blocks = [];
  const pattern = /location\s+[^{]+\{/g;
  let match;
  while ((match = pattern.exec(text))) {
    let depth = 1;
    let index = pattern.lastIndex;
    while (depth && index < text.length) {
      if (text[index] === '{') depth += 1;
      if (text[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ head: match[0], body: text.slice(pattern.lastIndex, index - 1) });
  }
  return blocks;
}

test('no location uses add_header, which would drop the server-level security headers', () => {
  const offenders = locationBlocks(config).filter((block) => /^\s*add_header\s/m.test(block.body)).map((block) => block.head.trim());
  assert.deepEqual(offenders, []);
});

test('every non-v1 API path and launch link has a proxy location', () => {
  for (const path of ['= /api/contact', '= /api/config', '= /api/analytics', '= /api/readyz', '^~ /api/v1/', '^~ /go/']) {
    assert.ok(locationBlocks(config).some((block) => block.head.includes(path) && /proxy_pass/.test(block.body)), `missing proxied location ${path}`);
  }
});

test('the CSP allows only self plus the reviewed identity and storage origins', () => {
  const csp = config.match(/Content-Security-Policy "([^"]+)"/)[1];
  const origins = [...new Set(csp.match(/https:\/\/[^\s;]+/g))].sort();
  assert.deepEqual(origins, [
    'https://*.googleusercontent.com',
    'https://accounts.google.com/gsi/',
    'https://accounts.google.com/gsi/client',
    'https://accounts.google.com/gsi/style',
    'https://appleid.apple.com',
    'https://appleid.cdn-apple.com',
    'https://storage.googleapis.com'
  ]);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
});
