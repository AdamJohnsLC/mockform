// All requests go through the Cloudflare proxy — token stays server-side
var API = "/api";

// Per-main-session config. Each session owns its own durations + buffer + teachers.
// `period` retained for backwards-compat display labels.
var VALID_SLOT_IDS = ["main_0800", "main_1040"];
var SLOTS = [
  {
    id: "main_0800",
    label: "08:00",
    period: "Morning",
    mainSeats: 10,
    mainDuration: 150,
    bufferMinutes: 10,
    speakingDuration: 15,
    teachers: 2,
  },
  {
    id: "main_1040",
    label: "10:40",
    period: "Midday",
    mainSeats: 10,
    mainDuration: 150,
    bufferMinutes: 10,
    speakingDuration: 15,
    teachers: 2,
  },
];
var MAX = 10;
// Day-level config — defaults derived from SLOTS in normalizeDayConfig().
var dayConfig = { dayStart: "08:00", dayClose: "13:10", dayCloseOverride: false };
var seats = {};
var step = 1; // 1=session, 6=speaking-grid, 5=exam-type (legacy), 2=details, 3=manage, 4=change-slot, 7=change-speak
var prevStep = null;
var form = { slot: null, speak: null, name: "", phone: "", school: "" };
var errors = {};
var submitting = false;
var loadError = false;
var loadErrorMsg = "";
var newSlotChoice = null;
var hasAnimatedCards = false; // only animate cards on first appearance
// --- Admin & deadline ---
var ADMIN_HASH =
  "4e00966f7d1e666e33b9f63bfad60646e023890a664d10a2e9df11331c46d976";
var headerClickCount = 0;
var headerClickTimer = null;
var adminAuthenticated = false;
var adminStatus = "";
var deadline = null; // Date object or null
var testDate = null; // Date object for actual test day (Bot Reminders)
var adminActiveTab = "deadline"; // 'deadline' or 'sessions'
var adminSessionDraft = null; // working copy while editing sessions
var adminFailedAttempts = 0;
var adminSaveTimer = null;
var adminLockedUntil = 0;
var ADMIN_MAX_ATTEMPTS = 5;
var ADMIN_LOCKOUT_MS = 60000; // 1 minute lockout
var HEADER_CLICK_RESET_MS = 1500; // ms window for 5-click trigger
var COUNTDOWN_THRESHOLD_MS = 24 * 60 * 60 * 1000; // show countdown within 24h
var MS_PER_HOUR = 3600000;
var MS_PER_MINUTE = 60000;
var adminStudentFilter = ""; // search filter for students tab
var adminStudentsLoadedAt = 0; // timestamp of last students load
var adminDayDraft = null; // working copy of dayConfig during admin edit

// --- Bot admin tab state ---
var adminBotSubtab = "texts"; // 'texts' | 'broadcast' | 'schedules' | 'stats'
var adminBotTexts = null; // loaded values keyed by setting key
var adminBotTextsLoading = false;
var adminBotTextsError = "";
var adminBotSchedules = null; // working copy (array)
var adminBotSchedulesLoaded = false;
var adminBotSchedulesError = "";
var adminBotBroadcastText = ""; // textarea contents
var adminBotBroadcastAudience = "all_linked";
var adminBotBroadcastPolling = false;
var adminBotActiveBroadcastId = null;
var adminBotActiveBroadcast = null; // last polled record
var adminBotBroadcastHistory = null; // array of summaries (last 10)
var adminBotStats = null;
var adminBotStatsLoading = false;
var adminBotStatsError = "";
var adminBotStatsTimer = null;
// Ordered list of editable text keys + admin-facing labels.
var BOT_TEXT_FIELDS = [
  { key: "bot_text_rules", label: "Test rules (/rules)", rows: 8 },
  { key: "bot_text_welcome", label: "Welcome (/start no payload)", rows: 6 },
  { key: "bot_text_help", label: "/help line", rows: 2 },
  { key: "bot_text_location", label: "/location body", rows: 6 },
  { key: "bot_text_location_line", label: "Location line (embedded in notifications)", rows: 2 },
  { key: "bot_text_registration_success_prefix", label: "Registration success prefix", rows: 4 },
  { key: "bot_text_registration_updated_prefix", label: "Registration updated prefix", rows: 4 },
  { key: "bot_text_cancellation", label: "Cancellation message", rows: 4 },
  { key: "bot_text_reminder_header_template", label: "Reminder header (use {name})", rows: 4 },
  { key: "bot_text_reminder_tips", label: "Reminder tips section (use {alarm})", rows: 6 },
];

// Restore admin session from sessionStorage
try {
  if (sessionStorage.getItem("adminAuth") === "1") {
    adminAuthenticated = true;
  }
} catch (e) {}

// --- Main+Speaking mode ---
var SPEAKING_SUFFIX = "_speaking"; // legacy — only used to read old data
var MAIN_DURATION_DEFAULT = 150; // fallback when a session is missing mainDuration
var SPEAK_DURATION_DEFAULT = 15;
var SPEAKING_GAP_DEFAULT = 10;
// Legacy aliases — some functions still reference these for fallback math.
var MAIN_DURATION = MAIN_DURATION_DEFAULT;
var SPEAK_DURATION = SPEAK_DURATION_DEFAULT;
var SPEAKING_GAP = SPEAKING_GAP_DEFAULT;
var registrationMode = "lr_only"; // 'lr_only' | 'main_speaking'
var examType = null; // legacy — kept for migration of old localStorage

// --- Local registration storage ---
function getRegistration() {
  try {
    var r = localStorage.getItem("mock_reg");
    if (!r) return null;
    var parsed = JSON.parse(r);
    // Schema validation — reject tampered/incomplete objects
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.name !== "string" || !parsed.name.trim()) return null;
    if (typeof parsed.phone !== "string") return null;
    if (typeof parsed.slotId !== "string" || !parsed.slotId.trim()) return null; // allow custom slot IDs
    if (typeof parsed.slotLabel !== "string") return null;
    if (typeof parsed.school !== "string") return null;
    return parsed;
  } catch (e) {
    return null;
  }
}
function saveRegistration(data) {
  try {
    localStorage.setItem("mock_reg", JSON.stringify(data));
  } catch (e) {}
}
function clearRegistration() {
  try {
    localStorage.removeItem("mock_reg");
  } catch (e) {}
}

// --- Time helpers (Main+Speaking mode) ---
function toMin(label) {
  if (!label) return 0;
  var p = String(label).split(":");
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}
function toHHMM(m) {
  var h = Math.floor(m / 60) % 24,
    n = m % 60;
  return (h < 10 ? "0" : "") + h + ":" + (n < 10 ? "0" : "") + n;
}
// Pool id used by the Seats sheet for a 15-min speaking slot starting at HH:MM.
function speakPoolId(label) {
  return "speak_" + label.replace(":", "");
}
// Normalize a legacy `slot_NNNN` id to the new `main_NNNN` id used internally.
function normalizeSlotId(id) {
  if (typeof id !== "string") return id;
  if (id.indexOf("slot_") === 0) return "main_" + id.slice(5);
  return id;
}
// Day-level defaults derived from SLOTS when admin hasn't pinned an override.
function normalizeDayConfig() {
  if (!Array.isArray(SLOTS) || !SLOTS.length) return;
  var sessions = SLOTS.slice().sort(function (a, b) {
    return toMin(a.label) - toMin(b.label);
  });
  var earliestStart = toMin(sessions[0].label);
  var lastEnd = 0;
  sessions.forEach(function (s) {
    var dur = Number(s.mainDuration) || MAIN_DURATION_DEFAULT;
    var end = toMin(s.label) + dur;
    if (end > lastEnd) lastEnd = end;
  });
  if (!dayConfig.dayStart) dayConfig.dayStart = toHHMM(earliestStart);
  if (!dayConfig.dayCloseOverride) {
    dayConfig.dayClose = toHHMM(lastEnd);
  }
}
// Build the day-wide grid of 15-min speaking slots with blockedByMain[] per slot.
// Pure function — pass arguments rather than read globals so the admin preview
// can call it with a draft config.
function buildSpeakingGrid(sessions, dc) {
  sessions = sessions || SLOTS;
  dc = dc || dayConfig;
  if (!sessions.length) return [];
  // Effective speaking duration: assume consistent across sessions (UI enforces).
  var dur = Number(sessions[0].speakingDuration) || SPEAK_DURATION_DEFAULT;
  var teachers = Math.max(0, Number(sessions[0].teachers) || 0);

  var sorted = sessions.slice().sort(function (a, b) {
    return toMin(a.label) - toMin(b.label);
  });
  var earliestStart = toMin(sorted[0].label);
  var lastMainEnd = 0;
  sorted.forEach(function (s) {
    var d = Number(s.mainDuration) || MAIN_DURATION_DEFAULT;
    var e = toMin(s.label) + d;
    if (e > lastMainEnd) lastMainEnd = e;
  });

  var dayStart = dc.dayStart ? toMin(dc.dayStart) : earliestStart;
  var dayClose = dc.dayClose ? toMin(dc.dayClose) : lastMainEnd;
  if (dayClose <= dayStart) dayClose = dayStart + dur;

  var grid = [];
  for (var s = dayStart; s + dur <= dayClose; s += dur) {
    var slot = {
      start: s,
      end: s + dur,
      label: toHHMM(s),
      capacity: teachers,
      blockedByMain: [],
    };
    sessions.forEach(function (sess) {
      var mDur = Number(sess.mainDuration) || MAIN_DURATION_DEFAULT;
      var buf = Number(sess.bufferMinutes) || 0;
      var mStart = toMin(sess.label) - buf;
      var mEnd = toMin(sess.label) + mDur + buf;
      // Overlap of [s, s+dur] and [mStart, mEnd]
      if (slot.start < mEnd && slot.end > mStart) {
        slot.blockedByMain.push(sess.id);
      }
    });
    slot.poolId = speakPoolId(slot.label);
    slot.available = slot.blockedByMain.length === 0 && slot.capacity > 0;
    grid.push(slot);
  }
  return grid;
}

// Slots valid for a student whose chosen main session is `mainId`.
function validSpeakingSlots(mainId, sessions, dc) {
  return buildSpeakingGrid(sessions, dc).filter(function (g) {
    return g.capacity > 0 && g.blockedByMain.indexOf(mainId) === -1;
  });
}

// Remaining seats for a speaking pool id (live seats map).
function speakPoolRemaining(poolId) {
  if (seats[poolId] !== undefined) return Number(seats[poolId]);
  // Default to capacity from current SLOTS config.
  return SLOTS.length ? Math.max(0, Number(SLOTS[0].teachers) || 0) : 0;
}

// Returns estimated schedule for a student. In the new flow speakTime is
// the explicitly chosen 15-min slot label; this helper just packages it
// alongside the session's main start time.
function calcSchedule(slotId, speakLabel) {
  var si = SLOTS.find(function (s) {
    return s.id === slotId;
  });
  if (!si) return null;
  return {
    mainTime: si.label,
    speakTime: speakLabel || null,
  };
}
function poolId(slotId, et) {
  // Legacy helper retained for the change-slot flow. With the new model the
  // main pool is just the slot id; speaking pools are addressed via speakPoolId.
  if (et === "speaking") return slotId + SPEAKING_SUFFIX;
  return slotId;
}
function isMSSession(slotId) {
  if (registrationMode !== "main_speaking") return false;
  var s = SLOTS.find(function (sl) {
    return sl.id === slotId;
  });
  if (!s) return false;
  return Number(s.teachers) > 0;
}

// --- Input handlers ---
function attachNameHandler() {
  var el = document.getElementById("inp-name");
  if (!el) return;
  el.addEventListener("input", function () {
    var hasCyrillic = /[\u0400-\u04FF]/.test(el.value);
    var clean = el.value.replace(/[^a-zA-Z '\-]/g, "");
    if (el.value !== clean) el.value = clean;
    form.name = clean;
    delete errors.name;
    var errEl = document.getElementById("err-name");
    if (errEl) errEl.remove();
    el.classList.remove("error");
    // Show Cyrillic warning
    var hint = document.getElementById("name-cyrillic-hint");
    if (hasCyrillic) {
      if (!hint) {
        hint = document.createElement("div");
        hint.id = "name-cyrillic-hint";
        hint.style.cssText = "font-size:12px;color:#BA7517;margin-top:5px";
        hint.textContent =
          "Please use Latin letters only (e.g. Amir, not Амир)";
        el.parentNode.insertBefore(hint, el.nextSibling);
      }
    } else {
      if (hint) hint.remove();
    }
  });
}

function attachPhoneHandler() {
  var el = document.getElementById("inp-phone");
  if (!el) return;
  el.addEventListener("keydown", function (e) {
    if ([8, 9, 37, 38, 39, 40, 46, 35, 36].indexOf(e.keyCode) !== -1) return;
    if (e.ctrlKey || e.metaKey) return;
    if (e.key.length === 1 && !/\d/.test(e.key)) e.preventDefault();
  });
  el.addEventListener("input", function () {
    var digits = el.value.replace(/\D/g, "").slice(0, 9);
    var formatted = "";
    if (digits.length > 0) formatted = digits.slice(0, 2);
    if (digits.length > 2) formatted += "-" + digits.slice(2, 5);
    if (digits.length > 5) formatted += "-" + digits.slice(5, 7);
    if (digits.length > 7) formatted += "-" + digits.slice(7, 9);
    el.value = formatted;
    form.phone = formatted;
    delete errors.phone;
    var errEl = document.getElementById("err-phone");
    if (errEl) errEl.remove();
    el.classList.remove("error");
  });
}

// --- API ---
async function loadSeats() {
  // Load session config FIRST so VALID_SLOT_IDS is correct before filtering seat rows
  await loadSessionConfig();
  await loadDeadline();
  normalizeDayConfig();

  try {
    var res = await fetch(API + "?sheet=Seats");
    if (!res.ok) throw new Error("Seats API error " + res.status);
    var rows = await res.json();
    if (!Array.isArray(rows))
      throw new Error("Unexpected response from Seats sheet");
    rows.forEach(function (row) {
      var rawId = row["Slot"] || row["slot"];
      if (!rawId) return;
      var rem =
        row["Remaining"] !== undefined ? row["Remaining"] : row["remaining"];
      // Map legacy ids to new namespace on read so old KV/Sheets data keeps working.
      var id = normalizeSlotId(rawId);
      var isMain = VALID_SLOT_IDS.indexOf(id) !== -1;
      var isSpeak = id.indexOf("speak_") === 0;
      // Legacy speaking pool rows (`slot_NNNN_speaking`) — fold into main remaining as
      // a sanity floor; the new flow doesn't use a per-session speaking pool.
      var isLegacySpeak =
        typeof rawId === "string" && rawId.indexOf(SPEAKING_SUFFIX) !== -1;
      if ((isMain || isSpeak) && rem !== undefined) {
        seats[id] = Math.max(0, Math.min(getMaxSeats(id), Number(rem)));
      } else if (isLegacySpeak && rem !== undefined) {
        seats[rawId] = Math.max(0, Number(rem));
      }
    });
    loadError = false;
  } catch (e) {
    loadError = true;
    loadErrorMsg = e.message || String(e);
  }

  // If already registered, verify if it is still valid or has been auto-cancelled
  var existing = getRegistration();
  if (existing) {
    var UZT_OFFSET_MS = 5 * 60 * 60 * 1000;
    var now = new Date();
    var nowUZT = new Date(now.getTime() + UZT_OFFSET_MS);
    var isOver = false;
    if (testDate) {
      var testDateUZT = new Date(testDate.getTime() + UZT_OFFSET_MS);
      isOver = (
        (nowUZT.getFullYear() > testDateUZT.getFullYear()) ||
        (nowUZT.getFullYear() === testDateUZT.getFullYear() && nowUZT.getMonth() > testDateUZT.getMonth()) ||
        (nowUZT.getFullYear() === testDateUZT.getFullYear() && nowUZT.getMonth() === testDateUZT.getMonth() && nowUZT.getDate() > testDateUZT.getDate())
      );
    }
    if (isOver) {
      clearRegistration();
      existing = null;
      step = 1;
    } else {
      // Test is not over, check if the registration actually exists in the database
      try {
        var cleanPhone = existing.phone.replace(/\D/g, "");
        var verifyPhone = "998" + cleanPhone;
        var verifyRes = await fetch(
          API + "/search?sheet=Registrations&Phone=" + encodeURIComponent(verifyPhone)
        );
        if (verifyRes.ok) {
          var verifyRows = await verifyRes.json();
          if (!Array.isArray(verifyRows) || verifyRows.length === 0) {
            // Registration not found on server (e.g. database cleared / cleaned up)
            clearRegistration();
            existing = null;
            step = 1;
          } else {
            // Update local storage with the latest data from server to keep them in sync
            var serverReg = verifyRows.find(function (r) {
              var rName = String(r.Name || r.name || "").trim().toLowerCase();
              var eName = String(existing.name || "").trim().toLowerCase();
              return rName === eName;
            }) || verifyRows[0];
            var matchedSlot = SLOTS.find(function (s) {
              return s.label === serverReg.Session || sheetTime(s.label) === serverReg.Session;
            });
            var updatedRegData = {
              name: serverReg.Name || serverReg.name || existing.name,
              phone: existing.phone,
              slotId: matchedSlot ? matchedSlot.id : existing.slotId,
              slotLabel: serverReg.Session || existing.slotLabel,
              school: serverReg.School || serverReg.school || existing.school,
              candidateNumber: serverReg.CandidateNumber || serverReg.candidatenumber || existing.candidateNumber,
            };
            var serverEt = serverReg.ExamType || serverReg.examtype;
            if (serverEt) {
              updatedRegData.examType = String(serverEt).toLowerCase() === "speaking" ? "speaking" : "main";
            } else if (existing.examType) {
              updatedRegData.examType = existing.examType;
            }
            var serverSpeak = serverReg.SpeakingTime || serverReg.speakingtime;
            if (serverSpeak) updatedRegData.speakTime = serverSpeak;
            var serverMain = serverReg.MainTime || serverReg.maintime;
            if (serverMain) updatedRegData.mainTime = serverMain;

            saveRegistration(updatedRegData);
            existing = updatedRegData;
            step = 3;
          }
        } else {
          // If server fails (e.g. 500 error), keep local registration as fallback
          step = 3;
        }
      } catch (e) {
        // Network error, fallback to keeping local registration to be safe when offline
        step = 3;
      }
    }
  } else {
    step = 1;
  }
  render();
}

async function addRegistration(payload) {
  var res = await fetch(API + "?sheet=Registrations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: payload }),
  });
  if (!res.ok) {
    var errObj = {};
    try {
      errObj = await res.json();
    } catch (e) {}
    if (errObj.error === "DUPLICATE_PHONE") throw new Error("DUPLICATE_PHONE");
    throw new Error("API error " + res.status);
  }
  try {
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function getLiveSeatCount(slotId) {
  // Use /search endpoint — named sheets require ?sheet= with search, not column/value
  var res = await fetch(
    API + "/search?sheet=Seats&Slot=" + encodeURIComponent(slotId),
  );
  if (!res.ok) throw new Error("Seat fetch error " + res.status);
  var rows = await res.json();
  // For speaking-grid pools we auto-provision on first use: missing row == full capacity.
  if (!Array.isArray(rows) || !rows.length) {
    if (typeof slotId === "string" && slotId.indexOf("speak_") === 0) {
      return getMaxSeats(slotId);
    }
    throw new Error("No seat row found for " + slotId);
  }
  var rem =
    rows[0]["Remaining"] !== undefined
      ? rows[0]["Remaining"]
      : rows[0]["remaining"];
  return Math.max(0, Math.min(getMaxSeats(slotId), Number(rem)));
}

async function updateSeat(slotId, delta) {
  // delta: -1 to decrement, +1 to return a seat
  var liveCount = await getLiveSeatCount(slotId);
  if (delta < 0 && liveCount <= 0) {
    throw new Error("Seat already taken");
  }
  var newVal = Math.max(0, Math.min(getMaxSeats(slotId), liveCount + delta));
  // Detect whether the row exists. If not (speaking-grid pools may be lazy),
  // POST a fresh row; otherwise PATCH.
  var rowExists = seats[slotId] !== undefined;
  if (!rowExists) {
    // Probe once more — getLiveSeatCount returned default for missing speak_* rows,
    // so we don't know definitively. Just try a POST and fall back to PATCH on conflict.
    var postRes = await fetch(API + "?sheet=Seats", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
      body: JSON.stringify({ data: { Slot: slotId, Remaining: newVal } }),
    });
    if (!postRes.ok && postRes.status !== 409) {
      // Some backends 200 on overwrite — treat any non-409 non-2xx as fatal.
      throw new Error("Seat API error " + postRes.status);
    }
    seats[slotId] = newVal;
    return;
  }
  var res = await fetch(
    API + "/Slot/" + encodeURIComponent(slotId) + "?sheet=Seats",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { Remaining: newVal } }),
    },
  );
  if (!res.ok) throw new Error("Seat API error " + res.status);
  seats[slotId] = newVal;
}

