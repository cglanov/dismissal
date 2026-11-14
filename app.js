/**
 * School Dismissal Management System (SDMS) — Frontend Application
 * Hosted on GitHub Pages; communicates with Google Apps Script Web App (Code.gs).
 */

const CONFIG = {
  // Replace with your deployed Google Apps Script Web App URL:
  API_URL: 'https://script.google.com/macros/s/AKfycbwuhV1WDETx0R8-MMFaBiXjEkdDCq_jsGH49ALedQuhP6ALcibfC4i9-g6hCMHdCcWu/exec',
  STAFF_PIN: '2013',
  POLL_INTERVAL_MS: 3500, // 3.5s polling (<50 concurrent clients hit GAS 3s cache)
  UNDO_DURATION_MS: 5000, // 5-second UNDO toast banner
  DEFAULT_ALERT_THRESHOLD_SECONDS: 600, // 10 minutes
  INITIAL_BUS_SLOTS: 12,
  STORAGE_AUTH_KEY: 'sdms_auth_expires_at',
  STORAGE_LAYOUT_KEY: 'sdms_layout_override'
};

const STATE = {
  authenticated: false,
  pinBuffer: '',
  layoutMode: 'desktop', // 'desktop' | 'mobile'
  currentScreen: 'start', // 'start' | 'buses' | 'valet-entry' | 'pickup-entry' | 'valet-checkout' | 'pickup-checkout'
  checkoutSubTab: 'primary', // 'primary' | 'left' | 'other'
  alertThresholdSeconds: CONFIG.DEFAULT_ALERT_THRESHOLD_SECONDS,
  students: [],
  activeBuses: [],
  mruBuses: [],
  busInputSlots: Array(CONFIG.INITIAL_BUS_SLOTS).fill(''),
  busSlotsDirty: false,
  selectedWaitingIds: new Set(),
  selectedCheckoutIds: new Set(),
  searchQueryWaiting: '',
  searchQueryCheckout: '',
  activeModalStudentRow: null,
  undoPayload: null,
  undoTimerId: null,
  retryQueue: [],
  inFlightMutations: 0,
  isDemoMode: false
};

/* ==========================================================================
   INITIALIZATION & SESSION AUTHENTICATION
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  initLayoutMode();
  bindPinEvents();
  bindNavigationEvents();
  bindBusEvents();
  bindNameEntryEvents();
  bindCheckoutEvents();
  bindModalEvents();
  bindUndoEvents();

  if (checkSavedAuthSession()) {
    unlockApp();
  }

  // Live 1-second timer for 10-minute color gradient & modal elapsed counter
  setInterval(tickLiveTimers, 1000);
});

/**
 * Computes the timestamp of the next 1:00 AM local school time.
 */
function getNext1AMTimestamp() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 0, 0, 0);
  if (now >= next) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function checkSavedAuthSession() {
  try {
    const expiresAt = Number(localStorage.getItem(CONFIG.STORAGE_AUTH_KEY) || 0);
    return expiresAt > Date.now();
  } catch (e) {
    return false;
  }
}

function saveAuthSession() {
  try {
    localStorage.setItem(CONFIG.STORAGE_AUTH_KEY, String(getNext1AMTimestamp()));
  } catch (e) {
    // Ignore storage quota errors
  }
}

function lockStation() {
  try {
    localStorage.removeItem(CONFIG.STORAGE_AUTH_KEY);
  } catch (e) {}
  STATE.authenticated = false;
  STATE.pinBuffer = '';
  updatePinDots();
  document.getElementById('pin-error').textContent = '';
  document.getElementById('app-shell').classList.add('hidden');
  document.getElementById('pin-screen').classList.remove('hidden');
}

function bindPinEvents() {
  document.querySelectorAll('.pin-key[data-digit]').forEach((btn) => {
    btn.addEventListener('click', () => handlePinDigit(btn.dataset.digit));
  });

  document.getElementById('pin-clear').addEventListener('click', () => {
    STATE.pinBuffer = '';
    document.getElementById('pin-error').textContent = '';
    updatePinDots();
  });

  document.getElementById('pin-backspace').addEventListener('click', () => {
    STATE.pinBuffer = STATE.pinBuffer.slice(0, -1);
    document.getElementById('pin-error').textContent = '';
    updatePinDots();
  });

  document.addEventListener('keydown', (e) => {
    if (STATE.authenticated) return;
    if (/^[0-9]$/.test(e.key)) {
      e.preventDefault();
      handlePinDigit(e.key);
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      STATE.pinBuffer = STATE.pinBuffer.slice(0, -1);
      updatePinDots();
    } else if (e.key === 'Escape') {
      STATE.pinBuffer = '';
      updatePinDots();
    }
  });
}

function handlePinDigit(digit) {
  if (STATE.pinBuffer.length >= 4) return;
  STATE.pinBuffer += digit;
  document.getElementById('pin-error').textContent = '';
  updatePinDots();

  if (STATE.pinBuffer.length === 4) {
    if (STATE.pinBuffer === CONFIG.STAFF_PIN) {
      saveAuthSession();
      unlockApp();
    } else {
      const card = document.getElementById('pin-card');
      card.classList.remove('shake');
      void card.offsetWidth; // Force reflow to restart animation
      card.classList.add('shake');
      document.getElementById('pin-error').textContent = 'Incorrect PIN. Please try again.';
      STATE.pinBuffer = '';
      setTimeout(updatePinDots, 150);
    }
  }
}

