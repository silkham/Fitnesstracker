'use strict';

// ============================================================
// STATE
// ============================================================
const State = {
  client: null,
  user: null,
  householdId: null,
  members: [],          // [{id, slot:'a'|'b', display_name, accent, ...}]
  activeMemberId: null, // current viewer
  settings: null,
  recipes: [],
  ingredients: {},      // {recipe_id: [ingredients]}
  weekPlan: null,
  weekStart: null,      // ISO date string of current week's Monday
  workouts: [],         // current week's workouts
  weights: [],          // all weight entries (history)
  strengthSets: [],     // strength_sets rows (history)
  shoppingItems: [],
  mealPlan: null,       // week_plans row currently shown in the Meals tab
  mealWeekStart: null,  // ISO Monday of the meals tab's viewed week
  mealsTab: 'week',
  vaultCategory: 'dinner',
  personalSlots: [],    // meal_slots_personal rows for current user
  pendingWrites: [],    // offline queue
  realtimeChannel: null,
  isOnline: navigator.onLine,
  programs: [],         // [{id, title, subtitle, classes:[{order,ride_id,title,instructor,duration_min}]}]
  programProgress: {},  // {program_id: Set<slot index>} — completed slots; repeated rides tick one slot per completion
  trainingTab: 'ride',  // Progress screen: ride | strength discipline toggle
  oneRmLift: null,      // Progress screen: exercise shown in the 1RM trend
  programFilter: 'all', // Programs tab: all | inprogress | completed
  currentProgramId: null, // program open in the detail screen
  programTab: 'overview', // detail screen: 'overview' | week index (0-based)
  planTab: 'program',   // Plan screen: program | instructor
  instructorSchedule: null, // { instructors, classes:[...] } | 'loading' | 'error' — cache for the Instructor sub-view
  instructorDir: null,  // { foldedName: {name, image} } — cached Peloton instructor directory (photos)
};

// ============================================================
// CONFIG (Supabase URL/key)
// ============================================================
const CFG_KEY = 'household_supabase_config_v1';
const DEVICE_MEMBER_KEY = 'household_device_member_v1';
// App version — shown on the You page. Bump the build each deploy to track updates.
const APP_VERSION = 'Stride · v4.8.1';

// Baked-in defaults so no device ever has to paste config.
// The anon key is public by design — data is protected by Supabase Row Level Security.
const DEFAULT_SUPABASE_URL = 'https://dgbbyijhabjozqrkokrq.supabase.co';
const DEFAULT_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRnYmJ5aWpoYWJqb3pxcmtva3JxIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMTA2ODgsImV4cCI6MjA5NDU4NjY4OH0.0VnZVRXNexVQBoYFrVXtGo9Ep-Gdv_04jGcX9NQLcE0';

// ============================================================
// NHS COUCH TO 5K — 9 week prescriptions
// Source: nhs.uk/better-health/get-active/get-running-with-couch-to-5k
// Three runs per week, rest day between each.
// ============================================================
const C25K_WEEKS = {
  1: { all: 'Brisk 5-min walk. Then alternate 60s run + 90s walk × 8. Total ~20 min running/walking. Cool-down walk.' },
  2: { all: 'Brisk 5-min walk. Then alternate 90s run + 2 min walk × 6. Total ~20 min. Cool-down walk.' },
  3: { all: 'Brisk 5-min walk. Then 2 × (90s run + 90s walk + 3 min run + 3 min walk). Cool-down walk.' },
  4: { all: 'Brisk 5-min walk. Then 3 min run, 90s walk, 5 min run, 2.5 min walk, 3 min run, 90s walk, 5 min run. Cool-down walk.' },
  5: {
    1: 'Run 1: 5-min walk. Then 5 min run, 3 min walk, 5 min run, 3 min walk, 5 min run.',
    2: 'Run 2: 5-min walk. Then 8 min run, 5 min walk, 8 min run.',
    3: 'Run 3: 5-min walk. Then 20 minutes running, no walking.',
  },
  6: {
    1: 'Run 1: 5-min walk. Then 5 min run, 3 min walk, 8 min run, 3 min walk, 5 min run.',
    2: 'Run 2: 5-min walk. Then 10 min run, 3 min walk, 10 min run.',
    3: 'Run 3: 5-min walk. Then 25 minutes running, no walking.',
  },
  7: { all: 'Brisk 5-min walk. Then 25 minutes running, no walking. Cool-down walk.' },
  8: { all: 'Brisk 5-min walk. Then 28 minutes running, no walking. Cool-down walk.' },
  9: { all: 'Brisk 5-min walk. Then 30 minutes running, no walking. You can do this. Cool-down walk.' },
};

function c25kPrescription(weekNum, runNum) {
  const w = C25K_WEEKS[weekNum];
  if (!w) return null;
  if (w.all) return w.all;
  return w[runNum] || w[1] || null;
}

function getConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null');
    if (saved && saved.url && saved.key) return saved;
  } catch {}
  // Fall back to baked-in defaults so the config gate never appears.
  if (DEFAULT_SUPABASE_URL && DEFAULT_SUPABASE_KEY) {
    return { url: DEFAULT_SUPABASE_URL, key: DEFAULT_SUPABASE_KEY };
  }
  return null;
}
function setConfig(url, key) {
  localStorage.setItem(CFG_KEY, JSON.stringify({ url, key }));
}

// Single-user: resolve which member belongs to the signed-in account (no picker needed).
function resolveActiveMember() {
  if (!State.members.length) return null;
  // 1. membership row's member, if the DB linked one
  if (State._suggestedMemberId) {
    const s = State.members.find(m => m.id === State._suggestedMemberId);
    if (s) return s;
  }
  // 2. a previously-remembered choice on this device
  const savedSlot = localStorage.getItem(DEVICE_MEMBER_KEY);
  if (savedSlot) {
    const m = State.members.find(x => x.slot === savedSlot);
    if (m) return m;
  }
  // 3. match a member's first name against the signed-in email (e.g. lachlan… → Lachlan)
  const emailLocal = ((State.user && State.user.email) || '').split('@')[0].toLowerCase();
  if (emailLocal) {
    const byName = State.members.find(m => {
      const n = (m.display_name || '').toLowerCase().split(/\s+/)[0];
      return n && (emailLocal.includes(n) || n.includes(emailLocal));
    });
    if (byName) return byName;
  }
  // 4. fallback
  return State.members[0];
}

// ============================================================
// IDENTITY PICKER (per-device "soft pick")
// ============================================================
function showIdentityPicker() {
  const root = document.getElementById('idTiles');
  if (!root || State.members.length < 2) return;
  root.innerHTML = State.members.map(m => {
    const initial = (m.display_name || '?')[0].toUpperCase();
    return `<button class="id-tile ${m.slot}" onclick="pickIdentity('${m.slot}','${m.id}')">
      <div class="id-tile-mark">${escapeHtml(initial)}</div>
      <div class="id-tile-info">
        <div class="id-tile-name">${escapeHtml(m.display_name)}</div>
        <div class="id-tile-meta">${m.life_goal_title ? escapeHtml(m.life_goal_title) : 'Tap to use this device'}</div>
      </div>
    </button>`;
  }).join('');
  document.getElementById('identityGate').classList.remove('hide');
}

function pickIdentity(slot, memberId) {
  localStorage.setItem(DEVICE_MEMBER_KEY, slot);
  State.activeMemberId = memberId;
  applyMemberTheme();
  document.getElementById('identityGate').classList.add('hide');
  renderAll();
}

function switchDeviceIdentity() {
  if (!confirm('Switch this device to the other person? You can switch back any time.')) return;
  showIdentityPicker();
}
function saveConfig() {
  const url = document.getElementById('cfgUrl').value.trim();
  const key = document.getElementById('cfgKey').value.trim();
  const err = document.getElementById('cfgError');
  if (!url || !key) { err.textContent = 'Both fields are required.'; err.classList.remove('hide'); return; }
  if (!url.startsWith('https://') || !url.includes('.supabase.co')) {
    err.textContent = 'URL should look like https://xxx.supabase.co';
    err.classList.remove('hide'); return;
  }
  if (!key.startsWith('eyJ')) {
    err.textContent = 'That doesn\'t look like an anon key. It should start with "eyJ".';
    err.classList.remove('hide'); return;
  }
  setConfig(url, key);
  location.reload();
}

// ============================================================
// AUTH
// ============================================================
let authMode = 'signin'; // 'signin' | 'signup' | 'join'

function setAuthMode(mode, e) {
  e && e.preventDefault();
  authMode = mode;
  const cfg = {
    signin: { title:'Welcome back.', sub:'Sign in to your household.', btn:'Sign in' },
    signup: { title:'New household.', sub:'Create your shared account.', btn:'Create household' },
    join:   { title:'Join your household.', sub:'Use the code your partner shared from their Profile.', btn:'Join household' },
  }[mode];
  document.getElementById('authTitle').textContent = cfg.title;
  document.getElementById('authSub').textContent = cfg.sub;
  document.getElementById('authBtn').textContent = cfg.btn;
  document.getElementById('authBtn').disabled = false;
  document.getElementById('authJoinCode').classList.toggle('hide', mode !== 'join');
  document.getElementById('authError').classList.add('hide');

  const t1 = document.getElementById('authToggle1');
  const t2 = document.getElementById('authToggle2');
  if (mode === 'signin') {
    t1.innerHTML = `No household yet? <a href="#" onclick="setAuthMode('signup', event)">Create one</a>`;
    t2.innerHTML = `<a href="#" onclick="setAuthMode('join', event)">Joining an existing household?</a>`;
  } else if (mode === 'signup') {
    t1.innerHTML = `Already have one? <a href="#" onclick="setAuthMode('signin', event)">Sign in</a>`;
    t2.innerHTML = `<a href="#" onclick="setAuthMode('join', event)">Joining an existing household?</a>`;
  } else {
    t1.innerHTML = `<a href="#" onclick="setAuthMode('signin', event)">Back to sign in</a>`;
    t2.innerHTML = '';
  }
}

// Back-compat shim — old onload code might still call this
function toggleAuthMode(e) {
  setAuthMode(authMode === 'signin' ? 'signup' : 'signin', e);
}

// Initialise the toggle UI on first show
document.addEventListener('DOMContentLoaded', () => {
  setAuthMode('signin');
});

async function doAuth() {
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPass').value;
  const joinCode = document.getElementById('authJoinCode').value.trim().toUpperCase();
  const btn = document.getElementById('authBtn');
  const err = document.getElementById('authError');
  err.classList.add('hide');

  if (!email || !pass) { err.textContent = 'Email and password required.'; err.classList.remove('hide'); return; }
  if (pass.length < 6) { err.textContent = 'Password must be at least 6 characters.'; err.classList.remove('hide'); return; }
  if (authMode === 'join' && !joinCode) { err.textContent = 'Household code required.'; err.classList.remove('hide'); return; }

  btn.disabled = true;
  const origText = btn.textContent;
  btn.textContent = '…';

  try {
    if (authMode === 'signin') {
      const r = await State.client.auth.signInWithPassword({ email, password: pass });
      if (r.error) throw r.error;
    } else if (authMode === 'signup') {
      const r = await State.client.auth.signUp({ email, password: pass });
      if (r.error) throw r.error;
    } else {
      // join: include join_code in user metadata for the trigger to read
      const r = await State.client.auth.signUp({
        email,
        password: pass,
        options: { data: { join_code: joinCode } },
      });
      if (r.error) throw r.error;
    }
    // onAuthStateChange fires → loadAll → resolves household via memberships
  } catch (e) {
    err.textContent = e.message || 'Something went wrong.';
    err.classList.remove('hide');
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function signOut() {
  if (!confirm('Sign out on this device?')) return;
  localStorage.removeItem(DEVICE_MEMBER_KEY);
  await State.client.auth.signOut();
  location.reload();
}

// ============================================================
// HOUSEHOLD ID — fetch from JWT or from members table
// ============================================================
async function resolveHouseholdId() {
  // 1. JWT app_metadata (set immediately on signup by trigger)
  const meta = State.user.app_metadata || {};
  if (meta.household_id) return meta.household_id;

  // 2. household_memberships table (canonical source after migration)
  const { data: mems, error: memErr } = await State.client
    .from('household_memberships')
    .select('household_id, member_id')
    .eq('user_id', State.user.id)
    .limit(1);
  if (memErr) {
    // Table might not exist on old DBs — fall through to email lookup
    console.warn('memberships lookup failed', memErr);
  } else if (mems && mems[0]) {
    if (mems[0].member_id) State._suggestedMemberId = mems[0].member_id;
    return mems[0].household_id;
  }

  // 3. Legacy fallback: lookup by owner_email
  const { data, error } = await State.client
    .from('households')
    .select('id')
    .eq('owner_email', State.user.email)
    .limit(1);
  if (error) throw error;
  if (data && data[0]) return data[0].id;

  throw new Error('Household not found. Try signing out and back in.');
}

// ============================================================
// INITIAL LOAD
// ============================================================
async function loadAll() {
  setSync('syncing', 'Loading');
  try {
    State.householdId = await resolveHouseholdId();

    const [household, members, settings, recipes, weights, workouts, weekPlan] = await Promise.all([
      State.client.from('households').select('*').eq('id', State.householdId).single(),
      State.client.from('members').select('*').eq('household_id', State.householdId).order('slot'),
      State.client.from('settings').select('*').eq('household_id', State.householdId).single(),
      State.client.from('recipes').select('*').eq('household_id', State.householdId).order('created_at'),
      State.client.from('weight_entries').select('*').eq('household_id', State.householdId).order('logged_at', { ascending: false }).limit(180),
      State.client.from('workouts').select('*').eq('household_id', State.householdId).gte('planned_for', isoDateAddDays(todayISO(), -90)).lte('planned_for', isoDateAddDays(weekStartFor(new Date()), 41)),
      getOrCreateWeekPlan(weekStartFor(new Date())),
    ]);

    State.household = household.data || null;
    State.members = members.data || [];
    State.settings = settings.data || null;
    State.recipes = recipes.data || [];
    State.weights = weights.data || [];
    State.workouts = workouts.data || [];
    State.weekPlan = weekPlan;
    State.weekStart = weekPlan.week_start;
    State.mealPlan = weekPlan;
    State.mealWeekStart = weekPlan.week_start;

    // load strength sets (last 120 days). Resilient: table may not exist yet.
    try {
      const since = isoDateAddDays(todayISO(), -120);
      const { data: sets, error: setErr } = await State.client
        .from('strength_sets')
        .select('*')
        .eq('member_id', State.activeMemberId || (members.data && members.data[0] && members.data[0].id))
        .gte('performed_at', since)
        .order('performed_at', { ascending: false })
        .order('created_at', { ascending: false });
      State.strengthSets = setErr ? [] : (sets || []);
    } catch (e) { State.strengthSets = []; }

    // load Peloton API-health heartbeat (single row, safe cols only). Resilient.
    await loadPelotonHealth();

    // load Programs manifests + completion (joined against done workouts)
    await loadPrograms();
    await loadProgramProgress();

    // load ingredients
    if (State.recipes.length) {
      const { data: ings } = await State.client
        .from('ingredients')
        .select('*')
        .in('recipe_id', State.recipes.map(r => r.id))
        .order('sort_order');
      State.ingredients = {};
      (ings || []).forEach(i => {
        if (!State.ingredients[i.recipe_id]) State.ingredients[i.recipe_id] = [];
        State.ingredients[i.recipe_id].push(i);
      });
    }

    // load shopping items for current week
    const { data: shop } = await State.client
      .from('shopping_items')
      .select('*')
      .eq('week_plan_id', State.weekPlan.id)
      .order('aisle')
      .order('sort_order');
    State.shoppingItems = shop || [];

    // load personal breakfast/lunch slots for this user (current week + next)
    const weekEnd = isoDateAddDays(State.weekStart, 13);
    const { data: personal } = await State.client
      .from('meal_slots_personal')
      .select('*')
      .eq('household_id', State.householdId)
      .eq('user_id', State.user.id)
      .gte('date', State.weekStart)
      .lte('date', weekEnd);
    State.personalSlots = personal || [];
    // Single-user: auto-bind to the member that belongs to the signed-in account. No picker.
    const me = resolveActiveMember();
    State.activeMemberId = me?.id || State.members[0]?.id || null;
    if (me?.slot) localStorage.setItem(DEVICE_MEMBER_KEY, me.slot);
    applyMemberTheme();

    // realtime
    setupRealtime();

    setSync('synced', 'Synced');
    renderAll();

    // Quiet auto-sync of Peloton calendars (no UI noise)
    autoSyncIfDue();
  } catch (e) {
    console.error(e);
    setSync('offline', 'Error');
    toast('Failed to load: ' + (e.message || 'unknown'));
  }
}

async function getOrCreateWeekPlan(weekStart) {
  const { data: existing } = await State.client
    .from('week_plans')
    .select('*')
    .eq('household_id', State.householdId)
    .eq('week_start', weekStart)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await State.client
    .from('week_plans')
    .insert({ household_id: State.householdId, week_start: weekStart, slots: {} })
    .select()
    .single();
  if (error) throw error;
  return created;
}

// ============================================================
// REALTIME
// ============================================================
function setupRealtime() {
  if (State.realtimeChannel) {
    State.client.removeChannel(State.realtimeChannel);
  }
  State.realtimeChannel = State.client
    .channel('hh:' + State.householdId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'shopping_items', filter: 'household_id=eq.' + State.householdId },
      (payload) => handleRealtime('shopping_items', payload))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'week_plans', filter: 'household_id=eq.' + State.householdId },
      (payload) => handleRealtime('week_plans', payload))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'workouts', filter: 'household_id=eq.' + State.householdId },
      (payload) => handleRealtime('workouts', payload))
    .subscribe();
}

function handleRealtime(table, payload) {
  if (table === 'shopping_items') {
    if (payload.eventType === 'INSERT') {
      if (!State.shoppingItems.find(s => s.id === payload.new.id)) {
        State.shoppingItems.push(payload.new);
      }
    } else if (payload.eventType === 'UPDATE') {
      const i = State.shoppingItems.findIndex(s => s.id === payload.new.id);
      if (i >= 0) State.shoppingItems[i] = payload.new;
    } else if (payload.eventType === 'DELETE') {
      State.shoppingItems = State.shoppingItems.filter(s => s.id !== payload.old.id);
    }
    if (State.mealsTab === 'shopping') renderShopping();
  } else if (table === 'week_plans') {
    if (payload.new && payload.new.id === State.weekPlan?.id) {
      State.weekPlan = payload.new;
      if (document.getElementById('screen-today').classList.contains('active')) renderToday();
      if (State.mealsTab === 'week') renderWeek();
    }
  } else if (table === 'workouts') {
    if (payload.eventType === 'INSERT') {
      if (!State.workouts.find(w => w.id === payload.new.id)) State.workouts.push(payload.new);
    } else if (payload.eventType === 'UPDATE') {
      const i = State.workouts.findIndex(w => w.id === payload.new.id);
      if (i >= 0) State.workouts[i] = payload.new;
    } else if (payload.eventType === 'DELETE') {
      State.workouts = State.workouts.filter(w => w.id !== payload.old.id);
    }
    renderAll();
  }
}

// ============================================================
// SYNC STATUS
// ============================================================
let syncTimeout;
function setSync(kind, text) {
  const el = document.getElementById('syncStatus');
  const t = document.getElementById('syncText');
  el.className = 'sync-status ' + kind + ' show';
  t.textContent = text || kind;
  clearTimeout(syncTimeout);
  if (kind === 'synced') {
    syncTimeout = setTimeout(() => el.classList.remove('show'), 1400);
  }
}

window.addEventListener('online', () => { State.isOnline = true; flushPendingWrites(); });
window.addEventListener('offline', () => { State.isOnline = false; setSync('offline', 'Offline'); });

async function flushPendingWrites() {
  // For v1 we keep this simple — pending writes mostly handled by retry-on-error within each action
  if (State.pendingWrites.length === 0) return;
  setSync('syncing', 'Syncing');
  for (const fn of State.pendingWrites.splice(0)) {
    try { await fn(); } catch (e) { console.error(e); }
  }
  setSync('synced', 'Synced');
}

// ============================================================
// HELPERS
// ============================================================
function todayISO() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function isoDateAddDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
function weekStartFor(date) {
  // Monday-based calendar week (used for shared week_plans + weekly count)
  const d = new Date(date);
  d.setHours(12, 0, 0, 0); // anchor to noon to avoid DST edges
  const day = d.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setDate(d.getDate() + diff);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}
function rolling7FromToday() {
  // Returns 7 ISO date strings starting today
  const t = todayISO();
  return Array.from({ length: 7 }, (_, i) => isoDateAddDays(t, i));
}

// ============================================================
// PELOTON HELPERS (isolated · no rendering dependencies)
// ============================================================
function detectWorkoutType(input) {
  if (!input) return null;
  const s = String(input).toLowerCase();
  // canonical app values pass straight through
  if (['ride','run','strength','yoga','stretch','walk','rest','other'].includes(s)) return s;
  // Apple Health / Peloton workout-type names
  if (s.includes('ride') || s.includes('cycl') || s.includes('bike') || s.includes('spin')) return 'ride';
  if (s.includes('strength') || s.includes('arms') || s.includes('legs') || s.includes('core') || s.includes('upper-body') || s.includes('lower-body') || s.includes('full-body') || s.includes('functional') || s.includes('pilates')) return 'strength';
  if (s.includes('yoga')) return 'yoga';
  if (s.includes('stretch') || s.includes('mobility') || s.includes('cool down')) return 'stretch';
  if (s.includes('walk') || s.includes('hik')) return 'walk';
  if (s.includes('run')) return 'run';
  return null;
}

// Normalise any stored/synced workout type to a canonical app value (falls back to raw).
function normType(t) { return detectWorkoutType(t) || t || 'other'; }

function parsePelotonUrl(rawText) {
  // Returns { url, class_id, workout_type, class_title } or null
  if (!rawText) return null;
  const text = String(rawText).trim();
  const urlMatch = text.match(/https?:\/\/[^\s]+/);
  if (!urlMatch) return null;
  const url = urlMatch[0];
  if (!/onepeloton\.|pelotoncycle\./i.test(url)) return null;

  let parsed = null;
  try { parsed = new URL(url); } catch { return { url, class_id: null, workout_type: null, class_title: null }; }

  const path = parsed.pathname || '';
  // Match /classes/<discipline>/<uuid>-<title-slug>  or /classes/player/<uuid>
  // UUID is 32 hex chars with dashes or sometimes without
  const idMatch = path.match(/([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}|[0-9a-f]{32})/i);
  const class_id = idMatch ? idMatch[1] : null;

  // Workout type from path discipline
  const discMatch = path.match(/\/classes\/([a-z-]+)\//i);
  const workout_type = detectWorkoutType(discMatch ? discMatch[1] : path);

  // Title slug: text after the UUID, hyphen-joined → spaces
  let class_title = null;
  if (idMatch) {
    const after = path.slice(path.indexOf(idMatch[1]) + idMatch[1].length).replace(/^[-/]/, '');
    if (after && /[a-z]/i.test(after)) {
      class_title = after.replace(/-/g, ' ').replace(/\/+/g, ' ').trim();
      // Title-case the first letter of each word
      class_title = class_title.replace(/\b\w/g, c => c.toUpperCase());
      // Strip trailing slug fragments like " V2" or numeric IDs
      class_title = class_title.replace(/\s+\d+$/, '').trim();
    }
  }

  return { url, class_id, workout_type, class_title };
}

function buildPelotonDeepLink(url) {
  // Returns a best-effort iOS/Android app deep link; falls back to https URL
  if (!url) return null;
  // Peloton has not publicly documented universal links; the public web URL
  // opens in-app on iOS when the Peloton app is installed. Just return it.
  return url;
}

function formatWorkoutDisplay(w) {
  // Build human display strings from a workout row
  if (!w) return { primary: 'Rest day', secondary: null };
  const type = sessionTypeLabel(w.session_type);
  const dur = w.duration_min ? `${w.duration_min} min` : '';
  const instructor = w.instructor || null;
  const title = w.class_title || null;
  let primary;
  if (instructor && dur) primary = `${dur} ${type} — ${instructor}`;
  else if (dur) primary = `${type} · ${dur}`;
  else primary = type;
  return { primary, secondary: title };
}

// ============================================================
// PELOTON API SYNC (v3.1) — pulls planned + completed straight from
// Peloton via the peloton-ingest Edge Function, then reloads workouts.
// Auth uses the logged-in user's own Supabase JWT — no secret shipped.
// ============================================================
let _lastAutoSync = 0;  // throttle for autoSyncIfDue (≤1 run / 60s)

async function syncPeloton(showFeedback, force = false) {
  if (State._pelotonSyncing) return;
  State._pelotonSyncing = true;
  if (showFeedback) setSync('syncing', force ? 'Force syncing' : 'Syncing');
  try {
    const cfg = getConfig();
    const { data: { session } } = await State.client.auth.getSession();
    const token = session?.access_token;
    if (!token) { if (showFeedback) toast('Sign in to sync'); return; }

    const res = await fetch(`${cfg.url}/functions/v1/peloton-ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ force }),
    });
    if (!res.ok) {
      if (showFeedback) { setSync('offline', 'Sync failed'); toast('Peloton sync failed'); }
      console.error('peloton-ingest', res.status, await res.text());
      return;
    }
    const out = await res.json();

    // reload the workouts window so new/updated rows show immediately
    const { data: wk } = await State.client.from('workouts').select('*')
      .eq('household_id', State.householdId)
      .gte('planned_for', isoDateAddDays(todayISO(), -90))
      .lte('planned_for', isoDateAddDays(weekStartFor(new Date()), 41));
    if (wk) State.workouts = wk;

    if (showFeedback) {
      setSync('synced', 'Synced');
      const c = out.completed || {}, p = out.planned || {};
      const bits = [];
      if (c.inserted || c.upgraded) bits.push(`${(c.inserted || 0) + (c.upgraded || 0)} done`);
      if (c.refreshed) bits.push(`${c.refreshed} refreshed`);
      if (p.upserted) bits.push(`${p.upserted} planned`);
      if (p.deleted) bits.push(`${p.deleted} removed`);
      toast(bits.length ? bits.join(' · ') : 'Up to date');
    }
    renderAll();
  } catch (e) {
    console.error('syncPeloton', e);
    if (showFeedback) { setSync('offline', 'Sync failed'); toast('Peloton sync failed'); }
  } finally {
    State._pelotonSyncing = false;
    Promise.all([loadPelotonHealth(), loadProgramProgress()]).then(renderAll).catch(() => {});
  }
}

// ---- API-health (layer 1): read the heartbeat the function writes ----------
async function loadPelotonHealth() {
  try {
    const { data } = await State.client.rpc('peloton_health');
    State.pelotonHealth = (data && data[0]) || null;
  } catch (e) { State.pelotonHealth = null; }
}
function pelAgo(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 90) return 'just now';
  const m = Math.floor(s / 60); if (m < 90) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 36) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
// Status line under the Sync button. 🟢 healthy / 🟡 stale (dead cron) / 🔴 failing.
function pelotonHealthLine() {
  const h = State.pelotonHealth;
  if (!h) return '';
  const succ = h.last_success_at ? new Date(h.last_success_at).getTime() : 0;
  const attempt = h.last_attempt_at ? new Date(h.last_attempt_at).getTime() : 0;
  const failing = (h.fail_count || 0) > 0 && attempt >= succ;
  let color, label;
  if (failing) { color = 'var(--bramble)'; label = `Sync failing (${h.fail_count}×) · tap for detail`; }
  else if (!succ || Date.now() - succ > 12 * 3600 * 1000) { color = 'var(--rust)'; label = succ ? `Sync stale · last ok ${pelAgo(succ)}` : 'Never synced'; }
  else { color = 'var(--moss)'; label = `API healthy · synced ${pelAgo(succ)}`; }
  return `<div class="tiny" onclick="showPelotonHealth()" style="display:flex;align-items:center;gap:6px;padding:0 2px 8px;color:var(--ink-4);cursor:pointer;">
    <span style="width:6px;height:6px;border-radius:50%;background:${color};display:inline-block;flex:none;"></span>${escapeHtml(label)}</div>`;
}
function showPelotonHealth() {
  const h = State.pelotonHealth;
  if (!h) { toast('No sync info yet'); return; }
  if (h.last_error && (h.fail_count || 0) > 0) toast('Last error: ' + h.last_error);
  else toast(h.last_success_at ? ('Last synced ' + pelAgo(new Date(h.last_success_at).getTime())) : 'Never synced');
}

function autoSyncIfDue() {
  // Run at most once every 60 seconds, silently
  const now = Date.now();
  if (now - _lastAutoSync < 60_000) return;
  _lastAutoSync = now;
  syncPeloton(false).catch(() => {});
}

// ============================================================
// PROGRAMS · data-driven manifests (programs/program_classes tables),
// progress via peloton_ride_id join
// ============================================================
// Onboarded via OCR + the peloton-ingest catalog branch (see memory:
// program-discover-your-power-manifest). No live Programs API — Peloton's
// gql program resolvers are decommissioned (503s service-wide).

// Manifests rarely change once onboarded — loaded once at startup.
async function loadPrograms() {
  try {
    const [{ data: progs }, { data: classes }] = await Promise.all([
      State.client.from('programs').select('*').order('created_at'),
      State.client.from('program_classes').select('*').order('order_num'),
    ]);
    // Class artwork lives in the peloton_classes catalog (Peloton's ride stills,
    // synced by the ingest catalog branch) — join it in for hero fallbacks.
    const rideIds = [...new Set((classes || []).map(c => c.ride_id))];
    const imgByRide = {};
    if (rideIds.length) {
      const { data: cat } = await State.client.from('peloton_classes').select('peloton_ride_id,image_url').in('peloton_ride_id', rideIds);
      (cat || []).forEach(r => { if (r.image_url) imgByRide[r.peloton_ride_id] = r.image_url; });
    }
    const byProgram = {};
    (classes || []).forEach(c => {
      (byProgram[c.program_id] = byProgram[c.program_id] || []).push({
        order: c.order_num, ride_id: c.ride_id, title: c.title, instructor: c.instructor, duration_min: c.duration_min,
        image: imgByRide[c.ride_id] || null, week: c.week || null, day: c.day || null,
      });
    });
    // slot = position within the program, the identity progress is keyed by
    // (order_num comes from the DB and isn't guaranteed unique/contiguous)
    State.programs = (progs || []).map(p => ({
      id: p.id, title: p.title, subtitle: p.subtitle, image_url: p.image_url || null,
      classes: (byProgram[p.id] || []).map((c, i) => ({ ...c, slot: i })),
    }));
  } catch (e) { State.programs = State.programs || []; }
}

// One completed workout ticks ONE slot. Count completions per ride, then
// consume them across the program's slots in order — a ride repeated in later
// weeks (e.g. Stronger You's stretches) only ticks as many slots as it was
// actually done. Pure — unit-tested with jsc.
function programSlotTicks(classes, doneRideIds) {
  const left = {};
  doneRideIds.forEach(id => { left[id] = (left[id] || 0) + 1; });
  const done = new Set();
  classes.forEach(c => { if (left[c.ride_id] > 0) { done.add(c.slot); left[c.ride_id]--; } });
  return done;
}

// Completed-slot sets per program, keyed by program id. Refreshed after
// every Peloton sync (mirrors loadPelotonHealth).
async function loadProgramProgress() {
  for (const p of State.programs) {
    try {
      const ids = [...new Set(p.classes.map(c => c.ride_id))];
      const { data } = await State.client.from('workouts').select('peloton_ride_id').eq('status', 'done').in('peloton_ride_id', ids);
      State.programProgress[p.id] = programSlotTicks(p.classes, (data || []).map(w => w.peloton_ride_id));
    } catch (e) { State.programProgress[p.id] = State.programProgress[p.id] || new Set(); }
  }
}

// Programs mirror the Peloton app's structure: a filterable list of hero cards,
// then a full-page detail (Overview + per-week class lists). Hero artwork:
// programs.image_url → first class's ride still → instructor photo → gradient.
const PROGRAM_PER_WEEK = 5;
const PROGRAM_GRADS = [
  'linear-gradient(135deg,#7a4a24,#2a1710)',  // amber / Power Zones
  'linear-gradient(135deg,#1c4a6e,#0d1f30)',  // blue
  'linear-gradient(135deg,#4a3a6e,#1e1830)',  // violet
  'linear-gradient(135deg,#1c5a44,#0c2a20)',  // emerald
  'linear-gradient(135deg,#6e2440,#301019)',  // rose
  'linear-gradient(135deg,#2a4a6e,#101c2a)',  // steel
];
function programHash(id) {
  const s = String(id);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
function programGrad(p) { return PROGRAM_GRADS[programHash(p.id) % PROGRAM_GRADS.length]; }
// The program's own artwork (programs.image_url — absolute https URL, or a
// path relative to the app root for repo-hosted art), else the first class's
// Peloton ride still from the catalog join.
function programImage(p) {
  if (p.image_url) return p.image_url;
  const c = (p.classes || []).find(x => x.image);
  return c ? c.image : null;
}
function programHeroStyle(p) {
  const art = programImage(p);
  const img = art || instructorImage(programInstructors(p).primary);
  if (!img) return `background:${programGrad(p)};`;
  // program/ride art is landscape (centre it); instructor photos are portrait
  // headshots (bias toward the face at the top)
  return `background-image:linear-gradient(to top, rgba(0,0,0,0.74), rgba(0,0,0,0.12)), url('${img}');background-size:cover;background-position:center ${art ? '50%' : '18%'};`;
}

// Classes for 0-based week index w: real week/day columns when the manifest
// carries them (multi-class days, uneven weeks), else the legacy fixed slice.
function programWeekClasses(p, w) {
  if (p.classes.some(c => c.week)) return p.classes.filter(c => c.week === w + 1);
  return p.classes.slice(w * PROGRAM_PER_WEEK, (w + 1) * PROGRAM_PER_WEEK);
}
function programStats(p) {
  const done = State.programProgress[p.id] || new Set();
  const total = p.classes.length;
  const doneCount = p.classes.filter(c => done.has(c.slot)).length;
  const pct = total ? Math.round((doneCount / total) * 100) : 0;
  const weeks = p.classes.some(c => c.week)
    ? Math.max(...p.classes.map(c => c.week || 1))
    : Math.max(1, Math.ceil(total / PROGRAM_PER_WEEK));
  const perWeekCounts = [];
  for (let w = 0; w < weeks; w++) perWeekCounts.push(programWeekClasses(p, w).length);
  const durs = p.classes.map(c => c.duration_min).filter(d => d > 0);
  const status = doneCount === 0 ? 'notstarted' : (doneCount >= total ? 'completed' : 'inprogress');
  return {
    done, total, doneCount, pct, weeks, status,
    perWeekMin: Math.min(...perWeekCounts), perWeekMax: Math.max(...perWeekCounts),
    minDur: durs.length ? Math.min(...durs) : 0, maxDur: durs.length ? Math.max(...durs) : 0,
  };
}
function programInstructors(p) {
  const seen = [];
  p.classes.forEach(c => { const n = (c.instructor || '').trim(); if (n && !seen.includes(n)) seen.push(n); });
  return { primary: seen[0] || 'Various', extra: Math.max(0, seen.length - 1) };
}
function programNextClass(p) {
  const done = State.programProgress[p.id] || new Set();
  return p.classes.find(c => !done.has(c.slot)) || null;
}

// ---- Instructors: favourites list + Peloton photo directory ----
function foldName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}
function favouriteInstructors(m) {
  const raw = (m && m.favourite_instructor) ? String(m.favourite_instructor) : '';
  const out = [];
  raw.split(',').forEach(s => { const n = s.trim(); if (n && !out.some(x => foldName(x) === foldName(n))) out.push(n); });
  return out;
}
function primaryInstructor(m) { return favouriteInstructors(m)[0] || ''; }
function instructorImage(name) {
  if (!name || !State.instructorDir) return null;
  const hit = State.instructorDir[foldName(name)];
  return hit ? hit.image : null;
}
async function loadInstructorDirectory(force) {
  if (State.instructorDir && !force) return State.instructorDir;
  try {
    const cached = JSON.parse(localStorage.getItem('stride_instructor_dir_v1') || 'null');
    if (cached && !force && (Date.now() - cached.at) < 30 * 86400000) { State.instructorDir = cached.map; return State.instructorDir; }
  } catch (_e) { /* ignore cache read errors */ }
  try {
    const cfg = getConfig();
    const { data: { session } } = await State.client.auth.getSession();
    const token = session?.access_token;
    if (!token) return null;
    const res = await fetch(`${cfg.url}/functions/v1/peloton-ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: true }),
    });
    const out = await res.json().catch(() => ({}));
    if (out && out.ok && Array.isArray(out.instructors)) {
      const map = {};
      out.instructors.forEach(i => { if (i.name) map[foldName(i.name)] = { name: i.name, image: i.image || null }; });
      State.instructorDir = map;
      try { localStorage.setItem('stride_instructor_dir_v1', JSON.stringify({ at: Date.now(), map })); } catch (_e) { /* quota */ }
      return map;
    }
  } catch (e) { console.error('loadInstructorDirectory', e); }
  return null;
}
// Fire the directory load once per session; re-render the Plan when photos arrive.
function ensureInstructorDir() {
  if (State.instructorDir || State._instrDirLoading || State._instrDirFailed) return;
  State._instrDirLoading = true;
  loadInstructorDirectory().then(dir => { if (!dir) State._instrDirFailed = true; })
    .finally(() => { State._instrDirLoading = false; renderPlan(); });
}

