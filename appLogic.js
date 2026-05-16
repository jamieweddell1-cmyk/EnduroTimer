'use strict';

// ── Service Worker Registration ───────────
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js').catch(e => console.warn('SW reg failed:', e));
    });
}

// ── Firebase bootstrap ───────────────────
let db = null;

// ── Paste your Firebase config here ──────
const firebaseConfig = {
    apiKey: "AIzaSyAvVvCexJhn8Y7yk6jLEO7uVp-CPkvVWFY",
    authDomain: "racetimer-c4693.firebaseapp.com",
    databaseURL: "https://racetimer-c4693-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "racetimer-c4693",
    storageBucket: "racetimer-c4693.firebasestorage.app",
    messagingSenderId: "733047674435",
    appId: "1:733047674435:web:2981a4d2eb009ef9bca6f6"
};

window.addEventListener('load', () => {
    try {
        if (firebase.apps.length) firebase.apps.forEach(a => a.delete());
        firebase.initializeApp(firebaseConfig);
        db = firebase.database();
        db.ref('.info/connected').on('value', s => setOnline(s.val() === true));
        checkURLParams();
    } catch (e) {
        alert('Firebase connection failed:\n' + e.message);
    }
});

// ── App state ────────────────────────────
const S = {
    sessionCode: null,
    eventName: '',
    role: null,
    isViewerOnly: false,   // true = arrived via shared URL, no back nav
    days: {},      // { dayId: {name, order} }
    stages: {},      // { stageId: {name, order, dayId} }
    activeStage: null,
    roster: {},
    isOnline: true,
    timingData: {},      // { stageId: {starts:{}, finishes:{}} }
    finishQueue: [],
    qIdx: 0,
    listeners: []
};

// ── Screens ──────────────────────────────
function showScreen(id) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(id).classList.add('active');
}

function goBack() {
    showRoleScreen();
}

function checkURLParams() {
    const p = new URLSearchParams(window.location.search);
    const s = p.get('session'), r = p.get('role');
    if (s && r === 'viewer') joinByCode(s.toUpperCase(), 'viewer', true);
}

// ── Online status ─────────────────────────
function setOnline(online) {
    S.isOnline = online;
    ['start-dot', 'finish-dot', 'res-dot'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('offline', !online);
    });
    ['start-status-txt', 'finish-status-txt', 'res-status-txt'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = online ? 'Live' : 'Offline';
    });
    ['start-banner', 'finish-banner', 'res-banner'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.classList.toggle('show', !online);
    });
}

// ── Session ───────────────────────────────
function genCode() {
    const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return Array.from({length: 4}, () => c[Math.floor(Math.random() * c.length)]).join('');
}

function detach() {
    S.listeners.forEach(({ref, ev, fn}) => ref.off(ev, fn));
    S.listeners = [];
}

function listen(ref, ev, fn) {
    ref.on(ev, fn);
    S.listeners.push({ref, ev, fn});
}

async function createSession() {
    const eventName = document.getElementById('new-event-name').value.trim() || 'Race Event';
    const daysRaw = document.getElementById('new-days').value.trim();
    const code = genCode();

    const daysObj = {};
    if (daysRaw) {
        daysRaw.split(',').forEach((name, i) => {
            const key = db.ref('x').push().key;
            daysObj[key] = {name: name.trim(), order: i};
        });
    }

    await db.ref(`sessions/${code}`).set({
        meta: {eventName, createdAt: firebase.database.ServerValue.TIMESTAMP, activeStageId: null},
        days: Object.keys(daysObj).length ? daysObj : null
    });

    S.sessionCode = code;
    S.eventName = eventName;
    showRoleScreen();
}

async function joinSession() {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    if (code.length !== 4) {
        toast('Enter a 4-character code');
        return;
    }
    await joinByCode(code);
}

async function joinByCode(code, autoRole = null, viewerOnly = false) {
    const snap = await db.ref(`sessions/${code}/meta`).once('value');
    if (!snap.exists()) {
        toast('Session not found — check your code');
        return;
    }
    const meta = snap.val();
    S.sessionCode = code;
    S.eventName = meta.eventName || 'Race Event';
    S.isViewerOnly = viewerOnly;
    if (autoRole) selectRole(autoRole);
    else showRoleScreen();
}

function showRoleScreen() {
    document.getElementById('role-code').textContent = S.sessionCode;
    document.getElementById('role-event').textContent = S.eventName;
    showScreen('screen-role');
}

