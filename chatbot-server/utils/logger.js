// utils/logger.js — Winston logger for the chatbot server
'use strict';

const { createLogger, format, transports } = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs/ directory exists next to this server
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const { combine, timestamp, errors, printf, colorize } = format;

// Custom line format: [2024-01-15 10:30:05] INFO: message  {"key":"val"}
const lineFormat = printf(({ timestamp: ts, level, message, stack, ...meta }) => {
  const metaStr = Object.keys(meta).length ? '  ' + JSON.stringify(meta) : '';
  return `[${ts}] ${level.toUpperCase()}: ${stack || message}${metaStr}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    errors({ stack: true })
  ),
  transports: [
    // Console — coloured, human-readable
    new transports.Console({
      format: combine(colorize({ all: true }), lineFormat)
    }),
    // File — error-only
    new transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: lineFormat,
      maxsize: 5 * 1024 * 1024,  // 5 MB
      maxFiles: 3
    }),
    // File — all levels
    new transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: lineFormat,
      maxsize: 10 * 1024 * 1024, // 10 MB
      maxFiles: 5
    })
  ]
});

module.exports = logger;
