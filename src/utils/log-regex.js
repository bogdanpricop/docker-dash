'use strict';

const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (!isMainThread) {
  try {
    const expression = new RegExp(workerData.pattern, 'i');
    parentPort.postMessage(workerData.lines.filter(line => expression.test(line)));
  } catch {
    parentPort.postMessage(null);
  }
}

let active = 0;
const failure = (message, status) => Object.assign(new Error(message), { status });

module.exports = async function filterLogsByRegex(lines, pattern) {
  if (typeof pattern !== 'string' || pattern.length > 200) throw failure('Invalid log regular expression', 400);
  if (active >= 2) throw failure('Log regular expression workers are busy', 429);
  const worker = new Worker(__filename, { workerData: { lines, pattern } });
  active++;
  let deadline;
  try {
    return await new Promise((resolve, reject) => {
      deadline = setTimeout(() => reject(failure('Log regular expression exceeded its time limit', 422)), 750);
      worker.once('message', result => result === null ? reject(failure('Invalid log regular expression', 400)) : resolve(result));
      worker.once('error', () => reject(failure('Log regular expression could not run', 422)));
      worker.once('exit', () => reject(failure('Log regular expression worker stopped', 422)));
    });
  } finally {
    clearTimeout(deadline);
    try { await worker.terminate(); }
    finally { active--; }
  }
};