function selectRole(role) {
    S.role = role;
    detach();
    S.timingData = {};
    S.finishQueue = [];
    S.qIdx = 0;

    listenMeta();
    listenRoster();
    listenTiming();

    if (role === 'start') {
        document.getElementById('start-event-lbl').textContent = S.eventName;
        document.getElementById('start-bib').value = '';
        // Show back arrow for officials
        document.getElementById('start-back-btn').classList.toggle('hidden', S.isViewerOnly);
        showScreen('screen-start');
        setTimeout(() => document.getElementById('start-bib').focus(), 200);
    } else if (role === 'finish') {
        document.getElementById('finish-event-lbl').textContent = S.eventName;
        document.getElementById('finish-back-btn').classList.toggle('hidden', S.isViewerOnly);
        showScreen('screen-finish');
        renderQueue();
    } else {
        document.getElementById('res-session-lbl').textContent = `SESSION ${S.sessionCode}`;
        document.getElementById('res-event-lbl').textContent = S.eventName;
        // Hide back arrow for viewer-only (URL joined)
        document.getElementById('res-back-btn').classList.toggle('hidden', S.isViewerOnly);
        showScreen('screen-results');
        renderResultsTabs();
        renderResults();
    }
}

function leaveSession() {
    detach();
    Object.assign(S, {
        sessionCode: null, eventName: '', role: null, isViewerOnly: false,
        days: {}, stages: {}, activeStage: null, roster: {},
        timingData: {}, finishQueue: [], qIdx: 0, listeners: []
    });
    closeAdmin();
    showScreen('screen-join');
}

// ── Realtime listeners ────────────────────
function listenMeta() {
    listen(db.ref(`sessions/${S.sessionCode}/meta`), 'value', snap => {
        const m = snap.val() || {};
        S.eventName = m.eventName || 'EnduroTimer';
        S.activeStage = m.activeStageId || null;
        ['start-event-lbl', 'finish-event-lbl', 'res-event-lbl'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.textContent = S.eventName;
        });
        if (document.getElementById('adm-event'))
            document.getElementById('adm-event').value = S.eventName;
        updateStageLabels();
        renderAdminStages();
        renderOnCourse();
    });

    listen(db.ref(`sessions/${S.sessionCode}/days`), 'value', snap => {
        S.days = snap.val() || {};
        renderAdminDays();
        renderAdminStages();
        renderDaySelect();
        renderResultsTabs();
        renderResults();
    });

    listen(db.ref(`sessions/${S.sessionCode}/stages`), 'value', snap => {
        S.stages = snap.val() || {};
        updateStageLabels();
        renderAdminStages();
        renderDaySelect();
        renderResultsTabs();
        renderResults();
    });
}

function listenRoster() {
    listen(db.ref(`sessions/${S.sessionCode}/roster`), 'value', snap => {
        S.roster = snap.val() || {};
        renderAdminRoster();
    });
}

function listenTiming() {
    listen(db.ref(`sessions/${S.sessionCode}/timing`), 'value', snap => {
        const raw = snap.val() || {};
        S.timingData = {};
        Object.entries(raw).forEach(([sid, sd]) => {
            S.timingData[sid] = {starts: sd.starts || {}, finishes: sd.finishes || {}};
        });
        rebuildQueue();
        renderQueue();
        renderOnCourse();
        renderResults();
    });
}

// ── Stage / Day helpers ───────────────────
function sortedDays() {
    return Object.entries(S.days).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
}

function sortedStages() {
    return Object.entries(S.stages).sort((a, b) => (a[1].order || 0) - (b[1].order || 0));
}

function stagesForDay(dayId) {
    return sortedStages().filter(([, s]) => s.dayId === dayId);
}

function stagesNoDay() {
    return sortedStages().filter(([, s]) => !s.dayId);
}

function updateStageLabels() {
    let label = 'NO ACTIVE STAGE';
    if (S.activeStage && S.stages[S.activeStage]) {
        const stage = S.stages[S.activeStage];
        const day = stage.dayId && S.days[stage.dayId] ? S.days[stage.dayId].name + ' · ' : '';
        label = (day + stage.name).toUpperCase();
    }
    ['start-stage-lbl', 'finish-stage-lbl'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.textContent = label;
    });
}

function addDay() {
    const name = document.getElementById('adm-new-day').value.trim();
    if (!name) return;
    const order = Object.keys(S.days).length;
    db.ref(`sessions/${S.sessionCode}/days`).push({name, order});
    document.getElementById('adm-new-day').value = '';
}

function renameDay(id) {
    const cur = S.days[id]?.name || '';
    const name = prompt('Rename day:', cur);
    if (name && name.trim()) db.ref(`sessions/${S.sessionCode}/days/${id}/name`).set(name.trim());
}

function removeDay(id) {
    if (!confirm('Remove this day? Stages assigned to it will become unassigned.')) return;
    db.ref(`sessions/${S.sessionCode}/days/${id}`).remove();
    // Unassign stages from this day
    sortedStages().filter(([, s]) => s.dayId === id).forEach(([sid]) => {
        db.ref(`sessions/${S.sessionCode}/stages/${sid}/dayId`).set(null);
    });
}

