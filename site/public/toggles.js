// Tiny client script: theme toggle, currency toggle, mobile menu. Everything else is static HTML.
(function () {
  var root = document.documentElement;

  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var dark = !root.classList.contains('dark');
      root.classList.toggle('dark', dark);
      save('yuktiops.theme', dark ? 'dark' : 'light');
      themeBtn.setAttribute('aria-pressed', String(dark));
    });
    themeBtn.setAttribute('aria-pressed', String(root.classList.contains('dark')));
  }

  var menuBtn = document.getElementById('menu-toggle');
  var menu = document.getElementById('mobile-menu');
  if (menuBtn && menu) {
    menuBtn.addEventListener('click', function () {
      var open = menu.classList.toggle('hidden') === false;
      menuBtn.setAttribute('aria-expanded', String(open));
    });
  }

  var currency = 'INR';
  try { currency = localStorage.getItem('yuktiops.currency') || 'INR'; } catch (e) {}
  function applyCurrency(c) {
    document.querySelectorAll('[data-currency]').forEach(function (el) {
      el.hidden = el.getAttribute('data-currency') !== c;
    });
    document.querySelectorAll('[data-currency-btn]').forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.getAttribute('data-currency-btn') === c));
    });
  }
  document.querySelectorAll('[data-currency-btn]').forEach(function (b) {
    b.addEventListener('click', function () {
      currency = b.getAttribute('data-currency-btn');
      save('yuktiops.currency', currency);
      applyCurrency(currency);
    });
  });
  applyCurrency(currency);
})();
