// Daily App: the busy page family members open from a personal busy link (busy.html#<token>).
// No account: it asks the account server for busy blocks only (day, part of the day, time, the day it was approved),
// never titles or details. The token sits after "#", so it isn't sent to the web server in the address.
"use strict";

(() => {
  const cfg = window.DAILY_CONFIG;
  const PARTS = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
  const $ = id => document.getElementById(id);
  const token = decodeURIComponent(location.hash.replace(/^#/, "")).trim();

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;   // textContent: nothing from the server runs as code
    return node;
  }

  const dayKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function dayLabel(day) {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);   // calendar day, safe on the night clocks change
    if (day === dayKey(today)) return "Today";
    if (day === dayKey(tomorrow)) return "Tomorrow";
    return new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  }

  function timeLabel(time) {
    if (!time) return "";
    const [h, m] = time.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  async function rpc(name, body) {
    const res = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: cfg.key, Authorization: "Bearer " + cfg.key },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("server answered " + res.status);
    return res.json();
  }

  function message(title, text) {
    $("busy-sub").textContent = "";
    const card = el("div", "card");
    card.append(el("h2", "", title), el("p", "muted", text));
    $("busy-root").replaceChildren(card);
  }

  async function start() {
    if (token.length < 32) {
      message("This link is incomplete", "Ask for the link again and open it exactly as sent.");
      return;
    }
    let blocks, name;
    try {
      [blocks, name] = await Promise.all([rpc("busy_blocks", { p_token: token }), rpc("busy_link_name", { p_token: token })]);
    } catch (e) {
      message("Can't load right now", navigator.onLine ? "Try again in a minute." : "You're offline. Try again when you have signal.");
      return;
    }
    if (name) {
      $("busy-title").textContent = `When ${name} is busy`;
      document.title = `When ${name} is busy`;
    }
    const today = dayKey(new Date());
    blocks = (blocks || []).filter(b => b.day >= today);
    if (!blocks.length && !name) {
      message("This link isn't active", "It was turned off or replaced. Ask for the new link.");
      return;
    }
    $("busy-sub").textContent = "Agreed plans for the next 3 months. Any other time: free, as far as Daily knows.";
    if (!blocks.length) {
      message("No plans coming up", "Nothing is booked in the next 3 months.");
      $("busy-sub").textContent = "";
      return;
    }

    const byDay = new Map();
    for (const b of blocks) {
      if (!byDay.has(b.day)) byDay.set(b.day, []);
      byDay.get(b.day).push(b);
    }
    const list = [];
    for (const [day, items] of byDay) {
      const card = el("div", "card busy-day");
      card.append(el("h2", "", dayLabel(day)));
      for (const b of items) {
        const row = el("div", "busy-row");
        row.append(el("span", "busy-when", "Busy · " + PARTS[b.part] + (b.exact_time ? " · " + timeLabel(b.exact_time) : "")));
        if (b.booked_on) {
          const booked = new Date(b.booked_on + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
          row.append(el("span", "muted small", "booked " + booked));
        }
        card.append(row);
      }
      list.push(card);
    }
    $("busy-root").replaceChildren(...list);
  }

  start();
})();
