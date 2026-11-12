'use strict';

module.exports = function stripUnsafeBodyKeys(req, _res, next) {
  const pending = [req.body];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object') continue;
    delete value.__proto__;
    delete value.constructor;
    delete value.prototype;
    for (const child of Object.values(value)) {
      if (child && typeof child === 'object') pending.push(child);
    }
  }
  next();
};