// ---- Plan screen: Program ⇄ Instructor toggle ----
function renderPlan() {
  const tab = State.planTab || 'program';
  const segP = document.getElementById('planSegProgram');
  const segI = document.getElementById('planSegInstructor');
  if (segP) segP.classList.toggle('active', tab === 'program');
  if (segI) segI.classList.toggle('active', tab === 'instructor');
  const cP = document.getElementById('programsContent');
  const cI = document.getElementById('instructorContent');
  if (cP) cP.classList.toggle('hide', tab !== 'program');
  if (cI) cI.classList.toggle('hide', tab !== 'instructor');
  if (tab === 'program') renderPrograms(); else renderInstructor();
}
function switchPlanTab(name) {
  State.planTab = name;
  renderPlan();
  // lazy-load the live schedule the first time the Instructor tab is opened
  if (name === 'instructor' && State.instructorSchedule == null) fetchInstructorSchedule();
}

// ---- Programs tab: filterable list of hero cards ----
function renderPrograms() {
  const sub = document.getElementById('programsSub');
  const content = document.getElementById('programsContent');
  if (!content) return;
  ensureInstructorDir();  // load instructor photos for program heroes
  const all = State.programs;
  if (!all.length) {
    if (sub) sub.textContent = 'Ordered class plans';
    content.innerHTML = `<div class="card" style="text-align:center;padding:28px 16px;color:var(--ink-3);">
      <div style="font-size:14px;margin-bottom:4px;">No programs yet</div>
      <div class="tiny" style="color:var(--ink-4);">Curated, ordered class plans will appear here.</div>
    </div>`;
    return;
  }
  const stats = all.map(programStats);
  const inProg = stats.filter(s => s.status === 'inprogress').length;
  const comp = stats.filter(s => s.status === 'completed').length;
  if (sub) sub.textContent = `${all.length} ${all.length === 1 ? 'program' : 'programs'}${inProg ? ` · ${inProg} in progress` : ''}`;

  const f = State.programFilter;
  const chip = (id, label, count) => `<button class="prog-chip ${f === id ? 'active' : ''}" onclick="setProgramFilter('${id}')">${label}${count != null ? ` <span class="prog-chip-n">${count}</span>` : ''}</button>`;
  let html = `<div class="prog-filter">${chip('all', 'All', null)}${chip('inprogress', 'In progress', inProg)}${chip('completed', 'Completed', comp)}</div>`;

  const shown = all.map((p, i) => ({ p, s: stats[i] })).filter(x =>
    f === 'all' || (f === 'inprogress' && x.s.status === 'inprogress') || (f === 'completed' && x.s.status === 'completed'));
  if (!shown.length) {
    html += `<div class="tiny" style="text-align:center;padding:28px;color:var(--ink-4);">Nothing in this filter yet.</div>`;
  } else {
    html += shown.map(({ p, s }) => programCardHtml(p, s)).join('');
  }
  content.innerHTML = html;
}
function programCardHtml(p, s) {
  const ins = programInstructors(p);
  const pill = s.status === 'completed' ? 'Completed' : (s.status === 'inprogress' ? 'In progress' : '');
  const btn = s.status === 'completed'
    ? `<button class="pd-class-btn" onclick="event.stopPropagation();openProgram('${p.id}')">Review program</button>`
    : `<button class="pd-class-btn" onclick="event.stopPropagation();startNextClass('${p.id}')">Start next class</button>`;
  // Official art carries its own title text — render the image at its natural
  // size and move the title into the card body (Peloton does the same).
  const hero = p.image_url
    ? `<div class="prog-hero art">
        ${pill ? `<span class="prog-pill">${pill}</span>` : ''}
        <img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.title)}">
      </div>`
    : `<div class="prog-hero" style="${programHeroStyle(p)}">
        ${pill ? `<span class="prog-pill">${pill}</span>` : ''}
        <div class="prog-hero-title">${escapeHtml(p.title)}</div>
      </div>`;
  return `<div class="prog-card" onclick="openProgram('${p.id}')">
    ${hero}
    <div class="prog-card-body">
      ${p.image_url ? `<div class="prog-title">${escapeHtml(p.title)}</div>` : ''}
      <div class="prog-instr">${escapeHtml(ins.primary)}${ins.extra ? ` <span style="color:var(--ink-4);">· +${ins.extra} more</span>` : ''}</div>
      <div class="prog-count">${s.doneCount} of ${s.total} classes</div>
      <div class="prog-bar"><i style="width:${s.pct}%;"></i></div>
      ${btn}
    </div>
  </div>`;
}
function setProgramFilter(f) { State.programFilter = f; renderPrograms(); }
function startNextClass(programId) {
  const p = State.programs.find(x => x.id === programId);
  if (!p) return;
  const c = programNextClass(p);
  if (c) openClassInfo(programId, c.ride_id); else openProgram(programId);
}

// ---- Program detail: full-page Overview + per-week class lists ----
function openProgram(programId) {
  const p = State.programs.find(x => x.id === programId);
  if (!p) return;
  State.currentProgramId = programId;
  State.programTab = 'overview';
  renderProgramDetail();
  switchScreen('program-detail');
}
function renderProgramDetail() {
  const host = document.getElementById('programDetailContent');
  const p = State.programs.find(x => x.id === State.currentProgramId);
  if (!host || !p) return;
  const s = programStats(p);
  const done = State.programProgress[p.id] || new Set();
  const weekComplete = (w) => {
    const cs = programWeekClasses(p, w);
    return cs.length && cs.every(c => done.has(c.slot));
  };
  let tabs = `<button class="pd-tab ${State.programTab === 'overview' ? 'active' : ''}" onclick="switchProgramTab('overview')">Overview</button>`;
  for (let w = 0; w < s.weeks; w++) {
    tabs += `<button class="pd-tab ${State.programTab === w ? 'active' : ''}" onclick="switchProgramTab(${w})">Week ${w + 1}${weekComplete(w) ? ' ✓' : ''}</button>`;
  }
  const panel = State.programTab === 'overview' ? programOverviewPanel(p, s) : programWeekPanel(p, State.programTab);
  const nc = programNextClass(p);
  const startBar = nc
    ? `<div class="pd-startbar"><button class="pd-start-btn" onclick="openClassInfo('${p.id}','${nc.ride_id}')">▶ Start next class</button></div>`
    : `<div class="pd-startbar"><button class="pd-start-btn done" disabled>✓ Program complete</button></div>`;
  const heroHtml = p.image_url
    ? `<div class="pd-hero art">
        <button class="pd-back" onclick="switchScreen('programs')" aria-label="Back">‹</button>
        <img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.title)}">
      </div>`
    : `<div class="pd-hero" style="${programHeroStyle(p)}">
        <button class="pd-back" onclick="switchScreen('programs')" aria-label="Back">‹</button>
        <div class="pd-hero-title">${escapeHtml(p.title)}</div>
      </div>`;
  host.innerHTML = `
    ${heroHtml}
    <div class="pd-tabs">${tabs}</div>
    <div class="pd-panel" id="pdPanel">${panel}</div>
    ${startBar}`;
}
function switchProgramTab(tab) {
  State.programTab = tab;
  const p = State.programs.find(x => x.id === State.currentProgramId);
  if (!p) return;
  const s = programStats(p);
  document.querySelectorAll('#screen-program-detail .pd-tab').forEach((el, idx) => {
    const key = idx === 0 ? 'overview' : (idx - 1);
    el.classList.toggle('active', key === tab);
  });
  const panel = document.getElementById('pdPanel');
  if (panel) panel.innerHTML = tab === 'overview' ? programOverviewPanel(p, s) : programWeekPanel(p, tab);
  window.scrollTo(0, 0);
}
function programOverviewPanel(p, s) {
  const ins = programInstructors(p);
  const durStr = s.minDur ? (s.minDur === s.maxDur ? `${s.minDur}` : `${s.minDur}-${s.maxDur}`) : '—';
  const perWeek = s.perWeekMin === s.perWeekMax ? `${s.perWeekMax}x` : `${s.perWeekMin}-${s.perWeekMax}x`;
  return `
    <div class="pd-count-card">
      <div class="pd-count"><b>${s.doneCount}</b><span>/${s.total} classes</span></div>
      <div class="prog-bar"><i style="width:${s.pct}%;"></i></div>
    </div>
    <div class="pd-stat-row">
      <div class="pd-stat"><b>${s.total}</b><span>classes</span></div>
      <div class="pd-stat"><b>${s.weeks}</b><span>weeks</span></div>
      <div class="pd-stat"><b>${perWeek}</b><span>per week</span></div>
      <div class="pd-stat"><b>${durStr}</b><span>minutes</span></div>
    </div>
    <div class="pd-about">
      <div class="pd-about-instr">${escapeHtml(ins.primary)}${ins.extra ? ` <span style="color:var(--ink-4);">· +${ins.extra} more</span>` : ''}</div>
      ${p.subtitle ? `<p>${escapeHtml(p.subtitle)}</p>` : ''}
    </div>`;
}
function programWeekPanel(p, w) {
  const done = State.programProgress[p.id] || new Set();
  const nc = programNextClass(p);
  const grad = programGrad(p);
  const cs = programWeekClasses(p, w);
  if (!cs.length) return `<div class="tiny" style="padding:24px;text-align:center;color:var(--ink-4);">No classes in this week.</div>`;

  const classCard = (c) => {
    const isDone = done.has(c.slot);
    const isNext = nc && c.slot === nc.slot;
    const badge = isDone ? `<span class="prog-pill done">✓ Completed</span>` : (isNext ? `<span class="prog-pill">Next Class</span>` : '');
    const meta = `
      <div class="pd-class-title">${escapeHtml(c.title)}</div>
      <div class="pd-class-instr">${escapeHtml(c.instructor || '')}${c.duration_min ? ` · ${c.duration_min} min` : ''}</div>
      <button class="pd-class-btn" onclick="event.stopPropagation();openClassInfo('${p.id}','${c.ride_id}')">${isDone ? 'View' : 'Start'}</button>`;
    // With a ride still: 16:9 image header (badge on the image), text below.
    return c.image
      ? `<div class="pd-class has-img ${isDone ? 'is-done' : ''}" onclick="openClassInfo('${p.id}','${c.ride_id}')">
          <div class="pd-class-img" style="background-image:url('${escapeHtml(c.image)}')">${badge}</div>
          <div class="pd-class-body">${meta}</div>
        </div>`
      : `<div class="pd-class ${isDone ? 'is-done' : ''}" style="background:${grad};" onclick="openClassInfo('${p.id}','${c.ride_id}')">
          ${badge}${meta}
        </div>`;
  };

  // Group into days: real day numbers when the manifest has them (multi-class
  // days — e.g. Benchmark + Stretch — share one label), else one class per day.
  const groups = [];
  cs.forEach((c, idx) => {
    const day = c.day || idx + 1;
    if (groups.length && groups[groups.length - 1].day === day) groups[groups.length - 1].classes.push(c);
    else groups.push({ day, classes: [c] });
  });
  return groups.map(g => `<div class="pd-day">
    <div class="pd-day-label">Day ${g.day}</div>
    ${g.classes.map(classCard).join('')}
  </div>`).join('');
}
function openClassInfo(programId, rideId) {
  const p = State.programs.find(x => x.id === programId);
  if (!p) return;
  const c = p.classes.find(x => x.ride_id === rideId);
  if (!c) return;
  // Info page is per-ride, not per-slot: "completed" means the member has done
  // this ride at least once (any slot of it ticked).
  const prog = State.programProgress[p.id] || new Set();
  const isDone = p.classes.some(x => x.ride_id === rideId && prog.has(x.slot));

  // Join to the member's actual completed workout(s) for this class — most recent
  // take wins. (State.workouts is a rolling ~90-day window, so very old completions
  // still tick the checkmark via programProgress but may not carry live metrics.)
  const wk = State.workouts
    .filter(w => w.peloton_ride_id === rideId && w.status === 'done')
    .sort((a, b) => String(b.done_at || b.planned_for || '').localeCompare(String(a.done_at || a.planned_for || '')))[0] || null;

  const tiles = [];
  if (wk) {
    if (wk.effort_points != null) tiles.push(['Strive', (+wk.effort_points).toFixed(1), '']);
    if (wk.total_output_kj != null) tiles.push(['Output', Math.round(+wk.total_output_kj).toString(), 'kJ']);
    else if (wk.avg_output_w != null) tiles.push(['Avg output', Math.round(+wk.avg_output_w).toString(), 'W']);
    if (wk.calories != null) tiles.push(['Calories', Math.round(+wk.calories).toLocaleString(), 'kcal']);
    if (wk.avg_hr != null) tiles.push(['Avg HR', Math.round(+wk.avg_hr).toString(), 'bpm']);
    if (wk.distance_km != null) tiles.push(['Distance', (+wk.distance_km).toFixed(2), 'km']);
  }
  const metricsHtml = tiles.length ? `<div class="ci-metrics">${tiles.map(([lab, val, unit]) =>
    `<div class="ci-metric"><b>${val}${unit ? `<span>${unit}</span>` : ''}</b><i>${lab}</i></div>`).join('')}</div>` : '';
  // Strive is HR-based — call it out when the class was done but no strap was worn.
  const striveNote = (wk && wk.effort_points == null)
    ? `<div class="tiny" style="color:var(--ink-4);margin-bottom:16px;">Strive Score needs a heart-rate monitor — none was recorded for this class.</div>` : '';

  const doneOn = wk && (wk.done_at || wk.planned_for) ? ` · ${shortDate(wk.done_at || wk.planned_for)}` : '';
  const statusText = isDone
    ? `Completed${doneOn}${tiles.length ? ' — your stats from this class.' : ' — synced from your Peloton history.'}`
    : 'Not yet completed. Pick a day to add it to your plan, or take it in the Peloton app and it’ll tick off here after your next sync.';

  const today = todayISO();
  const addBlock = isDone ? '' : `
    <div class="card" style="margin-bottom:12px;">
      <div class="tiny" style="color:var(--ink-3);margin-bottom:8px;">Add this class to your plan</div>
      <div style="display:flex;gap:8px;">
        <input type="date" id="ciPlanDate" class="input" value="${today}" min="${today}" style="flex:1;">
        <button class="btn accent" onclick="addProgramClassToPlan('${p.id}','${c.ride_id}')">Add to plan</button>
      </div>
    </div>`;

  const html = `
    <div style="margin-bottom:14px;">
      <div class="tiny" style="color:var(--ink-4);text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">${escapeHtml(p.title)} · Class ${c.order}</div>
      <div style="font-size:20px;font-weight:700;line-height:1.2;">${escapeHtml(c.title)}</div>
      <div class="tiny" style="color:var(--ink-3);margin-top:6px;">${escapeHtml(c.instructor || 'Various')}${c.duration_min ? ` · ${c.duration_min} min` : ''}</div>
    </div>
    <div class="card" style="display:flex;align-items:center;gap:10px;margin-bottom:${(metricsHtml || addBlock) ? '14px' : '16px'};">
      <span style="width:26px;height:26px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:${isDone ? 'var(--accent)' : 'var(--paper-3)'};color:${isDone ? 'var(--accent-ink)' : 'var(--ink-4)'};">${isDone ? '✓' : '•'}</span>
      <div class="tiny" style="color:var(--ink-3);">${statusText}</div>
    </div>
    ${metricsHtml}
    ${striveNote}
    ${addBlock}
    <button class="btn ${isDone ? 'primary' : 'ghost'} block" onclick="closeSheet();switchScreen('exercise');">Go to Training${isDone ? '' : ' to sync'}</button>`;
  openSheet('Class details', html);
}

async function addProgramClassToPlan(programId, rideId) {
  const p = State.programs.find(x => x.id === programId);
  if (!p) return;
  const c = p.classes.find(x => x.ride_id === rideId);
  if (!c) return;
  const m = activeMember();
  if (!m) return;
  const dateEl = document.getElementById('ciPlanDate');
  const date = dateEl && dateEl.value ? dateEl.value : todayISO();
  const dupe = State.workouts.some(w => w.status === 'planned' && w.peloton_ride_id === c.ride_id && w.planned_for === date);
  if (dupe) { toast('Already planned for that day'); return; }
  const row = {
    household_id: State.householdId, member_id: m.id,
    planned_for: date,
    session_type: detectWorkoutType(c.title) || 'ride',
    duration_min: c.duration_min || null,
    status: 'planned', source: 'program',
    peloton_ride_id: c.ride_id || null, class_title: c.title || null, instructor: c.instructor || null,
  };
  const { data, error } = await State.client.from('workouts').insert([row]).select();
  if (error) { console.error('addProgramClassToPlan', error); toast('Couldn’t add to plan'); return; }
  if (data) data.forEach(w => State.workouts.push(w));
  toast('Added to your plan');
  closeSheet();
  renderAll();
}

// ---- Plan → Instructor: favourite instructor's upcoming LIVE classes ----
async function fetchInstructorSchedule() {
  const m = activeMember();
  const favs = favouriteInstructors(m);
  if (!favs.length) { State.instructorSchedule = { classes: [] }; renderInstructor(); return; }
  State.instructorSchedule = 'loading';
  renderInstructor();
  loadInstructorDirectory();  // avatars, in parallel
  try {
    const cfg = getConfig();
    const { data: { session } } = await State.client.auth.getSession();
    const token = session?.access_token;
    if (!token) { State.instructorSchedule = 'error'; renderInstructor(); return; }
    const res = await fetch(`${cfg.url}/functions/v1/peloton-ingest`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, apikey: cfg.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schedule: true, instructors: favs }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) { console.error('instructor schedule', res.status, out); State.instructorSchedule = 'error'; }
    else State.instructorSchedule = { classes: out.classes || [], endpoint: out.endpoint, horizonDays: out.horizonDays };
  } catch (e) {
    console.error('fetchInstructorSchedule', e);
    State.instructorSchedule = 'error';
  }
  renderInstructor();
}

function instructorDayLabel(iso) {
  if (iso === todayISO()) return 'Today';
  if (iso === isoDateAddDays(todayISO(), 1)) return 'Tomorrow';
  return `${dayLabel(iso)} ${shortDate(iso)}`;
}

function instructorAvatarHtml(name) {
  const img = instructorImage(name);
  if (img) return `<div class="instr-avatar" style="background-image:url('${img}');"></div>`;
  const initials = name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  return `<div class="instr-avatar initials">${escapeHtml(initials || '?')}</div>`;
}
function instructorClassRowHtml(c) {
  const added = State.workouts.some(w => w.status === 'planned' && w.peloton_ride_id && w.peloton_ride_id === c.ride_id && w.planned_for === c.date);
  const meta = [sessionTypeLabel(c.discipline), c.duration_min ? `${c.duration_min} min` : ''].filter(Boolean).join(' · ');
  const btn = added
    ? `<button class="card-action" disabled style="opacity:0.6;">Added ✓</button>`
    : `<button class="card-action" onclick="addLiveClassToSchedule('${c.id}')">+ Schedule</button>`;
  return `<div class="card" style="display:flex;align-items:center;gap:12px;margin-bottom:8px;">
    <div style="flex:none;width:78px;">
      <div style="font-size:12px;color:var(--ink-3);font-weight:600;">${escapeHtml(instructorDayLabel(c.date))}</div>
      <div style="font-size:17px;font-weight:800;line-height:1.1;">${escapeHtml(c.time || '')}</div>
    </div>
    <div style="flex:1;min-width:0;">
      <div style="font-size:14px;font-weight:600;line-height:1.2;">${escapeHtml(c.title)}</div>
      <div class="tiny" style="color:var(--ink-4);margin-top:2px;">${escapeHtml(meta)}</div>
    </div>
    ${btn}
  </div>`;
}
function renderInstructor() {
  const host = document.getElementById('instructorContent');
  if (!host) return;
  ensureInstructorDir();
  const m = activeMember();
  const favs = favouriteInstructors(m);
  const sub = document.getElementById('programsSub');

  if (!favs.length) {
    if (sub) sub.textContent = 'Upcoming live classes';
    host.innerHTML = `<div class="card" style="text-align:center;padding:28px 16px;color:var(--ink-3);">
      <div style="font-size:14px;margin-bottom:4px;">No favourite instructors set</div>
      <div class="tiny" style="color:var(--ink-4);margin-bottom:12px;">Add instructors on the You page to see their upcoming live classes.</div>
      <button class="btn ghost block" onclick="switchScreen('profile')">Open You</button>
    </div>`;
    return;
  }
  if (sub) sub.textContent = `${favs.length} instructor${favs.length === 1 ? '' : 's'} · upcoming live`;

  const st = State.instructorSchedule;
  if (st === 'loading' || st == null) {
    host.innerHTML = `<div class="card"><div class="skel skel-row"></div><div class="skel skel-meta"></div></div>
      <div class="card"><div class="skel skel-row"></div><div class="skel skel-meta"></div></div>`;
    return;
  }
  if (st === 'error') {
    host.innerHTML = `<div class="card" style="text-align:center;padding:24px 16px;color:var(--ink-3);">
      <div style="font-size:14px;margin-bottom:4px;">Couldn’t load the live schedule</div>
      <div class="tiny" style="color:var(--ink-4);margin-bottom:12px;">Peloton’s schedule didn’t respond. Try again in a moment.</div>
      <button class="btn block" onclick="fetchInstructorSchedule()">Try again</button>
    </div>`;
    return;
  }

  const classes = st.classes || [];
  // One section per favourite instructor (in your saved order), classes chronological.
  let html = '';
  favs.forEach(fav => {
    const mine = classes.filter(c => foldName(c.instructor).includes(foldName(fav)) || foldName(fav).includes(foldName(c.instructor))).sort((a, b) => a.start_unix - b.start_unix);
    html += `<div class="instr-head">${instructorAvatarHtml(fav)}<div><div class="instr-name">${escapeHtml(fav)}</div><div class="tiny" style="color:var(--ink-4);">${mine.length ? `${mine.length} upcoming` : 'No upcoming live classes'}</div></div></div>`;
    html += mine.map(instructorClassRowHtml).join('');
  });
  html += `<div style="text-align:right;margin-top:6px;"><a href="#" onclick="event.preventDefault();fetchInstructorSchedule();" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-4);text-decoration:none;">Refresh</a></div>`;
  host.innerHTML = html;
}

async function addLiveClassToSchedule(id) {
  const st = State.instructorSchedule;
  if (!st || !st.classes) return;
  const c = st.classes.find(x => x.id === id);
  if (!c) return;
  const m = activeMember();
  if (!m) return;
  const dupe = State.workouts.some(w => w.status === 'planned' && w.peloton_ride_id && w.peloton_ride_id === c.ride_id && w.planned_for === c.date);
  if (dupe) { toast('Already in your schedule'); return; }
  const row = {
    household_id: State.householdId, member_id: m.id,
    planned_for: c.date, specific_time: c.time || null,
    session_type: c.discipline || 'ride', duration_min: c.duration_min || null,
    status: 'planned', source: 'peloton_live',
    peloton_ride_id: c.ride_id || null, class_title: c.title || null, instructor: c.instructor || null,
  };
  const { data, error } = await State.client.from('workouts').insert([row]).select();
  if (error) { console.error('addLiveClassToSchedule', error); toast('Couldn’t add to schedule'); return; }
  if (data) data.forEach(w => State.workouts.push(w));
  toast('Added to your schedule');
  renderInstructor();
}

