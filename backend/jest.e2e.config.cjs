/** @type {import('ts-jest').JestConfigWithTsJest} */
// Integration / e2e config. These tests hit a REAL PostgreSQL database (they
// prove the DB-atomic claim and the RBAC boundaries end-to-end), so they are
// kept separate from the fast unit config and run serially (--runInBand).
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  roots: ['<rootDir>/test/e2e'],
  testRegex: '.*\\.e2e-spec\\.ts$',
  moduleFileExtensions: ['ts', 'js', 'json'],
  testTimeout: 30000,
  // When run with --coverage (test:cov:e2e) collect over the SAME source set as
  // the unit config, so the merged report (docs/testing-strategy.md) is a true union: a file is
  // "covered" if either suite executed it, and files neither suite touched still
  // count against the gate.
  collectCoverageFrom: [
    'src/**/*.(t|j)s',
    '!src/main.ts',
    '!src/prisma/seed.ts',
    '!src/realtime/cors-io.adapter.ts',
  ],
};