async function restoreOldSeat(slotId) {
  // Fetch live value from sheet before restoring — avoids stale local memory bug
  var liveCount = await getLiveSeatCount(slotId);
  var newVal = Math.min(getMaxSeats(slotId), liveCount + 1);
  var res = await fetch(
    API + "/Slot/" + encodeURIComponent(slotId) + "?sheet=Seats",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { Remaining: newVal } }),
    },
  );
  if (!res.ok) throw new Error("Seat restore error " + res.status);
  seats[slotId] = newVal;
}

// Generic PATCH for any fields on a registration row matched by phone
async function updateRegistrationRecord(phone, fields) {
  var res = await fetch(
    API + "/Phone/" + phonePathSeg(phone) + "?sheet=Registrations",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: fields }),
    },
  );
  if (!res.ok) throw new Error("Update record error " + res.status);
}

async function updateRegistrationSlot(
  phone,
  newSlotLabel,
  newExamType,
  newSpeakTime,
  newMainTime,
) {
  var payload = { Session: sheetTime(newSlotLabel) };
  if (newExamType)
    payload.ExamType = newExamType === "speaking" ? "Speaking" : "Main";
  if (newSpeakTime !== undefined) payload.SpeakingTime = newSpeakTime || "";
  if (newMainTime !== undefined) payload.MainTime = newMainTime || "";
  var res = await fetch(
    API + "/Phone/" + phonePathSeg(phone) + "?sheet=Registrations",
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: payload }),
    },
  );
  if (!res.ok) throw new Error("Update API error " + res.status);
}

// New model assigns explicit speaking times at registration, so there's no
// queue to recompute after a cancellation. This is a no-op shim that keeps
// the old call sites working.
async function recalculateSpeakingTimes(slotId) { /* no-op in new model */ }

// LEGACY queue-recalculation kept under a different name in case we ever need
// to migrate old data — never called.
async function recalculateSpeakingTimes_LEGACY(slotId) {
  var si = SLOTS.find(function (s) {
    return s.id === slotId;
  });
  if (!si) return;
  var teachers = Math.max(1, si.teachers || 1);
  var start = toMin(si.label);
  // Google Sheets may auto-convert "HH:MM" session labels to decimal fractions.
  // Fetch ALL registrations and filter client-side to handle both formats.
  var sessionDecimal = toMin(si.label) / (24 * 60);

  // Process speaking-first pool
  try {
    var sRes = await fetch(API + "?sheet=Registrations");
    if (sRes.ok) {
      var rawRegs = await sRes.json();
      if (Array.isArray(rawRegs)) {
        // Filter: match by session label string OR by Sheets decimal value
        var allRegs = rawRegs.filter(function (r) {
          var raw = String(r.Session || r.session || "")
            .trim()
            .replace(",", ".");
          // Strip sheetTime suffix before comparing
          var s = raw.replace(/ \(est\.\)$/, "").trim();
          if (s === si.label) return true;
          var n = parseFloat(s);
          return !isNaN(n) && Math.abs(n - sessionDecimal) < 0.00002;
        });
        if (!allRegs.length) return;
        // Filter and sort speaking-first by registration timestamp
        var speakStudents = allRegs.filter(function (r) {
          var et = r.ExamType || r.examtype || "";
          return et.toLowerCase() === "speaking";
        });
        speakStudents.sort(function (a, b) {
          return (
            new Date(a.Timestamp || a.timestamp || 0) -
            new Date(b.Timestamp || b.timestamp || 0)
          );
        });
        for (var i = 0; i < speakStudents.length; i++) {
          var offset = Math.floor(i / teachers) * SPEAK_DURATION;
          var newSpeak = toHHMM(start + offset);
          var newMain = toHHMM(start + MAIN_DURATION + SPEAKING_GAP);
          var ph = speakStudents[i].Phone || speakStudents[i].phone || "";
          if (ph) {
            try {
              await fetch(
                API + "/Phone/" + phonePathSeg(ph) + "?sheet=Registrations",
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    data: {
                      SpeakingTime: sheetTime(newSpeak),
                      MainTime: sheetTime(newMain),
                    },
                  }),
                },
              );
            } catch (e2) {}
          }
        }

        // Filter and sort main-first by registration timestamp
        var mainStudents = allRegs.filter(function (r) {
          var et = r.ExamType || r.examtype || "";
          return et.toLowerCase() === "main";
        });
        mainStudents.sort(function (a, b) {
          return (
            new Date(a.Timestamp || a.timestamp || 0) -
            new Date(b.Timestamp || b.timestamp || 0)
          );
        });
        for (var j = 0; j < mainStudents.length; j++) {
          var offset2 = Math.floor(j / teachers) * SPEAK_DURATION;
          var newSpeak2 = toHHMM(start + MAIN_DURATION + SPEAKING_GAP + offset2);
          var ph2 = mainStudents[j].Phone || mainStudents[j].phone || "";
          if (ph2) {
            try {
              await fetch(
                API + "/Phone/" + phonePathSeg(ph2) + "?sheet=Registrations",
                {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    data: {
                      SpeakingTime: sheetTime(newSpeak2),
                      MainTime: sheetTime(toHHMM(start)),
                    },
                  }),
                },
              );
            } catch (e2) {}
          }
        }
      }
    }
  } catch (e) {}
}

