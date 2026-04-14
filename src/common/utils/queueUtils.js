/**
 * Queue Utilities for handling async operations with retries and timeouts
 */

/**
 * Execute a function with timeout
 * @param {Function} fn - Function to execute
 * @param {Number} timeout - Timeout in milliseconds
 * @param {String} errorMessage - Error message if timeout occurs
 */
const withTimeout = (fn, timeout, errorMessage = 'Operation timed out') => {
  return Promise.race([
    fn(),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), timeout)
    )
  ]);
};

/**
 * Retry a function with exponential backoff
 * @param {Function} fn - Function to retry
 * @param {Number} maxRetries - Maximum number of retries
 * @param {Number} initialDelay - Initial delay in milliseconds
 * @param {Number} maxDelay - Maximum delay in milliseconds
 */
const retryWithBackoff = async (fn, maxRetries = 3, initialDelay = 1000, maxDelay = 10000) => {
  let lastError;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      if (attempt === maxRetries) {
        throw error;
      }
      
      // Calculate delay with exponential backoff
      const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
      console.log(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms`);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
};

/**
 * Basic in-memory queue implementation
 */
class SimpleQueue {
  constructor(name, options = {}) {
    this.name = name;
    this.queue = [];
    this.processing = false;
    this.concurrency = options.concurrency || 1;
    this.activeJobs = 0;
    this.processHandler = null;
    this.errorHandler = options.errorHandler || console.error;
    this.completedJobs = 0;
    this.failedJobs = 0;
  }

  /**
   * Set the process handler for queue items
   * @param {Function} handler - Function to process each item
   */
  process(handler) {
    this.processHandler = handler;
    this.startProcessing();
  }

  /**
   * Add item to queue
   * @param {Any} data - Data to process
   * @param {Object} options - Job options
   */
  add(data, options = {}) {
    const job = {
      id: Date.now() + Math.random(),
      data,
      options,
      attempts: 0,
      createdAt: new Date(),
      status: 'pending'
    };

    this.queue.push(job);
    this.startProcessing();
    
    return job;
  }

  /**
   * Start processing queue
   */
  async startProcessing() {
    if (this.processing || !this.processHandler) {
      return;
    }

    this.processing = true;

    while (this.queue.length > 0 || this.activeJobs > 0) {
      // Wait if we've reached concurrency limit
      if (this.activeJobs >= this.concurrency) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      const job = this.queue.shift();
      if (!job) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      this.activeJobs++;
      this.processJob(job).then(() => {
        this.activeJobs--;
      }).catch(() => {
        this.activeJobs--;
      });
    }

    this.processing = false;
  }

  /**
   * Process individual job
   */
  async processJob(job) {
    try {
      job.status = 'processing';
      job.startedAt = new Date();
      
      // Apply timeout if specified
      if (job.options.timeout) {
        await withTimeout(
          () => this.processHandler(job.data, job),
          job.options.timeout,
          `Job ${job.id} timed out`
        );
      } else {
        await this.processHandler(job.data, job);
      }
      
      job.status = 'completed';
      job.completedAt = new Date();
      this.completedJobs++;
      
    } catch (error) {
      job.status = 'failed';
      job.error = error.message;
      job.failedAt = new Date();
      job.attempts++;
      
      // Retry logic
      if (job.options.maxRetries && job.attempts < job.options.maxRetries) {
        job.status = 'retrying';
        const delay = job.options.retryDelay || 1000 * job.attempts;
        setTimeout(() => {
          this.queue.push(job);
          this.startProcessing();
        }, delay);
      } else {
        this.failedJobs++;
        this.errorHandler(error, job);
      }
    }
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      name: this.name,
      pending: this.queue.filter(j => j.status === 'pending').length,
      active: this.activeJobs,
      completed: this.completedJobs,
      failed: this.failedJobs,
      total: this.queue.length + this.activeJobs
    };
  }

  /**
   * Clear the queue
   */
  clear() {
    this.queue = [];
    this.completedJobs = 0;
    this.failedJobs = 0;
  }

  /**
   * Pause processing
   */
  pause() {
    this.processing = false;
  }

  /**
   * Resume processing
   */
  resume() {
    this.startProcessing();
  }
}

/**
 * Batch processor for handling multiple items efficiently
 */
class BatchProcessor {
  constructor(options = {}) {
    this.batchSize = options.batchSize || 10;
    this.flushInterval = options.flushInterval || 5000;
    this.batch = [];
    this.processor = options.processor;
    this.timer = null;
  }

  /**
   * Add item to batch
   */
  add(item) {
    this.batch.push(item);
    
    if (this.batch.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushInterval);
    }
  }

  /**
   * Process the current batch
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    if (this.batch.length === 0) {
      return;
    }

    const items = [...this.batch];
    this.batch = [];

    try {
      if (this.processor) {
        await this.processor(items);
      }
    } catch (error) {
      console.error('Batch processing failed:', error);
      // Could implement retry logic here
    }
  }

  /**
   * Get current batch size
   */
  size() {
    return this.batch.length;
  }
}

/**
 * Rate limiter implementation
 */
class RateLimiter {
  constructor(options = {}) {
    this.maxRequests = options.maxRequests || 10;
    this.windowMs = options.windowMs || 60000; // 1 minute
    this.requests = [];
  }

  /**
   * Check if request is allowed
   */
  async checkLimit() {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    
    // Remove old requests
    this.requests = this.requests.filter(timestamp => timestamp > windowStart);
    
    if (this.requests.length >= this.maxRequests) {
      const oldestRequest = this.requests[0];
      const waitTime = (oldestRequest + this.windowMs) - now;
      return {
        allowed: false,
        waitTime,
        retryAfter: new Date(now + waitTime)
      };
    }
    
    this.requests.push(now);
    return {
      allowed: true,
      remaining: this.maxRequests - this.requests.length
    };
  }

  /**
   * Wait if rate limited
   */
  async waitIfLimited() {
    const check = await this.checkLimit();
    
    if (!check.allowed) {
      console.log(`Rate limited. Waiting ${check.waitTime}ms`);
      await new Promise(resolve => setTimeout(resolve, check.waitTime));
      return this.waitIfLimited();
    }
    
    return check;
  }
}

module.exports = {
  withTimeout,
  retryWithBackoff,
  SimpleQueue,
  BatchProcessor,
  RateLimiter
};