/* Minimal client helpers only: sidebar, countdown, upload filename, PWA. */
(function () {
  const app = document.querySelector(".app");
  const collapsedKey = "pacepack_sidebar_collapsed";

  function toggleCollapsed() {
    if (!app) return;
    app.classList.toggle("sidebar-collapsed");
    localStorage.setItem(collapsedKey, app.classList.contains("sidebar-collapsed") ? "1" : "0");
  }

  function toggleMobile() {
    document.body.classList.toggle("sidebar-open");
    const backdrop = document.getElementById("sidebar-backdrop");
    if (backdrop) backdrop.hidden = !document.body.classList.contains("sidebar-open");
  }

  if (app && localStorage.getItem(collapsedKey) === "1") {
    app.classList.add("sidebar-collapsed");
  }

  document.querySelectorAll("[data-sidebar-collapse]").forEach((button) => {
    button.addEventListener("click", toggleCollapsed);
  });
  document.querySelectorAll("[data-sidebar-toggle]").forEach((button) => {
    button.addEventListener("click", toggleMobile);
  });
  const backdrop = document.getElementById("sidebar-backdrop");
  if (backdrop) backdrop.addEventListener("click", toggleMobile);

  function tickCountdown(root) {
    const target = new Date(root.getAttribute("data-countdown")).getTime();
    if (Number.isNaN(target)) return;
    const diff = Math.max(0, target - Date.now());
    const parts = {
      days: Math.floor(diff / 86400000),
      hours: Math.floor((diff % 86400000) / 3600000),
      minutes: Math.floor((diff % 3600000) / 60000),
      seconds: Math.floor((diff % 60000) / 1000),
    };
    Object.entries(parts).forEach(([unit, value]) => {
      const el = root.querySelector(`[data-unit="${unit}"]`);
      if (el) el.textContent = String(value).padStart(unit === "days" ? 1 : 2, "0");
    });
  }

  function startCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach((root) => {
      tickCountdown(root);
      if (!root.dataset.timer) {
        root.dataset.timer = "1";
        setInterval(() => tickCountdown(root), 1000);
      }
    });
  }

  function bindUploads(scope) {
    (scope || document).querySelectorAll("[data-upload-input]").forEach((input) => {
      input.addEventListener("change", () => {
        const label = input.form?.querySelector("[data-upload-name]");
        if (label) label.textContent = input.files?.[0]?.name || "No file selected";
      });
    });
  }

  document.addEventListener("htmx:afterSwap", (event) => {
    bindUploads(event.target);
    startCountdowns();
  });
  function markActiveTabs() {
    const url = new URL(window.location.href);
    const tab = url.searchParams.get("tab");
    if (!tab) return;
    document.querySelectorAll(".profile-tab, .results-tab-btn").forEach((link) => {
      const href = link.getAttribute("href") || "";
      link.classList.toggle("is-active", href.includes(`tab=${tab}`));
    });
  }

  document.addEventListener("htmx:afterSwap", markActiveTabs);
  document.addEventListener("DOMContentLoaded", () => {
    bindUploads(document);
    startCountdowns();
    markActiveTabs();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("/static/sw.js").catch(() => {});
    });
  }
})();
