import PDFDocument from 'pdfkit';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { openSync } from 'fontkit';
import { HttpError } from './http.mjs';

const require = createRequire(import.meta.url);
const fontPath = require.resolve('@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff');
const font = openSync(fontPath);
const amount = (minor) => `INR ${(minor / 100).toFixed(2)}`;

export function validateDocumentText(values) {
  for (const value of values) {
    if ([...String(value ?? '')].some((character) => !/\s/.test(character) && !font.hasGlyphForCodePoint(character.codePointAt(0)))) {
      throw new HttpError(422, 'UNSUPPORTED_DOCUMENT_TEXT', 'The invoice font currently supports Latin-script legal details. Supply reviewed Latin-script text before issuing; unsupported characters will not be silently lost.');
    }
  }
}

export async function renderInvoicePdf(invoice) {
  validateDocumentText([...Object.values(invoice.profile_snapshot).filter((value) => typeof value === 'string'), invoice.project_name, ...invoice.lines.map((line) => line.description)]);
  const doc = new PDFDocument({ size: 'A4', margin: 48, info: { Title: `Invoice ${invoice.number}`, CreationDate: new Date(`${invoice.issue_date}T00:00:00Z`), ModDate: new Date(`${invoice.issue_date}T00:00:00Z`) } });
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
  });
  doc.font(fontPath).fontSize(20).text(invoice.document_title ?? 'TAX INVOICE');
  doc.fontSize(11).text(invoice.number).text(`Issue: ${invoice.issue_date} | Due: ${invoice.due_date}`).moveDown();
  if (invoice.original_number) doc.text(`Corrects invoice: ${invoice.original_number}`).moveDown();
  const profile = invoice.profile_snapshot;
  doc.text(profile.issuer_name).text(profile.issuer_address).text(`GSTIN: ${profile.issuer_gstin}`).moveDown();
  doc.text(`Bill to: ${profile.customer_name}`).text(profile.customer_address);
  doc.text(`Customer GSTIN: ${profile.customer_gstin || 'Unregistered'} | Place of supply: ${profile.customer_state_code}`).moveDown();
  doc.text(`Project: ${invoice.project_name} | SAC: ${profile.sac_code} | GST rate: ${profile.gst_rate_bps / 100}%`).moveDown();
  for (const line of invoice.lines) {
    if (doc.y > 690) doc.addPage();
    doc.text(line.description, { width: 490 });
    doc.text(`${line.minutes ? `${line.minutes} minutes | ` : ''}${amount(line.amount_minor)}`, { align: 'right' }).moveDown(0.5);
  }
  if (doc.y > 590) doc.addPage();
  doc.moveDown().text(`Net: ${amount(invoice.net_minor)}`, { align: 'right' });
  const tax = invoice.tax_components;
  for (const [label, value] of [['CGST', tax.cgst_minor], ['SGST', tax.sgst_minor], ['IGST', tax.igst_minor]]) {
    if (value) doc.text(`${label}: ${amount(value)}`, { align: 'right' });
  }
  doc.text(`Total: ${amount(invoice.total_minor)}`, { align: 'right' }).moveDown();
  if (invoice.original_number) doc.text('This credit note reduces the referenced invoice balance; it is not a payment demand.');
  else doc.text('Payment terms: 30 days after invoice issue.').text(profile.bank_details);
  doc.text('Issued electronically by the supplier. No automatic late fees apply.').end();
  const buffer = await done;
  return { buffer, checksum: createHash('sha256').update(buffer).digest('hex') };
}
