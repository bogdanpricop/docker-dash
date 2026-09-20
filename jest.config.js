module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.js'],
  setupFiles: ['<rootDir>/src/__tests__/setup-env.js'],
  testTimeout: 10000,
};
