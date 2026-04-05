'use strict';
(function() {
  var saved = localStorage.getItem('dd-theme');
  if (saved) document.documentElement.setAttribute('data-theme', saved);
  else if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.setAttribute('data-theme', 'light');
  var btn = document.getElementById('login-theme-toggle');
  var icon = document.getElementById('login-theme-icon');
  if (btn) btn.addEventListener('click', function() {
    var current = document.documentElement.getAttribute('data-theme');
    var next = current === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next === 'dark' ? '' : next);
    if (next === 'dark') document.documentElement.removeAttribute('data-theme');
    localStorage.setItem('dd-theme', next);
    if (icon) icon.className = next === 'light' ? 'fas fa-moon' : 'fas fa-sun';
  });
  if (icon) icon.className = (saved === 'light' || (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) ? 'fas fa-moon' : 'fas fa-sun';
})();
(function() {
  var mode = localStorage.getItem('dd-uimode') || 'standard';
  if (mode === 'enterprise') {
    document.documentElement.setAttribute('data-uimode', 'enterprise');
  }
})();
(function() {
  var d = localStorage.getItem('dd-density');
  if (d && d !== 'comfortable') document.documentElement.setAttribute('data-density', d);
})();
(function() {
  var accent = localStorage.getItem('dd-accent');
  if (accent) {
    document.documentElement.style.setProperty('--accent', accent);
    document.documentElement.style.setProperty('--accent-hover', accent);
    document.documentElement.style.setProperty('--accent-dim', accent + '26');
  }
})();