function updatePinDots() {
  const dots = document.querySelectorAll('#pin-dots .pin-dot');
  dots.forEach((dot, idx) => {
    dot.classList.toggle('filled', idx < STATE.pinBuffer.length);
  });
}

function unlockApp() {
  STATE.authenticated = true;
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');

  if (!CONFIG.API_URL || CONFIG.API_URL === 'YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL') {
    STATE.isDemoMode = true;
    document.getElementById('demo-banner').classList.remove('hidden');
    loadDemoData();
    renderAll();
  } else {
    fetchLatestState();
  }

  // Start background polling loop
  setInterval(() => {
    if (!STATE.authenticated || STATE.isDemoMode) return;
    flushRetryQueue();
    fetchLatestState();
  }, CONFIG.POLL_INTERVAL_MS);
}

/* ==========================================================================
   DUAL-MODE RESPONSIVE LAYOUT ENGINE (DESKTOP HORIZONTAL VS MOBILE VERTICAL)
   ========================================================================== */
function initLayoutMode() {
  const savedOverride = sessionStorage.getItem(CONFIG.STORAGE_LAYOUT_KEY);
  if (savedOverride === 'desktop' || savedOverride === 'mobile') {
    setLayoutMode(savedOverride, false);
  } else {
    const autoMode = window.innerWidth >= 900 ? 'desktop' : 'mobile';
    setLayoutMode(autoMode, false);
  }

  document.getElementById('btn-layout-toggle').addEventListener('click', () => {
    const next = STATE.layoutMode === 'desktop' ? 'mobile' : 'desktop';
    setLayoutMode(next, true);
  });
}

function setLayoutMode(mode, persistOverride) {
  STATE.layoutMode = mode;
  document.body.setAttribute('data-layout', mode);
  if (persistOverride) {
    sessionStorage.setItem(CONFIG.STORAGE_LAYOUT_KEY, mode);
  }
  const btn = document.getElementById('btn-layout-toggle');
  btn.textContent = mode === 'desktop' ? 'Desktop Mode ⇄' : 'Mobile Mode ⇄';
}

/* ==========================================================================
   NAVIGATION & SCREEN ROUTING
   ========================================================================== */
function bindNavigationEvents() {
  document.getElementById('btn-back-start').addEventListener('click', () => {
    navigateTo('start');
  });

  document.getElementById('btn-lock').addEventListener('click', lockStation);

  document.querySelectorAll('.station-card[data-nav]').forEach((card) => {
    card.addEventListener('click', () => navigateTo(card.dataset.nav));
  });
}

function navigateTo(screenId) {
  STATE.currentScreen = screenId;
  STATE.selectedWaitingIds.clear();
  STATE.selectedCheckoutIds.clear();
  STATE.searchQueryWaiting = '';
  STATE.searchQueryCheckout = '';
  STATE.checkoutSubTab = 'primary';

  document.getElementById('ne-search-input').value = '';
  document.getElementById('ne-search-clear').classList.add('hidden');
  document.getElementById('co-search-input').value = '';
  document.getElementById('co-search-clear').classList.add('hidden');

  // Hide all screens
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));

  const backBtn = document.getElementById('btn-back-start');
  const titleEl = document.getElementById('header-title');

  if (screenId === 'start') {
    backBtn.classList.add('hidden');
    titleEl.textContent = 'DISMISSAL';
    document.getElementById('screen-start').classList.remove('hidden');
  } else if (screenId === 'buses') {
    backBtn.classList.remove('hidden');
    titleEl.textContent = 'Call Buses';
    STATE.busSlotsDirty = false;
    syncBusSlotsFromState();
    document.getElementById('screen-buses').classList.remove('hidden');
  } else if (screenId === 'valet-entry') {
    backBtn.classList.remove('hidden');
    titleEl.textContent = 'Valet - Name Entry';
    document.getElementById('ne-active-title').textContent = 'Needed at Valet';
    document.getElementById('screen-name-entry').classList.remove('hidden');
  } else if (screenId === 'pickup-entry') {
    backBtn.classList.remove('hidden');
    titleEl.textContent = 'Pickup Door - Name Entry';
    document.getElementById('ne-active-title').textContent = 'Needed at Pick Up Door';
    document.getElementById('screen-name-entry').classList.remove('hidden');
  } else if (screenId === 'valet-checkout') {
    backBtn.classList.remove('hidden');
    titleEl.textContent = 'Needed at Valet - Checkout';
    document.getElementById('screen-checkout').classList.remove('hidden');
  } else if (screenId === 'pickup-checkout') {
    backBtn.classList.remove('hidden');
    titleEl.textContent = 'Needed at Pickup Door - Checkout';
    document.getElementById('screen-checkout').classList.remove('hidden');
  }

  renderAll();
}

/* ==========================================================================
   BACKEND API SYNC, OPTIMISTIC UPDATES & RETRY QUEUE
   ========================================================================== */
async function fetchLatestState() {
  if (STATE.inFlightMutations > 0 || STATE.retryQueue.length > 0) {
    return;
  }

  try {
    const url = `${CONFIG.API_URL}?pin=${encodeURIComponent(CONFIG.STAFF_PIN)}&action=state&t=${Date.now()}`;
    const res = await fetch(url, { method: 'GET' });
    const json = await res.json();

    if (json && json.ok && json.data) {
      applyServerState(json.data);
      updateSyncBadge(true);
    } else {
      updateSyncBadge(false);
    }
  } catch (err) {
    updateSyncBadge(false);
  }
}

