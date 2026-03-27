'use strict';

const config = require('../config');
const isDev = config.app.env === 'development';

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const minLevel = LEVELS[process.env.LOG_LEVEL || (isDev ? 'debug' : 'info')];

function log(level, module, message, data) {
  if (LEVELS[level] < minLevel) return;
  const entry = {
    time: new Date().toISOString(),
    level,
    module,
    msg: message,
  };
  if (data !== undefined) entry.data = data;
  const line = isDev
    ? `[${entry.time.substring(11, 19)}] ${level.toUpperCase().padEnd(5)} [${module}] ${message}${data ? ' ' + JSON.stringify(data) : ''}`
    : JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = (module) => ({
  debug: (msg, data) => log('debug', module, msg, data),
  info: (msg, data) => log('info', module, msg, data),
  warn: (msg, data) => log('warn', module, msg, data),
  error: (msg, data) => log('error', module, msg, data),
});
