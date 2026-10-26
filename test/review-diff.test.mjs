import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPrompt, chunkDiff, combineReviews, extractReview, parseDiff } from '../scripts/review-diff.mjs';

const fileDiff = (name, count, { start = 1 } = {}) => [
  `diff --git a/${name} b/${name}`,
  'index 1111111..2222222 100644',
  `--- a/${name}`,
  `+++ b/${name}`,
  `@@ -${start},0 +${start},${count} @@ export function demo() {`,
  ...Array.from({ length: count }, (_, index) => `+const line${index} = ${index};`),
  ''
].join('\n');

const bytes = (text) => Buffer.byteLength(text, 'utf8');

test('review diff: small diffs stay in one part with lockfiles and binaries omitted', () => {
  const diff = fileDiff('src/a.mjs', 3) +
    fileDiff('package-lock.json', 3) +
    'diff --git a/public/logo.png b/public/logo.png\nindex 1..2 100644\nBinary files a/public/logo.png and b/public/logo.png differ\n';
  const { parts, files, omitted } = chunkDiff(diff);
  assert.equal(parts.length, 1);
  assert.deepEqual(files, ['src/a.mjs', 'package-lock.json', 'public/logo.png']);
  assert.deepEqual(omitted.map((file) => file.reason), ['generated lockfile', 'binary content']);
  assert.match(parts[0], /\+\+\+ b\/src\/a\.mjs/);
  assert.doesNotMatch(parts[0], /package-lock|logo\.png/);
});

test('review diff: large diffs split into parts under the byte limit with exact hunk headers', () => {
  const diff = fileDiff('src/small.mjs', 10) + fileDiff('src/big.mjs', 400, { start: 50 });
  const { parts } = chunkDiff(diff, { maxBytes: 4000 });
  assert.ok(parts.length > 2);
  for (const part of parts) {
    assert.ok(bytes(part) <= 4000);
    assert.match(part, /^diff --git /);
  }
  const big = parts.flatMap((part) => parseDiff(part)).filter((file) => file.path === 'src/big.mjs');
  assert.ok(big.length > 1, 'the big file spans several parts');
  let expected = 50;
  for (const file of big) {
    for (const hunk of file.hunks) {
      const [, newStart, newCount] = hunk[0].match(/\+(\d+),(\d+) @@/);
      assert.equal(Number(newStart), expected);
      assert.equal(Number(newCount), hunk.length - 1);
      assert.equal(hunk[1], `+const line${expected - 50} = ${expected - 50};`);
      expected += Number(newCount);
    }
  }
  assert.equal(expected, 450);
});

test('review diff: too many parts fail explicitly', () => {
  assert.throws(() => chunkDiff(fileDiff('src/big.mjs', 400), { maxBytes: 2000, maxParts: 2 }), /Split the PR/);
});

test('review diff: prompts label parts and enforce the prompt limit', () => {
  const prompt = buildPrompt({
    guide: 'guide', part: 'diff', index: 1, total: 3, files: ['a', 'b'],
    omitted: [{ path: 'package-lock.json', reason: 'generated lockfile' }], repo: 'o/r', number: 7, sha: 'abc'
  });
  assert.match(prompt, /part 2 of 3/);
  assert.match(prompt, /package-lock\.json \(generated lockfile\)/);
  assert.match(prompt, /below 16000 characters/);
  assert.throws(() => buildPrompt({
    guide: 'x'.repeat(100001), part: '', index: 0, total: 1, files: [], omitted: [], repo: 'o/r', number: 1, sha: 'a'
  }), /exceeds/);
});

test('review diff: extractReview requires a successful, non-empty result', () => {
  const event = (value) => JSON.stringify(value);
  assert.equal(extractReview([
    event({ type: 'assistant.message', data: { content: '## Findings' } }),
    event({ type: 'result', exitCode: 0 })
  ].join('\n')), '## Findings');
  assert.throws(() => extractReview(event({ type: 'result', exitCode: 1 })), /exit code 1/);
  assert.throws(() => extractReview(event({ type: 'result', exitCode: 0 })), /empty/);
});

const review = (findings, verification) =>
  `## Findings\n\n${findings}\n\n## Verification\n\n${verification}\n\n## Limitations\n\nDiff-only.`;

test('review diff: combined reviews sort findings, dedupe checks, and keep fenced headings', () => {
  const combined = combineReviews([
    review('### Low: a.mjs:1\n\n**Fix:**\n```md\n## Not a heading\n### Not a finding\n```', '1. Run `npm test`.'),
    review('No actionable findings in the supplied diff.', '- Run `npm test`.\n- Open /login/.'),
    review('### High: b.mjs:2\n\n**Fix:**\n```js\nfix();\n```', '- Open /login/.')
  ], { omitted: [{ path: 'package-lock.json', reason: 'generated lockfile' }] });
  const findings = combined.split('## Verification')[0];
  assert.ok(findings.indexOf('### High: b.mjs:2') < findings.indexOf('### Low: a.mjs:1'));
  assert.match(findings, /```md\n## Not a heading\n### Not a finding\n```/);
  assert.doesNotMatch(findings, /No actionable findings/);
  assert.equal(combined.match(/Run `npm test`/g).length, 1);
  assert.equal(combined.match(/Open \/login\//g).length, 1);
  assert.match(combined, /reviewed in 3 separate parts/);
  assert.match(combined, /Not reviewed: `package-lock\.json` \(generated lockfile\)/);
  for (const heading of ['## Findings', '## Verification', '## Limitations']) {
    assert.ok(combined.split('\n').includes(heading));
  }
});

test('review diff: clean parts and size limits are reported, malformed parts fail', () => {
  assert.match(combineReviews([review('No actionable findings in the supplied diff.', '- Check.')]),
    /## Findings\n\nNo actionable findings in the supplied diff\./);
  const many = Array.from({ length: 20 }, (_, index) => `### Low: a.mjs:${index + 1}\n\n${'x'.repeat(500)}`).join('\n\n');
  const trimmed = combineReviews([review(`### High: b.mjs:1\n\nkeep\n\n${many}`, '- Check.')], { maxBytes: 4000 });
  assert.ok(bytes(trimmed) <= 4000);
  assert.match(trimmed, /### High: b\.mjs:1/);
  assert.match(trimmed, /lower-severity finding\(s\) were omitted/);
  assert.throws(() => combineReviews(['## Findings\n\nnone']), /missing the required heading: ## Verification/);
});
