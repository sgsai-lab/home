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