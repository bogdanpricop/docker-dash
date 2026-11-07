'use strict';

process.env.DB_PATH = ':memory:';
process.env.APP_ENV = 'test';

const { getDb, closeDb } = require('../db');
const { claimAutomatic, execute } = require('../services/schedule-dispatch');
const { compileScheduleCron } = require('../utils/schedule-cron');
const docker = require('../services/docker');
const config = require('../config');

const now = new Date(2026, 10, 8, 12, 15);
let db;
beforeAll(() => { db = getDb(); });
afterAll(closeDb);
afterEach(() => { db.exec('DELETE FROM schedule_history; DELETE FROM scheduled_actions'); jest.restoreAllMocks(); });

function create() {
  db.prepare(`INSERT INTO scheduled_actions (id, container_id, action, cron, host_id)
    VALUES ('fixture', 'container-fixture', 'restart', '* * * * *', 1)`).run();
  return db.prepare('SELECT * FROM scheduled_actions').get();
}

test.each([
  ['15 12 * nov sun', true], ['0-30/5 12 * november 5-7', true],
  ['0,15,30 12 * 11 7', true], ['14 12 * nov sun', false],
  ['15 12 * nov mon', false], ['15 12 9 nov sun', false],
  ['15 12 8 11 0', true], ['15 12 * nov sat,sun', true],
])('matches %s against the same rules used by preview', (pattern, expected) => {
  expect(compileScheduleCron(pattern)(now)).toBe(expected);
});

test.each(['0 0 * *', '* * * * * *', '60 * * * *', '*/0 * * * *',
  '1-999999999 * * * *', '4-1 * * * *', '* * * smarch *', '* * * * 8', ['* * * * *']])(
  'rejects invalid cron input %p without expanding unbounded ranges', pattern => {
    expect(compileScheduleCron(pattern)).toBeNull();
  }
);

test('a scheduled minute is claimed once and an older callback cannot overwrite a later claim', () => {
  const schedule = create();
  expect(claimAutomatic(db, schedule, now)).toBe(true);
  expect(claimAutomatic(db, schedule, now)).toBe(false);
  expect(claimAutomatic(db, schedule, new Date(now.getTime() + 60000))).toBe(true);
  expect(claimAutomatic(db, schedule, now)).toBe(false);
});

test('disabled, edited and read-only schedules are not claimed', () => {
  const schedule = create();
  db.prepare("UPDATE scheduled_actions SET enabled = 0 WHERE id = 'fixture'").run();
  expect(claimAutomatic(db, schedule, now)).toBe(false);
  db.prepare("UPDATE scheduled_actions SET enabled = 1, action = 'stop' WHERE id = 'fixture'").run();
  expect(claimAutomatic(db, schedule, now)).toBe(false);
  const previous = config.features.readOnly;
  config.features.readOnly = true;
  try {
    expect(claimAutomatic(db, db.prepare('SELECT * FROM scheduled_actions').get(), now)).toBe(false);
  } finally { config.features.readOnly = previous; }
});

test('records success and clears stale failure while retaining history', async () => {
  const schedule = create();
  const action = jest.spyOn(docker, 'containerAction').mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce();
  await expect(execute(schedule, db)).rejects.toThrow('offline');
  await expect(execute(schedule, db)).resolves.toMatchObject({ historyRecorded: true });
  expect(action).toHaveBeenCalledWith('container-fixture', 'restart', 1);
  expect(db.prepare('SELECT last_run_status, last_run_error, run_count FROM scheduled_actions').get())
    .toEqual({ last_run_status: 'success', last_run_error: null, run_count: 1 });
  expect(db.prepare('SELECT status FROM schedule_history ORDER BY id').pluck().all()).toEqual(['error', 'success']);
});
