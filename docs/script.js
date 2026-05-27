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

  // Hero mock — agent conversation animation. Plays a short loop:
  //   1. user turn fades in
  //   2. typing dots for ~2s
  //   3. agent reply + approval card fades in
  //   4. waits for Approve / Reject (or auto-resets after 15s)
  //   5. on choice, simulates the run and shows a result bubble,
  //      then loops back to step 1 after a beat.
  // Visibility/reduced-motion aware so it doesn't churn off-screen.
  const heroChat = document.getElementById("hero-chat");
  if (heroChat) {
    const $ = (id) => document.getElementById(id);
    const user = $("hc-user");
    const typing1 = $("hc-typing");
    const agent = $("hc-agent");
    const approval = $("hc-approval");
    const status = $("hc-approval-status");
    const approve = $("hc-approve");
    const reject = $("hc-reject");
    const typing2 = $("hc-typing2");
    const result = $("hc-result");

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Two-step show: `.pre-in` puts the element back in the layout at
    // its initial opacity/transform; one frame later `.in` triggers
    // the actual transition. Without this the element jumps from
    // display:none → fully visible with no animation.
    const show = (el) => {
      if (!el) return;
      el.classList.add("pre-in");
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          el.classList.add("in");
          el.classList.remove("pre-in");
        }),
      );
    };
    const hide = (el) => el && el.classList.remove("in", "pre-in");
    const sleep = (ms) => new Promise((r) => setTimeout(r, reducedMotion ? 0 : ms));

    let timers = [];
    let pendingResolve = null;
    const clearTimers = () => {
      timers.forEach(clearTimeout);
      timers = [];
    };
    const delay = (ms) =>
      new Promise((resolve) => {
        const t = setTimeout(resolve, reducedMotion ? 0 : ms);
        timers.push(t);
      });

    const reset = () => {
      clearTimers();
      [user, typing1, agent, typing2, result].forEach(hide);
      approval.removeAttribute("data-state");
      status.textContent = "";
      result.textContent = "";
      pendingResolve = null;
    };

    const waitForChoice = () =>
      new Promise((resolve) => {
        pendingResolve = resolve;
        // Auto-pick "approve" if the visitor doesn't engage — keeps the
        // demo moving for passive viewers.
        const t = setTimeout(() => {
          if (pendingResolve) {
            pendingResolve("approve");
            pendingResolve = null;
          }
        }, reducedMotion ? 0 : 15000);
        timers.push(t);
      });

    const onApprove = () => {
      if (!pendingResolve) return;
      const r = pendingResolve;
      pendingResolve = null;
      r("approve");
    };
    const onReject = () => {
      if (!pendingResolve) return;
      const r = pendingResolve;
      pendingResolve = null;
      r("reject");
    };
    approve.addEventListener("click", onApprove);
    reject.addEventListener("click", onReject);

    let running = false;
    async function play() {
      if (running) return;
      running = true;
      reset();
      await delay(600);
      show(user);
      await delay(700);
      show(typing1);
      await delay(2000);
      hide(typing1);
      show(agent);

      const choice = await waitForChoice();

      if (choice === "approve") {
        approval.dataset.state = "approved";
        status.textContent = "";
        show(typing2);
        await delay(900);
        hide(typing2);
        result.textContent = "✓ Done — 1 row inserted into public.customers.";
        show(result);
      } else {
        approval.dataset.state = "rejected";
        status.textContent = "";
        result.textContent = "Got it — no changes were made.";
        show(result);
      }

      await delay(5000);
      running = false;
      if (heroChat.dataset.paused !== "true") play();
    }

    // Only run when the hero is in view; pause off-screen to keep the
    // page idle and CPU-friendly.
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            heroChat.dataset.paused = "false";
            if (!running) play();
          } else {
            heroChat.dataset.paused = "true";
          }
        }
      },
      { threshold: 0.2 },
    );
    io.observe(heroChat);
  }

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