function addStage() {
    const name = document.getElementById('adm-new-stage').value.trim();
    const dayId = document.getElementById('adm-new-stage-day').value || null;
    if (!name) return;
    const order = Object.keys(S.stages).length;
    db.ref(`sessions/${S.sessionCode}/stages`).push({name, order, dayId});
    document.getElementById('adm-new-stage').value = '';
}

function setActiveStage(id) {
    db.ref(`sessions/${S.sessionCode}/meta/activeStageId`).set(id);
}

function renameStage(id) {
    const cur = S.stages[id]?.name || '';
    const name = prompt('Rename stage:', cur);
    if (name && name.trim()) db.ref(`sessions/${S.sessionCode}/stages/${id}/name`).set(name.trim());
}

function removeStage(id) {
    if (!confirm('Remove stage? Timing data is kept.')) return;
    db.ref(`sessions/${S.sessionCode}/stages/${id}`).remove();
    if (S.activeStage === id) db.ref(`sessions/${S.sessionCode}/meta/activeStageId`).set(null);
}

function saveEventName() {
    const v = document.getElementById('adm-event').value.trim();
    if (!v) return;
    db.ref(`sessions/${S.sessionCode}/meta/eventName`).set(v);
    toast('Saved');
}

// ── Roster ────────────────────────────────
function athleteName(bib) {
    return S.roster[String(bib)]?.name || null;
}

function previewAthlete(inputId, previewId) {
    const bib = document.getElementById(inputId).value;
    const el = document.getElementById(previewId);
    const name = athleteName(bib);
    el.textContent = name ? `#${bib} — ${name}` : (bib ? '(Unknown athlete)' : '');
    el.style.color = name ? 'var(--success)' : 'var(--text-3)';
}

function addAthlete() {
    const bib = document.getElementById('adm-new-bib').value.trim();
    const name = document.getElementById('adm-new-name').value.trim();
    if (!bib || !name) {
        toast('Enter both bib and name');
        return;
    }
    db.ref(`sessions/${S.sessionCode}/roster/${bib}`).set({name, bib: String(bib)});
    document.getElementById('adm-new-bib').value = '';
    document.getElementById('adm-new-name').value = '';
    toast(`Added #${bib} ${name}`);
}

function removeAthlete(bib) {
    if (!confirm(`Remove #${bib} ${athleteName(bib) || ''}?`)) return;
    db.ref(`sessions/${S.sessionCode}/roster/${bib}`).remove();
}

async function importSheets() {
    const url = document.getElementById('adm-sheets-url').value.trim();
    if (!url) {
        toast('Paste a CSV URL first');
        return;
    }
    toast('Importing…');
    try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await res.text();
        const rows = text.split('\n').slice(1);
        const updates = {};
        let count = 0;
        rows.forEach(line => {
            const cols = parseCsvLine(line);
            const bib = cols[0]?.trim();
            const name = cols[1]?.trim();
            if (bib && name && !isNaN(bib)) {
                updates[bib] = {name, bib: String(bib)};
                count++;
            }
        });
        if (!count) {
            toast('No valid rows found. Check format: Bib,Name');
            return;
        }
        await db.ref(`sessions/${S.sessionCode}/roster`).update(updates);
        toast(`✓ Imported ${count} athletes`);
    } catch (e) {
        toast('Import failed: ' + e.message);
        console.error(e);
    }
}

function parseCsvLine(line) {
    const out = [];
    let cur = '', inq = false;
    for (const ch of line) {
        if (ch === '"') inq = !inq;
        else if (ch === ',' && !inq) {
            out.push(cur);
            cur = '';
        } else cur += ch;
    }
    out.push(cur);
    return out;
}

// ── On Course Panel ───────────────────────
function renderOnCourse() {
    const panel = document.getElementById('on-course-panel');
    const list = document.getElementById('on-course-list');
    if (!panel || !S.activeStage) {
        if (panel) panel.style.display = 'none';
        return;
    }

    const td = S.timingData[S.activeStage] || {starts: {}, finishes: {}};
    const finishedBibs = new Set(
        Object.values(td.finishes).filter(f => f.assigned && f.bib).map(f => String(f.bib))
    );
    const onCourse = Object.keys(td.starts).filter(b => !finishedBibs.has(b));

    if (!onCourse.length) {
        panel.style.display = 'none';
        return;
    }

    panel.style.display = 'block';
    list.innerHTML = onCourse.map(bib => {
        const name = athleteName(bib);
        return `<div class="on-course-row">
      <span class="on-course-bib">#${bib}</span>
      <span>${esc(name || '(Unknown)')}</span>
      <span style="flex:1"></span>
      <span class="on-course-dot">● Running</span>
    </div>`;
    }).join('');
}

