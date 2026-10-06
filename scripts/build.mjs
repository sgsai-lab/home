import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJs } from 'terser';

const root = process.cwd();
const output = path.join(root, 'dist');
const files = [
  'index.html', '404.html', 'styles.css', 'pages.css', 'script.js', 'products.js',
  'favicon.svg', 'favicon.ico', 'favicon-192.png', 'favicon-512.png', 'apple-touch-icon.png', 'og-image.jpg',
  'site.webmanifest', 'robots.txt', 'sitemap.xml',
  'vision', 'products', 'roadmap', 'about', 'contact', 'privacy', 'terms', 'logo'
];
const pages = {
  '/index.html': 'HOME',
  '/vision/index.html': 'VISION',
  '/products/index.html': 'PRODUCTS',
  '/roadmap/index.html': 'ROADMAP',
  '/about/index.html': 'ABOUT',
  '/contact/index.html': 'CONTACT',
  '/privacy/index.html': 'PRIVACY',
  '/terms/index.html': 'TERMS'
};

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of files) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

const headerTemplate = await readFile(path.join(root, 'partials/site-header.html'), 'utf8');
const footerTemplate = await readFile(path.join(root, 'partials/site-footer.html'), 'utf8');

async function injectPartials(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await injectPartials(filename);
      continue;
    }
    if (!entry.name.endsWith('.html')) continue;

    const relativePage = `/${path.relative(output, filename)}`;
    const activePage = pages[relativePage];
    const activeAttributes = Object.fromEntries(
      ['HOME', 'VISION', 'PRODUCTS', 'ROADMAP', 'ABOUT', 'CONTACT', 'PRIVACY', 'TERMS']
        .map((page) => [`ACTIVE_${page}`, activePage === page ? ' aria-current="page"' : ''])
    );
    const header = headerTemplate.replace(/\{\{(ACTIVE_[A-Z]+)\}\}/g, (_, key) => activeAttributes[key] ?? '');
    const footer = footerTemplate.replace(/\{\{(ACTIVE_[A-Z]+)\}\}/g, (_, key) => activeAttributes[key] ?? '');
    let html = await readFile(filename, 'utf8');
    if (!/<header\b[\s\S]*?<\/header>/.test(html) || !/<footer\b[\s\S]*?<\/footer>/.test(html)) {
      throw new Error(`Missing shared header or footer in ${relativePage}`);
    }
    html = html.replace(/<header\b[\s\S]*?<\/header>/, header.trim());
    html = html.replace(/<footer\b[\s\S]*?<\/footer>/, footer.trim());
    html = html.replace(
      '<meta name="twitter:card" content="summary">',
      '<meta name="twitter:card" content="summary_large_image"><meta name="twitter:image" content="https://sgsaitechnology.com/og-image.jpg">'
    );
    await writeFile(filename, html);
  }
}

await injectPartials(output);

async function minifyTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await minifyTree(filename);
      continue;
    }
    const source = await readFile(filename, 'utf8');
    if (filename.endsWith('.html')) {
      await writeFile(filename, await minifyHtml(source, {
        collapseWhitespace: true,
        removeComments: true,
        minifyCSS: true,
        minifyJS: true
      }));
    } else if (filename.endsWith('.css')) {
      const result = new CleanCSS({ level: 1 }).minify(source);
      if (result.errors.length) throw new Error(`${filename}: ${result.errors.join('; ')}`);
      await writeFile(filename, result.styles);
    } else if (filename.endsWith('.js')) {
      const result = await minifyJs(source, { compress: true, mangle: true });
      if (!result.code) throw new Error(`Unable to minify ${filename}`);
      await writeFile(filename, result.code);
    }
  }
}

await minifyTree(output);
console.log(`Built minified site in ${output}`);