function applyServerState(data) {
  STATE.students = Array.isArray(data.students) ? data.students : [];
  STATE.activeBuses = Array.isArray(data.activeBuses) ? data.activeBuses : [];
  STATE.mruBuses = Array.isArray(data.mruBuses) ? data.mruBuses : [];
  if (data.alertThresholdSeconds) {
    STATE.alertThresholdSeconds = Number(data.alertThresholdSeconds);
  }

  if (!STATE.busSlotsDirty) {
    syncBusSlotsFromState();
  }

  renderAll();
}

function updateSyncBadge(isHealthy) {
  const badge = document.getElementById('sync-badge');
  if (STATE.isDemoMode) {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = 'Demo Mode';
    return;
  }

  if (STATE.retryQueue.length > 0) {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = `Reconnecting — Queued (${STATE.retryQueue.length})`;
  } else if (isHealthy) {
    badge.className = 'sync-badge sync-live';
    badge.textContent = 'Live • Synced';
  } else {
    badge.className = 'sync-badge sync-warn';
    badge.textContent = 'Syncing...';
  }
}

async function sendMutation(payload) {
  if (STATE.isDemoMode) {
    return;
  }

  const fullPayload = Object.assign({ pin: CONFIG.STAFF_PIN }, payload);
  STATE.inFlightMutations++;

  try {
    const res = await fetch(CONFIG.API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload)
    });
    const json = await res.json();
    STATE.inFlightMutations = Math.max(0, STATE.inFlightMutations - 1);

    if (json && json.ok && json.data) {
      if (STATE.inFlightMutations === 0 && STATE.retryQueue.length === 0) {
        applyServerState(json.data);
      }
      updateSyncBadge(true);
    } else {
      throw new Error((json && json.error) || 'Write failed');
    }
  } catch (err) {
    STATE.inFlightMutations = Math.max(0, STATE.inFlightMutations - 1);
    STATE.retryQueue.push(fullPayload);
    updateSyncBadge(false);
  }
}

async function flushRetryQueue() {
  if (STATE.retryQueue.length === 0 || STATE.inFlightMutations > 0) return;

  const nextPayload = STATE.retryQueue.shift();
  updateSyncBadge(false);
  await sendMutation(nextPayload);
}

/* ==========================================================================
   SCREEN 2: CALL BUSES LOGIC
   ========================================================================== */
function syncBusSlotsFromState() {
  const count = Math.max(CONFIG.INITIAL_BUS_SLOTS, STATE.activeBuses.length + 2);
  const slots = Array(count).fill('');
  STATE.activeBuses.forEach((bus, idx) => {
    slots[idx] = bus;
  });
  STATE.busInputSlots = slots;
}

function bindBusEvents() {
  document.getElementById('btn-add-bus-slot').addEventListener('click', () => {
    STATE.busSlotsDirty = true;
    STATE.busInputSlots.push('');
    renderBusesScreen();
  });

  document.getElementById('btn-clear-all-buses').addEventListener('click', () => {
    STATE.busSlotsDirty = false;
    STATE.busInputSlots = Array(CONFIG.INITIAL_BUS_SLOTS).fill('');
    commitBusSlots();
  });

  document.getElementById('btn-save-buses').addEventListener('click', () => {
    STATE.busSlotsDirty = false;
    commitBusSlots();
  });
}

function commitBusSlots() {
  const cleaned = STATE.busInputSlots.map((s) => s.trim()).filter(Boolean);
  STATE.activeBuses = cleaned;

  // Optimistically prepend & deduplicate into 30 MRU list
  const nextMru = [];
  cleaned.forEach((b) => {
    if (!nextMru.includes(b)) nextMru.push(b);
  });
  STATE.mruBuses.forEach((b) => {
    if (nextMru.length < 30 && !nextMru.includes(b)) nextMru.push(b);
  });
  STATE.mruBuses = nextMru.slice(0, 30);

  syncBusSlotsFromState();
  renderAll();
  sendMutation({ action: 'saveBuses', activeBuses: cleaned });
}

function renderBusesScreen() {
  const slotsContainer = document.getElementById('bus-slots-container');
  slotsContainer.innerHTML = '';

  STATE.busInputSlots.forEach((val, idx) => {
    const row = document.createElement('div');
    row.className = 'bus-slot-row';

    const num = document.createElement('span');
    num.className = 'bus-slot-num';
    num.textContent = `${idx + 1}.`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'bus-slot-input';
    input.value = val;
    input.placeholder = 'Enter bus # or note (e.g., 74-GYM)...';

    input.addEventListener('input', (e) => {
      STATE.busSlotsDirty = true;
      STATE.busInputSlots[idx] = e.target.value;
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        STATE.busSlotsDirty = false;
        commitBusSlots();
      }
    });

    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn-slot-clear';
    clearBtn.textContent = '×';
    clearBtn.title = 'Remove this bus';
    clearBtn.addEventListener('click', () => {
      STATE.busInputSlots.splice(idx, 1);
      STATE.busInputSlots.push('');
      STATE.busSlotsDirty = false;
      commitBusSlots();
    });

    row.append(num, input, clearBtn);
    slotsContainer.appendChild(row);
  });

  // Render Recent Buses/Transportation Checklist (Column B)
  const mruContainer = document.getElementById('bus-mru-list');
  mruContainer.innerHTML = '';

  if (STATE.mruBuses.length === 0) {
    mruContainer.innerHTML = '<div class="empty-state">No recent buses yet. Type a bus above and save to build your recent list.</div>';
    return;
  }

  const activeSet = new Set(STATE.busInputSlots.map((s) => s.trim()).filter(Boolean));

  STATE.mruBuses.forEach((busStr) => {
    const isChecked = activeSet.has(busStr);
    const label = document.createElement('label');
    label.className = `mru-item ${isChecked ? 'checked' : ''}`;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = isChecked;

    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        const emptyIdx = STATE.busInputSlots.findIndex((s) => s.trim() === '');
        if (emptyIdx !== -1) {
          STATE.busInputSlots[emptyIdx] = busStr;
        } else {
          STATE.busInputSlots.push(busStr);
        }
      } else {
        STATE.busInputSlots = STATE.busInputSlots.filter((s) => s.trim() !== busStr);
        while (STATE.busInputSlots.length < CONFIG.INITIAL_BUS_SLOTS) {
          STATE.busInputSlots.push('');
        }
      }
      STATE.busSlotsDirty = false;
      commitBusSlots();
    });

    const textSpan = document.createElement('span');
    textSpan.className = 'mru-label';
    textSpan.textContent = busStr;

    label.append(checkbox, textSpan);
    mruContainer.appendChild(label);
  });
}

