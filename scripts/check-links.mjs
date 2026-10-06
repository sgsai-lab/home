import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htmlFiles = [];

async function collectHtml(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'partials' || entry.name.startsWith('.')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectHtml(filename);
    else if (entry.name.endsWith('.html')) htmlFiles.push(filename);
  }
}

function resolveTarget(source, href) {
  const url = new URL(href, `https://local.invalid${source === '/' ? '/' : source}`);
  if (url.origin !== 'https://local.invalid') return null;
  if (url.pathname === '/api/contact') return { api: true, fragment: url.hash.slice(1) };
  const pathname = decodeURIComponent(url.pathname);
  const candidate = path.resolve(root, `.${pathname}`);
  if (!candidate.startsWith(`${root}${path.sep}`) && candidate !== path.join(root, 'index.html')) return null;
  return {
    file: pathname.endsWith('/') ? path.join(candidate, 'index.html') : candidate,
    fragment: url.hash.slice(1)
  };
}

await collectHtml(root);
const errors = [];
for (const filename of htmlFiles) {
  const sourcePath = `/${path.relative(root, filename)}`;
  const html = await readFile(filename, 'utf8');
  for (const match of html.matchAll(/<(?:a|link|script|img|form)\b[^>]*?\b(?:href|src|action)=["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(href)) continue;
    const target = resolveTarget(sourcePath, href);
    if (!target) continue;
    if (!target.api) {
      try {
        await access(target.file);
      } catch {
        errors.push(`${sourcePath}: missing local target ${href}`);
        continue;
      }
      if (target.fragment && target.file.endsWith('.html')) {
        const targetHtml = await readFile(target.file, 'utf8');
        const targetIds = new Set([...targetHtml.matchAll(/\bid=["']([^"']+)["']/g)].map((item) => item[1]));
        if (!targetIds.has(decodeURIComponent(target.fragment))) errors.push(`${sourcePath}: missing fragment target ${href}`);
      }
    }
  }
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked local links in ${htmlFiles.length} HTML documents.`);
}