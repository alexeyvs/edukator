import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SystemOcrRunner } from '../server/ocr-runner.js';

const enabled = process.env['EDUKATOR_OCR_SMOKE'] === '1';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe.skipIf(!enabled)('Linux OCR smoke', () => {
  let dir: string;
  let pdf: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'edukator-ocr-smoke-'));
    pdf = join(dir, 'russian-scan.pdf');
    writePbmPdf(join(root, 'tests/fixtures/russian-scan.pbm'), pdf);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('распознаёт маленький русский scan fixture реальными бинарниками', async () => {
    const runner = new SystemOcrRunner({ tempRoot: dir });
    await runner.checkDependencies();
    const page = await runner.processPage({ pdfPath: pdf, pageNumber: 1 });
    expect(page.text).toMatch(/[А-ЯЁ]{3,}/iu);
    expect(page.image.length).toBeGreaterThan(100);
  }, 180_000);
});

/** Wraps the committed 1-bit raster in a one-page PDF without another test dependency. */
function writePbmPdf(pbmPath: string, pdfPath: string): void {
  const tokens = readFileSync(pbmPath, 'utf8')
    .replace(/^#.*$/gmu, '')
    .trim()
    .split(/\s+/u);
  if (tokens[0] !== 'P1') throw new Error('OCR smoke fixture должен быть PBM P1');
  const width = Number(tokens[1]);
  const height = Number(tokens[2]);
  const pixels = tokens.slice(3).join('');
  if (pixels.length !== width * height || /[^01]/u.test(pixels)) throw new Error('Некорректный PBM fixture');
  const stride = Math.ceil(width / 8);
  const image = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const byte = y * stride + Math.floor(x / 8);
      if (pixels[y * width + x] === '1') image[byte] = (image[byte] ?? 0) | (0x80 >> (x % 8));
    }
  }
  const content = Buffer.from('q\n540 0 0 92 30 14 cm\n/Im0 Do\nQ\n');
  const objects = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 120] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>'),
    Buffer.concat([Buffer.from(`<< /Length ${content.length} >>\nstream\n`), content, Buffer.from('endstream')]),
    Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceGray /BitsPerComponent 1 /Decode [1 0] /Length ${image.length} >>\nstream\n`),
      image,
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts = [Buffer.from('%PDF-1.4\n%scan\n')];
  const offsets = [0];
  let offset = parts[0]?.length ?? 0;
  objects.forEach((object, index) => {
    offsets.push(offset);
    const encoded = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), object, Buffer.from('\nendobj\n')]);
    parts.push(encoded);
    offset += encoded.length;
  });
  const xref = offset;
  const rows = offsets.slice(1).map((entry) => `${String(entry).padStart(10, '0')} 00000 n \n`).join('');
  parts.push(Buffer.from(
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}` +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
  ));
  writeFileSync(pdfPath, Buffer.concat(parts));
}