// ============================================================
// MAGIC WEEK · EXERCISE (layered: Peloton → C25K → mix → top-up)
// ============================================================
function openMagicWeekExercise() {
  const m = activeMember();
  if (!m) return;
  const goal = m.goal_type || 'general';
  const mix = m.weekly_target_mix || { ride:0, run:0, strength:0, yoga:0, walk:0, stretch:0 };
  const onC25K = m.current_program === 'c25k';
  const dailyMin = parseInt(m.min_daily_minutes, 10) || 0;

  // No mix AND not on a program — nothing to do
  const totalMixTarget = Object.values(mix).reduce((a,b) => a + (parseInt(b,10)||0), 0);
  if (totalMixTarget === 0 && !onC25K) {
    const html = `
      <div class="tiny" style="margin-bottom:14px;color:var(--ink-3);">
        Set up your weekly mix in your profile first. Tell Household what a good week looks like for you (e.g. 2 rides, 1 strength, 1 walk) — or enrol in NHS Couch to 5K — and Plan my week will fill the empty days.
      </div>
      <button class="btn primary block" onclick="closeSheet();switchScreen('profile');">Open profile</button>
    `;
    openSheet('Plan week', html);
    return;
  }

  // The calendar week (Mon-Sun) and the days we can still plan into
  const calWeekStart = weekStartFor(new Date());
  const calWeekDays = Array.from({length:7}, (_,i) => isoDateAddDays(calWeekStart, i));
  const todayStr = todayISO();
  const todayIdx = calWeekDays.indexOf(todayStr);
  const candidateDays = todayIdx >= 0 ? calWeekDays.slice(todayIdx) : calWeekDays;

  const weekendDays = new Set();
  calWeekDays.forEach(d => {
    const [yy,mm,dd] = d.split('-').map(Number);
    const dow = new Date(yy, mm-1, dd).getDay();
    if (dow === 0 || dow === 6) weekendDays.add(d);
  });

  // Existing workouts this week (by day, multiple per day possible)
  const byDay = {}; // date -> array of workouts
  State.workouts
    .filter(w => w.member_id === m.id && calWeekDays.includes(w.planned_for) && w.status !== 'cancelled')
    .forEach(w => {
      if (!byDay[w.planned_for]) byDay[w.planned_for] = [];
      byDay[w.planned_for].push(w);
    });

  // ============================================================
  // STAGE 1: Peloton — already in the database, just observe
  // We won't propose anything here; these stay where they are.
  // ============================================================
  // Count existing by type for mix accounting
  const have = { ride:0, run:0, strength:0, yoga:0, walk:0, stretch:0 };
  Object.values(byDay).flat().forEach(w => {
    if (have[w.session_type] != null) have[w.session_type]++;
  });

  // ============================================================
  // STAGE 2: C25K runs — propose 3 run sessions across the week
  // ============================================================
  const c25kProposed = []; // { date, type, duration_min, label }
  if (onC25K) {
    const runsAlreadyPlanned = Object.values(byDay).flat()
      .filter(w => w.session_type === 'run').length;
    const runsNeeded = Math.max(0, 3 - runsAlreadyPlanned);
    if (runsNeeded > 0) {
      // Pick `runsNeeded` days from candidateDays, spaced as far apart as possible.
      // Avoid days that already have any session (to keep runs as standalone primary sessions).
      // Then if not enough such days, allow days with existing sessions too.
      const daysNoSession = candidateDays.filter(d => !byDay[d] || byDay[d].length === 0);
      const daysWithSession = candidateDays.filter(d => byDay[d] && byDay[d].length > 0);
      const preferred = daysNoSession.concat(daysWithSession);

      // Pick spaced days
      const picked = pickSpacedDays(preferred, runsNeeded);
      picked.forEach(d => {
        c25kProposed.push({
          date: d,
          type: 'run',
          duration_min: 30, // NHS sessions are ~30 min total incl. warmup/cooldown
          label: 'NHS C25K run',
          source: 'c25k',
        });
      });
    }
  }

  // After C25K stage, virtually add these to byDay for further planning
  const projectedByDay = JSON.parse(JSON.stringify(byDay));
  c25kProposed.forEach(p => {
    if (!projectedByDay[p.date]) projectedByDay[p.date] = [];
    projectedByDay[p.date].push({ session_type: p.type, duration_min: p.duration_min, _virtual:true });
    if (have[p.type] != null) have[p.type]++;
  });

  // ============================================================
  // STAGE 3: Weekly mix fill — remaining empty days
  // ============================================================
  // First: determine designated rest days based on member preference
  const restDaysPerWeek = Math.max(0, Math.min(7, parseInt(m.rest_days_per_week, 10) || 0));

  // Days that already have a workout (real or C25K-projected)
  const filledDays = new Set(Object.keys(projectedByDay).filter(d => (projectedByDay[d] || []).length > 0));

  // Empty days available for planning into
  const emptyDays = candidateDays.filter(d => !filledDays.has(d));

  // Pick rest days: prefer empty mid-week days (not Sat/Sun, not Mon), spaced apart.
  // Rest days come ONLY from empty days — we don't relocate Peloton/C25K sessions.
  let restDays = new Set();
  if (restDaysPerWeek > 0) {
    const restCandidates = emptyDays.filter(d => !weekendDays.has(d) && d !== calWeekDays[0]);
    // Fall back to any empty day if mid-week aren't enough
    const candidatesPool = restCandidates.length >= restDaysPerWeek ? restCandidates : emptyDays;
    const pickedRest = pickSpacedDays(candidatesPool, restDaysPerWeek);
    pickedRest.forEach(d => restDays.add(d));
  }

  // usableDays for mix fill = empty days minus rest days
  const usableDaysBase = emptyDays.filter(d => !restDays.has(d));

  const mixProposed = [];
  if (totalMixTarget > 0) {
    const deficit = {};
    ['ride','run','strength','yoga','walk','stretch'].forEach(t => {
      deficit[t] = Math.max(0, (parseInt(mix[t],10)||0) - have[t]);
    });

    const priorityOrder = goalPriority(goal);
    const queue = [];
    priorityOrder.forEach(t => {
      for (let i = 0; i < deficit[t]; i++) queue.push(t);
    });

    let usableDays = usableDaysBase.slice();

    // Weekend-prefer heavy types
    const heavyTypes = new Set(['run','ride']);
    const heavyFirst = queue.filter(t => heavyTypes.has(t));
    const lightFirst = queue.filter(t => !heavyTypes.has(t));
    const weekendUsable = usableDays.filter(d => weekendDays.has(d));
    const weekdayUsable = usableDays.filter(d => !weekendDays.has(d));

    const slotMap = {};
    let hq = heavyFirst.slice();
    let lq = lightFirst.slice();
    weekendUsable.forEach(d => { if (hq.length) slotMap[d] = hq.shift(); });
    weekdayUsable.forEach(d => {
      if (hq.length) slotMap[d] = hq.shift();
      else if (lq.length) slotMap[d] = lq.shift();
    });
    weekendUsable.forEach(d => {
      if (!slotMap[d] && lq.length) slotMap[d] = lq.shift();
    });

    // No strength back-to-back
    const sorted = Object.keys(slotMap).sort();
    for (let i = 1; i < sorted.length; i++) {
      if (slotMap[sorted[i]] === 'strength' && slotMap[sorted[i-1]] === 'strength') {
        const swapWith = sorted.find(d =>
          d !== sorted[i] && d !== sorted[i-1] &&
          slotMap[d] !== 'strength' &&
          Math.abs(sorted.indexOf(d) - i) > 1
        );
        if (swapWith) {
          const tmp = slotMap[sorted[i]];
          slotMap[sorted[i]] = slotMap[swapWith];
          slotMap[swapWith] = tmp;
        }
      }
    }

    Object.keys(slotMap).sort().forEach(d => {
      mixProposed.push({
        date: d,
        type: slotMap[d],
        duration_min: pickDurationForMember(m, slotMap[d]),
        label: sessionTypeLabel(slotMap[d]),
        source: 'mix',
      });
    });
  }

  // Project mix into byDay for top-up stage
  mixProposed.forEach(p => {
    if (!projectedByDay[p.date]) projectedByDay[p.date] = [];
    projectedByDay[p.date].push({ session_type: p.type, duration_min: p.duration_min, _virtual:true });
  });

  // ============================================================
  // STAGE 4: Top up active days to the daily minimum
  // HARD RULE: never top up a designated rest day
  // ============================================================
  const topUpProposed = [];
  if (dailyMin > 0) {
    const priorityForFill = goalPriority(goal).filter(t => t !== 'run' && t !== 'rest');
    // For each day that has SOMETHING but is below the minimum:
    candidateDays.forEach(d => {
      if (restDays.has(d)) return; // hard rule: don't top up rest days
      const sessions = projectedByDay[d] || [];
      if (sessions.length === 0) return; // rest day — leave it
      const total = sessions.reduce((s, w) => s + (w.duration_min || 0), 0);
      if (total >= dailyMin) return;
      const gap = dailyMin - total;
      // Pick a complementary type — prefer one we don't already have today
      const todayTypes = new Set(sessions.map(s => s.session_type));
      const candidateType = priorityForFill.find(t => !todayTypes.has(t)) || 'strength';
      // Round gap to nearest 5 min, minimum 10
      const dur = Math.max(10, Math.round(gap / 5) * 5);
      topUpProposed.push({
        date: d,
        type: candidateType,
        duration_min: dur,
        label: `${sessionTypeLabel(candidateType)} (top-up)`,
        source: 'topup',
      });
    });
  }

  // ============================================================
  // Compile final proposal (C25K + mix + top-up)
  // ============================================================
  const allProposed = c25kProposed.concat(mixProposed).concat(topUpProposed)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (allProposed.length === 0) {
    openSheet('Plan week', `<div class="empty"><div class="empty-title">Nothing to add</div><div class="empty-sub">Your week already matches your plan.</div></div><button class="btn block" onclick="closeSheet()" style="margin-top:14px;">Close</button>`);
    return;
  }

  // ============================================================
  // Preview UI
  // ============================================================
  const dayLabels = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const haveBits = Object.entries(have).filter(([_,v]) => v > 0)
    .map(([t,v]) => `${v} ${sessionTypeLabel(t).toLowerCase()}`).join(', ') || 'nothing yet';
  const mixBits = Object.entries(mix).filter(([_,v]) => parseInt(v,10) > 0)
    .map(([t,v]) => `${v} ${sessionTypeLabel(t).toLowerCase()}`).join(', ') || '—';

  let body = `
    <div class="tiny" style="margin-bottom:14px;line-height:1.6;">
      <div><span style="color:var(--ink-4);">Goal:</span> ${escapeHtml(goalLabel(goal))}</div>
      <div><span style="color:var(--ink-4);">Target mix:</span> ${escapeHtml(mixBits)}</div>
      ${onC25K ? `<div><span style="color:var(--ink-4);">Program:</span> NHS C25K · week ${m.current_program_week||1}</div>` : ''}
      ${restDaysPerWeek > 0 ? `<div><span style="color:var(--ink-4);">Rest days:</span> ${restDaysPerWeek}</div>` : ''}
      ${dailyMin > 0 ? `<div><span style="color:var(--ink-4);">Min daily:</span> ${dailyMin} min</div>` : ''}
      <div><span style="color:var(--ink-4);">Already this week:</span> ${escapeHtml(haveBits)}</div>
    </div>
  `;

  body += `<div class="card-eyebrow"><span class="eyebrow">Proposed</span></div>`;

  // Group by date for cleaner display
  const byDate = {};
  allProposed.forEach(p => {
    if (!byDate[p.date]) byDate[p.date] = [];
    byDate[p.date].push(p);
  });
  Object.keys(byDate).sort().forEach(d => {
    const [yy,mm,dd] = d.split('-').map(Number);
    const dow = new Date(yy, mm-1, dd).getDay();
    const items = byDate[d];
    body += `<div class="day-card" style="margin-bottom:6px;">
      <div class="day-name">${dayLabels[dow]} <span class="date">${shortDate(d)}</span></div>
      ${items.map(p => `<div class="card-meta" style="margin-top:4px;">${escapeHtml(p.label)} · ${p.duration_min} min ${p.source === 'c25k' ? '<span style="color:var(--accent-deep);font-size:11px;">· C25K</span>' : p.source === 'topup' ? '<span style="color:var(--ink-4);font-size:11px;">· top-up</span>' : ''}</div>`).join('')}
    </div>`;
  });

  body += `<div class="btn-row" style="margin-top:14px;">
    <button class="btn block" onclick="openMagicWeekExercise()">Try again</button>
    <button class="btn primary block" onclick='commitMagicWeekExercise(${JSON.stringify(allProposed).replace(/'/g,"&#39;")})'>Use this</button>
  </div>`;

  openSheet('Plan week', body);
}

// Pick N days from a list, spaced as far apart as possible
function pickSpacedDays(days, n) {
  if (n <= 0 || days.length === 0) return [];
  if (n >= days.length) return days.slice();
  // Distribute evenly: if 7 days and need 3, pick indexes 0, 3, 6
  const result = [];
  const step = (days.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) {
    const idx = Math.round(i * step);
    if (!result.includes(days[idx])) result.push(days[idx]);
  }
  // If duplicates collapsed, fill from remaining
  for (let i = 0; i < days.length && result.length < n; i++) {
    if (!result.includes(days[i])) result.push(days[i]);
  }
  return result.sort();
}

function pickDurationForMember(m, type) {
  const prefs = m.session_duration_prefs || {};
  const defaultPrefs = {
    ride:     { min: 20, max: 45 },
    run:      { min: 20, max: 45 },
    strength: { min: 15, max: 30 },
    yoga:     { min: 20, max: 45 },
    walk:     { min: 20, max: 60 },
    stretch:  { min: 5,  max: 15 },
  };
  const p = prefs[type] || defaultPrefs[type] || { min: 20, max: 30 };
  const lo = Math.max(5, parseInt(p.min, 10) || 5);
  const hi = Math.max(lo, parseInt(p.max, 10) || lo);
  const raw = lo + Math.floor(Math.random() * (hi - lo + 1));
  return Math.round(raw / 5) * 5;
}

function goalPriority(goal) {
  // Higher-priority types first
  switch (goal) {
    case 'lose_weight': return ['ride','run','walk','strength','yoga','stretch'];
    case 'event':       return ['run','ride','strength','walk','yoga','stretch'];
    case 'strength':    return ['strength','ride','walk','yoga','run','stretch'];
    case 'maintain':    return ['walk','yoga','stretch','ride','strength','run'];
    default:            return ['ride','strength','yoga','walk','run','stretch'];
  }
}

function goalLabel(g) {
  return { lose_weight:'Lose weight', event:'Train for an event', general:'General fitness', strength:'Build strength', maintain:'Maintain' }[g] || 'General fitness';
}

async function commitMagicWeekExercise(proposed) {
  closeSheet();
  setSync('syncing', 'Saving');
  const m = activeMember();
  const onC25K = m.current_program === 'c25k';
  // For C25K runners: estimate run duration based on week (NHS sessions are ~30 min)
  const c25kRunDuration = 30;

  const inserts = proposed.map(p => {
    let duration = p.duration_min;
    if (onC25K && p.type === 'run') {
      duration = c25kRunDuration;
    }
    return {
      household_id: State.householdId,
      member_id: m.id,
      planned_for: p.date,
      session_type: p.type,
      duration_min: duration,
      status: 'planned',
    };
  });
  const { data, error } = await State.client.from('workouts').insert(inserts).select();
  if (error) {
    toast('Save failed');
    setSync('offline', 'Error');
    return;
  }
  if (data) data.forEach(w => State.workouts.push(w));
  setSync('synced', 'Saved');
  toast(`Added ${data.length} session${data.length===1?'':'s'}`);
  renderAll();
}

// ============================================================
function dayLabel(iso) {
  const d = new Date(iso + 'T00:00:00');
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
}
function shortDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function formatDateLong() {
  const d = new Date();
  const day = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][d.getDay()];
  const m = ['January','February','March','April','May','June','July','August','September','October','November','December'][d.getMonth()];
  return `${day} · ${m} ${d.getDate()}`;
}
function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Late night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 22) return 'Good evening';
  return 'Late night';
}
function escapeHtml(s) {
  if (s == null) return '';
  const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
}
function activeMember() {
  return State.members.find(m => m.id === State.activeMemberId) || State.members[0];
}
function partnerMember() {
  return State.members.find(m => m.id !== State.activeMemberId) || State.members[1];
}
function applyMemberTheme() {
  const m = activeMember();
  if (m) document.body.dataset.member = m.slot;
}
function toast(text, kind) {
  // kind: 'success' | 'error' | 'info' (default)
  // Auto-infer if not specified
  if (!kind) {
    const lower = String(text || '').toLowerCase();
    if (/fail|error|denied|invalid|wrong|not found/.test(lower)) kind = 'error';
    else if (/saved|added|cleared|done|logged|complete|moving|copied|synced|success|removed/.test(lower)) kind = 'success';
    else kind = 'info';
  }
  const t = document.getElementById('toast');
  t.innerHTML = `<span class="toast-dot toast-dot-${kind}"></span>${escapeHtml(text)}`;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
}
function daysUntil(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.ceil((d - now) / (1000 * 60 * 60 * 24));
}

// ============================================================
// SCREEN SWITCHING
// ============================================================
function switchScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const screen = document.getElementById('screen-' + name);
  if (screen) screen.classList.add('active');
  const tab = document.querySelector(`.tab[data-screen="${name}"]`); // null for screens not in the bar (e.g. profile)
  if (tab) tab.classList.add('active');
  window.scrollTo(0, 0);
}

function switchMealTab(name) {
  State.mealsTab = name;
  document.querySelectorAll('[data-meal-tab]').forEach(b => b.classList.toggle('active', b.dataset.mealTab === name));
  ['mealsVault','mealsWeek','mealsShopping'].forEach(id => document.getElementById(id).classList.add('hide'));
  if (name === 'vault') { document.getElementById('mealsVault').classList.remove('hide'); renderVault(); }
  if (name === 'week') { document.getElementById('mealsWeek').classList.remove('hide'); renderWeek(); }
  if (name === 'shopping') { document.getElementById('mealsShopping').classList.remove('hide'); renderShopping(); }
}

// ============================================================
// SHEET
// ============================================================
function openSheet(title, html) {
  document.getElementById('sheetTitle').innerHTML = title;
  document.getElementById('sheetBody').innerHTML = html;
  document.getElementById('sheetOverlay').classList.add('open');
  document.getElementById('sheet').classList.add('open');
}
function closeSheet() {
  document.getElementById('sheetOverlay').classList.remove('open');
  document.getElementById('sheet').classList.remove('open');
  setTimeout(() => { document.getElementById('sheetBody').innerHTML = ''; }, 360);
}

// ============================================================
// RENDER · TODAY (dashboard)
// ============================================================
function renderAll() {
  renderPartnerAmbient();
  // top-right account circle initial
  const _m = activeMember();
  const _ab = document.getElementById('avatarBtn');
  if (_ab && _m) _ab.textContent = ((_m.display_name || '?')[0] || '?').toUpperCase();
  renderToday();
  renderExercise();
  renderProgress();
  renderPlan();
  renderMeals();
  renderProfile();
  // Post-render: animate any [data-num-id] spans whose value changed
  animateChangedNumbers();
}

const _numCache = {};
function animateChangedNumbers() {
  document.querySelectorAll('[data-num-id]').forEach(el => {
    const id = el.dataset.numId;
    const target = parseInt(el.textContent, 10);
    if (isNaN(target)) return;
    const prev = _numCache[id];
    _numCache[id] = target;
    if (prev === target) return;
    // first appearance counts up from 0; later changes tween from the old value
    animateNumber(el, prev === undefined ? 0 : prev, target, prev === undefined ? 700 : 480);
  });
}
function animateNumber(el, from, to, durationMs) {
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    // ease-out cubic
    const eased = 1 - Math.pow(1 - t, 3);
    const val = Math.round(from + (to - from) * eased);
    el.textContent = String(val);
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function renderPartnerAmbient() {
  const wrap = document.getElementById('partnerAmbient');
  if (!wrap) return;
  const partner = partnerMember();
  if (!partner) { wrap.innerHTML = ''; return; }
  const today = todayISO();
  const didWorkout = State.workouts.some(w => w.member_id === partner.id && w.planned_for === today && w.status === 'done');
  wrap.innerHTML = `<span class="pa-dot ${didWorkout ? 'ok' : ''}"></span>
    <span><span class="pa-name">${escapeHtml(partner.display_name)}</span> ${didWorkout ? 'moved today' : 'hasn\'t moved yet'}</span>`;
}

// Motivational headline for the dashboard greeting (single-user, time + state aware)
function todayHeadline(didMoveToday) {
  if (didMoveToday) return 'Nice work';
  const h = new Date().getHours();
  if (h < 5) return 'Rest up';
  if (h < 12) return "Let's move";
  if (h < 17) return 'Time to train';
  if (h < 22) return 'Finish strong';
  return 'Wind down';
}

// Consecutive-day workout streak ending today (today not-yet-done doesn't break it).
function computeStreak(memberId) {
  const doneDays = new Set(
    State.workouts.filter(w => w.member_id === memberId && w.status === 'done').map(w => w.planned_for)
  );
  let streak = 0;
  let cursor = todayISO();
  if (!doneDays.has(cursor)) cursor = isoDateAddDays(cursor, -1); // grace for today
  while (doneDays.has(cursor)) { streak++; cursor = isoDateAddDays(cursor, -1); }
  return streak;
}

// One-tap "move to tomorrow" for a planned session you couldn't get to.
async function rescheduleWorkout(id, days = 1) {
  const w = State.workouts.find(x => x.id === id);
  if (!w || w.status !== 'planned') return;
  const newDate = isoDateAddDays(w.planned_for, days);
  setSync('syncing', 'Saving');
  const { data, error } = await State.client.from('workouts').update({ planned_for: newDate }).eq('id', id).select().single();
  if (error) { toast('Reschedule failed'); setSync('offline', 'Error'); return; }
  const idx = State.workouts.findIndex(x => x.id === id);
  if (idx >= 0) State.workouts[idx] = data;
  setSync('synced', 'Saved');
  toast('Moved to tomorrow →');
  renderAll();
}

// One-tap "mark done" from the dashboard, without opening the sheet.
async function markWorkoutDoneQuick(id) {
  const w = State.workouts.find(x => x.id === id);
  if (!w) return;
  setSync('syncing', 'Saving');
  const payload = { status: 'done', done_at: new Date().toISOString() };
  const { data, error } = await State.client.from('workouts').update(payload).eq('id', id).select().single();
  if (error) { toast('Save failed'); setSync('offline', 'Error'); return; }
  const idx = State.workouts.findIndex(x => x.id === id);
  if (idx >= 0) State.workouts[idx] = data;
  setSync('synced', 'Saved');
  toast('Logged 💪');
  renderAll();
}

function todPeriod() {
  const h = new Date().getHours();
  if (h < 8) return 'dawn';
  if (h < 17) return 'day';
  if (h < 20) return 'dusk';
  return 'night';
}

function renderToday() {
  const m = activeMember();
  if (!m) return;

  const today = todayISO();
  const todayWorkouts = State.workouts
    .filter(w => w.member_id === m.id && w.planned_for === today && w.status !== 'cancelled')
    .sort((a, b) => {
      if (a.specific_time && b.specific_time) return a.specific_time.localeCompare(b.specific_time);
      if (a.specific_time) return -1;
      if (b.specific_time) return 1;
      return 0;
    });
  const didMoveToday = todayWorkouts.some(w => w.status === 'done');

  // Greeting hero — motivational headline + how much you've lost
  const firstName = escapeHtml((m.display_name || '').split(' ')[0]);
  const dateEl = document.getElementById('todayDate');
  if (dateEl) dateEl.textContent = formatDateLong();
  document.getElementById('todayGreet').innerHTML = `${todayHeadline(didMoveToday)}, <em>${firstName}</em>`;

  const myW = State.weights.filter(w => w.member_id === m.id);
  const latestV = myW[0] ? parseFloat(myW[0].weight_kg) : null;
  const startW = m.weight_start_kg ? parseFloat(m.weight_start_kg) : (myW.length ? parseFloat(myW[myW.length - 1].weight_kg) : null);
  const goalV = m.weight_goal_kg ? parseFloat(m.weight_goal_kg) : null;
  let subHtml;
  if (startW != null && latestV != null && (startW - latestV) > 0.05) {
    const toGo = (goalV != null && latestV > goalV) ? ` <span class="pip"></span> ${(latestV - goalV).toFixed(1)} kg to go` : '';
    subHtml = `<span style="color:var(--accent);font-weight:700;">▼ ${(startW - latestV).toFixed(1)} kg</span> down so far${toGo}`;
  } else if (goalV != null && latestV != null && latestV > goalV) {
    subHtml = `${(latestV - goalV).toFixed(1)} kg to your goal — let's go`;
  } else if (m.life_goal_title) {
    subHtml = escapeHtml(m.life_goal_title);
  } else {
    subHtml = `Log a weigh-in to start tracking your loss`;
  }
  document.getElementById('todaySub').innerHTML = subHtml;

  // weight
  const myWeights = State.weights.filter(w => w.member_id === m.id);
  const latest = myWeights[0];
  const latestVal = latest ? parseFloat(latest.weight_kg) : null;
  const goalVal = m.weight_goal_kg ? parseFloat(m.weight_goal_kg) : null;

  // consistency
  const streak = computeStreak(m.id);
  const calWeekStart = weekStartFor(new Date());
  const calWeekDays = Array.from({ length: 7 }, (_, i) => isoDateAddDays(calWeekStart, i));
  const weekDone = State.workouts.filter(w => w.member_id === m.id && calWeekDays.includes(w.planned_for) && w.status === 'done').length;
  const weekTarget = parseInt(m.weekly_session_target, 10) || 4;

  let html = '';

  // ---- Weight hero ----
  if (latestVal != null || m.weight_start_kg || goalVal) {
    const momentum = computeWeightMomentum(myWeights);
    const toGo = (goalVal != null && latestVal != null) ? (latestVal - goalVal) : null;
    html += `<div class="card-hero tappable" onclick="openWeightEntry()">
      <div class="card-row" style="align-items:flex-start;">
        <div>
          <div class="eyebrow" style="margin-bottom:6px;">Weight</div>
          <div class="stat-hero">${latestVal != null ? latestVal.toFixed(1) : '—'}<span class="u">kg</span></div>
        </div>
        <div class="spark-delta ${momentum.cls}" style="padding-top:18px;">${momentum.label}</div>
      </div>
      ${myWeights.length >= 2 ? renderSparkline(myWeights.slice(0, 30).reverse()) : ''}
      ${goalVal != null ? `<div class="goal-row"><span>Goal ${goalVal.toFixed(1)} kg</span>${toGo != null && toGo > 0 ? `<span><b>${toGo.toFixed(1)} kg</b> to go</span>` : (toGo != null ? `<span><b>Goal reached</b></span>` : '')}</div>` : ''}
    </div>`;
  } else {
    html += `<div class="card-hero tappable" onclick="openWeightEntry()">
      <div class="eyebrow" style="margin-bottom:6px;">Weight</div>
      <div class="wc-title">Tap to log your first weigh-in</div>
      <div class="wc-sub">Set a goal weight in your profile</div>
    </div>`;
  }

  // ---- Consistency tiles ----
  const bars = Array.from({ length: weekTarget }, (_, i) => `<span class="${i < weekDone ? 'on' : ''}"></span>`).join('');
  html += `<div class="stat-grid">
    <div class="stat-tile" style="cursor:pointer;" onclick="switchScreen('exercise')">
      <div class="stat-num"><span class="accent" data-num-id="streak">${streak}</span>${streak > 0 ? ' <span style="font-size:20px;">🔥</span>' : ''}</div>
      <div class="stat-label">day streak</div>
    </div>
    <div class="stat-tile" style="cursor:pointer;" onclick="switchScreen('exercise')">
      <div class="stat-num"><span data-num-id="weekdone">${weekDone}</span><span class="frac">/${weekTarget}</span></div>
      <div class="stat-label">workouts this week</div>
      <div class="week-bars">${bars}</div>
    </div>
  </div>`;

  // ---- Today's workout CTA ----
  if (todayWorkouts.length === 0) {
    html += `<div class="card-hero workout-cta tappable" onclick="openTodayWorkout()">
      <div class="card-row" style="margin-bottom:6px;"><span class="eyebrow">Today</span></div>
      <div class="wc-title">Nothing planned yet</div>
      <div class="wc-sub">Tap to add a session — or plan your week in Train</div>
    </div>`;
  } else if (todayWorkouts.length === 1) {
    const w = todayWorkouts[0];
    const disp = formatWorkoutDisplay(w);
    const done = w.status === 'done';
    const isPeloton = !!w.peloton_url;
    html += `<div class="card-hero workout-cta">
      <div class="card-row" style="margin-bottom:10px;">
        <span class="eyebrow">Today</span>
        ${done ? '<span class="badge done">Done</span>' : (isPeloton ? '<span class="badge">Peloton</span>' : '')}
      </div>
      <div style="display:flex;gap:12px;align-items:center;" onclick="openTodayWorkout()">
        ${sessionIconTile(w.session_type)}
        <div style="min-width:0;cursor:pointer;">
          <div class="wc-title">${escapeHtml(disp.primary)}</div>
          ${disp.secondary ? `<div class="wc-sub">${escapeHtml(disp.secondary)}</div>` : ''}
        </div>
      </div>
      <div class="btn-row">
        ${done
          ? `<button class="btn ghost block" onclick="openTodayWorkout()">View</button>`
          : `<button class="btn accent block" onclick="event.stopPropagation();markWorkoutDoneQuick('${w.id}')">Mark done</button>`}
        ${isPeloton && !done ? `<button class="btn" style="flex:0 0 auto;" onclick="openPelotonUrl('${escapeHtml(w.peloton_url)}')">Open</button>` : ''}
        ${!done ? `<button class="btn" style="flex:0 0 auto;" onclick="event.stopPropagation();rescheduleWorkout('${w.id}')" title="Move to tomorrow">Tomorrow →</button>` : ''}
      </div>
    </div>`;
  } else {
    // multiple sessions today — list them all, each with its own "Done"
    const allDone = todayWorkouts.every(x => x.status === 'done');
    const totalMin = todayWorkouts.reduce((s, x) => s + (x.duration_min || 0), 0);
    html += `<div class="card-hero workout-cta">
      <div class="card-row" style="margin-bottom:8px;">
        <span class="eyebrow">Today · ${todayWorkouts.length} sessions${totalMin ? ` · ${totalMin} min` : ''}</span>
        ${allDone ? '<span class="badge done">All done</span>' : ''}
      </div>
      ${todayWorkouts.map((w, i) => {
        const disp = formatWorkoutDisplay(w);
        const done = w.status === 'done';
        return `<div style="display:flex;align-items:center;gap:11px;padding:9px 0;${i > 0 ? 'border-top:0.5px solid var(--line);' : ''}">
          ${sessionIconTile(w.session_type, 38)}
          <div style="flex:1;min-width:0;cursor:pointer;${done ? 'opacity:0.6;' : ''}" onclick="openWorkoutById('${w.id}','${w.planned_for}')">
            <div style="font-weight:600;color:var(--ink);font-size:14px;">${escapeHtml(disp.primary)}</div>
            ${disp.secondary ? `<div class="tiny" style="color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(disp.secondary)}</div>` : ''}
          </div>
          ${done
            ? '<span class="badge done" style="flex-shrink:0;">Done</span>'
            : `<button class="btn ghost" style="flex-shrink:0;padding:7px 10px;font-size:13px;" onclick="event.stopPropagation();rescheduleWorkout('${w.id}')" title="Move to tomorrow">→</button><button class="btn accent" style="flex-shrink:0;padding:7px 13px;font-size:12px;" onclick="event.stopPropagation();markWorkoutDoneQuick('${w.id}')">Done</button>`}
        </div>`;
      }).join('')}
    </div>`;
  }

  // ---- Today's meals — breakfast / lunch / dinner (dinner is the hero) ----
  {
    const dayslots = State.weekPlan?.slots?.[today] || {};
    const rows = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner']].map(([key, label]) => {
      const mealObj = normMealSlot(dayslots[key]);
      const filled = mealObj && (mealObj.name || mealObj.url || mealObj.source);
      const right = (mealObj && mealObj.url)
        ? `<span class="meal-slot-link" onclick="event.stopPropagation();openMealUrl('${encodeURIComponent(mealObj.url)}')">↗</span>`
        : `<span class="meal-slot-add">${filled ? '' : '+'}</span>`;
      const val = filled
        ? `${mealObj.name ? escapeHtml(mealObj.name) : '<span style="color:var(--ink-4);">(no name)</span>'}${mealObj.source ? `<span class="src">${escapeHtml(mealObj.source)}</span>` : ''}`
        : 'Tap to add';
      return `<div class="meal-slot ${key}" onclick="openTodayMeal('${key}')">
        <span class="meal-slot-label">${label}</span>
        <span class="meal-slot-val ${filled ? '' : 'empty'}">${val}</span>
        ${right}
      </div>`;
    }).join('');
    html += `<div class="card" style="padding:14px 16px;">
      <div class="card-row" style="margin-bottom:6px;"><span class="eyebrow">Today's meals</span></div>
      ${rows}
    </div>`;
  }

  document.getElementById('todayContent').innerHTML = html;
}

// Open a meal editor for today, ensuring the meals tab is on the current week first.
async function openTodayMeal(slot) {
  if (State.mealWeekStart !== State.weekStart) await loadMealWeek(State.weekStart);
  openMealEditor(todayISO(), slot);
}

// Momentum framing for the weight card on the dashboard.
// Returns { label, cls } where cls is 'down' for negative deltas (which we render
// as the "moving in the right direction" colour) or '' otherwise.
function computeWeightMomentum(weights) {
  if (!weights || weights.length === 0) return { label: 'Tap to log', cls: '' };
  if (weights.length === 1) return { label: 'First log', cls: '' };
  // weights are sorted newest-first
  const latest = weights[0];
  const oldest = weights[weights.length - 1];
  const latestDate = new Date(latest.measured_on || latest.created_at || latest.logged_at);
  const oldestDate = new Date(oldest.measured_on || oldest.created_at || oldest.logged_at);
  if (isNaN(latestDate) || isNaN(oldestDate)) return { label: 'Logged', cls: '' };
  const days = Math.max(1, Math.round((latestDate - oldestDate) / 86400000));
  const delta = parseFloat(latest.weight_kg) - parseFloat(oldest.weight_kg);
  const absDelta = Math.abs(delta).toFixed(1);
  // Phrase the duration sensibly
  let dur;
  if (days < 10) dur = `${days} day${days===1?'':'s'}`;
  else if (days < 56) {
    const w = Math.round(days / 7);
    dur = `${w} week${w===1?'':'s'}`;
  } else {
    const mo = Math.round(days / 30);
    dur = `${mo} month${mo===1?'':'s'}`;
  }
  if (Math.abs(delta) < 0.05) return { label: `Steady · ${dur}`, cls: '' };
  const sign = delta < 0 ? '−' : '+';
  // 'down' class is the existing "good direction" colour. We use it when losing weight.
  return { label: `${sign}${absDelta} kg in ${dur}`, cls: delta < 0 ? 'down' : '' };
}

