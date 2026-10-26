// Daily App: the shared space for two people ("Together"): shared tasks and plans.
// Data part: loads the group, its shared tasks and plans, keeps them live, and sends changes. The screen part
// (together-view.js) draws it. Plans only change through the database functions in supabase/setup.sql, which
// check the rules (no approving your own suggestion, no answering an old version).
"use strict";

const Together = (() => {
  const CACHE_KEY = "dailyapp.together";   // last shared data seen, so it still shows offline
  const OUTBOX_KEY = "dailyapp.outbox";    // plans suggested while offline, sent when back online
  const ITEM_COLUMNS = "id,owner_id,group_id,kind,title,day,part,exact_time,done,done_by,status,version,last_by,created_at,updated_at";

  let client = null;
  let user = null;
  let channel = null;
  let reloadTimer = 0;
  let data = emptyData();
  let online = false;      // the last load reached the server
  let lastError = "";
  const listeners = [];

  function emptyData() {
    return { userId: null, group: null, members: [], items: [], events: {} };
  }

  function emit() { for (const fn of listeners) fn(); }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function loadCache(userId) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && c.userId === userId) return c;
    } catch (_) {}
    return { ...emptyData(), userId };
  }

  function outbox() {
    try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || "[]"); } catch (_) { return []; }
  }

  function setOutbox(list) {
    try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(list)); } catch (_) {}
  }

  // Database error codes from setup.sql, in plain words
  function explain(error) {
    const m = (error && error.message) || "";
    if (m.includes("plan_changed")) return "This plan changed while you were looking. Look again.";
    if (m.includes("plan_closed")) return "This plan was already answered.";
    if (m.includes("own_suggestion")) return "You suggested this one, so the other person answers it.";
    if (m.includes("day_passed")) return "That day has passed. Pick a later day.";
    if (m.includes("bad_code")) return "That code doesn't work. Codes work once, for 24 hours.";
    if (m.includes("need_day_and_part")) return "Pick a day and a part of the day.";
    if (!navigator.onLine) return "You're offline. Try again when you have signal.";
    return "Couldn't reach the account server. Try again in a moment.";
  }

  // ---------- Loading ----------

  async function load() {
    if (!client || !user) return;
    try {
      await client.rpc("expire_plans");
      const { data: groups, error: e1 } = await client.from("groups").select("id,name,created_at").order("created_at");
      if (e1) throw e1;
      const next = { ...emptyData(), userId: user.id, group: groups[0] || null };
      if (next.group) {
        const g = next.group.id;
        const [members, items] = await Promise.all([
          client.from("group_members").select("user_id").eq("group_id", g),
          client.from("items").select(ITEM_COLUMNS).eq("group_id", g).order("created_at"),
        ]);
        if (members.error) throw members.error;
        if (items.error) throw items.error;
        const ids = members.data.map(m => m.user_id);
        const { data: profiles, error: e2 } = await client.from("profiles").select("id,display_name").in("id", ids);
        if (e2) throw e2;
        next.members = ids.map(id => ({ id, name: (profiles.find(p => p.id === id) || {}).display_name || "" }));
        next.items = items.data;
        const planIds = items.data.filter(i => i.kind === "plan").map(i => i.id);
        if (planIds.length) {
          const { data: events, error: e3 } = await client.from("plan_events")
            .select("item_id,actor,action,day,part,exact_time,note,plan_version,created_at")
            .in("item_id", planIds).order("created_at");
          if (e3) throw e3;
          for (const ev of events) (next.events[ev.item_id] = next.events[ev.item_id] || []).push(ev);
        }
      } else {
        // Your own name is still needed for the first screen
        const { data: me } = await client.from("profiles").select("id,display_name").eq("id", user.id);
        next.members = me && me.length ? [{ id: user.id, name: me[0].display_name }] : [];
      }
      data = next;
      online = true;
      lastError = "";
      saveCache();
      subscribe();
      await flushOutbox();
    } catch (e) {
      online = false;
      lastError = explain(e);
    }
    emit();
  }

  function reloadSoon(ms = 300) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(load, ms);
  }

  // Live updates: any change to this group's items or plan history reloads the shared data
  function subscribe() {
    if (!data.group || (channel && channel.groupId === data.group.id)) return;
    if (channel) client.removeChannel(channel);
    const g = data.group.id;
    channel = client.channel("together-" + g)
      .on("postgres_changes", { event: "*", schema: "public", table: "items", filter: "group_id=eq." + g }, () => reloadSoon())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "plan_events" }, () => reloadSoon())
      .subscribe();
    channel.groupId = g;
  }

  // ---------- Names and the group ----------

  const me = () => data.members.find(m => m.id === (user && user.id));
  const myName = () => (me() && me().name) || "";
  const nameOf = id => (data.members.find(m => m.id === id) || {}).name || "Someone";
  const partner = () => data.members.find(m => m.id !== (user && user.id)) || null;

  async function setName(name) {
    name = name.trim().slice(0, 40);
    if (!name) return "Type a name first.";
    const { error } = await client.from("profiles").upsert({ id: user.id, display_name: name });
    if (error) return explain(error);
    await load();
    return "";
  }

  async function createGroup() {
    const { error } = await client.rpc("create_group", { p_name: "Together" });
    if (error) return { error: explain(error) };
    await load();
    return makeInvite();
  }

  async function makeInvite() {
    const { data: code, error } = await client.rpc("make_invite", { p_group: data.group.id });
    if (error) return { error: explain(error) };
    return { code };
  }

  async function joinGroup(code) {
    const { error } = await client.rpc("join_group", { p_code: code });
    if (error) return explain(error);
    await load();
    return "";
  }

  // ---------- Shared tasks ----------

  async function write(promise) {
    const { error } = await promise;
    if (error) { lastError = explain(error); emit(); return false; }
    reloadSoon(0);
    return true;
  }

  function addTask(text, part) {
    text = text.trim().slice(0, 200);
    if (!text || !data.group) return;
    return write(client.from("items").insert({ group_id: data.group.id, kind: "task", title: text, part: part || null }));
  }

  function toggleTask(id) {
    const t = data.items.find(i => i.id === id);
    if (!t) return;
    t.done = !t.done;   // shows at once; the reload brings back who ticked it
    emit();
    return write(client.from("items").update({ done: t.done }).eq("id", id));
  }

  function renameTask(id, text) {
    text = text.trim().slice(0, 200);
    if (!text) return;
    return write(client.from("items").update({ title: text }).eq("id", id));
  }

  function deleteTask(id) {
    data.items = data.items.filter(i => i.id !== id);
    emit();
    return write(client.from("items").delete().eq("id", id));
  }

  // ---------- Plans ----------

  // A plan suggested offline waits in the outbox with its own id, so sending it twice still adds it once.
  async function suggestPlan({ title, day, part, time, note }) {
    title = (title || "").trim().slice(0, 200);
    if (!title) return "Name the plan first.";
    if (!day || !part) return "Pick a day and a part of the day.";
    const plan = { p_group: data.group.id, p_title: title, p_day: day, p_part: part, p_time: time || null,
      p_note: (note || "").trim().slice(0, 200) || null, p_id: makeId() };
    if (!navigator.onLine) {
      setOutbox([...outbox(), plan]);
      emit();
      return "";
    }
    const { error } = await client.rpc("suggest_plan", plan);
    if (error) {
      if (!isNetworkError(error)) return explain(error);
      setOutbox([...outbox(), plan]);   // couldn't reach the server: keep it and try again later
      emit();
      return "";
    }
    await load();
    return "";
  }

  // "Failed to fetch" and similar = no connection; anything else is the server saying no
  const isNetworkError = error => /fetch|network|load failed/i.test(String((error && error.message) || ""));

  async function flushOutbox() {
    const list = outbox();
    if (!list.length) return;
    const left = [];
    for (const plan of list) {
      const { error } = await client.rpc("suggest_plan", plan);
      if (error && isNetworkError(error)) left.push(plan);   // a plan the server refused is dropped, not retried forever
    }
    setOutbox(left);
    if (left.length < list.length) reloadSoon(0);
  }

  // action: "approved", "declined" or "countered" (with a new day / part / time)
  async function answerPlan(id, action, extra = {}) {
    const plan = data.items.find(i => i.id === id);
    if (!plan) return "That plan is gone.";
    const { error } = await client.rpc("answer_plan", {
      p_item: id, p_version: plan.version, p_action: action,
      p_day: extra.day || null, p_part: extra.part || null, p_time: extra.time || null,
      p_note: (extra.note || "").trim().slice(0, 200) || null,
    });
    await load();
    return error ? explain(error) : "";
  }

  // ---------- Lists for the screen ----------

  const today = () => dayKey();
  const plans = () => data.items.filter(i => i.kind === "plan");
  const sortByDay = list => list.sort((a, b) => (a.day + partOrder(a.part)).localeCompare(b.day + partOrder(b.part)));
  const partOrder = p => String(["morning", "afternoon", "evening"].indexOf(p));

  const lists = () => ({
    waiting: sortByDay(plans().filter(p => p.status === "suggested" && p.last_by !== (user && user.id))),
    sent: sortByDay(plans().filter(p => p.status === "suggested" && p.last_by === (user && user.id))),
    upcoming: sortByDay(plans().filter(p => p.status === "approved" && p.day >= today())),
    past: plans().filter(p => !(p.status === "suggested") && !(p.status === "approved" && p.day >= today()))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    tasks: data.items.filter(i => i.kind === "task"),
    outbox: outbox(),
  });

  const waitingCount = () => lists().waiting.length;

  // ---------- Start ----------

  function init() {
    if (typeof Sync === "undefined") return;
    Sync.onUserChange(u => {
      client = Sync.getClient();
      user = u;
      if (channel && client) { client.removeChannel(channel); channel = null; }
      data = u ? loadCache(u.id) : emptyData();
      emit();
      if (u) load();
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) reloadSoon(0); });
    window.addEventListener("online", () => { if (user) load(); });
  }

  return {
    init, load, onChange: fn => listeners.push(fn),
    signedIn: () => !!user, online: () => online, error: () => lastError, clearError: () => { lastError = ""; },
    group: () => data.group, members: () => data.members, me, myName, nameOf, partner, myId: () => user && user.id,
    events: id => data.events[id] || [],
    setName, createGroup, makeInvite, joinGroup,
    addTask, toggleTask, renameTask, deleteTask,
    suggestPlan, answerPlan, lists, waitingCount,
  };
})();

Together.init();
