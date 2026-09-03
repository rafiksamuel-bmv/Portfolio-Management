/* A very small PDF writer.
 *
 * Lives outside api/ deliberately: anything in api/ becomes an endpoint.
 *
 * PDF is a text format, so a document can be assembled by hand the same way
 * the Excel export is. What it does not give you is a layout engine -- no line
 * breaking, no pagination, no flow -- so this supplies those: character widths
 * for the two standard fonts, a wrapper, and a cursor that starts a new page
 * when it runs out of room. That is the whole trick; everything else is
 * rectangles and text at coordinates.
 *
 * Only Helvetica and Helvetica-Bold are used. Both are among the 14 standard
 * fonts every reader ships, so nothing has to be embedded.
 */

/* Widths in 1/1000 em for characters 32..126, from the Adobe metrics. */
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,
  667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  278,278,278,469,556,333,
  556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,
  334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,
  556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,
  722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,
  333,278,333,584,556,333,
  556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,
  389,280,389,584];

/* The document is ASCII only, so nothing depends on the reader's encoding. */
const SUBS = [
  [/[‘’‛]/g, "'"], [/[“”]/g, '"'],
  [/[–—]/g, '-'], [/…/g, '...'], [/·/g, '-'],
  [/✓/g, '+'], [/▸/g, '>'], [/≥/g, '>='], [/ /g, ' '],
];
export function ascii(s) {
  let t = String(s == null ? '' : s);
  for (const [re, to] of SUBS) t = t.replace(re, to);
  return t.replace(/[^\x20-\x7E\n]/g, '');
}

function widthOf(text, bold, size) {
  const W = bold ? W_BOLD : W_REG;
  let n = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i) - 32;
    n += (c >= 0 && c < W.length) ? W[c] : 556;
  }
  return n * size / 1000;
}

/** Greedy wrap. Splits a word that cannot fit on a line of its own. */
export function wrap(text, bold, size, maxWidth) {
  const out = [];
  for (const para of ascii(text).split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      const next = line ? line + ' ' + word : word;
      if (widthOf(next, bold, size) <= maxWidth) { line = next; continue; }
      if (line) out.push(line);
      if (widthOf(word, bold, size) <= maxWidth) { line = word; continue; }
      let chunk = '';
      for (const ch of word) {
        if (widthOf(chunk + ch, bold, size) > maxWidth) { out.push(chunk); chunk = ch; }
        else chunk += ch;
      }
      line = chunk;
    }
    if (line) out.push(line);
  }
  return out;
}

const esc = s => ascii(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
const hex2rgb = h => {
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
};
const f2 = n => (Math.round(n * 100) / 100).toString();

/**
 * A page cursor. Width and height are points; A4 is 595.28 x 841.89.
 * y counts down from the top, which is the opposite of PDF's own axis, so
 * every draw converts. Callers never see PDF coordinates.
 */
export class Doc {
  constructor(opts = {}) {
    this.w = opts.width || 595.28;
    this.h = opts.height || 841.89;
    this.margin = opts.margin || 44;
    this.bg = opts.background || null;
    this.pages = [];
    this.ops = [];
    this.y = this.margin;
    this._startPage();
  }
  get innerWidth() { return this.w - this.margin * 2; }

  _startPage() {
    this.ops = [];
    if (this.bg) this.rect(0, 0, this.w, this.h, this.bg, { absolute: true });
    this.y = this.margin;
  }
  _endPage() { this.pages.push(this.ops.join('\n')); }
  newPage() { this._endPage(); this._startPage(); }
  /** Start a new page when less than `need` points remain. */
  room(need) {
    if (this.y + need > this.h - this.margin) { this.newPage(); return true; }
    return false;
  }
  space(n) { this.y += n; }

  rect(x, yTop, w, h, colour, opts = {}) {
    const [r, g, b] = hex2rgb(colour);
    const y = this.h - (opts.absolute ? yTop : yTop) - h;
    this.ops.push(`${f2(r)} ${f2(g)} ${f2(b)} rg`,
                  `${f2(x)} ${f2(y)} ${f2(w)} ${f2(h)} re f`);
  }

  /** One line of text at an explicit x, without moving the cursor. */
  textAt(text, x, yTop, opts = {}) {
    const size = opts.size || 10, bold = !!opts.bold;
    const [r, g, b] = hex2rgb(opts.colour || '#000000');
    const y = this.h - yTop - size;
    this.ops.push('BT', `/${bold ? 'FB' : 'FR'} ${size} Tf`,
                  `${f2(r)} ${f2(g)} ${f2(b)} rg`,
                  `${f2(x)} ${f2(y)} Td`, `(${esc(text)}) Tj`, 'ET');
  }
  /** Right-aligned at x. */
  textRight(text, x, yTop, opts = {}) {
    this.textAt(text, x - widthOf(ascii(text), !!opts.bold, opts.size || 10), yTop, opts);
  }

  /**
   * Wrapped paragraph from the cursor, which moves past it. Breaks across
   * pages a line at a time rather than orphaning the whole block.
   */
  para(text, opts = {}) {
    const size = opts.size || 10, bold = !!opts.bold;
    const lead = opts.leading || size * 1.42;
    const x = this.margin + (opts.indent || 0);
    const width = (opts.width || this.innerWidth) - (opts.indent || 0);
    for (const line of wrap(text, bold, size, width)) {
      this.room(lead);
      if (line) this.textAt(line, x, this.y, { size, bold, colour: opts.colour });
      this.y += lead;
    }
    if (opts.after) this.y += opts.after;
  }

  rule(colour, opts = {}) {
    this.room(6);
    this.rect(this.margin + (opts.indent || 0), this.y,
              this.innerWidth - (opts.indent || 0), opts.thickness || 0.6, colour);
    this.y += (opts.thickness || 0.6) + (opts.after || 0);
  }

  /** Rounded corners are not worth the curve operators here; a flat chip reads fine. */
  chip(text, yTop, xRight, fg, bg, size = 7.5) {
    const padX = 6, h = size + 7;
    const w = widthOf(ascii(text), true, size) + padX * 2;
    this.rect(xRight - w, yTop, w, h, bg);
    this.textAt(text, xRight - w + padX, yTop + 3.5, { size, bold: true, colour: fg });
    return w;
  }

  toBuffer(footer) {
    this._endPage();
    if (footer) {
      this.pages = this.pages.map((ops, i) => {
        const save = { ops: this.ops, y: this.y };
        this.ops = [];
        footer(this, i + 1, this.pages.length);
        const extra = this.ops.join('\n');
        this.ops = save.ops; this.y = save.y;
        return ops + '\n' + extra;
      });
    }
    const objs = [];
    const add = body => { objs.push(body); return objs.length; };

    const pageIds = [];
    const contentIds = this.pages.map(c =>
      add(`<< /Length ${Buffer.byteLength(c, 'latin1')} >>\nstream\n${c}\nendstream`));
    const fontR = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    const fontB = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pagesId = objs.length + this.pages.length + 1;
    contentIds.forEach(cid => pageIds.push(add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${f2(this.w)} ${f2(this.h)}] `
      + `/Resources << /Font << /FR ${fontR} 0 R /FB ${fontB} 0 R >> >> /Contents ${cid} 0 R >>`)));
    const realPages = add(`<< /Type /Pages /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] `
      + `/Count ${pageIds.length} >>`);
    const catalog = add(`<< /Type /Catalog /Pages ${realPages} 0 R >>`);

    let out = '%PDF-1.4\n';
    const offsets = [0];
    objs.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objs.length; i++)
      out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}
