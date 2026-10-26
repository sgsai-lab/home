import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function listFiles(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)))
    .sort();
}

test('build publishes only public files, preserves assets, and works outside the repository cwd', async (context) => {
  const workingDirectory = await mkdtemp(path.join(tmpdir(), 'sgsai-build-'));
  context.after(() => rm(workingDirectory, { recursive: true, force: true }));

  await execute(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: workingDirectory });

  const source = path.join(root, 'public');
  const output = path.join(root, 'dist');
  const sourceFiles = await listFiles(source);
  const outputFiles = await listFiles(output);
  assert.deepEqual(outputFiles, sourceFiles);
  assert.ok(outputFiles.includes('index.html'));
  assert.ok(outputFiles.includes('assets/js/app.js'));
  assert.ok(outputFiles.includes('assets/css/global.css'));
  assert.ok(!outputFiles.some((filename) => /(^|\/)(src|config|infra|docs|test|scripts)\//.test(filename)));
  assert.ok(!outputFiles.some((filename) => filename.endsWith('.mjs') || filename === 'package.json'));

  for (const filename of sourceFiles.filter((filename) => !/\.(html|css|js)$/.test(filename))) {
    assert.deepEqual(
      await readFile(path.join(output, filename)),
      await readFile(path.join(source, filename)),
      `${filename} must be copied without modification`
    );
  }

  const { stdout } = await execute(process.execPath, [path.join(root, 'scripts/check-links.mjs'), output], {
    cwd: workingDirectory
  });
  assert.match(stdout, /Checked local links/);
});
async function publicRoutes() {
  const source = path.join(root, 'public');
  const routes = { indexed: ['/'], hidden: [] };
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let html;
    try {
      html = await readFile(path.join(source, entry.name, 'index.html'), 'utf8');
    } catch {
      continue;
    }
    routes[/<meta name="robots" content="noindex">/.test(html) ? 'hidden' : 'indexed'].push(`/${entry.name}/`);
  }
  return { indexed: routes.indexed.sort(), hidden: routes.hidden.sort() };
}

test('sitemap, robots, analytics allowlists and Lighthouse cover exactly the indexable routes', async () => {
  const { indexed, hidden } = await publicRoutes();
  const sitemap = [...(await readFile(path.join(root, 'public/sitemap.xml'), 'utf8')).matchAll(/<loc>https:\/\/www\.sgsaitechnology\.com([^<]*)<\/loc>/g)].map((match) => match[1]).sort();
  assert.deepEqual(sitemap, indexed, 'public/sitemap.xml');

  const { ANALYTICS_PATHS } = await import('../src/server/server.mjs');
  assert.deepEqual([...ANALYTICS_PATHS].sort(), indexed, 'ANALYTICS_PATHS in src/server/server.mjs');
  const app = await readFile(path.join(root, 'public/assets/js/app.js'), 'utf8');
  const declaration = app.match(/const ANALYTICS_PATHS = new Set\((\[[^\]]+\])\)/);
  assert.ok(declaration, 'ANALYTICS_PATHS declaration not found in public/assets/js/app.js');
  const browserPaths = [...declaration[1].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]).sort();
  assert.deepEqual(browserPaths, indexed, 'ANALYTICS_PATHS in public/assets/js/app.js');

  const lighthouse = JSON.parse(await readFile(path.join(root, 'lighthouserc.json'), 'utf8')).ci.collect.url.map((url) => new URL(url).pathname).sort();
  assert.deepEqual(lighthouse, indexed, 'lighthouserc.json');

  const robots = await readFile(path.join(root, 'public/robots.txt'), 'utf8');
  for (const route of hidden) assert.match(robots, new RegExp(`^Disallow: ${route}$`, 'm'), `robots.txt must disallow ${route}`);
});

test('the build stamps one content-hash asset version and leaves no placeholder behind', async () => {
  await execute(process.execPath, [path.join(root, 'scripts/build.mjs')]);
  const html = await readFile(path.join(root, 'dist/about/index.html'), 'utf8');
  const versions = new Set([...html.matchAll(/\?v=([a-z0-9]+)/g)].map((match) => match[1]));
  assert.equal(versions.size, 1);
  assert.match([...versions][0], /^[0-9a-f]{10}$/);
  const app = await readFile(path.join(root, 'dist/assets/js/app.js'), 'utf8');
  assert.ok(app.includes([...versions][0]), 'app.js fragments use the same version as the pages');
  for (const file of await listFiles(path.join(root, 'dist'))) {
    if (/\.(html|css|js)$/.test(file)) assert.ok(!(await readFile(path.join(root, 'dist', file), 'utf8')).includes('__ASSET_VERSION__'), file);
  }
});
