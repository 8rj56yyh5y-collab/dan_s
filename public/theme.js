// Тема применяется до отрисовки, чтобы страница не «мигала».
try { var t = localStorage.getItem('bh-theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
