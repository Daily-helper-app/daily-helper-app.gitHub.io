// Daily App: the to-do list foundation. The list is stored on this phone (localStorage); when signed in,
// sync.js also keeps a copy in the account.
"use strict";

const APP_VERSION = "0.9.0";
const SAVE_VERSION = 3;                         // bump + add a step in migrate() when the save shape changes
const SAVE_KEY = "dailyapp.data";
const SNAPSHOT_KEY = "dailyapp.snapshot";       // automatic start-of-day copy
const PRE_RESTORE_KEY = "dailyapp.beforeRestore"; // copy kept before any restore
const TIP_KEY = "dailyapp.hideInstallTip";
const MAX_TEXT = 200;

// Parts of the day, in screen order. A task with no part (part: null) shows under "Anytime".
const PARTS = [
  { id: "morning", label: "Morning", startHour: 0 },
  { id: "afternoon", label: "Afternoon", startHour: 12 },
  { id: "evening", label: "Evening", startHour: 17 },
];
const PART_IDS = PARTS.map(p => p.id);

const $ = id => document.getElementById(id);
let state = null;
let undoSteps = [];    // one step per delete/clear/restore, newest last; emptied when the Undo toast goes away
let toastTimer = 0;
let openAdd = null;    // part whose "Add to …" row is open for typing
let rendering = false; // true while the screen is redrawn, so blur events from removed inputs are ignored
let pointerIsDown = false; // a finger (or mouse) is pressed: redraws wait until it lifts, so the tap still lands
let holdRender = false;    // true while a text box is closing: its redraw waits until the tap that closed it is handled
let renderPending = false;
let flushTimer = 0;
let loadFailed = false;    // the save could not be read this session: don't overwrite the daily copy with an empty list

// ---------- Saving and loading ----------

function freshData() {
  return { version: SAVE_VERSION, todos: [], lastBackup: null };
}

// Task ids are UUIDs, the id format the account's database uses
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map(x => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Checks a save and upgrades older versions to the current shape. Throws if it is not a Daily save.
function migrate(data) {
  if (!data || typeof data !== "object" || !Array.isArray(data.todos)) throw new Error("no task list found");
  if (!data.version) data.version = 1;
  if (data.version > SAVE_VERSION) throw new Error("it was made by a newer version of the app");
  // Upgrades, one per version. Future ones go below, e.g.: if (data.version === 2) { ...; data.version = 3; }
  if (data.version === 1) data.version = 2;   // v2: tasks get a part of the day; old tasks have none (Anytime)
  if (data.version === 2) data.version = 3;   // v3: task ids become UUIDs (below), so they can go into the account
  data.todos = data.todos
    .filter(t => t && typeof t.text === "string" && t.text.trim())
    .map(t => ({
      id: UUID_RE.test(t.id) ? t.id.toLowerCase() : makeId(),
      text: t.text.trim().slice(0, MAX_TEXT),
      done: !!t.done,
      part: PART_IDS.includes(t.part) ? t.part : null,
      createdAt: Number(t.createdAt) || Date.now(),
      doneAt: t.doneAt ? Number(t.doneAt) : null,
    }));
  data.lastBackup = Number(data.lastBackup) || null;
  return data;
}

function load() {
  let raw = null;
  try { raw = localStorage.getItem(SAVE_KEY); } catch (e) {
    showBanner("This phone is blocking storage, so tasks can't be saved. Check that Private Browsing is off.");
  }
  if (!raw) return freshData();
  try {
    const parsed = JSON.parse(raw);
    const oldVersion = parsed && parsed.version;
    const data = migrate(parsed);
    // Save an upgraded list straight away, so new ids stay the same on the next open
    if (oldVersion !== SAVE_VERSION) {
      try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (_) {}
    }
    return data;
  } catch (e) {
    // Never overwrite a save we could not read: park it under another name so it can be recovered.
    try { localStorage.setItem("dailyapp.unreadable." + Date.now(), raw); } catch (_) {}
    loadFailed = true;
    showBanner("Your saved tasks could not be read. A copy was kept. Restore a backup in Settings.");
    return freshData();
  }
}

function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch (e) {
    showBanner("Could not save on this phone (storage full or blocked). Save a backup in Settings now.");
  }
  if (typeof Sync !== "undefined") Sync.changed();   // signed in: send the change to the account soon
}

