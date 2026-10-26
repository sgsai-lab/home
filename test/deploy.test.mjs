import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

function deployPaths(workflow) {
  const block = workflow.match(/^ {4}paths:\n((?: {6}- .+\n)+)/m);
  assert.ok(block, 'deploy.yml push trigger must declare a paths list');
  return block[1].trim().split('\n').map((line) => line.replace(/^\s*-\s*/, '').trim());
}

function isCovered(file, patterns) {
  return patterns.some((pattern) => pattern === file ||
    (pattern.endsWith('/**') && (file === pattern.slice(0, -3) || file.startsWith(pattern.slice(0, -2)))));
}

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
