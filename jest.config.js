/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  // p-retry is published as ESM only, so it is compiled for jest too.
  preset: "ts-jest/presets/js-with-ts",
  testEnvironment: "node",
  transformIgnorePatterns: ["/node_modules/(?!(p-retry)/)"],
};
