import {describe, expect, it} from 'vitest';
import {readFileSync} from 'fs';
import {inflateSync} from 'zlib';
import {resolve} from 'path';

type Tables = Map<string, Buffer>;

function readSfnt(buffer: Buffer): Tables {
  const tables: Tables = new Map();
  const numTables = buffer.readUInt16BE(4);
  for(let i = 0; i < numTables; ++i) {
    const offset = 12 + i * 16;
    const tag = buffer.toString('ascii', offset, offset + 4);
    const tableOffset = buffer.readUInt32BE(offset + 8);
    const length = buffer.readUInt32BE(offset + 12);
    tables.set(tag, buffer.subarray(tableOffset, tableOffset + length));
  }
  return tables;
}

function readWoff(buffer: Buffer): Tables {
  const tables: Tables = new Map();
  const numTables = buffer.readUInt16BE(12);
  for(let i = 0; i < numTables; ++i) {
    const offset = 44 + i * 20;
    const tag = buffer.toString('ascii', offset, offset + 4);
    const tableOffset = buffer.readUInt32BE(offset + 4);
    const compLength = buffer.readUInt32BE(offset + 8);
    const origLength = buffer.readUInt32BE(offset + 12);
    const raw = buffer.subarray(tableOffset, tableOffset + compLength);
    tables.set(tag, compLength === origLength ? raw : inflateSync(raw));
  }
  return tables;
}

/**
 * Returns the glyphs whose hmtx left side bearing differs from the glyf xMin.
 * FreeType (Chrome, Firefox on Linux/Android) positions a TrueType glyph at
 * `xMin - lsb`, so any mismatch moves the whole icon sideways inside its box.
 */
function findMismatchedGlyphs(tables: Tables): string[] {
  const head = tables.get('head')!;
  const hhea = tables.get('hhea')!;
  const maxp = tables.get('maxp')!;
  const hmtx = tables.get('hmtx')!;
  const loca = tables.get('loca')!;
  const glyf = tables.get('glyf')!;
  const longLoca = head.readInt16BE(50) === 1;
  const numGlyphs = maxp.readUInt16BE(4);
  const numHMetrics = hhea.readUInt16BE(34);
  const mismatched: string[] = [];
  for(let glyph = 0; glyph < numGlyphs; ++glyph) {
    const start = longLoca ? loca.readUInt32BE(glyph * 4) : loca.readUInt16BE(glyph * 2) * 2;
    const end = longLoca ? loca.readUInt32BE((glyph + 1) * 4) : loca.readUInt16BE((glyph + 1) * 2) * 2;
    if(start === end) {
      continue;
    }

    const xMin = glyf.readInt16BE(start + 2);
    const lsb = glyph < numHMetrics ?
      hmtx.readInt16BE(glyph * 4 + 2) :
      hmtx.readInt16BE(numHMetrics * 4 + (glyph - numHMetrics) * 2);
    if(xMin !== lsb) {
      mismatched.push(`glyph ${glyph}: xMin ${xMin}, lsb ${lsb}`);
    }
  }
  return mismatched;
}

describe('tgico icon font', () => {
  const fontsDir = resolve(__dirname, '../../public/assets/fonts');

  it.each([
    ['tgico.ttf', readSfnt],
    ['tgico.woff', readWoff]
  ] as const)('%s keeps hmtx left side bearing equal to glyf xMin for every glyph', (file, read) => {
    const tables = read(readFileSync(resolve(fontsDir, file)));
    expect(findMismatchedGlyphs(tables)).toEqual([]);
  });
});