// ── Start timing ──────────────────────────
function recordStart() {
    const bib = document.getElementById('start-bib').value.trim();
    if (!bib) {
        toast('Enter a bib number first');
        return;
    }
    if (!S.activeStage) {
        toast('No active stage — set one in ⚙️ Admin');
        return;
    }

    const wasOffline = !S.isOnline;
    const deviceTime = Date.now();

    db.ref(`sessions/${S.sessionCode}/timing/${S.activeStage}/starts/${bib}`).set({
        bib: String(bib),
        deviceTime,
        serverTime: firebase.database.ServerValue.TIMESTAMP,
        wasOffline
    });

    const name = athleteName(bib);
    const label = name ? `#${bib} ${name}` : `#${bib}`;
    flashScreen('green');
    document.getElementById('start-last').textContent =
        `Last: ${label} at ${fmtTime(deviceTime)}${wasOffline ? ' ⚠' : ''}`;
    document.getElementById('start-bib').value = '';
    document.getElementById('start-preview').textContent = '';
    document.getElementById('start-bib').focus();
    toast(`✓ ${label} started`);
}

// ── Finish timing ─────────────────────────
function recordFinish() {
    if (!S.activeStage) {
        toast('No active stage — set one in ⚙️ Admin');
        return;
    }

    const wasOffline = !S.isOnline;
    const deviceTime = Date.now();

    db.ref(`sessions/${S.sessionCode}/timing/${S.activeStage}/finishes`).push({
        deviceTime,
        serverTime: firebase.database.ServerValue.TIMESTAMP,
        wasOffline,
        bib: null,
        assigned: false
    });

    flashScreen('red');
    toast(`⏱ Finish recorded — ${fmtTime(deviceTime)}`);
    setTimeout(() => document.getElementById('finish-bib').focus(), 80);
}

function rebuildQueue() {
    if (!S.activeStage) {
        S.finishQueue = [];
        return;
    }
    const fin = S.timingData[S.activeStage]?.finishes || {};
    S.finishQueue = Object.entries(fin)
        .filter(([, f]) => !f.assigned)
        .sort((a, b) => a[1].deviceTime - b[1].deviceTime)
        .map(([id, f]) => ({id, ...f}));
    if (S.qIdx >= S.finishQueue.length) S.qIdx = Math.max(0, S.finishQueue.length - 1);
}

function qNav(dir) {
    S.qIdx = Math.max(0, Math.min(S.finishQueue.length - 1, S.qIdx + dir));
    renderQueue();
}

function renderQueue() {
    const q = S.finishQueue;
    document.getElementById('queue-badge').textContent = q.length;
    document.getElementById('finish-ua-count').textContent = `${q.length} unassigned`;
    document.getElementById('queue-empty').style.display = q.length === 0 ? 'block' : 'none';
    document.getElementById('queue-controls').style.display = q.length > 0 ? 'block' : 'none';
    if (!q.length) return;

    const e = q[S.qIdx];
    const useT = e.wasOffline ? e.deviceTime : (e.serverTime || e.deviceTime);
    const tEl = document.getElementById('q-time');
    tEl.textContent = fmtTime(useT) + (e.wasOffline ? '  ⚠' : '');
    tEl.className = 'queue-entry-time' + (e.wasOffline ? ' device-time' : '');
    document.getElementById('q-meta').textContent = `entry ${S.qIdx + 1} of ${q.length}`;
    document.getElementById('q-prev').disabled = S.qIdx === 0;
    document.getElementById('q-next').disabled = S.qIdx === q.length - 1;
}

function assignFinish() {
    const bib = document.getElementById('finish-bib').value.trim();
    if (!bib) {
        toast('Enter a bib number');
        return;
    }
    if (!S.finishQueue.length) {
        toast('No unassigned entries');
        return;
    }

    const entry = S.finishQueue[S.qIdx];
    db.ref(`sessions/${S.sessionCode}/timing/${S.activeStage}/finishes/${entry.id}`).update({
        bib: String(bib), assigned: true
    });

    const name = athleteName(bib);
    const label = name ? `#${bib} ${name}` : `#${bib}`;
    toast(`✓ Time assigned to ${label}`);
    document.getElementById('finish-bib').value = '';
    document.getElementById('finish-preview').textContent = '';
}

// ── Results ───────────────────────────────
let activeTab = 'overall';

