'use strict';

function httpUrl(value, { httpsOnly = false } = {}) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value.trim())) return null;
  const url = URL.parse(value.trim());
  if (!url || !url.hostname || url.username || url.password || url.hash) return null;
  if (url.protocol === 'https:' || (!httpsOnly && url.protocol === 'http:')) return url;
  return null;
}

module.exports = httpUrl;