function renderSparkline(weights) {
  if (weights.length < 2) return '';
  const vals = weights.map(w => parseFloat(w.weight_kg));
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const w = 320, h = 50, p = 4;
  const xStep = (w - p*2) / (vals.length - 1);
  const points = vals.map((v, i) => {
    const x = p + i * xStep;
    const y = h - p - ((v - min) / range) * (h - p*2);
    return [x, y];
  });
  const pathD = points.map((pt, i) => (i === 0 ? 'M' : 'L') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const areaD = pathD + ` L ${(w-p).toFixed(1)} ${h-p} L ${p} ${h-p} Z`;
  return `<svg class="spark-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path class="area" d="${areaD}" style="fill:var(--accent);fill-opacity:0.18;stroke:none"/>
    <path d="${pathD}" style="fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>
  </svg>`;
}

// Larger weight chart for the Weight screen, with an optional goal line.
// ============================================================
// TRAINING METRICS — derived from workouts (rides) + strength_sets.
// All pure functions; unit-testable with jsc.
// ============================================================

// Estimated one-rep max (Epley). Reps beyond ~12 grow unreliable but still map.
function estimate1RM(weightKg, reps) {
  const w = parseFloat(weightKg) || 0;
  const r = parseInt(reps, 10) || 0;
  if (w <= 0 || r <= 0) return 0;
  return r === 1 ? w : w * (1 + r / 30);
}

// Rides done by this member, oldest→newest by date.
function memberRides(m) {
  return State.workouts
    .filter(w => w.member_id === m.id && w.status === 'done' && normType(w.session_type) === 'ride')
    .slice().sort((a, b) => (a.planned_for || '').localeCompare(b.planned_for || ''));
}

// FTP change-points over time, collapsing runs of equal ftp: [{date, ftp}]
function ftpSeries(rides) {
  const out = [];
  for (const r of rides) {
    const f = r.ftp != null ? Math.round(+r.ftp) : null;
    if (f == null || f <= 0) continue;
    if (!out.length || out[out.length - 1].ftp !== f) out.push({ date: r.planned_for, ftp: f });
  }
  return out;
}

// avg_output_w for the last n rides that have it, oldest→newest: [{date, w}]
function outputSeries(rides, n) {
  return rides.filter(r => r.avg_output_w != null).slice(-(n || 8))
    .map(r => ({ date: r.planned_for, w: Math.round(+r.avg_output_w) }));
}

// Mean avg_output_w over rides in [sinceISO, untilISO], or null.
function avgOutputBetween(rides, sinceISO, untilISO) {
  const win = rides.filter(r => r.avg_output_w != null && r.planned_for >= sinceISO && r.planned_for <= untilISO);
  if (!win.length) return null;
  return Math.round(win.reduce((s, r) => s + (+r.avg_output_w), 0) / win.length);
}

// Ride PRs: best max output / cadence / longest / leaderboard percentile.
function ridePRs(rides) {
  const prs = [];
  let bo = null, bc = null, bl = null, blb = null;
  for (const r of rides) {
    if (r.max_output_w != null && (!bo || +r.max_output_w > +bo.max_output_w)) bo = r;
    if (r.max_cadence != null && (!bc || +r.max_cadence > +bc.max_cadence)) bc = r;
    if (r.duration_min != null && (!bl || +r.duration_min > +bl.duration_min)) bl = r;
    if (r.leaderboard_rank != null && +r.leaderboard_total > 0) {
      const pct = +r.leaderboard_rank / +r.leaderboard_total;
      if (!blb || pct < blb.pct) blb = { r, pct };
    }
  }
  if (bo) prs.push({ icon: 'bolt', val: Math.round(+bo.max_output_w) + 'W', label: 'max output', date: bo.planned_for });
  if (bc) prs.push({ icon: 'rotate', val: Math.round(+bc.max_cadence) + 'rpm', label: 'max cadence', date: bc.planned_for });
  if (bl) prs.push({ icon: 'clock', val: (+bl.duration_min) + 'min', label: 'longest ride', date: bl.planned_for });
  if (blb) prs.push({ icon: 'trophy', val: 'Top ' + Math.max(1, Math.round(blb.pct * 100)) + '%', label: 'best leaderboard', date: blb.r.planned_for });
  return prs;
}

// Strength sets for member, oldest→newest.
function memberSets(m) {
  return State.strengthSets
    .filter(s => s.member_id === m.id)
    .slice().sort((a, b) => (a.performed_at || '').localeCompare(b.performed_at || ''));
}

// Exercise names ranked by set count (most-logged first).
function exercisesByFrequency(sets) {
  const c = {};
  sets.forEach(s => { c[s.exercise] = (c[s.exercise] || 0) + 1; });
  return Object.keys(c).sort((a, b) => c[b] - c[a]);
}

// Best estimated 1RM per day for one exercise, oldest→newest: [{date, e1rm}]
function oneRmSeries(sets, exercise) {
  const byDate = {};
  sets.filter(s => s.exercise === exercise).forEach(s => {
    const e = estimate1RM(s.weight_kg, s.reps);
    if (!byDate[s.performed_at] || e > byDate[s.performed_at]) byDate[s.performed_at] = e;
  });
  return Object.keys(byDate).sort().map(d => ({ date: d, e1rm: byDate[d] }));
}

// Weekly volume (Σ reps×weight), keyed by ISO week-start, last n weeks: [{week, vol}]
function weeklyVolume(sets, n) {
  const byWeek = {};
  sets.forEach(s => {
    const ws = weekStartFor(new Date(s.performed_at + 'T00:00:00'));
    byWeek[ws] = (byWeek[ws] || 0) + (parseInt(s.reps, 10) || 0) * (parseFloat(s.weight_kg) || 0);
  });
  return Object.keys(byWeek).sort().slice(-(n || 8)).map(w => ({ week: w, vol: Math.round(byWeek[w]) }));
}

// Strength PRs: best weight (with its reps) per exercise; top few by frequency.
function strengthPRs(sets, limit) {
  return exercisesByFrequency(sets).slice(0, limit || 4).map(ex => {
    let best = null;
    sets.filter(s => s.exercise === ex).forEach(s => {
      const wv = parseFloat(s.weight_kg) || 0;
      if (!best || wv > best.w) best = { w: wv, reps: parseInt(s.reps, 10) || 0, date: s.performed_at };
    });
    return best ? { exercise: ex, ...best } : null;
  }).filter(Boolean);
}

// Aggregate HR-zone durations (sec) across done workouts since date.
// hr_zones = [{slug, duration}] (may arrive as a JSON string). Returns [{z,sec,pct}] or null.
function aggregateHrZones(m, sinceISO) {
  const buckets = [0, 0, 0, 0, 0];
  State.workouts.forEach(w => {
    if (w.member_id !== m.id || w.status !== 'done' || (w.planned_for || '') < sinceISO) return;
    let z = w.hr_zones;
    if (!z) return;
    if (typeof z === 'string') { try { z = JSON.parse(z); } catch (e) { return; } }
    if (!Array.isArray(z)) return;
    z.forEach(zone => {
      const mm = String(zone.slug || '').match(/(\d)/);
      if (mm) buckets[Math.min(4, Math.max(0, +mm[1] - 1))] += (+zone.duration || 0);
    });
  });
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  return buckets.map((sec, i) => ({ z: i + 1, sec, pct: Math.round((sec / total) * 100) }));
}

// ---- tiny chart helpers (generic; oldest→newest values) ----
function metricSparkline(vals, tint, height) {
  if (!vals || vals.length < 2) return '<div class="tiny" style="padding:14px 0;color:var(--ink-4);">Not enough data yet.</div>';
  const h = height || 70, w = 320, p = 6;
  const min = Math.min(...vals), max = Math.max(...vals), range = (max - min) || 1;
  const step = (w - p * 2) / (vals.length - 1);
  const pts = vals.map((v, i) => [p + i * step, h - p - ((v - min) / range) * (h - p * 2)]);
  const d = pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ' ' + pt[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  return `<svg class="spark-svg" style="height:${h}px;" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" style="fill:none;stroke:${tint};stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>
    <circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="4" style="fill:${tint}"/>
  </svg>`;
}
function metricBars(vals, tint, height) {
  if (!vals || !vals.length) return '<div class="tiny" style="padding:14px 0;color:var(--ink-4);">Not enough data yet.</div>';
  const h = height || 64, w = 320, gap = 8;
  const max = Math.max(...vals) || 1;
  const bw = (w - gap * (vals.length - 1)) / vals.length;
  const bars = vals.map((v, i) => {
    const bh = Math.max(3, (v / max) * (h - 6));
    const op = (0.35 + 0.65 * (i / Math.max(1, vals.length - 1))).toFixed(2);
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="3" style="fill:${tint};fill-opacity:${op}"/>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block;">${bars}</svg>`;
}
function zoneBarHtml(zones) {
  const colors = ['#3a4252', '#3a6ea5', 'var(--accent)', '#e0a83d', '#e0553d'];
  const txt = ['var(--ink-3)', '#dbeafe', '#042417', '#3a2607', '#3a0f07'];
  const segs = zones.filter(z => z.pct > 0).map(z => `<div style="flex:${z.pct};background:${colors[z.z-1]};display:flex;align-items:center;justify-content:center;min-width:0;"><span style="font-size:9px;color:${txt[z.z-1]};font-weight:${z.z >= 3 ? 700 : 500};">${z.pct}%</span></div>`).join('');
  return `<div style="display:flex;height:22px;border-radius:6px;overflow:hidden;gap:1px;">${segs}</div>`;
}
// Small line icons for PR tiles (app doesn't load an icon webfont).
function prIco(name) {
  const p = {
    bolt: '<path d="M13 3L4 14h7l-1 7 9-11h-7z"/>',
    rotate: '<path d="M4 12a8 8 0 1 1 2.3 5.6"/><path d="M4 20v-4h4"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
    trophy: '<path d="M7 4h10v4a5 5 0 0 1-10 0zM5 6H3v1a3 3 0 0 0 3 3M19 6h2v1a3 3 0 0 1-3 3M9 15h6M12 15v3M9 21h6"/>',
  };
  return `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="var(--accent)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${p[name] || p.bolt}</svg>`;
}

// ============================================================
// TRAINING SECTION (ride / strength toggle) — lives on the merged Progress screen
// ============================================================
function switchTrainingTab(name) {
  State.trainingTab = name;
  renderProgress();
}
function cycleOneRmLift() {
  const m = activeMember(); if (!m) return;
  const order = exercisesByFrequency(memberSets(m));
  if (order.length < 2) return;
  const i = order.indexOf(State.oneRmLift || order[0]);
  State.oneRmLift = order[(i + 1) % order.length];
  renderProgress();
}

function trainingSectionHtml(m) {
  const tab = State.trainingTab || 'ride';
  const seg = `<div class="seg" role="tablist">
    <button class="seg-btn ${tab === 'ride' ? 'active' : ''}" onclick="switchTrainingTab('ride')">Ride</button>
    <button class="seg-btn ${tab === 'strength' ? 'active' : ''}" onclick="switchTrainingTab('strength')">Strength</button>
  </div>`;
  const cards = tab === 'ride' ? rideTrainingHtml(m) : strengthTrainingHtml(m);

  // Shared: 30-day time-in-zone (any session with a HR monitor) + discipline stat row.
  const since = isoDateAddDays(todayISO(), -30);
  const zones = aggregateHrZones(m, since);
  let shared = '';
  if (zones) {
    shared += `<div class="card">
      <div class="card-row" style="margin-bottom:8px;"><span class="eyebrow">Time in zone</span><span class="tiny" style="color:var(--ink-3);">last 30 days</span></div>
      ${zoneBarHtml(zones)}
      <div class="tiny" style="color:var(--ink-4);margin-top:5px;">z1 easy → z5 max · sessions with a HR monitor</div>
    </div>`;
  }
  shared += sessionStatsHtml(m, tab);

  return `<div class="section-head"><span class="t">Training</span></div>${seg}${cards}${shared}`;
}

function rideTrainingHtml(m) {
  const rides = memberRides(m);
  if (!rides.length) return `<div class="card"><div class="tiny" style="color:var(--ink-3);">No rides synced yet. Tap “Sync Peloton” on the Train tab to pull your metrics.</div></div>`;
  let h = '';

  const ftp = ftpSeries(rides);
  if (ftp.length >= 2) {
    const first = ftp[0], last = ftp[ftp.length - 1], delta = last.ftp - first.ftp;
    h += `<div class="card">
      <div class="card-row" style="margin-bottom:2px;"><span class="eyebrow">FTP progression</span><span class="tiny" style="font-weight:600;color:${delta >= 0 ? 'var(--accent)' : 'var(--ink-3)'};">${delta >= 0 ? '+' : ''}${delta}W</span></div>
      ${metricSparkline(ftp.map(p => p.ftp), 'var(--accent)', 70)}
      <div class="metric-legend"><span>${first.ftp}W · ${formatHistoryDate(first.date)}</span><span>${last.ftp}W · now</span></div>
    </div>`;
  } else if (ftp.length === 1) {
    h += `<div class="card"><div class="card-row"><span class="eyebrow">Current FTP</span><span style="font-family:'Archivo Expanded',sans-serif;font-weight:800;font-size:18px;color:var(--ink);">${ftp[0].ftp}W</span></div></div>`;
  }

  const outSeries = outputSeries(rides, 8);
  if (outSeries.length >= 2) {
    const today = todayISO();
    const cur = avgOutputBetween(rides, isoDateAddDays(today, -28), today);
    const prior = avgOutputBetween(rides, isoDateAddDays(today, -56), isoDateAddDays(today, -29));
    const delta = (cur != null && prior != null) ? cur - prior : null;
    h += `<div class="card">
      <div class="card-row" style="margin-bottom:8px;"><span class="eyebrow">Output trend</span><span class="tiny" style="color:var(--ink-3);">last ${outSeries.length} rides</span></div>
      ${metricSparkline(outSeries.map(p => p.w), 'var(--accent)', 68)}
      <div class="card-row" style="margin-top:6px;"><span><b style="font-family:'Archivo Expanded',sans-serif;font-size:19px;color:var(--ink);">${cur != null ? cur : '—'}W</b> <span class="tiny" style="color:var(--ink-3);">avg, last 4wk</span></span>${delta != null ? `<span class="tiny" style="font-weight:700;color:${delta >= 0 ? 'var(--accent)' : 'var(--ink-3)'};">${delta >= 0 ? '+' : ''}${delta}W vs prior</span>` : ''}</div>
    </div>`;
  }

  const prs = ridePRs(rides);
  if (prs.length) {
    h += `<div class="card"><div class="eyebrow" style="margin-bottom:10px;">Personal records</div><div class="pr-grid">${prs.map(p => `
      <div class="pr-item">${prIco(p.icon)}<div style="min-width:0;"><div class="pr-val">${p.val}</div><div class="pr-label">${p.label} · ${formatHistoryDate(p.date)}</div></div></div>`).join('')}</div></div>`;
  }
  return h;
}

function strengthTrainingHtml(m) {
  const sets = memberSets(m);
  if (!sets.length) return `<div class="card"><div class="tiny" style="color:var(--ink-3);">No lifts logged yet. Log sets on the Train tab to track your strength.</div></div>`;
  let h = '';

  const order = exercisesByFrequency(sets);
  if (!State.oneRmLift || !order.includes(State.oneRmLift)) State.oneRmLift = order[0];
  const lift = State.oneRmLift;
  const series = oneRmSeries(sets, lift);
  const liftChip = order.length > 1
    ? `<button class="lift-chip" onclick="cycleOneRmLift()">${escapeHtml(lift)} ›</button>`
    : `<span class="lift-chip static">${escapeHtml(lift)}</span>`;
  if (series.length >= 2) {
    const first = series[0], last = series[series.length - 1], delta = last.e1rm - first.e1rm;
    h += `<div class="card">
      <div class="card-row" style="margin-bottom:2px;"><span class="eyebrow">Estimated 1RM</span><span class="tiny" style="font-weight:600;color:${delta >= 0 ? 'var(--accent)' : 'var(--ink-3)'};">${delta >= 0 ? '+' : ''}${delta.toFixed(1)}kg</span></div>
      <div style="display:flex;align-items:center;gap:8px;margin:4px 0 2px;">
        <span style="font-family:'Archivo Expanded',sans-serif;font-size:26px;font-weight:800;color:var(--ink);line-height:1;">${last.e1rm.toFixed(0)}<span style="font-size:12px;color:var(--ink-3);font-weight:600;">kg</span></span>
        ${liftChip}
      </div>
      ${metricSparkline(series.map(p => p.e1rm), '#5cc6ff', 68)}
      <div class="metric-legend"><span>${first.e1rm.toFixed(0)}kg · ${formatHistoryDate(first.date)}</span><span>now</span></div>
    </div>`;
  } else {
    const last = series[series.length - 1];
    h += `<div class="card">
      <div class="card-row" style="margin-bottom:2px;"><span class="eyebrow">Estimated 1RM</span>${liftChip}</div>
      <div style="font-family:'Archivo Expanded',sans-serif;font-size:24px;font-weight:800;color:var(--ink);margin-top:4px;">${last ? last.e1rm.toFixed(0) : '—'}<span style="font-size:12px;color:var(--ink-3);font-weight:600;">kg</span></div>
      <div class="tiny" style="color:var(--ink-4);margin-top:2px;">Log this lift again to see the trend.</div>
    </div>`;
  }

  const vol = weeklyVolume(sets, 8);
  if (vol.length >= 2) {
    const cur = vol[vol.length - 1].vol, prior = vol[vol.length - 2].vol;
    const pct = prior > 0 ? Math.round(((cur - prior) / prior) * 100) : null;
    h += `<div class="card">
      <div class="card-row" style="margin-bottom:8px;"><span class="eyebrow">Weekly volume</span><span class="tiny" style="color:var(--ink-3);">last ${vol.length} weeks</span></div>
      ${metricBars(vol.map(v => v.vol), '#5cc6ff', 64)}
      <div class="card-row" style="margin-top:6px;"><span><b style="font-family:'Archivo Expanded',sans-serif;font-size:19px;color:var(--ink);">${cur.toLocaleString()}kg</b> <span class="tiny" style="color:var(--ink-3);">this week</span></span>${pct != null ? `<span class="tiny" style="font-weight:700;color:${pct >= 0 ? 'var(--accent)' : 'var(--ink-3)'};">${pct >= 0 ? '+' : ''}${pct}% vs prior</span>` : ''}</div>
    </div>`;
  }

  const prs = strengthPRs(sets, 4);
  if (prs.length) {
    h += `<div class="card"><div class="eyebrow" style="margin-bottom:10px;">Personal records</div><div class="pr-grid">${prs.map(p => `
      <div><div class="pr-val">${fmtKg(p.w)}<span style="font-size:10px;color:var(--ink-4);font-weight:600;"> ×${p.reps}</span></div><div class="pr-label">${escapeHtml(p.exercise)} · ${formatHistoryDate(p.date)}</div></div>`).join('')}</div></div>`;
  }
  return h;
}

// 30-day session stat row, adapted to the active discipline tab.
function sessionStatsHtml(m, tab) {
  const since = isoDateAddDays(todayISO(), -30);
  const col = { accent: 'var(--accent)', strength: '#5cc6ff', warn: '#ffb84d', ink: 'var(--ink)' };
  let items;
  if (tab === 'ride') {
    const rides = State.workouts.filter(w => w.member_id === m.id && w.status === 'done' && normType(w.session_type) === 'ride' && w.planned_for >= since);
    const mins = rides.reduce((s, w) => s + (w.duration_min || 0), 0);
    const kcal = rides.reduce((s, w) => s + (w.calories || 0), 0);
    const timeStr = mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}` : `${mins}`;
    items = [['accent', rides.length, 'rides'], ['ink', timeStr, mins >= 60 ? 'trained' : 'min trained']];
    if (kcal > 0) items.push(['warn', kcal.toLocaleString(), 'kcal']);
  } else {
    const sets = memberSets(m).filter(s => s.performed_at >= since);
    const days = new Set(sets.map(s => s.performed_at)).size;
    const vol = sets.reduce((s, x) => s + (parseInt(x.reps, 10) || 0) * (parseFloat(x.weight_kg) || 0), 0);
    items = [['strength', days, 'sessions'], ['ink', Math.round(vol).toLocaleString(), 'kg volume'], ['ink', sets.length, 'sets']];
  }
  if (!items.length) return '';
  return `<div class="card" style="display:flex;justify-content:space-around;text-align:center;padding:14px 12px;">${items.map(([c, v, l]) => `<div><div class="stat-num" style="font-size:22px;color:${col[c] || 'var(--ink)'};">${v}</div><div class="stat-label">${l}</div></div>`).join('')}</div>`;
}

// Full weigh-in history (sheet) — the "Show all" target on the merged screen.
function openWeightHistory() {
  const m = activeMember(); if (!m) return;
  const myWeights = State.weights.filter(w => w.member_id === m.id);
  const html = myWeights.map((wEntry, i) => {
    const v = parseFloat(wEntry.weight_kg);
    const prev = myWeights[i + 1] ? parseFloat(myWeights[i + 1].weight_kg) : null;
    let delta = '';
    if (prev != null) {
      const d = v - prev;
      delta = Math.abs(d) < 0.05 ? `<span class="tiny" style="color:var(--ink-4);">±0</span>` : `<span class="tiny" style="color:${d < 0 ? 'var(--accent)' : 'var(--ink-3)'};font-weight:600;">${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}</span>`;
    }
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:11px 2px;border-top:1px solid var(--line);cursor:pointer;" onclick="closeSheet();openWeightEntryFor('${wEntry.logged_at}')"><span class="tiny" style="color:var(--ink-3);">${formatHistoryDate(wEntry.logged_at)}</span><span style="display:flex;align-items:center;gap:10px;">${delta}<b style="font-family:'Archivo Expanded',sans-serif;font-size:15px;color:var(--ink);">${v.toFixed(1)}kg</b></span></div>`;
  }).join('');
  openSheet('Weigh-in history', html);
}

function formatHistoryDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === isoDateAddDays(today, -1)) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

// Open the weight entry sheet pre-filled for a specific past date
function openWeightEntryFor(dateISO) {
  openWeightEntry(dateISO);
}

// ============================================================
// RENDER · PROGRESS (trajectory to goal + training insights)
// ============================================================
// Project weight to goal using the recent (≤8 week) trend.
function computeProjection(weights, goal) {
  if (!weights || weights.length < 2 || goal == null) return null;
  const sorted = weights.slice().sort((a, b) => a.logged_at.localeCompare(b.logged_at)); // oldest→newest
  const newest = sorted[sorted.length - 1];
  const cutoff = isoDateAddDays(newest.logged_at, -56);
  const win = sorted.filter(w => w.logged_at >= cutoff);
  const a = win[0], b = win[win.length - 1];
  const days = Math.max(1, (new Date(b.logged_at + 'T00:00:00') - new Date(a.logged_at + 'T00:00:00')) / 86400000);
  const ratePerWeek = (parseFloat(b.weight_kg) - parseFloat(a.weight_kg)) / (days / 7); // <0 = losing
  const latest = parseFloat(b.weight_kg);
  const toGo = latest - goal;
  let weeksToGoal = null, goalDate = null, onTrack = false;
  if (toGo <= 0) onTrack = true;
  else if (ratePerWeek < -0.02) {
    weeksToGoal = toGo / Math.abs(ratePerWeek);
    goalDate = new Date(Date.now() + weeksToGoal * 7 * 86400000);
    onTrack = true;
  }
  return { ratePerWeek, latest, toGo, weeksToGoal, goalDate, onTrack };
}

function fmtGoalDate(d) {
  const opts = { day: 'numeric', month: 'short' };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleDateString('en-GB', opts);
}

// Actual weight line (solid) + projection (dashed) to the goal line.
function renderTrajectoryChart(weights, goal, proj) {
  const sorted = weights.slice().sort((a, b) => a.logged_at.localeCompare(b.logged_at));
  if (sorted.length < 2) return '<div class="tiny" style="padding:18px 0;color:var(--ink-4);">Log a couple of weigh-ins to see your trajectory.</div>';
  const w = 320, h = 140, px = 6, py = 10;
  const t0 = new Date(sorted[0].logged_at + 'T00:00:00').getTime();
  const tNow = new Date(sorted[sorted.length - 1].logged_at + 'T00:00:00').getTime();
  const tEnd = (proj && proj.goalDate) ? proj.goalDate.getTime() : tNow;
  const tMax = Math.max(tEnd, tNow + 86400000);
  const tx = t => px + ((t - t0) / (tMax - t0 || 1)) * (w - px * 2);
  const vals = sorted.map(s => parseFloat(s.weight_kg));
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (goal != null) lo = Math.min(lo, goal);
  const padv = (hi - lo) * 0.12 || 1; lo -= padv; hi += padv;
  const vy = v => h - py - ((v - lo) / (hi - lo || 1)) * (h - py * 2);
  const pts = sorted.map(s => [tx(new Date(s.logged_at + 'T00:00:00').getTime()), vy(parseFloat(s.weight_kg))]);
  const actualD = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const areaD = actualD + ` L ${pts[pts.length - 1][0].toFixed(1)} ${h - py} L ${pts[0][0].toFixed(1)} ${h - py} Z`;
  let projD = '';
  if (proj && proj.goalDate && goal != null) {
    const last = pts[pts.length - 1];
    projD = `M ${last[0].toFixed(1)} ${last[1].toFixed(1)} L ${tx(proj.goalDate.getTime()).toFixed(1)} ${vy(goal).toFixed(1)}`;
  }
  const goalY = goal != null ? vy(goal).toFixed(1) : null;
  return `<svg class="spark-svg" style="height:140px;" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${areaD}" style="fill:var(--accent);fill-opacity:0.16;stroke:none"/>
    ${goalY != null ? `<line x1="${px}" y1="${goalY}" x2="${w - px}" y2="${goalY}" style="stroke:var(--accent);stroke-width:1;stroke-dasharray:3 4;opacity:0.4"/>` : ''}
    ${projD ? `<path d="${projD}" style="fill:none;stroke:var(--accent);stroke-width:2;stroke-dasharray:2 5;opacity:0.85"/>` : ''}
    <path d="${actualD}" style="fill:none;stroke:var(--accent);stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round"/>
  </svg>`;
}

// Merged Progress screen: weight trajectory + goal + training (ride/strength) + weigh-in history.
function renderProgress() {
  const m = activeMember();
  const root = document.getElementById('progressContent');
  if (!root || !m) return;
  const myWeights = State.weights.filter(w => w.member_id === m.id); // newest-first
  const goal = m.weight_goal_kg ? parseFloat(m.weight_goal_kg) : null;
  const startVal = m.weight_start_kg ? parseFloat(m.weight_start_kg) : null;
  const latest = myWeights[0] ? parseFloat(myWeights[0].weight_kg) : null;
  const proj = computeProjection(myWeights, goal);

  let sub = 'Your journey';
  if (!myWeights.length) sub = 'Log a weigh-in to begin';
  else if (latest != null && goal != null && latest <= goal) sub = 'goal reached 🎉';
  else if (proj && proj.onTrack && proj.goalDate) sub = `on track · goal by ${fmtGoalDate(proj.goalDate)}`;
  else if (goal != null) sub = 'keep going · log to project';
  const subEl = document.getElementById('progressSub');
  if (subEl) subEl.textContent = sub;

  // Empty state — no weigh-ins yet (training still shows below if they have workouts)
  let html = '';
  if (!myWeights.length) {
    html += `<div class="card-hero">${emptyState(
      ico('<path d="M4 19h16M5 19l3-10h8l3 10M9 9V7a3 3 0 0 1 6 0v2"/>'),
      'Step on the scale',
      'Log your first weigh-in to start your trend — then your trajectory and training insights kick in.',
      `<button class="btn accent" onclick="openWeightEntry()">Log weight</button>`
    )}</div>`;
    html += trainingSectionHtml(m);
    root.innerHTML = html;
    return;
  }

  // Weight hero — trajectory (with projection when a goal exists)
  if (latest != null && goal != null) {
    const toGo = latest - goal;
    const rateStr = proj ? `${proj.ratePerWeek <= 0 ? '−' : '+'}${Math.abs(proj.ratePerWeek).toFixed(2)} kg/wk` : '';
    html += `<div class="card-hero">
      <div class="card-row" style="align-items:flex-start;">
        <div>
          <div class="eyebrow" style="margin-bottom:6px;">Now</div>
          <div class="stat-hero">${latest.toFixed(1)}<span class="u">kg</span></div>
        </div>
        <div style="text-align:right;padding-top:14px;">
          <div class="spark-delta ${proj && proj.ratePerWeek < 0 ? 'down' : ''}" style="font-weight:700;">${rateStr}</div>
          <div class="tiny" style="color:var(--ink-4);">${toGo > 0 ? toGo.toFixed(1) + ' kg to go' : 'goal reached'}</div>
        </div>
      </div>
      ${renderTrajectoryChart(myWeights, goal, proj)}
      <div class="goal-row"><span>${startVal != null ? startVal.toFixed(0) + ' start' : ''}</span><span>today</span><span>${goal.toFixed(0)} goal</span></div>
    </div>`;

    const lostStr = (startVal != null) ? (startVal - latest).toFixed(1) : null;
    html += `<div class="stat-grid">
      <div class="stat-tile"><div class="stat-num">${proj && proj.weeksToGoal != null ? '~' + Math.round(proj.weeksToGoal) + '<span class="frac"> wks</span>' : '—'}</div><div class="stat-label">to goal at this pace</div></div>
      ${lostStr != null ? `<div class="stat-tile"><div class="stat-num"><span class="accent">${lostStr}</span><span class="frac">kg</span></div><div class="stat-label">lost so far</div></div>` : ''}
    </div>`;
  } else {
    // Weigh-ins but no goal — still show the plain trend.
    html += `<div class="card-hero">
      <div class="card-row" style="align-items:flex-start;">
        <div><div class="eyebrow" style="margin-bottom:6px;">Now</div><div class="stat-hero">${latest != null ? latest.toFixed(1) : '—'}<span class="u">kg</span></div></div>
      </div>
      ${renderTrajectoryChart(myWeights, null, null)}
      <div class="wc-sub" style="margin-top:8px;">Set a start &amp; goal weight in You (top-right) to project your trajectory.</div>
    </div>`;
  }

  html += `<button class="btn accent block" style="margin:4px 0 18px;" onclick="openWeightEntry()">Log today's weight</button>`;

  // Training (ride / strength toggle) + shared zone + stat row
  html += trainingSectionHtml(m);

  // Weigh-in history — recent 6, with "Show all" sheet
  html += `<div class="section-head"><span class="t">Weigh-in history</span>${myWeights.length > 6 ? `<a href="#" onclick="event.preventDefault();openWeightHistory();" style="color:var(--accent);text-decoration:none;font-size:12px;">Show all</a>` : ''}</div>`;
  html += myWeights.slice(0, 6).map((wEntry, i) => {
    const v = parseFloat(wEntry.weight_kg);
    const prev = myWeights[i + 1] ? parseFloat(myWeights[i + 1].weight_kg) : null;
    let delta = '';
    if (prev != null) {
      const d = v - prev;
      if (Math.abs(d) < 0.05) delta = `<span class="tiny" style="color:var(--ink-4);">±0</span>`;
      else delta = `<span class="tiny" style="color:${d < 0 ? 'var(--accent)' : 'var(--ink-3)'};font-weight:600;">${d < 0 ? '−' : '+'}${Math.abs(d).toFixed(1)}</span>`;
    }
    return `<div class="card" style="display:flex;align-items:center;justify-content:space-between;padding:12px 16px;margin-bottom:6px;cursor:pointer;" onclick="openWeightEntryFor('${wEntry.logged_at}')">
      <span class="tiny" style="color:var(--ink-3);">${formatHistoryDate(wEntry.logged_at)}</span>
      <span style="display:flex;align-items:center;gap:10px;">${delta}<span style="font-family:'Archivo Expanded','Archivo',sans-serif;font-weight:700;font-size:16px;color:var(--ink);">${v.toFixed(1)}<span style="font-size:11px;color:var(--ink-3);font-weight:600;margin-left:2px;">kg</span></span></span>
    </div>`;
  }).join('');

  root.innerHTML = html;
}

function sessionTypeLabel(t) {
  return { ride:'Ride', strength:'Strength', yoga:'Yoga', stretch:'Stretch', walk:'Walk', run:'Run', other:'Workout', rest:'Rest day' }[normType(t)] || t;
}

// Per-session-type colour + line icon ("workout art")
function sessionTint(t) {
  return { ride:'#19e08a', run:'#b3a0ff', strength:'#5cc6ff', yoga:'#5de0c4', walk:'#ffd23d', stretch:'#ff9d6b', other:'#8a93a3', rest:'#8a93a3' }[normType(t)] || '#8a93a3';
}
function sessionIcon(t, size) {
  const s = size || 22;
  const paths = {
    ride: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l4-7h5l3 7M10 10l1.5-3H15"/>',
    run: '<circle cx="15" cy="5" r="2"/><path d="M5 20l3-5 3 1 1-4 3 3 3 1M9 11l3-3 3 2"/>',
    strength: '<path d="M4 9v6M7 7v10M17 7v10M20 9v6M7 12h10"/>',
    yoga: '<circle cx="12" cy="5" r="2"/><path d="M12 7v6M12 13l-5 6M12 13l5 6M7 11h10"/>',
    walk: '<circle cx="13" cy="5" r="2"/><path d="M11 8l-2 6 2 5M13 8l3 4-1 7M9 11l2.5-3"/>',
    stretch: '<circle cx="12" cy="5" r="2"/><path d="M12 7v5l-4 7M12 12l4 7M8 9h8"/>',
    other: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
    rest: '<path d="M14 4h6l-6 8h6M5 13h4l-4 6h4"/>',
  };
  return `<svg viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths[normType(t)] || paths.other}</svg>`;
}
// A coloured icon tile for a session type
function sessionIconTile(t, px) {
  const size = px || 46;
  const tint = sessionTint(t);
  return `<div style="width:${size}px;height:${size}px;border-radius:13px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:${tint}22;color:${tint};">${sessionIcon(t, Math.round(size * 0.52))}</div>`;
}

// Reusable styled empty state: emerald icon tile + title + sub + optional action.
function emptyState(iconSvg, title, sub, actionHtml) {
  return `<div style="text-align:center;padding:34px 20px;">
    <div style="width:54px;height:54px;border-radius:16px;background:var(--accent-soft);color:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 14px;">${iconSvg}</div>
    <div style="font-family:'Archivo','Archivo Expanded',sans-serif;font-weight:700;font-size:16px;color:var(--ink);">${title}</div>
    ${sub ? `<div class="tiny" style="color:var(--ink-3);margin:4px auto 0;max-width:250px;line-height:1.5;">${sub}</div>` : ''}
    ${actionHtml ? `<div style="margin-top:16px;">${actionHtml}</div>` : ''}
  </div>`;
}
function ico(paths) {
  return `<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// "284 kcal · 131 bpm · 12.8 km" — intensity metrics synced from the Peloton API
function workoutMetricsLine(w) {
  if (!w) return '';
  const bits = [];
  if (w.calories) bits.push(`${w.calories} kcal`);
  if (w.avg_hr) bits.push(`${w.avg_hr} bpm`);
  if (w.distance_km) bits.push(`${parseFloat(w.distance_km).toFixed(1)} km`);
  return bits.join(' · ');
}
function timeOfDayLabel(t) {
  return { early:'Early', morning:'Morning', midday:'Midday', afternoon:'Afternoon', evening:'Evening', late:'Late' }[t] || '';
}
function formatRecipeMeta(r) {
  const bits = [];
  if (r.kcal) bits.push(`~${r.kcal} kcal`);
  if (r.protein_g) bits.push(`${r.protein_g}g protein`);
  return bits.join(' · ') || 'Tap for recipe';
}

// Returns a display label for any dinner slot object, handling complete meals,
// component assemblies, Mindful Chef, leftovers, and empty.
function formatDinnerSlotLabel(slotData) {
  if (!slotData) return null;
  if (slotData.component_ids) {
    const { meat, carb, veg } = slotData.component_ids;
    const parts = [meat, carb, veg].map(id => {
      const r = State.recipes.find(x => x.id === id);
      return r ? escapeHtml(r.title) : null;
    }).filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }
  if (slotData.recipe_id) {
    const r = State.recipes.find(x => x.id === slotData.recipe_id);
    return r ? escapeHtml(r.title) : null;
  }
  if (slotData.mindful_chef) return '<em style="color:var(--accent-deep);">Mindful Chef</em>';
  if (slotData.mindful_chef_leftover) return '<em style="color:var(--ink-3);">Leftovers</em>';
  return null;
}

function getSlotRecipe(dateISO, slot) {
  if (!State.weekPlan?.slots) return null;
  const day = State.weekPlan.slots[dateISO];
  if (!day || !day[slot]?.recipe_id) return null;
  return State.recipes.find(r => r.id === day[slot].recipe_id) || null;
}

// Get a personal slot (breakfast/lunch) for the current user on a given date
function getPersonalSlot(dateISO, slot) {
  return State.personalSlots.find(s => s.date === dateISO && s.slot === slot) || null;
}

// Save/update a personal slot row
async function setPersonalSlot(dateISO, slot, payload) {
  const existing = getPersonalSlot(dateISO, slot);
  setSync('syncing','Saving');

  if (!payload) {
    // Remove
    if (existing) {
      State.personalSlots = State.personalSlots.filter(s => !(s.date === dateISO && s.slot === slot));
      await State.client.from('meal_slots_personal').delete().eq('id', existing.id);
    }
    setSync('synced','Saved'); toast('Removed');
    renderAll(); return;
  }

  const row = { household_id: State.householdId, user_id: State.user.id, date: dateISO, slot, ...payload, updated_at: new Date().toISOString() };

  if (existing) {
    const updated = { ...existing, ...payload, updated_at: row.updated_at };
    State.personalSlots = State.personalSlots.map(s => (s.date === dateISO && s.slot === slot) ? updated : s);
    const { error } = await State.client.from('meal_slots_personal').update(row).eq('id', existing.id);
    if (error) { toast('Save failed'); setSync('offline','Error'); return; }
  } else {
    const { data, error } = await State.client.from('meal_slots_personal').insert(row).select().single();
    if (error) { toast('Save failed'); setSync('offline','Error'); return; }
    State.personalSlots.push(data);
  }
  setSync('synced','Saved'); toast('Saved');
  closeSheet();
  renderAll();
}

async function setPersonalSlotFreeChoice(dateISO, slot) {
  await setPersonalSlot(dateISO, slot, { recipe_id: null, free_choice: true, cooked: false });
}

async function markPersonalSlotCooked(dateISO, slot, cooked) {
  const existing = getPersonalSlot(dateISO, slot);
  if (!existing) return;
  await setPersonalSlot(dateISO, slot, { ...existing, cooked });
}

// ============================================================
// TODAY · interactions
// ============================================================
function openDinnerSwap() {
  const today = todayISO();
  const current = getSlotRecipe(today, 'dinner');
  const tonightSlotData = State.weekPlan?.slots?.[today]?.dinner;
  const isMindfulChef = tonightSlotData?.mindful_chef === true;
  const dinners = State.recipes.filter(r => r.category === 'dinner');

  let statusLine;
  if (current) statusLine = 'Currently: ' + escapeHtml(current.title);
  else if (isMindfulChef) statusLine = 'Currently: Mindful Chef tonight';
  else statusLine = 'Pick tonight\'s dinner from your vault.';
  let html = `<div class="tiny" style="margin-bottom:12px;">${statusLine}</div>`;

  // Mindful Chef quick option (always available)
  if (!isMindfulChef) {
    html += `<button class="btn accent block" style="margin-bottom:14px;" onclick="setSlotMindfulChef('${today}')">Mindful Chef tonight</button>`;
  }

  if (dinners.length === 0) {
    html += `<div class="empty"><div class="empty-title">Your dinner vault is empty</div><div class="empty-sub">Add a dinner first.</div>
      <button class="btn primary" onclick="closeSheet();switchScreen('meals');switchMealTab('vault');State.vaultCategory='dinner';renderVault();">Go to vault</button></div>`;
  } else {
    html += '<div class="recipe-grid">' + dinners.map(r => `
      <div class="recipe-tile" onclick="setSlotRecipe('${today}','dinner','${r.id}')">
        ${r.image_url
          ? `<div class="recipe-img" style="background-image:url('${escapeHtml(r.image_url)}')"></div>`
          : `<div class="recipe-img empty"><svg viewBox="0 0 24 24"><path d="M12 3v18M3 12h18"/></svg></div>`}
        <div class="recipe-info">
          <div class="recipe-title">${escapeHtml(r.title)}</div>
          <div class="recipe-meta">${formatRecipeMeta(r)}</div>
        </div>
      </div>`).join('') + '</div>';
    if (current || isMindfulChef) {
      html += `<button class="btn ghost block" style="margin-top:14px;" onclick="setSlotRecipe('${today}','dinner',null)">Remove tonight's dinner</button>`;
    }
  }
  openSheet('Tonight', html);
}

