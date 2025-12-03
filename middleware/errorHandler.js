// middleware/errorHandler.js
const errorHandler = (err, req, res, next) => {
  console.error(`[${new Date().toISOString()}] Error:`, err);
  
  if (process.env.NODE_ENV === 'production') {
    return res.status(err.status || 500).json({
      success: false,
      message: 'An error occurred'
    });
  }
  
  res.status(err.status || 500).json({
    success: false,
    message: err.message,
    stack: err.stack
  });
};