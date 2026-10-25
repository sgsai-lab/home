import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import CleanCSS from 'clean-css';
import { minify as minifyHtml } from 'html-minifier-terser';
import { minify as minifyJs } from 'terser';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'public');
const output = path.join(root, 'dist');

await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true });

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