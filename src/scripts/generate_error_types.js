// @ts-check
//
// Generates the canon error identifier union from the published Telegram error
// catalog. That catalog has 800+ entries and grows with every layer; hand-keeping
// a subset of it in global.d.ts meant every new comparison failed to typecheck
// with TS2367 until someone remembered to add the string.
//
// Input is the vendored snapshot in ./in/errors.json — the same file the backend
// audits against — so a build never depends on core.telegram.org being reachable.
// Refresh it deliberately, the way ./in/schema.json is refreshed.
//
//   node ./src/scripts/generate_error_types.js src/

const catalog = require(__dirname + '/in/errors.json');

const TABULATION = '  ';
const NEW_LINE = '\n';

// Catalog identifiers carry a printf placeholder where the wire value has a
// number: FLOOD_WAIT_%d arrives as FLOOD_WAIT_42. A plain string literal would
// never match those, so they become template literal types instead.
const PLACEHOLDER = /%d/g;

const plain = [];
const templated = [];

for(const identifier of Object.keys(catalog).sort()) {
  if(PLACEHOLDER.test(identifier)) {
    PLACEHOLDER.lastIndex = 0;
    templated.push(identifier);
  } else {
    plain.push(identifier);
  }
}

let out = '';
out += `/* eslint-disable */${NEW_LINE}`;
out += `// GENERATED FILE — do not edit by hand.${NEW_LINE}`;
out += `// Run \`pnpm run generate-error-types\` after refreshing src/scripts/in/errors.json.${NEW_LINE}`;
out += `// ${plain.length} plain identifiers, ${templated.length} templated.${NEW_LINE}${NEW_LINE}`;
out += `declare global {${NEW_LINE}`;
out += `${TABULATION}/** Every error identifier published in the canon catalog. */${NEW_LINE}`;
out += `${TABULATION}type CanonServerErrorType =${NEW_LINE}`;

for(const identifier of plain) {
  out += `${TABULATION}${TABULATION}| '${identifier}'${NEW_LINE}`;
}

if(templated.length) {
  out += `${TABULATION}${TABULATION}// Numeric suffix supplied by the server: FLOOD_WAIT_%d arrives as FLOOD_WAIT_42.${NEW_LINE}`;
  for(const identifier of templated) {
    out += `${TABULATION}${TABULATION}| \`${identifier.replace(PLACEHOLDER, '${number}')}\`${NEW_LINE}`;
  }
}

out += `${TABULATION}${TABULATION};${NEW_LINE}`;
out += `}${NEW_LINE}${NEW_LINE}`;
out += `export {};${NEW_LINE}`;

const path = process.argv[2];
const writePathTo = (path || __dirname + '/out/') + 'canonErrors.d.ts';
console.log(`Writing ${plain.length + templated.length} error identifiers to:`, writePathTo);
require('fs').writeFileSync(writePathTo, out);