// Morning before 12, afternoon 12 to 5 pm, evening after 5 pm (phone's own clock)
function currentPart(time = Date.now()) {
  const hour = new Date(time).getHours();
  return [...PARTS].reverse().find(p => hour >= p.startHour).id;
}

function dayKey(time = Date.now()) {
  const d = new Date(time);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Once per day, keep a copy of how the list looked when the app was first opened that day.
function takeDailySnapshot() {
  if (loadFailed) return;
  try {
    const old = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null");
    if (old && old.day === dayKey()) return;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ day: dayKey(), data: state }));
  } catch (_) { /* a missing snapshot is not worth bothering the user about */ }
}

// Ask the phone not to clean up this app's storage when space runs low.
async function askPersistentStorage() {
  const el = $("persist-status");
  if (!navigator.storage || !navigator.storage.persist) { el.textContent = ""; return; }
  try {
    const ok = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    el.textContent = ok
      ? "Storage is protected from automatic clean-up."
      : "The phone may clear storage if space runs very low, so keep a backup.";
  } catch (_) { el.textContent = ""; }
}

// ---------- Changes to the list ----------

// Undo keeps one step per change, so two deletes in a row can both be undone, and undoing a delete
// puts back only those tasks (anything added or ticked meanwhile stays).
function rememberWholeList() {
  const copy = JSON.stringify(state);
  undoSteps.push({ state: copy });
  return copy;
}

function addTask(text, part) {
  text = text.trim().slice(0, MAX_TEXT);
  if (!text) return;
  state.todos.push({ id: makeId(), text, done: false, part, createdAt: Date.now(), doneAt: null });
  save();
  render();
}

function toggleTask(id) {
  const t = state.todos.find(t => t.id === id);
  if (!t) return;
  t.done = !t.done;
  t.doneAt = t.done ? Date.now() : null;
  save();
  render();
}

function moveTask(id, part) {
  const t = state.todos.find(t => t.id === id);
  if (t && t.part !== part) { t.part = part; save(); }
}

function renameTask(id, text) {
  const t = state.todos.find(t => t.id === id);
  text = text.trim().slice(0, MAX_TEXT);
  if (t && text && text !== t.text) { t.text = text; save(); }
  render();
}

function deleteTask(id) {
  const index = state.todos.findIndex(t => t.id === id);
  if (index < 0) return;
  const [task] = state.todos.splice(index, 1);
  undoSteps.push({ tasks: [{ task, index }] });
  save();
  render();
  toast("Task deleted", true);
}

function clearDone() {
  const removed = [];
  state.todos = state.todos.filter((task, index) => {
    if (task.done) { removed.push({ task, index }); return false; }
    return true;
  });
  if (!removed.length) return;
  undoSteps.push({ tasks: removed });
  save();
  render();
  toast(`${removed.length} done task${removed.length === 1 ? "" : "s"} cleared`, true);
}

function undo() {
  const step = undoSteps.pop();
  if (!step) return;
  if (step.state) state = migrate(JSON.parse(step.state));
  // Put tasks back where they were (in their original order, so each index is still right)
  // (skipped when a sync already brought the task back, so it never shows twice)
  else for (const { task, index } of step.tasks) {
    if (!state.todos.some(t => t.id === task.id)) state.todos.splice(Math.min(index, state.todos.length), 0, task);
  }
  save();
  render();
  toast("Undone", undoSteps.length > 0);
}

// ---------- Drawing the screen ----------

const CHECK_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2.5 7.2l3 3 6-6.4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function taskRow(t) {
  const li = document.createElement("li");
  li.className = "item" + (t.done ? " done" : "");
  li.dataset.id = t.id;

  const check = document.createElement("button");
  check.type = "button";
  check.className = "check";
  check.setAttribute("aria-label", t.done ? "Mark not done" : "Mark done");
  check.innerHTML = "<span>" + CHECK_SVG + "</span>";   // fixed icon only, never task text

  const text = document.createElement("span");
  text.className = "text";
  text.textContent = t.text;                             // textContent: task text can never run as code

  const del = document.createElement("button");
  del.type = "button";
  del.className = "del";
  del.setAttribute("aria-label", "Delete task");
  del.textContent = "×";

  li.append(check, text, del);
  return li;
}

