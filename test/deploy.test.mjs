import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (filename) => readFile(path.join(root, filename), 'utf8');

function deployPaths(workflow) {
  // Tolerate any indentation, quoted patterns, and trailing comments.
  const block = workflow.match(/^( +)paths:[ \t]*(?:#.*)?\n((?:\1 +(?:#.*|- .+)\n|[ \t]*\n)+)/m);
  assert.ok(block, 'deploy.yml push trigger must declare a block-style paths list (one "- pattern" per line)');
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

async function deployWith(values = {}) {
  const workflow = await read('.github/workflows/deploy.yml');
  const step = workflow.split('      - name: Deploy to Cloud Run\n')[1];
  assert.ok(step, 'expected Cloud Run deployment step');
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '');
  const result = spawnSync('bash', ['-c', `gcloud() { printf '%s\\n' "$@"; }\n${script}`], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, GCP_PROJECT_ID: 'test-project', GCP_REGION: 'asia-south1',
      GCP_RUNTIME_SERVICE_ACCOUNT: 'runtime@test-project.iam.gserviceaccount.com', IMAGE: 'test-image',
      SMTP_USER_SECRET: '', SMTP_PASS_SECRET: '', ...values }
  });
  if (result.error) throw result.error;
  return result;
}

const workerConfig = {
  GITHUB_CRM_WORKER_AUDIENCE: 'https://sgsaitechnology.com',
  GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'crm-worker@test-project.iam.gserviceaccount.com'
};
const githubConfig = {
  CRM_GITHUB_ENABLED: 'true', GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY_SECRET: 'crm-app-key', GITHUB_WEBHOOK_SECRET_SECRET: 'crm-webhook',
  ...workerConfig
};

test('CRM deployment defaults fail closed without GitHub secret mounts', async () => {
  const result = await deployWith();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CRM_INVOICE_ISSUANCE_ENABLED=false/);
  assert.match(result.stdout, /CRM_INVOICE_VOID_ALLOWED=false/);
  assert.match(result.stdout, /--clear-secrets/);
  assert.doesNotMatch(result.stdout, /GITHUB_APP_PRIVATE_KEY=|GITHUB_WEBHOOK_SECRET=|GITHUB_APP_ID=/);
});

test('disabling GitHub removes its mounts while preserving other configured secrets', async () => {
  const result = await deployWith({
    ...githubConfig, CRM_GITHUB_ENABLED: 'false',
    SMTP_USER_SECRET: 'smtp-user', SMTP_PASS_SECRET: 'smtp-pass',
    MFA_ENCRYPTION_KEY_SECRET: 'mfa-key', APPLE_STATE_SECRET_SECRET: 'apple-state'
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SMTP_USER=smtp-user:latest,SMTP_PASS=smtp-pass:latest/);
  assert.match(result.stdout, /MFA_ENCRYPTION_KEY=mfa-key:latest/);
  assert.match(result.stdout, /APPLE_STATE_SECRET=apple-state:latest/);
  assert.doesNotMatch(result.stdout, /GITHUB_APP_ID=|GITHUB_APP_PRIVATE_KEY=|GITHUB_WEBHOOK_SECRET=/);
});

test('activation inputs are wired from repository variables into the deployment step', async () => {
  const workflow = await read('.github/workflows/deploy.yml');
  const inputs = {
    CRM_GITHUB_ENABLED: 'CRM_GITHUB_ENABLED',
    GITHUB_APP_ID: 'CRM_GITHUB_APP_ID',
    GITHUB_APP_PRIVATE_KEY_SECRET: 'CRM_GITHUB_APP_PRIVATE_KEY_SECRET',
    GITHUB_WEBHOOK_SECRET_SECRET: 'CRM_GITHUB_WEBHOOK_SECRET',
    GITHUB_CRM_WORKER_AUDIENCE: 'CRM_WORKER_AUDIENCE',
    GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'CRM_WORKER_SERVICE_ACCOUNT',
    CRM_INVOICE_ISSUANCE_ENABLED: 'CRM_INVOICE_ISSUANCE_ENABLED',
    CRM_INVOICE_APPROVAL_REFERENCE: 'CRM_INVOICE_APPROVAL_REFERENCE'
  };
  for (const [name, variable] of Object.entries(inputs)) {
    assert.ok(workflow.includes(`${name}: \${{ vars.${variable} }}`), `${name} must be available to deployment validation`);
    assert.ok(!variable.startsWith('GITHUB_'), 'GitHub reserves this configuration-variable prefix');
  }
});

test('CRM deployment enables GitHub only with complete App and worker configuration', async () => {
  const result = await deployWith(githubConfig);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /GITHUB_APP_ID=12345/);
  assert.match(result.stdout, /GITHUB_APP_PRIVATE_KEY=crm-app-key:latest/);
  assert.match(result.stdout, /GITHUB_WEBHOOK_SECRET=crm-webhook:latest/);
  assert.match(result.stdout, /GITHUB_CRM_WORKER_AUDIENCE=https:\/\/sgsaitechnology.com/);
  for (const field of Object.keys(githubConfig).filter((key) => key !== 'CRM_GITHUB_ENABLED')) {
    const invalid = await deployWith({ ...githubConfig, [field]: '' });
    assert.notEqual(invalid.status, 0, `${field} must be required`);
    assert.equal(invalid.stdout, '', 'must fail before invoking gcloud');
  }
});

