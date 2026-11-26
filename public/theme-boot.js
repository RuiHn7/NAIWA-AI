/* 首帧前决定主题，避免白闪；独立文件以满足 CSP 的 script-src 'self' */
(function () {
  try {
    var raw = localStorage.getItem('naiwa.theme');
    var mode = raw || 'system';
    var dark =
      mode === 'dark' ||
      (mode === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  } catch (e) {
    document.documentElement.dataset.theme = 'dark';
  }
})();
