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

function compileScheduleCron(expression) {
  if (typeof expression !== 'string' || expression.length > 120) return null;
  const parts = expression.trim().toLowerCase().split(/\s+/);
  if (parts.length !== fields.length) return null;
  const values = parts.map((part, index) => fieldValues(part, fields[index]));
  if (values.some(value => value === null)) return null;
  return date => [date.getMinutes(), date.getHours(), date.getDate(), date.getMonth() + 1, date.getDay()]
    .every((value, index) => values[index].has(value));
}

const validScheduleCron = expression => Boolean(compileScheduleCron(expression));
const cronMatchesNow = (expression, now) => compileScheduleCron(expression)?.(now) ?? false;
module.exports = { compileScheduleCron, validScheduleCron, cronMatchesNow };
