/* eslint-disable @typescript-eslint/no-require-imports -- Node CJS build script. */
/**
 * Combine the unit and e2e Istanbul coverage into a single `.nyc_output` set so
 * `nyc report` / `nyc check-coverage` evaluate the gate against BOTH suites.
 *
 * Why this exists (ADR-0016): the critical guarantees (DB-atomic claim, RBAC,
 * real-time, observability) are proven by the e2e suite against real Postgres/
 * Redis, not by mock-heavy unit tests. Unit-only coverage is therefore ~13% and
 * says nothing useful; the honest coverage number is the union of what the unit
 * AND e2e suites execute. Jest cannot merge two separate runs, so we drop each
 * run's `coverage-final.json` into `.nyc_output` (nyc unions all files it finds
 * there) under distinct names and let nyc produce the combined report.
 *
 * No real/clinical data is involved — this only moves Istanbul JSON around.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const nycOutput = path.join(root, '.nyc_output');

const sources = [
  { label: 'unit', file: path.join(root, 'coverage', 'unit', 'coverage-final.json') },
  { label: 'e2e', file: path.join(root, 'coverage', 'e2e', 'coverage-final.json') },
];

fs.rmSync(nycOutput, { recursive: true, force: true });
fs.mkdirSync(nycOutput, { recursive: true });

let copied = 0;
for (const { label, file } of sources) {
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, path.join(nycOutput, `${label}.json`));
    copied += 1;
    console.log(`merged coverage: ${label} <- ${path.relative(root, file)}`);
  } else {
    console.warn(`WARNING: ${label} coverage not found at ${path.relative(root, file)}`);
  }
}

if (copied === 0) {
  console.error('No coverage inputs found. Run test:cov:unit and test:cov:e2e first.');
  process.exit(1);
}
