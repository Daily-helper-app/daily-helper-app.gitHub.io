// Daily App: the "Us" tab. Draws what together.js holds: plans waiting for you on top, then plans you sent,
// what's coming up, the shared list, and past plans. All text from the database is shown with textContent.
"use strict";

const UsView = (() => {
  const PART_LABELS = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
  let openForm = null;     // "suggest", or a plan id whose "Other time" form is open
  let message = "";        // a short note under the heading (e.g. an error from the last action)
  let invite = null;       // { code } after making an invite
  let draft = null;        // what was typed in the open plan form, kept when the screen redraws (e.g. after an error)
  let busy = false;
  let pending = false;     // live data arrived while a form was open: redraw once it closes

  // Small helper: el("div", { className: "x", onclick: f }, child, "text")
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else if (k === "className") node.className = v;
      else if (v !== undefined && v !== null && v !== false) node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c);
    return node;
  }

  function dayLabel(day) {
    if (!day) return "";
    const t = dayKey();
    const tomorrow = dayKey(Date.now() + 86400000);
    if (day === t) return "Today";
    if (day === tomorrow) return "Tomorrow";
    return new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function timeLabel(time) {
    if (!time) return "";
    const [h, m] = time.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  const whenText = p => [dayLabel(p.day), (PART_LABELS[p.part] || "").toLowerCase(), timeLabel(p.exact_time)]
    .filter(Boolean).join(" · ");

  const lastNote = id => {
    const withNote = Together.events(id).filter(e => e.note);
    return withNote.length ? withNote[withNote.length - 1] : null;
  };

  // Runs an action, shows its message (empty = fine), and redraws
  async function act(fn) {
    if (busy) return;
    busy = true;
    try {
      const result = await fn();
      message = typeof result === "string" ? result : "";
      if (message) {
        const shown = message;
        setTimeout(() => { if (message === shown) { message = ""; draw(); } }, 8000);
      }
    } finally {
      busy = false;
      draw(true);
    }
  }

  function closeForm() {
    openForm = null;
    draft = null;
    draw(true);
  }

  // ---------- Pieces ----------

  // Day + part of the day + optional time + note; used to suggest a plan and to suggest another time
  function planFields(withTitle, startDay) {
    const d = draft || {};
    const title = withTitle ? el("input", { type: "text", maxlength: 200, placeholder: "What? (e.g. dinner out)", "aria-label": "Plan", value: d.title || "" }) : null;
    const day = el("input", { type: "date", value: d.day || startDay || dayKey(), min: dayKey(), "aria-label": "Day" });
    let part = d.part || currentPart();
    const partBtns = Object.entries(PART_LABELS).map(([id, label]) => {
      const b = el("button", { type: "button", className: id === part ? "on" : "" }, label);
      b.addEventListener("click", () => {
        part = id;
        for (const x of partBtns) x.className = x === b ? "on" : "";
      });
      return b;
    });
    const time = el("input", { type: "time", "aria-label": "Time (optional)", value: d.time || "" });
    const note = el("input", { type: "text", maxlength: 200, placeholder: "Note (optional)", "aria-label": "Note", value: d.note || "" });
    const node = el("div", { className: "plan-fields" },
      title, day, el("div", { className: "move" }, partBtns),
      el("label", { className: "muted small" }, "Time (optional) ", time), note);
    return { node, get: () => ({ title: title && title.value, day: day.value, part, time: time.value, note: note.value }) };
  }

  function waitingCard(p) {
    const n = lastNote(p.id);
    const card = el("div", { className: "plan-card" },
      el("div", { className: "plan-title" }, p.title),
      el("div", { className: "muted" }, whenText(p)),
      el("div", { className: "muted small" }, "From " + Together.nameOf(p.last_by) + (n ? ' · "' + n.note + '"' : "")));
    if (openForm === p.id) {
      const f = planFields(false, p.day);
      card.append(f.node, el("div", { className: "btn-row" },
        el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
          draft = f.get();
          const err = await Together.answerPlan(p.id, "countered", draft);
          if (!err) { openForm = null; draft = null; }
          return err;
        }) }, "Send other time"),
        el("button", { type: "button", className: "btn", onclick: closeForm }, "Cancel")));
    } else {
      card.append(el("div", { className: "btn-row three" },
        el("button", { type: "button", className: "btn primary", onclick: () => act(() => Together.answerPlan(p.id, "approved")) }, "Approve"),
        el("button", { type: "button", className: "btn", onclick: () => { openForm = p.id; draft = null; draw(true); } }, "Other time"),
        el("button", { type: "button", className: "btn", onclick: () => act(() => {
          const note = prompt("Decline this plan? Add a short reason if you like (optional):", "");
          if (note === null) return "";
          return Together.answerPlan(p.id, "declined", { note });
        }) }, "Decline")));
    }
    card.append(history(p));
    return card;
  }

  function sentCard(p) {
    const partner = Together.partner();
    return el("div", { className: "plan-card quiet" },
      el("div", { className: "plan-title" }, p.title),
      el("div", { className: "muted" }, whenText(p)),
      el("div", { className: "muted small" }, "Waiting for " + (partner ? partner.name || "them" : "them")),
      el("button", { type: "button", className: "text-btn", onclick: () => act(() => {
        if (!confirm("Take this suggestion back?")) return "";
        return Together.answerPlan(p.id, "declined", { note: "taken back" });
      }) }, "Take back"),
      history(p));
  }

  function history(p) {
    const evs = Together.events(p.id);
    if (!evs.length) return null;
    const words = { suggested: "suggested", countered: "suggested another time", approved: "approved",
      declined: "declined", expired: "expired (no answer)" };
    return el("details", { className: "history" },
      el("summary", {}, "History"),
      el("ul", {}, evs.map(e => el("li", {},
        (e.actor ? (e.actor === Together.myId() ? "You" : Together.nameOf(e.actor)) + " " : "") + words[e.action] +
        (e.action === "suggested" || e.action === "countered" ? " " + whenText(e) : "") +
        (e.note ? ' · "' + e.note + '"' : "") +
        " · " + new Date(e.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })))));
  }

  function taskRowShared(t) {
    const li = el("li", { className: "item" + (t.done ? " done" : "") });
    const check = el("button", { type: "button", className: "check", "aria-label": t.done ? "Mark not done" : "Mark done",
      onclick: () => Together.toggleTask(t.id) });
    check.innerHTML = "<span>" + CHECK_SVG + "</span>";   // fixed icon only, never task text
    const text = el("span", { className: "text", onclick: () => {
      const v = prompt("Change task:", t.title);
      if (v !== null) Together.renameTask(t.id, v);
    } }, t.title);
    if (t.done && t.done_by) text.append(el("span", { className: "by" }, " · " + (t.done_by === Together.myId() ? "you" : Together.nameOf(t.done_by))));
    const del = el("button", { type: "button", className: "del", "aria-label": "Delete task",
      onclick: () => { if (confirm("Delete this shared task for both of you?")) Together.deleteTask(t.id); } }, "×");
    li.append(check, text, del);
    return li;
  }

  // ---------- Screens ----------

  function setupScreen(root) {
    if (!Together.myName()) {
      const name = el("input", { type: "text", maxlength: 40, placeholder: "Your first name", "aria-label": "Your name" });
      root.append(el("div", { className: "card" },
        el("h2", {}, "What should we call you?"),
        el("p", { className: "muted" }, "The other person sees this name on plans and shared tasks."),
        el("form", { className: "account-form", onsubmit: e => { e.preventDefault(); act(() => Together.setName(name.value)); } },
          name, el("button", { type: "submit", className: "btn primary" }, "Save"))));
      return;
    }
    const code = el("input", { type: "text", maxlength: 6, placeholder: "6-letter code", "aria-label": "Invite code",
      autocapitalize: "characters", spellcheck: "false" });
    root.append(
      el("div", { className: "card" },
        el("h2", {}, "Share with someone"),
        el("p", { className: "muted" }, "One of you starts a shared space and gets a code. The other types the code."),
        el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
          const r = await Together.createGroup();
          invite = r.code ? r : null;
          return r.error || "";
        }) }, "Start a shared space")),
      el("div", { className: "card" },
        el("h2", {}, "I have a code"),
        el("form", { className: "account-form", onsubmit: e => { e.preventDefault(); act(() => Together.joinGroup(code.value)); } },
          code, el("button", { type: "submit", className: "btn" }, "Join"))));
  }

  function inviteCard() {
    return el("div", { className: "card invite" },
      el("h2", {}, "Invite the other person"),
      invite
        ? [el("p", { className: "code" }, invite.code),
           el("p", { className: "muted" }, "They sign in, open Us, tap \"I have a code\" and type this. Works once, for 24 hours.")]
        : el("p", { className: "muted" }, "Make a code and give it to them in person or by text."),
      el("button", { type: "button", className: "btn", onclick: () => act(async () => {
        const r = await Together.makeInvite();
        invite = r.code ? r : invite;
        return r.error || "";
      }) }, invite ? "Make a new code" : "Make a code"));
  }

  function mainScreen(root) {
    const L = Together.lists();
    const partner = Together.partner();

    if (!partner) root.append(inviteCard());

    if (L.waiting.length) {
      root.append(el("h3", { className: "us-head" }, "Waiting for you · " + L.waiting.length), ...L.waiting.map(waitingCard));
    }

    // Suggest a plan
    if (partner) {
      if (openForm === "suggest") {
        const f = planFields(true);
        root.append(el("div", { className: "card" },
          el("h2", {}, "Suggest a plan"), f.node,
          el("div", { className: "btn-row" },
            el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
              draft = f.get();
              const err = await Together.suggestPlan(draft);
              if (!err) { openForm = null; draft = null; }
              return err;
            }) }, "Send to " + (partner.name || "them")),
            el("button", { type: "button", className: "btn", onclick: closeForm }, "Cancel"))));
      } else {
        root.append(el("button", { type: "button", className: "btn primary suggest", onclick: () => { openForm = "suggest"; draft = null; draw(true); } },
          "+ Suggest a plan"));
      }
    }

    if (L.outbox.length) {
      root.append(el("h3", { className: "us-head" }, "Not sent yet"),
        ...L.outbox.map(o => el("div", { className: "plan-card quiet" },
          el("div", { className: "plan-title" }, o.p_title),
          el("div", { className: "muted small" }, "Sends when you're back online."))));
    }
    if (L.sent.length) root.append(el("h3", { className: "us-head" }, "Sent"), ...L.sent.map(sentCard));
    if (L.upcoming.length) {
      root.append(el("h3", { className: "us-head" }, "Coming up"),
        el("ul", { className: "list" }, L.upcoming.map(p => el("li", { className: "item plan-row" },
          el("span", { className: "text" }, p.title, el("span", { className: "by" }, " · " + whenText(p)))))));
    }

    // Shared list
    const input = el("input", { id: "us-add", type: "text", maxlength: 200, placeholder: "Add to the shared list", "aria-label": "New shared task", enterkeyhint: "done" });
    root.append(el("h3", { className: "us-head" }, "Together list"),
      el("form", { className: "add", autocomplete: "off", onsubmit: e => {
        e.preventDefault();
        Together.addTask(input.value, null);
        input.value = "";
      } }, input, el("button", { type: "submit", className: "add-btn", "aria-label": "Add shared task" }, "+")));
    const open = L.tasks.filter(t => !t.done), done = L.tasks.filter(t => t.done);
    if (L.tasks.length) root.append(el("ul", { className: "list" }, [...open, ...done].map(taskRowShared)));
    else root.append(el("p", { className: "muted" }, "Nothing shared yet. Anything added here shows on both phones."));

    if (L.past.length) {
      root.append(el("details", { className: "card past" },
        el("summary", {}, "Past plans · " + L.past.length),
        L.past.map(p => el("div", { className: "plan-card quiet" },
          el("div", { className: "plan-title" }, p.title),
          el("div", { className: "muted small" }, whenText(p) + " · " + p.status),
          history(p)))));
    }
  }

  // ---------- Drawing ----------

  // force = the person tapped something here. Live updates (force false) wait while a form is open or someone is
  // typing, so nothing they typed disappears; the badge still updates.
  function draw(force = false) {
    const root = $("us-root");
    if (!root) return;
    const active = document.activeElement;
    const typing = active && root.contains(active) && active.matches("input") && active.id !== "us-add";
    if (!force && (typing || openForm)) { pending = true; drawBadge(); return; }
    pending = false;
    // The shared list's add box survives redraws, so several tasks can be added in a row
    const addBox = $("us-add");
    const keepAdd = addBox && document.activeElement === addBox ? addBox.value : null;
    root.replaceChildren();
    const status = !Together.signedIn() ? "" : (Together.error() || (Together.online() ? "" : "Showing the last saved copy."));
    if (message || status) root.append(el("p", { className: "us-msg" }, message || status));

    if (!Together.signedIn()) {
      root.append(el("div", { className: "card" },
        el("h2", {}, "Share with someone"),
        el("p", { className: "muted" }, "Sign in first (Settings → Account). Then plans and a shared list show here."),
        el("button", { type: "button", className: "btn primary", onclick: () => showView("settings") }, "Go to Settings")));
    } else if (!Together.group() || !Together.myName()) {
      setupScreen(root);
    } else {
      mainScreen(root);
    }
    const newAdd = $("us-add");
    if (keepAdd !== null && newAdd) { newAdd.value = keepAdd; newAdd.focus(); }
    drawBadge();
  }

  function drawBadge() {
    const n = Together.signedIn() ? Together.waitingCount() : 0;
    const badge = $("us-count");
    badge.textContent = n;
    badge.hidden = n === 0;
  }

  function init() {
    Together.onChange(() => draw());
    // Typing finished: catch up on anything that arrived meanwhile
    const root = $("us-root");
    root.addEventListener("focusout", () => setTimeout(() => {
      if (pending && !root.contains(document.activeElement)) draw();
    }, 300));
    draw(true);
  }

  return { init, draw };
})();

UsView.init();