function renderResultsTabs() {
    const el = document.getElementById('res-tabs');
    if (!el) return;
    const days = sortedDays();
    let html = `<button class="tab-btn ${activeTab === 'overall' ? 'active' : ''}" onclick="switchTab('overall')">OVERALL</button>`;
    days.forEach(([id, d]) => {
        html += `<button class="tab-btn ${activeTab === id ? 'active' : ''}" onclick="switchTab('${id}')">${esc(d.name.toUpperCase())}</button>`;
    });
    // If no days, add per-stage tabs
    if (!days.length) {
        sortedStages().forEach(([id, s]) => {
            html += `<button class="tab-btn ${activeTab === id ? 'active' : ''}" onclick="switchTab('${id}')">${esc(s.name.toUpperCase())}</button>`;
        });
    }
    el.innerHTML = html;
}

function switchTab(t) {
    activeTab = t;
    renderResultsTabs();
    renderResults();
}

function renderResults() {
    const el = document.getElementById('res-body');
    if (!el) return;

    if (activeTab === 'overall') {
        renderOverall(el);
    } else if (S.days[activeTab]) {
        renderDayTab(el, activeTab);
    } else {
        renderStageTab(el, activeTab);
    }
}

// ─ Overall Tab ─
function renderOverall(el) {
    const days = sortedDays();
    const stages = sortedStages();
    const bibs = allBibs();
    const ua = collectUnassigned();

    if (!bibs.size && !ua.length) {
        el.innerHTML = '<div class="no-data">No timing data yet.<br>Start a stage and begin recording times.</div>';
        return;
    }

    // If days exist, columns = days; else columns = stages
    const useDays = days.length > 0;

    const rows = [];
    bibs.forEach(bib => {
        const name = athleteName(bib) || '(Unknown)';
        let total = 0, complete = true, anyOffline = false;
        const colTimes = {};

        if (useDays) {
            days.forEach(([did]) => {
                const dStages = stagesForDay(did);
                let dayTotal = 0, dayComplete = true, dayOffline = false;
                dStages.forEach(([sid]) => {
                    const r = getElapsed(bib, sid);
                    if (r) {
                        dayTotal += r.ms;
                        if (r.offline) dayOffline = true;
                    } else {
                        dayComplete = false;
                    }
                });
                if (!dStages.length) {
                    dayComplete = false;
                }
                colTimes[did] = dayComplete ? {ms: dayTotal, offline: dayOffline} : null;
                if (!dayComplete) complete = false;
                else total += dayTotal;
                if (dayOffline) anyOffline = true;
            });
        } else {
            stages.forEach(([sid]) => {
                const r = getElapsed(bib, sid);
                colTimes[sid] = r;
                if (r) {
                    total += r.ms;
                    if (r.offline) anyOffline = true;
                } else {
                    complete = false;
                }
            });
        }

        rows.push({bib, name, total, complete, anyOffline, colTimes});
    });

    rows.sort((a, b) => {
        if (a.complete !== b.complete) return a.complete ? -1 : 1;
        return a.total - b.total;
    });

    const cols = useDays ? days : stages;
    let h = '<table class="results-table"><thead><tr><th>#</th><th>BIB</th><th>NAME</th>';
    cols.forEach(([, c]) => h += `<th>${esc(c.name.toUpperCase())}</th>`);
    h += '<th>OVERALL</th></tr></thead><tbody>';

    let rank = 1;
    rows.forEach(r => {
        h += '<tr>';
        h += `<td class="td-rank">${r.complete ? rank++ : '—'}</td>`;
        h += `<td class="td-bib">${r.bib}</td>`;
        h += `<td class="td-name">${esc(r.name)}</td>`;
        cols.forEach(([id]) => {
            const t = r.colTimes[id];
            if (t) h += `<td class="td-time${t.offline ? ' td-warn' : ''}">${fmtElapsed(t.ms)}${t.offline ? ' ⚠' : ''}</td>`;
            else h += `<td class="td-muted">—</td>`;
        });
        h += `<td class="${r.complete ? 'td-best' : 'td-muted'}">${r.complete ? fmtElapsed(r.total) + (r.anyOffline ? ' ⚠' : '') : '—'}</td>`;
        h += '</tr>';
    });

    ua.forEach(u => {
        h += `<tr><td>—</td><td class="td-danger">?</td><td class="td-danger">Unassigned</td>`;
        cols.forEach(() => h += `<td class="td-muted">—</td>`);
        h += `<td class="td-muted">—</td></tr>`;
    });

    h += '</tbody></table>';
    el.innerHTML = h;
}

