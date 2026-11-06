'use strict';

const os = require('os');
const path = require('path');

// Services create repositories, previews, backups and generated policies below
// DATA_DIR as soon as they are imported. Production correctly defaults to
// /data, but an unprivileged CI runner must never write there. Jest executes
// this file before every test environment, so each worker gets an isolated,
// writable root before any service module can capture DATA_DIR.
process.env.APP_ENV = 'test';
process.env.DATA_DIR = path.join(
  os.tmpdir(),
  'docker-dash-tests',
  `${process.pid}-${process.env.JEST_WORKER_ID || '0'}`
);
