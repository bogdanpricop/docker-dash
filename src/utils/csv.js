'use strict';

// Quote delimiters and neutralize spreadsheet formula prefixes in untrusted text.
function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value === 'string' && /^(?:[\s\uFEFF]*[=+\-@＝＋－＠]|[\t\r\n])/.test(text)) {
    text = "'" + text;
  }
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

module.exports = { csvCell };