async function setSlotRecipe(dateISO, slot, recipeId) {
  closeSheet();
  const slots = JSON.parse(JSON.stringify(State.weekPlan.slots || {}));
  if (!slots[dateISO]) slots[dateISO] = {};

  // Detect: are we REMOVING a Mindful Chef dinner? If so, also remove the auto-generated leftover lunch on the next day.
  const wasMindfulChefDinner = slot === 'dinner' && slots[dateISO]?.dinner?.mindful_chef === true;
  if (recipeId) {
    slots[dateISO][slot] = { recipe_id: recipeId, cooked: false };
  } else if (slots[dateISO][slot]) {
    delete slots[dateISO][slot];
  }
  // Clean up orphan leftover lunch if dinner removed
  if (wasMindfulChefDinner && !recipeId) {
    const nextDay = isoDateAddDays(dateISO, 1);
    if (slots[nextDay]?.lunch?.mindful_chef_leftover === true) {
      delete slots[nextDay].lunch;
      if (Object.keys(slots[nextDay]).length === 0) delete slots[nextDay];
    }
  }
  if (slots[dateISO] && Object.keys(slots[dateISO]).length === 0) delete slots[dateISO];

  State.weekPlan.slots = slots;
  setSync('syncing', 'Saving');
  const { error } = await State.client.from('week_plans').update({ slots, updated_at: new Date().toISOString() }).eq('id', State.weekPlan.id);
  if (error) { toast('Save failed'); setSync('offline','Error'); }
  else { setSync('synced','Saved'); toast(recipeId ? 'Saved' : 'Removed'); }
  renderAll();
}

async function setSlotFreeChoice(dateISO) {
  closeSheet();
  const slots = JSON.parse(JSON.stringify(State.weekPlan.slots || {}));
  if (!slots[dateISO]) slots[dateISO] = {};
  slots[dateISO].dinner = { free_choice: true, cooked: false };
  State.weekPlan.slots = slots;
  setSync('syncing','Saving');
  const { error } = await State.client.from('week_plans').update({ slots, updated_at: new Date().toISOString() }).eq('id', State.weekPlan.id);
  if (error) { toast('Save failed'); setSync('offline','Error'); }
  else { setSync('synced','Saved'); toast('Free choice night set'); }
  renderAll();
}

async function setSlotMindfulChef(dateISO) {
  closeSheet();
  const slots = JSON.parse(JSON.stringify(State.weekPlan.slots || {}));
  if (!slots[dateISO]) slots[dateISO] = {};

  // Set dinner to Mindful Chef
  slots[dateISO].dinner = { mindful_chef: true, cooked: false };

  // Auto-set next day's lunch to leftovers, ONLY if empty
  const nextDay = isoDateAddDays(dateISO, 1);
  if (!slots[nextDay]?.lunch) {
    if (!slots[nextDay]) slots[nextDay] = {};
    slots[nextDay].lunch = { mindful_chef_leftover: true, cooked: false };
  }

  State.weekPlan.slots = slots;
  setSync('syncing', 'Saving');
  const { error } = await State.client.from('week_plans').update({ slots, updated_at: new Date().toISOString() }).eq('id', State.weekPlan.id);
  if (error) { toast('Save failed'); setSync('offline','Error'); }
  else { setSync('synced','Saved'); toast('Mindful Chef + leftovers planned'); }
  renderAll();
}

function openTodayWorkout() {
  const today = todayISO();
  const m = activeMember();
  const todayWorkouts = State.workouts
    .filter(w => w.member_id === m.id && w.planned_for === today && w.status !== 'cancelled')
    .sort((a, b) => {
      if (a.specific_time && b.specific_time) return a.specific_time.localeCompare(b.specific_time);
      if (a.specific_time) return -1;
      if (b.specific_time) return 1;
      return 0;
    });
  // Prefer the next unfinished session; otherwise the first; otherwise blank
  const next = todayWorkouts.find(w => w.status !== 'done') || todayWorkouts[0] || null;
  openWorkoutSheet(today, next);
}

function openWorkoutSheet(dateISO, existing) {
  const types = ['ride','strength','yoga','stretch','walk','run','other','rest'];
  const current = existing?.session_type || 'ride';
  const dur = existing?.duration_min ?? 30;
  const status = existing?.status || 'planned';
  const note = existing?.note || '';
  const d = new Date(dateISO + 'T00:00:00');
  const title = dateISO === todayISO() ? 'Today' : d.toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'short' });

  const instructor = existing?.instructor || '';
  const classTitle = existing?.class_title || '';
  const pelotonUrl = existing?.peloton_url || '';
  const hasPelotonData = !!(instructor || classTitle || pelotonUrl);

  const timeOfDay = existing?.time_of_day || '';
  const specificTime = existing?.specific_time || '';
  const timeChips = [
    { id:'early', label:'Early' },
    { id:'morning', label:'Morning' },
    { id:'midday', label:'Midday' },
    { id:'afternoon', label:'Afternoon' },
    { id:'evening', label:'Evening' },
    { id:'late', label:'Late' },
  ];

  const html = `
    <div class="field">
      <label class="field-label">Session</label>
      <div class="chip-group" id="sessChips">
        ${types.map(t => `<button class="chip ${t===current?'active':''}" data-t="${t}" onclick="this.parentNode.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));this.classList.add('active');">${sessionTypeLabel(t)}</button>`).join('')}
      </div>
    </div>
    <div class="field">
      <label class="field-label">Duration</label>
      <div class="stepper">
        <button onclick="adjStep('wDur',-5)">−</button>
        <span class="v" id="wDur">${dur}</span>
        <button onclick="adjStep('wDur',5)">+</button>
        <span style="padding:0 14px;color:var(--ink-3);font-size:13px;">min</span>
      </div>
    </div>
    <div class="field">
      <label class="field-label">When${specificTime ? ' · ' + escapeHtml(specificTime) : ''}</label>
      <div class="chip-group" id="todChips">
        <button class="chip ${!timeOfDay?'active':''}" data-tod="" onclick="this.parentNode.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));this.classList.add('active');">Anytime</button>
        ${timeChips.map(c => `<button class="chip ${c.id===timeOfDay?'active':''}" data-tod="${c.id}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');">${c.label}</button>`).join('')}
      </div>
    </div>

    <details ${hasPelotonData ? 'open' : ''} style="margin:6px 0 14px;border-top:1px solid var(--line);padding-top:12px;">
      <summary style="cursor:pointer;font-size:11px;letter-spacing:0.14em;text-transform:uppercase;color:var(--ink-4);font-weight:500;list-style:none;display:flex;align-items:center;gap:6px;">
        <span>Peloton details</span>
        <span style="color:var(--ink-4);font-size:10px;">${hasPelotonData ? '' : '(optional)'}</span>
      </summary>
      <div style="margin-top:12px;">
        <div class="field">
          <label class="field-label">Instructor</label>
          <input class="input" id="wInstructor" placeholder="Olivia Amato" value="${escapeHtml(instructor)}">
        </div>
        <div class="field">
          <label class="field-label">Class title</label>
          <input class="input" id="wClassTitle" placeholder="Pop Ride" value="${escapeHtml(classTitle)}">
        </div>
        <div class="field">
          <label class="field-label">Peloton URL</label>
          <input class="input" id="wPelotonUrl" placeholder="https://members.onepeloton.com/..." value="${escapeHtml(pelotonUrl)}">
        </div>
      </div>
    </details>

    <div class="field">
      <label class="field-label">Note (optional)</label>
      <textarea class="textarea" id="wNote" placeholder="How was it?">${escapeHtml(note)}</textarea>
    </div>
    <div class="btn-row">
      ${dateISO === todayISO() && status !== 'done' ? `<button class="btn primary block" onclick="saveWorkout('${dateISO}', ${existing ? `'${existing.id}'` : 'null'}, 'done')">Mark done</button>` : ''}
      ${status === 'done' ? `<button class="btn ghost block" onclick="saveWorkout('${dateISO}', ${existing ? `'${existing.id}'` : 'null'}, 'planned')">Mark not done</button>` : `<button class="btn block" onclick="saveWorkout('${dateISO}', ${existing ? `'${existing.id}'` : 'null'}, 'planned')">${existing ? 'Save' : 'Plan'}</button>`}
    </div>
    ${pelotonUrl ? `<button class="btn ghost block" style="margin-top:8px;" onclick="openPelotonUrl('${escapeHtml(pelotonUrl)}')">Open this class in Peloton</button>` : (dateISO === todayISO() ? `<button class="btn ghost block" style="margin-top:8px;" onclick="openPeloton()">Open Peloton</button>` : '')}
    ${existing ? `<button class="btn danger block" style="margin-top:8px;" onclick="deleteWorkout('${existing.id}')">Remove</button>` : ''}
  `;
  openSheet(title, html);
}

function adjStep(id, delta) {
  const el = document.getElementById(id);
  let v = parseInt(el.textContent, 10);
  v = Math.max(0, Math.min(180, v + delta));
  el.textContent = v;
}

async function saveWorkout(dateISO, existingId, status) {
  const m = activeMember();
  const sessChip = document.querySelector('#sessChips .chip.active');
  const session_type = sessChip?.dataset.t || 'other';
  const duration_min = parseInt(document.getElementById('wDur').textContent, 10);
  const note = document.getElementById('wNote').value.trim() || null;
  const instructor = document.getElementById('wInstructor')?.value.trim() || null;
  const class_title = document.getElementById('wClassTitle')?.value.trim() || null;
  const peloton_url = document.getElementById('wPelotonUrl')?.value.trim() || null;
  const todChip = document.querySelector('#todChips .chip.active');
  const time_of_day = todChip?.dataset.tod || null;
  let peloton_class_id = null;
  if (peloton_url) {
    const parsed = parsePelotonUrl(peloton_url);
    peloton_class_id = parsed?.class_id || null;
  }

  closeSheet();
  setSync('syncing','Saving');
  const payload = {
    household_id: State.householdId,
    member_id: m.id,
    planned_for: dateISO,
    session_type,
    duration_min,
    status,
    done_at: status === 'done' ? new Date().toISOString() : null,
    note,
    instructor,
    class_title,
    peloton_url,
    peloton_class_id,
    time_of_day: time_of_day || null,
  };
  let res;
  if (existingId) {
    res = await State.client.from('workouts').update(payload).eq('id', existingId).select().single();
  } else {
    res = await State.client.from('workouts').insert(payload).select().single();
  }
  if (res.error) { toast('Save failed'); setSync('offline','Error'); return; }
  // upsert into state
  const idx = State.workouts.findIndex(w => w.id === res.data.id);
  if (idx >= 0) State.workouts[idx] = res.data; else State.workouts.push(res.data);
  setSync('synced','Saved');

  // C25K auto-advance: if a RUN was just marked done, and member is on C25K, bump runs/week
  let bumpedMsg = null;
  if (status === 'done' && session_type === 'run' && m.current_program === 'c25k') {
    // Only bump if this is a NEW completion (existing wasn't already done, or didn't exist)
    const previouslyDone = existingId && State.workouts.find(w => w.id === existingId && w.done_at && w.done_at < res.data.done_at);
    const wasAlreadyDone = false; // we just transitioned to done in this save
    if (!wasAlreadyDone) {
      let week = m.current_program_week || 1;
      let runs = (m.program_runs_this_week || 0) + 1;
      let program = m.current_program;
      let msg = null;
      if (runs >= 3) {
        if (week >= 9) {
          program = null;
          week = null;
          runs = null;
          msg = '🎉 C25K complete! You did it.';
        } else {
          week = week + 1;
          runs = 0;
          msg = `Week ${week-1} done. Moving to week ${week}.`;
        }
      }
      const mPayload = {
        current_program: program,
        current_program_week: week,
        program_runs_this_week: runs,
      };
      const mRes = await State.client.from('members').update(mPayload).eq('id', m.id);
      if (!mRes.error) {
        const mi = State.members.findIndex(x => x.id === m.id);
        if (mi >= 0) State.members[mi] = { ...State.members[mi], ...mPayload };
        bumpedMsg = msg;
      }
    }
  }

  toast(bumpedMsg || (status === 'done' ? 'Logged' : 'Saved'));
  renderAll();
}

async function deleteWorkout(id) {
  if (!confirm('Remove this session?')) return;
  closeSheet();
  setSync('syncing','Removing');
  const { error } = await State.client.from('workouts').delete().eq('id', id);
  if (error) { toast('Failed'); setSync('offline','Error'); return; }
  State.workouts = State.workouts.filter(w => w.id !== id);
  setSync('synced','Removed');
  renderAll();
}

// Two-tap confirm: first tap arms, second tap commits, 3s timeout resets
const _confirmState = {}; // id -> { armedAt, originalText, timer }
function twoTapConfirm(el, armedText, onConfirm) {
  const key = el.id || el.dataset.k || 'anon';
  const now = Date.now();
  const state = _confirmState[key];
  if (state && now - state.armedAt < 3000) {
    // Confirmed
    clearTimeout(state.timer);
    el.textContent = state.originalText;
    delete _confirmState[key];
    onConfirm();
    return;
  }
  // Arm
  const originalText = el.textContent;
  el.textContent = armedText;
  el.style.color = 'var(--bramble)';
  const timer = setTimeout(() => {
    el.textContent = originalText;
    el.style.color = '';
    delete _confirmState[key];
  }, 3000);
  _confirmState[key] = { armedAt: now, originalText, timer };
}

async function clearExerciseWeek(linkEl) {
  twoTapConfirm(linkEl, 'Tap again to clear', async () => {
    const m = activeMember();
    if (!m) return;
    const weekDays = rolling7FromToday();
    const toDelete = State.workouts.filter(w =>
      w.member_id === m.id &&
      weekDays.includes(w.planned_for) &&
      w.status === 'planned' &&
      !w.peloton_calendar_uid && w.source !== 'peloton'  // never delete Peloton-synced sessions
    );
    if (toDelete.length === 0) {
      toast('Nothing to clear');
      return;
    }
    setSync('syncing', 'Clearing');
    const ids = toDelete.map(w => w.id);
    const { error } = await State.client.from('workouts').delete().in('id', ids);
    if (error) { toast('Failed'); setSync('offline','Error'); return; }
    State.workouts = State.workouts.filter(w => !ids.includes(w.id));
    setSync('synced','Cleared');
    toast(`Cleared ${ids.length} planned session${ids.length===1?'':'s'}`);
    renderAll();
  });
}

async function clearMealsWeek(linkEl) {
  twoTapConfirm(linkEl, 'Tap again to clear', async () => {
    const slots = State.weekPlan?.slots || {};
    // Count what will be cleared
    let count = 0;
    const cleaned = {};
    for (const date of Object.keys(slots)) {
      const day = {};
      for (const slotName of ['breakfast','lunch','dinner']) {
        const slot = slots[date][slotName];
        if (!slot) continue;
        // Preserve cooked/eaten slots — only clear planned-not-yet-cooked
        if (slot.cooked) {
          day[slotName] = slot;
        } else {
          count++;
        }
      }
      if (Object.keys(day).length > 0) cleaned[date] = day;
    }
    if (count === 0) {
      toast('Nothing to clear');
      return;
    }
    setSync('syncing', 'Clearing');
    State.weekPlan.slots = cleaned;
    const { error } = await State.client.from('week_plans').update({ slots: cleaned, updated_at: new Date().toISOString() }).eq('id', State.weekPlan.id);
    if (error) { toast('Failed'); setSync('offline','Error'); return; }
    setSync('synced','Cleared');
    toast(`Cleared ${count} planned meal${count===1?'':'s'}`);
    renderAll();
  });
}

function openPeloton() {
  // Try app, fall back to web
  const start = Date.now();
  const fallback = setTimeout(() => {
    window.location.href = 'https://members.onepeloton.com';
  }, 1200);
  window.location.href = 'onepeloton://';
  // If page is hidden quickly, app opened — clear fallback
  setTimeout(() => { if (document.hidden) clearTimeout(fallback); }, 1000);
}

function openPelotonUrl(url) {
  if (!url) return;
  window.open(url, '_blank');
}


