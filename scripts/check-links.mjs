import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(repoRoot, 'public');
const root = process.argv[2]
  ? path.resolve(process.argv[2])
  : sourceRoot;
const pageFiles = [];

async function collectPages(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'components' || entry.name === 'sections' || entry.name.startsWith('.')) continue;
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

// --- Content Security Policy guard -----------------------------------------------------
// Production serves the CSP from config/nginx.conf; anything it would block is a lint error here,
// because `npm run preview` and Lighthouse run without Nginx and would not show the violation.
function parseCsp(nginxConfig) {
  const policy = nginxConfig.match(/Content-Security-Policy "([^"]+)"/)?.[1];
  if (!policy) throw new Error('config/nginx.conf has no Content-Security-Policy header.');
  return new Map(policy.split(';').map((part) => part.trim().split(/\s+/)).filter((tokens) => tokens[0]).map(([name, ...sources]) => [name, sources]));
}

function allowedBy(csp, directive, url) {
  const sources = csp.get(directive) ?? csp.get('default-src') ?? [];
  return sources.some((source) => {
    if (!source.startsWith('https://')) return false;
    const [host, ...rest] = source.slice(8).split('/');
    const prefix = rest.length ? `/${rest.join('/')}` : '/';
    const hostMatches = host.startsWith('*.') ? url.hostname.endsWith(host.slice(1)) : url.hostname === host;
    return url.protocol === 'https:' && hostMatches && url.pathname.startsWith(prefix);
  });
}

async function collectFiles(directory, extensions, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(filename, extensions, found);
    else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(filename);
  }
  return found;
}

const DIRECTIVE_BY_TAG = { script: 'script-src', img: 'img-src', iframe: 'frame-src', video: 'media-src', audio: 'media-src', source: 'media-src' };

async function checkPolicy(errors) {
  const csp = parseCsp(await readFile(path.join(repoRoot, 'config/nginx.conf'), 'utf8'));
  for (const filename of await collectFiles(root, ['.html'])) {
    const where = `/${path.relative(root, filename)}`;
    const html = await readFile(filename, 'utf8');
    if (/\sstyle=["']/i.test(html)) errors.add(`${where}: inline style attributes are blocked by the CSP; use a class`);
    if (/\son[a-z]+=["']/i.test(html)) errors.add(`${where}: inline event handlers are blocked by the CSP; use an external script`);
    if (/<style[\s>]/i.test(html)) errors.add(`${where}: <style> blocks are blocked by the CSP; use a stylesheet`);
    for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
      if (!/\bsrc=/i.test(match[1]) && !/type=["']application\/ld\+json["']/i.test(match[1]) && match[2].trim()) {
        errors.add(`${where}: inline scripts are blocked by the CSP; use an external script`);
      }
    }
    for (const match of html.matchAll(/<(script|link|img|iframe|video|audio|source)\b([^>]*?)\b(src|href)=(["'])(https?:\/\/[^"']+)\4([^>]*)>/gi)) {
      const [, tag, before, , , href, after] = match;
      const attributes = `${before} ${after}`;
      let directive = DIRECTIVE_BY_TAG[tag.toLowerCase()];
      if (tag.toLowerCase() === 'link') {
        const rel = attributes.match(/\brel=["']([^"']+)["']/i)?.[1] ?? '';
        if (/stylesheet/.test(rel) || /as=["']style["']/i.test(attributes)) directive = 'style-src';
        else if (/as=["']font["']/i.test(attributes)) directive = 'font-src';
        else if (/as=["']script["']/i.test(attributes)) directive = 'script-src';
        else if (/preconnect|dns-prefetch/.test(rel)) directive = 'connect-src';
        else continue;
      }
      if (!allowedBy(csp, directive, new URL(href))) errors.add(`${where}: ${href} is blocked by the CSP (${directive}); self-host it or update config/nginx.conf`);
    }
  }
  for (const filename of await collectFiles(root, ['.css'])) {
    const css = await readFile(filename, 'utf8');
    for (const match of css.matchAll(/(?:url\(\s*["']?|@import\s+["'])(https?:\/\/[^"')\s]+)/gi)) {
      const directive = /\.(woff2?|ttf|otf)(\?|$)/i.test(match[1]) ? 'font-src' : /@import/i.test(match[0]) ? 'style-src' : 'img-src';
      if (!allowedBy(csp, directive, new URL(match[1]))) errors.add(`/${path.relative(root, filename)}: ${match[1]} is blocked by the CSP (${directive})`);
    }
  }
  if (root === sourceRoot) {
    for (const filename of await collectFiles(root, ['.html', '.js', '.css'])) {
      if (/\?v=\d/.test(await readFile(filename, 'utf8'))) {
        errors.add(`/${path.relative(root, filename)}: use ?v=__ASSET_VERSION__ (stamped by scripts/build.mjs) instead of a literal version`);
      }
    }
  }
}

function resolveTarget(source, href) {
  const url = new URL(href, `https://local.invalid${source}`);
  if (url.origin !== 'https://local.invalid') return null;
  if (url.pathname === '/api/contact' || url.pathname === '/api/analytics') return { api: true };
  return { pathname: url.pathname, fragment: url.hash.slice(1) };
}

await collectPages(root);
const mappings = findComponentMappings(await readFile(path.join(sourceRoot, 'assets/js/app.js'), 'utf8'));
if (!mappings.length) throw new Error('No dynamic components found in the source loader.');
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
    if (/^<a\b/i.test(match[0]) && target.pathname !== '/' && !target.pathname.endsWith('/') && !path.extname(target.pathname)) {
      // Nginx answers slash-less routes with a 301; link to the canonical URL directly.
      errors.add(`${document.sourcePath}: link to ${href} without a trailing slash`);
    }

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

await checkPolicy(errors);

if (errors.size) {
  console.error([...errors].sort().join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Checked local links in ${documents.length} HTML documents and ${mappings.length} dynamically loaded fragments.`);
}