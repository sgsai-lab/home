import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

function deployPaths(workflow) {
  // Tolerate any indentation, quoted patterns, and trailing comments.
  const block = workflow.match(/^( +)paths:[ \t]*(?:#.*)?\n((?:\1 +(?:#.*|- .+)\n)+)/m);
  assert.ok(block, 'deploy.yml push trigger must declare a paths list');
  return block[2].split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2'));
}

function isCovered(file, patterns) {
  return patterns.some((pattern) => pattern === file ||
    (pattern.endsWith('/**') && (file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2)))));
}

test('deploy path filter uses only patterns this guard can evaluate', async () => {
  for (const pattern of deployPaths(await read('.github/workflows/deploy.yml'))) {
    assert.ok(!pattern.startsWith('!') && !/[*?[\]{}]/.test(pattern.replace(/\/\*\*$/, '')),
      `unsupported deploy path pattern "${pattern}": use exact paths or a trailing /**, or extend isCovered()`);
  }
});

test('deploy path filter covers every input of the production image', async () => {
  const [workflow, dockerfile, packageJson, buildScript] = await Promise.all([
    read('.github/workflows/deploy.yml'),
    read('Dockerfile'),
    read('package.json'),
    read('scripts/build.mjs')
  ]);
  const patterns = deployPaths(workflow);

  // Files copied from the builder into the final image; dist/ and node_modules/ are generated.
  const shipped = [...dockerfile.matchAll(/^COPY --from=builder \/app\/(\S+?)\/? /gm)]
    .map((match) => match[1])
    .filter((source) => !['dist', 'node_modules'].includes(source));
  assert.ok(shipped.length > 0, 'expected COPY --from=builder lines in the Dockerfile');

  const buildCommand = JSON.parse(packageJson).scripts.build;
  const buildEntry = buildCommand.match(/^node (\S+)$/)?.[1];
  assert.ok(buildEntry, `unexpected build script "${buildCommand}"; update this test and deploy paths`);
  const buildSource = buildScript.match(/path\.join\(root, '([^']+)'\)/)?.[1];
  assert.equal(buildSource, 'public', 'build source directory changed; update deploy paths');
  const localImports = [...buildScript.matchAll(/\bfrom\s+['"](\.{1,2}\/[^'"]+)['"]|\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]/g)]
    .map((match) => match[1] ?? match[2]);
  assert.deepEqual(localImports, [],
    `${buildEntry} imports local modules; add them to deploy paths and to this test`);

  const required = [
    ...shipped,
    buildEntry,
    buildSource,
    'package.json',
    'package-lock.json',
    'Dockerfile',
    '.dockerignore',
    '.github/workflows/deploy.yml'
  ];
  for (const file of required) {
    assert.ok(isCovered(file, patterns),
      `${file} is a production image input but is missing from deploy.yml on.push.paths`);
  }
});
