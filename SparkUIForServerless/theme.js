"use strict";

(() => {
  const key = "sparkdice-theme";
  const modes = ["light", "dark", "system"];
  const system = matchMedia("(prefers-color-scheme: dark)");
  let mode = "system";
  let storageWarning = "";
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null && !modes.includes(saved)) {
      console.warn("SparkDice: invalid saved theme; using system mode.");
      storageWarning = "Saved theme was invalid. Using system mode.";
    } else if (saved !== null) {
      mode = saved;
    }
  } catch (error) {
    console.warn("SparkDice could not read the theme preference.", error);
    storageWarning = "Theme storage is unavailable. Changes apply to this page only.";
  }

  function apply() {
    document.documentElement.dataset.theme = mode === "system" ? (system.matches ? "dark" : "light") : mode;
    document.documentElement.dataset.themeMode = mode;
    document.querySelectorAll("[data-theme-mode]").forEach(button => {
      if (button.tagName === "BUTTON") button.setAttribute("aria-pressed", String(button.dataset.themeMode === mode));
    });
  }

  // Apply before the stylesheet loads to avoid flashing the wrong theme.
  apply();
  system.addEventListener("change", () => { if (mode === "system") apply(); });

  document.addEventListener("DOMContentLoaded", () => {
    const icons = {
      light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
      dark: '<path d="M20.5 14a8.5 8.5 0 0 1-10.5-10.5A8.5 8.5 0 1 0 20.5 14z"/>',
      system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M12 17v4m-4 0h8"/>'
    };
    document.querySelectorAll("[data-theme-control]").forEach(control => {
      control.innerHTML = `<div class="theme-switch" role="group" aria-label="Color theme">${modes.map(value =>
        `<button type="button" data-theme-mode="${value}" aria-label="${value === "system" ? "System default" : value === "light" ? "Light" : "Dark"} theme" title="${value === "system" ? "System default" : value === "light" ? "Light" : "Dark"} theme"><svg viewBox="0 0 24 24" aria-hidden="true">${icons[value]}</svg></button>`
      ).join("")}</div><span class="theme-warning" role="status"></span>`;
      const warning = control.querySelector(".theme-warning");
      warning.textContent = storageWarning;
      control.querySelectorAll("button").forEach(button => {
        button.addEventListener("click", () => {
          mode = button.dataset.themeMode;
          apply();
          try {
            localStorage.setItem(key, mode);
            warning.textContent = "";
          } catch (error) {
            console.warn("SparkDice could not save the theme preference.", error);
            warning.textContent = "Theme could not be saved. Changes apply to this page only.";
          }
        });
      });
    });
    apply();
  });
})();