/* ==========================================================================
   SCREENS 3 & 4: NAME ENTRY (VALET & PICKUP DOOR)
   ========================================================================== */
function bindNameEntryEvents() {
  const searchInput = document.getElementById('ne-search-input');
  const clearBtn = document.getElementById('ne-search-clear');
  const submitBtn = document.getElementById('ne-submit-btn');

  searchInput.addEventListener('input', (e) => {
    STATE.searchQueryWaiting = e.target.value;
    clearBtn.classList.toggle('hidden', !STATE.searchQueryWaiting);
    renderNameEntryScreen();
  });

  clearBtn.addEventListener('click', () => {
    STATE.searchQueryWaiting = '';
    searchInput.value = '';
    clearBtn.classList.add('hidden');
    searchInput.focus();
    renderNameEntryScreen();
  });

  submitBtn.addEventListener('click', () => {
    if (STATE.selectedWaitingIds.size === 0) return;

    const targetStatus = STATE.currentScreen === 'valet-entry'
      ? 'Needed at Valet'
      : 'Needed at Pick Up Door';

    const nowIso = getLocalIsoTimestamp();
    const updates = [];

    STATE.students.forEach((st) => {
      if (STATE.selectedWaitingIds.has(st.rowIndex)) {
        st.status = targetStatus;
        st.time = nowIso;
        updates.push({ rowIndex: st.rowIndex, status: targetStatus, time: nowIso });
      }
    });

    STATE.selectedWaitingIds.clear();
    STATE.searchQueryWaiting = '';
    searchInput.value = '';
    clearBtn.classList.add('hidden');

    renderAll();
    sendMutation({ action: 'updateStudents', updates });
  });
}

function renderNameEntryScreen() {
  const targetStatus = STATE.currentScreen === 'valet-entry'
    ? 'Needed at Valet'
    : 'Needed at Pick Up Door';

  // Zone A: Waiting Students ('waiting'), sorted A->Z by last then first
  const query = STATE.searchQueryWaiting.trim().toLowerCase();
  const waitingStudents = STATE.students
    .filter((st) => st.status === 'waiting')
    .filter((st) => {
      if (!query) return true;
      return (
        st.first.toLowerCase().includes(query) ||
        st.last.toLowerCase().includes(query)
      );
    })
    .sort(compareStudentsByLastThenFirst);

  document.getElementById('ne-waiting-count').textContent = waitingStudents.length;
  document.getElementById('ne-selected-count').textContent = STATE.selectedWaitingIds.size;
  document.getElementById('ne-submit-btn').disabled = STATE.selectedWaitingIds.size === 0;

  const waitingGrid = document.getElementById('ne-waiting-grid');
  waitingGrid.innerHTML = '';

  if (waitingStudents.length === 0) {
    waitingGrid.innerHTML = '<div class="empty-state">No waiting students match your search.</div>';
  } else {
    waitingStudents.forEach((st) => {
      const isSelected = STATE.selectedWaitingIds.has(st.rowIndex);
      const btn = createStudentButtonElement(st, {
        extraClass: isSelected ? 'selected' : ''
      });

      btn.addEventListener('click', () => {
        if (STATE.selectedWaitingIds.has(st.rowIndex)) {
          STATE.selectedWaitingIds.delete(st.rowIndex);
        } else {
          STATE.selectedWaitingIds.add(st.rowIndex);
        }
        renderNameEntryScreen();
      });

      waitingGrid.appendChild(btn);
    });
  }

  // Zone B: Active Queue Monitor (10-minute color gradient only; no timer counter on buttons)
  const activeStudents = STATE.students
    .filter((st) => st.status === targetStatus)
    .sort(compareStudentsByLastThenFirst);

  document.getElementById('ne-active-count').textContent = activeStudents.length;

  const activeGrid = document.getElementById('ne-active-grid');
  activeGrid.innerHTML = '';

  if (activeStudents.length === 0) {
    activeGrid.innerHTML = `<div class="empty-state">No students currently in "${targetStatus}".</div>`;
  } else {
    activeStudents.forEach((st) => {
      const btn = createStudentButtonElement(st, {
        extraClass: 'active-gradient-btn'
      });
      btn.dataset.rowIndex = st.rowIndex;
      applyGradientStyleToButton(btn, st.time);

      btn.addEventListener('click', () => openStudentDetailModal(st.rowIndex));
      activeGrid.appendChild(btn);
    });
  }
}