test('invoice deployment requires explicit approval and service recovery configuration', async () => {
  const base = { CRM_INVOICE_ISSUANCE_ENABLED: 'true', ...workerConfig };
  assert.notEqual((await deployWith(base)).status, 0);
  const approved = { ...base, CRM_INVOICE_APPROVAL_REFERENCE: 'approved-review-reference' };
  const result = await deployWith(approved);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CRM_INVOICE_ISSUANCE_ENABLED=true/);
  assert.match(result.stdout, /CRM_INVOICE_VOID_ALLOWED=false/);
  assert.doesNotMatch(result.stdout, /CRM_INVOICE_APPROVAL_REFERENCE=/, 'review reference is a deployment prerequisite, not client/runtime data');
  assert.notEqual((await deployWith({ ...approved, GITHUB_CRM_WORKER_AUDIENCE: '' })).status, 0);
});

test('CRM deployment rejects malformed flags and configuration before rollout', async () => {
  for (const values of [
    { CRM_GITHUB_ENABLED: 'yes' }, { CRM_INVOICE_ISSUANCE_ENABLED: '1' },
    { ...githubConfig, GITHUB_APP_ID: 'not-numeric' },
    { ...githubConfig, GITHUB_APP_PRIVATE_KEY_SECRET: 'name,OTHER=secret' },
    { ...workerConfig, GITHUB_CRM_WORKER_SERVICE_ACCOUNT: '' },
    { ...workerConfig, GITHUB_CRM_WORKER_AUDIENCE: 'http://worker.test' },
    { ...workerConfig, GITHUB_CRM_WORKER_SERVICE_ACCOUNT: 'not-a-service-account' },
    { ...workerConfig, GITHUB_CRM_WORKER_AUDIENCE: 'https://worker.test|OTHER=value' },
    { ...workerConfig, CRM_INVOICE_ISSUANCE_ENABLED: 'true', CRM_INVOICE_APPROVAL_REFERENCE: '   ' }
  ]) {
    const result = await deployWith(values);
    assert.notEqual(result.status, 0, JSON.stringify(values));
    assert.equal(result.stdout, '');
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

  // Every COPY source: builder outputs (/app/<path>) and direct context copies.
  // dist/ and node_modules/ are generated; "." is the builder's full context.
  const shipped = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
    .flatMap((match) => {
      const args = match[1].trim().split(/\s+/).filter((arg) => !arg.startsWith('--'));
      const fromBuilder = /--from=builder\b/.test(match[1]);
      return args.slice(0, -1).map((source) =>
        (fromBuilder ? source.replace(/^\/app\//, '') : source).replace(/^\.\//, '').replace(/\/$/, ''));
    })
    .filter((source) => !['dist', 'node_modules', '.'].includes(source));
  assert.ok(shipped.length > 0, 'expected COPY lines in the Dockerfile');

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
