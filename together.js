// Daily App: shared spaces (e.g. "Us", "Family"): shared tasks and plans.
// Data part: loads the space, its people, shared tasks and the plans you're in, keeps them live, and sends changes.
// The screen part (together-view.js) draws it. Plans only change through the database functions in supabase/
// (setup.sql, family-2.sql), which check the rules (only people in a plan see or answer it, one answer each, no
// answering an old time).
"use strict";

const Together = (() => {
  const CACHE_KEY = "dailyapp.together";   // last shared data seen, so it still shows offline
  const OUTBOX_KEY = "dailyapp.outbox";    // plans suggested while offline, sent when back online
  const GROUP_KEY = "dailyapp.group";      // the shared space this phone shows (per account)
  const ITEM_COLUMNS = "id,owner_id,group_id,kind,title,day,part,exact_time,done,done_by,status,version,last_by,details,created_at,updated_at";

  let client = null;
  let user = null;
  let channel = null;
  let reloadTimer = 0;
  let data = emptyData();
  let online = false;      // the last load reached the server
  let lastError = "";
  let notice = "";         // stays until the person taps something (a reload doesn't clear it)
  const listeners = [];

  // groups = every space you're in; waitingBy = plans waiting for you, per space (so no space's plans are missed);
  // people = who is in each plan and their answer ("waiting", "going", "cant"); privacy = your own "who sees
  // you're busy" per plan (family-4.sql); everyone = you + everyone you share any space with
  function emptyData() {
    return { userId: null, groups: [], waitingBy: {}, group: null, members: [], items: [], events: {}, people: {},
      privacy: {}, everyone: [] };
  }

  function emit() { for (const fn of listeners) fn(); }

  function saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(data)); } catch (_) {}
  }

  function loadCache(userId) {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (c && c.userId === userId) return { ...emptyData(), ...c };   // copies saved by v0.6 have no space list
    } catch (_) {}
    return { ...emptyData(), userId };
  }

  // One outbox per account, so plans made offline never go out under someone else's name
  const outboxKey = () => OUTBOX_KEY + "." + (user ? user.id : "none");

  function outbox() {
    try { return JSON.parse(localStorage.getItem(outboxKey()) || "[]"); } catch (_) { return []; }
  }

  function setOutbox(list) {
    try { localStorage.setItem(outboxKey(), JSON.stringify(list)); } catch (_) {}
  }

  // Database error codes from setup.sql and family-*.sql, in plain words. quiet = called from load(), which must
  // not start another load (that could repeat without a pause).
  function explain(error, quiet = false) {
    const m = (error && error.message) || "";
    if (m) console.warn("Daily: the account server said:", m);   // for debugging; never holds passwords
    if (m.includes("plan_changed")) return "This plan changed while you were looking. Look again.";
    if (m.includes("plan_closed")) return "This plan is closed already.";
    if (m.includes("own_suggestion")) return "You suggested this one, so the others answer it.";
    if (m.includes("not_signed_in")) return "You're signed out. Sign in again in Settings.";
    if (m.includes("day_passed")) return "That day has passed. Pick a later day.";
    if (m.includes("bad_code")) return "That code doesn't work. Codes work once, for 24 hours.";
    if (m.includes("already_member")) return "You're in that space already.";
    if (m.includes("space_full")) return "That space is full.";
    if (m.includes("need_day_and_part")) return "Pick a day and a part of the day.";
    if (m.includes("already_answered")) return "You answered this plan already.";
    if (m.includes("plan_on")) return "Someone is going already, so the time stays. Answer Going or Can't.";
    if (m.includes("not_in_space")) return "Someone you picked isn't in this space any more. Pick again.";
    if (m.includes("no_people")) return "Pick at least one person.";
    if (m.includes("not_owner")) return "Only the person who runs this space can do that.";
    // You were removed, or the plan isn't yours to see any more: show what's really there
    if (m.includes("not_member")) { if (!quiet) reloadSoon(0); return "You're not in this space any more."; }
    if (m.includes("not_found")) { if (!quiet) reloadSoon(0); return "That plan isn't there for you any more."; }
    if (!navigator.onLine) return "You're offline. Try again when you have signal.";
    if (m && !isNetworkError(error)) return "Something went wrong on the account server (" + m.slice(0, 60) + "). Try again.";
    return "Couldn't reach the account server. Try again in a moment.";
  }

  // Reads every row, 1,000 at a time: the server sends at most 1,000 per request and doesn't say it cut the rest
  async function selectAll(makeQuery) {
    const rows = [];
    for (let from = 0; ; from += 1000) {
      const { data: page, error } = await makeQuery().range(from, from + 999);
      if (error) return { data: null, error };
      rows.push(...page);
      if (page.length < 1000) return { data: rows, error: null };
    }
  }

  // ---------- Loading ----------

  async function load() {
    if (!client || !user) return;
    try {
      await client.rpc("expire_plans");
      const { data: groups, error: e1 } = await client.from("groups").select("id,name,created_at,owner_id").order("created_at");
      if (e1) throw e1;
      // The space to show: the one you joined or started last on this phone, else the first one
      let preferred = null;
      try { preferred = localStorage.getItem(GROUP_KEY + "." + user.id); } catch (_) {}
      const next = { ...emptyData(), userId: user.id, groups,
        group: groups.find(g => g.id === preferred) || groups[0] || null };
      // Plans waiting for your answer in every space (the rules only return plans you're in)
      if (groups.length) {
        const { data: waiting, error: ew } = await client.from("plan_people").select("items!inner(group_id,status,day)")
          .eq("user_id", user.id).eq("answer", "waiting").in("items.status", ["suggested", "approved"]);
        if (ew) throw ew;
        for (const w of waiting) {
          if (stillOpen(w.items)) next.waitingBy[w.items.group_id] = (next.waitingBy[w.items.group_id] || 0) + 1;
        }
      }
      if (next.group) {
        const g = next.group.id;
        const [members, items] = await Promise.all([
          client.from("group_members").select("user_id,joined_at,invited_by,owner_seen").eq("group_id", g).order("joined_at"),
          selectAll(() => client.from("items").select(ITEM_COLUMNS).eq("group_id", g).order("created_at").order("id")),
        ]);
        if (members.error) throw members.error;
        if (items.error) throw items.error;
        const ids = members.data.map(m => m.user_id);
        // Names of the people here and of whoever invited them (the rules only return people you share a space with)
        const nameIds = [...new Set([...ids, ...members.data.map(m => m.invited_by).filter(Boolean)])];
        const { data: profiles, error: e2 } = await client.from("profiles").select("id,display_name").in("id", nameIds);
        if (e2) throw e2;
        const nameFor = id => (profiles.find(p => p.id === id) || {}).display_name || "";
        next.members = members.data.map(m => ({ id: m.user_id, name: nameFor(m.user_id), joinedAt: m.joined_at,
          invitedBy: m.invited_by, invitedByName: nameFor(m.invited_by), ownerSeen: m.owner_seen !== false }));
        next.items = items.data;
        const planIds = items.data.filter(i => i.kind === "plan").map(i => i.id);
        if (planIds.length) {
          const [events, people] = await Promise.all([
            selectAll(() => client.from("plan_events").select("item_id,actor,action,day,part,exact_time,note,plan_version,created_at")
              .in("item_id", planIds).order("created_at").order("id")),
            selectAll(() => client.from("plan_people").select("item_id,user_id,answer").in("item_id", planIds)
              .order("item_id").order("user_id")),
          ]);
          if (events.error) throw events.error;
          if (people.error) throw people.error;
          for (const ev of events.data) (next.events[ev.item_id] = next.events[ev.item_id] || []).push(ev);
          for (const pp of people.data) (next.people[pp.item_id] = next.people[pp.item_id] || []).push(pp);
          // Your busy privacy (only your own rows come back). An older server without it: every plan stays "everyone".
          const privacy = await client.from("plan_busy_privacy").select("item_id,mode,viewers").in("item_id", planIds);
          next.privacyReady = !privacy.error;
          if (!privacy.error) for (const r of privacy.data) next.privacy[r.item_id] = r;
        }
        const { data: all } = await client.from("profiles").select("id,display_name");
        next.everyone = (all || []).map(p => ({ id: p.id, name: p.display_name || "" }));
      } else {
        // Your own name is still needed for the first screen
        const { data: me } = await client.from("profiles").select("id,display_name").eq("id", user.id);
        next.members = me && me.length ? [{ id: user.id, name: me[0].display_name }] : [];
      }
      data = next;
      online = true;
      lastError = "";
      saveCache();
      saveTimeZone();
      subscribe();
      await flushOutbox();
    } catch (e) {
      online = false;
      lastError = explain(e, true);
    }
    emit();
  }

  // The phone's time zone, so a reminder for "7:00 pm" comes at 7 pm where you are (once per app start)
  let tzSaved = false;
  async function saveTimeZone() {
    if (tzSaved || !me()) return;
    tzSaved = true;
    let tz = "";
    try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch (_) {}
    if (tz) await client.from("profiles").update({ tz }).eq("id", user.id);
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
      // A delete can't be filtered by space, so any deleted item (only its id is sent) reloads this space
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "items" }, () => reloadSoon())
      .subscribe();
    channel.groupId = g;
  }

  // ---------- Names and the group ----------

  const me = () => data.members.find(m => m.id === (user && user.id));
  const myName = () => (me() && me().name) || "";
  const nameOf = id => (data.members.find(m => m.id === id) || {}).name || "Someone";
  const others = () => data.members.filter(m => m.id !== (user && user.id));

  // Who runs the space: the person who started it, or (once they left) the longest member. Same rule as the
  // server's space_owner() in family-2.sql; members come sorted by when they joined.
  function owner() {
    if (!data.group) return null;
    return data.members.find(m => m.id === data.group.owner_id) || data.members[0] || null;
  }
  const isOwner = () => !!user && !!owner() && owner().id === user.id;

  // Only the person who runs the space removes someone (the server checks this too)
  async function removeMember(id) {
    const { error } = await client.rpc("remove_member", { p_group: data.group.id, p_user: id });
    await load();
    if (error && (error.message || "").includes("not_member")) return "They're not in this space any more.";
    return error ? explain(error) : "";
  }

  // Anyone can leave a space on their own (if the person who runs it leaves, the longest member takes over)
  async function leaveGroup() {
    const { error } = await client.from("group_members").delete().eq("group_id", data.group.id).eq("user_id", user.id);
    if (error) return explain(error);
    try { localStorage.removeItem(GROUP_KEY + "." + user.id); } catch (_) {}
    await load();
    return "";
  }

  // The person who runs the space has seen who joined with someone else's code
  async function ackMember(id) {
    const { error } = await client.rpc("ack_member", { p_group: data.group.id, p_user: id });
    await load();
    return error ? explain(error) : "";
  }

  async function setName(name) {
    name = name.trim().slice(0, 40);
    if (!name) return "Type a name first.";
    const { error } = await client.from("profiles").upsert({ id: user.id, display_name: name });
    if (error) return explain(error);
    await load();
    return "";
  }

  function rememberGroup(id) {
    try { if (id) localStorage.setItem(GROUP_KEY + "." + user.id, id); } catch (_) {}
  }

  // Shows another of your spaces (remembered on this phone)
  async function switchGroup(id) {
    if (!data.groups.some(g => g.id === id) || (data.group && data.group.id === id)) return;
    rememberGroup(id);
    await load();
  }

  async function createGroup(name) {
    name = (name || "").trim().slice(0, 40) || "Together";
    const { data: groupId, error } = await client.rpc("create_group", { p_name: name });
    if (error) return { error: explain(error) };
    rememberGroup(groupId);
    const { data: code, error: e2 } = await client.rpc("make_invite", { p_group: groupId });
    await load();
    return e2 ? { error: explain(e2) } : { code };
  }

  async function makeInvite() {
    const { data: code, error } = await client.rpc("make_invite", { p_group: data.group.id });
    if (error) return { error: explain(error) };
    return { code };
  }

  async function joinGroup(code) {
    const { data: groupId, error } = await client.rpc("join_group", { p_code: code });
    if (error) return explain(error);
    rememberGroup(groupId);
    await load();
    return "";
  }

  // ---------- Shared tasks ----------

  async function write(promise) {
    const { error } = await promise;
    if (error) { lastError = explain(error); emit(); reloadSoon(0); return false; }   // reload undoes the early change on screen
    reloadSoon(0);
    return true;
  }

  function addTask(text, part) {
    text = text.trim().slice(0, 200);
    if (!text || !data.group) return Promise.resolve(false);
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
    const t = data.items.find(i => i.id === id);
    if (!text || !t) return;
    t.title = text;   // shows at once; the reload brings back the saved one
    emit();
    return write(client.from("items").update({ title: text }).eq("id", id));
  }

  function deleteTask(id) {
    data.items = data.items.filter(i => i.id !== id);
    emit();
    return write(client.from("items").delete().eq("id", id));
  }

  // ---------- Plans ----------

  // A plan suggested offline waits in the outbox with its own id, so sending it twice still adds it once.
  // people = the ids ticked (you're always in it); null = everyone in the space.
  async function suggestPlan({ title, day, part, time, note, details, people }) {
    title = (title || "").trim().slice(0, 200);
    if (!title) return "Name the plan first.";
    if (!day || !part) return "Pick a day and a part of the day.";
    if (people && !people.length) return "Pick at least one person.";
    const plan = { p_group: data.group.id, p_title: title, p_day: day, p_part: part, p_time: time || null,
      p_note: (note || "").trim().slice(0, 200) || null, p_id: makeId(),
      p_details: (details || "").trim().slice(0, 1000) || null, p_people: people ? [user.id, ...people] : null };
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
    const left = [], refused = [];
    for (const plan of list) {
      const { error } = await client.rpc("suggest_plan", plan);
      if (!error) continue;
      // No connection or a server hiccup (5xx): try again later. A clear "no" from the rules: drop it and say so.
      if (isNetworkError(error) || error.status >= 500 || !error.message) left.push(plan);
      else refused.push(plan.p_title + " (" + explain(error) + ")");
    }
    // Keep plans that were added to the outbox while this was sending
    const sentIds = new Set(list.map(p => p.p_id));
    setOutbox([...left, ...outbox().filter(p => !sentIds.has(p.p_id))]);
    if (refused.length) { notice = "A plan made offline couldn't be sent: " + refused.join("; "); emit(); }
    if (left.length < list.length) reloadSoon(0);
  }

  // action: "approved" (Going), "declined" (Can't, or taking back your own suggestion) or "countered" (Other time,
  // with a new day / part / time)
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

  // Who sees that you're busy for this plan (people not in it): "all", "some" (viewers) or "none"
  const privacyOf = id => data.privacy[id] || { mode: "all", viewers: [] };
  async function setBusyPrivacy(id, mode, viewers = []) {
    const { error } = await client.rpc("set_busy_privacy", { p_item: id, p_mode: mode, p_viewers: viewers });
    await load();
    return error ? explain(error) : "";
  }

  // Anyone in the plan can change its details; the change is kept in its history
  async function setDetails(id, details) {
    const { error } = await client.rpc("set_plan_details", { p_item: id, p_details: (details || "").slice(0, 1000) });
    await load();
    return error ? explain(error) : "";
  }

  // ---------- Personal busy link ----------
  // One link per person that shows when they're busy (supabase/busy-link.sql). Anyone with it can look; a new link
  // turns the old one off.

  async function getBusyLink() {
    const { data: rows, error } = await client.from("share_links").select("token,created_at")
      .eq("user_id", user.id).eq("active", true).order("created_at", { ascending: false }).limit(1);
    if (error) return { error: explain(error) };
    return { token: rows && rows[0] ? rows[0].token : null };
  }

  async function newBusyLink() {
    const off = await client.from("share_links").update({ active: false }).eq("user_id", user.id).eq("active", true);
    if (off.error) return { error: explain(off.error) };
    const { data: row, error } = await client.from("share_links").insert({ user_id: user.id }).select("token").single();
    if (error) return { error: explain(error) };
    return { token: row.token };
  }

  async function turnOffBusyLink() {
    const { error } = await client.from("share_links").update({ active: false }).eq("user_id", user.id).eq("active", true);
    return error ? explain(error) : "";
  }

  // Signing out: this phone stops getting the account's notifications (removed from the account, then unsubscribed)
  async function beforeSignOut() {
    try {
      if (!pushSupported() || !navigator.serviceWorker.controller) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && await reg.pushManager.getSubscription();
      if (!sub) return;
      await client.from("push_subscriptions").delete().eq("endpoint", sub.endpoint);
      await sub.unsubscribe();
    } catch (_) { /* signing out still works */ }
  }

  // ---------- Lists for the screen ----------

  const today = () => dayKey();
  const plans = () => data.items.filter(i => i.kind === "plan");
  const sortByDay = list => list.sort((a, b) => (a.day + partOrder(a.part)).localeCompare(b.day + partOrder(b.part)));
  const partOrder = p => String(["morning", "afternoon", "evening"].indexOf(p));

  // Who is in a plan and their answers; your own answer
  const peopleIn = id => (data.people[id] || []).map(pp => ({ id: pp.user_id, name: nameOf(pp.user_id), answer: pp.answer }));
  const answerOf = (p, id = user && user.id) => ((data.people[p.id] || []).find(pp => pp.user_id === id) || {}).answer;
  // Still open for answers: waiting for the first Going, or on and not over yet (others may still answer)
  const stillOpen = p => p.status === "suggested" || (p.status === "approved" && p.day >= today());

  function lists() {
    const mine = user && user.id;
    const waiting = plans().filter(p => answerOf(p) === "waiting" && stillOpen(p));
    const sent = plans().filter(p => p.status === "suggested" && p.last_by === mine);
    const upcoming = plans().filter(p => p.status === "approved" && p.day >= today() && answerOf(p) === "going");
    const shown = new Set([...waiting, ...sent, ...upcoming]);
    return {
      waiting: sortByDay(waiting), sent: sortByDay(sent), upcoming: sortByDay(upcoming),
      past: plans().filter(p => !shown.has(p)).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
      tasks: data.items.filter(i => i.kind === "task"),
      outbox: outbox(),
    };
  }

  // Every space together (the tab badge), or one space; the space on screen counts from its own fresh list
  const waitingCount = groupId => {
    const shown = data.group ? data.group.id : null;
    if (groupId) return groupId === shown ? lists().waiting.length : data.waitingBy[groupId] || 0;
    return data.groups.reduce((n, g) => n + (g.id === shown ? lists().waiting.length : data.waitingBy[g.id] || 0), 0);
  };

  // ---------- Phone notifications ----------
  // iPhone: only in the app opened from the Home Screen (iOS 16.4+), and the request must come from a tap.

  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const pushState = () => !pushSupported() ? "unsupported" : Notification.permission;   // default / granted / denied

  function keyBytes(b64) {
    const s = atob((b64 + "=".repeat((4 - b64.length % 4) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(s, c => c.charCodeAt(0));
  }

  // Signs this phone up (or refreshes its sign-up) and saves it to the account
  async function enablePush(askFirst = true) {
    if (!pushSupported()) return "This browser can't show notifications. On iPhone, open Daily from the Home Screen.";
    if (askFirst && Notification.permission !== "granted") {
      const answer = await Notification.requestPermission();
      if (answer !== "granted") return "Notifications are off. Turn them on in iPhone Settings → Notifications → Daily.";
    }
    if (Notification.permission !== "granted") return "";
    try {
      const { data: publicKey, error } = await client.rpc("vapid_public_key");
      if (error || !publicKey) return "Notifications aren't set up on the server yet.";
      // ready never settles if the offline helper didn't install: give up after 10 s instead of locking the tab
      const reg = await Promise.race([navigator.serviceWorker.ready,
        new Promise((_, no) => setTimeout(() => no(new Error("the app's offline helper isn't running; reopen the app")), 10000))]);
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
      const j = sub.toJSON();
      let { error: e2 } = await client.from("push_subscriptions")
        .upsert({ endpoint: j.endpoint, user_id: user.id, p256dh: j.keys.p256dh, auth: j.keys.auth });
      if (e2) {
        // This phone's sign-up still belongs to another account (signed out before this fix): make a fresh one
        await sub.unsubscribe();
        sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
        const k = sub.toJSON();
        ({ error: e2 } = await client.from("push_subscriptions")
          .upsert({ endpoint: k.endpoint, user_id: user.id, p256dh: k.keys.p256dh, auth: k.keys.auth }));
      }
      if (e2) return explain(e2);
      emit();
      return "";
    } catch (e) {
      return "Couldn't turn on notifications (" + (e && e.message) + ").";
    }
  }

  // ---------- Start ----------

  function init() {
    if (typeof Sync === "undefined") return;
    Sync.onUserChange(u => {
      client = Sync.getClient();
      user = u;
      if (channel && client) { client.removeChannel(channel); channel = null; }
      tzSaved = false;
      data = u ? loadCache(u.id) : emptyData();
      emit();
      if (u) load();
      if (u && pushState() === "granted") enablePush(false);   // keep this phone's sign-up fresh
    });
    document.addEventListener("visibilitychange", () => { if (!document.hidden && user) reloadSoon(0); });
    window.addEventListener("online", () => { if (user) load(); });
  }

  return {
    init, load, onChange: fn => listeners.push(fn),
    signedIn: () => !!user, online: () => online, error: () => lastError || notice,
    clearError: () => { lastError = ""; notice = ""; },
    group: () => data.group, groups: () => data.groups || [], members: () => data.members, me, myName, nameOf,
    others, owner, isOwner, myId: () => user && user.id,
    events: id => data.events[id] || [], peopleIn, answerOf, privacyOf, setBusyPrivacy,
    everyone: () => data.everyone || [], privacyReady: () => !!data.privacyReady,
    setName, createGroup, makeInvite, joinGroup, switchGroup, removeMember, ackMember, leaveGroup,
    addTask, toggleTask, renameTask, deleteTask,
    suggestPlan, answerPlan, setDetails, lists, waitingCount,
    pushState, enablePush,
    getBusyLink, newBusyLink, turnOffBusyLink, beforeSignOut,
  };
})();

Together.init();
