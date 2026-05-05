'use strict';

const fs   = require('fs');
const path = require('path');
const winston = require('winston');
const config  = require('./config');

const transports = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) =>
        `[${timestamp}] ${level}: ${message}`
      )
    ),
  }),
];

if (config.logToFile) {
  const logDir = path.join(__dirname, '..', 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const fileFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message }) =>
      `[${timestamp}] ${level.toUpperCase()}: ${message}`
    )
  );
  transports.push(
    new winston.transports.File({ filename: path.join(logDir, 'error.log'),    level: 'error', format: fileFormat }),
    new winston.transports.File({ filename: path.join(logDir, 'combined.log'),                format: fileFormat })
  );
}

module.exports = winston.createLogger({
  level: config.logLevel,
  transports,
});
