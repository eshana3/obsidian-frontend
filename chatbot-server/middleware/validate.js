// middleware/validate.js — express-validator rules + error handler
'use strict';

const { body, validationResult } = require('express-validator');

const MAX_MSG_LEN = parseInt(process.env.MAX_MESSAGE_LENGTH, 10) || 4000;

/**
 * Validation rules for POST /api/chat
 */
const chatRules = [
  body('message')
    .trim()
    .notEmpty()
    .withMessage('message is required and cannot be blank.')
    .isLength({ max: MAX_MSG_LEN })
    .withMessage(`message cannot exceed ${MAX_MSG_LEN} characters.`),

  body('sessionId')
    .optional({ nullable: true })
    .isString()
    .withMessage('sessionId must be a string.'),
];

/**
 * Express middleware: return 400 if any validation rule failed.
 */
function handleValidationErrors(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: 'Validation failed.',
      details: errors.array().map(e => e.msg)
    });
  }
  next();
}

module.exports = { chatRules, handleValidationErrors };