/* ==========================================================================
   SCREENS 5 & 6: CHECKOUT SCREENS (VALET & PICKUP DOOR)
   ========================================================================== */
function bindCheckoutEvents() {
  document.getElementById('co-tab-primary').addEventListener('click', () => {
    STATE.checkoutSubTab = 'primary';
    STATE.selectedCheckoutIds.clear();
    renderCheckoutScreen();
  });

  document.getElementById('co-tab-left').addEventListener('click', () => {
    STATE.checkoutSubTab = 'left';
    STATE.selectedCheckoutIds.clear();
    renderCheckoutScreen();
  });

  document.getElementById('co-tab-other').addEventListener('click', () => {
    STATE.checkoutSubTab = 'other';
    STATE.selectedCheckoutIds.clear();
    renderCheckoutScreen();
  });

  const coSearch = document.getElementById('co-search-input');
  const coClear = document.getElementById('co-search-clear');

  coSearch.addEventListener('input', (e) => {
    STATE.searchQueryCheckout = e.target.value;
    coClear.classList.toggle('hidden', !STATE.searchQueryCheckout);
    renderCheckoutScreen();
  });

  coClear.addEventListener('click', () => {
    STATE.searchQueryCheckout = '';
    coSearch.value = '';
    coClear.classList.add('hidden');
    coSearch.focus();
    renderCheckoutScreen();
  });

  // 'Mark as Gone' Batch Action — Immediate write with NO confirmation prompt + 5s UNDO
  document.getElementById('btn-mark-gone').addEventListener('click', () => {
    if (STATE.selectedCheckoutIds.size === 0) return;

    const nowIso = getLocalIsoTimestamp();
    const undoRecords = [];
    const updates = [];

    STATE.students.forEach((st) => {
      if (STATE.selectedCheckoutIds.has(st.rowIndex)) {
        undoRecords.push({
          rowIndex: st.rowIndex,
          priorStatus: st.status,
          priorTime: st.time
        });
        st.status = 'Left the Building';
        st.time = nowIso;
        updates.push({ rowIndex: st.rowIndex, status: 'Left the Building', time: nowIso });
      }
    });

    STATE.selectedCheckoutIds.clear();
    renderAll();
    sendMutation({ action: 'updateStudents', updates });
    showUndoBanner(undoRecords);
  });

  // Restore Selected Students from 'Left the Building' Recall View
  document.getElementById('btn-restore-selected').addEventListener('click', () => {
    if (STATE.selectedCheckoutIds.size === 0) return;

    const restoreStatus = STATE.currentScreen === 'valet-checkout'
      ? 'Needed at Valet'
      : 'Needed at Pick Up Door';
    const nowIso = getLocalIsoTimestamp();
    const updates = [];

    STATE.students.forEach((st) => {
      if (STATE.selectedCheckoutIds.has(st.rowIndex)) {
        st.status = restoreStatus;
        st.time = nowIso;
        updates.push({ rowIndex: st.rowIndex, status: restoreStatus, time: nowIso });
      }
    });

    STATE.selectedCheckoutIds.clear();
    renderAll();
    sendMutation({ action: 'updateStudents', updates });
  });
}

function renderCheckoutScreen() {
  const isValet = STATE.currentScreen === 'valet-checkout';
  const primaryStatus = isValet ? 'Needed at Valet' : 'Needed at Pick Up Door';
  const otherStatus = isValet ? 'Needed at Pick Up Door' : 'Needed at Valet';

  const primaryList = STATE.students.filter((s) => s.status === primaryStatus);
  const leftList = STATE.students.filter((s) => s.status === 'Left the Building');
  const otherList = STATE.students.filter((s) => s.status === otherStatus);

  // Update Sub-Navigation Tab Labels & Active States (without 'Read-Only' text on tab button)
  const tabPrimary = document.getElementById('co-tab-primary');
  const tabLeft = document.getElementById('co-tab-left');
  const tabOther = document.getElementById('co-tab-other');

  tabPrimary.textContent = `${primaryStatus} (${primaryList.length})`;
  tabLeft.textContent = `Left the Building (${leftList.length})`;
  tabOther.textContent = `${otherStatus} (${otherList.length})`;

  tabPrimary.classList.toggle('active', STATE.checkoutSubTab === 'primary');
  tabLeft.classList.toggle('active', STATE.checkoutSubTab === 'left');
  tabOther.classList.toggle('active', STATE.checkoutSubTab === 'other');

  const isReadOnly = STATE.checkoutSubTab === 'other';
  document.getElementById('co-readonly-banner').classList.toggle('hidden', !isReadOnly);
  document.getElementById('co-action-bar').classList.toggle('hidden', isReadOnly);

  const btnMarkGone = document.getElementById('btn-mark-gone');
  const btnRestore = document.getElementById('btn-restore-selected');

  if (STATE.checkoutSubTab === 'primary') {
    btnMarkGone.classList.remove('hidden');
    btnRestore.classList.add('hidden');
    btnMarkGone.disabled = STATE.selectedCheckoutIds.size === 0;
    btnMarkGone.textContent = `Mark as Gone (${STATE.selectedCheckoutIds.size} Selected)`;
  } else if (STATE.checkoutSubTab === 'left') {
    btnMarkGone.classList.add('hidden');
    btnRestore.classList.remove('hidden');
    btnRestore.disabled = STATE.selectedCheckoutIds.size === 0;
    btnRestore.textContent = `Restore to ${primaryStatus} (${STATE.selectedCheckoutIds.size} Selected)`;
  }

  // Filter & sort current sub-view list A->Z by Last Name
  let sourceList = primaryList;
  if (STATE.checkoutSubTab === 'left') sourceList = leftList;
  if (STATE.checkoutSubTab === 'other') sourceList = otherList;

  const query = STATE.searchQueryCheckout.trim().toLowerCase();
  const filteredList = sourceList
    .filter((st) => {
      if (!query) return true;
      return st.first.toLowerCase().includes(query) || st.last.toLowerCase().includes(query);
    })
    .sort(compareStudentsByLastThenFirst);

  const grid = document.getElementById('co-grid');
  grid.innerHTML = '';

  if (filteredList.length === 0) {
    grid.innerHTML = '<div class="empty-state">No students in this view.</div>';
    return;
  }

  filteredList.forEach((st) => {
    const isSelected = STATE.selectedCheckoutIds.has(st.rowIndex);
    let extraClass = 'co-primary';
    if (STATE.checkoutSubTab === 'left') extraClass = 'co-left';
    if (isReadOnly) extraClass = 'readonly-card';
    if (!isReadOnly && isSelected) extraClass += ' selected';

    const btn = createStudentButtonElement(st, {
      extraClass,
      isReadOnly
    });

    if (!isReadOnly) {
      btn.addEventListener('click', () => {
        if (STATE.selectedCheckoutIds.has(st.rowIndex)) {
          STATE.selectedCheckoutIds.delete(st.rowIndex);
        } else {
          STATE.selectedCheckoutIds.add(st.rowIndex);
        }
        renderCheckoutScreen();
      });
    }

    grid.appendChild(btn);
  });
}

