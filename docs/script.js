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
    const intro = $("hc-intro");
    const approval = $("hc-approval");
    const kindEl = $("hc-kind");
    const targetEl = $("hc-target");
    const sqlEl = $("hc-sql");
    const status = $("hc-approval-status");
    const approve = $("hc-approve");
    const reject = $("hc-reject");
    const typing2 = $("hc-typing2");
    const result = $("hc-result");

    // 15 prepared scenarios — INSERT, UPDATE and DELETE flavours. Each
    // pairs a plausible NL prompt with a coherent agent intro, SQL
    // statement, success line and rejection line. Picked at random per
    // loop (last index avoided so back-to-back picks differ).
    const SCENARIOS = [
      {
        user: "Add a new customer: Acme Pro — email acme.pro@example.com",
        intro: "I'll insert this record into <code>public.customers</code>. Because it's a write, I need your approval before running it.",
        kind: "INSERT", target: "public.customers",
        sql: `<span class="kw">INSERT INTO</span> public.customers (name, email)
<span class="kw">VALUES</span> (<span class="str">'Acme Pro'</span>, <span class="str">'acme.pro@example.com'</span>);`,
        success: "✓ Done — 1 row inserted into public.customers.",
        rejected: "Got it — no changes were made.",
      },
      {
        user: "Create order #4821 for customer 19, total 248.90",
        intro: "I'll add the order to <code>public.orders</code>. Approve to run.",
        kind: "INSERT", target: "public.orders",
        sql: `<span class="kw">INSERT INTO</span> public.orders (id, customer_id, total)
<span class="kw">VALUES</span> (<span class="str">4821</span>, <span class="str">19</span>, <span class="str">248.90</span>);`,
        success: "✓ Done — order 4821 created.",
        rejected: "Cancelled — no order was created.",
      },
      {
        user: "Register a new product: 'USB-C Hub', SKU 'HUB-001', price 79.00",
        intro: "I'll add it to <code>public.products</code>. Waiting for your approval.",
        kind: "INSERT", target: "public.products",
        sql: `<span class="kw">INSERT INTO</span> public.products (name, sku, price)
<span class="kw">VALUES</span> (<span class="str">'USB-C Hub'</span>, <span class="str">'HUB-001'</span>, <span class="str">79.00</span>);`,
        success: "✓ Done — product HUB-001 created.",
        rejected: "Ok — no product was added.",
      },
      {
        user: "Hire João Mendes as engineer, hired today, salary 12000",
        intro: "I'll insert the new hire into <code>public.employees</code>.",
        kind: "INSERT", target: "public.employees",
        sql: `<span class="kw">INSERT INTO</span> public.employees (name, role, hired_at, salary)
<span class="kw">VALUES</span> (<span class="str">'João Mendes'</span>, <span class="str">'engineer'</span>, <span class="fn">CURRENT_DATE</span>, <span class="str">12000</span>);`,
        success: "✓ Done — employee record created.",
        rejected: "Cancelled — no employee was added.",
      },
      {
        user: "Log a payment of 248.90 for order 4821, method credit_card",
        intro: "I'll record the payment in <code>public.payments</code>.",
        kind: "INSERT", target: "public.payments",
        sql: `<span class="kw">INSERT INTO</span> public.payments (order_id, amount, method)
<span class="kw">VALUES</span> (<span class="str">4821</span>, <span class="str">248.90</span>, <span class="str">'credit_card'</span>);`,
        success: "✓ Done — payment recorded.",
        rejected: "Cancelled — payment was not stored.",
      },
      {
        user: "Change Acme Pro's email to billing@acme.pro",
        intro: "I'll update the customer's email in <code>public.customers</code>. Approve to run.",
        kind: "UPDATE", target: "public.customers",
        sql: `<span class="kw">UPDATE</span> public.customers
<span class="kw">SET</span> email = <span class="str">'billing@acme.pro'</span>
<span class="kw">WHERE</span> name = <span class="str">'Acme Pro'</span>;`,
        success: "✓ Done — 1 row updated in public.customers.",
        rejected: "Ok — the email was left as-is.",
      },
      {
        user: "Raise the price of SKU 'HUB-001' to 89.00",
        intro: "I'll bump the price in <code>public.products</code>.",
        kind: "UPDATE", target: "public.products",
        sql: `<span class="kw">UPDATE</span> public.products
<span class="kw">SET</span> price = <span class="str">89.00</span>
<span class="kw">WHERE</span> sku = <span class="str">'HUB-001'</span>;`,
        success: "✓ Done — 1 row updated, new price 89.00.",
        rejected: "Cancelled — price unchanged.",
      },
      {
        user: "Mark order 4821 as shipped",
        intro: "I'll flip the status in <code>public.orders</code>.",
        kind: "UPDATE", target: "public.orders",
        sql: `<span class="kw">UPDATE</span> public.orders
<span class="kw">SET</span> status = <span class="str">'shipped'</span>, shipped_at = <span class="fn">NOW</span>()
<span class="kw">WHERE</span> id = <span class="str">4821</span>;`,
        success: "✓ Done — order 4821 marked as shipped.",
        rejected: "Ok — order status unchanged.",
      },
      {
        user: "Promote user 42 to admin role",
        intro: "I'll update the role in <code>public.users</code>. Approve to run.",
        kind: "UPDATE", target: "public.users",
        sql: `<span class="kw">UPDATE</span> public.users
<span class="kw">SET</span> role = <span class="str">'admin'</span>
<span class="kw">WHERE</span> id = <span class="str">42</span>;`,
        success: "✓ Done — user 42 is now admin.",
        rejected: "Ok — user role unchanged.",
      },
      {
        user: "Decrease stock of SKU 'HUB-001' by 5 units",
        intro: "I'll adjust the on-hand quantity in <code>public.inventory</code>.",
        kind: "UPDATE", target: "public.inventory",
        sql: `<span class="kw">UPDATE</span> public.inventory
<span class="kw">SET</span> quantity = quantity - <span class="str">5</span>
<span class="kw">WHERE</span> sku = <span class="str">'HUB-001'</span>;`,
        success: "✓ Done — 1 row updated, stock reduced by 5.",
        rejected: "Cancelled — stock untouched.",
      },
      {
        user: "Flag customer 'Initech' as churned",
        intro: "I'll set the churn flag in <code>public.customers</code>.",
        kind: "UPDATE", target: "public.customers",
        sql: `<span class="kw">UPDATE</span> public.customers
<span class="kw">SET</span> status = <span class="str">'churned'</span>, churned_at = <span class="fn">NOW</span>()
<span class="kw">WHERE</span> name = <span class="str">'Initech'</span>;`,
        success: "✓ Done — Initech marked as churned.",
        rejected: "Ok — no change applied.",
      },
      {
        user: "Delete inactive users who haven't logged in for 12 months",
        intro: "Heads up: this removes records permanently. Review and approve to run.",
        kind: "DELETE", target: "public.users",
        sql: `<span class="kw">DELETE FROM</span> public.users
<span class="kw">WHERE</span> last_login &lt; <span class="fn">NOW</span>() - <span class="kw">INTERVAL</span> <span class="str">'12 months'</span>;`,
        success: "✓ Done — 138 rows deleted from public.users.",
        rejected: "Cancelled — no users were removed.",
      },
      {
        user: "Wipe application logs older than 90 days",
        intro: "This is a destructive purge of <code>public.logs</code>. Approve to proceed.",
        kind: "DELETE", target: "public.logs",
        sql: `<span class="kw">DELETE FROM</span> public.logs
<span class="kw">WHERE</span> created_at &lt; <span class="fn">NOW</span>() - <span class="kw">INTERVAL</span> <span class="str">'90 days'</span>;`,
        success: "✓ Done — 24,318 rows deleted from public.logs.",
        rejected: "Cancelled — logs were preserved.",
      },
      {
        user: "Cancel and remove order 4821",
        intro: "This deletes the order row in <code>public.orders</code>. Approve only if intentional.",
        kind: "DELETE", target: "public.orders",
        sql: `<span class="kw">DELETE FROM</span> public.orders
<span class="kw">WHERE</span> id = <span class="str">4821</span>;`,
        success: "✓ Done — order 4821 removed.",
        rejected: "Cancelled — the order is still there.",
      },
      {
        user: "Purge expired sessions",
        intro: "I'll clear expired rows from <code>public.sessions</code>. Approve to run.",
        kind: "DELETE", target: "public.sessions",
        sql: `<span class="kw">DELETE FROM</span> public.sessions
<span class="kw">WHERE</span> expires_at &lt; <span class="fn">NOW</span>();`,
        success: "✓ Done — 5,071 rows deleted from public.sessions.",
        rejected: "Cancelled — sessions table left intact.",
      },
    ];
    let lastScenarioIdx = -1;
    function pickScenario() {
      let idx;
      do {
        idx = Math.floor(Math.random() * SCENARIOS.length);
      } while (SCENARIOS.length > 1 && idx === lastScenarioIdx);
      lastScenarioIdx = idx;
      return SCENARIOS[idx];
    }
    function renderScenario(s) {
      user.textContent = s.user;
      intro.innerHTML = s.intro;
      kindEl.textContent = s.kind;
      targetEl.textContent = s.target;
      sqlEl.innerHTML = s.sql;
      approval.dataset.kind = s.kind.toLowerCase();
      // Stash the outcome copy on the approval card so the click
      // handlers don't need to capture closures over the scenario.
      approval.dataset.success = s.success;
      approval.dataset.rejected = s.rejected;
    }

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
      renderScenario(pickScenario());
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
        result.textContent = approval.dataset.success || "";
        show(result);
      } else {
        approval.dataset.state = "rejected";
        status.textContent = "";
        result.textContent = approval.dataset.rejected || "";
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
