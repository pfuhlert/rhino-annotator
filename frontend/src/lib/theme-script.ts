export const KEY = "theme";
export const CHANGE = "themechange";

// Runs in <head> before paint, and keeps applying on OS or cross-tab changes.
export const themeScript = `(() => {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const apply = () => {
    let theme;
    try { theme = localStorage.getItem("${KEY}"); } catch {}
    const dark = theme === "dark" || (theme !== "light" && media.matches);
    document.documentElement.classList.toggle("dark", dark);
    document.documentElement.style.colorScheme = dark ? "dark" : "light";
  };
  apply();
  media.addEventListener("change", apply);
  addEventListener("${CHANGE}", apply);
  addEventListener("storage", apply);
})()`;
