// utils/queueUtils.js
// Stub implementation without Redis

const withTimeout = async (promise, timeoutMs = 5000) => {
  // Just return the promise without timeout handling
  // since we're not using queues
  try {
    return await promise;
  } catch (error) {
    console.error('Operation failed:', error);
    throw error;
  }
};

module.exports = {
  withTimeout
};