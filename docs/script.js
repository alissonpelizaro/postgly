(() => {
  const root = document.documentElement;
  const STORAGE_KEY = "postgly-theme";

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") {
    root.setAttribute("data-theme", stored);
  } else {
    const prefersLight = window.matchMedia("(prefers-color-scheme: light)").matches;
    root.setAttribute("data-theme", prefersLight ? "light" : "dark");
  }

  const toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      localStorage.setItem(STORAGE_KEY, next);
    });
  }

  const yearEl = document.getElementById("year");
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const lightbox = document.getElementById("lightbox");
  if (lightbox) {
    const imgEl = lightbox.querySelector(".lightbox-img");
    const capEl = lightbox.querySelector(".lightbox-cap");
    const closeBtn = lightbox.querySelector(".lightbox-close");

    const open = (src, alt, cap) => {
      imgEl.src = src;
      imgEl.alt = alt || "";
      capEl.textContent = cap || "";
      lightbox.classList.add("is-open");
      lightbox.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
    };

    const close = () => {
      lightbox.classList.remove("is-open");
      lightbox.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      imgEl.src = "";
    };

    document.querySelectorAll("a[data-lightbox]").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const img = a.querySelector("img");
        const fig = a.closest("figure");
        const cap = fig ? fig.querySelector("figcaption") : null;
        open(a.getAttribute("href"), img ? img.alt : "", cap ? cap.textContent : "");
      });
    });

    lightbox.addEventListener("click", (e) => {
      if (e.target === lightbox || e.target === closeBtn) close();
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && lightbox.classList.contains("is-open")) close();
    });
  }
})();
