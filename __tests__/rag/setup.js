'use strict';

// Global mock for AWS SDK S3
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client:           jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  PutObjectCommand:   jest.fn(),
  GetObjectCommand:   jest.fn(),
  DeleteObjectCommand: jest.fn()
}));

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://s3.example.com/signed-url?X-Amz-Expires=900')
}));

// Silence console during tests
global.console.log  = jest.fn();
global.console.info = jest.fn();
// Keep console.error for test failures