// --- Helpers ---
function readFormFromDOM() {
  var nameEl = document.getElementById("inp-name");
  var phoneEl = document.getElementById("inp-phone");
  if (nameEl) form.name = nameEl.value;
  if (phoneEl) form.phone = phoneEl.value;
}
function barColor(r, max) {
  var m = max || MAX;
  return r === 0
    ? "#e05a5a"
    : r <= Math.max(1, Math.ceil(m * 0.2))
      ? "#e0943a"
      : "#3dbd8b";
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
// Escape for inline JS strings inside onclick attributes
function scr(s) {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}
// Append " (est.)" so Google Sheets treats the value as plain text, not a time decimal
function sheetTime(t) {
  return t ? t + " (est.)" : "";
}
// encodeURIComponent encodes '+' as '%2B' — SheetDB URL-path matching won't decode that,
// so phone lookups silently find nothing. Keep '+' as a literal in path segments.
function phonePathSeg(phone) {
  return encodeURIComponent(phone).replace(/%2B/gi, "+");
}
// --- Helpers for Daylight Theme ---
function getDoorsOpenTime(label) {
  var parts = label.split(":");
  if (parts.length === 2) {
    var h = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 15;
    if (m < 0) {
      m += 60;
      h -= 1;
    }
    if (h < 0) {
      h += 24;
    }
    var hStr = h < 10 ? "0" + h : h;
    var mStr = m < 10 ? "0" + m : m;
    return "Doors open at " + hStr + ":" + mStr;
  }
  return "";
}

function renderProgressBar(activeStep) {
  // Show 3 steps whenever any session has speaking enabled in main_speaking mode,
  // so the user sees the full path before picking a session.
  var anyMS = registrationMode === "main_speaking" && SLOTS.some(function (s) {
    return Number(s.teachers) > 0;
  });
  var hasSpeakStep = form.slot
    ? registrationMode === "main_speaking" && isMSSession(form.slot)
    : anyMS;
  var labels = "";
  var widthPct = 0;

  if (hasSpeakStep) {
    if (activeStep === 1) {
      labels = '<span class="current">1 · Session</span><span>2 · Speaking</span><span>3 · Details</span>';
      widthPct = 33;
    } else if (activeStep === 6) {
      labels = '<span>1 · Session</span><span class="current">2 · Speaking</span><span>3 · Details</span>';
      widthPct = 66;
    } else { // step 2
      labels = '<span>1 · Session</span><span>2 · Speaking</span><span class="current">3 · Details</span>';
      widthPct = 100;
    }
  } else {
    if (activeStep === 1) {
      labels = '<span class="current">1 · Session</span><span>2 · Details</span>';
      widthPct = 50;
    } else {
      labels = '<span>1 · Session</span><span class="current">2 · Details</span>';
      widthPct = 100;
    }
  }

  return (
    '<div class="dl-progress-wrap">' +
    '<div class="dl-progress-labels">' + labels + '</div>' +
    '<div class="dl-progress">' +
    '<div class="dl-progress-fill" style="width:' + widthPct + '%"></div>' +
    '</div>' +
    '</div>'
  );
}

// --- Render functions ---
function renderStep1() {
  // Deadline enforcement
  if (isRegistrationClosed()) {
    return (
      '<div class="deadline-banner">' +
      "<strong>Registration is closed.</strong><br>" +
      "The deadline was " +
      formatDeadline(deadline) +
      "." +
      "</div>"
    );
  }
  var errBanner = loadError
    ? '<div class="err-banner">Could not load seat data — ' +
      esc(loadErrorMsg || "please refresh the page") +
      '. <a href="javascript:location.reload()" style="color:inherit;text-decoration:underline">Refresh</a></div>'
    : "";
  // Countdown banner if deadline is within 24 hours
  var countdownHtml = "";
  if (deadline) {
    var msLeft = deadline - new Date();
    if (msLeft > 0 && msLeft < COUNTDOWN_THRESHOLD_MS) {
      var hLeft = Math.floor(msLeft / MS_PER_HOUR);
      var mLeft = Math.floor((msLeft % MS_PER_HOUR) / MS_PER_MINUTE);
      var sLeft = Math.floor((msLeft % MS_PER_MINUTE) / 1000);
      var timeStr =
        hLeft > 0
          ? hLeft + "h " + mLeft + "m"
          : mLeft > 0
            ? mLeft + "m " + sLeft + "s"
            : sLeft + "s";
      countdownHtml =
        '<div class="countdown-banner">Registration closes in <strong>' +
        timeStr +
        "</strong> (" +
        formatDeadline(deadline) +
        ")</div>";
    }
  }
  
  var progressHtml = renderProgressBar(1);
  
  var cards = SLOTS.map(function (s) {
    var mainRem = seats[s.id] !== undefined ? Number(seats[s.id]) : getMaxSeats(s.id);
    var rem = mainRem;
    var slotMax = getMaxSeats(s.id);
    var urgentThreshold = Math.max(1, Math.ceil(slotMax * 0.2));
    var isFull = rem <= 0;
    var isSel = form.slot === s.id;
    var isUrgent = rem <= urgentThreshold && !isFull;
    var cls = ["time-card", isFull ? "full" : "", isSel ? "selected" : "", !hasAnimatedCards ? "animate-in" : "", isUrgent ? "urgent" : ""]
      .filter(Boolean)
      .join(" ");
      
    // Doors open time (15 mins before label)
    var doorsTimeStr = getDoorsOpenTime(s.label);
    
    // Badge styling and text
    var badgeClass = "time-card-badge";
    var badgeText = s.period;
    if (isFull) {
      badgeClass += " full";
      badgeText = "Full";
    } else if (isUrgent) {
      badgeClass += " urgent";
      badgeText = "Almost full";
    }
    
    var badgeHtml = '<span class="' + badgeClass + '">' + badgeText + '</span>';
    
    // Count html text
    var countHtml = isFull 
      ? '<strong>0</strong> / ' + slotMax + ' seats'
      : '<strong>' + rem + '</strong> / ' + slotMax + ' seats';
      
    // Capsule segments dots (taken dots are filled/taken, avail are empty/avail)
    var dotHtml = Array.from({ length: slotMax }, function (_, i) {
      return (
        '<div class="seat-dot ' +
        (i < slotMax - rem ? "taken" : "avail") +
        '"></div>'
      );
    }).join("");
    
    var onclick = isFull ? "" : "onclick=\"selectSlot('" + s.id + "')\"";
    
    return (
      '<div class="' + cls + '" ' + onclick + '>' +
      '<span class="time-card-radio"></span>' +
      '<div class="time-card-content">' +
      '<div class="time-card-title-row">' +
      '<div class="time-label">' + s.label + '</div>' +
      badgeHtml +
      '</div>' +
      '<div class="time-card-period">' + doorsTimeStr + '</div>' +
      '</div>' +
      '<div class="time-card-meter">' +
      '<div class="time-card-count">' + countHtml + '</div>' +
      '<div class="seat-dots">' + dotHtml + '</div>' +
      '</div>' +
      '</div>'
    );
  }).join("");
  
  var canNext = form.slot && (seats[form.slot] === undefined || seats[form.slot] > 0);
  return (
    countdownHtml +
    errBanner +
    progressHtml +
    '<div class="section-label">Select test session</div>' +
    '<div class="time-grid">' +
    cards +
    "</div>" +
    '<button class="btn-primary" onclick="goNext()" ' +
    (canNext ? "" : "disabled") +
    ">" +
    "Continue" +
    '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" style="margin-left: 8px; vertical-align: middle;"><path d="M1 7h12m0 0L8 2m5 5l-5 5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
    "</button>" +
    (errors.slot
      ? '<div class="error-msg" style="text-align:center;margin-top:8px">' +
        errors.slot +
        "</div>"
      : "")
  );
}

// --- Render step 6: speaking-time grid ---
function renderSpeakingGrid() {
  var si = SLOTS.find(function (s) {
    return s.id === form.slot;
  });
  if (!si) {
    step = 1;
    return renderStep1();
  }
  var grid = buildSpeakingGrid(SLOTS, dayConfig);
  var teachers = Math.max(0, Number(si.teachers) || 0);
  var mDur = Number(si.mainDuration) || MAIN_DURATION_DEFAULT;
  var mainStart = toMin(si.label);
  var mainEnd = mainStart + mDur;

  var cells = grid.map(function (g) {
    var rem = seats[g.poolId] !== undefined ? Number(seats[g.poolId]) : g.capacity;
    var blocksMe = g.blockedByMain.indexOf(si.id) !== -1;
    var isFull = rem <= 0;
    var isSelected = form.speak === g.label;
    var disabled = blocksMe || isFull || g.capacity <= 0;
    var reason = "";
    if (blocksMe) reason = "During your main exam";
    else if (isFull) reason = "Full";
    else if (g.capacity <= 0) reason = "No teachers";

    var cls = ["speak-cell"];
    if (disabled) cls.push("disabled");
    if (isSelected) cls.push("selected");
    if (blocksMe) cls.push("blocked");
    if (isFull) cls.push("full");

    var onclick = disabled ? "" : "onclick=\"selectSpeak('" + g.label + "')\"";
    var title = disabled ? ' title="' + esc(reason) + '"' : "";
    return (
      '<div class="' + cls.join(" ") + '"' + onclick + title + '>' +
      '<div class="speak-time">' + g.label + '</div>' +
      '<div class="speak-seats">' +
      (disabled
        ? esc(reason)
        : '<strong>' + rem + '</strong>/' + g.capacity + ' seat' + (g.capacity === 1 ? '' : 's')) +
      '</div>' +
      '</div>'
    );
  }).join("");

  var canNext = !!form.speak;
  var progressHtml = renderProgressBar(6);
  var summary =
    '<div class="selected-slot-recap"><div>' +
    '<div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">Main exam</div>' +
    '<div class="recap-time">' + esc(si.label) + ' &mdash; ends ' + toHHMM(mainEnd) + '</div></div>' +
    '<span class="recap-change" onclick="goBackToStep1()">Change</span></div>';

  var hint =
    '<div class="speak-hint">Pick a 15-min speaking slot. Greyed cells overlap your main exam, are full, or fall outside the day window. ' +
    (teachers > 0
      ? teachers + ' teacher' + (teachers === 1 ? '' : 's') + ' assess in parallel.'
      : 'Speaking is currently disabled (0 teachers).') +
    '</div>';

  return (
    progressHtml +
    summary +
    '<div class="section-label">Choose your speaking time</div>' +
    hint +
    '<div class="speak-grid">' + cells + '</div>' +
    '<button class="btn-primary" onclick="goSpeakNext()" ' + (canNext ? "" : "disabled") + '>Continue to details</button>' +
    '<button class="btn-secondary" onclick="goBackToStep1()">Back</button>'
  );
}

// --- Render step 5: exam type selection (legacy — kept for old data) ---
function renderExamType() {
  var si = SLOTS.find(function (s) {
    return s.id === form.slot;
  });
  if (!si) {
    step = 1;
    return renderStep1();
  }
  var mp = form.slot,
    sp = form.slot + SPEAKING_SUFFIX;
  var mr = seats[mp] !== undefined ? Number(seats[mp]) : 0;
  var sr = seats[sp] !== undefined ? Number(seats[sp]) : 0;
  var mm = getMaxSeats(mp),
    sm2 = getMaxSeats(sp);
  var mut = Math.max(1, Math.ceil(mm * 0.2));
  var sut = Math.max(1, Math.ceil(sm2 * 0.2));
  function sLabel(r, max, ut, cls) {
    if (r === 0) return '<div class="ec-seats fs">Full</div>';
    if (r <= ut)
      return (
        '<div class="ec-seats ' +
        cls +
        '">' +
        r +
        " seat" +
        (r === 1 ? "" : "s") +
        " left</div>"
      );
    return (
      '<div class="ec-seats ' + cls + '">' + r + " / " + max + " seats</div>"
    );
  }
  var mcOc = mr > 0 ? "onclick=\"selectET('main')\"" : "";
  var scOc = sr > 0 ? "onclick=\"selectET('speaking')\"" : "";
  var mc =
    '<div class="exam-card' +
    (mr === 0 ? " ec-full" : examType === "main" ? " ec-main" : "") +
    '" ' +
    mcOc +
    ">" +
    '<div class="ec-icon">&#x1F4BB;</div>' +
    '<div class="ec-name">Main Exam</div>' +
    '<div class="ec-desc">Listening + Reading + Writing<br>~150 min, then speaking</div>' +
    sLabel(mr, mm, mut, "ms") +
    "</div>";
  var sc =
    '<div class="exam-card' +
    (sr === 0 ? " ec-full" : examType === "speaking" ? " ec-speaking" : "") +
    '" ' +
    scOc +
    ">" +
    '<div class="ec-icon">&#x1F3A4;</div>' +
    '<div class="ec-name">Speaking First</div>' +
    '<div class="ec-desc">Speaking assessment first,<br>then main exam</div>' +
    sLabel(sr, sm2, sut, "ss") +
    "</div>";
  var canCont = examType && (examType === "main" ? mr > 0 : sr > 0);
  var progressHtml = renderProgressBar(5);
  return (
    progressHtml +
    '<div class="section-label">Choose exam type — ' +
    esc(si.label) +
    "</div>" +
    '<div class="exam-grid">' +
    mc +
    sc +
    "</div>" +
    '<button class="btn-primary" onclick="goToDetails()" ' +
    (canCont ? "" : "disabled") +
    ">Continue to details</button>" +
    '<button class="btn-secondary" onclick="goBackToStep1()">Back</button>'
  );
}

function renderStep2() {
  var slotInfo = SLOTS.find(function (s) {
    return s.id === form.slot;
  });
  // Guard: if slot is invalid redirect to step 1 instead of crashing
  if (!slotInfo) {
    step = 1;
    errors = {};
    return renderStep1();
  }
  // Schedule recap for Main+Speaking mode — shows the picked main + speaking times.
  var schedPill = "";
  var schedBoxHtml = "";
  if (registrationMode === "main_speaking" && isMSSession(form.slot) && form.speak) {
    var mainStart = toMin(slotInfo.label);
    var mDur = Number(slotInfo.mainDuration) || MAIN_DURATION_DEFAULT;
    var spkStart = toMin(form.speak);
    var ordering = spkStart < mainStart ? "Speaking first" : "Main first";
    schedPill = '<span class="recap-pill ' + (spkStart < mainStart ? "ps" : "pm") + '">' + ordering + '</span>';
    schedBoxHtml =
      '<div class="sched-box"><div class="sched-title">Your schedule</div>' +
      '<div class="sched-row"><span class="sched-label">Main exam</span><span class="sched-val mv">' +
      slotInfo.label + ' &ndash; ' + toHHMM(mainStart + mDur) +
      "</span></div>" +
      '<div class="sched-row"><span class="sched-label">Speaking slot</span><span class="sched-val sv">' +
      form.speak + ' &ndash; ' + toHHMM(spkStart + (Number(slotInfo.speakingDuration) || SPEAK_DURATION_DEFAULT)) +
      "</span></div>" +
      '<div class="sched-note">All seats are guaranteed — no overlap with your main exam.</div>' +
      "</div>";
  }
  var progressHtml = renderProgressBar(2);
  var ajSel = form.school === "adam_johns";
  var otSel = form.school === "other";
  return (
    progressHtml +
    '<div class="selected-slot-recap"><div>' +
    '<div style="font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin-bottom:3px">Selected session</div>' +
    '<div class="recap-time">' +
    slotInfo.label +
    " \u2014 " +
    slotInfo.period +
    schedPill +
    "</div></div>" +
    '<span class="recap-change" onclick="goBack()">Change</span></div>' +
    schedBoxHtml +
    '<div class="section-label">Your details</div>' +
    '<div class="field-group"><label class="field-label">Full name</label>' +
    '<input id="inp-name" class="field-input ' +
    (errors.name ? "error error-shake" : "") +
    '" type="text" value="' +
    esc(form.name) +
    '" placeholder="e.g. Amir Karimov" maxlength="80" autocomplete="name" />' +
    (errors.name
      ? '<div class="error-msg" id="err-name">' + errors.name + "</div>"
      : "") +
    "</div>" +
    '<div class="field-group"><label class="field-label">Phone number</label>' +
    '<div class="phone-wrap"><div class="phone-prefix">+998</div>' +
    '<input id="inp-phone" class="field-input ' +
    (errors.phone ? "error error-shake" : "") +
    '" type="tel" value="' +
    esc(form.phone) +
    '" placeholder="90-999-99-99" maxlength="12" style="flex:1" autocomplete="tel" /></div>' +
    (errors.phone
      ? '<div class="error-msg" id="err-phone">' + errors.phone + "</div>"
      : "") +
    "</div>" +
    '<div class="field-group" style="margin-top:1.25rem"><div class="section-label">Where do you study?</div>' +
    '<div class="radio-group">' +
    '<div class="radio-card ' +
    (ajSel ? "selected" : "") +
    '" data-val="adam_johns" onclick="setSchool(\'adam_johns\')"><div class="radio-circle ' +
    (ajSel ? "on" : "") +
    '"></div><span class="radio-text">Adam &amp; John\'s</span></div>' +
    '<div class="radio-card ' +
    (otSel ? "selected" : "") +
    '" data-val="other" onclick="setSchool(\'other\')"><div class="radio-circle ' +
    (otSel ? "on" : "") +
    '"></div><span class="radio-text">Other school</span></div>' +
    "</div>" +
    (errors.school
      ? '<div class="error-msg" id="err-school">' + errors.school + "</div>"
      : "") +
    "</div>" +
    '<button class="btn-primary" onclick="submitForm()" ' +
    (submitting ? "disabled" : "") +
    ">" +
    (submitting ? "Registering\u2026" : "Complete registration") +
    "</button>" +
    '<button class="btn-secondary" onclick="goBack()">Back</button>'
  );
}

function renderManage() {
  var reg = getRegistration();
  if (!reg) {
    step = 1;
    return renderStep1();
  }
  var tgPhone = (reg.phone || '').replace(/\D/g, '');
  var tgLink = 'https://t.me/ajmockbot?start=998' + tgPhone;
  return (
    '<div class="success-screen">' +
    '<div class="confetti-wrap"><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div><div class="confetti-dot"></div></div>' +
    '<div class="success-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#3dbd8b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></div>' +
    '<div class="manage-title">You&#39;re registered!</div>' +
    '<div class="manage-sub">Your spot is confirmed. Arrive 10 minutes early with your student ID.</div>' +
    '<div class="booking-card">' +
    '<div class="booking-row"><span class="booking-row-label">Candidate No.</span><span class="booking-row-val" style="font-weight:700;color:var(--primary)">' +
    esc(reg.candidateNumber || reg.CandidateNumber || reg.candidatenumber || 'N/A') +
    '</span></div>' +
    '<div class="booking-row"><span class="booking-row-label">Name</span><span class="booking-row-val">' +
    esc(reg.name) +
    "</span></div>" +
    '<div class="booking-row"><span class="booking-row-label">Session</span><span class="booking-row-val">' +
    esc(reg.slotLabel) +
    "</span></div>" +
    (reg.examType
      ? '<div class="booking-row"><span class="booking-row-label">Exam type</span><span class="booking-row-val" style="color:' +
        (reg.examType === "speaking" ? "var(--speak)" : "var(--main)") +
        '">' +
        (reg.examType === "speaking" ? "Speaking First" : "Main") +
        "</span></div>"
      : "") +
    (reg.speakTime
      ? '<div class="booking-row"><span class="booking-row-label">Speaking time</span><span class="booking-row-val" style="color:var(--speak)">' +
        esc(reg.speakTime) +
        ' <span style="font-weight:400;font-size:12px;color:var(--muted)">(est.)</span></span></div>'
      : "") +
    (reg.mainTime
      ? '<div class="booking-row"><span class="booking-row-label">' +
        (reg.examType === "speaking" ? "Main exam" : "Main exam") +
        ' time</span><span class="booking-row-val" style="color:var(--main)">' +
        esc(reg.mainTime) +
        ' <span style="font-weight:400;font-size:12px;color:var(--muted)">(est.)</span></span></div>'
      : "") +
    '<div class="booking-row"><span class="booking-row-label">Phone</span><span class="booking-row-val">+998 ' +
    esc(reg.phone) +
    "</span></div>" +
    '<div class="booking-row"><span class="booking-row-label">School</span><span class="booking-row-val">' +
    esc(reg.school) +
    "</span></div>" +
    "</div>" +
    '<div id="tg-reminder-card" style="display:flex;align-items:center;gap:12px;background:rgba(36,161,222,0.1);border:1px solid rgba(36,161,222,0.2);border-radius:12px;padding:14px 16px;margin:16px 0">' +
    '<div style="font-size:22px;flex-shrink:0">&#128172;</div>' +
    '<div style="flex:1">' +
    '<div style="font-size:14px;font-weight:600;color:#24a1de">Get Telegram Reminders</div>' +
    '<div style="font-size:12px;color:var(--muted);margin-top:3px">We&#39;ll message you the evening before your test</div>' +
    '</div>' +
    '<a href="' + tgLink + '" target="_blank" rel="noopener" style="display:inline-block;background:#24a1de;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;text-decoration:none;white-space:nowrap">Open Bot</a>' +
    '</div>' +
    (isRegistrationClosed()
      ? '<div class="deadline-warning">' +
        '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>' +
        '<span>Registration deadline has passed &mdash; session changes are no longer available.</span>' +
        '</div>' +
        '<button class="btn-green" disabled style="opacity:0.45;cursor:not-allowed">Change my session</button>' +
        ''
      : '<button class="btn-green" onclick="goChangeSlot()" ' +
        (submitting ? "disabled" : "") +
        ">Change my session</button>") +
    "" +
    (isRegistrationClosed()
      ? '<button class="btn-danger" disabled style="opacity:0.45;cursor:not-allowed">Cancel my registration</button>'
      : '<button class="btn-danger" onclick="cancelRegistration()" ' +
        (submitting ? "disabled" : "") +
        ">Cancel my registration</button>") +
    "</div>"
  );
}

function renderChangeSlot() {
  var reg = getRegistration();
  // FIX: Guard against null reg (e.g. localStorage cleared mid-session)
  if (!reg) {
    step = 1;
    return renderStep1();
  }
  var errBanner = loadError
    ? '<div class="err-banner">Could not load live seat data — please refresh.</div>'
    : "";
  var cards = SLOTS.map(function (s) {
    var rem = seats[s.id] !== undefined ? Number(seats[s.id]) : getMaxSeats(s.id);
    var slotMax = getMaxSeats(s.id);
    var urgentThreshold = Math.max(1, Math.ceil(slotMax * 0.2));
    var isMine = s.id === reg.slotId;
    var isFull = rem === 0 && !isMine;
    var isSel = newSlotChoice === s.id;
    var isUrgent = rem <= urgentThreshold && !isFull && !isMine;
    var cls = [
      "time-card",
      isFull ? "full" : "",
      isSel ? "selected" : "",
      isMine ? "mine" : "",
      isUrgent ? "urgent" : "",
    ]
      .filter(Boolean)
      .join(" ");

    // Doors open time (15 mins before label)
    var doorsTimeStr = getDoorsOpenTime(s.label);

    // Badge styling and text
    var badgeClass = "time-card-badge";
    var badgeText = s.period;
    if (isMine) {
      badgeClass += " mine";
      badgeText = "Your current slot";
    } else if (isFull) {
      badgeClass += " full";
      badgeText = "Full";
    } else if (isUrgent) {
      badgeClass += " urgent";
      badgeText = "Almost full";
    }
    
    var badgeHtml = '<span class="' + badgeClass + '">' + badgeText + '</span>';

    // Count html text
    var countHtml = isMine
      ? '<strong>' + rem + '</strong> / ' + slotMax + ' seats'
      : isFull
        ? '<strong>0</strong> / ' + slotMax + ' seats'
        : '<strong>' + rem + '</strong> / ' + slotMax + ' seats';

    // Capsule segments dots (taken dots are filled/taken, avail are empty/avail)
    var dotHtml = Array.from({ length: slotMax }, function (_, i) {
      return (
        '<div class="seat-dot ' +
        (i < slotMax - rem ? "taken" : "avail") +
        '"></div>'
      );
    }).join("");

    var onclick =
      isFull || isMine ? "" : "onclick=\"selectNewSlot('" + s.id + "')\"";

    return (
      '<div class="' + cls + '" ' + onclick + '>' +
      '<span class="time-card-radio"></span>' +
      '<div class="time-card-content">' +
      '<div class="time-card-title-row">' +
      '<div class="time-label">' + s.label + '</div>' +
      badgeHtml +
      '</div>' +
      '<div class="time-card-period">' + doorsTimeStr + '</div>' +
      '</div>' +
      '<div class="time-card-meter">' +
      '<div class="time-card-count">' + countHtml + '</div>' +
      '<div class="seat-dots">' + dotHtml + '</div>' +
      '</div>' +
      '</div>'
    );
  }).join("");
  var canConfirm =
    newSlotChoice && newSlotChoice !== reg.slotId &&
    (seats[newSlotChoice] === undefined || seats[newSlotChoice] > 0);
  return (
    errBanner +
    '<div class="change-slot-title">Change your session</div>' +
    '<div class="change-slot-sub">Your current slot is highlighted in green. Pick a new one below.</div>' +
    '<div class="section-label">Available sessions</div>' +
    '<div class="time-grid">' +
    cards +
    "</div>" +
    '<button class="btn-green" onclick="confirmChangeSlot()" ' +
    (canConfirm && !submitting ? "" : "disabled") +
    ">" +
    (submitting ? "Saving\u2026" : "Confirm new session") +
    "</button>" +
    '<button class="btn-secondary" onclick="step=3;newSlotChoice=null;render()">Cancel</button>'
  );
}

function render() {
  // Push state to history so mobile back button works properly
  if (!history.state || history.state.step !== step) {
    history.pushState({ step: step }, "", "#step" + step);
  }

  var el = document.getElementById("main");
  var html = "";
  if (step === 1) {
    html = renderStep1();
    if (!hasAnimatedCards) {
      hasAnimatedCards = true;
    }
  }
  else if (step === 5) html = renderExamType();
  else if (step === 6) html = renderSpeakingGrid();
  else if (step === 2) {
    html = renderStep2();
  } else if (step === 3) html = renderManage();
  else if (step === 4) html = renderChangeSlot();
  else if (step === 99) {
    html = adminAuthenticated
      ? renderAdminPanelHTML()
      : renderAdminLoginHTML();
  } else {
    step = 1;
    html = renderStep1();
  }

  // Wrap in step-view-container for premium view transitions!
  var stepChanged = (prevStep !== step);
  prevStep = step;
  var containerClass = "step-view-container" + (stepChanged ? " animate-step" : "");
  el.innerHTML = '<div class="' + containerClass + '">' + html + '</div>';

  if (step === 2) {
    attachNameHandler();
    attachPhoneHandler();
  } else if (step === 99 && !adminAuthenticated) {
    setTimeout(function () {
      var inp = document.getElementById("admin-pw-input");
      if (inp) {
        inp.focus();
        inp.onkeydown = function (e) {
          if (e.key === "Enter") adminLogin();
        };
      }
    }, 50);
  }

  // Admin FAB: show on non-admin screens when authenticated
  updateAdminFab();
}

function updateAdminFab() {
  var existing = document.getElementById("admin-fab");
  if (adminAuthenticated && step !== 99) {
    if (!existing) {
      var fab = document.createElement("button");
      fab.id = "admin-fab";
      fab.className = "admin-fab";
      fab.innerHTML = '&#9881; Admin';
      fab.onclick = function () { step = 99; render(); };
      document.body.appendChild(fab);
    }
  } else if (existing) {
    existing.remove();
  }
}

// --- Toast Notification System ---
function showToast(message, type) {
  type = type || "info";
  var container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    document.body.appendChild(container);
  }
  var toast = document.createElement("div");
  toast.className = "toast " + type;
  var icon = type === "success" ? "&#10003;" : type === "error" ? "&#10007;" : "&#8505;";
  toast.innerHTML = '<span>' + icon + '</span><span>' + message + '</span>';
  container.appendChild(toast);
  setTimeout(function () {
    toast.classList.add("toast-out");
    setTimeout(function () { toast.remove(); }, 300);
  }, 3000);
}

