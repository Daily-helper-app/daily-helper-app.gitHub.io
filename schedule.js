// Daily App: the Schedule tab (family schedule step 3). A month strip with a dot per busy person and a day-by-day
// agenda, for you and everyone who shares a space with you. Plans you're in show their name; other people's plans
// show only as "busy", and only if they let you see it (supabase/family-3.sql + family-4.sql decide this on the
// server). Tap one name to see that person's calendar, or 2+ names to see the days when all of them are free.
// Look picked by the user on 2026-10-28: month + agenda, inspired by Outlook (not a copy).
"use strict";

const Schedule = (() => {
  const PARTS = ["morning", "afternoon", "evening"];
  const PART_LABELS = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
  const COLORS = ["#e0703a", "#2f9e6e", "#c2408f", "#c99a06", "#3a8fe0", "#8a5cd6", "#d64545", "#3aa3a3"];

  let monthStart = firstOfMonth(new Date());
  let selectedDay = dayKey();
  const picked = new Set();      // people ids; empty = everyone
  let blocks = [];               // rows from schedule_blocks() for the 6 weeks on screen
  let people = [];               // { id, name } for you and everyone who shares a space with you
  let loadedFor = "";            // the first day of the 6 weeks the blocks are for
  let loadToken = 0;
  let error = "";

  // Small helper (same as together-view.js): el("div", { className: "x", onclick: f }, child, "text")
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "className") node.className = v;
      else if (k === "style") node.style.cssText = v;   // through the style object: the page's safety rules block style text
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function firstOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1, 12); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  const keyOf = d => dayKey(d.getTime());
  // The 6 weeks on screen start on the Sunday on or before the 1st (US calendars start on Sunday)
  const gridStart = () => addDays(monthStart, -monthStart.getDay());

  function timeLabel(time) {
    if (!time) return "";
    const [h, m] = time.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const me = () => Together.myId();
  const nameOf = id => id === me() ? "You" : ((people.find(p => p.id === id) || {}).name || "Someone");
  // A color per person that stays the same between loads (you are the app's accent color)
  function colorOf(id) {
    if (id === me()) return "var(--accent)";
    let h = 0;
    for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return COLORS[h % COLORS.length];
  }

  // Busy = a plan this person is going to (or a "busy" block you may see); waiting answers don't block time
  const blocksTime = b => b.status === "busy" || b.answer === "going";
  const shownPeople = () => picked.size ? [...picked] : people.map(p => p.id);

  // ---------- Loading ----------

  async function load(force = false) {
    const client = typeof Sync !== "undefined" && Sync.getClient();
    if (!client || !Together.signedIn()) { blocks = []; people = []; draw(); return; }
    const from = keyOf(gridStart());
    if (!force && from === loadedFor) { draw(); return; }
    const token = ++loadToken;
    const [rows, profiles] = await Promise.all([
      client.rpc("schedule_blocks", { p_from: from, p_days: 42 }),
      client.from("profiles").select("id,display_name"),   // the rules return you + people you share a space with
    ]);
    if (token !== loadToken) return;   // a newer load (another month) started meanwhile
    if (rows.error || profiles.error) {
      const m = ((rows.error || profiles.error).message || "");
      error = /schedule_blocks|function/i.test(m) && !/fetch/i.test(m)
        ? "The Schedule turns on once the account server's update runs (it needs the owner's sign-in)."
        : (navigator.onLine ? "Couldn't load the schedule. Try again in a moment." : "You're offline. The schedule needs signal.");
      if (m) console.warn("Daily: schedule load:", m);
      draw();
      return;
    }
    error = "";
    blocks = rows.data || [];
    people = (profiles.data || []).map(p => ({ id: p.id, name: p.display_name || "" }))
      .sort((a, b) => (a.id === me() ? -1 : b.id === me() ? 1 : a.name.localeCompare(b.name)));
    for (const id of [...picked]) if (!people.some(p => p.id === id)) picked.delete(id);
    loadedFor = from;
    draw();
  }

  // ---------- What's on a day ----------

  // For the people on screen: plans you're in (one row per plan) and busy blocks (one row per person)
  function entriesOn(day) {
    const shown = new Set(shownPeople());
    const today = blocks.filter(b => b.day === day);
    const plans = new Map();
    const busy = [];
    for (const b of today) {
      if (b.item_id) {
        if (!plans.has(b.item_id)) plans.set(b.item_id, { ...b, going: [], waiting: [] });
        plans.get(b.item_id)[b.answer === "going" ? "going" : "waiting"].push(b.user_id);
      } else if (shown.has(b.user_id)) busy.push(b);
    }
    const planRows = [...plans.values()].filter(p => [...p.going, ...p.waiting].some(id => shown.has(id)));
    const order = r => PARTS.indexOf(r.part) * 10000 + (r.exact_time ? Number(r.exact_time.slice(0, 2)) * 60 + Number(r.exact_time.slice(3, 5)) : 0);
    return [...planRows, ...busy].sort((a, b) => order(a) - order(b));
  }

  // Parts of the day when every picked person is free (compare mode)
  function freeParts(day) {
    const ids = new Set(shownPeople());
    return PARTS.filter(part => !blocks.some(b => b.day === day && b.part === part && ids.has(b.user_id) && blocksTime(b)));
  }

  // People with something that day, for the dots
  function busyPeopleOn(day) {
    const shown = new Set(shownPeople());
    return [...new Set(blocks.filter(b => b.day === day && shown.has(b.user_id) && (blocksTime(b) || b.answer === "waiting"))
      .map(b => b.user_id))];
  }

  // ---------- Drawing ----------

  function draw() {
    const root = $("schedule-root");
    if (!root) return;
    root.replaceChildren();
    if (!Together.signedIn()) {
      root.append(el("div", { className: "card" }, el("h2", {}, "See when everyone is free"),
        el("p", { className: "muted" }, "Sign in first (Settings → Account). Then your plans and your family's busy times show here."),
        el("button", { type: "button", className: "btn primary", onclick: () => showView("settings") }, "Go to Settings")));
      return;
    }
    if (error) root.append(el("p", { className: "us-msg", role: "status" }, error));
    root.append(header(), chips(), compareLine(), month(), agenda(),
      el("p", { className: "muted small sched-foot" }, "Busy = a plan someone said Going to. You see what a plan is only " +
        "if you're in it. Striped = still waiting for answers."));
  }

  function header() {
    const label = monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    // Another month: the agenda starts on its 1st (or today, in this month)
    const go = n => () => {
      monthStart = firstOfMonth(new Date(monthStart.getFullYear(), monthStart.getMonth() + n, 1, 12));
      const now = new Date();
      selectedDay = monthStart.getMonth() === now.getMonth() && monthStart.getFullYear() === now.getFullYear()
        ? dayKey() : keyOf(monthStart);
      load();
    };
    return el("div", { className: "sched-head" },
      el("button", { type: "button", className: "navbtn", "aria-label": "Previous month", onclick: go(-1) }, "‹"),
      el("b", {}, label),
      el("button", { type: "button", className: "navbtn", "aria-label": "Next month", onclick: go(1) }, "›"),
      el("button", { type: "button", className: "navbtn today-btn", onclick: () => {
        monthStart = firstOfMonth(new Date()); selectedDay = dayKey(); load();
      } }, "Today"));
  }

  // "Everyone" plus one chip per person: tap one to see their calendar, tap more to compare
  function chips() {
    const chip = (label, on, onclick, color) => el("button", { type: "button", className: "space-chip" + (on ? " on" : ""),
      "aria-pressed": on ? "true" : "false", onclick },
      color ? el("span", { className: "dot", style: "background:" + color }) : null, label);
    return el("div", { className: "space-bar sched-people" },
      chip("Everyone", picked.size === 0, () => { picked.clear(); draw(); }),
      people.map(p => chip(p.id === me() ? "You" : (p.name || "Someone"), picked.has(p.id),
        () => { picked.has(p.id) ? picked.delete(p.id) : picked.add(p.id); draw(); }, colorOf(p.id))));
  }

  function compareLine() {
    if (picked.size === 0) return el("p", { className: "muted small" }, "Everyone you share a space with. Tap a name to see only them.");
    if (picked.size === 1) {
      const id = [...picked][0];
      return el("p", { className: "muted small" }, (id === me() ? "Your" : nameOf(id) + "'s") + " calendar. Tap another name to compare.");
    }
    return el("p", { className: "muted small" }, el("span", { className: "sw free-all" }), " all " + picked.size + " free all day · ",
      el("span", { className: "sw free-some" }), " free part of the day");
  }

  function month() {
    const start = gridStart();
    const thisMonth = monthStart.getMonth();
    const today = dayKey();
    const grid = el("div", { className: "sched-month", role: "grid" },
      ["S", "M", "T", "W", "T", "F", "S"].map(d => el("div", { className: "wd", "aria-hidden": "true" }, d)));
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const key = keyOf(d);
      if (i === 35 && d.getMonth() !== thisMonth) break;   // a month that fits in 5 weeks
      const who = busyPeopleOn(key);
      let cls = "day";
      if (d.getMonth() !== thisMonth) cls += " other";
      if (key === today) cls += " today";
      if (key === selectedDay) cls += " sel";
      let freeNote = "";
      if (picked.size > 1 && key >= today) {   // free time only matters from today on
        const free = freeParts(key).length;
        if (free === 3) { cls += " free-all"; freeNote = ", all free"; }
        else if (free) { cls += " free-some"; freeNote = ", free part of the day"; }
      }
      const label = d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" }) +
        (who.length ? ", " + who.length + (who.length === 1 ? " person" : " people") + " busy" : "") + freeNote;
      grid.append(el("button", { type: "button", className: cls, "aria-label": label, "aria-pressed": key === selectedDay ? "true" : "false",
        onclick: () => { selectedDay = key; draw(); } },
        el("span", { className: "num" }, String(d.getDate())),
        el("span", { className: "dots" }, who.slice(0, 4).map(id => el("i", { style: "background:" + colorOf(id) })),
          who.length > 4 ? el("em", {}, "+" + (who.length - 4)) : null)));
    }
    return grid;
  }

  // Day by day from the selected day to the end of the 6 weeks; days with nothing on them are skipped
  function agenda() {
    const box = el("div", { className: "sched-agenda" });
    const start = gridStart();
    const end = keyOf(addDays(start, 41));
    let shownDays = 0;
    for (let d = new Date(selectedDay + "T12:00"); keyOf(d) <= end && shownDays < 14; d = addDays(d, 1)) {
      const key = keyOf(d);
      const rows = entriesOn(key);
      const free = picked.size > 1 ? freeParts(key) : null;
      if (!rows.length && key !== selectedDay && !(free && free.length)) continue;
      shownDays++;
      const title = key === dayKey() ? "Today" : d.toLocaleDateString(undefined, { weekday: "short" });
      box.append(el("h3", { className: "ag-day" }, title + " ",
        el("span", {}, d.toLocaleDateString(undefined, { month: "short", day: "numeric" })),
        free ? el("span", { className: "ag-free" }, free.length === 3 ? " · all free" :
          free.length ? " · free: " + free.map(p => PART_LABELS[p].toLowerCase()).join(", ") : " · nobody free together") : null));
      if (!rows.length) box.append(el("p", { className: "free" }, "Nothing planned."));
      for (const r of rows) box.append(row(r));
    }
    if (!shownDays) box.append(el("p", { className: "muted" }, "Nothing planned in these weeks."));
    return box;
  }

  function row(r) {
    const when = el("span", { className: "when" }, PART_LABELS[r.part] + (r.exact_time ? " " + timeLabel(r.exact_time) : ""));
    if (!r.item_id) {
      return el("div", { className: "ag" }, el("span", { className: "bar", style: "background:" + colorOf(r.user_id) }), when,
        el("span", { className: "what" }, nameOf(r.user_id) + " · busy"));
    }
    const going = r.going.map(nameOf), waiting = r.waiting.map(nameOf);
    const tentative = r.status === "suggested";
    const mineWaiting = r.waiting.includes(me());
    return el("button", { type: "button", className: "ag plan", onclick: () => openPlan(r) },
      el("span", { className: "bar" + (tentative ? " tent" : ""), style: tentative ? "" : "background:var(--accent)" }), when,
      el("span", { className: "what" }, r.title + (mineWaiting ? " (waiting for you)" : tentative ? " (not on yet)" : ""),
        el("small", {}, [going.length ? going.join(", ") + " going" : "", waiting.length ? waiting.join(", ") + " waiting" : ""]
          .filter(Boolean).join(" · "))));
  }

  // The plan opens on the Us tab, in its own space, with its details showing
  function openPlan(r) {
    if (typeof UsView !== "undefined" && UsView.openPlan) UsView.openPlan(r.item_id, r.group_id);
  }

  function visible() { const v = $("view-schedule"); return v && !v.hidden; }

  function init() {
    const tab = document.querySelector('.tab[data-view="schedule"]');
    if (tab) tab.addEventListener("click", () => load(true));
    // Plans changed (live update, an answer): reload while the tab is on screen
    let timer = 0;
    Together.onChange(() => { if (visible()) { clearTimeout(timer); timer = setTimeout(() => load(true), 400); } });
    if (typeof Sync !== "undefined") Sync.onUserChange(() => {
      blocks = []; people = []; loadedFor = ""; picked.clear(); error = ""; draw();
    });
    draw();
  }

  return { init, load, draw };
})();

Schedule.init();
