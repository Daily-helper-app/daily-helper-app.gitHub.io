// Daily App: the "Us" tab. Draws what together.js holds: plans waiting for you on top, then plans you sent,
// what's coming up, the shared list, the people in the space, and past plans. All text from the database is shown
// with textContent.
"use strict";

const UsView = (() => {
  const PART_LABELS = { morning: "Morning", afternoon: "Afternoon", evening: "Evening" };
  let openForm = null;     // "suggest", or a plan id whose "Other time" form is open
  let message = "";        // a short note under the heading (e.g. an error from the last action)
  let invite = null;       // { code } after making an invite
  let draft = null;        // what was typed in the open plan form, kept when the screen redraws (e.g. after an error)
  let liveForm = null;     // { id, get } of the form on screen, so any redraw keeps what's typed in it
  let busy = false;
  const expanded = new Set();   // plans opened to show their details and history
  let pastOpen = false;
  let busyLink;                 // your busy link's token: undefined = not loaded yet, null = none
  let busyLinkLoading = false;
  const historyOpen = new Set();   // plans whose History drop-down is open
  let pending = false;     // live data arrived while a form was open: redraw once it closes
  let addingSpace = false; // the "+" chip is open: start or join another space
  let inviteOpen = false;  // the "Invite someone" drop-down is open
  let peopleOpen = false;  // the "People in …" drop-down is open

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
    const next = new Date();
    next.setDate(next.getDate() + 1);   // calendar day, so the night clocks change doesn't break "Tomorrow"
    const tomorrow = dayKey(next.getTime());
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

  // Notes are the short messages sent with an answer (e.g. "Sunday instead?" or a reason to decline)
  const notesOf = id => Together.events(id).filter(e => e.note);
  const who = id => id === Together.myId() ? "You" : Together.nameOf(id);

  // The newest note, shown on the plan card itself so it can always be seen
  function noteLine(p) {
    const notes = notesOf(p.id);
    if (!notes.length) return null;
    const n = notes[notes.length - 1];
    return el("div", { className: "plan-note" }, "“" + n.note + "”", el("span", { className: "by" }, " — " + who(n.actor)));
  }

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

  // Day + part of the day + optional time + note; used to suggest a plan and to suggest another time.
  // A new plan in a space with 3 or more people also picks who is in it (everyone is ticked to start with).
  function planFields(withTitle, startDay) {
    const d = draft || {};
    const title = withTitle ? el("input", { type: "text", maxlength: 200, placeholder: "What? (e.g. dinner out)", "aria-label": "Plan", value: d.title || "" }) : null;
    const others = withTitle ? Together.others() : [];
    const picked = new Set(d.picked || others.map(m => m.id));
    const pickBtns = others.map(m => {
      const b = el("button", { type: "button", className: picked.has(m.id) ? "on" : "", "aria-pressed": picked.has(m.id) ? "true" : "false" },
        m.name || "Someone");
      b.addEventListener("click", () => {
        picked.has(m.id) ? picked.delete(m.id) : picked.add(m.id);
        b.className = picked.has(m.id) ? "on" : "";
        b.setAttribute("aria-pressed", picked.has(m.id) ? "true" : "false");
      });
      return b;
    });
    const pick = others.length > 1
      ? el("div", {}, el("div", { className: "muted small" }, "Who's in it? (only they see what it is)"),
          el("div", { className: "move" }, pickBtns))
      : null;
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
    // A new plan has a details box instead; a note goes with an answer ("Sunday instead?")
    const note = withTitle ? null
      : el("input", { type: "text", maxlength: 200, placeholder: "Note (optional), e.g. Sunday instead?", "aria-label": "Note", value: d.note || "" });
    const details = withTitle
      ? el("textarea", { maxlength: 1000, rows: 3, placeholder: "Details (optional): where, what to bring, links…", "aria-label": "Details" })
      : null;
    if (details) details.value = d.details || "";
    const node = el("div", { className: "plan-fields" },
      title, pick, day, el("div", { className: "move" }, partBtns),
      el("label", { className: "muted small" }, "Time (optional; with a time, everyone going gets a reminder when it starts) ", time), note, details);
    // people = who is ticked, or null when it's everyone (then people who join later are in it too)
    const get = () => ({ title: title && title.value, day: day.value, part, time: time.value, note: note ? note.value : undefined,
      details: details ? details.value : undefined, picked: [...picked],
      people: others.length > 1 && picked.size < others.length ? [...picked] : null });
    liveForm = { id: openForm, get };
    return { node, get };
  }

  // The plan's name; tapping it opens or closes its details and history
  function planHead(p) {
    const open = expanded.has(p.id);
    return el("button", { type: "button", className: "plan-head", "aria-expanded": open ? "true" : "false",
      onclick: () => { open ? expanded.delete(p.id) : expanded.add(p.id); draw(true); } },
      el("span", { className: "plan-title" }, p.title),
      el("span", { className: "plan-more-hint" }, open ? "Close" : (p.details ? "Details" : "More")));
  }

  // Who is going, still waiting or can't (only for plans with more than two people; with two, "From …" says it all)
  function peopleLine(p) {
    const people = Together.peopleIn(p.id);
    if (people.length <= 2) return null;
    const by = { going: [], waiting: [], cant: [] };
    for (const x of people) if (by[x.answer]) by[x.answer].push(x.id === Together.myId() ? "You" : x.name || "Someone");
    const text = [["Going", by.going], ["Waiting", by.waiting], ["Can't", by.cant]]
      .filter(([, names]) => names.length).map(([word, names]) => word + ": " + names.join(", ")).join(" · ");
    return el("div", { className: "muted small" }, text);
  }

  // Shown when a plan is opened: its details (anyone in it can change them) and its history
  function planMore(p) {
    if (!expanded.has(p.id)) return null;
    const box = el("div", { className: "plan-more" });
    if (openForm === "details:" + p.id) {
      const area = el("textarea", { maxlength: 1000, rows: 4, "aria-label": "Details" });
      area.value = draft && draft.details !== undefined ? draft.details : (p.details || "");
      liveForm = { id: openForm, get: () => ({ details: area.value }) };
      box.append(area, el("div", { className: "btn-row" },
        el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
          draft = { details: area.value };
          const err = await Together.setDetails(p.id, area.value);
          if (!err) { openForm = null; draft = null; }
          return err;
        }) }, "Save details"),
        el("button", { type: "button", className: "btn", onclick: closeForm }, "Cancel")));
    } else {
      box.append(
        p.details ? el("p", { className: "plan-details" }, p.details) : el("p", { className: "muted small" }, "No details yet."),
        el("button", { type: "button", className: "text-btn left", onclick: () => { openForm = "details:" + p.id; draft = null; draw(true); } },
          p.details ? "Edit details" : "Add details"));
    }
    // Every note on this plan, oldest first
    const notes = notesOf(p.id);
    if (notes.length) {
      box.append(el("div", { className: "muted small history-head" }, "Notes"),
        el("ul", { className: "notes" }, notes.map(n => el("li", {},
          el("span", { className: "by" }, who(n.actor) + ": "), n.note))));
    }
    // History stays folded (a drop-down) unless opened, so an opened plan isn't cluttered
    const list = historyList(p);
    if (list) {
      const drop = el("details", { className: "history-drop", open: historyOpen.has(p.id) },
        el("summary", {}, "History (" + Together.events(p.id).length + ")"), list);
      drop.addEventListener("toggle", () => { drop.open ? historyOpen.add(p.id) : historyOpen.delete(p.id); });
      box.append(drop);
    }
    return box;
  }

  // A plan that is on already (someone said Going) keeps its time: then the choice is Going or Can't
  function waitingCard(p) {
    const card = el("div", { className: "plan-card" },
      planHead(p),
      el("div", { className: "muted" }, whenText(p)),
      el("div", { className: "muted small" }, "From " + Together.nameOf(p.last_by) + (p.status === "approved" ? " · it's on" : "")),
      peopleLine(p),
      noteLine(p));
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
      const open = p.status === "suggested";
      card.append(el("div", { className: "btn-row" + (open ? " three" : "") },
        el("button", { type: "button", className: "btn primary", onclick: () => act(() => Together.answerPlan(p.id, "approved")) }, "Going"),
        open ? el("button", { type: "button", className: "btn", onclick: () => { openForm = p.id; draft = null; draw(true); } }, "Other time") : null,
        el("button", { type: "button", className: "btn", onclick: () => act(() => {
          const note = prompt("Can't make it? Add a short reason if you like (optional):", "");
          if (note === null) return "";
          return Together.answerPlan(p.id, "declined", { note });
        }) }, "Can't")));
    }
    const more = planMore(p);
    if (more) card.append(more);   // append(null) would show the word "null"
    return card;
  }

  function sentCard(p) {
    const waitingFor = Together.peopleIn(p.id).filter(x => x.answer === "waiting").map(x => x.name || "Someone");
    return el("div", { className: "plan-card quiet" },
      planHead(p),
      el("div", { className: "muted" }, whenText(p)),
      peopleLine(p) || el("div", { className: "muted small" }, "Waiting for " + (waitingFor.length ? waitingFor.join(", ") : "answers")),
      noteLine(p),
      el("button", { type: "button", className: "text-btn left", onclick: () => act(() => {
        if (!confirm("Take this suggestion back?")) return "";
        return Together.answerPlan(p.id, "declined", { note: "taken back" });
      }) }, "Take back"),
      planMore(p));
  }

  // Approved and past plans: name, when, who's going, and (opened) details + history
  function plainCard(p, extra) {
    return el("div", { className: "plan-card quiet" },
      planHead(p),
      el("div", { className: "muted small" }, whenText(p) + (extra ? " · " + extra : "")),
      peopleLine(p),
      noteLine(p),
      planMore(p));
  }

  // How a past plan ended, from your side
  function pastWord(p) {
    if (Together.answerOf(p) === "cant") return "you can't";
    return { approved: "happened", declined: "declined", expired: "expired (no answer)", suggested: "still open" }[p.status] || p.status;
  }

  function historyList(p) {
    const evs = Together.events(p.id);
    if (!evs.length) return null;
    const words = { suggested: "suggested", countered: "suggested another time", approved: "said Going",
      declined: "said Can't", expired: "expired (no answer)", details: "changed the details" };
    const takenBack = e => e.action === "declined" && e.note === "taken back";
    return el("ul", { className: "history" }, evs.map(e => el("li", {},
      (e.actor ? (e.actor === Together.myId() ? "You" : Together.nameOf(e.actor)) + " " : "") +
      (takenBack(e) ? "took it back" : words[e.action]) +
      (e.action === "suggested" || e.action === "countered" ? " " + whenText(e) : "") +
      (e.note && !takenBack(e) ? ' · "' + e.note + '"' : "") +
      " · " + new Date(e.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }))));
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
      onclick: () => { if (confirm("Delete this shared task for everyone in this space?")) Together.deleteTask(t.id); } }, "×");
    li.append(check, text, del);
    return li;
  }

  // ---------- Screens ----------

  function setupScreen(root) {
    if (!Together.myName()) {
      const name = el("input", { type: "text", maxlength: 40, placeholder: "Your first name", "aria-label": "Your name" });
      root.append(el("div", { className: "card" },
        el("h2", {}, "What should we call you?"),
        el("p", { className: "muted" }, "People in your shared spaces see this name on plans and shared tasks."),
        el("form", { className: "account-form", onsubmit: e => { e.preventDefault(); act(() => Together.setName(name.value)); } },
          name, el("button", { type: "submit", className: "btn primary" }, "Save"))));
      return;
    }
    root.append(...spaceCards(true));
  }

  // Start a space (with its name) or join one with a code. first = you're in no space yet.
  function spaceCards(first) {
    const name = el("input", { type: "text", maxlength: 40, placeholder: "Name, e.g. Us or Family", "aria-label": "Space name" });
    const code = el("input", { type: "text", maxlength: 6, placeholder: "6-letter code", "aria-label": "Invite code",
      autocapitalize: "characters", spellcheck: "false" });
    return [
      el("div", { className: "card" },
        el("h2", {}, first ? "Share with someone" : "Start another space"),
        el("p", { className: "muted" }, first
          ? "Start a shared space and invite people with a code, or type a code someone gave you."
          : "Each space has its own plans, list and invite codes (e.g. one for the two of you, one for the family)."),
        el("form", { className: "account-form", onsubmit: e => { e.preventDefault(); act(async () => {
          const r = await Together.createGroup(name.value);
          invite = r.code ? r : null;
          if (!r.error) addingSpace = false;
          return r.error || "";
        }); } }, name, el("button", { type: "submit", className: "btn primary" }, "Start a shared space"))),
      el("div", { className: "card" },
        el("h2", {}, "I have a code"),
        el("form", { className: "account-form", onsubmit: e => { e.preventDefault(); act(async () => {
          const err = await Together.joinGroup(code.value);
          if (!err) { addingSpace = false; invite = null; }
          return err;
        }); } }, code, el("button", { type: "submit", className: "btn" }, "Join"))),
    ];
  }

  // One chip per space, with the number of plans waiting for you there; "+" starts or joins another
  function spaceBar() {
    const current = Together.group();
    const chips = Together.groups().map(g => {
      const n = Together.waitingCount(g.id);
      return el("button", { type: "button", className: "space-chip" + (!addingSpace && current && g.id === current.id ? " on" : ""),
        onclick: () => { addingSpace = false; invite = null; openForm = null; draft = null; act(() => Together.switchGroup(g.id)); } },
        g.name, n ? el("span", { className: "chip-count" }, String(n)) : null);
    });
    chips.push(el("button", { type: "button", className: "space-chip" + (addingSpace ? " on" : ""), "aria-label": "Start or join another space",
      onclick: () => { addingSpace = !addingSpace; draw(true); } }, "+"));
    return el("div", { className: "space-bar" }, chips);
  }

  // alone = nobody else is in this space yet (then this card comes first)
  function inviteCard(alone) {
    const space = Together.group() ? Together.group().name : "this space";
    const body = [
      invite
        ? [el("p", { className: "code" }, invite.code),
           el("p", { className: "muted" }, "Works once, for 24 hours. With an account: Us → \"I have a code\". " +
             "New to Daily: Settings → \"New here? Join with a code\".")]
        : el("p", { className: "muted" }, "Make a code and give it to them in person or by text."),
      el("button", { type: "button", className: "btn", onclick: () => act(async () => {
        const r = await Together.makeInvite();
        invite = r.code ? r : invite;
        return r.error || "";
      }) }, invite ? "Make a new code" : "Make a code")];
    if (alone) return el("div", { className: "card invite" }, el("h2", {}, "Invite someone to " + space), body);
    const box = el("details", { className: "card invite", open: inviteOpen || !!invite },
      el("summary", {}, "Invite someone to " + space), body);
    box.addEventListener("toggle", () => { inviteOpen = box.open; });
    return box;
  }

  // The person who runs the space sees who joined with someone else's code, and keeps or removes them
  function newPeopleCards() {
    if (!Together.isOwner()) return [];
    const space = Together.group().name;
    return Together.members().filter(m => !m.ownerSeen && m.id !== Together.myId()).map(m =>
      el("div", { className: "card" },
        el("h2", {}, (m.name || "Someone") + " joined " + space),
        el("p", { className: "muted" }, (m.invitedByName ? "Invited by " + m.invitedByName + "." : "Joined with a code.") +
          " Did you talk about it? If not, you can remove them."),
        el("div", { className: "btn-row" },
          el("button", { type: "button", className: "btn primary", onclick: () => act(() => Together.ackMember(m.id)) }, "Keep"),
          el("button", { type: "button", className: "btn", onclick: () => act(() => removeAsk(m)) }, "Remove"))));
  }

  function removeAsk(m) {
    const space = Together.group().name;
    if (!confirm("Remove " + (m.name || "this person") + " from " + space + "? They stop seeing its plans and list. " +
      "They can come back only with a new code.")) return "";
    return Together.removeMember(m.id);
  }

  // Everyone in the space: who runs it, who invited whom; the person who runs it can remove people
  function peopleCard() {
    const space = Together.group().name;
    const owner = Together.owner();
    const runner = Together.isOwner();
    const rows = Together.members().map(m => {
      const bits = [m.id === Together.myId() ? "you" : null, owner && m.id === owner.id ? "runs this space" : null,
        m.invitedByName ? "invited by " + m.invitedByName : null].filter(Boolean);
      return el("li", { className: "person" },
        el("span", {}, m.name || "Someone", bits.length ? el("span", { className: "by" }, " · " + bits.join(" · ")) : null),
        runner && m.id !== Together.myId()
          ? el("button", { type: "button", className: "text-btn danger", onclick: () => act(() => removeAsk(m)) }, "Remove")
          : null);
    });
    const box = el("details", { className: "card people-box", open: peopleOpen },
      el("summary", {}, "People in " + space + " · " + rows.length),
      el("ul", { className: "people" }, rows),
      el("p", { className: "muted small" }, runner
        ? "You run this space: you can remove people. Anyone here can invite."
        : "Anyone here can invite. " + (owner ? (owner.name || "The person who started it") : "The person who started it") +
          " runs it and can remove people."),
      el("button", { type: "button", className: "text-btn left danger", onclick: () => act(() => {
        if (!confirm("Leave " + space + "? You stop seeing its plans and list. You can come back only with a new code." +
          (runner ? " The person here longest will run it." : ""))) return "";
        return Together.leaveGroup();
      }) }, "Leave " + space));
    box.addEventListener("toggle", () => { peopleOpen = box.open; });
    return box;
  }

  // Your busy link: one link for family (a sister, a mother-in-law) that shows when you have plans, in every shared
  // space you're in. They see busy times only, never what the plans are.
  function busyLinkUrl(token) {
    return location.origin + location.pathname.replace(/[^/]*$/, "") + "busy.html#" + token;
  }

  function busyLinkCard() {
    const card = el("div", { className: "card" }, el("h2", {}, "Your busy link"),
      el("p", { className: "muted" }, "Give family one link that shows when you have plans, so they know before they ask. " +
        "They see days and times only, never what the plans are."));
    if (busyLink === undefined) {
      card.append(el("p", { className: "muted small" }, "Loading…"));
      if (!busyLinkLoading) {
        busyLinkLoading = true;
        Together.getBusyLink().then(r => {
          busyLinkLoading = false;
          busyLink = r.error ? null : r.token;
          if (r.error) message = r.error;
          draw();   // waits if a form is open, so nothing typed is lost
        });
      }
      return card;
    }
    if (!busyLink) {
      card.append(el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
        const r = await Together.newBusyLink();
        if (r.token) busyLink = r.token;
        return r.error || "";
      }) }, "Make my link"));
      return card;
    }
    const url = busyLinkUrl(busyLink);
    card.append(
      el("p", { className: "link-box" }, url),
      el("button", { type: "button", className: "btn primary", onclick: () => act(async () => {
        try {
          if (navigator.share) await navigator.share({ title: "When I'm busy", url });
          else { await navigator.clipboard.writeText(url); return "Link copied."; }
        } catch (e) {
          if (e && e.name === "AbortError") return "";
          try { await navigator.clipboard.writeText(url); return "Link copied."; } catch (_) { return "Copy the link above by hand."; }
        }
        return "";
      }) }, "Share link"),
      el("button", { type: "button", className: "btn", onclick: () => act(async () => {
        if (!confirm("Make a new link? The old one stops working, so anyone who has it needs the new one.")) return "";
        const r = await Together.newBusyLink();
        busyLink = r.token || undefined;   // failed half way: load what the account really has
        return r.error || "";
      }) }, "Make a new link"),
      el("button", { type: "button", className: "text-btn left danger", onclick: () => act(async () => {
        if (!confirm("Turn your busy link off? Anyone who has it will see that it's turned off.")) return "";
        const err = await Together.turnOffBusyLink();
        if (!err) busyLink = null;
        return err;
      }) }, "Turn link off"));
    return card;
  }

  // Shown until notifications are on for this phone
  function pushCard() {
    const state = Together.pushState();
    if (state === "granted") return null;
    const installed = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
    if (state === "unsupported" || !installed) {
      return el("div", { className: "card" },
        el("h2", {}, "Get notified about plans"),
        el("p", { className: "muted" }, "Open Daily from your Home Screen (Share → Add to Home Screen in Safari) to turn on notifications."));
    }
    if (state === "denied") {
      return el("div", { className: "card" },
        el("h2", {}, "Notifications are off"),
        el("p", { className: "muted" }, "Turn them on in iPhone Settings → Notifications → Daily."));
    }
    return el("div", { className: "card" },
      el("h2", {}, "Get notified about plans"),
      el("p", { className: "muted" }, "Your phone shows a notification when a plan is suggested or answered."),
      el("button", { type: "button", className: "btn primary", onclick: () => act(() => Together.enablePush(true)) },
        "Turn on notifications"));
  }

  function mainScreen(root) {
    const L = Together.lists();
    const others = Together.others();

    root.append(spaceBar());
    if (addingSpace) { root.append(...spaceCards(false)); return; }
    root.append(...newPeopleCards());
    if (!others.length) root.append(inviteCard(true));
    const push = pushCard();
    if (push) root.append(push);

    if (L.waiting.length) {
      root.append(el("h3", { className: "us-head" }, "Waiting for you · " + L.waiting.length), ...L.waiting.map(waitingCard));
    }

    // Suggest a plan
    if (others.length) {
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
            }) }, others.length === 1 ? "Send to " + (others[0].name || "them") : "Send"),
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
      root.append(el("h3", { className: "us-head" }, "Coming up"), ...L.upcoming.map(p => plainCard(p)));
    }
    root.append(busyLinkCard());
    if (others.length) root.append(inviteCard(false));
    root.append(peopleCard());

    // Shared list
    const input = el("input", { id: "us-add", type: "text", maxlength: 200, placeholder: "Add to the shared list", "aria-label": "New shared task", enterkeyhint: "done" });
    root.append(el("h3", { className: "us-head" }, "Together list"),
      el("form", { className: "add", autocomplete: "off", onsubmit: e => {
        e.preventDefault();
        const text = input.value;
        input.value = "";
        // If it couldn't be saved (e.g. offline), put the text back so nothing typed is lost
        Together.addTask(text, null).then(ok => {
          const box = $("us-add");
          if (!ok && box && !box.value) box.value = text;
        });
      } }, input, el("button", { type: "submit", className: "add-btn", "aria-label": "Add shared task" }, "+")));
    const open = L.tasks.filter(t => !t.done), done = L.tasks.filter(t => t.done);
    if (L.tasks.length) root.append(el("ul", { className: "list" }, [...open, ...done].map(taskRowShared)));
    else root.append(el("p", { className: "muted" }, "Nothing shared yet. Anything added here shows for everyone in this space."));

    if (L.past.length) {
      const past = el("details", { className: "card past", open: pastOpen },
        el("summary", {}, "Past and not going · " + L.past.length),
        L.past.map(p => plainCard(p, pastWord(p))));
      past.addEventListener("toggle", () => { pastOpen = past.open; });
      root.append(past);
    }
  }

  // ---------- Drawing ----------

  // force = the person tapped something here. Live updates (force false) wait while a form is open or someone is
  // typing, so nothing they typed disappears; the badge still updates.
  function draw(force = false) {
    const root = $("us-root");
    if (!root) return;
    const active = document.activeElement;
    const typing = active && root.contains(active) && active.matches("input, textarea") && active.id !== "us-add";
    if (!force && (typing || openForm)) { pending = true; drawBadge(); return; }
    pending = false;
    if (liveForm && liveForm.id === openForm && openForm) { try { draft = liveForm.get(); } catch (_) {} }
    liveForm = null;
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
    // The number on the app icon (shows only when notifications are allowed)
    if (navigator.setAppBadge && Together.signedIn()) (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {});
  }

  function init() {
    Together.onChange(() => draw());
    // Another account signed in (or out): nothing from the previous person stays on the Us tab
    if (typeof Sync !== "undefined") Sync.onUserChange(() => {
      busyLink = undefined; busyLinkLoading = false; invite = null; message = ""; addingSpace = false; inviteOpen = false;
      peopleOpen = false;
      openForm = null; draft = null; liveForm = null; pastOpen = false;
      expanded.clear(); historyOpen.clear();
      draw(true);
    });
    // Typing finished: catch up on anything that arrived meanwhile
    const root = $("us-root");
    root.addEventListener("focusout", () => setTimeout(() => {
      if (pending && !root.contains(document.activeElement)) draw();
    }, 300));
    // Opened from a notification: go straight to Us
    if (new URLSearchParams(location.search).get("view") === "us") showView("us");
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.open === "us") showView("us"); });
    }
    draw(true);
  }

  return { init, draw };
})();

UsView.init();
