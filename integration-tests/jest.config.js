/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  testMatch: ["**/*.test.ts"],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  setupFilesAfterEnv: ["<rootDir>/src/setup.ts"],
  testTimeout: 120000, // 2 minutes for API calls
  verbose: true,
  collectCoverageFrom: ["src/**/*.ts", "!src/**/*.d.ts", "!src/setup.ts"],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  maxWorkers: 1, // Run tests serially to avoid rate limiting
  globals: {
    "ts-jest": {
      tsconfig: "tsconfig.json",
    },
  },
};