/* ==========================================================================
   STUDENT DETAIL MODAL POPUP (ZONE B)
   ========================================================================== */
function bindModalEvents() {
  document.getElementById('modal-btn-close').addEventListener('click', closeStudentDetailModal);

  document.getElementById('student-modal').addEventListener('click', (e) => {
    if (e.target.id === 'student-modal') closeStudentDetailModal();
  });

  // Action 2: Remove from List -> reverts status to 'waiting', clears Column F timestamp
  document.getElementById('modal-btn-remove').addEventListener('click', () => {
    const st = STATE.students.find((s) => s.rowIndex === STATE.activeModalStudentRow);
    closeStudentDetailModal();
    if (!st) return;

    st.status = 'waiting';
    st.time = '';
    renderAll();
    sendMutation({
      action: 'updateStudents',
      updates: [{ rowIndex: st.rowIndex, status: 'waiting', time: '' }]
    });
  });

  // Action 3: Left the Building -> immediate update + 5s UNDO banner (no confirmation)
  document.getElementById('modal-btn-left').addEventListener('click', () => {
    const st = STATE.students.find((s) => s.rowIndex === STATE.activeModalStudentRow);
    closeStudentDetailModal();
    if (!st) return;

    const nowIso = getLocalIsoTimestamp();
    const undoRecords = [{
      rowIndex: st.rowIndex,
      priorStatus: st.status,
      priorTime: st.time
    }];

    st.status = 'Left the Building';
    st.time = nowIso;
    renderAll();
    sendMutation({
      action: 'updateStudents',
      updates: [{ rowIndex: st.rowIndex, status: 'Left the Building', time: nowIso }]
    });
    showUndoBanner(undoRecords);
  });
}

function openStudentDetailModal(rowIndex) {
  const st = STATE.students.find((s) => s.rowIndex === rowIndex);
  if (!st) return;

  STATE.activeModalStudentRow = rowIndex;

  document.getElementById('modal-student-name').textContent = `${st.first} ${st.last}`;
  document.getElementById('modal-student-grade').textContent = `Grade ${st.grade || '—'}`;

  // Parse Column C ('<Teacher> - <Ext>')
  const classParts = st.classInfo.split(' - ');
  document.getElementById('modal-teacher').textContent = classParts[0] || '—';
  document.getElementById('modal-ext').textContent = classParts[1] || '—';
  document.getElementById('modal-bus').textContent = st.mode ? `Bus ${st.mode}` : 'None';

  const contactsUl = document.getElementById('modal-contacts-list');
  contactsUl.innerHTML = '';
  if (st.contacts && st.contacts.length > 0) {
    st.contacts.forEach((c) => {
      const li = document.createElement('li');
      li.textContent = c;
      contactsUl.appendChild(li);
    });
  } else {
    const li = document.createElement('li');
    li.textContent = 'No authorized contacts listed';
    li.style.color = '#64748b';
    contactsUl.appendChild(li);
  }

  updateModalElapsedText(st);
  document.getElementById('student-modal').classList.remove('hidden');
}

function closeStudentDetailModal() {
  STATE.activeModalStudentRow = null;
  document.getElementById('student-modal').classList.add('hidden');
}

function updateModalElapsedText(st) {
  const secs = getElapsedSeconds(st.time);
  document.getElementById('modal-elapsed').textContent = `Elapsed Wait: ${formatMMSS(secs)}`;
}

/* ==========================================================================
   5-SECOND NON-BLOCKING UNDO TOAST BANNER
   ========================================================================== */
