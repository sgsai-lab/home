import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pageFiles = [];

async function collectPages(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'components' || entry.name === 'sections' || entry.name === 'partials' || entry.name.startsWith('.')) continue;
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectPages(filename);
    else if (entry.name.endsWith('.html')) pageFiles.push(filename);
  }
}

function getIds(html) {
  return new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map((match) => match[1]));
}

function findComponentMappings(appSource) {
  return [...appSource.matchAll(/\{\s*id:\s*'([^']+)',\s*path:\s*'([^']+)',\s*hasCss:\s*(true|false),\s*hasJs:\s*(true|false)\s*\}/g)]
    .map((match) => ({ id: match[1], path: match[2], hasCss: match[3] === 'true', hasJs: match[4] === 'true' }));
}

function safePathname(pathname) {
  const decoded = decodeURIComponent(pathname);
  const filename = path.resolve(root, `.${decoded}`);
  if (!filename.startsWith(`${root}${path.sep}`) && filename !== root && filename !== path.join(root, 'index.html')) return null;
  return { decoded, filename };
}

async function resolvePageFile(pathname) {
  const safe = safePathname(pathname);
  if (!safe) return null;
  const { decoded, filename } = safe;
  const candidates = decoded.endsWith('/')
    ? [path.join(filename, 'index.html')]
    : path.extname(decoded)
      ? [filename]
      : [path.join(filename, 'index.html'), `${filename}.html`];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next route shape supported by Nginx: directory index, then .html.
    }
  }
  return candidates[0];
}

function resolveTarget(source, href) {
  const url = new URL(href, `https://local.invalid${source}`);
  if (url.origin !== 'https://local.invalid') return null;
  if (url.pathname === '/api/contact' || url.pathname === '/api/analytics') return { api: true };
  return { pathname: url.pathname, fragment: url.hash.slice(1) };
}

await collectPages(root);
const mappings = findComponentMappings(await readFile(path.join(root, 'app.js'), 'utf8'));
const mountMap = new Map(mappings.map((component) => [component.id, path.join(root, `${component.path}.html`)]));
const errors = new Set();

for (const component of mappings) {
  for (const [extension, required] of [['html', true], ['css', component.hasCss], ['js', component.hasJs]]) {
    if (!required) continue;
    try {
      await access(path.join(root, `${component.path}.${extension}`));
    } catch {
      errors.add(`app.js: missing dynamic component resource ${component.path}.${extension}`);
    }
  }
}

const documents = [];
for (const filename of pageFiles) {
  const sourcePath = `/${path.relative(root, filename)}`;
  const pageHtml = await readFile(filename, 'utf8');
  let combinedHtml = pageHtml;
  for (const [mountId, fragmentPath] of mountMap) {
    if (!new RegExp(`\\bid=["']${mountId}["']`).test(pageHtml)) continue;
    try {
      combinedHtml += `\n${await readFile(fragmentPath, 'utf8')}`;
    } catch {
      // The missing fragment itself was already reported from the app.js mapping.
    }
  }
  documents.push({ sourcePath, html: combinedHtml, ids: getIds(combinedHtml) });
}

for (const document of documents) {
  for (const match of document.html.matchAll(/<(?:a|link|script|img|form|source|video|audio)\b[^>]*?\b(?:href|src|action|poster)=(["'])(.*?)\1[^>]*>/gi)) {
    const href = match[2].trim();
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|\/\/)/i.test(href)) continue;
    let target;
    try {
      target = resolveTarget(document.sourcePath, href);
    } catch {
      errors.add(`${document.sourcePath}: invalid local target ${href}`);
      continue;
    }
    if (!target || target.api) continue;

    const targetFile = await resolvePageFile(target.pathname);
    if (!targetFile) {
      errors.add(`${document.sourcePath}: unsafe local target ${href}`);
      continue;
    }
    try {
      await access(targetFile);
    } catch {
      errors.add(`${document.sourcePath}: missing local target ${href}`);
      continue;
    }

    if (target.fragment && targetFile.endsWith('.html')) {
      const targetPath = `/${path.relative(root, targetFile)}`;
      const targetDocument = documents.find((candidate) => candidate.sourcePath === targetPath);
      const targetIds = targetDocument?.ids ?? getIds(await readFile(targetFile, 'utf8'));
      if (!targetIds.has(decodeURIComponent(target.fragment))) {
        errors.add(`${document.sourcePath}: missing fragment target ${href}`);
      }
    }
  }
}

if (errors.size) {
  console.error([...errors].sort().join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked local links in ${documents.length} HTML documents and ${mappings.length} dynamically loaded fragments.`);
}