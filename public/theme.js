// Applies the saved theme and appearance before the page is drawn (no flash).
// data-theme: "code" (VS Code-like) or "thudal" (thudal.com); data-mode: "light" or "dark".
try {
  let theme = JSON.parse(localStorage.getItem('latex.theme'));
  let mode = JSON.parse(localStorage.getItem('latex.mode'));
  if (theme === 'light' || theme === 'dark') { mode = mode || theme; theme = 'code'; } // older setting
  if (theme === 'code' || theme === 'thudal') document.documentElement.dataset.theme = theme;
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.mode = mode;
} catch { /* defaults: code, light */ }