// The "+ Add to evening" row, or a text box when that row is open for typing
function addRow(part, label) {
  if (openAdd !== part) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "add-to";
    btn.textContent = "+ Add to " + label.toLowerCase();
    return btn;
  }
  const input = document.createElement("input");
  input.type = "text";
  input.className = "add-inline";
  input.placeholder = "Add to " + label.toLowerCase();
  input.maxLength = MAX_TEXT;
  input.setAttribute("aria-label", "New " + label.toLowerCase() + " task");
  input.setAttribute("enterkeyhint", "done");
  const close = () => { openAdd = null; render(); };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.value.trim() ? addTask(input.value, part) : close();   // stays open for the next task
    }
    if (e.key === "Escape") close();
  });
  input.addEventListener("blur", () => {
    if (rendering) return;
    openAdd = null;
    // Typed text is kept. The redraw waits until the tap that moved focus away has landed (see render).
    holdRender = true;
    if (input.value.trim()) addTask(input.value, part);
    else render();
    holdRender = false;
  });
  return input;
}

// One part of the day: heading, its tasks (open first, done ones crossed out below), and its add row
function partSection(part, label, tasks, isNow) {
  const section = document.createElement("section");
  section.className = "part" + (isNow ? " now" : "");
  section.dataset.part = part || "";

  const head = document.createElement("h2");
  head.className = "part-head";
  head.append(label);
  if (isNow) {
    const pill = document.createElement("span");
    pill.className = "now-pill";
    pill.textContent = "now";
    head.append(pill);
  }
  if (tasks.length) {
    const count = document.createElement("span");
    count.className = "part-count";
    count.textContent = `${tasks.filter(t => t.done).length} of ${tasks.length}`;
    head.append(count);
  }

  const list = document.createElement("ul");
  list.className = "list";
  list.append(...tasks.filter(t => !t.done).map(taskRow), ...tasks.filter(t => t.done).map(taskRow));

  section.append(head, list);
  if (part) section.append(addRow(part, label));
  return section;
}

// Redraws wait while a finger is down: closing a text box redraws the list, and a redraw in the middle of a
// tap would swallow it (tapping another task's circle while editing used to need two taps).
function render() {
  if (pointerIsDown || holdRender) {
    renderPending = true;
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flushRender, 400);   // fallback when no tap follows (e.g. the keyboard's Done)
    return;
  }
  renderPending = false;
  draw();
}

function flushRender() {
  if (renderPending && !pointerIsDown) render();
}

function draw() {
  rendering = true;
  const now = currentPart();
  const sections = [];
  const anytime = state.todos.filter(t => !t.part);
  if (anytime.length) sections.push(partSection(null, "Anytime", anytime, false));
  for (const p of PARTS) {
    sections.push(partSection(p.id, p.label, state.todos.filter(t => t.part === p.id), p.id === now));
  }
  $("parts").replaceChildren(...sections);
  rendering = false;

  const open = state.todos.filter(t => !t.done).length;
  const done = state.todos.length - open;
  $("empty").hidden = state.todos.length > 0;
  $("clear-done").hidden = done === 0;
  $("add-input").placeholder = "Add to " + PARTS.find(p => p.id === now).label.toLowerCase();

  const date = new Date().toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  $("subtitle").textContent = state.todos.length ? `${done} of ${state.todos.length} done · ${date}` : date;
  renderSettings();

  const inline = document.querySelector(".add-inline");
  if (inline) inline.focus();
}