// --- Escape key handler ---
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape" && step === 99) {
    step = 1;
    render();
  }
});

// --- Actions ---
function selectSlot(id) {
  if (VALID_SLOT_IDS.indexOf(id) === -1) return;
  form.slot = form.slot === id ? null : id;
  render();
}

function selectNewSlot(id) {
  if (VALID_SLOT_IDS.indexOf(id) === -1) return;
  newSlotChoice = id;
  render();
}

function goNext() {
  if (!form.slot) return;
  var slotAvail = seats[form.slot] === undefined ? true : seats[form.slot] > 0;
  if (!slotAvail) return;
  errors = {};
  if (isMSSession(form.slot)) {
    form.speak = null;
    step = 6;
  } else {
    examType = null;
    step = 2;
  }
  render();
}

function selectSpeak(label) {
  form.speak = form.speak === label ? null : label;
  render();
}

function goSpeakNext() {
  if (!form.speak || !form.slot) return;
  // Server is authoritative — but check the pool client-side for fast feedback.
  var pid = speakPoolId(form.speak);
  var rem = seats[pid] !== undefined ? Number(seats[pid]) : null;
  if (rem !== null && rem <= 0) {
    alert("Sorry, that speaking slot just filled up. Please choose another.");
    form.speak = null;
    render();
    return;
  }
  errors = {};
  step = 2;
  render();
}
async function goToDetails() {
  if (!examType) return;
  var reg = getRegistration();
  // Already registered for this exact slot with a DIFFERENT exam type → perform switch
  if (
    reg &&
    reg.slotId === form.slot &&
    reg.examType &&
    reg.examType !== examType
  ) {
    await doExamTypeSwitch(reg, examType);
    return;
  }
  // Same slot, same type (shouldn't normally happen) → just go to manage
  if (reg && reg.slotId === form.slot && reg.examType === examType) {
    step = 3;
    render();
    return;
  }
  var pid = poolId(form.slot, examType);
  if (!(seats[pid] > 0)) {
    alert("Sorry, that pool just filled up. Please choose again.");
    step = 5;
    render();
    return;
  }
  step = 2;
  errors = {};
  render();
}

// Navigate from manage screen back to the exam type picker for the registered session
function goChangeExamType() {
  var reg = getRegistration();
  if (!reg || !reg.examType) return;
  if (isRegistrationClosed()) {
    alert("Registration is closed — you can no longer change your exam type.");
    return;
  }
  form.slot = reg.slotId;
  examType = reg.examType; // pre-select current so it shows highlighted
  step = 5;
  render();
}

// Perform an exam-type switch for an already-registered student.
// Called from goToDetails when student picks a different type on step 5.
async function doExamTypeSwitch(reg, newET) {
  var slotInfo = SLOTS.find(function (s) {
    return s.id === reg.slotId;
  });
  if (!slotInfo || !isMSSession(reg.slotId)) {
    alert("Exam type switching is not available for this session.");
    step = 3;
    render();
    return;
  }
  var newPool = poolId(reg.slotId, newET);
  var oldPool = poolId(reg.slotId, reg.examType);
  if (!(seats[newPool] > 0)) {
    alert(
      "Sorry, the " +
        (newET === "speaking" ? "Speaking First" : "Main") +
        " pool is full for this session.",
    );
    step = 3;
    render();
    return;
  }
  submitting = true;
  step = 3;
  render();
  var cleanPhone = reg.phone.replace(/\D/g, "");
  var newSeatClaimed = false;
  // Calculate position BEFORE claiming seat so myPos is based on pre-claim state
  var sched = calcSchedule(reg.slotId, newET);
  try {
    await updateSeat(newPool, -1);
    newSeatClaimed = true;
    try {
      await restoreOldSeat(oldPool);
    } catch (e) {}
    reg.examType = newET;
    reg.speakTime = sched ? sched.speakTime : undefined;
    if (!reg.speakTime) delete reg.speakTime;
    if (newET === "speaking" && sched && sched.mainTime)
      reg.mainTime = sched.mainTime;
    else delete reg.mainTime;
    saveRegistration(reg);
    // Update sheet: ExamType + new times (sheetTime appends " (est.)" to prevent Sheets decimal conversion)
    var sheetFields = {
      ExamType: newET === "speaking" ? "Speaking" : "Main",
      SpeakingTime: sheetTime(sched ? sched.speakTime : reg.speakTime),
      MainTime: sheetTime(sched ? sched.mainTime : reg.mainTime),
    };
    try {
      await updateRegistrationRecord("998" + cleanPhone, sheetFields);
    } catch (e) {}
    // Recalculate all students' times in this session (positions shift after the switch)
    try {
      await recalculateSpeakingTimes(reg.slotId);
    } catch (e) {}
    submitting = false;
    step = 3;
    render();
  } catch (err) {
    submitting = false;
    if (newSeatClaimed) {
      try {
        await restoreOldSeat(oldPool);
      } catch (e) {}
      // sched was computed before the try block — reuse it
      reg.examType = newET;
      reg.speakTime = sched ? sched.speakTime : undefined;
      if (!reg.speakTime) delete reg.speakTime;
      if (newET === "speaking" && sched && sched.mainTime)
        reg.mainTime = sched.mainTime;
      else delete reg.mainTime;
      saveRegistration(reg);
      step = 3;
    }
    render();
    if (!newSeatClaimed)
      alert(
        "Could not switch exam type — please check your connection and try again.",
      );
  }
}

function backToExamType() {
  readFormFromDOM();
  step = 5;
  errors = {};
  render();
}
function selectET(et) {
  examType = et;
  render();
}
function goBackToStep1() {
  readFormFromDOM();
  examType = null;
  errors = {};
  // If already registered, go back to manage screen (student came via goChangeExamType)
  var existingReg = getRegistration();
  if (existingReg) {
    step = 3;
    render();
    return;
  }
  step = 1;
  render();
}
function goBack() {
  readFormFromDOM();
  var si = SLOTS.find(function (s) {
    return s.id === form.slot;
  });
  if (si && isMSSession(form.slot)) {
    step = 6;
  } else {
    examType = null;
    step = 1;
  }
  errors = {};
  render();
}
function goChangeSlot() {
  if (isRegistrationClosed()) {
    // Button is already disabled; this is a safety net
    return;
  }
  newSlotChoice = null;
  step = 4;
  render();
}

function setSchool(val) {
  if (val !== "adam_johns" && val !== "other") return;
  readFormFromDOM();
  form.school = val;
  document.querySelectorAll(".radio-card").forEach(function (card) {
    var isSel = card.getAttribute("data-val") === val;
    card.classList.toggle("selected", isSel);
    card.querySelector(".radio-circle").classList.toggle("on", isSel);
  });
  var errEl = document.getElementById("err-school");
  if (errEl) errEl.remove();
  delete errors.school;
}

function validate() {
  readFormFromDOM();
  var e = {};
  var cleanName = form.name.replace(/[^a-zA-Z '\-]/g, "").trim();
  if (!cleanName) e.name = "Full name is required";
  else if (cleanName.length < 2) e.name = "Name must be at least 2 characters";
  form.name = cleanName;
  var digits = form.phone.replace(/\D/g, "");
  if (!form.phone.trim()) e.phone = "Phone number is required";
  else if (digits.length < 9) e.phone = "Enter 9 digits, e.g. 90-999-99-99";
  if (!form.school) e.school = "Please select where you study";
  if (!form.slot || VALID_SLOT_IDS.indexOf(form.slot) === -1)
    e.slot = "Please select a valid session";
  return e;
}

async function submitForm() {
  errors = validate();
  if (Object.keys(errors).length > 0) {
    render();
    return;
  }
  if (isRegistrationClosed()) {
    alert("Registration is now closed.");
    render();
    return;
  }
  if (getRegistration()) {
    step = 3;
    render();
    return;
  }
  var slotInfo = SLOTS.find(function (s) {
    return s.id === form.slot;
  });
  if (!slotInfo) {
    render();
    return;
  }
  var isMS = registrationMode === "main_speaking" && isMSSession(form.slot);
  if (isMS && !form.speak) {
    step = 6;
    render();
    return;
  }
  var mainPool = form.slot;
  var spkPool = isMS ? speakPoolId(form.speak) : null;
  if (seats[mainPool] !== undefined && seats[mainPool] <= 0) {
    alert("Sorry, this session just filled up. Please choose another time.");
    step = 1;
    render();
    return;
  }
  if (spkPool && seats[spkPool] !== undefined && seats[spkPool] <= 0) {
    alert("Sorry, that speaking slot just filled up. Please choose another.");
    form.speak = null;
    step = 6;
    render();
    return;
  }
  submitting = true;
  var btn = document.querySelector(".btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML =
      '<svg class="btn-spinner" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Registering&hellip;';
  }
  var mainSeatClaimed = false;
  var spkSeatClaimed = false;
  try {
    var schoolLabel = form.school === "adam_johns" ? "Adam & John's" : "Other";
    var cleanPhone = form.phone.replace(/\D/g, "");
    await updateSeat(mainPool, -1);
    mainSeatClaimed = true;
    if (spkPool) {
      await updateSeat(spkPool, -1);
      spkSeatClaimed = true;
    }
    var mainStart = toMin(slotInfo.label);
    var spkStart = isMS ? toMin(form.speak) : null;
    var examTypeStr = null;
    if (isMS) examTypeStr = spkStart < mainStart ? "Speaking" : "Main";
    var payload = {
      Timestamp: new Date().toISOString(),
      Name: form.name.trim(),
      Phone: "998" + cleanPhone,
      Session: sheetTime(slotInfo.label),
      School: schoolLabel,
    };
    if (examTypeStr) payload.ExamType = examTypeStr;
    if (isMS) {
      payload.SpeakingTime = sheetTime(form.speak);
      payload.MainTime = sheetTime(slotInfo.label);
    }
    var respData = await addRegistration(payload);
    var regData = {
      name: form.name.trim(),
      phone: form.phone,
      slotId: form.slot,
      slotLabel: slotInfo.label,
      school: schoolLabel,
      candidateNumber: (respData && respData.candidateNumber) || payload.CandidateNumber,
    };
    if (examTypeStr) regData.examType = examTypeStr.toLowerCase();
    if (isMS) {
      regData.speakTime = form.speak;
      regData.mainTime = slotInfo.label;
    }
    saveRegistration(regData);
    submitting = false;
    step = 3;
    render();
  } catch (err) {
    submitting = false;
    if (mainSeatClaimed) {
      restoreOldSeat(mainPool).catch(function () {});
    }
    if (spkSeatClaimed && spkPool) {
      restoreOldSeat(spkPool).catch(function () {});
    }
    var freshBtn = document.querySelector(".btn-primary");
    if (freshBtn) {
      freshBtn.disabled = false;
      freshBtn.innerHTML = "Complete registration";
    }

    if (err.message === "DUPLICATE_PHONE") {
      errors.phone = "A user with this phone number is already registered.";
      render();
    } else {
      var banner = document.createElement("div");
      banner.className = "err-banner";
      banner.style.marginTop = "1rem";
      banner.textContent = "Submission failed: " + err.message;
      var existing = document.querySelector(".err-banner");
      if (existing) existing.remove();
      var pb = document.querySelector(".btn-primary");
      if (pb) pb.parentNode.insertBefore(banner, pb);
    }
  }
}

async function performCancellationLogic(reg) {
  if (!reg) return;
  // Always free main seat (if the session still exists).
  if (VALID_SLOT_IDS.indexOf(reg.slotId) !== -1) {
    try {
      await restoreOldSeat(reg.slotId);
    } catch (e) {
      console.warn("Could not restore main seat on cancellation (non-fatal):", e);
    }
  }
  // Free the speaking-grid pool for the chosen 15-min slot.
  var speakLabel = reg.speakTime || reg.SpeakingTime || reg.speakingtime;
  if (speakLabel) {
    speakLabel = String(speakLabel).replace(/ \(est\.\)$/, "").trim();
    if (/^\d{1,2}:\d{2}$/.test(speakLabel)) {
      try {
        await restoreOldSeat(speakPoolId(speakLabel));
      } catch (e) {
        console.warn("Could not restore speaking seat on cancellation (non-fatal):", e);
      }
    }
  }
  var cancelledSlotId = reg.slotId;

  var cleanPhone = (reg.phone || "").replace(/\D/g, "");
  if (cleanPhone.startsWith("998")) {
    cleanPhone = cleanPhone.substring(3);
  }
  var cancelPhone = "998" + cleanPhone;

  if (cleanPhone.length > 3) {
    try {
      await fetch(
        API + "/Phone/" + phonePathSeg(cancelPhone) + "?sheet=Registrations",
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
        },
      );
    } catch (e) {
      /* deletion failure is non-fatal — seat is already restored */
    }
  }

  if (VALID_SLOT_IDS.indexOf(cancelledSlotId) !== -1) {
    recalculateSpeakingTimes(cancelledSlotId).catch(function () {});
  }
}

async function cancelRegistration() {
  if (
    !confirm(
      "Are you sure you want to cancel your registration? Your seat will be released.",
    )
  )
    return;
  var reg = getRegistration();
  if (!reg) return;

  var cancelBtn = document.querySelector(".btn-danger");
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.innerHTML =
      '<svg class="btn-spinner" viewBox="0 0 50 50"><circle cx="25" cy="25" r="20" fill="none" stroke-width="5"></circle></svg> Cancelling&hellip;';
  }

  try {
    await performCancellationLogic(reg);
    clearRegistration();
    form = { slot: null, name: "", phone: "", school: "" };
    examType = null;
    step = 1;
    render();
  } catch (err) {
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = "Cancel my registration";
    }
    alert(
      "Could not release your seat — please check your connection and try again.",
    );
  }
}

async function confirmChangeSlot() {
  var reg = getRegistration();
  if (!reg || !newSlotChoice || newSlotChoice === reg.slotId) return;
  if (VALID_SLOT_IDS.indexOf(newSlotChoice) === -1) return;
  // Main pool capacity check (new model: main pool only at this stage).
  var newMainPool = newSlotChoice;
  if (seats[newMainPool] !== undefined && seats[newMainPool] <= 0) {
    alert("Sorry, that session just filled up. Please choose another.");
    render();
    return;
  }
  submitting = true;
  render();
  var oldSlotId = reg.slotId;
  var newSlotInfo = SLOTS.find(function (s) {
    return s.id === newSlotChoice;
  });
  if (!newSlotInfo) {
    submitting = false;
    render();
    return;
  }
  var cleanPhone = reg.phone.replace(/\D/g, "");
  var newSeatClaimed = false;
  // Free the old speaking pool so the student can pick a fresh one for the new session.
  var oldSpeakLabel = reg.speakTime || "";
  oldSpeakLabel = String(oldSpeakLabel).replace(/ \(est\.\)$/, "").trim();
  try {
    await updateSeat(newMainPool, -1);
    newSeatClaimed = true;
    if (/^\d{1,2}:\d{2}$/.test(oldSpeakLabel)) {
      try { await restoreOldSeat(speakPoolId(oldSpeakLabel)); } catch (e) {}
    }
    try {
      if (VALID_SLOT_IDS.indexOf(oldSlotId) !== -1) {
        await restoreOldSeat(oldSlotId);
      }
    } catch (e) {}
    // Clear speaking choice — the user must re-pick one valid for the new main.
    delete reg.speakTime;
    delete reg.mainTime;
    delete reg.examType;
    reg.slotId = newSlotChoice;
    reg.slotLabel = newSlotInfo.label;
    saveRegistration(reg);
    // Update sheet: clear SpeakingTime/MainTime/ExamType pending re-pick.
    try {
      await updateRegistrationSlot(
        "998" + cleanPhone,
        newSlotInfo.label,
        null,
        "",
        sheetTime(newSlotInfo.label),
      );
    } catch (e) {}
    submitting = false;
    var goSpeak = registrationMode === "main_speaking" && isMSSession(reg.slotId);
    newSlotChoice = null;
    if (goSpeak) {
      form.slot = reg.slotId;
      form.speak = null;
      step = 6;
    } else {
      step = 3;
    }
    render();
  } catch (err) {
    submitting = false;
    if (newSeatClaimed) {
      // New seat was claimed but something else failed — still save locally
      reg.slotId = newSlotChoice;
      reg.slotLabel = newSlotInfo.label;
      saveRegistration(reg);
      newSlotChoice = null;
      step = 3;
    } else {
      step = 3; // stay on manage screen
    }
    render();
    if (!newSeatClaimed) {
      alert(
        "Could not change session — please check your connection and try again.",
      );
    }
  }
}

