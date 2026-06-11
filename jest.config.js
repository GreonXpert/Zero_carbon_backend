'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch:       ['**/__tests__/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/__tests__/rag/setup.js'],
  testTimeout:     30000
};