function renderSettings() {
  const last = state.lastBackup;
  const days = last ? Math.floor((Date.now() - last) / 86400000) : null;
  $("backup-status").textContent = !last
    ? "No backup yet. A backup is a file you keep (in Files or iCloud) in case this phone loses its data."
    : `Last backup: ${new Date(last).toLocaleDateString()}${days >= 7 ? " · over a week ago, save a new one" : ""}.`;

  let snap = null;
  try { snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null"); } catch (_) {}
  const btn = $("snapshot-btn");
  btn.hidden = !snap;
  if (snap) {
    const label = snap.day === dayKey() ? "this morning" : new Date(snap.day + "T12:00").toLocaleDateString();
    btn.textContent = `Go back to the copy from ${label}`;
  }
  $("app-version").textContent = APP_VERSION;
}

function showView(name) {
  for (const view of document.querySelectorAll(".view")) view.hidden = view.id !== "view-" + name;
  for (const tab of document.querySelectorAll(".tab")) tab.classList.toggle("active", tab.dataset.view === name);
  $("title").textContent = { todo: "To-do", us: "Us", schedule: "Schedule", settings: "Settings" }[name];
  window.scrollTo(0, 0);
}

function showBanner(message) {
  const el = $("banner");
  el.textContent = message;
  el.hidden = false;
}

function toast(message, withUndo = false) {
  $("toast-text").textContent = message;
  $("toast-undo").hidden = !withUndo;
  $("toast").hidden = false;
  if (!withUndo) undoSteps = [];
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("toast").hidden = true; undoSteps = []; }, withUndo ? 6000 : 2500);
}

// Inline editing: tap a task's text to change it. Enter or tapping away saves, Escape cancels.
// While editing, a row of buttons below moves the task to another part of the day.
function startEdit(li) {
  const id = li.dataset.id;
  // A box that just closed may still be waiting to redraw: redraw first, then edit the fresh row
  if (renderPending) {
    renderPending = false;
    draw();
    li = [...document.querySelectorAll(".item")].find(el => el.dataset.id === id);
    if (!li) return;
  }
  const t = state.todos.find(t => t.id === id);
  const span = li.querySelector(".text");
  if (!t || !span) return;
  openAdd = null;
  const input = document.createElement("input");
  input.className = "edit";
  input.value = t.text;
  input.maxLength = MAX_TEXT;
  input.setAttribute("aria-label", "Edit task");
  input.setAttribute("enterkeyhint", "done");
  let finished = false;
  const finish = keep => {
    if (finished) return;
    finished = true;
    keep ? renameTask(t.id, input.value) : render();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => {
    holdRender = true;   // the redraw waits until the tap that closed this box has landed (see render)
    finish(true);
    holdRender = false;
  });

  const move = document.createElement("div");
  move.className = "move";
  for (const p of PARTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = p.id === t.part ? "on" : "";
    btn.textContent = p.label;
    // pointerdown runs before the text box loses focus, so the tap is not lost when the row redraws
    const pick = e => {
      e.preventDefault();
      if (finished) return;
      moveTask(t.id, p.id);
      finish(true);
    };
    btn.addEventListener("pointerdown", pick);
    btn.addEventListener("click", pick);
    move.append(btn);
  }

  span.replaceWith(input);
  li.classList.add("editing");
  li.append(move);
  input.focus();
}

// ---------- Backup ----------

async function exportBackup() {
  const json = JSON.stringify({ app: "daily-app", exportedAt: new Date().toISOString(), data: state }, null, 2);
  const name = `daily-backup-${dayKey()}.json`;
  const file = new File([json], name, { type: "application/json" });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      // iPhone: opens the share sheet, where "Save to Files" keeps it in Files / iCloud Drive
      await navigator.share({ files: [file], title: "Daily backup" });
    } else {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    state.lastBackup = Date.now();
    save();
    renderSettings();
    toast("Backup saved");
  } catch (e) {
    if (e.name !== "AbortError") toast("Backup failed: " + e.message);
  }
}

// Replaces the list with other data, keeping the current list for Undo and in a spare copy.
function restore(data, message) {
  const before = rememberWholeList();
  try { localStorage.setItem(PRE_RESTORE_KEY, before); } catch (_) {}
  state = data;
  save();
  render();
  toast(message, true);
}

