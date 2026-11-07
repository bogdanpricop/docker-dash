'use strict';

const months = 'january february march april may june july august september october november december'.split(' ');
const weekdays = 'sunday monday tuesday wednesday thursday friday saturday'.split(' ');
const fields = [[0, 59], [0, 23], [1, 31], [1, 12, months], [0, 7, weekdays]];

function fieldValues(field, [minimum, maximum, aliases]) {
  const parse = value => {
    if (/^\d{1,2}$/.test(value)) return Number(value);
    const index = aliases?.findIndex(name => name === value || name.slice(0, 3) === value) ?? -1;
    return index === -1 ? NaN : index + minimum;
  };
  const result = new Set();
  for (const item of field.split(',')) {
    const match = /^(\*|[a-z]+|\d{1,2})(?:-([a-z]+|\d{1,2}))?(?:\/(\d{1,2}))?$/.exec(item);
    if (!match) return null;
    const [, first, last, stride] = match;
    const from = first === '*' ? minimum : parse(first);
    const to = last ? parse(last) : first === '*' || stride ? maximum : from;
    const step = stride ? Number(stride) : 1;
    if ((first === '*' && last) || !Number.isInteger(from) || !Number.isInteger(to)
      || from < minimum || to > maximum || from > to || step < 1) return null;
    for (let value = from; value <= to; value += step) {
      result.add(aliases === weekdays && value === 7 ? 0 : value);
    }
  }
  return result;
}

function parseSchedule(expression) {
  if (typeof expression !== 'string' || expression.length > 120) return null;
  const parts = expression.trim().toLowerCase().split(/\s+/);
  if (parts.length !== fields.length) return null;
  const values = parts.map((part, index) => fieldValues(part, fields[index]));
  return values.some(value => value === null) ? null : values;
}

function compileScheduleCron(expression) {
  const values = parseSchedule(expression);
  if (!values) return null;
  return date => [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
    .every((value, index) => values[index].has(value));
}

function nextScheduleRuns(expression, after = new Date(), limit = 1) {
  const values = parseSchedule(expression);
  if (!values || !Number.isFinite(after.getTime())) return [];
  const [minutes, hours, days, months, weekdays] = values;
  const deadline = new Date(after);
  deadline.setFullYear(deadline.getFullYear() + 9);
  const current = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const runs = [];
  while (current <= deadline && runs.length < limit) {
    if (!days.has(current.getDate()) || !months.has(current.getMonth() + 1) || !weekdays.has(current.getDay())) {
      current.setDate(current.getDate() + 1);
      current.setHours(0, 0, 0, 0);
      continue;
    }
    if (hours.has(current.getHours()) && minutes.has(current.getMinutes())) runs.push(current.toISOString());
    current.setTime(current.getTime() + 60000);
  }
  return runs;
}

const validScheduleCron = expression => Boolean(compileScheduleCron(expression));
const cronMatchesNow = (expression, now) => compileScheduleCron(expression)?.(now) ?? false;
module.exports = { compileScheduleCron, validScheduleCron, cronMatchesNow, nextScheduleRuns };
