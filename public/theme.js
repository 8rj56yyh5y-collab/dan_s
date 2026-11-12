// Тема применяется до отрисовки, чтобы страница не «мигала». Если не выбрана — как в системе.
(function () {
  var t = null;
  try { t = localStorage.getItem('bh-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  var m = document.querySelector('meta[name=theme-color]');
  if (m) m.content = t === 'dark' ? '#000000' : '#ffffff';
})();
