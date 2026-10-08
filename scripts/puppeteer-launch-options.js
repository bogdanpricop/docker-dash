'use strict';

module.exports = function puppeteerLaunchOptions() {
  const options = { headless: true };
  if (process.env.CI === 'true') {
    options.args = ['--no-sandbox', '--disable-setuid-sandbox'];
  }
  return options;
};