// ─ Day Tab ─
function renderDayTab(el, dayId) {
    const stages = stagesForDay(dayId);
    if (!stages.length) {
        el.innerHTML = '<div class="no-data">No stages assigned to this day yet.<br>Add stages in ⚙️ Admin.</div>';
        return;
    }

    const bibs = new Set();
    stages.forEach(([sid]) => {
        const td = S.timingData[sid] || {starts: {}, finishes: {}};
        Object.keys(td.starts).forEach(b => bibs.add(b));
        Object.values(td.finishes).filter(f => f.assigned && f.bib).forEach(f => bibs.add(String(f.bib)));
    });
    Object.keys(S.roster).forEach(b => bibs.add(b));

    const ua = [];
    stages.forEach(([sid]) => {
        const td = S.timingData[sid] || {starts: {}, finishes: {}};
        Object.entries(td.finishes).filter(([, f]) => !f.assigned).forEach(([id, f]) => {
            const t = f.wasOffline ? f.deviceTime : (f.serverTime || f.deviceTime);
            ua.push({sid, id, t, offline: f.wasOffline});
        });
    });

    const rows = [];
    bibs.forEach(bib => {
        const name = athleteName(bib) || '(Unknown)';
        let dayTotal = 0, dayComplete = true, anyOffline = false;
        const stageTimes = {};
        stages.forEach(([sid]) => {
            const r = getElapsed(bib, sid);
            stageTimes[sid] = r;
            if (r) {
                dayTotal += r.ms;
                if (r.offline) anyOffline = true;
            } else {
                dayComplete = false;
            }
        });
        rows.push({bib, name, dayTotal, dayComplete, anyOffline, stageTimes});
    });

    rows.sort((a, b) => {
        if (a.dayComplete !== b.dayComplete) return a.dayComplete ? -1 : 1;
        return a.dayTotal - b.dayTotal;
    });

    let h = '<table class="results-table"><thead><tr><th>#</th><th>BIB</th><th>NAME</th>';
    stages.forEach(([, s]) => h += `<th>${esc(s.name.toUpperCase())}</th>`);
    h += '<th>DAY TOTAL</th></tr></thead><tbody>';

    let rank = 1;
    rows.forEach(r => {
        h += '<tr>';
        h += `<td class="td-rank">${r.dayComplete ? rank++ : '—'}</td>`;
        h += `<td class="td-bib">${r.bib}</td>`;
        h += `<td class="td-name">${esc(r.name)}</td>`;
        stages.forEach(([sid]) => {
            const t = r.stageTimes[sid];
            const td = S.timingData[sid] || {starts: {}};
            if (t) h += `<td class="td-time${t.offline ? ' td-warn' : ''}">${fmtElapsed(t.ms)}${t.offline ? ' ⚠' : ''}</td>`;
            else if (td.starts[r.bib]) h += `<td class="td-muted">Running…</td>`;
            else h += `<td class="td-muted">—</td>`;
        });
        h += `<td class="${r.dayComplete ? 'td-best' : 'td-muted'}">${r.dayComplete ? fmtElapsed(r.dayTotal) + (r.anyOffline ? ' ⚠' : '') : '—'}</td>`;
        h += '</tr>';
    });

    ua.forEach(u => {
        const s = stages.find(([id]) => id === u.sid);
        h += `<tr><td>—</td><td class="td-danger">?</td><td class="td-danger">Unassigned</td>`;
        stages.forEach(([sid]) => h += sid === u.sid ? `<td class="td-danger">${fmtTime(u.t)}</td>` : `<td class="td-muted">—</td>`);
        h += `<td class="td-muted">—</td></tr>`;
    });

    h += '</tbody></table>';
    el.innerHTML = h;
}