async function importBackup(file) {
  let data;
  try {
    const parsed = JSON.parse(await file.text());
    data = migrate(parsed.data || parsed);
  } catch (e) {
    alert("That file is not a Daily backup (" + e.message + ").");
    return;
  }
  const inAccount = typeof Sync !== "undefined" && Sync.getUser() ? " (also in your account and on your other phones)" : "";
  if (!confirm(`Replace your ${state.todos.length} tasks with the ${data.todos.length} tasks in this backup${inAccount}?`)) return;
  data.lastBackup = state.lastBackup;
  restore(data, "Backup restored");
}

function restoreSnapshot() {
  let snap;
  try { snap = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || "null"); } catch (_) {}
  if (!snap) return;
  let data;
  try { data = migrate(snap.data); } catch (e) { alert("The saved copy could not be read."); return; }
  const inAccount = typeof Sync !== "undefined" && Sync.getUser() ? " (also in your account and on your other phones)" : "";
  if (!confirm(`Go back to the copy with ${data.todos.length} tasks? Changes made since then are undone${inAccount}.`)) return;
  restore(data, "Went back to the saved copy");
}

// ---------- Install tip + offline support ----------

function isInstalled() {
  return window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;
}

function setupInstallTip() {
  let hidden = false;
  try { hidden = localStorage.getItem(TIP_KEY) === "1"; } catch (_) {}
  $("install-tip").hidden = isInstalled() || hidden;
  $("install-tip-close").addEventListener("click", () => {
    $("install-tip").hidden = true;
    try { localStorage.setItem(TIP_KEY, "1"); } catch (_) {}
  });
}

// No "close and reopen" notice on updates: sw.js loads the newest files whenever there's signal,
// so an update simply shows up the next time the app opens.
function setupOffline() {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.register("sw.js").catch(() => { /* app still works online without it */ });
}

// ---------- Start ----------

function start() {
  state = load();
  takeDailySnapshot();
  render();
  setupInstallTip();
  setupOffline();
  askPersistentStorage();

  $("add-form").addEventListener("submit", e => {
    e.preventDefault();
    addTask($("add-input").value, currentPart());
    $("add-input").value = "";
  });

  // One click handler for all parts of the day (rows are redrawn often)
  $("parts").addEventListener("click", e => {
    if (e.target.closest(".add-to")) {
      openAdd = e.target.closest(".part").dataset.part;
      render();
      return;
    }
    const li = e.target.closest(".item");
    if (!li || li.classList.contains("editing")) return;
    if (e.target.closest(".check")) toggleTask(li.dataset.id);
    else if (e.target.closest(".del")) deleteTask(li.dataset.id);
    else if (e.target.closest(".text")) startEdit(li);
  });

  // Coming back to the app later (it can stay open overnight): take the day's copy if it's a new day,
  // and move the "now" label to the current part of the day
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    takeDailySnapshot();
    if (!document.querySelector(".edit, .add-inline")) render();
  });

  // Hold redraws while a finger is down (see render), then catch up right after the tap has landed
  document.addEventListener("pointerdown", () => { pointerIsDown = true; }, true);
  const release = () => {
    pointerIsDown = false;
    if (renderPending) setTimeout(flushRender, 0);
  };
  document.addEventListener("pointerup", release, true);
  document.addEventListener("pointercancel", release, true);
  // After a tap's own action has run, draw anything still waiting
  document.addEventListener("click", () => { if (renderPending) setTimeout(flushRender, 0); });
  // iPhone Safari only shows :active (pressed) styles when the page listens for touches
  document.addEventListener("touchstart", () => {}, { passive: true });

  $("clear-done").addEventListener("click", clearDone);
  $("toast-undo").addEventListener("click", undo);
  $("export-btn").addEventListener("click", exportBackup);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", e => {
    const file = e.target.files[0];
    e.target.value = "";
    if (file) importBackup(file);
  });
  $("snapshot-btn").addEventListener("click", restoreSnapshot);
  for (const tab of document.querySelectorAll(".tab")) {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  }

  // Another open copy of the app (e.g. a second tab) changed the list: reload it here
  window.addEventListener("storage", e => {
    if (e.key === SAVE_KEY) { state = load(); render(); }
  });
}

start();
