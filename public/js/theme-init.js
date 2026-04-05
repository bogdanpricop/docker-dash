'use strict';
(function() {
  var saved = localStorage.getItem('dd-theme');
  // Only 'light' is a valid theme attribute; dark = no attribute
  if (saved === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else if (!saved && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');

  var isLight = document.documentElement.getAttribute('data-theme') === 'light';
  var btn = document.getElementById('login-theme-toggle');
  var icon = document.getElementById('login-theme-icon');
  if (btn) btn.addEventListener('click', function() {
    var wasLight = document.documentElement.getAttribute('data-theme') === 'light';
    if (wasLight) {
      document.documentElement.removeAttribute('data-theme');
      localStorage.setItem('dd-theme', 'dark');
    } else {
      document.documentElement.setAttribute('data-theme', 'light');
      localStorage.setItem('dd-theme', 'light');
    }
    if (icon) icon.className = wasLight ? 'fas fa-sun' : 'fas fa-moon';
  });
  if (icon) icon.className = isLight ? 'fas fa-moon' : 'fas fa-sun';
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