function bindUndoEvents() {
  document.getElementById('undo-btn').addEventListener('click', () => {
    if (!STATE.undoPayload || STATE.undoPayload.length === 0) return;

    const recordsToRestore = STATE.undoPayload.slice();
    hideUndoBanner();

    const updates = [];
    recordsToRestore.forEach((rec) => {
      const st = STATE.students.find((s) => s.rowIndex === rec.rowIndex);
      if (st) {
        st.status = rec.priorStatus;
        st.time = rec.priorTime;
        updates.push({
          rowIndex: st.rowIndex,
          status: rec.priorStatus,
          time: rec.priorTime
        });
      }
    });

    renderAll();
    sendMutation({ action: 'updateStudents', updates });
  });
}

function showUndoBanner(undoRecords) {
  if (STATE.undoTimerId) {
    clearTimeout(STATE.undoTimerId);
    STATE.undoTimerId = null;
  }

  STATE.undoPayload = undoRecords;
  const count = undoRecords.length;
  const label = count === 1 ? '1 student' : `${count} students`;
  document.getElementById('undo-message').textContent = `Marked ${label} as Left the Building`;

  const toast = document.getElementById('undo-toast');
  const bar = document.getElementById('undo-progress-bar');

  toast.classList.remove('hidden');
  bar.style.transition = 'none';
  bar.style.transform = 'scaleX(1)';
  void bar.offsetWidth; // Force reflow
  bar.style.transition = `transform ${CONFIG.UNDO_DURATION_MS}ms linear`;
  bar.style.transform = 'scaleX(0)';

  STATE.undoTimerId = setTimeout(() => {
    hideUndoBanner();
  }, CONFIG.UNDO_DURATION_MS);
}

function hideUndoBanner() {
  if (STATE.undoTimerId) {
    clearTimeout(STATE.undoTimerId);
    STATE.undoTimerId = null;
  }
  STATE.undoPayload = null;
  document.getElementById('undo-toast').classList.add('hidden');
}

/* ==========================================================================
   SHARED UI HELPERS & CONTINUOUS 10-MINUTE COLOR GRADIENT ENGINE
   ========================================================================== */
function createStudentButtonElement(student, { extraClass = '', isReadOnly = false } = {}) {
  const btn = document.createElement(isReadOnly ? 'div' : 'button');
  if (!isReadOnly) btn.type = 'button';
  btn.className = `student-btn ${extraClass}`.trim();

  const namesWrap = document.createElement('div');
  namesWrap.className = 'student-btn-names';

  // Top-Left: Column B ('last') in BOLD BLACK text
  const lastEl = document.createElement('span');
  lastEl.className = 'student-last';
  lastEl.textContent = student.last;

  // Bottom-Left: Column A ('first') in WHITE text
  const firstEl = document.createElement('span');
  firstEl.className = 'student-first';
  firstEl.textContent = student.first;

  namesWrap.append(lastEl, firstEl);

  // Right Side: Column E ('grade') small pill/badge
  const rightMeta = document.createElement('div');
  rightMeta.className = 'student-right-meta';

  const gradeBadge = document.createElement('span');
  gradeBadge.className = 'grade-badge';
  gradeBadge.textContent = student.grade || '—';
  rightMeta.appendChild(gradeBadge);

  btn.append(namesWrap, rightMeta);
  return btn;
}

/**
 * Smoothly interpolates RGB color across 4 stops over 0–10 minutes (configurable):
 * 0% (0:00)  -> RGB(22, 163, 74)  Emerald Green (#16A34A)
 * 40% (4:00) -> RGB(234, 179, 8)  Warm Yellow (#EAB308)
 * 75% (7:30) -> RGB(249, 115, 22) Vivid Orange (#F97316)
 * 100% (10m+)-> RGB(220, 38, 38)  Full Alert Red (#DC2626)
 */
function computeEscalationColor(elapsedSeconds) {
  const threshold = Math.max(1, STATE.alertThresholdSeconds);
  const t = Math.max(0, Math.min(1, elapsedSeconds / threshold));

  const stops = [
    { pos: 0.0, rgb: [22, 163, 74] },
    { pos: 0.4, rgb: [234, 179, 8] },
    { pos: 0.75, rgb: [249, 115, 22] },
    { pos: 1.0, rgb: [220, 38, 38] }
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const start = stops[i];
    const end = stops[i + 1];
    if (t >= start.pos && t <= end.pos) {
      const localT = (t - start.pos) / (end.pos - start.pos);
      const r = Math.round(start.rgb[0] + (end.rgb[0] - start.rgb[0]) * localT);
      const g = Math.round(start.rgb[1] + (end.rgb[1] - start.rgb[1]) * localT);
      const b = Math.round(start.rgb[2] + (end.rgb[2] - start.rgb[2]) * localT);
      return `rgb(${r}, ${g}, ${b})`;
    }
  }
  return 'rgb(220, 38, 38)';
}

function applyGradientStyleToButton(btn, isoTime) {
  const secs = getElapsedSeconds(isoTime);
  btn.style.backgroundColor = computeEscalationColor(secs);
}

