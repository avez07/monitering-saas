// Runs before the first paint so the right theme is on screen immediately (no flash).
// It is a separate file, not an inline script, because the Content-Security-Policy only allows
// scripts from our own origin. Keep in sync with src/lib/theme.jsx.
(function () {
  var dark = false;
  try {
    var saved = localStorage.getItem('yuktiops.theme');
    dark =
      saved === 'dark' ||
      (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (error) {
    /* storage can be unavailable in private windows: stay on the light default */
  }
  document.documentElement.classList.toggle('dark', dark);
  try {
    var palette = localStorage.getItem('yuktiops.palette');
    if (palette && /^[a-z]+$/.test(palette) && palette !== 'warm') {
      document.documentElement.setAttribute('data-palette', palette);
    }
  } catch (error) {
    /* default palette */
  }
})();
