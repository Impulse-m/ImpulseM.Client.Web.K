import {readFileSync, readdirSync, statSync} from 'fs';
import {join} from 'path';

import {describe, expect, it} from 'vitest';

import registry from './open-findings.json';

type OpenFinding = (typeof registry.findings)[number];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function testFiles(root: string): string[] {
  const files: string[] = [];
  for(const entry of readdirSync(root)) {
    const path = join(root, entry);
    if(statSync(path).isDirectory()) {
      files.push(...testFiles(path));
    } else if(/\.test\.[cm]?[jt]sx?$/.test(path)) {
      files.push(path);
    }
  }
  return files;
}

describe('open findings registry', () => {
  it('has one existing test with the matching suffix for every permit', () => {
    const ids = new Set<string>();
    const registeredTitles = new Set<string>();

    for(const finding of registry.findings as OpenFinding[]) {
      expect(ids.has(finding.id), `duplicate open finding id ${finding.id}`).toBe(false);
      ids.add(finding.id);
      expect(registeredTitles.has(finding.testName), `duplicate registered test ${finding.testName}`).toBe(false);
      registeredTitles.add(finding.testName);

      const suffix = `[OpenFinding:${finding.id}]`;
      expect(finding.testName.endsWith(suffix)).toBe(true);
      const source = readFileSync(finding.file, 'utf8');
      const titlePattern = new RegExp(`\\bit\\(\\s*['\"]${escapeRegExp(finding.testName)}['\"]`);
      expect(source, `stale open finding ${finding.id}: ${finding.testName} is absent`).toMatch(titlePattern);
    }
  });

  it('registers every open-finding suffix used by a test', () => {
    const source = testFiles('src/tests')
    .filter((file) => file !== 'src/tests/openFindings.test.ts')
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
    const usedIds = [...source.matchAll(/\[OpenFinding:([^\]]+)\]/g)].map((match) => match[1]);
    const registeredIds = registry.findings.map((finding) => finding.id);

    expect(usedIds.sort()).toEqual(registeredIds.sort());
  });
});