let _weightEntryDate = null;
function openWeightEntry(dateISO) {
  const m = activeMember();
  const date = dateISO || todayISO();
  _weightEntryDate = date;
  const existing = State.weights.find(w => w.member_id === m.id && w.logged_at === date);
  const latest = State.weights.find(w => w.member_id === m.id);
  const startVal = existing?.weight_kg || latest?.weight_kg || m.weight_start_kg || 75;
  const dateLabel = date === todayISO() ? "Today's weight" : `Weight · ${formatHistoryDate(date)}`;
  const html = `
    <div class="field">
      <label class="field-label">${dateLabel}</label>
      <div class="stepper">
        <button onclick="adjWeight(-0.1)">−</button>
        <span class="v" id="wKg" style="min-width:90px;font-family:'Archivo Expanded','Archivo',sans-serif;font-size:26px;font-weight:800;">${parseFloat(startVal).toFixed(1)}</span>
        <button onclick="adjWeight(0.1)">+</button>
        <span style="padding:0 14px;color:var(--ink-3);font-size:13px;">kg</span>
      </div>
    </div>
    <div class="btn-row">
      <button class="btn primary block" onclick="saveWeight()">${existing ? 'Update' : 'Save'}</button>
    </div>
    ${existing ? `<button class="btn danger block" style="margin-top:8px;" onclick="deleteWeight('${existing.id}')">Remove today's entry</button>` : ''}
  `;
  openSheet('Weight', html);
}

function adjWeight(delta) {
  const el = document.getElementById('wKg');
  let v = parseFloat(el.textContent) + delta;
  v = Math.round(v * 10) / 10;            // snap to clean 0.1 to avoid float drift
  v = Math.max(30, Math.min(300, v));
  el.textContent = v.toFixed(1);
}

async function saveWeight() {
  const m = activeMember();
  const date = _weightEntryDate || todayISO();
  const weight_kg = parseFloat(document.getElementById('wKg').textContent);
  closeSheet();
  setSync('syncing','Saving');
  const { data, error } = await State.client
    .from('weight_entries')
    .upsert({ household_id: State.householdId, member_id: m.id, logged_at: date, weight_kg }, { onConflict: 'member_id,logged_at' })
    .select()
    .single();
  if (error) { toast('Failed'); setSync('offline','Error'); return; }
  const idx = State.weights.findIndex(w => w.id === data.id);
  if (idx >= 0) State.weights[idx] = data;
  else {
    State.weights.unshift(data);
    State.weights.sort((a,b) => b.logged_at.localeCompare(a.logged_at));
  }
  setSync('synced','Saved');
  toast('Saved');
  renderAll();
}

async function deleteWeight(id) {
  closeSheet();
  await State.client.from('weight_entries').delete().eq('id', id);
  State.weights = State.weights.filter(w => w.id !== id);
  renderAll();
}

// ============================================================
// STRENGTH LOGGING
// ============================================================
let _lastLift = { exercise: '', reps: 8, weight: 20 };

function fmtKg(v) {
  const n = parseFloat(v);
  if (isNaN(n)) return '—';
  return (Number.isInteger(n) ? n : n.toFixed(1)) + 'kg';
}

function adjNum(id, delta, min, max, decimals) {
  const el = document.getElementById(id);
  let v = parseFloat(el.textContent) + delta;
  v = Math.max(min, Math.min(max, v));
  el.textContent = decimals ? (Math.round(v * 10) / 10) : Math.round(v);
}

// Strength card shown on the Train screen
function strengthSectionHtml(m) {
  const sets = State.strengthSets.filter(s => s.member_id === m.id);
  const today = todayISO();
  const todaySets = sets.filter(s => s.performed_at === today);
  let h = `<div class="card">
    <div class="card-row" style="margin-bottom:${(todaySets.length || sets.length) ? '12' : '8'}px;">
      <span class="eyebrow">Strength</span>
      <button class="card-action primary" onclick="openStrengthLogger()">+ Log set</button>
    </div>`;

  if (todaySets.length) {
    const groups = {};
    todaySets.forEach(s => { (groups[s.exercise] = groups[s.exercise] || []).push(s); });
    h += Object.keys(groups).map(ex => {
      const g = groups[ex].slice().sort((a, b) => (a.set_number || 0) - (b.set_number || 0));
      const summary = g.map(s => `${s.reps || 0}×${fmtKg(s.weight_kg)}`).join('   ');
      const vol = g.reduce((t, s) => t + (s.reps || 0) * (parseFloat(s.weight_kg) || 0), 0);
      return `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-top:1px solid var(--line);cursor:pointer;" onclick="openExerciseHistory('${encodeURIComponent(ex)}')">
        <div style="min-width:0;">
          <div style="font-weight:600;color:var(--ink);font-size:14px;">${escapeHtml(ex)}</div>
          <div class="tiny" style="color:var(--ink-3);">${summary}</div>
        </div>
        <div class="tiny" style="color:var(--ink-4);white-space:nowrap;padding-left:10px;">${Math.round(vol)} kg vol</div>
      </div>`;
    }).join('');
    h += `<div class="tiny" style="margin-top:10px;text-align:right;"><a href="#" onclick="event.preventDefault();openStrengthHistory();" style="color:var(--accent);text-decoration:none;">All history →</a></div>`;
  } else if (sets.length) {
    const recent = [];
    const seen = new Set();
    for (const s of sets) { if (!seen.has(s.exercise)) { seen.add(s.exercise); recent.push(s); } if (recent.length >= 4) break; }
    h += recent.map(s => `<div style="display:flex;justify-content:space-between;align-items:baseline;padding:8px 0;border-top:1px solid var(--line);cursor:pointer;" onclick="openExerciseHistory('${encodeURIComponent(s.exercise)}')">
      <span style="font-weight:600;color:var(--ink);font-size:14px;">${escapeHtml(s.exercise)}</span>
      <span class="tiny" style="color:var(--ink-3);">last ${fmtKg(s.weight_kg)} · ${formatHistoryDate(s.performed_at)}</span>
    </div>`).join('');
    h += `<div class="tiny" style="margin-top:8px;color:var(--ink-4);">Nothing logged today yet.</div>`;
  } else {
    h += `<div class="tiny" style="color:var(--ink-3);padding-top:2px;">Track your lifts — sets, reps, weight. Tap “Log set” to start.</div>`;
  }
  h += `</div>`;
  return h;
}

function openStrengthLogger(prefillEx) {
  const m = activeMember();
  const today = todayISO();
  const exNames = [...new Set(State.strengthSets.filter(s => s.member_id === m.id).map(s => s.exercise))];
  const ex = prefillEx != null ? prefillEx : _lastLift.exercise;
  const reps = _lastLift.reps;
  const weight = _lastLift.weight;
  const todaySets = State.strengthSets.filter(s => s.member_id === m.id && s.performed_at === today);
  const todayList = todaySets.length ? `<div class="field" style="margin-top:16px;"><label class="field-label">Logged today</label>${
    todaySets.slice().sort((a, b) => a.exercise.localeCompare(b.exercise) || (a.set_number || 0) - (b.set_number || 0)).map(s => `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 12px;background:var(--card);border:1px solid var(--line);border-radius:8px;margin-bottom:6px;">
      <span style="font-size:13px;"><b>${escapeHtml(s.exercise)}</b> · ${s.reps || 0}×${fmtKg(s.weight_kg)}</span>
      <span onclick="deleteStrengthSet('${s.id}')" style="color:var(--ink-4);font-size:18px;cursor:pointer;padding:0 4px;">×</span>
    </div>`).join('')}</div>` : '';
  const html = `
    <div class="field">
      <label class="field-label">Exercise</label>
      <input class="input" id="sEx" list="exList" placeholder="e.g. Bench press" value="${escapeHtml(ex)}" autocomplete="off">
      <datalist id="exList">${exNames.map(n => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
    </div>
    <div class="input-row">
      <div class="field" style="flex:1;">
        <label class="field-label">Reps</label>
        <div class="stepper"><button onclick="adjNum('sReps',-1,1,100,0)">−</button><span class="v" id="sReps">${reps}</span><button onclick="adjNum('sReps',1,1,100,0)">+</button></div>
      </div>
      <div class="field" style="flex:1;">
        <label class="field-label">Weight (kg)</label>
        <div class="stepper"><button onclick="adjNum('sWt',-2.5,0,500,1)">−</button><span class="v" id="sWt">${weight}</span><button onclick="adjNum('sWt',2.5,0,500,1)">+</button></div>
      </div>
    </div>
    <button class="btn accent block" style="margin-top:4px;" onclick="addStrengthSet()">Add set</button>
    ${todayList}
    <button class="btn ghost block" style="margin-top:8px;" onclick="closeSheet()">Done</button>
  `;
  openSheet('Log strength', html);
}

async function addStrengthSet() {
  const m = activeMember();
  const exercise = (document.getElementById('sEx').value || '').trim();
  if (!exercise) { toast('Enter an exercise'); return; }
  const reps = parseInt(document.getElementById('sReps').textContent, 10) || 0;
  const weight = parseFloat(document.getElementById('sWt').textContent) || 0;
  const today = todayISO();
  const setNum = State.strengthSets.filter(s => s.member_id === m.id && s.performed_at === today && s.exercise.toLowerCase() === exercise.toLowerCase()).length + 1;
  _lastLift = { exercise, reps, weight };
  setSync('syncing', 'Saving');
  const payload = { household_id: State.householdId, member_id: m.id, performed_at: today, exercise, set_number: setNum, reps, weight_kg: weight };
  const { data, error } = await State.client.from('strength_sets').insert(payload).select().single();
  if (error) {
    const msg = /relation|does not exist|schema cache|find the table/i.test(error.message || '') ? 'Run supabase-phase1.sql first' : 'Save failed';
    toast(msg); setSync('offline', 'Error'); return;
  }
  State.strengthSets.unshift(data);
  setSync('synced', 'Saved'); toast('Set added 💪');
  renderAll();
  openStrengthLogger(exercise);
}

async function deleteStrengthSet(id) {
  await State.client.from('strength_sets').delete().eq('id', id);
  State.strengthSets = State.strengthSets.filter(s => s.id !== id);
  toast('Removed');
  renderAll();
  openStrengthLogger();
}

function openExerciseHistory(encName) {
  const ex = decodeURIComponent(encName);
  const m = activeMember();
  const sets = State.strengthSets.filter(s => s.member_id === m.id && s.exercise === ex);
  if (!sets.length) { openSheet(ex, '<div class="empty"><div class="empty-title">No sets yet</div></div>'); return; }
  const byDate = {};
  sets.forEach(s => { (byDate[s.performed_at] = byDate[s.performed_at] || []).push(s); });
  const dates = Object.keys(byDate).sort().reverse();
  const pr = Math.max(...sets.map(s => parseFloat(s.weight_kg) || 0));
  let html = `<div class="tiny" style="margin-bottom:12px;color:var(--ink-3);">Best <b style="color:var(--accent);">${fmtKg(pr)}</b> · ${sets.length} sets logged</div>`;
  html += dates.map(d => {
    const g = byDate[d].slice().sort((a, b) => (a.set_number || 0) - (b.set_number || 0));
    return `<div style="padding:10px 0;border-top:1px solid var(--line);">
      <div class="tiny" style="color:var(--ink-4);margin-bottom:4px;">${formatHistoryDate(d)}</div>
      <div style="font-size:14px;color:var(--ink);">${g.map(s => `${s.reps || 0}×${fmtKg(s.weight_kg)}`).join('   ')}</div>
    </div>`;
  }).join('');
  html += `<button class="btn accent block" style="margin-top:16px;" onclick="closeSheet();openStrengthLoggerEnc('${encodeURIComponent(ex)}')">Add a set</button>`;
  openSheet(ex, html);
}

function openStrengthLoggerEnc(enc) {
  openStrengthLogger(decodeURIComponent(enc));
}

function openStrengthHistory() {
  const m = activeMember();
  const exNames = [...new Set(State.strengthSets.filter(s => s.member_id === m.id).map(s => s.exercise))];
  if (!exNames.length) { openSheet('Strength', '<div class="empty"><div class="empty-title">No lifts yet</div></div>'); return; }
  const html = exNames.map(ex => {
    const sets = State.strengthSets.filter(s => s.member_id === m.id && s.exercise === ex);
    const pr = Math.max(...sets.map(s => parseFloat(s.weight_kg) || 0));
    const last = sets[0];
    return `<div class="card" style="display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin-bottom:6px;" onclick="openExerciseHistory('${encodeURIComponent(ex)}')">
      <span style="font-weight:600;">${escapeHtml(ex)}</span>
      <span class="tiny" style="color:var(--ink-3);">best ${fmtKg(pr)} · ${formatHistoryDate(last.performed_at)}</span>
    </div>`;
  }).join('');
  openSheet('Strength history', html);
}

// ============================================================
// RENDER · EXERCISE
// ============================================================
function renderExercise() {
  const m = activeMember();
  if (!m) return;
  const today = todayISO();

  // Rolling 7-day strip starts at today
  const weekDays = rolling7FromToday();

  // Weekly count still uses calendar week (Mon-Sun)
  const calWeekStart = weekStartFor(new Date());
  const calWeekDays = Array.from({length:7}, (_,i) => isoDateAddDays(calWeekStart, i));
  const calWeekWorkouts = State.workouts.filter(w => w.member_id === m.id && calWeekDays.includes(w.planned_for));
  const doneCount = calWeekWorkouts.filter(w => w.status === 'done').length;
  const target = m.weekly_session_target || 4;

  // Workouts for the visible (rolling) strip
  const visibleWorkouts = State.workouts.filter(w => w.member_id === m.id && weekDays.includes(w.planned_for));

  document.getElementById('exerciseSub').innerHTML = `<span data-num-id="exercise-done">${doneCount}</span> of ${target} sessions this week`;

  let html = '';

  // Favourite instructor ambient label
  {
    const favs = favouriteInstructors(m);
    if (favs.length) html += `<div class="tiny" style="padding:0 2px 12px;color:var(--ink-3);">This week · ${escapeHtml(favs.join(' · '))}</div>`;
  }

  // Action buttons — moved to top
  html += `<div style="display:flex;gap:8px;margin-bottom:8px;">
    <button class="btn primary" style="flex:1;" onclick="syncPeloton(true, false)">Sync Peloton</button>
    <button class="btn accent" style="flex:1;" onclick="openMagicWeekExercise()">Plan week</button>
  </div>`;
  html += pelotonHealthLine();
  html += `<div style="text-align:right;margin-bottom:8px;">
    <a href="#" id="clearExerciseLink" onclick="event.preventDefault();clearExerciseWeek(this);" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-4);text-decoration:none;">Clear week</a>
  </div>`;

  // Last-30-days motivation band — sessions · time · calories
  {
    const since = isoDateAddDays(today, -30);
    const done30 = State.workouts.filter(w => w.member_id === m.id && w.status === 'done' && w.planned_for >= since && w.planned_for <= today);
    const mins30 = done30.reduce((s, w) => s + (w.duration_min || 0), 0);
    const kcal30 = done30.reduce((s, w) => s + (w.calories || 0), 0);
    const hrs = Math.floor(mins30 / 60), rem = mins30 % 60;
    const timeStr = mins30 >= 60 ? `${hrs}<span class="frac">h</span> ${rem}` : `${mins30}`;
    html += `<div class="eyebrow" style="margin:2px 2px 8px;">Last 30 days</div>
    <div class="card" style="display:flex;justify-content:space-around;text-align:center;padding:16px 14px;">
      <div><div class="stat-num" style="font-size:26px;"><span class="accent">${done30.length}</span></div><div class="stat-label">sessions</div></div>
      <div><div class="stat-num" style="font-size:26px;">${timeStr}<span class="frac">${mins30 >= 60 ? 'm' : ' min'}</span></div><div class="stat-label">trained</div></div>
      ${kcal30 > 0 ? `<div><div class="stat-num" style="font-size:26px;color:#ffb84d;">${kcal30.toLocaleString()}</div><div class="stat-label">kcal</div></div>` : ''}
    </div>`;
  }

  // Strength logging section
  html += strengthSectionHtml(m);

  // Schedule heading
  html += `<div class="section-head"><span class="t">Schedule</span></div>`;

  // 7 day cards
  // Other member's workouts for the same days (for partner-session line + conflict dot)
  const otherMembers = State.members.filter(mm => mm.id !== m.id);

  weekDays.forEach((d, idx) => {
    const dayWorkouts = visibleWorkouts
      .filter(w => w.planned_for === d)
      // Sort: by specific_time if present, else by time_of_day chip order, else by created order
      .sort((a, b) => {
        if (a.specific_time && b.specific_time) return a.specific_time.localeCompare(b.specific_time);
        if (a.specific_time) return -1;
        if (b.specific_time) return 1;
        const order = ['early','morning','midday','afternoon','evening','late'];
        const ai = order.indexOf(a.time_of_day || '');
        const bi = order.indexOf(b.time_of_day || '');
        if (ai >= 0 && bi >= 0) return ai - bi;
        if (ai >= 0) return -1;
        if (bi >= 0) return 1;
        return 0;
      });
    const isToday = d === today;

    // Partner sessions on this day (any other member, all of them)
    const partnerSessions = [];
    otherMembers.forEach(om => {
      const pws = State.workouts.filter(x => x.member_id === om.id && x.planned_for === d && x.status !== 'cancelled');
      pws.forEach(pw => partnerSessions.push({ member: om, workout: pw }));
    });

    // Conflict: any of my sessions and any partner session share the same time_of_day chip
    const myChips = new Set(dayWorkouts.filter(w => w.status !== 'cancelled' && w.time_of_day).map(w => w.time_of_day));
    const conflictChips = [];
    partnerSessions.forEach(ps => {
      if (ps.workout.time_of_day && myChips.has(ps.workout.time_of_day)) {
        if (!conflictChips.includes(ps.workout.time_of_day)) conflictChips.push(ps.workout.time_of_day);
      }
    });
    const isConflict = conflictChips.length > 0;

    // Format partner session lines
    const partnerLines = partnerSessions.map(ps => {
      const name = escapeHtml(ps.member.display_name);
      const t = ps.workout.specific_time
        ? ps.workout.specific_time
        : (ps.workout.time_of_day ? timeOfDayLabel(ps.workout.time_of_day) : null);
      const type = sessionTypeLabel(ps.workout.session_type).toLowerCase();
      return t
        ? `<div class="tiny" style="margin-top:4px;color:var(--ink-3);">· ${name} · ${type} · ${escapeHtml(t)}</div>`
        : `<div class="tiny" style="margin-top:4px;color:var(--ink-3);">· ${name} · ${type}</div>`;
    }).join('');

    // Render the outer card
    const totalMin = dayWorkouts.filter(w => w.status !== 'cancelled').reduce((s, w) => s + (w.duration_min || 0), 0);
    const totalLine = dayWorkouts.length > 1 && totalMin > 0
      ? `<div class="tiny" style="color:var(--ink-4);">${totalMin} min total</div>`
      : '';

    html += `<div class="day-card ${isToday?'today':''}">
      <div class="day-head" onclick="openWorkoutFor('${d}')" style="cursor:pointer;">
        <div class="day-name">${isToday ? 'Today' : dayLabel(d)} <span class="date">${shortDate(d)}</span>${isConflict ? ` <span title="Both planning ${conflictChips.map(timeOfDayLabel).join(', ')}" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#d18e3a;margin-left:4px;vertical-align:middle;"></span>` : ''}</div>
        ${dayWorkouts.length === 0 ? `<div class="tiny" style="color:var(--ink-4);">Nothing planned</div>` : totalLine}
      </div>`;

    if (dayWorkouts.length === 0) {
      html += `<div class="card-meta" style="margin-top:0;color:var(--ink-4);font-style:italic;" onclick="openWorkoutFor('${d}')">A quiet day. Tap to add something.</div>`;
    } else {
      // Render each session as a stacked sub-row
      dayWorkouts.forEach((w, sessionIdx) => {
        const isCancelled = w.status === 'cancelled';
        const cancelStyle = isCancelled ? 'opacity:0.55;text-decoration:line-through;' : '';
        const display = formatWorkoutDisplay(w);
        const statusBadge = isCancelled
          ? `<span class="tiny" style="color:var(--bramble);">Cancelled</span>`
          : (w.status === 'done' ? `<span class="tiny" style="color:var(--moss);">Done ✓</span>` : '');
        const timeLabel = w.specific_time || (w.time_of_day ? timeOfDayLabel(w.time_of_day) : null);
        const topMargin = sessionIdx === 0 ? '6px' : '10px';
        const borderTop = sessionIdx > 0 ? 'border-top:1px solid var(--line);padding-top:10px;' : '';

        html += `<div onclick="openWorkoutById('${w.id}','${d}')" style="cursor:pointer;margin-top:${topMargin};${borderTop}">
          <div style="${cancelStyle}">
            <div class="card-meta" style="margin-top:0;display:flex;align-items:center;gap:10px;">
              <span style="color:${sessionTint(w.session_type)};display:inline-flex;flex-shrink:0;">${sessionIcon(w.session_type, 18)}</span>
              <span style="flex:1;">${escapeHtml(display.primary)}${timeLabel ? ` <span style="color:var(--ink-4);font-size:12px;">· ${escapeHtml(timeLabel)}</span>` : ''}</span>
              ${statusBadge}
            </div>
            ${display.secondary ? `<div class="tiny" style="margin-top:4px;font-style:italic;color:var(--ink-3);">${escapeHtml(display.secondary)}</div>` : ''}
            ${w.session_type === 'run' && m.current_program === 'c25k' && !isCancelled ? (() => {
              const runNum = (m.program_runs_this_week || 0) + 1;
              const presc = c25kPrescription(m.current_program_week || 1, runNum);
              if (!presc) return '';
              return `<div class="tiny" style="margin-top:8px;padding:8px 10px;background:var(--paper-2);border-left:2px solid var(--accent);border-radius:4px;line-height:1.5;"><strong style="display:block;margin-bottom:2px;color:var(--ink);">C25K · Week ${m.current_program_week} · Run ${runNum}</strong>${escapeHtml(presc)}<br><span style="color:var(--ink-4);font-size:11px;display:block;margin-top:4px;">Follow the NHS C25K app for audio coaching.</span></div>`;
            })() : ''}
            ${w.note ? `<div class="tiny" style="margin-top:6px;font-style:italic;">"${escapeHtml(w.note)}"</div>` : ''}
          </div>
          ${w.status === 'planned' ? `<div style="margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;">${w.peloton_url ? `<button class="card-action" onclick="event.stopPropagation();openPelotonUrl('${escapeHtml(w.peloton_url)}')">Open Peloton</button>` : ''}<button class="card-action" onclick="event.stopPropagation();rescheduleWorkout('${w.id}')">Move to tomorrow →</button></div>` : ''}
        </div>`;
      });

      // "Add another session" link at the bottom of the card
      html += `<div class="tiny" style="margin-top:10px;padding-top:8px;border-top:1px solid var(--line);text-align:right;"><a href="#" onclick="event.preventDefault();openWorkoutFor('${d}');" style="color:var(--accent-deep);text-decoration:none;">+ Add another session</a></div>`;
    }

    // Partner lines + close
    html += `${partnerLines}</div>`;
  });

  // Recent completed sessions (past days), newest first — synced rides + logged workouts
  {
    const recent = State.workouts
      .filter(w => w.member_id === m.id && w.status === 'done' && w.planned_for < today)
      .sort((a, b) => b.planned_for.localeCompare(a.planned_for))
      .slice(0, 20);
    if (recent.length) {
      html += `<div class="section-head"><span class="t">Recent</span></div>`;
      html += recent.map(w => {
        const disp = formatWorkoutDisplay(w);
        return `<div class="card" style="display:flex;align-items:center;gap:12px;padding:12px 14px;margin-bottom:8px;cursor:pointer;" onclick="openWorkoutById('${w.id}','${w.planned_for}')">
          ${sessionIconTile(w.session_type, 40)}
          <div style="flex:1;min-width:0;">
            <div style="font-weight:600;color:var(--ink);font-size:14px;">${escapeHtml(disp.primary)}</div>
            ${disp.secondary ? `<div class="tiny" style="color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(disp.secondary)}</div>` : ''}
            ${workoutMetricsLine(w) ? `<div class="tiny" style="color:var(--ink-4);margin-top:1px;">${workoutMetricsLine(w)}</div>` : ''}
          </div>
          <div class="tiny" style="color:var(--ink-4);white-space:nowrap;">${formatHistoryDate(w.planned_for)}</div>
        </div>`;
      }).join('');
    } else {
      html += `<div class="section-head"><span class="t">Recent</span></div>`;
      html += `<div class="card">${emptyState(
        ico('<path d="M4 14h2l2-8 4 12 2-6h6"/>'),
        'No sessions yet',
        'Your Peloton &amp; Watch workouts will appear here once they sync — or tap a day above to log one.'
      )}</div>`;
    }
  }

  // Quiet "Open Peloton" at bottom for ad-hoc use
  html += `<button class="btn ghost block" style="margin-top:14px;" onclick="openPeloton()">Open Peloton</button>`;

  document.getElementById('exerciseContent').innerHTML = html;
}

function openWorkoutFor(dateISO) {
  // Opens a NEW blank workout planning sheet for the given day
  openWorkoutSheet(dateISO, null);
}

function openWorkoutById(workoutId, dateISO) {
  const w = State.workouts.find(x => x.id === workoutId);
  if (!w) {
    openWorkoutSheet(dateISO || todayISO(), null);
    return;
  }
  openWorkoutSheet(w.planned_for, w);
}

// ============================================================
// RENDER · MEALS · VAULT
// ============================================================
function renderVault() {
  const root = document.getElementById('mealsVault');
  if (!root) return;
  const cat = State.vaultCategory;
  const recipes = State.recipes.filter(r => r.category === cat);

  let html = `<div class="chip-group" style="margin-bottom:14px;">
    ${['breakfast','lunch','dinner'].map(c => `<button class="chip ${c===cat?'active':''}" onclick="setVaultCategory('${c}')">${c[0].toUpperCase()+c.slice(1)}</button>`).join('')}
  </div>`;

  function recipeTileHtml(r) {
    return `<div class="recipe-tile" onclick="openRecipe('${r.id}')">
      ${r.image_url
        ? `<div class="recipe-img" style="background-image:url('${escapeHtml(r.image_url)}')">${r.favourite ? '<div class="recipe-fav"><svg viewBox="0 0 24 24"><path d="M12 21l-1.5-1.4C5 14.4 2 11.7 2 8.4 2 5.8 4 4 6.5 4 7.9 4 9.3 4.7 12 7c2.7-2.3 4.1-3 5.5-3C20 4 22 5.8 22 8.4c0 3.3-3 6-8.5 11.2L12 21z"/></svg></div>' : ''}</div>`
        : `<div class="recipe-img empty"><svg viewBox="0 0 24 24"><path d="M3 8h18M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 8V5a3 3 0 0 1 6 0v3"/></svg>${r.favourite ? '<div class="recipe-fav"><svg viewBox="0 0 24 24"><path d="M12 21l-1.5-1.4C5 14.4 2 11.7 2 8.4 2 5.8 4 4 6.5 4 7.9 4 9.3 4.7 12 7c2.7-2.3 4.1-3 5.5-3C20 4 22 5.8 22 8.4c0 3.3-3 6-8.5 11.2L12 21z"/></svg></div>' : ''}</div>`}
      <div class="recipe-info">
        <div class="recipe-title">${escapeHtml(r.title)}</div>
        <div class="recipe-meta">${formatRecipeMeta(r)}</div>
      </div>
    </div>`;
  }

  // Complete meals grid
  if (recipes.length === 0) {
    html += `<div class="empty">
      <div class="empty-title">Your ${cat} shelf is empty</div>
      <div class="empty-sub">Add the meals you actually cook. Up to 20 here.</div>
      <button class="btn primary" onclick="openRecipeEditor()">Add a ${cat}</button>
    </div>`;
  } else {
    html += '<div class="recipe-grid">';
    recipes.forEach(r => { html += recipeTileHtml(r); });
    if (recipes.length < 20) {
      html += `<div class="recipe-add-tile" onclick="openRecipeEditor()">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        <span>Add ${cat}</span>
      </div>`;
    }
    html += '</div>';
  }

  // Components section — dinner tab only
  if (cat === 'dinner') {
    const components = State.recipes.filter(r => r.category === 'dinner_component');
    const buckets = [
      { key: 'red_meat',   label: 'Red meat' },
      { key: 'white_meat', label: 'White meat' },
      { key: 'fish',       label: 'Fish' },
      { key: 'carb',       label: 'Carb' },
      { key: 'veg',        label: 'Veg / Salad' },
    ];

    html += `<div style="margin-top:22px;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
        <span class="eyebrow">Components</span>
        <button class="btn ghost" style="padding:5px 10px;font-size:12px;" onclick="openRecipeEditorComponent('red_meat')">+ Add component</button>
      </div>
      <div class="tiny" style="margin-bottom:14px;color:var(--ink-3);">One meat (red, white, or fish), one carb, and one veg/salad are randomly assembled into a dinner when planning the week.</div>`;

    buckets.forEach(({ key, label }) => {
      const pool = components.filter(r => r.component_type === key);
      html += `<div style="margin-bottom:16px;">
        <div class="field-label" style="margin-bottom:8px;">${label} <span style="color:var(--ink-4);font-weight:400;">(${pool.length})</span></div>`;
      if (pool.length === 0) {
        html += `<div class="tiny" style="color:var(--ink-4);padding:4px 0 8px;">None yet.</div>`;
      } else {
        html += '<div class="recipe-grid">';
        pool.forEach(r => { html += recipeTileHtml(r); });
        html += '</div>';
      }
      html += `<button class="btn ghost" style="margin-top:6px;padding:5px 12px;font-size:12px;" onclick="openRecipeEditorComponent('${key}')">+ Add ${label.toLowerCase()}</button>`;
      html += '</div>';
    });

    html += '</div>';
  }

  root.innerHTML = html;
}

function setVaultCategory(c) {
  State.vaultCategory = c;
  renderVault();
}

function openRecipeEditorComponent(type) {
  openRecipeEditor();
  setTimeout(() => {
    const catChip = document.querySelector('#rCat .chip[data-c="dinner_component"]');
    if (catChip) catChip.click();
    const typeChip = document.querySelector(`#rCompType .chip[data-t="${type}"]`);
    if (typeChip) { document.querySelectorAll('#rCompType .chip').forEach(x => x.classList.remove('active')); typeChip.classList.add('active'); }
  }, 50);
}

