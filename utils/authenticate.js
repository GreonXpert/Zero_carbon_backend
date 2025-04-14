const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Middleware to authenticate the user based on the JWT token
const authenticate = async (req, res, next) => {
  // Get token from Authorization header
  const token = req.header('Authorization')?.replace('Bearer ', '');
console.log("token",token)
  if (!token) {
    return res.status(401).json({ message: 'No token, authorization denied' });
  }

  try {
    // Verify the token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Attach user info to req.user (i.e., the userId)
    const user = await User.findById(decoded.id);
    if (!user) {
      return res.status(401).json({ message: 'User not found' });
    }

    req.user = user;  // Add user information to req.user
    console.log("req.user",req.user);
    next(); // Proceed to the next middleware/route handler
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid' }); 
  }
};

module.exports ={authenticate} 
