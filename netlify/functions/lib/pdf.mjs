/**
 * A very small PDF writer. Text only, Helvetica, A4.
 *
 * Deliberately dependency-free. The collab site has no package.json and
 * adding one would put an `npm install` in front of a build that currently
 * has none, for the sake of one text document a week. Base-14 Helvetica is
 * built into every PDF reader, so nothing needs to be embedded.
 *
 * Latin-1 only — the base-14 encoding cannot carry anything else. Typographic
 * punctuation is folded to ASCII on the way in and anything still outside
 * Latin-1 becomes '?'. A name in a non-Latin script will not survive; the
 * email body and the Notion row both carry it intact, so the PDF is not the
 * only record.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 56;
const WIDTH = PAGE_W - MARGIN * 2;

// Helvetica averages a little under half the point size per character.
const CHAR_W = 0.5;

// Built from its code point rather than written out. A non-breaking space
// does not survive being carried through tooling — as a literal or as an
// escape it arrives as an ordinary space, leaving a rule that replaces a
// space with a space.
const NBSP = String.fromCharCode(160);

const FOLD = [
  [/[‘’‚′]/g, "'"],
  [/[“”„″]/g, '"'],
  [/[–—―]/g, '-'],
  [/[•·]/g, '-'],
  [/…/g, '...'],
  [new RegExp(NBSP, 'g'), ' '],
];

function fold(s) {
  let out = String(s == null ? '' : s);
  for (const [re, to] of FOLD) out = out.replace(re, to);
  // Anything still outside Latin-1 cannot be encoded by the base font.
  return out.replace(/[^\x00-\xFF]/g, '?');
}

const escape = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function wrap(textRaw, size) {
  const max = Math.max(8, Math.floor(WIDTH / (size * CHAR_W)));
  const out = [];
  for (const para of String(textRaw).split(/\r?\n/)) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line.length) {
        line = word;
      } else if ((line + ' ' + word).length <= max) {
        line += ' ' + word;
      } else {
        out.push(line);
        line = word;
      }
      while (line.length > max) {
        out.push(line.slice(0, max));
        line = line.slice(max);
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * blocks: [{ text, size, bold, before, after }]
 * Returns a Buffer.
 */
export function buildPdf(blocks) {
  const pages = [];
  let stream = '';
  let y = PAGE_H - MARGIN;

  const newPage = () => {
    pages.push(stream);
    stream = '';
    y = PAGE_H - MARGIN;
  };

  for (const b of blocks) {
    const size = b.size || 10;
    const font = b.bold ? '/F2' : '/F1';
    const leading = size * 1.45;
    y -= b.before || 0;

    if (b.rule) {
      if (y < MARGIN) newPage();
      stream += `0.75 w 0.69 0.67 0.65 RG ${MARGIN} ${y.toFixed(2)} m ${(PAGE_W - MARGIN).toFixed(2)} ${y.toFixed(2)} l S\n`;
      y -= b.after || 0;
      continue;
    }

    for (const line of wrap(fold(b.text), size)) {
      if (y < MARGIN) newPage();
      if (line.length) {
        stream += `BT ${font} ${size} Tf 0 0 0 rg 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escape(line)}) Tj ET\n`;
      }
      y -= leading;
    }
    y -= b.after || 0;
  }
  pages.push(stream);

  /* ---------- assemble ---------- */

  const objects = [];
  const push = (body) => { objects.push(body); return objects.length; };

  const fontRegular = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const fontBold = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');

  const pagesId = objects.length + 1 + pages.length * 2;
  const pageIds = [];

  for (const content of pages) {
    const bytes = Buffer.byteLength(content, 'latin1');
    const contentId = push(`<< /Length ${bytes} >>\nstream\n${content}endstream`);
    pageIds.push(push(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> ` +
      `/Contents ${contentId} 0 R >>`,
    ));
  }

  const realPagesId = push(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] >>`);
  const catalogId = push(`<< /Type /Catalog /Pages ${realPagesId} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
