'use strict';

const component = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*';
const repositoryPattern = new RegExp('^' + component + '(?:/' + component + ')*(?![\\s\\S])');

const repository = value => typeof value === 'string' && value.length <= 255 && repositoryPattern.test(value);
const tag = value => typeof value === 'string' && /^\w[\w.-]{0,127}(?![\s\S])/.test(value);
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}(?![\s\S])/.test(value);

module.exports = { repository, tag, digest };