// ─ Stage Tab (when no days configured) ─
function renderStageTab(el, sid) {
    const td = S.timingData[sid] || {starts: {}, finishes: {}};
    const bibs = new Set([
        ...Object.keys(td.starts),
        ...Object.values(td.finishes).filter(f => f.assigned && f.bib).map(f => String(f.bib))
    ]);
    const ua = Object.entries(td.finishes).filter(([, f]) => !f.assigned);

    if (!bibs.size && !ua.length) {
        el.innerHTML = '<div class="no-data">No data for this stage yet.</div>';
        return;
    }

    const rows = [];
    bibs.forEach(bib => {
        const name = athleteName(bib) || '(Unknown)';
        const result = getElapsed(bib, sid);
        const st = td.starts[bib];
        rows.push({bib, name, result, st});
    });
    rows.sort((a, b) => {
        if (a.result && !b.result) return -1;
        if (!a.result && b.result) return 1;
        if (a.result && b.result) return a.result.ms - b.result.ms;
        return 0;
    });

    let h = '<table class="results-table"><thead><tr><th>#</th><th>BIB</th><th>NAME</th><th>START</th><th>FINISH</th><th>TIME</th></tr></thead><tbody>';
    let rank = 1;
    rows.forEach(r => {
        const fin = Object.values(td.finishes).find(f => f.assigned && String(f.bib) === String(r.bib));
        const stT = r.st ? (r.st.wasOffline ? r.st.deviceTime : (r.st.serverTime || r.st.deviceTime)) : null;
        const finT = fin ? (fin.wasOffline ? fin.deviceTime : (fin.serverTime || fin.deviceTime)) : null;
        h += '<tr>';
        h += `<td class="td-rank">${r.result ? rank++ : '—'}</td>`;
        h += `<td class="td-bib">${r.bib}</td>`;
        h += `<td class="td-name">${esc(r.name)}</td>`;
        h += `<td class="td-time${r.st?.wasOffline ? ' td-warn' : ''}">${stT ? fmtTime(stT) + (r.st.wasOffline ? ' ⚠' : '') : '—'}</td>`;
        h += `<td class="td-time${fin?.wasOffline ? ' td-warn' : ''}">${finT ? fmtTime(finT) + (fin.wasOffline ? ' ⚠' : '') : (r.st ? 'Running…' : '—')}</td>`;
        h += `<td class="${r.result ? 'td-best' : 'td-muted'}">${r.result ? fmtElapsed(r.result.ms) + (r.result.offline ? ' ⚠' : '') : '—'}</td>`;
        h += '</tr>';
    });
    ua.forEach(([id, f]) => {
        const t = f.wasOffline ? f.deviceTime : (f.serverTime || f.deviceTime);
        h += `<tr><td>—</td><td class="td-danger">?</td><td class="td-danger">Unassigned finish</td><td>—</td><td class="td-danger">${fmtTime(t)}</td><td>—</td></tr>`;
    });
    h += '</tbody></table>';
    el.innerHTML = h;
}

function getElapsed(bib, sid) {
    const td = S.timingData[sid];
    if (!td) return null;
    const st = td.starts[String(bib)];
    if (!st) return null;
    const fin = Object.values(td.finishes).find(f => f.assigned && String(f.bib) === String(bib));
    if (!fin) return null;
    const sT = st.deviceTime;
    const fT = fin.deviceTime;
    return {ms: fT - sT, offline: st.wasOffline || fin.wasOffline};
}

function allBibs() {
    const set = new Set();
    Object.keys(S.roster).forEach(b => set.add(b));
    Object.values(S.timingData).forEach(td => {
        Object.keys(td.starts).forEach(b => set.add(b));
        Object.values(td.finishes).filter(f => f.assigned && f.bib).forEach(f => set.add(String(f.bib)));
    });
    return set;
}

function collectUnassigned() {
    const out = [];
    Object.entries(S.timingData).forEach(([sid, td]) => {
        Object.entries(td.finishes).filter(([, f]) => !f.assigned).forEach(([id, f]) => {
            const t = f.wasOffline ? f.deviceTime : (f.serverTime || f.deviceTime);
            out.push({sid, id, t, offline: f.wasOffline});
        });
    });
    return out;
}