// --- SHA-256 (native Web Crypto) ---
async function sha256(message) {
  if (!window.crypto || !window.crypto.subtle) {
    // crypto.subtle only available on HTTPS. Show clear error instead of silent fail.
    throw new Error(
      "Secure context required. Please access this page over HTTPS.",
    );
  }
  var msgBuffer = new TextEncoder().encode(message);
  var hashBuffer = await window.crypto.subtle.digest("SHA-256", msgBuffer);
  var hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray
    .map(function (b) {
      return b.toString(16).padStart(2, "0");
    })
    .join("");
}

// --- Deadline helpers ---
var deadlineLoadError = null;
var sessionConfigError = null;

async function loadDeadline() {
  deadlineLoadError = null;
  try {
    // Use /search endpoint — named sheets require this format for GET filtering
    var res = await fetch(API + "/search?sheet=Settings&Key=deadline");
    if (!res.ok) {
      deadlineLoadError =
        "Settings sheet error (HTTP " +
        res.status +
        '). Ensure the Settings tab exists with Key/Value columns and a row where Key="deadline".';
      return;
    }
    var rows = await res.json();
    if (!rows || !rows.length) {
      deadlineLoadError =
        'Settings sheet found but no rows returned. Add a row with Key="deadline" and leave Value empty.';
      return;
    }
    var val =
      rows[0]["Value"] !== undefined ? rows[0]["Value"] : rows[0]["value"];
    if (val) {
      var d = new Date(val);
      if (!isNaN(d.getTime())) deadline = d;
      else
        deadlineLoadError =
          'Stored deadline value "' + val + '" is not a valid date.';
    }
  } catch (e) {
    deadlineLoadError = "Could not reach Settings sheet: " + e.message;
  }
}

// --- Session config helpers ---
// Migrate a legacy session entry to the new schema (mainSeats/mainDuration/etc).
function migrateLegacySession(s) {
  var legacyId = String(s.id || "");
  var newId = normalizeSlotId(legacyId);
  return {
    id: newId,
    label: s.label,
    period: s.period || "",
    mainSeats: Number(s.mainSeats) || Number(s.maxSeats) || MAX,
    mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
    bufferMinutes:
      s.bufferMinutes !== undefined
        ? Number(s.bufferMinutes)
        : SPEAKING_GAP_DEFAULT,
    speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
    teachers:
      s.teachers !== undefined
        ? Number(s.teachers)
        : s.speakingEnabled
          ? 1
          : 0,
  };
}

async function loadSessionConfig() {
  sessionConfigError = null;
  try {
    var res = await fetch(API + "/search?sheet=Settings&Key=session_config");
    if (!res.ok) return; // Use defaults if not found
    var rows = await res.json();
    if (!rows || !rows.length) return;
    var val =
      rows[0]["Value"] !== undefined ? rows[0]["Value"] : rows[0]["value"];
    if (!val) return;
    var parsed = JSON.parse(val);
    if (!Array.isArray(parsed) || !parsed.length) {
      sessionConfigError =
        "Session config is malformed — using defaults. Check the session_config value in the Settings sheet.";
      return;
    }
    SLOTS = parsed.map(migrateLegacySession);
    VALID_SLOT_IDS = SLOTS.map(function (s) {
      return s.id;
    });
    var newSeats = {};
    SLOTS.forEach(function (s) {
      newSeats[s.id] = seats[s.id] !== undefined ? seats[s.id] : s.mainSeats;
      newSeats["__max__" + s.id] = s.mainSeats;
    });
    // Preserve any speak_* pool counts we've already loaded.
    Object.keys(seats).forEach(function (k) {
      if (k.indexOf("speak_") === 0 || k.indexOf("__max__speak_") === 0) {
        newSeats[k] = seats[k];
      }
    });
    seats = newSeats;
  } catch (e) {
    sessionConfigError = "Session config error: " + e.message;
  }
  // Day-level config
  try {
    var dr = await fetch(API + "/search?sheet=Settings&Key=session_day_config");
    if (dr.ok) {
      var drows = await dr.json();
      if (drows && drows.length) {
        var dv = drows[0]["Value"] || drows[0]["value"];
        if (dv) {
          var d = JSON.parse(dv);
          if (d && typeof d === "object") {
            if (d.dayStart) dayConfig.dayStart = d.dayStart;
            if (d.dayClose) dayConfig.dayClose = d.dayClose;
            dayConfig.dayCloseOverride = !!d.dayCloseOverride;
          }
        }
      }
    }
  } catch (e3) {}
  normalizeDayConfig();
  // Load registration mode
  try {
    var mr = await fetch(API + "/search?sheet=Settings&Key=registration_mode");
    if (mr.ok) {
      var mrows = await mr.json();
      if (mrows && mrows.length) {
        var mv = mrows[0]["Value"] || mrows[0]["value"];
        if (mv === "main_speaking" || mv === "lr_only") registrationMode = mv;
      }
    }
  } catch (e2) {}
}

async function saveDayConfig(dc) {
  var val = JSON.stringify({
    dayStart: dc.dayStart,
    dayClose: dc.dayClose,
    dayCloseOverride: !!dc.dayCloseOverride,
  });
  var res = await fetch(API + "/Key/session_day_config?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: val } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

function getMaxSeats(slotId) {
  if (seats["__max__" + slotId] !== undefined) return seats["__max__" + slotId];
  // Speaking pool defaults to teachers count of the first session (assumed consistent).
  if (typeof slotId === "string" && slotId.indexOf("speak_") === 0) {
    return SLOTS.length ? Math.max(0, Number(SLOTS[0].teachers) || 0) : 0;
  }
  // Main pool defaults to that session's mainSeats.
  var s = SLOTS.find(function (sl) {
    return sl.id === slotId;
  });
  if (s) return Number(s.mainSeats) || Number(s.maxSeats) || MAX;
  return MAX;
}

async function saveSessionConfig(sessions) {
  var val = JSON.stringify(sessions);
  var res = await fetch(API + "/Key/session_config?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: val } }),
  });
  if (!res.ok) {
    var body = "";
    try {
      body = await res.text();
    } catch (e2) {}
    throw new Error(
      "HTTP " + res.status + (body ? ": " + body.slice(0, 120) : ""),
    );
  }
}

async function saveModeConfig(mode) {
  var res = await fetch(API + "/Key/registration_mode?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: mode } }),
  });
  if (!res.ok) {
    var b = "";
    try {
      b = await res.text();
    } catch (e2) {}
    throw new Error("HTTP " + res.status + (b ? ": " + b.slice(0, 120) : ""));
  }
}

async function syncSeatsSheet(sessions) {
  // ── Step 1: Fetch live rows from the Seats sheet ──────────────────────
  var liveRows = [];
  try {
    var liveRes = await fetch(API + "?sheet=Seats");
    if (liveRes.ok) {
      var parsed = await liveRes.json();
      if (Array.isArray(parsed)) liveRows = parsed;
    }
  } catch (e) {
    /* network error — treat as empty sheet */
  }

  // Build a set of IDs that physically exist in the sheet right now
  var liveIds = liveRows
    .map(function (r) {
      return r["Slot"] || r["slot"] || "";
    })
    .filter(Boolean);

  // ── Step 2: Build the updates list ────────────────────────────────────
  var updates = [];

  // Build complete desired set: a row per main session + one row per 15-min
  // speaking slot in the day grid (capacity = teachers).
  var desired = [];
  sessions.forEach(function (s) {
    desired.push({
      id: s.id,
      maxSeats: Number(s.mainSeats) || Number(s.maxSeats) || 1,
      isSpeaking: false,
    });
  });
  var grid = buildSpeakingGrid(sessions, dayConfig);
  grid.forEach(function (g) {
    if (g.capacity <= 0) return; // teachers=0 → no speaking pools at all
    desired.push({
      id: g.poolId,
      maxSeats: g.capacity,
      isSpeaking: true,
    });
  });

  desired.forEach(function (d) {
    var existsInSheet = liveIds.indexOf(d.id) !== -1;
    if (existsInSheet) {
      // Row already in sheet — calculate adjusted remaining count
      var current = seats[d.id] !== undefined ? seats[d.id] : d.maxSeats;
      var oldMax = getMaxSeats(d.id);
      var newRemaining;
      if (d.maxSeats > oldMax) {
        newRemaining = Math.max(0, current) + (d.maxSeats - oldMax);
      } else {
        newRemaining = Math.min(current, d.maxSeats);
      }
      updates.push({ id: d.id, remaining: newRemaining, op: "patch" });
    } else {
      // New slot — POST a fresh row with full seats available
      updates.push({ id: d.id, remaining: d.maxSeats, op: "post" });
    }
  });

  // Any live row NOT in the desired set should be deleted
  var desiredIds = desired.map(function (d) {
    return d.id;
  });
  liveIds.forEach(function (liveId) {
    if (desiredIds.indexOf(liveId) === -1) {
      updates.push({ id: liveId, op: "delete" });
    }
  });

  // ── Step 3: Fire all API calls (memory stays unchanged until all succeed) ──
  for (var j = 0; j < updates.length; j++) {
    var u = updates[j];
    if (u.op === "delete") {
      var delRes = await fetch(
        API + "/Slot/" + encodeURIComponent(u.id) + "?sheet=Seats",
        {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Hash": ADMIN_HASH,
          },
        },
      );
      if (!delRes.ok)
        throw new Error(
          "Seat DELETE failed for " + u.id + " (HTTP " + delRes.status + ")",
        );
    } else if (u.op === "patch") {
      var patchRes = await fetch(
        API + "/Slot/" + encodeURIComponent(u.id) + "?sheet=Seats",
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: { Remaining: u.remaining } }),
        },
      );
      if (!patchRes.ok)
        throw new Error(
          "Seat PATCH failed for " + u.id + " (HTTP " + patchRes.status + ")",
        );
    } else {
      var postRes = await fetch(API + "?sheet=Seats", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Hash": ADMIN_HASH,
        },
        body: JSON.stringify({ data: { Slot: u.id, Remaining: u.remaining } }),
      });
      if (!postRes.ok)
        throw new Error(
          "Seat POST failed for " + u.id + " (HTTP " + postRes.status + ")",
        );
    }
  }

  // ── Step 4: All calls succeeded — update memory ───────────────────────
  updates.forEach(function (u) {
    if (u.op === "delete") {
      delete seats[u.id];
      delete seats["__max__" + u.id];
    } else {
      seats[u.id] = u.remaining;
    }
  });
}