function openRecipe(id) {
  const r = State.recipes.find(x => x.id === id);
  if (!r) return;
  const ings = State.ingredients[id] || [];
  const today = todayISO();
  const plannedToday = State.weekPlan?.slots?.[today]?.[r.category]?.recipe_id === id;

  const html = `
    ${r.image_url ? `<div style="aspect-ratio:1.6/1;background:var(--paper-2) center/cover url('${escapeHtml(r.image_url)}');border-radius:var(--radius);margin-bottom:14px;"></div>` : ''}
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div class="tiny">${formatRecipeMeta(r) || '—'} · ${r.servings} serving${r.servings===1?'':'s'}</div>
      <button onclick="toggleFavourite('${r.id}')" style="padding:6px;">
        <svg viewBox="0 0 24 24" width="20" height="20" stroke="${r.favourite?'var(--accent)':'var(--ink-4)'}" fill="${r.favourite?'var(--accent)':'none'}" stroke-width="1.5"><path d="M12 21l-1.5-1.4C5 14.4 2 11.7 2 8.4 2 5.8 4 4 6.5 4 7.9 4 9.3 4.7 12 7c2.7-2.3 4.1-3 5.5-3C20 4 22 5.8 22 8.4c0 3.3-3 6-8.5 11.2L12 21z"/></svg>
      </button>
    </div>
    ${ings.length ? `<div class="field"><label class="field-label">Ingredients</label>
      <div style="font-size:14px;line-height:1.7;">${ings.map(i => `<div>${i.quantity ? `<strong>${i.quantity}${i.unit?' '+escapeHtml(i.unit):''}</strong> ` : ''}${escapeHtml(i.name)}</div>`).join('')}</div>
    </div>` : ''}
    ${r.method ? `<div class="field"><label class="field-label">Method</label>
      <div style="font-size:14px;line-height:1.7;white-space:pre-wrap;">${escapeHtml(r.method)}</div>
    </div>` : ''}
    ${r.tags?.length ? `<div class="field"><label class="field-label">Tags</label>
      <div class="chip-group">${r.tags.map(t => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>
    </div>` : ''}
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="setSlotRecipe('${today}','${r.category}','${r.id}')">${plannedToday ? '✓ Planned today' : `Cook this ${r.category === 'dinner' ? 'tonight' : 'today'}`}</button>
    </div>
    <div class="btn-row">
      <button class="btn block" onclick="openRecipeEditor('${r.id}')">Edit</button>
      <button class="btn danger block" onclick="deleteRecipe('${r.id}')">Delete</button>
    </div>
  `;
  openSheet(escapeHtml(r.title), html);
}

async function toggleFavourite(id) {
  const r = State.recipes.find(x => x.id === id);
  if (!r) return;
  r.favourite = !r.favourite;
  await State.client.from('recipes').update({ favourite: r.favourite, updated_at: new Date().toISOString() }).eq('id', id);
  openRecipe(id);
  renderVault();
}

async function deleteRecipe(id) {
  if (!confirm('Delete this recipe?')) return;
  closeSheet();
  await State.client.from('recipes').delete().eq('id', id);
  State.recipes = State.recipes.filter(r => r.id !== id);
  delete State.ingredients[id];
  toast('Deleted');
  renderVault();
}

// ============================================================
// RECIPE EDITOR
// ============================================================
let editingRecipeId = null;
let editingIngredients = [];

function openRecipeEditor(id) {
  editingRecipeId = id || null;
  const r = id ? State.recipes.find(x => x.id === id) : null;
  editingIngredients = id ? [...(State.ingredients[id] || []).map(i => ({...i}))] : [];

  const cat = r?.category || State.vaultCategory;

  const compType = r?.component_type || 'red_meat';
  const proteinType = r?.protein_type || 'white';

  const html = `
    <div class="field">
      <label class="field-label">Category</label>
      <div class="chip-group" id="rCat">
        ${['breakfast','lunch','dinner','dinner_component'].map(c => {
          const label = c === 'dinner_component' ? 'Dinner component' : c[0].toUpperCase()+c.slice(1);
          return `<button class="chip ${c===cat?'active':''}" data-c="${c}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');document.getElementById('rCompTypeWrap').style.display=this.dataset.c==='dinner_component'?'block':'none';document.getElementById('rProteinTypeWrap').style.display=this.dataset.c==='dinner'?'block':'none';">${label}</button>`;
        }).join('')}
      </div>
    </div>
    <div class="field" id="rProteinTypeWrap" style="display:${cat==='dinner'?'block':'none'};">
      <label class="field-label">Protein type</label>
      <div class="chip-group" id="rProteinType">
        ${[['red','Red meat'],['white','White meat'],['fish','Fish'],['veg','Veg']].map(([v,l]) => `<button class="chip ${v===proteinType?'active':''}" data-t="${v}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');">${l}</button>`).join('')}
      </div>
    </div>
    <div class="field" id="rCompTypeWrap" style="display:${cat==='dinner_component'?'block':'none'};">
      <label class="field-label">Component type</label>
      <div class="chip-group" id="rCompType">
        ${[['red_meat','Red meat'],['white_meat','White meat'],['fish','Fish'],['carb','Carb'],['veg','Veg / Salad']].map(([v,l]) => `<button class="chip ${v===compType?'active':''}" data-t="${v}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');">${l}</button>`).join('')}
      </div>
      <div class="tiny" style="margin-top:6px;color:var(--ink-3);">One meat, one carb, and one veg/salad will be randomly combined into a dinner when planning the week.</div>
    </div>
    <div class="field">
      <label class="field-label">Title</label>
      <input class="input" id="rTitle" placeholder="Lemon chicken &amp; orzo" value="${escapeHtml(r?.title || '')}">
    </div>
    <div class="field">
      <label class="field-label">Image URL (optional)</label>
      <input class="input" id="rImg" placeholder="https://..." value="${escapeHtml(r?.image_url || '')}">
    </div>
    <div class="field input-row">
      <div>
        <label class="field-label">Calories</label>
        <input class="input" id="rKcal" type="number" inputmode="numeric" placeholder="—" value="${r?.kcal || ''}">
      </div>
      <div>
        <label class="field-label">Protein (g)</label>
        <input class="input" id="rProtein" type="number" inputmode="numeric" placeholder="—" value="${r?.protein_g || ''}">
      </div>
      <div>
        <label class="field-label">Servings</label>
        <input class="input" id="rServings" type="number" inputmode="numeric" value="${r?.servings || 2}">
      </div>
    </div>
    <div class="field">
      <label class="field-label">Ingredients</label>
      <div id="ingList"></div>
      <button class="ing-add" onclick="addIngredient()">+ Add ingredient</button>
      ${State.settings?.claude_api_key ? `<button class="btn ghost block" style="margin-top:8px;" onclick="estimateMacros()">Estimate calories &amp; protein</button>` : ''}
    </div>
    <div class="field">
      <label class="field-label">Method</label>
      <textarea class="textarea" id="rMethod" placeholder="Heat oil in a pan...">${escapeHtml(r?.method || '')}</textarea>
    </div>
    <div class="field">
      <label class="field-label">Tags (comma separated)</label>
      <input class="input" id="rTags" placeholder="quick, freezer, kids" value="${escapeHtml((r?.tags || []).join(', '))}">
    </div>
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="saveRecipe()">${id ? 'Save changes' : 'Add to vault'}</button>
    </div>
  `;
  openSheet(id ? 'Edit recipe' : 'New recipe', html);
  renderIngredientList();
}

function addIngredient() {
  editingIngredients.push({ name:'', quantity:null, unit:'', category:'other', sort_order: editingIngredients.length });
  renderIngredientList();
}

function renderIngredientList() {
  const root = document.getElementById('ingList');
  if (!root) return;
  if (editingIngredients.length === 0) {
    root.innerHTML = '<div class="tiny" style="padding:8px 0;">No ingredients yet.</div>';
    return;
  }
  root.innerHTML = editingIngredients.map((i, idx) => `
    <div class="ing-row">
      <input placeholder="Name" value="${escapeHtml(i.name)}" onchange="editingIngredients[${idx}].name=this.value">
      <input placeholder="Qty" type="number" inputmode="decimal" value="${i.quantity ?? ''}" onchange="editingIngredients[${idx}].quantity=this.value?parseFloat(this.value):null">
      <select onchange="editingIngredients[${idx}].unit=this.value">
        <option value="" ${!i.unit?'selected':''}>unit</option>
        <option value="g" ${i.unit==='g'?'selected':''}>g</option>
        <option value="kg" ${i.unit==='kg'?'selected':''}>kg</option>
        <option value="ml" ${i.unit==='ml'?'selected':''}>ml</option>
        <option value="l" ${i.unit==='l'?'selected':''}>l</option>
        <option value="tbsp" ${i.unit==='tbsp'?'selected':''}>tbsp</option>
        <option value="tsp" ${i.unit==='tsp'?'selected':''}>tsp</option>
        <option value="cup" ${i.unit==='cup'?'selected':''}>cup</option>
        <option value="oz" ${i.unit==='oz'?'selected':''}>oz</option>
      </select>
      <button class="ing-remove" onclick="editingIngredients.splice(${idx},1);renderIngredientList();">×</button>
    </div>
    <div style="margin:-2px 0 8px 0;">
      <select style="font-size:11px;padding:4px 8px;background:var(--paper-2);border:1px solid var(--line);border-radius:4px;color:var(--ink-3);" onchange="editingIngredients[${idx}].category=this.value">
        <option value="produce" ${i.category==='produce'?'selected':''}>Produce</option>
        <option value="meat" ${i.category==='meat'?'selected':''}>Meat &amp; fish</option>
        <option value="dairy" ${i.category==='dairy'?'selected':''}>Dairy</option>
        <option value="pantry" ${i.category==='pantry'?'selected':''}>Pantry</option>
        <option value="other" ${i.category==='other'?'selected':''}>Other</option>
      </select>
    </div>
  `).join('');
}

async function saveRecipe() {
  const cat = document.querySelector('#rCat .chip.active')?.dataset.c || 'dinner';
  const title = document.getElementById('rTitle').value.trim();
  if (!title) { toast('Title required'); return; }
  const image_url = document.getElementById('rImg').value.trim() || null;
  const kcal = parseInt(document.getElementById('rKcal').value, 10) || null;
  const protein_g = parseInt(document.getElementById('rProtein').value, 10) || null;
  const servings = parseInt(document.getElementById('rServings').value, 10) || 2;
  const method = document.getElementById('rMethod').value.trim() || null;
  const tags = document.getElementById('rTags').value.split(',').map(s => s.trim()).filter(Boolean);

  const component_type = cat === 'dinner_component'
    ? (document.querySelector('#rCompType .chip.active')?.dataset.t || 'red_meat')
    : null;

  const protein_type = cat === 'dinner'
    ? (document.querySelector('#rProteinType .chip.active')?.dataset.t || 'white')
    : null;

  closeSheet();
  setSync('syncing','Saving');

  const recipePayload = {
    household_id: State.householdId,
    category: cat,
    component_type,
    protein_type,
    title, image_url, kcal, protein_g, servings, method, tags,
    updated_at: new Date().toISOString(),
  };

  let recipeId = editingRecipeId;
  if (recipeId) {
    const { error } = await State.client.from('recipes').update(recipePayload).eq('id', recipeId);
    if (error) { toast('Failed'); setSync('offline','Error'); return; }
  } else {
    const { data, error } = await State.client.from('recipes').insert(recipePayload).select().single();
    if (error) { toast('Failed'); setSync('offline','Error'); return; }
    recipeId = data.id;
    State.recipes.push(data);
  }

  // ingredients: full replace
  await State.client.from('ingredients').delete().eq('recipe_id', recipeId);
  if (editingIngredients.length > 0) {
    const payload = editingIngredients
      .filter(i => i.name.trim())
      .map((i, idx) => ({
        recipe_id: recipeId,
        name: i.name.trim(),
        quantity: i.quantity,
        unit: i.unit || null,
        category: i.category || 'other',
        sort_order: idx,
      }));
    if (payload.length) {
      const { data: ingsData } = await State.client.from('ingredients').insert(payload).select();
      State.ingredients[recipeId] = ingsData || [];
    } else {
      State.ingredients[recipeId] = [];
    }
  } else {
    State.ingredients[recipeId] = [];
  }

  // update in memory
  const { data: refreshed } = await State.client.from('recipes').select('*').eq('id', recipeId).single();
  const idx = State.recipes.findIndex(r => r.id === recipeId);
  if (idx >= 0) State.recipes[idx] = refreshed;

  setSync('synced','Saved');
  toast(editingRecipeId ? 'Updated' : 'Added');
  editingRecipeId = null;
  editingIngredients = [];
  renderVault();
}

async function estimateMacros() {
  const apiKey = State.settings?.claude_api_key;
  if (!apiKey) { toast('Set API key in Profile first'); return; }
  const ings = editingIngredients.filter(i => i.name.trim());
  if (ings.length === 0) { toast('Add ingredients first'); return; }
  const title = document.getElementById('rTitle').value.trim();
  const servings = parseInt(document.getElementById('rServings').value, 10) || 2;

  toast('Estimating…');
  const ingredientText = ings.map(i => `${i.quantity || ''} ${i.unit || ''} ${i.name}`.trim()).join('\n');
  const prompt = `Estimate calories and protein for this recipe per serving. Return ONLY valid JSON like {"kcal": 520, "protein_g": 32}.

Recipe: ${title || 'untitled'}
Servings: ${servings}
Ingredients:
${ingredientText}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'x-api-key': apiKey,
        'anthropic-version':'2023-06-01',
        'anthropic-dangerous-direct-browser-access':'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role:'user', content: prompt }],
      }),
    });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]);
    if (parsed.kcal) document.getElementById('rKcal').value = parsed.kcal;
    if (parsed.protein_g) document.getElementById('rProtein').value = parsed.protein_g;
    toast('Estimated');
  } catch (e) {
    console.error(e);
    toast('Estimate failed');
  }
}

// ============================================================
// RENDER · MEALS · WEEK
// ============================================================
function renderWeek() {
  const root = document.getElementById('mealsWeek');
  if (!root) return;
  const today = todayISO();
  const weekStart = State.weekStart;
  const weekDays = Array.from({length:7}, (_,i) => isoDateAddDays(weekStart, i));

  let html = `<div class="btn-row" style="margin-bottom:8px;">
    <button class="btn accent block" onclick="generateMagicWeek()">Plan week</button>
  </div>
  <div style="text-align:right;margin-bottom:14px;">
    <a href="#" id="clearMealsLink" onclick="event.preventDefault();clearMealsWeek(this);" style="font-size:11px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-4);text-decoration:none;">Clear week</a>
  </div>`;

  const dayLabels = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  weekDays.forEach(d => {
    const [yy, mm, dd] = d.split('-').map(Number);
    const dayOfWeek = new Date(yy, mm - 1, dd).getDay();
    const slots = State.weekPlan?.slots?.[d] || {};
    const isToday = d === today;

    html += `<div class="day-card ${isToday?'today':''}">
      <div class="day-head">
        <div class="day-name">${dayLabels[dayOfWeek]} <span class="date">${shortDate(d)}</span></div>
        ${isToday ? '<div class="tiny" style="color:var(--accent);">Today</div>' : ''}
      </div>
      ${['breakfast','lunch','dinner'].map(slot => {
        const isPersonal = slot === 'breakfast' || slot === 'lunch';
        let s, isComponent, recipe, isMindfulChef, isLeftover, isFreeChoice;
        if (isPersonal) {
          const ps = getPersonalSlot(d, slot);
          recipe = ps?.recipe_id ? State.recipes.find(r => r.id === ps.recipe_id) : null;
          isFreeChoice = ps?.free_choice === true;
          s = ps; isComponent = false; isMindfulChef = false; isLeftover = false;
        } else {
          s = slots[slot];
          isComponent = !!(s?.component_ids);
          recipe = !isComponent && s?.recipe_id ? State.recipes.find(r => r.id === s.recipe_id) : null;
          isMindfulChef = s?.mindful_chef === true;
          isLeftover = s?.mindful_chef_leftover === true;
          isFreeChoice = s?.free_choice === true;
        }
        let label = '—';
        let extraStyle = '';
        if (isFreeChoice) { label = 'Free choice'; extraStyle = 'color:var(--ink-3);font-style:italic;'; }
        else if (isComponent) { label = formatDinnerSlotLabel(s) || '—'; extraStyle = 'font-size:12px;'; }
        else if (recipe) label = escapeHtml(recipe.title);
        else if (isMindfulChef) { label = 'Mindful Chef'; extraStyle = 'color:var(--accent-deep);font-style:italic;'; }
        else if (isLeftover) { label = 'Leftovers from Mindful Chef'; extraStyle = 'color:var(--ink-3);font-style:italic;'; }
        const filled = isFreeChoice || isComponent || recipe || isMindfulChef || isLeftover;
        const thumb = recipe?.image_url
          ? `<div class="slot-thumb" style="background-image:url('${escapeHtml(recipe.image_url)}')"></div>`
          : '';
        return `<div class="slot-row" onclick="openSlotPicker('${d}','${slot}')">
          <div class="slot-label">${slot[0].toUpperCase()+slot.slice(1)}</div>
          ${thumb}
          <div class="slot-content ${!filled?'empty':''} ${s?.cooked?'cooked':''}" style="${extraStyle}">${label}</div>
          <div class="slot-action">${filled ? (s?.cooked?'✓':'') : '+'}</div>
        </div>`;
      }).join('')}
    </div>`;
  });

  root.innerHTML = html;
}

function openSlotPicker(dateISO, slot) {
  const isPersonal = slot === 'breakfast' || slot === 'lunch';
  const dateLong = new Date(dateISO + 'T00:00:00').toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'short' });

  // Resolve current slot data from the right source
  let slotData, current, isMindfulChef, isLeftover, isComponent, isFreeChoice;
  if (isPersonal) {
    slotData = getPersonalSlot(dateISO, slot);
    current = slotData?.recipe_id ? State.recipes.find(r => r.id === slotData.recipe_id) : null;
    isFreeChoice = slotData?.free_choice === true;
    isMindfulChef = false; isLeftover = false; isComponent = false;
  } else {
    slotData = State.weekPlan?.slots?.[dateISO]?.[slot];
    isComponent = !!(slotData?.component_ids);
    current = !isComponent && slotData?.recipe_id ? State.recipes.find(r => r.id === slotData.recipe_id) : null;
    isMindfulChef = slotData?.mindful_chef === true;
    isLeftover = slotData?.mindful_chef_leftover === true;
    isFreeChoice = slotData?.free_choice === true;
  }

  const recipes = State.recipes.filter(r => r.category === slot);
  let html = `<div class="tiny" style="margin-bottom:12px;">${dateLong} · ${slot}</div>`;

  // Current slot state — actions
  if (isFreeChoice) {
    html += `<div class="card" style="background:var(--paper-2);margin-bottom:14px;">
      <div class="card-big" style="font-size:16px;">Free choice 🍽️</div>
      <div class="tiny" style="margin-top:4px;color:var(--ink-3);">Going off-book tonight.</div>
    </div>
    <button class="btn danger block" style="margin-bottom:14px;" onclick="${isPersonal ? `setPersonalSlot('${dateISO}','${slot}',null)` : `setSlotRecipe('${dateISO}','${slot}',null)`}">Remove</button>`;
  } else if (isComponent) {
    const label = formatDinnerSlotLabel(slotData) || '—';
    html += `<div class="card" style="background:var(--paper-2);margin-bottom:14px;">
      <div class="card-big" style="font-size:15px;line-height:1.5;">${label}</div>
      <div class="tiny" style="margin-top:4px;color:var(--ink-3);">Assembled from your component pools.</div>
    </div>
    <div class="btn-row" style="margin-bottom:14px;">
      <button class="btn block" onclick="markCooked('${dateISO}','${slot}',${slotData.cooked?'false':'true'})">${slotData.cooked ? 'Unmark cooked' : 'Mark cooked'}</button>
      <button class="btn danger block" onclick="setSlotRecipe('${dateISO}','${slot}',null)">Remove</button>
    </div>`;
  } else if (current) {
    html += `<div class="btn-row" style="margin-bottom:14px;">
      <button class="btn block" onclick="${isPersonal ? `markPersonalSlotCooked('${dateISO}','${slot}',${slotData.cooked?'false':'true'})` : `markCooked('${dateISO}','${slot}',${slotData.cooked?'false':'true'})`}">${slotData?.cooked ? 'Unmark cooked' : 'Mark cooked'}</button>
      <button class="btn danger block" onclick="${isPersonal ? `setPersonalSlot('${dateISO}','${slot}',null)` : `setSlotRecipe('${dateISO}','${slot}',null)`}">Remove</button>
    </div>`;
  } else if (isMindfulChef) {
    html += `<div class="card" style="background:var(--accent-soft);margin-bottom:14px;">
      <div class="card-big" style="font-size:16px;">Mindful Chef tonight</div>
      <div class="tiny" style="margin-top:4px;color:var(--ink-2);">Tomorrow's lunch is set to leftovers automatically.</div>
    </div>
    <div class="btn-row" style="margin-bottom:14px;">
      <button class="btn block" onclick="markCooked('${dateISO}','${slot}',${slotData.cooked?'false':'true'})">${slotData.cooked ? 'Unmark cooked' : 'Mark cooked'}</button>
      <button class="btn danger block" onclick="setSlotRecipe('${dateISO}','${slot}',null)">Remove</button>
    </div>`;
  } else if (isLeftover) {
    html += `<div class="card" style="background:var(--paper-2);margin-bottom:14px;">
      <div class="card-big" style="font-size:16px;">Leftovers from Mindful Chef</div>
      <div class="tiny" style="margin-top:4px;color:var(--ink-3);">Auto-set from yesterday's dinner. No shopping needed.</div>
    </div>
    <div class="btn-row" style="margin-bottom:14px;">
      <button class="btn block" onclick="markCooked('${dateISO}','${slot}',${slotData.cooked?'false':'true'})">${slotData.cooked ? 'Unmark eaten' : 'Mark eaten'}</button>
      <button class="btn danger block" onclick="setSlotRecipe('${dateISO}','${slot}',null)">Remove</button>
    </div>`;
  }

  // Dinner-only special buttons
  if (slot === 'dinner' && !isMindfulChef && !isComponent && !isFreeChoice) {
    html += `<button class="btn accent block" style="margin-bottom:8px;" onclick="setSlotMindfulChef('${dateISO}')">Mindful Chef tonight</button>`;
    html += `<button class="btn ghost block" style="margin-bottom:14px;" onclick="setSlotFreeChoice('${dateISO}')">Free choice night</button>`;
  }

  // Recipe grid
  if (recipes.length === 0) {
    html += `<div class="empty">
      <div class="empty-title">No ${slot}s in vault</div>
      <div class="empty-sub">Add ${slot} recipes first.</div>
    </div>`;
  } else {
    html += '<div class="recipe-grid">';
    recipes.forEach(r => {
      const isCurrent = current?.id === r.id;
      const onclick = isPersonal
        ? `setPersonalSlot('${dateISO}','${slot}',{recipe_id:'${r.id}',cooked:false,free_choice:false})`
        : `setSlotRecipe('${dateISO}','${slot}','${r.id}')`;
      html += `<div class="recipe-tile" onclick="${onclick}" style="${isCurrent?'border-color:var(--accent);border-width:2px;':''}">
        ${r.image_url
          ? `<div class="recipe-img" style="background-image:url('${escapeHtml(r.image_url)}')"></div>`
          : `<div class="recipe-img empty"><svg viewBox="0 0 24 24"><path d="M3 8h18M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 8V5a3 3 0 0 1 6 0v3"/></svg></div>`}
        <div class="recipe-info">
          <div class="recipe-title">${escapeHtml(r.title)}</div>
          <div class="recipe-meta">${formatRecipeMeta(r)}</div>
        </div>
      </div>`;
    });
    html += '</div>';
  }
  openSheet(slot[0].toUpperCase()+slot.slice(1), html);
}

async function markCooked(dateISO, slot, cooked) {
  closeSheet();
  const slots = JSON.parse(JSON.stringify(State.weekPlan.slots || {}));
  if (!slots[dateISO] || !slots[dateISO][slot]) return;
  slots[dateISO][slot].cooked = cooked === 'true' || cooked === true;
  State.weekPlan.slots = slots;
  await State.client.from('week_plans').update({ slots, updated_at: new Date().toISOString() }).eq('id', State.weekPlan.id);
  // also update recipe last_cooked
  if (slots[dateISO][slot].cooked) {
    const recipeId = slots[dateISO][slot].recipe_id;
    await State.client.from('recipes').update({ last_cooked_at: dateISO }).eq('id', recipeId);
    const r = State.recipes.find(x => x.id === recipeId);
    if (r) r.last_cooked_at = dateISO;
  }
  renderWeek();
  renderShopping();
}

// ============================================================
// MAGIC WEEK
// ============================================================
async function generateMagicWeek() {
  if (!State.recipes.length) {
    toast('Add some recipes first');
    switchMealTab('vault');
    return;
  }

  const weekStart = State.weekStart;
  const weekDays = Array.from({length:7}, (_,i) => isoDateAddDays(weekStart, i));
  const existing = State.weekPlan.slots || {};
  const newSlots = JSON.parse(JSON.stringify(existing));

  const dt = State.settings?.dinner_targets || { red: 1, white: 2, fish: 1, veg: 1 };

  // Pick from pool avoiding already-used-this-week ids. Falls back to full pool if exhausted.
  function pickRandom(arr, usedIds) {
    const fresh = arr.filter(r => !usedIds.has(r.id));
    const src = fresh.length ? fresh : arr; // fallback if pool fully exhausted
    if (!src.length) return null;
    const weighted = [];
    src.forEach(r => { weighted.push(r); if (r.favourite) weighted.push(r); });
    return weighted[Math.floor(Math.random() * weighted.length)];
  }

  function completeDinnersByType(ptype) {
    return State.recipes.filter(r => r.category === 'dinner' && r.protein_type === ptype);
  }
  function componentMeatByType(ptype) {
    const key = ptype === 'red' ? 'red_meat' : ptype === 'white' ? 'white_meat' : 'fish';
    return State.recipes.filter(r => r.category === 'dinner_component' && r.component_type === key);
  }
  function componentCarbs() { return State.recipes.filter(r => r.category === 'dinner_component' && r.component_type === 'carb'); }
  function componentVeg()   { return State.recipes.filter(r => r.category === 'dinner_component' && r.component_type === 'veg'); }
  function canAssembleComponent(ptype) {
    return componentMeatByType(ptype).length > 0 && componentCarbs().length > 0 && componentVeg().length > 0;
  }

  // Build protein type queue for empty dinner slots from targets
  const filledTypes = { red: 0, white: 0, fish: 0, veg: 0 };
  for (const d of weekDays) {
    const s = (existing[d] || {}).dinner;
    if (!s) continue;
    if (s.component_ids) {
      const meat = State.recipes.find(r => r.id === s.component_ids.meat);
      if (meat?.component_type === 'red_meat') filledTypes.red++;
      else if (meat?.component_type === 'white_meat') filledTypes.white++;
      else if (meat?.component_type === 'fish') filledTypes.fish++;
    } else if (s.recipe_id) {
      const r = State.recipes.find(x => x.id === s.recipe_id);
      if (r?.protein_type && filledTypes[r.protein_type] !== undefined) filledTypes[r.protein_type]++;
    }
  }

  const queue = [];
  ['red','white','fish','veg'].forEach(pt => {
    const remaining = Math.max(0, (dt[pt]||0) - filledTypes[pt]);
    for (let i = 0; i < remaining; i++) queue.push(pt);
  });
  // Shuffle
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }

  const emptyDinnerDays = weekDays.filter(d => {
    const s = (existing[d] || {}).dinner;
    return !s?.recipe_id && !s?.mindful_chef && !s?.mindful_chef_leftover && !s?.component_ids;
  });

  const dinnerPlan = {};
  emptyDinnerDays.forEach((d, i) => { dinnerPlan[d] = queue[i] || 'any'; });

  const used = { breakfast: new Set(), lunch: new Set(), dinner: new Set() };
  const prevComp = { meat: null, carb: null, veg: null };
  let componentCount = 0;

  // Seed used sets from already-filled shared dinner slots
  for (const d of weekDays) {
    const ex = newSlots[d]?.dinner;
    if (ex?.recipe_id) used.dinner.add(ex.recipe_id);
  }
  // Seed used sets from existing personal breakfast/lunch slots
  State.personalSlots.forEach(s => {
    if (weekDays.includes(s.date) && (s.slot === 'breakfast' || s.slot === 'lunch') && s.recipe_id) {
      used[s.slot].add(s.recipe_id);
    }
  });

  for (const d of weekDays) {
    if (!newSlots[d]) newSlots[d] = {};

    for (const slot of ['breakfast','lunch','dinner']) {
      const ex = newSlots[d][slot];
      if (ex?.recipe_id || ex?.mindful_chef || ex?.mindful_chef_leftover || ex?.component_ids || ex?.free_choice) {
        if (ex.component_ids) componentCount++;
        continue;
      }

      if (slot !== 'dinner') {
        // Skip if personal slot already filled
        const existingPersonal = getPersonalSlot(d, slot);
        if (existingPersonal?.recipe_id || existingPersonal?.free_choice) continue;
        const r = pickRandom(State.recipes.filter(r => r.category === slot), used[slot]);
        if (r) { newSlots[d][slot] = { recipe_id: r.id, cooked: false }; used[slot].add(r.id); }
        continue;
      }

      // Dinner
      const ptype = dinnerPlan[d] || 'any';

      // Veg is always a complete meal
      if (ptype === 'veg') {
        const pool = completeDinnersByType('veg');
        const r = pickRandom(pool.length ? pool : State.recipes.filter(r => r.category === 'dinner'), used.dinner);
        if (r) { newSlots[d].dinner = { recipe_id: r.id, cooked: false }; used.dinner.add(r.id); }
        continue;
      }

      // For red/white/fish: randomly decide component vs complete
      const tryComponent = ptype !== 'any'
        && canAssembleComponent(ptype)
        && Math.random() < 0.5;

      if (tryComponent) {
        const meatUsed = new Set([prevComp.meat].filter(Boolean));
        const carbUsed = new Set([prevComp.carb].filter(Boolean));
        const vegUsed  = new Set([prevComp.veg].filter(Boolean));
        const meat = pickRandom(componentMeatByType(ptype), meatUsed);
        const carb = pickRandom(componentCarbs(), carbUsed);
        const veg  = pickRandom(componentVeg(), vegUsed);
        if (meat && carb && veg) {
          newSlots[d].dinner = { component_ids: { meat: meat.id, carb: carb.id, veg: veg.id }, cooked: false };
          prevComp.meat = meat.id; prevComp.carb = carb.id; prevComp.veg = veg.id;
          componentCount++;
          continue;
        }
      }

      // Complete meal — prefer correct protein type, fall back to anything
      const typed = ptype !== 'any' ? completeDinnersByType(ptype) : [];
      const allDinners = State.recipes.filter(r => r.category === 'dinner');
      const r = pickRandom(typed.length ? typed : allDinners, used.dinner);
      if (r) { newSlots[d].dinner = { recipe_id: r.id, cooked: false }; used.dinner.add(r.id); }
    }
  }

  // Split: dinner-only slots go to week_plans, breakfast/lunch go to meal_slots_personal
  const sharedSlots = {};
  const personalSlotRows = [];
  weekDays.forEach(d => {
    if (!newSlots[d]) return;
    sharedSlots[d] = {};
    if (newSlots[d].dinner) sharedSlots[d].dinner = newSlots[d].dinner;
    // Preserve any existing non-meal data on the day
    Object.keys(newSlots[d]).forEach(k => {
      if (k !== 'breakfast' && k !== 'lunch') sharedSlots[d][k] = newSlots[d][k];
    });
    ['breakfast','lunch'].forEach(slot => {
      const s = newSlots[d][slot];
      if (s?.recipe_id) {
        personalSlotRows.push({ date: d, slot, recipe_id: s.recipe_id, cooked: false, free_choice: false });
      }
    });
  });

  // Stash pending plan in State so commitMagicWeek can access it without giant onclick JSON
  State._pendingMagicWeek = { sharedSlots, personalSlotRows };

  // Preview
  let html = `<div class="tiny" style="margin-bottom:14px;">Preview the suggested week. Already-filled slots are preserved.</div>`;
  weekDays.forEach(d => {
    const slots = newSlots[d] || {};
    const date = new Date(d + 'T00:00:00');
    html += `<div class="day-card" style="margin-bottom:8px;">
      <div class="day-name" style="margin-bottom:6px;">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()]} <span class="date">${shortDate(d)}</span></div>
      ${['breakfast','lunch','dinner'].map(s => {
        const sd = slots[s];
        let label = '—';
        if (sd?.component_ids) label = formatDinnerSlotLabel(sd) || '—';
        else if (sd?.recipe_id) { const r = State.recipes.find(x => x.id === sd.recipe_id); label = r ? escapeHtml(r.title) : '—'; }
        else if (sd?.mindful_chef) label = '<em style="color:var(--accent-deep);">Mindful Chef</em>';
        else if (sd?.mindful_chef_leftover) label = '<em style="color:var(--ink-3);">Leftovers</em>';
        return `<div class="tiny" style="padding:2px 0;"><span style="color:var(--ink-4);">${s[0].toUpperCase()+s.slice(1)} · </span>${label}</div>`;
      }).join('')}
    </div>`;
  });
  html += `<div class="btn-row" style="margin-top:14px;">
    <button class="btn block" onclick="generateMagicWeek()">Try again</button>
    <button class="btn primary block" onclick="commitMagicWeek()">Use this week</button>
  </div>`;
  openSheet('Plan week', html);
}

async function commitMagicWeek() {
  const pending = State._pendingMagicWeek;
  if (!pending) { toast('Nothing to commit'); return; }
  closeSheet();
  setSync('syncing','Saving');

  // Save shared (dinner) slots to week_plans
  State.weekPlan.slots = pending.sharedSlots;
  const { error: wpErr } = await State.client
    .from('week_plans')
    .update({ slots: pending.sharedSlots, updated_at: new Date().toISOString() })
    .eq('id', State.weekPlan.id);
  if (wpErr) { toast('Failed'); setSync('offline','Error'); return; }

  // Upsert personal breakfast/lunch slots
  if (pending.personalSlotRows.length) {
    const rows = pending.personalSlotRows.map(r => ({
      household_id: State.householdId,
      user_id: State.user.id,
      date: r.date,
      slot: r.slot,
      recipe_id: r.recipe_id,
      cooked: false,
      free_choice: false,
      updated_at: new Date().toISOString(),
    }));
    const { error: psErr } = await State.client
      .from('meal_slots_personal')
      .upsert(rows, { onConflict: 'user_id,date,slot' });
    if (psErr) { toast('Partial save — personal slots failed'); setSync('offline','Error'); return; }
    // Update local State.personalSlots
    rows.forEach(row => {
      const idx = State.personalSlots.findIndex(s => s.date === row.date && s.slot === row.slot);
      if (idx >= 0) State.personalSlots[idx] = { ...State.personalSlots[idx], ...row };
      else State.personalSlots.push(row);
    });
  }

  State._pendingMagicWeek = null;
  setSync('synced','Saved');
  toast('Week generated');
  renderWeek();
  renderShopping();
  renderToday();
}

// ============================================================
// SHOPPING LIST
// ============================================================
async function renderShopping() {
  const root = document.getElementById('mealsShopping');
  if (!root) return;

  // Generate from current week plan (exclude cooked)
  const generated = generateShoppingFromWeek();

  // Reconcile with stored shopping_items: keep custom items, keep checked state
  await reconcileShoppingItems(generated);

  const items = State.shoppingItems.slice().sort((a,b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  if (items.length === 0) {
    root.innerHTML = `<div class="empty">
      <div class="empty-title">Nothing to shop for</div>
      <div class="empty-sub">Plan some meals first, or add custom items below.</div>
      <button class="btn primary" onclick="addCustomShopItem()">Add custom item</button>
    </div>`;
    return;
  }

  const aisles = ['produce','meat','dairy','pantry','other'];
  const aisleLabels = { produce:'Produce', meat:'Meat & fish', dairy:'Dairy', pantry:'Pantry', other:'Other' };
  let html = `<div class="btn-row" style="margin-bottom:14px;">
    <button class="btn block" onclick="shareShoppingList()">Share list</button>
    <button class="btn ghost block" onclick="clearCheckedShopping()">Clear checked</button>
  </div>`;
  aisles.forEach(a => {
    const aisleItems = items.filter(i => i.aisle === a);
    if (aisleItems.length === 0) return;
    const remaining = aisleItems.filter(i => !i.checked).length;
    html += `<div class="aisle">
      <div class="aisle-head"><div class="aisle-name">${aisleLabels[a]}</div><div class="aisle-count">${remaining} of ${aisleItems.length}</div></div>
      ${aisleItems.map(i => `<div class="shop-item ${i.checked?'checked':''}" onclick="toggleShop('${i.id}')">
        <div class="shop-check ${i.checked?'on':''}"></div>
        <div class="shop-name">${escapeHtml(i.name)}</div>
        ${i.quantity_display ? `<div class="shop-qty">${escapeHtml(i.quantity_display)}</div>` : ''}
      </div>`).join('')}
    </div>`;
  });
  html += `<button class="btn ghost block" style="margin-top:8px;" onclick="addCustomShopItem()">+ Add custom item</button>`;
  root.innerHTML = html;
}

function generateShoppingFromWeek() {
  const slots = State.weekPlan?.slots || {};
  const tally = {}; // key: name|unit -> { name, unit, qty, aisle }

  function tallyRecipe(recipeId) {
    const ings = State.ingredients[recipeId] || [];
    ings.forEach(ing => {
      const key = `${ing.name.toLowerCase().trim()}|${(ing.unit||'').toLowerCase()}`;
      if (!tally[key]) tally[key] = { name: ing.name, unit: ing.unit, qty: 0, aisle: ing.category };
      if (ing.quantity) tally[key].qty += parseFloat(ing.quantity);
    });
  }

  for (const date of Object.keys(slots)) {
    for (const slotName of ['breakfast','lunch','dinner']) {
      const slot = slots[date][slotName];
      if (!slot || slot.cooked) continue;
      if (slot.component_ids) {
        // Tally ingredients from all three component recipes
        const { meat, carb, veg } = slot.component_ids;
        [meat, carb, veg].filter(Boolean).forEach(tallyRecipe);
      } else if (slot.recipe_id) {
        tallyRecipe(slot.recipe_id);
      }
    }
  }
  return Object.values(tally).map(t => ({
    name: t.name,
    quantity_display: t.qty > 0 ? `${+t.qty.toFixed(2)}${t.unit?' '+t.unit:''}` : '',
    aisle: t.aisle,
    custom: false,
  }));
}

async function reconcileShoppingItems(generated) {
  // existing: keep custom + keep checked state for matching items
  const existing = State.shoppingItems;
  const keep = [];
  const toInsert = [];
  const toDelete = [];

  // Build map of existing non-custom items by name+aisle
  const existingMap = {};
  existing.forEach(e => {
    if (!e.custom) {
      const k = `${e.name.toLowerCase()}|${e.aisle}`;
      existingMap[k] = e;
    } else {
      keep.push(e);
    }
  });

  for (const g of generated) {
    const k = `${g.name.toLowerCase()}|${g.aisle}`;
    if (existingMap[k]) {
      const e = existingMap[k];
      // update qty_display if different
      if (e.quantity_display !== g.quantity_display) {
        await State.client.from('shopping_items').update({ quantity_display: g.quantity_display, updated_at: new Date().toISOString() }).eq('id', e.id);
        e.quantity_display = g.quantity_display;
      }
      keep.push(e);
      delete existingMap[k];
    } else {
      toInsert.push({
        household_id: State.householdId,
        week_plan_id: State.weekPlan.id,
        name: g.name,
        quantity_display: g.quantity_display,
        aisle: g.aisle,
        checked: false,
        custom: false,
      });
    }
  }

  // Anything left in existingMap is no longer in the plan → delete (only if not checked, to be safe)
  for (const e of Object.values(existingMap)) {
    toDelete.push(e.id);
  }

  if (toInsert.length) {
    const { data } = await State.client.from('shopping_items').insert(toInsert).select();
    if (data) keep.push(...data);
  }
  if (toDelete.length) {
    await State.client.from('shopping_items').delete().in('id', toDelete);
  }
  State.shoppingItems = keep;
}

async function toggleShop(id) {
  const item = State.shoppingItems.find(i => i.id === id);
  if (!item) return;
  item.checked = !item.checked;
  document.querySelectorAll(`.shop-item`).forEach(el => { /* rerender for animation */ });
  renderShopping();
  await State.client.from('shopping_items').update({ checked: item.checked, updated_at: new Date().toISOString() }).eq('id', id);
}

async function clearCheckedShopping() {
  const checked = State.shoppingItems.filter(i => i.checked);
  if (checked.length === 0) return;
  if (!confirm(`Clear ${checked.length} checked item${checked.length===1?'':'s'}?`)) return;
  await State.client.from('shopping_items').delete().in('id', checked.map(i => i.id));
  State.shoppingItems = State.shoppingItems.filter(i => !i.checked);
  renderShopping();
}

function addCustomShopItem() {
  const html = `
    <div class="field">
      <label class="field-label">Item</label>
      <input class="input" id="scName" placeholder="Olive oil" autofocus>
    </div>
    <div class="field">
      <label class="field-label">Quantity (optional)</label>
      <input class="input" id="scQty" placeholder="1 bottle">
    </div>
    <div class="field">
      <label class="field-label">Aisle</label>
      <div class="chip-group" id="scAisle">
        ${['produce','meat','dairy','pantry','other'].map((a,i) => `<button class="chip ${i===4?'active':''}" data-a="${a}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');">${({produce:'Produce',meat:'Meat',dairy:'Dairy',pantry:'Pantry',other:'Other'})[a]}</button>`).join('')}
      </div>
    </div>
    <button class="btn primary block" onclick="saveCustomShop()">Add</button>
  `;
  openSheet('Custom item', html);
}

async function saveCustomShop() {
  const name = document.getElementById('scName').value.trim();
  if (!name) return;
  const quantity_display = document.getElementById('scQty').value.trim() || null;
  const aisle = document.querySelector('#scAisle .chip.active')?.dataset.a || 'other';
  closeSheet();
  const { data } = await State.client.from('shopping_items').insert({
    household_id: State.householdId,
    week_plan_id: State.weekPlan.id,
    name, quantity_display, aisle, custom: true,
  }).select().single();
  if (data) State.shoppingItems.push(data);
  renderShopping();
}

function shareShoppingList() {
  const aisles = ['produce','meat','dairy','pantry','other'];
  const aisleLabels = { produce:'Produce', meat:'Meat & fish', dairy:'Dairy', pantry:'Pantry', other:'Other' };
  let text = 'Shopping list\n\n';
  aisles.forEach(a => {
    const items = State.shoppingItems.filter(i => i.aisle === a && !i.checked);
    if (items.length === 0) return;
    text += `${aisleLabels[a]}\n`;
    items.forEach(i => { text += `· ${i.name}${i.quantity_display ? ' — ' + i.quantity_display : ''}\n`; });
    text += '\n';
  });
  if (navigator.share) {
    navigator.share({ title:'Shopping list', text }).catch(()=>{});
  } else {
    navigator.clipboard.writeText(text).then(()=>toast('Copied to clipboard'));
  }
}

// ============================================================
// MEALS — simple weekly planner (name + source + optional link)
// Stored in week_plans.slots[dateISO][slot] = { name, source, url }
// ============================================================
let _mealEdit = { date: null, slot: null };

// Normalise a stored slot (handles the new simple shape and legacy recipe shapes)
function normMealSlot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if ('name' in raw || 'url' in raw || 'source' in raw) {
    return { name: raw.name || '', source: raw.source || '', url: raw.url || '' };
  }
  if (raw.recipe_id) {
    const r = (State.recipes || []).find(x => x.id === raw.recipe_id);
    return { name: r ? r.title : '', source: '', url: '' };
  }
  if (raw.mindful_chef) return { name: 'Mindful Chef', source: '', url: '' };
  return null;
}

function mealDayName(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long' }); }
function mealShortDate(iso) { return new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); }

function mealWeekRangeLabel(weekStart) {
  const start = new Date(weekStart + 'T00:00:00');
  const end = new Date(isoDateAddDays(weekStart, 6) + 'T00:00:00');
  const fmt = (dt) => dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const thisMon = weekStartFor(new Date());
  let rel = '';
  if (weekStart === thisMon) rel = 'This week';
  else if (weekStart === isoDateAddDays(thisMon, 7)) rel = 'Next week';
  else if (weekStart === isoDateAddDays(thisMon, -7)) rel = 'Last week';
  return `${fmt(start)} – ${fmt(end)}${rel ? `<span class="sub">${rel}</span>` : ''}`;
}

function renderMeals() {
  const plan = State.mealPlan;
  const weekStart = State.mealWeekStart;
  const root = document.getElementById('mealsContent');
  const labelEl = document.getElementById('mealWeekLabel');
  if (!root) return;
  if (!plan || !weekStart) { root.innerHTML = ''; return; }
  if (labelEl) labelEl.innerHTML = mealWeekRangeLabel(weekStart);

  const slots = plan.slots || {};
  const today = todayISO();
  const days = Array.from({ length: 7 }, (_, i) => isoDateAddDays(weekStart, i));
  const order = [['breakfast', 'Breakfast'], ['lunch', 'Lunch'], ['dinner', 'Dinner']];

  root.innerHTML = days.map(d => {
    const isToday = d === today;
    const dayslots = slots[d] || {};
    const rows = order.map(([key, label]) => {
      const mealObj = normMealSlot(dayslots[key]);
      const filled = mealObj && (mealObj.name || mealObj.url || mealObj.source);
      const right = (mealObj && mealObj.url)
        ? `<span class="meal-slot-link" onclick="event.stopPropagation();openMealUrl('${encodeURIComponent(mealObj.url)}')">↗</span>`
        : `<span class="meal-slot-add">${filled ? '' : '+'}</span>`;
      const val = filled
        ? `${mealObj.name ? escapeHtml(mealObj.name) : '<span style="color:var(--ink-4);">(no name)</span>'}${mealObj.source ? `<span class="src">${escapeHtml(mealObj.source)}</span>` : ''}`
        : 'Tap to add';
      return `<div class="meal-slot ${key}" onclick="openMealEditor('${d}','${key}')">
        <span class="meal-slot-label">${label}</span>
        <span class="meal-slot-val ${filled ? '' : 'empty'}">${val}</span>
        ${right}
      </div>`;
    }).join('');
    return `<div class="card meal-day ${isToday ? 'today' : ''}">
      <div class="meal-day-head">
        <span class="meal-day-name">${mealDayName(d)} <span class="date">${mealShortDate(d)}</span></span>
        ${isToday ? '<span class="badge">Today</span>' : ''}
      </div>
      ${rows}
    </div>`;
  }).join('');
}

function openMealUrl(enc) {
  const u = decodeURIComponent(enc);
  if (u) window.open(u, '_blank');
}

async function mealWeekNav(delta) {
  if (!State.mealWeekStart) return;
  await loadMealWeek(isoDateAddDays(State.mealWeekStart, delta * 7));
}

async function loadMealWeek(weekStart) {
  setSync('syncing', 'Loading');
  try {
    const plan = (weekStart === State.weekStart && State.weekPlan)
      ? State.weekPlan
      : await getOrCreateWeekPlan(weekStart);
    State.mealPlan = plan;
    State.mealWeekStart = weekStart;
    setSync('synced', 'Synced');
    renderMeals();
  } catch (e) {
    setSync('offline', 'Error');
    toast('Could not load that week');
  }
}

function openMealEditor(dateISO, slot) {
  _mealEdit = { date: dateISO, slot };
  const cur = normMealSlot((State.mealPlan?.slots?.[dateISO] || {})[slot]) || { name: '', source: '', url: '' };
  const slotLabel = slot[0].toUpperCase() + slot.slice(1);
  const html = `
    <div class="field">
      <label class="field-label">Meal</label>
      <input class="input" id="mName" placeholder="e.g. Butter chicken" value="${escapeHtml(cur.name)}" autocomplete="off">
    </div>
    <div class="field">
      <label class="field-label">From — cookbook, RecipeTin…</label>
      <input class="input" id="mSource" placeholder="Ottolenghi p.120" value="${escapeHtml(cur.source)}" autocomplete="off">
    </div>
    <div class="field">
      <label class="field-label">Link (optional)</label>
      <input class="input" id="mUrl" inputmode="url" placeholder="https://…" value="${escapeHtml(cur.url)}" autocomplete="off">
      <button class="btn ghost block" style="margin-top:8px;" id="mFetchBtn" onclick="fetchMealNameFromUrl()">Get name from link</button>
    </div>
    <div class="btn-row">
      <button class="btn accent block" onclick="saveMealSlot()">Save</button>
    </div>
    ${(cur.name || cur.source || cur.url) ? `<button class="btn danger block" style="margin-top:8px;" onclick="clearMealSlot()">Clear</button>` : ''}
  `;
  openSheet(`${mealDayName(dateISO)} · ${slotLabel}`, html);
}

async function saveMealSlot() {
  const { date, slot } = _mealEdit;
  if (!date || !slot) return;
  const name = (document.getElementById('mName').value || '').trim();
  const source = (document.getElementById('mSource').value || '').trim();
  let url = (document.getElementById('mUrl').value || '').trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  closeSheet();
  await writeMealSlot(date, slot, (name || source || url) ? { name, source, url } : null);
}

async function clearMealSlot() {
  const { date, slot } = _mealEdit;
  closeSheet();
  await writeMealSlot(date, slot, null);
}

async function writeMealSlot(date, slot, value) {
  const plan = State.mealPlan;
  if (!plan) return;
  const slots = JSON.parse(JSON.stringify(plan.slots || {}));
  if (!slots[date]) slots[date] = {};
  if (value) slots[date][slot] = value; else delete slots[date][slot];
  if (Object.keys(slots[date]).length === 0) delete slots[date];
  setSync('syncing', 'Saving');
  const { error } = await State.client.from('week_plans').update({ slots, updated_at: new Date().toISOString() }).eq('id', plan.id);
  if (error) { toast('Save failed'); setSync('offline', 'Error'); return; }
  plan.slots = slots;
  if (State.weekPlan && State.weekPlan.id === plan.id) State.weekPlan.slots = slots;
  setSync('synced', 'Saved');
  toast(value ? 'Saved' : 'Cleared');
  renderMeals();
  if (document.getElementById('screen-today').classList.contains('active')) renderToday();
}

// Best-effort: read a recipe page's title via a CORS-friendly reader, fill the name.
async function fetchMealNameFromUrl() {
  let url = (document.getElementById('mUrl').value || '').trim();
  if (!url) { toast('Paste a link first'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  const btn = document.getElementById('mFetchBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    const res = await fetch('https://r.jina.ai/' + url, { headers: { 'Accept': 'text/plain' } });
    if (!res.ok) throw new Error('bad');
    const text = await res.text();
    let name = null;
    const tm = text.match(/^Title:\s*(.+)$/m);
    if (tm) name = tm[1].trim();
    if (!name) { const h = text.match(/^#\s+(.+)$/m); if (h) name = h[1].trim(); }
    if (name) {
      name = name.split(/\s+[|·–—]\s+/)[0].trim();
      const f = document.getElementById('mName');
      if (f && !f.value.trim()) f.value = name;
      toast('Name added — check it');
    } else {
      toast('Couldn’t read that — type the name');
    }
  } catch (e) {
    toast('Couldn’t read that link — type the name');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Get name from link'; }
  }
}

// ============================================================
// PROFILE
// ============================================================
function renderProfile() {
  const root = document.getElementById('profileContent');
  if (!root) return;
  let html = '';

  // ============== MEMBER CARD — single user, just you ==============
  [activeMember()].filter(Boolean).forEach(m => {
    const programLabel = m.current_program === 'c25k' ? `C25K · week ${m.current_program_week||1}` : null;
    html += `<div class="member-card" data-member-card="${m.slot}">
      <div class="mc-head">
        <div class="mc-name">${escapeHtml(m.display_name)}</div>
        <button class="card-action" onclick="openMemberEditor('${m.id}')">Edit</button>
      </div>
      <div class="mc-row"><span class="k">Life goal</span><span class="v">${m.life_goal_title ? escapeHtml(m.life_goal_title) + (m.life_goal_date ? ` · ${shortDate(m.life_goal_date)}` : '') : '—'}</span></div>
      <div class="mc-row"><span class="k">Weight goal</span><span class="v">${m.weight_goal_kg ? m.weight_goal_kg + ' kg' : '—'}</span></div>
      <div class="mc-row"><span class="k">Weekly sessions</span><span class="v">${m.weekly_session_target}${m.rest_days_per_week ? ` · ${m.rest_days_per_week} rest` : ''}</span></div>
      ${programLabel ? `<div class="mc-row"><span class="k">Program</span><span class="v">${programLabel}</span></div>` : ''}
    </div>`;
  });

  // ============== ACCOUNT — sign-in info ==============
  const me = activeMember();
  html += `<div class="card" style="margin-top:14px;">
    <div class="card-eyebrow"><span class="eyebrow">Account</span></div>
    <div class="mc-row" style="margin-top:8px;"><span class="k">Email</span><span class="v" style="font-size:12px;">${escapeHtml(State.user.email)}</span></div>
    <button class="btn ghost block" style="margin-top:10px;" onclick="signOut()">Sign out</button>
  </div>`;

  // ============== SETTINGS — collapsible ==============
  const s = State.settings || {};
  html += `<details class="card" style="margin-top:14px;">
    <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;">
      <span class="eyebrow">Settings</span>
      <span style="color:var(--ink-4);font-size:14px;">›</span>
    </summary>
    <div style="margin-top:14px;">
      <div class="mc-row"><span class="k">Theme</span>
        <select class="select" style="width:auto;padding:6px 28px 6px 10px;font-size:13px;" onchange="updateSetting('theme', this.value)">
          <option value="auto" ${s.theme==='auto'?'selected':''}>Auto</option>
          <option value="light" ${s.theme==='light'?'selected':''}>Light</option>
          <option value="dark" ${s.theme==='dark'?'selected':''}>Dark</option>
        </select>
      </div>
      <div class="mc-row"><span class="k">Week starts on</span>
        <select class="select" style="width:auto;padding:6px 28px 6px 10px;font-size:13px;" onchange="updateSetting('week_starts_on', parseInt(this.value,10))">
          <option value="1" ${s.week_starts_on===1?'selected':''}>Monday</option>
          <option value="0" ${s.week_starts_on===0?'selected':''}>Sunday</option>
        </select>
      </div>
      <div class="mc-row"><span class="k">Claude API key</span>
        <button class="card-action" onclick="editApiKey()">${s.claude_api_key ? '••• set' : 'Off'}</button>
      </div>
    </div>
  </details>`;

  // ============== ADVANCED — collapsible, rarely-touched ==============
  html += `<details class="card">
    <summary style="cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center;">
      <span class="eyebrow">Advanced</span>
      <span style="color:var(--ink-4);font-size:14px;">›</span>
    </summary>
    <div style="margin-top:14px;">
      <div>
        <button class="btn ghost block" onclick="exportAll()">Export everything</button>
        <button class="btn ghost block" style="margin-top:8px;" onclick="syncPeloton(true, true)">Full API re-sync</button>
        <div class="tiny" style="color:var(--ink-4);margin-top:6px;">Re-fetches metrics for every recent workout. Slow — only needed after a data fix.</div>
      </div>
    </div>
  </details>`;

  html += `<div class="tiny" style="text-align:center;padding:20px 0 0;">${APP_VERSION} · Add to your Home Screen for the best experience.</div>`;

  root.innerHTML = html;
  applyTheme();
}

function copyJoinCode(code) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(code).then(() => toast('Code copied')).catch(() => toast('Copy failed'));
  } else {
    toast(code);
  }
}

function applyTheme() {
  const t = State.settings?.theme || 'auto';
  if (t === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    // honour OS
    if (matchMedia('(prefers-color-scheme: dark)').matches) {
      document.documentElement.setAttribute('data-theme', 'dark');
    }
  } else {
    document.documentElement.setAttribute('data-theme', t);
  }
}

async function updateSetting(key, value) {
  State.settings[key] = value;
  await State.client.from('settings').update({ [key]: value, updated_at: new Date().toISOString() }).eq('household_id', State.householdId);
  applyTheme();
  renderAll();
}

function adjDinnerTarget(key, delta) {
  const el = document.getElementById(`dt_${key}`);
  if (!el) return;
  const newVal = Math.max(0, parseInt(el.textContent, 10) + delta);
  el.textContent = newVal;
  // Update the remainder counter for protein keys only
  if (key !== 'max_components') {
    const keys = ['red','white','fish','veg'];
    const total = keys.reduce((s, k) => {
      const e = document.getElementById(`dt_${k}`);
      return s + (e ? parseInt(e.textContent, 10) : 0);
    }, 0);
    const comp = document.getElementById('dt_complete');
    if (comp) comp.textContent = Math.max(0, 7 - total) + ' nights';
  }
}

async function saveDinnerTargets() {
  const keys = ['red','white','fish','veg'];
  const targets = {};
  keys.forEach(k => {
    const el = document.getElementById(`dt_${k}`);
    targets[k] = el ? Math.max(0, parseInt(el.textContent, 10)) : 0;
  });
  await updateSetting('dinner_targets', targets);
  toast('Saved');
}

function editApiKey() {
  const current = State.settings?.claude_api_key || '';
  const html = `
    <div class="tiny" style="margin-bottom:14px;">Optional. Used only for recipe calorie/protein estimation in the recipe editor. Get a key from <strong>console.anthropic.com</strong>. Stored in your household's Supabase row.</div>
    <div class="field">
      <label class="field-label">API key</label>
      <input class="input" id="akInput" type="password" placeholder="sk-ant-..." value="${escapeHtml(current)}">
    </div>
    <div class="btn-row">
      <button class="btn primary block" onclick="saveApiKey()">Save</button>
      ${current ? `<button class="btn danger block" onclick="clearApiKey()">Remove</button>` : ''}
    </div>
  `;
  openSheet('Claude API key', html);
}

async function saveApiKey() {
  const v = document.getElementById('akInput').value.trim();
  closeSheet();
  State.settings.claude_api_key = v || null;
  await State.client.from('settings').update({ claude_api_key: v || null, updated_at: new Date().toISOString() }).eq('household_id', State.householdId);
  renderProfile();
  toast(v ? 'Saved' : 'Removed');
}

async function clearApiKey() {
  document.getElementById('akInput').value = '';
  saveApiKey();
}

function openMemberEditor(memberId) {
  // HUB — navigation to focused sub-sheets
  const m = State.members.find(x => x.id === memberId);
  if (!m) return;
  const summary = (label, value) => `<div class="mc-row"><span class="k">${label}</span><span class="v">${value}</span></div>`;
  const mixBits = (() => {
    const mix = m.weekly_target_mix || {};
    const bits = Object.entries(mix).filter(([_,v]) => parseInt(v,10) > 0).map(([t,v]) => `${v} ${sessionTypeLabel(t).toLowerCase()}`);
    return bits.length ? bits.join(', ') : 'Not set';
  })();
  const goalLbl = (() => {
    return ({ lose_weight:'Lose weight', event:'Train for event', general:'General fitness', strength:'Build strength', maintain:'Maintain' })[m.goal_type || 'general'];
  })();
  const programLbl = m.current_program === 'c25k' ? `NHS C25K · week ${m.current_program_week||1}` : 'None';

  const html = `
    <div style="display:flex;flex-direction:column;gap:10px;">
      <button class="card tappable" onclick="openMemberEditorBasics('${memberId}')" style="text-align:left;background:var(--card);border:1px solid var(--line);">
        <div class="card-eyebrow"><span class="eyebrow">Basics</span></div>
        <div style="margin-top:6px;">
          ${summary('Name', escapeHtml(m.display_name))}
          ${summary('Life goal', escapeHtml(m.life_goal_title || '—'))}
          ${summary('Start / goal weight', `${m.weight_start_kg || '—'} / ${m.weight_goal_kg || '—'} kg`)}
        </div>
      </button>

      <button class="card tappable" onclick="openMemberEditorWeeklyPlan('${memberId}')" style="text-align:left;background:var(--card);border:1px solid var(--line);">
        <div class="card-eyebrow"><span class="eyebrow">Weekly plan</span></div>
        <div style="margin-top:6px;">
          ${summary('Session target', m.weekly_session_target || 4)}
          ${summary('Mix', escapeHtml(mixBits))}
          ${summary('Rest days', m.rest_days_per_week || 0)}
          ${summary('Min daily', m.min_daily_minutes ? m.min_daily_minutes + ' min' : 'Off')}
        </div>
      </button>

      <button class="card tappable" onclick="openMemberEditorWorkouts('${memberId}')" style="text-align:left;background:var(--card);border:1px solid var(--line);">
        <div class="card-eyebrow"><span class="eyebrow">Workouts</span></div>
        <div style="margin-top:6px;">
          ${summary('Training goal', goalLbl)}
          ${summary('Favourite instructor', escapeHtml(m.favourite_instructor || '—'))}
        </div>
      </button>

      <button class="card tappable" onclick="openMemberEditorIntegrations('${memberId}')" style="text-align:left;background:var(--card);border:1px solid var(--line);">
        <div class="card-eyebrow"><span class="eyebrow">Integrations</span></div>
        <div style="margin-top:6px;">
          ${summary('Program', programLbl)}
        </div>
      </button>
    </div>
  `;
  openSheet('Edit ' + escapeHtml(m.display_name), html);
}

// --- SUB-SHEET: BASICS ---
function openMemberEditorBasics(memberId) {
  const m = State.members.find(x => x.id === memberId);
  if (!m) return;
  const html = `
    <button class="btn ghost" style="margin-bottom:14px;padding:6px 10px;font-size:13px;" onclick="openMemberEditor('${memberId}')">← Back</button>
    <div class="field">
      <label class="field-label">Display name</label>
      <input class="input" id="mName" value="${escapeHtml(m.display_name)}">
    </div>
    <div class="field">
      <label class="field-label">Life goal</label>
      <input class="input" id="mGoal" placeholder="Venice 10k" value="${escapeHtml(m.life_goal_title || '')}">
    </div>
    <div class="field">
      <label class="field-label">Life goal date</label>
      <input class="input" id="mGoalDate" type="date" value="${m.life_goal_date || ''}">
    </div>
    <div class="field input-row">
      <div>
        <label class="field-label">Start weight (kg)</label>
        <input class="input" id="mStart" type="number" inputmode="decimal" step="0.1" value="${m.weight_start_kg || ''}">
      </div>
      <div>
        <label class="field-label">Goal weight (kg)</label>
        <input class="input" id="mGoalW" type="number" inputmode="decimal" step="0.1" value="${m.weight_goal_kg || ''}">
      </div>
    </div>
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="saveMemberBasics('${memberId}')">Save</button>
    </div>
  `;
  openSheet('Basics · ' + escapeHtml(m.display_name), html);
}

async function saveMemberBasics(id) {
  const payload = {
    display_name: document.getElementById('mName').value.trim() || 'Member',
    life_goal_title: document.getElementById('mGoal').value.trim() || null,
    life_goal_date: document.getElementById('mGoalDate').value || null,
    weight_start_kg: parseFloat(document.getElementById('mStart').value) || null,
    weight_goal_kg: parseFloat(document.getElementById('mGoalW').value) || null,
  };
  await saveMemberPayload(id, payload);
  openMemberEditor(id);
}

// --- SUB-SHEET: WEEKLY PLAN ---
function openMemberEditorWeeklyPlan(memberId) {
  const m = State.members.find(x => x.id === memberId);
  if (!m) return;
  const mix = m.weekly_target_mix || { ride:0, run:0, strength:0, yoga:0, walk:0, stretch:0 };
  const html = `
    <button class="btn ghost" style="margin-bottom:14px;padding:6px 10px;font-size:13px;" onclick="openMemberEditor('${memberId}')">← Back</button>
    <div class="field">
      <label class="field-label">Weekly sessions target</label>
      <div class="stepper">
        <button onclick="adjStep('mWk',-1)">−</button>
        <span class="v" id="mWk">${m.weekly_session_target || 4}</span>
        <button onclick="adjStep('mWk',1)">+</button>
      </div>
    </div>

    <div class="field">
      <label class="field-label">Rest days per week</label>
      <div class="stepper">
        <button onclick="adjStep('mRest',-1)">−</button>
        <span class="v" id="mRest">${m.rest_days_per_week || 0}</span>
        <button onclick="adjStep('mRest',1)">+</button>
      </div>
      <div class="tiny" style="margin-top:6px;color:var(--ink-3);">Plan my week reserves this many empty days as rest. Top-up never fires on rest days.</div>
    </div>

    <div class="field">
      <label class="field-label">Weekly mix (Plan my week target)</label>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        ${['ride','run','strength','yoga','walk','stretch'].map(t => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;">
            <span style="font-size:13px;">${sessionTypeLabel(t)}</span>
            <div class="stepper" style="border:none;">
              <button style="padding:4px 8px;" onclick="adjStep('mix_${t}',-1)">−</button>
              <span class="v" id="mix_${t}" style="min-width:24px;font-size:14px;">${parseInt(mix[t],10)||0}</span>
              <button style="padding:4px 8px;" onclick="adjStep('mix_${t}',1)">+</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label">Minimum daily minutes (optional)</label>
      <input class="input" id="mMinDaily" type="number" inputmode="numeric" min="0" max="180" step="5" value="${m.min_daily_minutes || ''}" placeholder="e.g. 60 (or leave blank)">
      <div class="tiny" style="margin-top:6px;color:var(--ink-3);">If set, Plan my week tops up days that have a session but fall short of this. Never fires on rest days.</div>
    </div>

    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="saveMemberWeeklyPlan('${memberId}')">Save</button>
    </div>
  `;
  openSheet('Weekly plan · ' + escapeHtml(m.display_name), html);
}

async function saveMemberWeeklyPlan(id) {
  const mix = {};
  ['ride','run','strength','yoga','walk','stretch'].forEach(t => {
    mix[t] = parseInt(document.getElementById('mix_' + t).textContent, 10) || 0;
  });
  const payload = {
    weekly_session_target: parseInt(document.getElementById('mWk').textContent, 10),
    rest_days_per_week: Math.min(7, Math.max(0, parseInt(document.getElementById('mRest').textContent, 10) || 0)),
    weekly_target_mix: mix,
    min_daily_minutes: parseInt(document.getElementById('mMinDaily').value, 10) || null,
  };
  await saveMemberPayload(id, payload);
  openMemberEditor(id);
}

// --- SUB-SHEET: WORKOUTS ---
function openMemberEditorWorkouts(memberId) {
  const m = State.members.find(x => x.id === memberId);
  if (!m) return;
  State._editInstructors = favouriteInstructors(m);  // working copy for the chips editor
  const goals = [
    { id:'lose_weight', label:'Lose weight' },
    { id:'event', label:'Train for event' },
    { id:'general', label:'General fitness' },
    { id:'strength', label:'Build strength' },
    { id:'maintain', label:'Maintain' },
  ];
  const currentGoal = m.goal_type || 'general';
  const prefs = m.session_duration_prefs || {};
  const def = { ride:{min:20,max:45}, run:{min:20,max:45}, strength:{min:15,max:30}, yoga:{min:20,max:45}, walk:{min:20,max:60}, stretch:{min:5,max:15} };

  const html = `
    <button class="btn ghost" style="margin-bottom:14px;padding:6px 10px;font-size:13px;" onclick="openMemberEditor('${memberId}')">← Back</button>

    <div class="field">
      <label class="field-label">Training goal</label>
      <div class="chip-group" id="mGoalType">
        ${goals.map(g => `<button class="chip ${g.id===currentGoal?'active':''}" data-g="${g.id}" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');">${g.label}</button>`).join('')}
      </div>
      <div class="tiny" style="margin-top:6px;color:var(--ink-3);">Tells Plan my week how to prioritise types.</div>
    </div>

    <div class="field">
      <label class="field-label">Session duration ranges (minutes)</label>
      <div class="tiny" style="margin-bottom:8px;color:var(--ink-3);">Plan my week picks a random duration in each range.</div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        ${['ride','run','strength','yoga','walk','stretch'].map(t => {
          const v = prefs[t] || def[t];
          return `<div style="display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:var(--radius-sm);padding:6px 10px;">
            <span style="font-size:13px;flex:1;">${sessionTypeLabel(t)}</span>
            <input class="input" id="durmin_${t}" type="number" inputmode="numeric" min="5" max="120" step="5" value="${v.min}" style="width:60px;padding:6px 8px;font-size:13px;text-align:center;">
            <span style="color:var(--ink-3);font-size:12px;">to</span>
            <input class="input" id="durmax_${t}" type="number" inputmode="numeric" min="5" max="180" step="5" value="${v.max}" style="width:60px;padding:6px 8px;font-size:13px;text-align:center;">
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="field">
      <label class="field-label">Favourite Peloton instructors</label>
      <div id="mInstructorChips" class="chip-list"></div>
      <div style="display:flex;gap:8px;margin-top:8px;">
        <input class="input" id="mInstructorInput" placeholder="Bradley Rose" style="flex:1;" onkeydown="if(event.key==='Enter'){event.preventDefault();addEditInstructor();}">
        <button class="btn" onclick="addEditInstructor()">Add</button>
      </div>
      <div class="tiny" style="color:var(--ink-4);margin-top:6px;">Their upcoming live classes show on the Plan → Instructor tab.</div>
    </div>

    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="saveMemberWorkouts('${memberId}')">Save</button>
    </div>
  `;
  openSheet('Workouts · ' + escapeHtml(m.display_name), html);
  renderInstructorChips();
}

function renderInstructorChips() {
  const host = document.getElementById('mInstructorChips');
  if (!host) return;
  const list = State._editInstructors || [];
  host.innerHTML = list.length
    ? list.map((n, i) => `<span class="chip removable">${escapeHtml(n)}<button type="button" aria-label="Remove" onclick="removeEditInstructor(${i})">×</button></span>`).join('')
    : `<span class="tiny" style="color:var(--ink-4);">None yet — add one below.</span>`;
}
function addEditInstructor() {
  const input = document.getElementById('mInstructorInput');
  if (!input) return;
  const name = input.value.trim();
  State._editInstructors = State._editInstructors || [];
  if (name && !State._editInstructors.some(x => foldName(x) === foldName(name))) State._editInstructors.push(name);
  input.value = '';
  input.focus();
  renderInstructorChips();
}
function removeEditInstructor(i) {
  if (!State._editInstructors) return;
  State._editInstructors.splice(i, 1);
  renderInstructorChips();
}

async function saveMemberWorkouts(id) {
  const durs = {};
  ['ride','run','strength','yoga','walk','stretch'].forEach(t => {
    const minVal = parseInt(document.getElementById('durmin_' + t).value, 10);
    const maxVal = parseInt(document.getElementById('durmax_' + t).value, 10);
    if (!isNaN(minVal) && !isNaN(maxVal)) {
      durs[t] = { min: Math.max(5, minVal), max: Math.max(Math.max(5, minVal), maxVal) };
    }
  });
  const payload = {
    goal_type: document.querySelector('#mGoalType .chip.active')?.dataset.g || 'general',
    session_duration_prefs: durs,
    favourite_instructor: (() => {
      const list = (State._editInstructors || []).slice();
      const pending = (document.getElementById('mInstructorInput')?.value || '').trim();  // catch un-added text
      if (pending && !list.some(x => foldName(x) === foldName(pending))) list.push(pending);
      return list.join(', ') || null;
    })(),
  };
  await saveMemberPayload(id, payload);
  // schedule cache is keyed on the favourites — drop it so the tab refetches
  State.instructorSchedule = null;
  openMemberEditor(id);
}

// --- SUB-SHEET: INTEGRATIONS ---
function openMemberEditorIntegrations(memberId) {
  const m = State.members.find(x => x.id === memberId);
  if (!m) return;
  const html = `
    <button class="btn ghost" style="margin-bottom:14px;padding:6px 10px;font-size:13px;" onclick="openMemberEditor('${memberId}')">← Back</button>

    <div class="field">
      <label class="field-label">Training program</label>
      <div class="chip-group" id="mProgram">
        <button class="chip ${!(m.current_program)?'active':''}" data-p="" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');document.getElementById('mProgramWeekWrap').style.display='none';">None</button>
        <button class="chip ${m.current_program==='c25k'?'active':''}" data-p="c25k" onclick="this.parentNode.querySelectorAll('.chip').forEach(x=>x.classList.remove('active'));this.classList.add('active');document.getElementById('mProgramWeekWrap').style.display='block';">NHS Couch to 5K</button>
      </div>
      <div id="mProgramWeekWrap" style="margin-top:10px;display:${m.current_program==='c25k'?'block':'none'};">
        <div style="display:flex;gap:14px;align-items:center;">
          <div>
            <div class="field-label" style="margin-bottom:4px;">Week</div>
            <div class="stepper">
              <button onclick="adjStep('mProgWk',-1)">−</button>
              <span class="v" id="mProgWk">${m.current_program_week || 1}</span>
              <button onclick="adjStep('mProgWk',1)">+</button>
            </div>
          </div>
          <div>
            <div class="field-label" style="margin-bottom:4px;">Runs done this week</div>
            <div class="stepper">
              <button onclick="adjStep('mProgRuns',-1)">−</button>
              <span class="v" id="mProgRuns">${m.program_runs_this_week || 0}</span>
              <button onclick="adjStep('mProgRuns',1)">+</button>
            </div>
          </div>
        </div>
        <div class="tiny" style="margin-top:8px;color:var(--ink-3);line-height:1.5;">Auto-advances when the 3rd run of the week is marked done. The NHS C25K app provides the audio coaching — Household just tracks where you are.</div>
      </div>
    </div>

    <div class="btn-row" style="margin-top:18px;">
      <button class="btn primary block" onclick="saveMemberIntegrations('${memberId}')">Save</button>
    </div>
  `;
  openSheet('Integrations · ' + escapeHtml(m.display_name), html);
}

async function saveMemberIntegrations(id) {
  const progChip = document.querySelector('#mProgram .chip.active');
  const progId = progChip?.dataset.p || '';
  const progWeek = parseInt(document.getElementById('mProgWk')?.textContent, 10);
  const progRuns = parseInt(document.getElementById('mProgRuns')?.textContent, 10);
  const payload = {
    current_program: progId || null,
    current_program_week: progId === 'c25k' ? Math.min(Math.max(progWeek || 1, 1), 9) : null,
    program_runs_this_week: progId === 'c25k' ? Math.min(Math.max(progRuns || 0, 0), 3) : null,
  };
  await saveMemberPayload(id, payload);
  openMemberEditor(id);
}

// --- SHARED: COMMIT A PARTIAL PAYLOAD ---
async function saveMemberPayload(id, payload) {
  setSync('syncing', 'Saving');
  const { error } = await State.client.from('members').update(payload).eq('id', id);
  if (error) { toast('Save failed'); setSync('offline','Error'); return; }
  const idx = State.members.findIndex(m => m.id === id);
  if (idx >= 0) State.members[idx] = { ...State.members[idx], ...payload };
  setSync('synced', 'Saved');
  toast('Saved');
  renderAll();
}

// Back-compat shim — anywhere old saveMember was wired up
async function saveMember(id) {
  // Used by legacy code that's been refactored; route to hub
  openMemberEditor(id);
}

async function exportAll() {
  const exp = {
    exported_at: new Date().toISOString(),
    household_id: State.householdId,
    members: State.members,
    settings: { ...State.settings, claude_api_key: undefined },
    recipes: State.recipes,
    ingredients: State.ingredients,
    week_plans: [State.weekPlan],
    workouts: State.workouts,
    weight_entries: State.weights,
    shopping_items: State.shoppingItems,
  };
  const blob = new Blob([JSON.stringify(exp, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `household-export-${todayISO()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Downloaded');
}

// ============================================================
// BOOT
// ============================================================
async function boot() {
  // 1. Config (Supabase URL/key)
  const cfg = getConfig();
  if (!cfg) {
    document.getElementById('configGate').classList.remove('hide');
    return;
  }

  // 2. Init Supabase client
  try {
    State.client = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  } catch (e) {
    document.getElementById('configGate').classList.remove('hide');
    document.getElementById('cfgError').textContent = 'Could not initialise. Check your URL and key.';
    document.getElementById('cfgError').classList.remove('hide');
    return;
  }

  // 3. Listen for auth changes
  State.client.auth.onAuthStateChange((event, session) => {
    if (session?.user) {
      State.user = session.user;
      document.getElementById('authGate').classList.add('hide');
      document.getElementById('app').classList.remove('hide');
      loadAll();
    } else {
      State.user = null;
      document.getElementById('app').classList.add('hide');
      document.getElementById('authGate').classList.remove('hide');
    }
  });

  // 4. Check existing session
  const { data: { session } } = await State.client.auth.getSession();
  if (session?.user) {
    State.user = session.user;
    document.getElementById('app').classList.remove('hide');
    loadAll();
  } else {
    document.getElementById('authGate').classList.remove('hide');
  }
}

boot();

// Honour OS theme changes
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

// Quiet calendar resync when the app regains focus
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && State.householdId) autoSyncIfDue();
});
