// middleware/validation.js
const { body, validationResult } = require('express-validator');

const loginValidation = [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }).trim().escape()
];

const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};