function tickLiveTimers() {
  if (!STATE.authenticated) return;

  if (STATE.currentScreen === 'valet-entry' || STATE.currentScreen === 'pickup-entry') {
    document.querySelectorAll('.active-gradient-btn').forEach((btn) => {
      const rowIdx = Number(btn.dataset.rowIndex);
      const st = STATE.students.find((s) => s.rowIndex === rowIdx);
      if (st) {
        applyGradientStyleToButton(btn, st.time);
      }
    });
  }

  if (STATE.activeModalStudentRow !== null) {
    const st = STATE.students.find((s) => s.rowIndex === STATE.activeModalStudentRow);
    if (st) updateModalElapsedText(st);
  }
}

function renderAll() {
  // Update Start Screen Live Badges
  const valetCount = STATE.students.filter((s) => s.status === 'Needed at Valet').length;
  const pickupCount = STATE.students.filter((s) => s.status === 'Needed at Pick Up Door').length;

  document.getElementById('badge-buses-count').textContent = `${STATE.activeBuses.length} active`;
  document.getElementById('badge-valet-count').textContent = `${valetCount} in queue`;
  document.getElementById('badge-pickup-count').textContent = `${pickupCount} in queue`;
  document.getElementById('badge-valet-co-count').textContent = `${valetCount} ready`;
  document.getElementById('badge-pickup-co-count').textContent = `${pickupCount} ready`;

  if (STATE.currentScreen === 'buses') {
    renderBusesScreen();
  } else if (STATE.currentScreen === 'valet-entry' || STATE.currentScreen === 'pickup-entry') {
    renderNameEntryScreen();
  } else if (STATE.currentScreen === 'valet-checkout' || STATE.currentScreen === 'pickup-checkout') {
    renderCheckoutScreen();
  }
}

function compareStudentsByLastThenFirst(a, b) {
  const lastCmp = a.last.localeCompare(b.last, undefined, { sensitivity: 'base' });
  if (lastCmp !== 0) return lastCmp;
  return a.first.localeCompare(b.first, undefined, { sensitivity: 'base' });
}

function getElapsedSeconds(isoString) {
  if (!isoString) return 0;
  const parsed = Date.parse(isoString);
  if (isNaN(parsed)) return 0;
  return Math.max(0, Math.floor((Date.now() - parsed) / 1000));
}

function formatMMSS(totalSeconds) {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

function getLocalIsoTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const tzOffsetMin = -d.getTimezoneOffset();
  const sign = tzOffsetMin >= 0 ? '+' : '-';
  const absOffset = Math.abs(tzOffsetMin);
  const offsetH = pad(Math.floor(absOffset / 60));
  const offsetM = pad(absOffset % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${offsetH}:${offsetM}`;
}

/* ==========================================================================
   DEMO SANDBOX DATA (USED ONLY BEFORE GOOGLE APPS SCRIPT URL IS CONFIGURED)
   ========================================================================== */
function loadDemoData() {
  const now = Date.now();
  const isoAgo = (sec) => new Date(now - sec * 1000).toISOString();

  STATE.activeBuses = ['74-GYM', '81-CAFE'];
  STATE.mruBuses = [
    '74-GYM', '81-CAFE', '77-SPANISH/O204', '78-DESIGN/RED Maker',
    'Reign- Valet', '76-CAFE', 'AC-pk/k-ART', '82-GYM'
  ];
  STATE.students = [
    { rowIndex: 2, first: 'Noah', last: 'Adams', classInfo: 'Miller - 4108', status: 'waiting', grade: '2', time: '', mode: '74', contacts: ['Sarah Adams (Mom)', 'David Adams (Dad)'] },
    { rowIndex: 3, first: 'Lily', last: 'Allen', classInfo: 'Davis - 4112', status: 'waiting', grade: 'K', time: '', mode: '', contacts: ['Grace Allen'] },
    { rowIndex: 4, first: 'Mia', last: 'Baker', classInfo: 'Clark - 4201', status: 'waiting', grade: '4', time: '', mode: '81', contacts: ['Tom Baker', 'Aunt Linda'] },
    { rowIndex: 5, first: 'Ethan', last: 'Carter', classInfo: 'Lopez - 4105', status: 'waiting', grade: '1', time: '', mode: '', contacts: ['Elena Carter'] },
    { rowIndex: 6, first: 'Sofia', last: 'Chen', classInfo: 'White - 4302', status: 'waiting', grade: '3', time: '', mode: '', contacts: ['Wei Chen', 'Mei Lin'] },
    { rowIndex: 7, first: 'Lucas', last: 'Davis', classInfo: 'Hall - 4101', status: 'waiting', grade: 'preK', time: '', mode: '', contacts: ['Hannah Davis'] },
    { rowIndex: 8, first: 'Ava', last: 'Miller', classInfo: 'Young - 4110', status: 'Needed at Valet', grade: '1', time: isoAgo(75), mode: '', contacts: ['Claire Miller'] },
    { rowIndex: 9, first: 'Jaytzael', last: 'Ortiz P', classInfo: 'King - 4209', status: 'Needed at Valet', grade: '3', time: isoAgo(410), mode: '', contacts: ['Maria Ortiz', 'Carlos Ortiz'] },
    { rowIndex: 10, first: 'Leo', last: 'Smith', classInfo: 'Scott - 4310', status: 'Needed at Valet', grade: '5', time: isoAgo(645), mode: '77', contacts: ['Rachel Smith'] },
    { rowIndex: 11, first: 'Emma', last: 'Wang', classInfo: 'Adams - 4204', status: 'Needed at Pick Up Door', grade: '2', time: isoAgo(190), mode: '', contacts: ['Jun Wang'] }
  ];
  syncBusSlotsFromState();
}
