// Runs before first paint: applies the saved or system light/dark theme. Same storage key as the app.
(function () {
  var dark = false;
  try {
    var saved = localStorage.getItem('yuktiops.theme');
    dark = saved === 'dark' || (saved !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) {}
  document.documentElement.classList.toggle('dark', dark);
})();