// ── CSV Export ───────────────────────────
function exportCSV() {
    const el = document.getElementById('res-body');
    const tbl = el.querySelector('table');
    if (!tbl) {
        toast('No data to export');
        return;
    }

    const rows = [];
    tbl.querySelectorAll('tr').forEach(tr => {
        const cells = [];
        tr.querySelectorAll('th,td').forEach(td => {
            // Clean text content - strip emoji and extra whitespace
            let txt = td.textContent.replace(/[⚠●]/g, '').trim();
            // Wrap in quotes if contains comma
            if (txt.includes(',')) txt = `"${txt}"`;
            cells.push(txt);
        });
        rows.push(cells.join(','));
    });

    const csv = rows.join('\n');
    const blob = new Blob([csv], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const tabName = activeTab === 'overall' ? 'Overall' :
        (S.days[activeTab]?.name || S.stages[activeTab]?.name || activeTab);
    a.href = url;
    a.download = `${S.eventName.replace(/\s+/g, '_')}_${tabName.replace(/\s+/g, '_')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('✓ CSV downloaded');
}

// ── Admin Panel ───────────────────────────
function openAdmin() {
    document.getElementById('admin-panel').classList.add('open');
    document.getElementById('adm-code').textContent = S.sessionCode;
    document.getElementById('adm-event').value = S.eventName;
    renderAdminDays();
    renderAdminStages();
    renderAdminRoster();
    renderDaySelect();
    genQR();
}

function closeAdmin() {
    document.getElementById('admin-panel').classList.remove('open');
}

function renderAdminDays() {
    const el = document.getElementById('adm-days');
    if (!el) return;
    const days = sortedDays();
    if (!days.length) {
        el.innerHTML = '<div class="hint" style="margin-bottom:10px">No days added yet — add days to group stages.</div>';
        return;
    }
    el.innerHTML = days.map(([id, d]) =>
        `<div class="stage-item">
      <div class="stage-item-name">${esc(d.name)}</div>
      <button class="xs-btn" onclick="renameDay('${id}')">Rename</button>
      <button class="xs-btn del" onclick="removeDay('${id}')">✕</button>
    </div>`
    ).join('');
}

function renderAdminStages() {
    const el = document.getElementById('adm-stages');
    if (!el) return;
    const days = sortedDays();
    const stages = sortedStages();
    if (!stages.length) {
        el.innerHTML = '<div class="hint" style="margin-bottom:10px">No stages added yet.</div>';
        return;
    }

    let html = '';

    if (days.length) {
        // Group by day
        days.forEach(([did, d]) => {
            const dStages = stages.filter(([, s]) => s.dayId === did);
            if (!dStages.length) return;
            html += `<div class="day-group"><div class="day-group-label">${esc(d.name)}</div>`;
            dStages.forEach(([sid, s]) => html += stageItemHTML(sid, s));
            html += '</div>';
        });
        // Unassigned stages
        const unassigned = stages.filter(([, s]) => !s.dayId);
        if (unassigned.length) {
            html += `<div class="day-group"><div class="day-group-label">No Day Assigned</div>`;
            unassigned.forEach(([sid, s]) => html += stageItemHTML(sid, s));
            html += '</div>';
        }
    } else {
        stages.forEach(([sid, s]) => html += stageItemHTML(sid, s));
    }

    el.innerHTML = html;
}

function stageItemHTML(sid, s) {
    const act = sid === S.activeStage;
    return `<div class="stage-item ${act ? 'is-active' : ''}">
    <div class="stage-dot ${act ? 'on' : ''}"></div>
    <div class="stage-item-name">${esc(s.name)}</div>
    ${act
        ? '<span class="active-badge">● ACTIVE</span>'
        : `<button class="xs-btn ok" onclick="setActiveStage('${sid}')">Set Active</button>`}
    <button class="xs-btn" onclick="renameStage('${sid}')">Rename</button>
    <button class="xs-btn del" onclick="removeStage('${sid}')">✕</button>
  </div>`;
}

function renderDaySelect() {
    const sel = document.getElementById('adm-new-stage-day');
    if (!sel) return;
    const days = sortedDays();
    sel.innerHTML = '<option value="">— No day assigned —</option>' +
        days.map(([id, d]) => `<option value="${id}">${esc(d.name)}</option>`).join('');
}

function renderAdminRoster() {
    const el = document.getElementById('adm-roster');
    if (!el) return;
    const entries = Object.entries(S.roster).sort((a, b) => Number(a[0]) - Number(b[0]));
    if (!entries.length) {
        el.innerHTML = '<div class="hint">No athletes yet.</div>';
        return;
    }
    el.innerHTML = entries.map(([bib, a]) =>
        `<div class="athlete-row"><div><span class="ath-bib">#${bib}</span>${esc(a.name)}</div>
     <button class="xs-btn del" onclick="removeAthlete('${bib}')">✕</button></div>`
    ).join('');
}

// ── Share / QR ────────────────────────────
function shareURL() {
    return `${location.href.split('?')[0]}?session=${S.sessionCode}&role=viewer`;
}

function genQR() {
    const wrap = document.getElementById('qr-inner');
    wrap.innerHTML = '';
    const url = shareURL();
    document.getElementById('share-url-display').textContent = url;
    try {
        new QRCode(wrap, {
            text: url, width: 150, height: 150,
            colorDark: '#000', colorLight: '#fff', correctLevel: QRCode.CorrectLevel.M
        });
    } catch (e) {
        wrap.innerHTML = '<div class="hint">QR unavailable offline</div>';
    }
}

function copyLink() {
    navigator.clipboard.writeText(shareURL()).then(() => toast('✓ Link copied'));
}

function shareWA() {
    const msg = encodeURIComponent(
        `⏱ *${S.eventName}* — Live Results\n\nWatch your time live:\n${shareURL()}\n\nSession code: *${S.sessionCode}*`
    );
    window.open(`https://wa.me/?text=${msg}`, '_blank');
}

// ── Formatting ────────────────────────────
function fmtTime(ms) {
    if (!ms) return '--:--:--.---';
    const d = new Date(ms);
    return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function fmtElapsed(ms) {
    if (ms == null || ms < 0) return '--:--.---';
    const m = Math.floor(ms / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    const ml = ms % 1000;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ml).padStart(3, '0')}`;
}

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Flash / Toast ─────────────────────────
function flashScreen(colour) {
    const el = document.getElementById(`fl-${colour}`);
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 350);
}

let _toastTmr;

function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(_toastTmr);
    _toastTmr = setTimeout(() => el.classList.remove('show'), 2600);
}