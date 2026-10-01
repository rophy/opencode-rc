// Applies the saved color scheme before first paint (a file, not inline, so the CSP needs no 'unsafe-inline').
;(function () {
  var scheme = localStorage.getItem("opencode-color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  document.documentElement.dataset.theme = "oc-2"
  document.documentElement.dataset.colorScheme = isDark ? "dark" : "light"
  document.documentElement.style.backgroundColor = isDark ? "#080808" : "#fafafa"
  var meta = document.querySelector("meta[name='theme-color']")
  if (meta) meta.setAttribute("content", isDark ? "#080808" : "#fafafa")
})()
