import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJs } from 'terser';

const root = process.cwd();
const output = path.join(root, 'dist');
const files = [
  'index.html', '404.html', 'global.css', 'app.js', 'styles.css', 'pages.css', 'script.js', 'products.js',
  'favicon.svg', 'favicon.ico', 'favicon-192.png', 'favicon-512.png', 'apple-touch-icon.png', 'og-image.jpg',
  'site.webmanifest', 'robots.txt', 'sitemap.xml',
  'assets', 'logo', 'about', 'contact', 'login', 'signup', 'verify-email', 'forgot-password', 'reset-password',
  'account', 'admin', 'projects', 'js', 'vendor', 'account.css', 'privacy', 'products', 'roadmap', 'services', 'terms', 'vision',
  'components', 'sections'
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const entry of files) {
  await cp(path.join(root, entry), path.join(output, entry), { recursive: true });
}

async function minifyTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await minifyTree(filename);
      continue;
    }
    const source = await readFile(filename, 'utf8');
    if (filename.endsWith('.html')) {
      const html = source.replace(
        /<link\b(?=[^>]*\brel=["']stylesheet["'])(?=[^>]*\bhref=["']https?:\/\/)[^>]*>/gi,
        (link) => link
          .replace(/\brel=["']stylesheet["']/i, 'rel="preload" as="style" data-async-stylesheet')
      );
      await writeFile(filename, await minifyHtml(html, {
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