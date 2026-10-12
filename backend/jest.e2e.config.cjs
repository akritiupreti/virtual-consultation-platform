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
};
