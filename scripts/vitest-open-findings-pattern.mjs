import {readFileSync} from 'node:fs';

const registry = JSON.parse(readFileSync('src/tests/open-findings.json', 'utf8'));
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ids = registry.findings.map((finding) => escapeRegExp(finding.id));

process.stdout.write(ids.length ? `^(?!.*\\[OpenFinding:(?:${ids.join('|')})\\]).*$` : '.*');
