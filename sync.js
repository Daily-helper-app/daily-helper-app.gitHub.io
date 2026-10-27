// Daily App: account + sync for "Mine" (private tasks).
// The list on this phone stays the one the screen uses. When signed in, this file sends its changes to the account
// and brings in changes made on another phone. Signed out, nothing is sent anywhere.
"use strict";

const Sync = (() => {
  const META_KEY = "dailyapp.sync";   // what the account looked like at the last sync (kept apart from the list)
  const AUTH_KEY = "dailyapp.auth";   // sign-in session, kept by the Supabase library
  const COLUMNS = "id,title,done,part,created_at,done_at,updated_at";
  const PAUSED_HINT = "If this lasts more than a day, the free server may be paused: open supabase.com → the " +
    "daily-app project → Restore.";

  let client = null;
  let user = null;
  let busy = false;
  let again = false;
  let applying = false;  // true while sync itself writes the list, so that save doesn't start another sync
  let timer = 0;
  let status = "";
  let meta = loadMeta();

  function loadMeta() {
    try {
      const m = JSON.parse(localStorage.getItem(META_KEY) || "null");
      if (m && typeof m.base === "object") return m;
    } catch (_) {}
    return { userId: null, base: {}, lastSync: null };
  }

  function saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (_) {}
  }

  // ---------- Matching this phone's list with the account ----------

  const contentKey = t => JSON.stringify([t.text, t.done, t.part, t.doneAt || null]);

  const toRow = t => ({
    id: t.id,
    kind: "task",
    title: t.text,
    done: t.done,
    part: t.part,
    created_at: new Date(t.createdAt).toISOString(),
    done_at: t.doneAt ? new Date(t.doneAt).toISOString() : null,
  });

  const fromRow = r => ({
    id: r.id,
    text: r.title,
    done: r.done,
    part: r.part,
    createdAt: Date.parse(r.created_at) || Date.now(),
    doneAt: r.done_at ? Date.parse(r.done_at) : null,
  });

  // Decides what to send and what to take, from three lists: this phone's tasks, the account's tasks, and the
  // account as it was at the last sync (base). Changed on this phone = its content differs from the base.
  // Changed in the account = its updated_at differs from the base. If both changed, this phone wins.
  function plan(localTasks, remoteRows, base) {
    const local = new Map(localTasks.map(t => [t.id, t]));
    const remote = new Map(remoteRows.map(r => [r.id, r]));
    const out = { push: [], remove: [], take: [], drop: [] };
    for (const id of new Set([...local.keys(), ...remote.keys(), ...Object.keys(base)])) {
      const L = local.get(id), R = remote.get(id), B = base[id];
      const localChanged = L && (!B || contentKey(L) !== B.h);
      const remoteChanged = R && (!B || R.updated_at !== B.r);
      if (L && R) {
        if (localChanged) out.push.push(L);
        else if (remoteChanged) out.take.push(R);
      } else if (L) {
        if (B && !localChanged) out.drop.push(id);   // deleted on another phone
        else out.push.push(L);                         // new here (or changed here after a delete elsewhere)
      } else if (R) {
        if (B && !remoteChanged) out.remove.push(id); // deleted on this phone
        else out.take.push(R);                         // new in the account
      }
    }
    return out;
  }

  async function syncNow() {
    if (!client || !user) return;
    if (busy) { again = true; return; }
    // The list on this phone couldn't be read: an empty list here must not delete everything in the account
    if (typeof loadFailed !== "undefined" && loadFailed) {
      setStatus("Sync is paused because this phone's list couldn't be read. Restore a backup, then sync again.");
      return;
    }
    busy = true;
    if (meta.userId && meta.userId !== user.id) {
      // A different account signed in on this phone: keep the previous person's list aside (not sent anywhere) and
      // start from this account's own tasks, so the two lists never mix
      try { localStorage.setItem("dailyapp.otherAccount." + Date.now(), JSON.stringify(state)); } catch (_) {}
      state.todos = [];
      applying = true;
      save();
      applying = false;
      render();
    }
    if (meta.userId !== user.id) meta = { userId: user.id, base: {}, lastSync: null };
    try {
      const { data: rows, error } = await client.from("items").select(COLUMNS).is("group_id", null).eq("kind", "task");
      if (error) throw error;
      const sent = new Map(state.todos.map(t => [t.id, contentKey(t)]));   // the list as it was when sync began
      const p = plan(state.todos, rows, meta.base);
      const base = {};
      for (const r of rows) if (meta.base[r.id]) base[r.id] = meta.base[r.id];

      if (p.push.length) {
        const { data: saved, error: e } = await client.from("items").upsert(p.push.map(toRow)).select("id,updated_at");
        if (e) throw e;
        for (const r of saved) base[r.id] = { r: r.updated_at, h: sent.get(r.id) };
      }
      if (p.remove.length) {
        const { error: e } = await client.from("items").delete().in("id", p.remove);
        if (e) throw e;
        for (const id of p.remove) delete base[id];
      }

      // Bring in the account's changes, unless the task was edited here while this sync was running
      let changed = false;
      const editedMeanwhile = id => {
        const t = state.todos.find(t => t.id === id);
        return t ? contentKey(t) !== sent.get(id) : sent.has(id);
      };
      for (const r of p.take) {
        if (editedMeanwhile(r.id)) continue;
        const task = fromRow(r);
        const i = state.todos.findIndex(t => t.id === r.id);
        if (i >= 0) state.todos[i] = task; else state.todos.push(task);
        base[r.id] = { r: r.updated_at, h: contentKey(task) };
        changed = true;
      }
      for (const id of p.drop) {
        if (editedMeanwhile(id)) continue;
        state.todos = state.todos.filter(t => t.id !== id);
        delete base[id];
        changed = true;
      }
      // Tasks that matched already: remember them as they are now
      for (const r of rows) {
        if (!base[r.id] && !p.remove.includes(r.id) && !p.drop.includes(r.id) && sent.has(r.id)) {
          base[r.id] = { r: r.updated_at, h: sent.get(r.id) };
        }
      }

      meta.base = base;
      meta.lastSync = Date.now();
      saveMeta();
      if (changed) {
        applying = true;
        save();
        applying = false;
        // Not while a text box is open: closing it redraws anyway, and a redraw now would throw away what's typed
        if (!document.querySelector(".edit, .add-inline")) render();
      }
      setStatus("Synced " + new Date(meta.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) + ".");
    } catch (e) {
      if (!navigator.onLine) setStatus("Offline. Your list works as usual; changes send when you're back online.");
      else if (e && (e.status === 401 || e.code === "PGRST301")) setStatus("Signed out by the server. Please sign in again.");
      else setStatus("Can't reach the account server. Your list works as usual and changes send later. " + PAUSED_HINT);
    } finally {
      busy = false;
      if (again) { again = false; schedule(500); }
    }
  }

  function schedule(ms = 1500) {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(syncNow, ms);
  }

  // Called by app.js after every save
  function changed() {
    if (!applying) schedule();
  }

  // ---------- Account screen ----------

  function setStatus(text) {
    status = text;
    const el = $("sync-status");
    if (el) el.textContent = status;
  }

  function renderAccount() {
    $("signin-form").hidden = !!user || !client;
    $("account-in").hidden = !user;
    if (!client) setStatus("The account server can't be loaded right now. Your list works as usual on this phone.");
    else if (!user) setStatus("Not signed in. Your tasks are only on this phone.");
    if (user) $("account-email").textContent = user.email || "";
    $("privacy-text").textContent = user
      ? "Your tasks are on this phone and in your account (on Supabase's servers), where only you can read them. " +
        "No tracking, no ads."
      : "Your tasks are stored only on this phone. Nothing is sent anywhere until you sign in. No tracking, no ads.";
  }

  async function signIn(e) {
    e.preventDefault();
    const email = $("signin-email").value.trim();
    const password = $("signin-password").value;
    if (!email || !password) return;
    const btn = $("signin-btn");
    btn.disabled = true;
    setStatus("Signing in…");
    const { error } = await client.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    if (error) {
      setStatus(navigator.onLine ? "Sign-in didn't work: " + error.message : "You're offline. Sign in when you have signal.");
      return;
    }
    $("signin-password").value = "";
    toast("Signed in. Using a temporary password? Change it below.");
  }

  async function changePassword(e) {
    e.preventDefault();
    const pw = $("new-password").value;
    if (pw.length < 8) { setStatus("Pick a password with at least 8 characters."); return; }
    const { error } = await client.auth.updateUser({ password: pw });
    if (error) { setStatus("Password not changed: " + error.message); return; }
    $("new-password").value = "";
    $("password-box").open = false;
    toast("Password changed");
  }

  async function signOut() {
    if (!confirm("Sign out? Your tasks stay on this phone. Notifications for this account stop on this phone.")) return;
    // Stop this phone getting the account's notifications (they'd show plan names to whoever uses it next)
    if (typeof Together !== "undefined") await Together.beforeSignOut();
    await client.auth.signOut();
  }

  function init() {
    try {
      const cfg = window.DAILY_CONFIG;
      client = window.supabase.createClient(cfg.url, cfg.key, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: AUTH_KEY },
      });
    } catch (_) {
      client = null;   // the library didn't load (e.g. offline on first open): the list still works
    }
    $("signin-form").addEventListener("submit", signIn);
    $("password-form").addEventListener("submit", changePassword);
    $("signout-btn").addEventListener("click", signOut);
    $("sync-now").addEventListener("click", () => { setStatus("Syncing…"); syncNow(); });
    renderAccount();
    if (!client) return;

    client.auth.onAuthStateChange((event, session) => {
      const was = user && user.id;
      user = session ? session.user : null;
      renderAccount();
      if (user && user.id !== was) schedule(0);
      if ((user && user.id) !== was) for (const fn of userListeners) setTimeout(() => fn(user), 0);
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
    window.addEventListener("online", () => schedule(0));
    setInterval(() => { if (!document.hidden) schedule(0); }, 120000);   // pick up the other phone's changes
  }

  // together.js uses the same sign-in
  const userListeners = [];
  const onUserChange = fn => { userListeners.push(fn); if (user) setTimeout(() => fn(user), 0); };

  return { init, changed, syncNow, plan, onUserChange, getClient: () => client, getUser: () => user };
})();

Sync.init();
