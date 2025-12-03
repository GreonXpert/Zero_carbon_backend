// middleware/rateLimit.js
const rateLimit = require('express-rate-limit');

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 attempts
  message: { message: 'Too many login attempts, please try again later' }
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100
});

// In index.js
app.use('/api/users/login', loginLimiter);
app.use('/api/', apiLimiter);