async function saveDeadline(isoString) {
  var res = await fetch(API + "/Key/deadline?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: isoString } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

async function saveTestDate(isoString) {
  var res = await fetch(API + "/Key/test_date?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: isoString } }),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
}

async function clearDeadline() {
  var res = await fetch(API + "/Key/deadline?sheet=Settings", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
    body: JSON.stringify({ data: { Value: "" } }),
  });
  if (!res.ok) {
    var body = "";
    try {
      body = await res.text();
    } catch (e2) {}
    throw new Error(
      "HTTP " + res.status + (body ? ": " + body.slice(0, 120) : ""),
    );
  }
}

async function loadDeadline() {
  deadlineLoadError = null;
  try {
    // 1. Load Registration Deadline
    var res1 = await fetch(API + "/search?sheet=Settings&Key=deadline");
    if (res1.ok) {
      var rows1 = await res1.json();
      if (rows1 && rows1.length) {
        var val1 = rows1[0]["Value"] !== undefined ? rows1[0]["Value"] : rows1[0]["value"];
        if (val1) deadline = new Date(val1);
      }
    }
    
    // 2. Load Actual Test Date
    var res2 = await fetch(API + "/search?sheet=Settings&Key=test_date");
    if (res2.ok) {
      var rows2 = await res2.json();
      if (rows2 && rows2.length) {
        var val2 = rows2[0]["Value"] !== undefined ? rows2[0]["Value"] : rows2[0]["value"];
        if (val2) testDate = new Date(val2);
      }
    }
  } catch (e) {
    deadlineLoadError = "Could not reach Settings sheet: " + e.message;
  }
}

function formatTestDate(d) {
  if (!d) return "Not set";
  return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function toLocalDateString(d) {
  if (!d) return "";
  var pad = function (n) { return String(n).padStart(2, "0"); };
  return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function isRegistrationClosed() {
  if (!deadline) return false;
  return new Date() > deadline;
}

function formatDeadline(d) {
  if (!d) return "Not set";
  return d.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Returns a datetime-local-compatible string in LOCAL time (not UTC)
function toLocalDatetimeString(d) {
  if (!d) return "";
  var pad = function (n) {
    return String(n).padStart(2, "0");
  };
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}

// --- Admin panel ---
function onHeaderClick() {
  headerClickCount++;
  if (headerClickTimer) clearTimeout(headerClickTimer);
  if (headerClickCount >= 5) {
    headerClickCount = 0;
    adminStatus = "";
    step = 99;
    render();
    return;
  }
  headerClickTimer = setTimeout(function () {
    headerClickCount = 0;
  }, HEADER_CLICK_RESET_MS);
}

async function adminLogin() {
  var input = document.getElementById("admin-pw-input");
  if (!input) return;
  var val = input.value;
  if (!val) return;
  // Brute-force lockout check
  if (Date.now() < adminLockedUntil) {
    var secsLeft = Math.ceil((adminLockedUntil - Date.now()) / 1000);
    var statusEl0 = document.getElementById("admin-status");
    if (statusEl0) {
      statusEl0.textContent =
        "Too many attempts. Try again in " + secsLeft + "s.";
      statusEl0.className = "admin-status err";
    }
    return;
  }
  var hash;
  try {
    hash = await sha256(val);
  } catch (e) {
    var statusEl = document.getElementById("admin-status");
    if (statusEl) {
      statusEl.textContent = e.message;
      statusEl.className = "admin-status err";
    }
    return;
  }
  if (hash === ADMIN_HASH) {
    adminAuthenticated = true;
    adminFailedAttempts = 0;
    adminLockedUntil = 0;
    adminStatus = "";
    try { sessionStorage.setItem("adminAuth", "1"); } catch (e) {}
    render();
  } else {
    adminFailedAttempts++;
    if (adminFailedAttempts >= ADMIN_MAX_ATTEMPTS) {
      adminLockedUntil = Date.now() + ADMIN_LOCKOUT_MS;
      adminFailedAttempts = 0;
      adminStatus = "Too many failed attempts. Locked for 60 seconds.";
    } else {
      adminStatus =
        "Incorrect password. (" +
        adminFailedAttempts +
        "/" +
        ADMIN_MAX_ATTEMPTS +
        " attempts)";
    }
    var statusEl2 = document.getElementById("admin-status");
    if (statusEl2) {
      statusEl2.textContent = adminStatus;
      statusEl2.className = "admin-status err";
    }
    input.value = "";
  }
}

function closeAdmin() {
  if (adminSaveTimer) {
    clearTimeout(adminSaveTimer);
    adminSaveTimer = null;
  }
  adminSessionDraft = null;
  // Keep adminAuthenticated = true so user can re-enter via FAB
  adminStatus = "";
  step = 1;
  render();
}

function adminLogout() {
  adminAuthenticated = false;
  try { sessionStorage.removeItem("adminAuth"); } catch (e) {}
  adminStatus = "";
  adminSessionDraft = null;
  step = 1;
  render();
  showToast("Logged out of admin", "info");
}

function renderAdminLoginHTML() {
  return (
    '<div class="admin-panel">' +
    '<div class="admin-title">Admin access</div>' +
    '<div class="admin-sub">Enter your password to manage the registration deadline.</div>' +
    '<input id="admin-pw-input" class="admin-input" type="password" placeholder="Password" />' +
    '<button class="btn-primary" style="margin-top:0" onclick="adminLogin()">Unlock</button>' +
    '<div id="admin-status" class="admin-status err">' +
    (adminStatus || "") +
    "</div>" +
    '<button class="btn-secondary" onclick="closeAdmin()">Cancel</button>' +
    '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button>' +
    "</div>"
  );
}

var adminStudents = null;
var adminStudentsLoading = false;
var adminStudentsError = "";

async function adminLoadStudents(force) {
  // Smart refresh: skip if data is fresh (<30s) unless forced
  if (!force && adminStudents !== null && (Date.now() - adminStudentsLoadedAt) < 30000) {
    return;
  }
  adminStudentsLoading = true;
  adminStudentsError = "";
  render();
  try {
    var res = await fetch(API + "?sheet=Registrations");
    if (!res.ok) throw new Error("Failed to load " + res.status);
    var data = await res.json();
    adminStudents = Array.isArray(data) ? data.slice().reverse() : []; // show newest first
    adminStudentsLoadedAt = Date.now();
  } catch (e) {
    adminStudentsError = e.message;
  }
  adminStudentsLoading = false;
  render();
}

async function adminCancelStudent(ph, sid, et, spk) {
  if (
    !confirm(
      "Cancel this student? This will instantly free up their main and speaking seats.",
    )
  )
    return;
  // performCancellationLogic reads `reg.speakTime` to release the speak_HHMM pool.
  // Without this, the speaking slot stays decremented forever — seat leak.
  var obj = { phone: ph, slotId: sid, examType: et, speakTime: spk || "" };
  adminStudentsLoading = true;
  render();
  try {
    await performCancellationLogic(obj);
    showToast("Student cancelled successfully", "success");
    await adminLoadStudents(true); // refresh roster instantly
  } catch (e) {
    adminStudentsError = "Cancellation failed: " + e.message;
    adminStudentsLoading = false;
    render();
  }
}

function renderAdminPanelHTML() {
  var studentsBadge = (adminStudents && adminStudents.length > 0)
    ? ' <span class="admin-tab-badge">' + adminStudents.length + '</span>'
    : '';
  var tabs =
    '<div class="admin-tabs">' +
    '<button class="admin-tab' +
    (adminActiveTab === "deadline" ? " active" : "") +
    '" onclick="adminSwitchTab(\'deadline\')">Deadline</button>' +
    '<button class="admin-tab' +
    (adminActiveTab === "sessions" ? " active" : "") +
    '" onclick="adminSwitchTab(\'sessions\')">Sessions</button>' +
    '<button class="admin-tab' +
    (adminActiveTab === "mode" ? " active" : "") +
    '" onclick="adminSwitchTab(\'mode\')">Mode</button>' +
    '<button class="admin-tab' +
    (adminActiveTab === "students" ? " active" : "") +
    '" onclick="adminSwitchTab(\'students\')">Students' + studentsBadge + '</button>' +
    '<button class="admin-tab' +
    (adminActiveTab === "bot" ? " active" : "") +
    '" onclick="adminSwitchTab(\'bot\')">Bot</button>' +
    "</div>";

  if (adminActiveTab === "bot") {
    return renderBotTabHTML(tabs);
  }

  if (adminActiveTab === "students") {
    var html =
      '<div class="admin-panel" style="max-width:600px"><div class="admin-title">Students Roster</div>' +
      tabs;

    // Search input
    html += '<div class="student-search-wrap">' +
      '<svg class="student-search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>' +
      '<input class="student-search" type="text" placeholder="Search by name or phone..." value="' + esc(adminStudentFilter) + '" oninput="adminStudentFilter=this.value;render()" />' +
      '</div>';

    if (adminStudentsLoading) {
      html +=
        '<div class="skeleton-row"><div><div class="skeleton-bar sk-name"></div><div class="skeleton-bar sk-meta"></div></div><div class="skeleton-bar sk-btn"></div></div>' +
        '<div class="skeleton-row"><div><div class="skeleton-bar sk-name"></div><div class="skeleton-bar sk-meta"></div></div><div class="skeleton-bar sk-btn"></div></div>' +
        '<div class="skeleton-row"><div><div class="skeleton-bar sk-name"></div><div class="skeleton-bar sk-meta"></div></div><div class="skeleton-bar sk-btn"></div></div>';
    } else if (adminStudentsError) {
      html += '<div class="err-banner">' + esc(adminStudentsError) + "</div>";
    } else if (adminStudents && adminStudents.length > 0) {
      var filteredStudents = adminStudents;
      if (adminStudentFilter) {
        var q = adminStudentFilter.toLowerCase();
        filteredStudents = adminStudents.filter(function (st) {
          var nm = (st.Name || st.name || "").toLowerCase();
          var ph = (st.Phone || st.phone || "").toLowerCase();
          var cn = String(st.CandidateNumber || st.candidatenumber || "").toLowerCase();
          return nm.indexOf(q) !== -1 || ph.indexOf(q) !== -1 || cn.indexOf(q) !== -1;
        });
      }
      if (filteredStudents.length === 0) {
        html += '<div style="text-align:center;color:var(--muted);font-size:13px;padding:2rem 0">No students match &ldquo;' + esc(adminStudentFilter) + '&rdquo;</div>';
      } else {
      var rosterParams = filteredStudents
        .map(function (st) {
          var ph = st.Phone || st.phone || "";
          var nm = st.Name || st.name || "";
          var slot = st.Session || st.session || "";

          var slotInfo = SLOTS.find(function (s) {
            return (
              sheetTime(s.label) === slot ||
              s.label === slot.replace(/ \(est\.\)$/, "")
            );
          });
          var sid = slotInfo ? slotInfo.id : "";
          var et = st.ExamType || st.examtype || null;
          if (et && et.toLowerCase() === "speaking") et = "speaking";
          else if (et && et.toLowerCase() === "main") et = "main";
          // Pull the explicit speaking-time string so cancellation can release
          // the right speak_HHMM pool. Strip the " (est.)" suffix here so the
          // onclick payload is the bare HH:MM label.
          var spk = String(st.SpeakingTime || st.speakingtime || "")
            .replace(/ \(est\.\)$/, "")
            .trim();

          return (
            '<div class="session-row" style="padding:12px;justify-content:space-between;align-items:center">' +
            '<div><div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:4px">' +
            esc(nm) + ' <span style="font-size:12px;color:var(--primary);font-weight:400">(ID: ' + esc(st.CandidateNumber || st.candidatenumber || "N/A") + ')</span>' +
            "</div>" +
            '<div style="font-size:12px;color:var(--muted)">' +
            esc(ph) +
            " &bull; " +
            esc(slot) +
            (et ? " &bull; " + et : "") +
            (spk ? " &bull; speak " + esc(spk) : "") +
            "</div></div>" +
            '<button class="session-del" style="border:1px solid var(--red-border);color:var(--red);border-radius:4px;padding:4px 8px;font-size:11px;width:auto;height:auto" onclick="adminCancelStudent(\'' +
            scr(ph) +
            "','" +
            scr(sid) +
            "','" +
            scr(et || "") +
            "','" +
            scr(spk) +
            "')\">Cancel</button>" +
            "</div>"
          );
        })
        .join("");
      html +=
        '<div style="max-height:360px;overflow-y:auto;padding-right:4px">' +
        rosterParams +
        "</div>";
    } // close filteredStudents.length > 0
    } else {
      html +=
        '<div style="text-align:center;color:var(--muted);font-size:13px;padding:2rem 0">No students registered yet.</div>';
    }

    html +=
      '<button class="btn-secondary" style="margin-top:16px" onclick="closeAdmin()">Close</button>' +
      '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button></div>';
    return html;
  }

  if (adminActiveTab === "deadline") {
    var deadlineStr = deadline ? toLocalDatetimeString(deadline) : "";
    var currentDisplay = deadline
      ? '<div class="deadline-display">Current deadline: <strong>' + formatDeadline(deadline) + "</strong></div>"
      : '<div class="deadline-display" style="color:#888">No deadline set — registration is open.</div>';

    var testDateStr = testDate ? toLocalDateString(testDate) : "";
    var testDateDisplay = testDate
      ? '<div class="deadline-display" style="margin-top:4px">Test Date (Bot Reminders): <strong>' + formatTestDate(testDate) + "</strong></div>"
      : '<div class="deadline-display" style="color:#888;margin-top:4px">No test date set for bot reminders.</div>';

    var allErrors = [deadlineLoadError, sessionConfigError].filter(Boolean).join(" | ");
    var errorHtml = allErrors ? '<div style="background:#FCEBEB;border:1px solid #F09595;border-radius:8px;padding:10px 14px;font-size:12px;color:#791F1F;margin-bottom:12px">⚠ ' + esc(allErrors) + "</div>" : "";
    
    return (
      '<div class="admin-panel">' +
      '<div class="admin-title">Settings</div>' +
      tabs +
      errorHtml +
      currentDisplay +
      testDateDisplay +
      
      '<div style="margin-top:16px"><label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:6px">Registration Close Deadline (Time)</label>' +
      '<input id="admin-deadline-input" class="admin-input" type="datetime-local" value="' + deadlineStr + '" min="' + toLocalDatetimeString(new Date()) + '" /></div>' +
      
      '<div style="margin-top:12px"><label style="font-size:13px;font-weight:500;color:#555;display:block;margin-bottom:6px">Actual Test Date (For Bot Reminders & Cleanup)</label>' +
      '<input id="admin-testdate-input" class="admin-input" type="date" value="' + testDateStr + '" /></div>' +
      
      '<div id="admin-save-status" class="admin-status"></div>' +
      '<button class="btn-primary" style="margin-top:12px" onclick="adminSaveDates()">Save Settings</button>' +
      '<button class="btn-danger" style="margin-top:8px;width:100%" onclick="adminClearDates()">Clear Both Dates</button>' +
      '<button class="btn-secondary" onclick="closeAdmin()">Close</button>' +
      '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button>' +
      "</div>"
    );
  }

  // Mode tab
  if (adminActiveTab === "mode") {
    var isMS = registrationMode === "main_speaking";
    return (
      '<div class="admin-panel"><div class="admin-title">Settings</div>' +
      tabs +
      '<div style="font-size:13px;color:var(--muted);margin-bottom:14px">Choose the exam format students see when registering.</div>' +
      '<div class="mode-card' +
      (!isMS ? " mode-on" : "") +
      '" onclick="adminSetMode(\'lr_only\')">' +
      '<div class="mode-card-title">L+R Only ' +
      (!isMS ? '<span class="mode-badge">ACTIVE</span>' : "") +
      "</div>" +
      '<div class="mode-card-desc">Students pick a session time only. No exam type selection. For listening + reading tests without speaking.</div>' +
      "</div>" +
      '<div class="mode-card' +
      (isMS ? " mode-on" : "") +
      '" onclick="adminSetMode(\'main_speaking\')">' +
      '<div class="mode-card-title">Main + Speaking ' +
      (isMS ? '<span class="mode-badge">ACTIVE</span>' : "") +
      "</div>" +
      '<div class="mode-card-desc">Students choose Main-first or Speaking-first. Their estimated schedule is shown on the details page. Configure per session in the Sessions tab.</div>' +
      "</div>" +
      '<div id="admin-mode-status" class="admin-status"></div>' +
      '<button class="btn-secondary" onclick="closeAdmin()">Close</button>' +
      '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button></div>'
    );
  }

  // Sessions tab
  var draft =
    adminSessionDraft ||
    SLOTS.map(function (s) {
      return {
        id: s.id,
        label: s.label,
        mainSeats: s.mainSeats || getMaxSeats(s.id),
        period: s.period || "",
        mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
        bufferMinutes:
          s.bufferMinutes !== undefined
            ? Number(s.bufferMinutes)
            : SPEAKING_GAP_DEFAULT,
        speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
        teachers: s.teachers !== undefined ? Number(s.teachers) : 0,
      };
    });
  adminSessionDraft = draft;
  if (!adminDayDraft) {
    adminDayDraft = {
      dayStart: dayConfig.dayStart || "",
      dayClose: dayConfig.dayClose || "",
      dayCloseOverride: !!dayConfig.dayCloseOverride,
    };
  }

  // Capacity preview — uses the live draft so admin sees feasibility immediately.
  var feasibilityHtml = renderAdminFeasibility(draft, adminDayDraft);

  var dayRow =
    '<div class="session-row" style="flex-direction:column;align-items:stretch;background:rgba(255,255,255,0.02)">' +
    '<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap">' +
    '<span style="font-size:11px;color:var(--muted);font-weight:600;letter-spacing:.05em;text-transform:uppercase">Day window</span>' +
    '<span style="font-size:11px;color:var(--muted)">start</span>' +
    '<input class="session-input" type="text" maxlength="5" placeholder="HH:MM" value="' + esc(adminDayDraft.dayStart) + '" oninput="adminUpdateDay(\'dayStart\',this.value)" style="width:64px;flex:none" />' +
    '<span style="font-size:11px;color:var(--muted)">close</span>' +
    '<input class="session-input" type="text" maxlength="5" placeholder="HH:MM" value="' + esc(adminDayDraft.dayClose) + '" oninput="adminUpdateDay(\'dayClose\',this.value)" ' + (adminDayDraft.dayCloseOverride ? "" : "disabled") + ' style="width:64px;flex:none;opacity:' + (adminDayDraft.dayCloseOverride ? "1" : ".55") + '" />' +
    '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);cursor:pointer">' +
    '<input type="checkbox" ' + (adminDayDraft.dayCloseOverride ? "" : "checked") + ' onchange="adminToggleDerivedClose()" /> derive close from last main</label>' +
    '</div></div>';

  var rows = draft
    .map(function (s, i) {
      var canDelete = draft.length > 1;
      var topRow =
        '<div style="display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap">' +
        '<span class="session-row-num">' + (i + 1) + "</span>" +
        '<input class="session-input" type="text" maxlength="8" placeholder="HH:MM" value="' + esc(s.label) + '" oninput="adminUpdateSession(' + i + ",'label',this.value)\" />" +
        '<input class="session-input" type="text" maxlength="12" placeholder="Period" value="' + esc(s.period || "") + '" oninput="adminUpdateSession(' + i + ',\'period\',this.value)" style="width:72px;flex:none" />' +
        '<input class="session-input seats-input" type="number" min="1" max="200" value="' + s.mainSeats + '" oninput="adminUpdateSession(' + i + ",'mainSeats',this.value)\" />" +
        '<span style="font-size:11px;color:var(--muted);white-space:nowrap">main seats</span>' +
        '<button class="session-del" onclick="adminDeleteSession(' + i + ')" ' + (canDelete ? "" : "disabled") + ">&#215;</button>" +
        "</div>";
      var detailRow =
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px;margin-top:8px;border-top:1px solid var(--border)">' +
        '<span style="font-size:11px;color:var(--muted)">Main duration</span>' +
        '<input class="session-input" type="number" min="15" max="600" value="' + s.mainDuration + '" oninput="adminUpdateSession(' + i + ",'mainDuration',this.value)\" style=\"width:72px\" />" +
        '<span style="font-size:11px;color:var(--muted)">min · buffer</span>' +
        '<input class="session-input" type="number" min="0" max="120" value="' + s.bufferMinutes + '" oninput="adminUpdateSession(' + i + ",'bufferMinutes',this.value)\" style=\"width:60px\" />" +
        '<span style="font-size:11px;color:var(--muted)">min</span>' +
        '</div>' +
        (registrationMode === "main_speaking"
          ? '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px;margin-top:8px;border-top:1px dashed var(--border)">' +
            '<span style="font-size:11px;color:var(--speak);font-weight:600">&#127908; Speaking</span>' +
            '<span style="font-size:11px;color:var(--muted)">slot length</span>' +
            '<input class="session-input" type="number" min="5" max="60" value="' + s.speakingDuration + '" oninput="adminUpdateSession(' + i + ",'speakingDuration',this.value)\" style=\"width:60px\" />" +
            '<span style="font-size:11px;color:var(--muted)">min · teachers</span>' +
            '<input class="session-input teach-input" type="number" min="0" max="20" value="' + s.teachers + '" oninput="adminUpdateSession(' + i + ",'teachers',this.value)\" />" +
            '<span style="font-size:11px;color:var(--muted)">(0 disables speaking)</span>' +
            '</div>'
          : "");
      return (
        '<div class="session-row" id="srow-' + i + '" style="flex-direction:column;align-items:stretch">' +
        topRow +
        detailRow +
        "</div>"
      );
    })
    .join("");

  return (
    '<div class="admin-panel">' +
    '<div class="admin-title">Settings</div>' +
    tabs +
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Edit session times, capacity, and durations. The speaking grid is generated automatically from these settings.</div>' +
    dayRow +
    rows +
    '<button class="add-session-btn" onclick="adminAddSession()">+ Add session</button>' +
    feasibilityHtml +
    '<div id="admin-sessions-status" class="admin-status"></div>' +
    '<button class="btn-primary" style="margin-top:12px" onclick="adminSaveSessions()">Save sessions</button>' +
    '<button class="btn-secondary" onclick="adminSessionDraft=null;adminDayDraft=null;render()">Discard changes</button>' +
    '<button class="btn-secondary" onclick="closeAdmin()">Close</button>' +
    '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button>' +
    "</div>"
  );
}

// Compute and render a capacity feasibility report for the admin's draft.
function renderAdminFeasibility(draft, dc) {
  // Convert draft sessions into the runtime shape used by buildSpeakingGrid.
  var sessions = draft.map(function (s) {
    return {
      id: s.id,
      label: s.label,
      mainSeats: Number(s.mainSeats) || 0,
      mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
      bufferMinutes:
        s.bufferMinutes !== undefined
          ? Number(s.bufferMinutes)
          : SPEAKING_GAP_DEFAULT,
      speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
      teachers: Number(s.teachers) || 0,
    };
  });
  // Day config: honor the override; otherwise derive from sessions.
  var dcEff = { dayStart: dc.dayStart, dayClose: dc.dayClose, dayCloseOverride: dc.dayCloseOverride };
  if (!dcEff.dayCloseOverride && sessions.length) {
    var sorted = sessions.slice().sort(function (a, b) {
      return toMin(a.label) - toMin(b.label);
    });
    var lastEnd = 0;
    sorted.forEach(function (s) {
      var e = toMin(s.label) + (Number(s.mainDuration) || MAIN_DURATION_DEFAULT);
      if (e > lastEnd) lastEnd = e;
    });
    dcEff.dayClose = toHHMM(lastEnd);
    if (!dcEff.dayStart) dcEff.dayStart = toHHMM(toMin(sorted[0].label));
  }

  // Validation: teachers and speakingDuration consistency.
  var warnings = [];
  if (sessions.length) {
    var t0 = sessions[0].teachers;
    var d0 = sessions[0].speakingDuration;
    var teachersAgree = sessions.every(function (s) { return s.teachers === t0; });
    var durAgree = sessions.every(function (s) { return s.speakingDuration === d0; });
    if (!teachersAgree) warnings.push("Teachers count differs between sessions — speaking grid uses the first session's value.");
    if (!durAgree) warnings.push("Speaking duration differs between sessions — grid uses the first session's value.");
  }

  var grid = buildSpeakingGrid(sessions, dcEff);
  // Per-session reachable seats:
  var perSession = sessions.map(function (s) {
    var validCount = grid.filter(function (g) {
      return g.capacity > 0 && g.blockedByMain.indexOf(s.id) === -1;
    }).length;
    var reachable = validCount * (Number(sessions[0].teachers) || 0);
    var ok = reachable >= s.mainSeats;
    return { session: s, validSlots: validCount, reachable: reachable, ok: ok };
  });

  var totalMain = sessions.reduce(function (a, s) { return a + s.mainSeats; }, 0);
  var totalSpeak = grid.filter(function (g) { return g.capacity > 0; }).length * (sessions[0] ? sessions[0].teachers || 0 : 0);

  var rowsHtml = perSession.map(function (p) {
    var color = p.ok ? "#3dbd8b" : "#e05a5a";
    return (
      '<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0">' +
      '<span>' + esc(p.session.label) + '</span>' +
      '<span style="color:' + color + '">' +
      p.reachable + ' speaking seats reachable / ' + p.session.mainSeats + ' main' +
      (p.ok ? "" : " &mdash; INSUFFICIENT") +
      '</span></div>'
    );
  }).join("");

  var warnHtml = warnings.map(function (w) {
    return '<div style="font-size:11px;color:#BA7517;margin-top:4px">&#9888; ' + esc(w) + '</div>';
  }).join("");

  var anyBad = perSession.some(function (p) { return !p.ok; });
  var headerColor = anyBad ? "#e05a5a" : "#3dbd8b";

  return (
    '<div style="margin-top:12px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border);border-radius:8px">' +
    '<div style="font-size:12px;font-weight:600;color:' + headerColor + ';margin-bottom:6px">Capacity preview &mdash; ' +
    totalMain + ' main seats, ' + totalSpeak + ' speaking seats (' + grid.length + ' grid cells)</div>' +
    rowsHtml +
    warnHtml +
    (anyBad
      ? '<div style="font-size:11px;color:#e05a5a;margin-top:6px">Some sessions cannot guarantee a speaking seat for every student. Add teachers, widen the day window, or reduce main seats.</div>'
      : '') +
    '</div>'
  );
}

function adminSwitchTab(tab) {
  adminActiveTab = tab;
  if (tab === "sessions") {
    adminSessionDraft =
      adminSessionDraft ||
      SLOTS.map(function (s) {
        return {
          id: s.id,
          label: s.label,
          mainSeats: s.mainSeats || getMaxSeats(s.id),
          period: s.period || "",
          mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
          bufferMinutes:
            s.bufferMinutes !== undefined
              ? Number(s.bufferMinutes)
              : SPEAKING_GAP_DEFAULT,
          speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
          teachers: s.teachers !== undefined ? Number(s.teachers) : 0,
        };
      });
    adminDayDraft = adminDayDraft || {
      dayStart: dayConfig.dayStart || "",
      dayClose: dayConfig.dayClose || "",
      dayCloseOverride: !!dayConfig.dayCloseOverride,
    };
  }
  if (tab === "students") adminLoadStudents();
  if (tab === "bot") {
    // Load whichever sub-tab is active so the user sees data immediately.
    if (adminBotSubtab === "texts" && !adminBotTexts) adminBotLoadTexts();
    if (adminBotSubtab === "schedules" && !adminBotSchedulesLoaded) adminBotLoadSchedules();
    if (adminBotSubtab === "broadcast" && !adminBotBroadcastHistory) adminBotLoadHistory();
    if (adminBotSubtab === "stats") adminBotLoadStats();
  } else {
    // Leaving the Bot tab — stop any background polling.
    adminBotStopPolling();
  }
  render();
}

function adminBotSwitchSubtab(sub) {
  adminBotSubtab = sub;
  if (sub === "texts" && !adminBotTexts) adminBotLoadTexts();
  if (sub === "schedules" && !adminBotSchedulesLoaded) adminBotLoadSchedules();
  if (sub === "broadcast" && !adminBotBroadcastHistory) adminBotLoadHistory();
  if (sub === "stats") adminBotLoadStats();
  if (sub !== "stats") adminBotStopPolling();
  render();
}

var ADMIN_NUMERIC_FIELDS = {
  mainSeats: 1,
  mainDuration: 1,
  bufferMinutes: 1,
  speakingDuration: 1,
  teachers: 1,
};
function adminUpdateSession(index, field, value) {
  if (!adminSessionDraft) return;
  if (ADMIN_NUMERIC_FIELDS[field]) {
    if (value === "" || value === null) {
      adminSessionDraft[index][field] = field === "teachers" || field === "bufferMinutes" ? 0 : 1;
    } else {
      adminSessionDraft[index][field] = Number(value);
    }
    // Re-render so the capacity preview updates live.
    render();
  } else {
    adminSessionDraft[index][field] = value;
    // Re-render label/period changes too — they affect the grid.
    if (field === "label") render();
  }
}

function adminUpdateDay(field, value) {
  if (!adminDayDraft) return;
  adminDayDraft[field] = value;
  render();
}
function adminToggleDerivedClose() {
  if (!adminDayDraft) return;
  adminDayDraft.dayCloseOverride = !adminDayDraft.dayCloseOverride;
  if (!adminDayDraft.dayCloseOverride) {
    // Recompute close from sessions
    var sorted = (adminSessionDraft || []).slice().sort(function (a, b) {
      return toMin(a.label) - toMin(b.label);
    });
    var lastEnd = 0;
    sorted.forEach(function (s) {
      var e = toMin(s.label) + (Number(s.mainDuration) || MAIN_DURATION_DEFAULT);
      if (e > lastEnd) lastEnd = e;
    });
    if (lastEnd) adminDayDraft.dayClose = toHHMM(lastEnd);
  }
  render();
}
async function adminSetMode(mode) {
  var statusEl = document.getElementById("admin-mode-status");
  if (mode === registrationMode) return;
  if (statusEl) {
    statusEl.textContent = "Saving…";
    statusEl.className = "admin-status";
  }
  try {
    await saveModeConfig(mode);
    registrationMode = mode;
    if (statusEl) {
      statusEl.textContent = "Mode updated!";
      statusEl.className = "admin-status ok";
    }
    setTimeout(render, 700);
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = "Save failed: " + e.message;
      statusEl.className = "admin-status err";
    }
  }
}

function adminAddSession() {
  if (!adminSessionDraft) {
    adminSessionDraft = SLOTS.map(function (s) {
      return {
        id: s.id,
        label: s.label,
        mainSeats: s.mainSeats || getMaxSeats(s.id),
        period: s.period || "",
        mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
        bufferMinutes: s.bufferMinutes !== undefined ? Number(s.bufferMinutes) : SPEAKING_GAP_DEFAULT,
        speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
        teachers: s.teachers !== undefined ? Number(s.teachers) : 0,
      };
    });
  }
  var newId = "main_custom_" + Date.now();
  // Inherit speaking config from an existing row so the grid stays coherent.
  var template = adminSessionDraft[0] || {};
  adminSessionDraft.push({
    id: newId,
    label: "00:00",
    mainSeats: 10,
    period: "",
    mainDuration: Number(template.mainDuration) || MAIN_DURATION_DEFAULT,
    bufferMinutes: template.bufferMinutes !== undefined ? Number(template.bufferMinutes) : SPEAKING_GAP_DEFAULT,
    speakingDuration: Number(template.speakingDuration) || SPEAK_DURATION_DEFAULT,
    teachers: template.teachers !== undefined ? Number(template.teachers) : 0,
  });
  render();
}

function adminDeleteSession(index) {
  if (!adminSessionDraft || adminSessionDraft.length <= 1) return;
  adminSessionDraft.splice(index, 1);
  render();
}

async function adminSaveSessions() {
  var draft = adminSessionDraft;
  if (!draft || !draft.length) return;

  var statusEl = document.getElementById("admin-sessions-status");
  for (var i = 0; i < draft.length; i++) {
    var lbl = (draft[i].label || "").trim();
    if (!/^\d{1,2}:\d{2}$/.test(lbl)) {
      if (statusEl) {
        statusEl.textContent = "Session " + (i + 1) + ": time must be HH:MM.";
        statusEl.className = "admin-status err";
      }
      return;
    }
    var seatsVal = Number(draft[i].mainSeats);
    if (!seatsVal || seatsVal < 1 || seatsVal > 200) {
      if (statusEl) {
        statusEl.textContent = "Session " + (i + 1) + ": main seats must be 1–200.";
        statusEl.className = "admin-status err";
      }
      return;
    }
    var mDur = Number(draft[i].mainDuration);
    if (!mDur || mDur < 15) {
      if (statusEl) {
        statusEl.textContent = "Session " + (i + 1) + ": main duration must be ≥ 15 min.";
        statusEl.className = "admin-status err";
      }
      return;
    }
    draft[i].label = lbl;
  }

  var btn = document.querySelector(".admin-panel .btn-primary");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Saving…";
  }

  try {
    var configToSave = draft.map(function (s) {
      var existingSlot = SLOTS.find(function (sl) {
        return sl.id === s.id;
      });
      return {
        id: s.id,
        label: s.label,
        period: s.period !== undefined ? s.period : existingSlot ? existingSlot.period || "" : "",
        mainSeats: Number(s.mainSeats) || 1,
        mainDuration: Number(s.mainDuration) || MAIN_DURATION_DEFAULT,
        bufferMinutes: s.bufferMinutes !== undefined ? Number(s.bufferMinutes) : SPEAKING_GAP_DEFAULT,
        speakingDuration: Number(s.speakingDuration) || SPEAK_DURATION_DEFAULT,
        teachers: Number(s.teachers) || 0,
      };
    });
    await saveSessionConfig(configToSave);
    if (adminDayDraft) {
      try {
        await saveDayConfig(adminDayDraft);
        dayConfig.dayStart = adminDayDraft.dayStart;
        dayConfig.dayClose = adminDayDraft.dayClose;
        dayConfig.dayCloseOverride = !!adminDayDraft.dayCloseOverride;
      } catch (e) {
        console.warn("Day config save failed (non-fatal):", e);
      }
    }

    // Apply to live state before syncing Seats so buildSpeakingGrid uses fresh data.
    SLOTS = configToSave.map(function (s) {
      return {
        id: s.id,
        label: s.label,
        period: s.period || "",
        mainSeats: s.mainSeats,
        mainDuration: s.mainDuration,
        bufferMinutes: s.bufferMinutes,
        speakingDuration: s.speakingDuration,
        teachers: s.teachers,
      };
    });
    VALID_SLOT_IDS = SLOTS.map(function (s) {
      return s.id;
    });
    normalizeDayConfig();
    configToSave.forEach(function (s) {
      seats["__max__" + s.id] = s.mainSeats;
    });
    // Re-provision Seats sheet with main pools + speaking grid pools.
    await syncSeatsSheet(SLOTS);
    adminSessionDraft = null;
    adminDayDraft = null;

    if (statusEl) {
      statusEl.textContent = "Sessions saved successfully!";
      statusEl.className = "admin-status ok";
    }
    showToast("Sessions saved successfully", "success");
    // Re-render sessions tab in-place to reflect updated session list (preserving status msg)
    var rowsContainer = document.querySelector(".admin-panel");
    if (rowsContainer) {
      // Briefly show success then refresh
      adminSaveTimer = setTimeout(function () {
        adminSaveTimer = null;
        var s2 = document.getElementById("admin-sessions-status");
        if (s2) s2.textContent = "";
        render();
      }, 1500);
    }
  } catch (e) {
    if (statusEl) {
      statusEl.textContent =
        "Save failed: " + (e.message || "check your connection.");
      statusEl.className = "admin-status err";
    }
  } finally {
    var saveBtn = document.querySelector(".admin-panel .btn-primary");
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save sessions";
    }
  }
}
async function adminSaveDates() {
  var inpD = document.getElementById("admin-deadline-input");
  var inpT = document.getElementById("admin-testdate-input");
  var statusEl = document.getElementById("admin-save-status");
  
  var btn = document.querySelector(".admin-panel .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  
  try {
    // Save Registration Deadline
    if (inpD && inpD.value) {
      var parts = inpD.value.split(/[\-T:]/);
      var localDate = new Date(+parts[0], +parts[1] - 1, +parts[2], +parts[3], +parts[4]);
      var isoString = localDate.toISOString();
      await saveDeadline(isoString);
      deadline = new Date(isoString);
    }
    
    // Save Test Date
    if (inpT && inpT.value) {
      var partsT = inpT.value.split("-");
      var localTestDate = new Date(+partsT[0], +partsT[1] - 1, +partsT[2]); // Midnight local time
      var isoStringT = localTestDate.toISOString();
      await saveTestDate(isoStringT);
      testDate = new Date(isoStringT);
    }
    
    if (statusEl) {
      statusEl.textContent = "Dates saved successfully!";
      statusEl.className = "admin-status ok";
    }
    setTimeout(function() { render(); }, 1200);
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = "Save failed: " + e.message;
      statusEl.className = "admin-status err";
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Save Settings"; }
  }
}

async function adminClearDates() {
  var statusEl = document.getElementById("admin-save-status");
  var btn = document.querySelector(".admin-panel .btn-danger");
  if (btn) { btn.disabled = true; btn.textContent = "Clearing…"; }
  try {
    // Clear both from Cloudflare
    await fetch(API + "/Key/deadline?sheet=Settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH }, body: JSON.stringify({ data: { Value: "" } }) });
    await fetch(API + "/Key/test_date?sheet=Settings", { method: "PATCH", headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH }, body: JSON.stringify({ data: { Value: "" } }) });
    
    deadline = null;
    testDate = null;
    if (statusEl) {
      statusEl.textContent = "Both dates cleared!";
      statusEl.className = "admin-status ok";
    }
    setTimeout(function() { render(); }, 1200);
  } catch (e) {
    if (statusEl) { statusEl.textContent = "Clear failed."; statusEl.className = "admin-status err"; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Clear Both Dates"; }
  }
}

// Navigate history state (Mobile Back Button fix)
window.addEventListener("popstate", function(e) {
  if (e.state && typeof e.state.step === 'number') {
    step = e.state.step;
    render();
  } else {
    // If no state (loaded root), check if already registered
    var existing = getRegistration();
    step = existing ? 3 : 1;
    render();
  }
});

function initTheme() {
  var toggleBtn = document.getElementById("theme-toggle-btn");
  if (!toggleBtn) return;

  function updateIcon(theme) {
    if (theme === "dark") {
      toggleBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<circle cx="12" cy="12" r="5"></circle>' +
        '<line x1="12" y1="1" x2="12" y2="3"></line>' +
        '<line x1="12" y1="21" x2="12" y2="23"></line>' +
        '<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>' +
        '<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>' +
        '<line x1="1" y1="12" x2="3" y2="12"></line>' +
        '<line x1="21" y1="12" x2="23" y2="12"></line>' +
        '<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>' +
        '<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>' +
        "</svg>";
    } else {
      toggleBtn.innerHTML =
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
        '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>' +
        "</svg>";
    }
  }

  function setTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
    updateIcon(theme);
  }

  // Initial icon update
  var currentTheme = document.documentElement.getAttribute("data-theme") || "light";
  updateIcon(currentTheme);

  // Toggle on click
  toggleBtn.addEventListener("click", function () {
    var active = document.documentElement.getAttribute("data-theme") || "light";
    var nextTheme = active === "dark" ? "light" : "dark";
    setTheme(nextTheme);
  });

  // Listen to system theme changes (only apply if no user override exists in localStorage)
  var mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  if (mediaQuery.addEventListener) {
    mediaQuery.addEventListener("change", function (e) {
      if (!localStorage.getItem("theme")) {
        setTheme(e.matches ? "dark" : "light");
      }
    });
  } else if (mediaQuery.addListener) {
    // Fallback for older browsers
    mediaQuery.addListener(function (e) {
      if (!localStorage.getItem("theme")) {
        setTheme(e.matches ? "dark" : "light");
      }
    });
  }
}

// ============================================================
// BOT ADMIN TAB
// ============================================================

function renderBotTabHTML(tabs) {
  var subtabs =
    '<div class="admin-tabs" style="margin-bottom:14px">' +
    ['texts', 'broadcast', 'schedules', 'stats'].map(function (s) {
      var label = s.charAt(0).toUpperCase() + s.slice(1);
      return '<button class="admin-tab' + (adminBotSubtab === s ? ' active' : '') +
        '" onclick="adminBotSwitchSubtab(\'' + s + '\')">' + label + '</button>';
    }).join('') +
    '</div>';

  var body = "";
  if (adminBotSubtab === "texts") body = renderBotTexts();
  else if (adminBotSubtab === "broadcast") body = renderBotBroadcast();
  else if (adminBotSubtab === "schedules") body = renderBotSchedules();
  else if (adminBotSubtab === "stats") body = renderBotStats();

  return (
    '<div class="admin-panel" style="max-width:680px">' +
    '<div class="admin-title">Bot</div>' +
    tabs +
    subtabs +
    body +
    '<button class="btn-secondary" onclick="closeAdmin()">Close</button>' +
    '<button class="btn-secondary" style="margin-top:4px;color:var(--red);border-color:var(--red-border)" onclick="adminLogout()">Log out</button>' +
    '</div>'
  );
}

// ---- TEXTS ----
async function adminBotLoadTexts() {
  adminBotTextsLoading = true;
  adminBotTextsError = "";
  render();
  var loaded = {};
  try {
    // Fetch each key — small N, parallel.
    await Promise.all(BOT_TEXT_FIELDS.map(async function (f) {
      try {
        var r = await fetch(API + "/search?sheet=Settings&Key=" + encodeURIComponent(f.key));
        if (r.ok) {
          var rows = await r.json();
          if (rows && rows.length) {
            var v = rows[0].Value !== undefined ? rows[0].Value : rows[0].value;
            if (typeof v === "string" && v.length) loaded[f.key] = v;
          }
        }
      } catch (e) {}
    }));
    adminBotTexts = loaded;
  } catch (e) {
    adminBotTextsError = e.message;
  }
  adminBotTextsLoading = false;
  render();
}

function renderBotTexts() {
  if (adminBotTextsLoading) {
    return '<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">Loading…</div>';
  }
  if (adminBotTextsError) {
    return '<div class="err-banner">' + esc(adminBotTextsError) + '</div>';
  }
  var t = adminBotTexts || {};
  var rows = BOT_TEXT_FIELDS.map(function (f) {
    var val = t[f.key] !== undefined ? t[f.key] : "";
    var placeholder = "Uses built-in default if left empty";
    return (
      '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<label style="font-size:13px;font-weight:600">' + esc(f.label) + '</label>' +
      '<code style="font-size:11px;color:var(--muted)">' + esc(f.key) + '</code>' +
      '</div>' +
      '<textarea id="bot-text-' + f.key + '" class="admin-input" rows="' + f.rows + '" placeholder="' + esc(placeholder) + '" ' +
      'style="font-family:inherit;font-size:13px;resize:vertical;width:100%;box-sizing:border-box">' + esc(val) + '</textarea>' +
      '<div style="display:flex;gap:8px;margin-top:6px">' +
      '<button class="btn-primary" style="margin:0;padding:6px 12px;font-size:12px" onclick="adminBotSaveText(\'' + f.key + '\')">Save</button>' +
      (val ? '<button class="btn-secondary" style="margin:0;padding:6px 12px;font-size:12px" onclick="adminBotResetText(\'' + f.key + '\')">Reset to default</button>' : '') +
      '<span id="bot-text-status-' + f.key + '" class="admin-status" style="font-size:11px"></span>' +
      '</div></div>'
    );
  }).join("");
  return (
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">' +
    'Edit the bot\'s static texts. HTML tags like &lt;b&gt;, &lt;i&gt;, &lt;a&gt; are allowed. ' +
    'Leave a field empty to fall back to the built-in default. ' +
    'Tokens: <code>{name}</code> in reminder header; <code>{alarm}</code> in reminder tips.' +
    '</div>' + rows
  );
}

async function adminBotSaveText(key) {
  var el = document.getElementById("bot-text-" + key);
  if (!el) return;
  var val = el.value;
  var statusEl = document.getElementById("bot-text-status-" + key);
  if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "admin-status"; }
  try {
    var res = await fetch(API + "/Key/" + encodeURIComponent(key) + "?sheet=Settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
      body: JSON.stringify({ data: { Value: val } }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (!adminBotTexts) adminBotTexts = {};
    if (val) adminBotTexts[key] = val; else delete adminBotTexts[key];
    if (statusEl) { statusEl.textContent = "✓ Saved"; statusEl.className = "admin-status ok"; }
    showToast("Saved " + key, "success");
  } catch (e) {
    if (statusEl) { statusEl.textContent = "Save failed: " + e.message; statusEl.className = "admin-status err"; }
  }
}

async function adminBotResetText(key) {
  if (!confirm("Clear this override? The bot will fall back to the built-in default text.")) return;
  var el = document.getElementById("bot-text-" + key);
  if (el) el.value = "";
  await adminBotSaveText(key);
  render();
}

// ---- BROADCAST ----
async function adminBotLoadHistory() {
  try {
    var res = await fetch(API + "/admin/broadcasts", { headers: { "X-Admin-Hash": ADMIN_HASH } });
    if (res.ok) adminBotBroadcastHistory = await res.json();
  } catch (e) {
    adminBotBroadcastHistory = [];
  }
  render();
}

function renderBotBroadcast() {
  var bcast = adminBotActiveBroadcast;
  var inFlight = bcast && bcast.status !== "done";

  var progressHtml = "";
  if (bcast) {
    var pct = bcast.recipients && bcast.recipients.length
      ? Math.round((bcast.cursor / bcast.recipients.length) * 100)
      : 0;
    var failedHtml = "";
    if (bcast.failed && bcast.failed.length) {
      failedHtml =
        '<div style="font-size:11px;color:#e05a5a;margin-top:6px">' +
        bcast.failed.length + ' failed: ' +
        bcast.failed.slice(0, 3).map(function (f) { return esc(String(f.chatId)); }).join(", ") +
        (bcast.failed.length > 3 ? '…' : '') +
        '</div>' +
        '<button class="btn-secondary" style="margin-top:6px;padding:6px 12px;font-size:12px" onclick="adminBotRetryFailed()">Retry failed (' + bcast.failed.length + ')</button>';
    }
    progressHtml =
      '<div style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px">' +
      '<span>Status: <b>' + esc(bcast.status) + '</b></span>' +
      '<span>' + bcast.sent.length + ' sent · ' + bcast.failed.length + ' failed · ' + bcast.recipients.length + ' total</span>' +
      '</div>' +
      '<div style="height:6px;background:var(--border);border-radius:3px;overflow:hidden">' +
      '<div style="width:' + pct + '%;height:100%;background:var(--primary);transition:width .3s"></div>' +
      '</div>' +
      failedHtml +
      '</div>';
  }

  var historyHtml = "";
  if (adminBotBroadcastHistory && adminBotBroadcastHistory.length) {
    historyHtml = '<div style="font-size:11px;font-weight:600;color:var(--muted);margin:14px 0 6px;letter-spacing:.05em;text-transform:uppercase">Recent broadcasts</div>';
    historyHtml += adminBotBroadcastHistory.map(function (h) {
      return (
        '<div style="font-size:12px;padding:8px 10px;border:1px solid var(--border);border-radius:6px;margin-bottom:6px">' +
        '<div style="display:flex;justify-content:space-between"><span><b>' + esc(h.status) + '</b> · ' + h.sent + '/' + h.recipientCount + ' sent' + (h.failed ? ' · ' + h.failed + ' failed' : '') + '</span>' +
        '<span style="color:var(--muted);font-size:11px">' + esc(String(h.createdAt).slice(0, 16).replace('T', ' ')) + '</span></div>' +
        '<div style="font-size:11px;color:var(--muted);margin-top:3px">' + esc(h.text) + '</div>' +
        '</div>'
      );
    }).join("");
  }

  return (
    '<div style="font-size:12px;color:var(--muted);margin-bottom:10px">' +
    'Compose a one-off broadcast to all linked Telegram users. HTML tags allowed. ' +
    'Audience filters (per session/exam type/school) are wired but UI is TODO — ships with "all linked".' +
    '</div>' +
    '<textarea id="bot-broadcast-text" class="admin-input" rows="6" placeholder="Type your message…" ' +
    'style="font-family:inherit;font-size:13px;resize:vertical;width:100%;box-sizing:border-box" ' +
    'oninput="adminBotBroadcastText=this.value">' + esc(adminBotBroadcastText) + '</textarea>' +
    '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">' +
    '<button class="btn-secondary" style="margin:0;padding:8px 14px;font-size:12px" onclick="adminBotBroadcastPreview()">Preview to me only</button>' +
    '<button class="btn-primary" style="margin:0;padding:8px 14px;font-size:12px" onclick="adminBotBroadcastSend()" ' + (inFlight ? 'disabled' : '') + '>Send to all linked users</button>' +
    '<span id="bot-broadcast-status" class="admin-status" style="font-size:11px;align-self:center"></span>' +
    '</div>' +
    '<div style="margin-top:14px">' + progressHtml + '</div>' +
    historyHtml
  );
}

async function adminBotBroadcastPreview() {
  var txt = String(adminBotBroadcastText || "").trim();
  if (!txt) { showToast("Type a message first", "info"); return; }
  var statusEl = document.getElementById("bot-broadcast-status");
  if (statusEl) { statusEl.textContent = "Sending preview…"; statusEl.className = "admin-status"; }
  try {
    var res = await fetch(API + "/admin/broadcast/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
      body: JSON.stringify({ text: txt }),
    });
    var data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || "HTTP " + res.status);
    if (statusEl) { statusEl.textContent = "✓ Preview sent to your Telegram"; statusEl.className = "admin-status ok"; }
  } catch (e) {
    if (statusEl) { statusEl.textContent = "Preview failed: " + e.message; statusEl.className = "admin-status err"; }
  }
}

async function adminBotBroadcastSend() {
  var txt = String(adminBotBroadcastText || "").trim();
  if (!txt) { showToast("Type a message first", "info"); return; }
  // Confirm-with-count step.
  var count = 0;
  try {
    var pr = await fetch(API + "/admin/broadcast-preview-count?audience=" + encodeURIComponent(JSON.stringify(adminBotBroadcastAudience)), { headers: { "X-Admin-Hash": ADMIN_HASH } });
    if (pr.ok) { var pd = await pr.json(); count = pd.count || 0; }
  } catch (e) {}
  if (!confirm("Send this message to " + count + " linked users?")) return;
  var statusEl = document.getElementById("bot-broadcast-status");
  if (statusEl) { statusEl.textContent = "Starting…"; statusEl.className = "admin-status"; }
  try {
    var res = await fetch(API + "/admin/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
      body: JSON.stringify({ text: txt, audience: adminBotBroadcastAudience }),
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    adminBotActiveBroadcastId = data.id;
    adminBotBroadcastText = "";
    if (statusEl) { statusEl.textContent = "Queued " + data.recipients + " recipients"; statusEl.className = "admin-status ok"; }
    adminBotStartPolling();
    adminBotLoadHistory();
  } catch (e) {
    if (statusEl) { statusEl.textContent = "Send failed: " + e.message; statusEl.className = "admin-status err"; }
  }
}

async function adminBotRetryFailed() {
  if (!adminBotActiveBroadcastId) return;
  try {
    var res = await fetch(API + "/admin/broadcast/" + adminBotActiveBroadcastId + "/retry-failed", {
      method: "POST",
      headers: { "X-Admin-Hash": ADMIN_HASH },
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    adminBotStartPolling();
    showToast("Retry queued", "success");
  } catch (e) {
    showToast("Retry failed: " + e.message, "error");
  }
}

function adminBotStartPolling() {
  adminBotBroadcastPolling = true;
  (function tick() {
    if (!adminBotBroadcastPolling || !adminBotActiveBroadcastId) return;
    fetch(API + "/admin/broadcast/" + adminBotActiveBroadcastId, { headers: { "X-Admin-Hash": ADMIN_HASH } })
      .then(function (r) { return r.json(); })
      .then(function (rec) {
        adminBotActiveBroadcast = rec;
        if (adminBotSubtab === "broadcast" && adminActiveTab === "bot") render();
        if (rec && rec.status !== "done") {
          setTimeout(tick, 2000);
        } else {
          adminBotBroadcastPolling = false;
          adminBotLoadHistory();
        }
      })
      .catch(function () { setTimeout(tick, 4000); });
  })();
}

function adminBotStopPolling() {
  adminBotBroadcastPolling = false;
  if (adminBotStatsTimer) { clearInterval(adminBotStatsTimer); adminBotStatsTimer = null; }
}

// ---- SCHEDULES ----
async function adminBotLoadSchedules() {
  try {
    var res = await fetch(API + "/search?sheet=Settings&Key=bot_schedules");
    if (res.ok) {
      var rows = await res.json();
      if (rows && rows.length) {
        try {
          adminBotSchedules = JSON.parse(rows[0].Value || rows[0].value || "[]");
        } catch (e) { adminBotSchedules = []; }
      } else {
        adminBotSchedules = [];
      }
    }
  } catch (e) {
    adminBotSchedulesError = e.message;
  }
  if (!Array.isArray(adminBotSchedules) || !adminBotSchedules.length) {
    adminBotSchedules = [{ id: "default", label: "Day-before reminder", hoursBeforeTest: 9, templateKey: "reminder", active: true }];
  }
  adminBotSchedulesLoaded = true;
  render();
}

function renderBotSchedules() {
  if (!adminBotSchedulesLoaded) {
    return '<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">Loading…</div>';
  }
  if (adminBotSchedulesError) {
    return '<div class="err-banner">' + esc(adminBotSchedulesError) + '</div>';
  }
  var rows = adminBotSchedules.map(function (s, i) {
    return (
      '<div class="session-row" style="flex-direction:column;align-items:stretch;margin-bottom:8px">' +
      '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
      '<input class="session-input" type="text" placeholder="Label" value="' + esc(s.label || "") + '" oninput="adminBotUpdateSched(' + i + ",'label',this.value)\" style=\"flex:1;min-width:140px\" />" +
      '<input class="session-input" type="number" min="0" max="168" value="' + (s.hoursBeforeTest || 0) + '" oninput="adminBotUpdateSched(' + i + ",'hoursBeforeTest',+this.value)\" style=\"width:64px\" />" +
      '<span style="font-size:11px;color:var(--muted)">h before test</span>' +
      '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)"><input type="checkbox" ' + (s.active ? "checked" : "") + ' onchange="adminBotUpdateSched(' + i + ",'active',this.checked)\" /> active</label>" +
      '<button class="session-del" onclick="adminBotDeleteSched(' + i + ')" ' + (adminBotSchedules.length > 1 ? "" : "disabled") + '>&#215;</button>' +
      '</div></div>'
    );
  }).join("");

  return (
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">' +
    'Define when the daily reminder fires. The cron runs hourly and triggers each active entry once when (test date − hours) lands in the current hour.' +
    '</div>' +
    rows +
    '<button class="add-session-btn" onclick="adminBotAddSched()">+ Add schedule</button>' +
    '<div id="bot-schedules-status" class="admin-status"></div>' +
    '<button class="btn-primary" style="margin-top:12px" onclick="adminBotSaveSchedules()">Save schedules</button>' +
    '<button class="btn-secondary" onclick="adminBotSchedules=null;adminBotSchedulesLoaded=false;adminBotLoadSchedules()">Discard changes</button>'
  );
}
function adminBotUpdateSched(i, field, value) {
  if (!adminBotSchedules || !adminBotSchedules[i]) return;
  adminBotSchedules[i][field] = value;
  if (field === "active") render();
}
function adminBotAddSched() {
  if (!adminBotSchedules) adminBotSchedules = [];
  adminBotSchedules.push({
    id: "s" + Date.now().toString(36),
    label: "New reminder",
    hoursBeforeTest: 1,
    templateKey: "reminder",
    active: true,
  });
  render();
}
function adminBotDeleteSched(i) {
  if (!adminBotSchedules || adminBotSchedules.length <= 1) return;
  adminBotSchedules.splice(i, 1);
  render();
}
async function adminBotSaveSchedules() {
  var statusEl = document.getElementById("bot-schedules-status");
  if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "admin-status"; }
  try {
    var res = await fetch(API + "/Key/bot_schedules?sheet=Settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Admin-Hash": ADMIN_HASH },
      body: JSON.stringify({ data: { Value: JSON.stringify(adminBotSchedules) } }),
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    if (statusEl) { statusEl.textContent = "✓ Saved"; statusEl.className = "admin-status ok"; }
    showToast("Schedules saved", "success");
  } catch (e) {
    if (statusEl) { statusEl.textContent = "Save failed: " + e.message; statusEl.className = "admin-status err"; }
  }
}

// ---- STATS ----
async function adminBotLoadStats() {
  adminBotStatsLoading = true;
  adminBotStatsError = "";
  render();
  try {
    var res = await fetch(API + "/admin/bot-stats", { headers: { "X-Admin-Hash": ADMIN_HASH } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    adminBotStats = await res.json();
  } catch (e) {
    adminBotStatsError = e.message;
  }
  adminBotStatsLoading = false;
  // Refresh every 30 seconds while user stays on the Stats tab.
  if (adminBotStatsTimer) clearInterval(adminBotStatsTimer);
  if (adminBotSubtab === "stats" && adminActiveTab === "bot") {
    adminBotStatsTimer = setInterval(function () {
      if (adminBotSubtab === "stats" && adminActiveTab === "bot") {
        adminBotLoadStats();
      } else {
        clearInterval(adminBotStatsTimer);
        adminBotStatsTimer = null;
      }
    }, 30000);
  }
  render();
}

function renderBotStats() {
  if (adminBotStatsLoading && !adminBotStats) {
    return '<div style="font-size:12px;color:var(--muted);padding:20px 0;text-align:center">Loading…</div>';
  }
  if (adminBotStatsError) {
    return '<div class="err-banner">' + esc(adminBotStatsError) + '</div>';
  }
  var s = adminBotStats || {};
  function row(label, val, color) {
    return '<div style="display:flex;justify-content:space-between;font-size:13px;padding:6px 0;border-bottom:1px dashed var(--border)">' +
      '<span style="color:var(--muted)">' + esc(label) + '</span>' +
      '<span style="font-weight:600;' + (color ? "color:" + color : "") + '">' + esc(val) + '</span></div>';
  }
  var lb = s.lastBroadcast;
  var lbText = lb
    ? lb.sent + ' sent / ' + lb.recipients + ' (' + lb.status + ') · ' + String(lb.createdAt).slice(0, 16).replace('T', ' ')
    : 'None yet';
  var ns = s.nextScheduledSend;
  var nsText = ns
    ? ns.label + ' — ' + String(ns.fireAt).slice(0, 16).replace('T', ' ') + ' UTC'
    : 'No active schedules / no test date';
  return (
    '<div style="font-size:12px;color:var(--muted);margin-bottom:12px">Live stats — refreshes every 30s.</div>' +
    row('Total registrations', s.totalRegistrations || 0) +
    row('Linked to Telegram', s.linkedCount || 0, '#3dbd8b') +
    row('Not linked', s.unlinkedCount || 0, (s.unlinkedCount > 0 ? '#BA7517' : '')) +
    row('Last broadcast', lbText) +
    row('Next scheduled send', nsText) +
    row('Last reminder fired', s.reminderSent || 'Never') +
    (s.lastCronError
      ? '<div style="margin-top:10px;padding:8px 10px;background:#FCEBEB;border:1px solid #F09595;border-radius:6px;font-size:11px;color:#791F1F">⚠ Last cron error: ' + esc(s.lastCronError) + '</div>'
      : '') +
    '<button class="btn-secondary" style="margin-top:14px;padding:6px 14px;font-size:12px" onclick="adminBotLoadStats()">Refresh now</button>'
  );
}

initTheme();
loadSeats();
