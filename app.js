/**
 * JoSAA Round Tracker & Analyzer 2026
 * Application Logic with Multi-Category/Gender support, auto-discovery loader
 * PARSER v3 — inline institute/program split (no post-processing needed)
 *
 * PERF FIX (v3.1):
 *   - Debounced input handlers for rank/allotment (was: synchronous on every keystroke).
 *   - Split render path: rank/allotment changes only re-render advisory + table;
 *     matching is skipped entirely (matching depends only on prefs/cat/gender).
 *   - Precompute normalize() / tokenize() on round records at parse time.
 *   - Cache the (category, gender)-filtered subset of records so matchAllRounds()
 *     does the filter once per recalc, not once per preference.
 *   - Debounced localStorage save (was: serialize full prefs on every keystroke).
 *
 * PERF FIX (v3.2):
 *   - Incremental table updates. Previously every rank/allotment keystroke did
 *     `tableBody.innerHTML = html` for ALL rows (200 prefs × 8 cols = 1600 cells
 *     of DOM teardown + rebuild + layout + paint). Now rank/allotment changes
 *     only touch the gap cell and row class for rows that actually changed —
 *     no innerHTML rebuild. Full rebuild still happens for search/filter/cat/gender.
 */
console.log('[JoSAA] app.js v3.2 loaded');

// Application State
const state = {
  preferenceOrder: [],
  userRank: null,
  allottedChoiceNo: null,
  userCategory: 'OBC-NCL',
  userGender: 'Gender-Neutral',
  roundsData: { 1: null, 2: null, 3: null, 4: null, 5: null },
  loadedRoundsCount: 0
};

// Cache of unique known institute names — used to refine the institute/program
// split when the user pastes "untidy" data (no tabs, no newlines between
// institute and program).
// Array of { orig: string, norm: string }, sorted by norm.length DESC so the
// longest matching prefix wins. Built lazily by refinePreferenceSplits() from
// the loaded round data (which is tab-separated and authoritative).
let knownInstitutesCache = null;

// PERF: cache of (category||gender) -> { filtered: records, byNorm: Map }
// Invalidated when category/gender change OR when round data is reloaded.
let matchIndexCache = null;
let matchIndexKey = null;

// PERF: cache of rendered table rows for incremental updates.
// Keyed by choiceNo. Value: { tr, gapCell, currentRowClass, currentGapHtml }.
// Populated by renderTable() after innerHTML set. Used by updateTableIncremental()
// to avoid full innerHTML rebuild on rank/allotment changes.
// Invalidated (cleared) whenever renderTable() runs a full rebuild.
let renderedRowCache = new Map();

// UI Elements
const els = {
  prefPasteInput: document.getElementById('pref-paste-input'),
  prefLoadBtn: document.getElementById('pref-load-btn'),
  prefLoadStatus: document.getElementById('pref-load-status'),

  userCategory: document.getElementById('user-category'),
  userGender: document.getElementById('user-gender'),
  userRankInput: document.getElementById('user-rank'),
  userAllotmentInput: document.getElementById('user-allotment'),

  tutorialToggle: document.getElementById('tutorial-toggle'),
  tutorialCard: document.querySelector('.tutorial-card'),

  advisoryCard: document.getElementById('advisory-card'),
  advisoryBadge: document.getElementById('advisory-badge'),
  advisoryDescription: document.getElementById('advisory-description'),

  tableThead: document.getElementById('table-thead'),
  tableBody: document.getElementById('table-body'),
  tableSearch: document.getElementById('table-search'),
  matchStatusFilter: document.getElementById('match-status-filter'),
  tableSummaryText: document.getElementById('table-summary-text'),

  resetAppBtn: document.getElementById('reset-app-btn'),
  exportPdfBtn: document.getElementById('export-pdf-btn'),

  roundsPills: document.getElementById('rounds-pills'),
  themeToggleBtn: document.getElementById('theme-toggle-btn'),
  themeIcon: document.getElementById('theme-icon')
};

const moonPath = `<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>`;
const sunPath = `<circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>`;

const commonWords = [
  'and', 'or', 'of', 'in', 'for', 'with', 'under', 'on', 'at',
  'by', 'an', 'a', 'the', 'bachelor', 'master', 'technology',
  'science', 'years', 'degree', 'dual', 'integrated'
];

const quotaPriority = { 'OS': 1, 'AI': 2, 'HS': 3 };

function getQuotaPriority(quota) {
  return quotaPriority[quota] || 99;
}

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

function tokenize(str) {
  if (!str) return [];
  return str.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/).filter(t => t.length > 0);
}

// ---- PERF: debounce helper ----
// Returns a function that delays invoking `fn` until `wait`ms have elapsed
// since the last call. Trailing-edge only. The returned function also has a
// `.flush()` method to force immediate invocation (used on blur).
function debounce(fn, wait) {
  let timer = null;
  function debounced(...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  }
  debounced.flush = function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn.apply(this);
    }
  };
  debounced.cancel = function () {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return debounced;
}

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  loadStateFromLocalStorage();
  initializeTheme();
  await loadRoundData();
  recalculateAndRender();
});

function initializeTheme() {
  const savedTheme = localStorage.getItem('josaa_theme') || 'dark';
  if (savedTheme === 'light') {
    document.body.classList.add('light-theme');
    els.themeIcon.innerHTML = sunPath;
  } else {
    document.body.classList.remove('light-theme');
    els.themeIcon.innerHTML = moonPath;
  }
}

function toggleTheme() {
  const isLight = document.body.classList.toggle('light-theme');
  if (isLight) {
    els.themeIcon.innerHTML = sunPath;
    localStorage.setItem('josaa_theme', 'light');
  } else {
    els.themeIcon.innerHTML = moonPath;
    localStorage.setItem('josaa_theme', 'dark');
  }
}

function setupEventListeners() {
  // Collapsible tutorial
  els.tutorialToggle.addEventListener('click', () => {
    els.tutorialCard.classList.toggle('collapsed');
  });

  // Theme Toggle
  els.themeToggleBtn.addEventListener('click', toggleTheme);

  // Preference load
  els.prefLoadBtn.addEventListener('click', () => {
    const text = els.prefPasteInput.value;
    if (text.trim()) {
      parseAndLoadPreferenceOrder(text);
      saveStateToLocalStorage();
      recalculateAndRender();
    }
  });

  // Profile Inputs
  els.userCategory.addEventListener('change', (e) => {
    state.userCategory = e.target.value;
    invalidateMatchIndex();
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  els.userGender.addEventListener('change', (e) => {
    state.userGender = e.target.value;
    invalidateMatchIndex();
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  // PERF: rank & allotment changes do NOT affect matching — they only affect
  // advisory + gap display. So we skip matchAllRounds() entirely on these
  // events. We also debounce so a rapid sequence of keystrokes only triggers
  // one re-render.
  const onRankInput = debounce(() => {
    state.userRank = parseInt(els.userRankInput.value) || null;
    schedulePersist();
    renderAdvisoryAndTable();
  }, 150);
  els.userRankInput.addEventListener('input', onRankInput);
  els.userRankInput.addEventListener('blur', () => {
    onRankInput.flush();
    flushPersist();
  });

  const onAllotmentInput = debounce(() => {
    state.allottedChoiceNo = parseInt(els.userAllotmentInput.value) || null;
    schedulePersist();
    renderAdvisoryAndTable();
  }, 150);
  els.userAllotmentInput.addEventListener('input', onAllotmentInput);
  els.userAllotmentInput.addEventListener('blur', () => {
    onAllotmentInput.flush();
    flushPersist();
  });

  // Table Search and Filter (debounced — renderTable itself is cheap but
  // typing fast in a long list still causes layout thrash)
  const onSearchInput = debounce(renderTable, 120);
  els.tableSearch.addEventListener('input', onSearchInput);
  els.tableSearch.addEventListener('blur', onSearchInput.flush);
  els.matchStatusFilter.addEventListener('change', renderTable);

  // PDF Export
  els.exportPdfBtn.addEventListener('click', () => {
    window.print();
  });

  // Reset App
  els.resetAppBtn.addEventListener('click', () => {
    if (!confirm('Are you sure you want to clear all preference and allotment data?')) return;
    localStorage.removeItem('josaa_analyzer_state');
    state.preferenceOrder = [];
    state.userRank = null;
    state.allottedChoiceNo = null;

    els.prefPasteInput.value = '';
    els.userRankInput.value = '';
    els.userAllotmentInput.value = '';
    els.prefLoadStatus.textContent = 'No preference list loaded';
    els.prefLoadStatus.className = 'load-status';

    recalculateAndRender();
  });
}

// ---- Auto-Discovery Round Data Loader ----
async function loadRoundData() {
  els.roundsPills.innerHTML = '<span class="round-pill loading">Loading rounds...</span>';
  let loadedCount = 0;

  for (let r = 1; r <= 5; r++) {
    try {
      const response = await fetch(`data/josaaRoundData/r${r}.txt`);
      if (!response.ok) {
        break; // Stop loading subsequent rounds if 404
      }
      const text = await response.text();
      const records = parseRawRanksText(text);
      if (records.length > 0) {
        state.roundsData[r] = records;
        loadedCount++;
      } else {
        break;
      }
    } catch (e) {
      console.warn(`Round ${r} data failed to load:`, e);
      break;
    }
  }

  state.loadedRoundsCount = loadedCount;
  knownInstitutesCache = null; // Invalidate cache; will be rebuilt on next refine
  invalidateMatchIndex();
  updateRoundsDisplay();
}

function updateRoundsDisplay() {
  if (state.loadedRoundsCount === 0) {
    els.roundsPills.innerHTML = '<span class="round-pill" style="color:var(--red)">No Data</span>';
    return;
  }

  let html = '';
  for (let r = 1; r <= 5; r++) {
    const isLoaded = state.roundsData[r] !== null;
    html += `<span class="round-pill ${isLoaded ? 'active' : ''}">R${r}</span>`;
  }
  els.roundsPills.innerHTML = html;
}

// ---- TSV Parser ----
function parseRawRanksText(text) {
  const lines = text.split('\n');
  const records = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = line.split('\t');
    if (parts.length === 7) {
      const inst = parts[0].trim();
      if (inst === 'Institute' || inst.startsWith('Joint Seat Allocation')) {
        continue; // Skip header/meta lines
      }

      const prog = parts[1].trim();
      const quota = parts[2].trim().toUpperCase();
      const seatType = parts[3].trim();
      const gender = parts[4].trim();
      const openRank = parts[5].trim();
      const closeRank = parts[6].trim();

      const instProgStr = inst + ' ' + prog;
      // PERF: precompute the normalized form and token list ONCE at load time.
      // Previously these were recomputed inside findMatchesForChoice() for
      // every preference, every recalc — that was the bulk of the CPU cost.
      const normInstProg = normalize(instProgStr);
      const tokens = tokenize(instProgStr);
      const sigTokens = tokens.filter(t => !commonWords.includes(t));

      records.push({
        institute: inst,
        program: prog,
        instProgStr,
        normInstProg,
        tokens,
        sigTokens,
        quota,
        category: seatType,
        gender,
        openRank,
        closeRank
      });
    }
  }
  return records;
}

// ---- Preference Parser ----

// Split a combined "Institute Name Program Name" string into separate fields.
// Uses round data as ground truth if available; otherwise uses a heuristic
// based on the fact that JoSAA program names always contain a parenthetical
// duration like "(4 Years, Bachelor of Technology)".
function splitInstituteProgram(combined) {
  combined = combined.replace(/\s+/g, ' ').trim();
  if (!combined) return { institute: '', program: '' };

  // 1. Try round data: find the longest known institute name that is a prefix.
  if (state.loadedRoundsCount > 0) {
    if (!knownInstitutesCache) buildKnownInstitutesCache();
    if (knownInstitutesCache && knownInstitutesCache.length > 0) {
      const cn = normalize(combined);
      for (const k of knownInstitutesCache) {
        if (k.norm && cn.startsWith(k.norm)) {
          const instLower = k.orig.toLowerCase().replace(/\s+/g, ' ').trim();
          const combLower = combined.toLowerCase().replace(/\s+/g, ' ').trim();
          if (combLower.indexOf(instLower) === 0) {
            const prog = combined.substring(k.orig.length).trim();
            if (prog) return { institute: k.orig, program: prog };
          }
        }
      }
    }
  }

  // 2. Heuristic fallback: find the program name by looking for the
  //    parenthetical duration pattern. JoSAA programs always end with something
  //    like "(4 Years, Bachelor of Technology)" or "(5 Years, B.Tech. + M.Tech./MS (Dual Degree))".
  //    The program name is the text from the start of the program field to the
  //    end. We detect it by finding "(N Years," and working backwards to the
  //    start of the program name.
  //
  //    Strategy: institute names don't contain "(N Years," — so we find the
  //    FIRST "(<digit> Years," in the string. Everything from the start of the
  //    word before that parenthetical (the program name) to the end is the
  //    program. Everything before that is the institute.
  const parenMatch = combined.match(/\(\d+\s+Years,/);
  if (parenMatch) {
    const parenIdx = combined.indexOf(parenMatch[0]);
    // Walk backwards from parenIdx to find the start of the program name.
    // The program name starts at the word boundary before the parenthetical.
    let progStart = parenIdx;
    // Skip whitespace before the parenthetical
    while (progStart > 0 && combined[progStart - 1] === ' ') progStart--;
    // Now skip the program name words (they end at the institute boundary)
    // We need to find where the institute name ends. We do this by looking
    // for known institute-ending patterns. Most JoSAA institute names end
    // with a city/location name. We'll use a simpler heuristic: the institute
    // name is everything up to the LAST word that looks like a location,
    // and the program name starts after that.
    //
    // Actually, simplest reliable approach: find the FIRST known institute
    // prefix and use its length. If we can't, just split at the word boundary
    // right before the program name.
    //
    // For now, use this: the program name typically starts with a known
    // keyword like "Computer", "Electrical", "Mechanical", "Civil", "Chemical",
    // "Aerospace", "Engineering", "Mathematics", "Physics", "Chemistry",
    // "Data", "Artificial", "Intelligent", "Biotechnology", "Metallurgical",
    // "Materials", "Industrial", "Instrumentation", "Energy", "Space",
    // "BS", "B.Tech", "B. Tech".
    const progKeywords = [
      'Computer', 'Electrical', 'Mechanical', 'Civil', 'Chemical',
      'Aerospace', 'Engineering', 'Mathematics', 'Physics', 'Chemistry',
      'Data', 'Artificial', 'Intelligent', 'Biotechnology', 'Biochemical',
      'Metallurgical', 'Materials', 'Industrial', 'Instrumentation',
      'Energy', 'Space', 'BS', 'B.Tech', 'B. Tech', 'Economics',
      'Computational', 'Electronics', 'Mining', 'Metallurgy',
      'Production', 'Architecture', 'Planning', 'Polymer', 'Ceramic',
      'Pharmaceutical', 'Textile', 'Agricultural', 'Dairy', 'Food',
      'Leather', 'Paint', 'Paper', 'Packaging', 'Ocean', 'Naval',
      'Metallurgy', 'mining'
    ];
    // Find the first occurrence of a program keyword in the string
    let bestIdx = -1;
    for (const kw of progKeywords) {
      const re = new RegExp('\\b' + kw.replace(/\./g, '\\.') + '\\b', 'i');
      const m = combined.match(re);
      if (m) {
        const idx = combined.indexOf(m[0]);
        if (bestIdx === -1 || idx < bestIdx) bestIdx = idx;
      }
    }
    if (bestIdx > 0 && bestIdx < parenIdx) {
      return {
        institute: combined.substring(0, bestIdx).trim(),
        program: combined.substring(bestIdx).trim()
      };
    }
    // Can't find program keyword — just return the whole thing as institute
    return { institute: combined, program: '' };
  }

  // 3. No parenthetical found — can't split, leave everything as institute
  return { institute: combined, program: '' };
}

function parseAndLoadPreferenceOrder(text) {
  // Pre-process: inject newlines before choice-number boundaries
  // Splits "...Technology) 2 Indian Institute..." on a single line.
  // IMPORTANT: use [ ]+ (space only) after the digit, NOT \s+, so we don't
  // break TSV format where the digit is followed by a tab.
  const instPrefixes = 'Indian|National|International|Birla|Visvesvaraya|Maulana|Malaviya|Atal|Sardar|Jawaharlal|School|Dr\\.';
  const splitRe = new RegExp('(?<=\\S)\\s+(\\d+)[ ]+(?=' + instPrefixes + ')', 'gi');
  text = text.replace(splitRe, '\n$1 ');
  const lines = text.split('\n');
  const parsed = [];
  let currentChoice = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Check if the line has tabs and starts with a number (classic TSV format)
    let tabParts = line.split('\t');
    if (tabParts.length >= 3 && /^\d+$/.test(tabParts[0].trim())) {
      if (currentChoice && currentChoice.institute) {
        parsed.push(currentChoice);
      }
      currentChoice = {
        choiceNo: parseInt(tabParts[0].trim(), 10),
        institute: tabParts[1].trim(),
        program: tabParts[2].trim(),
        combinedNorm: '',
        tokens: [],
        ranks: {}
      };
      continue;
    }

    // Check if line starts with a number (space-separated or untidy format)
    const numberMatch = line.match(/^(\d+)(?:\s+(.*))?$/);

    if (numberMatch) {
      const choiceNo = parseInt(numberMatch[1], 10);
      const rest = numberMatch[2] ? numberMatch[2].trim() : '';

      if (currentChoice && currentChoice.institute) {
        parsed.push(currentChoice);
      }

      // INLINE SPLIT: if rest contains the full "Institute Program" text,
      // split it now using round data or heuristic.
      let institute = rest;
      let program = '';
      if (rest) {
        const split = splitInstituteProgram(rest);
        institute = split.institute;
        program = split.program;
      }

      currentChoice = {
        choiceNo: choiceNo,
        institute: institute,
        program: program,
        combinedNorm: '',
        tokens: [],
        ranks: {}
      };
    } else {
      if (currentChoice) {
        if (!currentChoice.institute) {
          currentChoice.institute = line;
        } else {
          if (currentChoice.program) {
            currentChoice.program += ' ' + line;
          } else {
            currentChoice.program = line;
          }
        }
      }
    }
  }

  if (currentChoice && currentChoice.institute) {
    parsed.push(currentChoice);
  }

  // Post-process normalization & tokenization
  parsed.forEach(c => {
    c.institute = c.institute.replace(/\s+/g, ' ').trim();
    c.program = c.program.replace(/\s+/g, ' ').trim();
    const combined = c.institute + ' ' + c.program;
    c.combinedNorm = normalize(combined);
    c.tokens = tokenize(combined);
    c.sigTokens = c.tokens.filter(t => !commonWords.includes(t));
  });

  state.preferenceOrder = parsed.sort((a, b) => a.choiceNo - b.choiceNo);

  // Log to console for debugging
  let emptyCount = 0;
  for (const c of state.preferenceOrder) {
    if (!c.program) emptyCount++;
  }
  console.log(`[JoSAA] Parsed ${state.preferenceOrder.length} choices, ${emptyCount} empty programs`);

  if (state.preferenceOrder.length > 0) {
    els.prefLoadStatus.textContent = `${state.preferenceOrder.length} choices loaded`;
    els.prefLoadStatus.className = 'load-status success';
  } else {
    els.prefLoadStatus.innerHTML = '<span style="color:var(--red)">Failed to parse. Refer to the tutorial step-by-step.</span>';
    els.prefLoadStatus.className = 'load-status';
  }
}

// ---- Institute / Program Split Refiner ----
// When the user pastes "untidy" data with no tabs and no newlines between
// institute and program, parseAndLoadPreferenceOrder() dumps the entire
// "Institute Program" string into choice.institute and leaves choice.program
// empty. This function uses the round data files (which are tab-separated and
// contain the canonical institute/program split) as ground truth to correctly
// re-split each choice.
function buildKnownInstitutesCache() {
  knownInstitutesCache = [];
  const seen = new Set();
  for (let r = 1; r <= state.loadedRoundsCount; r++) {
    const records = state.roundsData[r];
    if (!records) continue;
    for (const rec of records) {
      if (!rec.institute) continue;
      const norm = normalize(rec.institute);
      if (!norm || seen.has(norm)) continue;
      seen.add(norm);
      knownInstitutesCache.push({ orig: rec.institute, norm: norm });
    }
  }
  // Longest first so the most specific institute wins on prefix match
  knownInstitutesCache.sort((a, b) => b.norm.length - a.norm.length);
  console.log(`[JoSAA] Built institutes cache: ${knownInstitutesCache.length} institutes, loadedRoundsCount=${state.loadedRoundsCount}`);
}

function refinePreferenceSplits() {
  // Requires round data to be loaded — the institute names in the round data
  // are the ground truth for splitting institute/program.
  if (state.loadedRoundsCount === 0) return;
  if (!knownInstitutesCache) buildKnownInstitutesCache();
  if (knownInstitutesCache.length === 0) return;

  // Quick lookup: institutes we already recognize
  const knownInstSet = new Set(knownInstitutesCache.map(k => k.norm));

  for (const choice of state.preferenceOrder) {
    // Skip if institute is already a known institute AND program is non-empty
    // — this means the original parse was clean (tab-separated) and we don't
    // need to touch it.
    if (choice.program && choice.institute && knownInstSet.has(normalize(choice.institute))) {
      continue;
    }

    const combinedOrig = (choice.institute + ' ' + choice.program).trim();
    if (!combinedOrig) continue;

    const cn = normalize(combinedOrig);

    // Find the longest known institute whose normalized form is a prefix of
    // the choice's normalized combined text.
    let matched = null;
    for (const k of knownInstitutesCache) {
      if (k.norm && cn.startsWith(k.norm)) {
        matched = k;
        break; // knownInstitutesCache is sorted longest-first
      }
    }

    if (!matched) continue;

    // Locate the institute substring in the original (un-normalized) combined
    // text so we can split there. Match case-insensitively, after collapsing
    // whitespace, to be tolerant of minor formatting differences.
    const instLower = matched.orig.toLowerCase().replace(/\s+/g, ' ').trim();
    const combLower = combinedOrig.toLowerCase().replace(/\s+/g, ' ').trim();
    const idx = combLower.indexOf(instLower);

    if (idx === 0) {
      // Institute is at the very start — everything after it is the program
      const progPart = combinedOrig.substring(matched.orig.length).trim();
      choice.institute = matched.orig;
      if (progPart) {
        choice.program = progPart;
      }
    } else {
      // Couldn't align by whitespace — fall back to using the canonical
      // institute name; keep program as-is (matching still works via combined
      // normalization).
      choice.institute = matched.orig;
    }

    // Re-normalize so matching and display stay consistent
    const combined = choice.institute + ' ' + choice.program;
    choice.combinedNorm = normalize(combined);
    choice.tokens = tokenize(combined);
    choice.sigTokens = choice.tokens.filter(t => !commonWords.includes(t));
  }
}

// ---- PERF: per-(category,gender) match index ----
// Previously, findMatchesForChoice() called records.filter(r => r.category === X && r.gender === Y)
// FOR EVERY preference choice. With ~100 prefs, that's 100x redundant filtering.
// We now build the filtered subset ONCE per recalc and reuse it for every choice.
function invalidateMatchIndex() {
  matchIndexCache = null;
  matchIndexKey = null;
}

function getMatchIndex() {
  if (state.loadedRoundsCount === 0) return null;
  const key = state.userCategory + '||' + state.userGender;
  if (matchIndexCache && matchIndexKey === key) return matchIndexCache;

  // Build per-round filtered subsets. Each entry is the list of records in
  // round r matching the current (category, gender).
  const perRound = [];
  for (let r = 1; r <= state.loadedRoundsCount; r++) {
    const records = state.roundsData[r];
    if (!records) {
      perRound.push(null);
      continue;
    }
    // PERF: for-loop is meaningfully faster than .filter() here because we
    // also want to skip records with no usable program string.
    const filtered = [];
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (rec.category === state.userCategory && rec.gender === state.userGender) {
        filtered.push(rec);
      }
    }
    perRound.push(filtered);
  }
  matchIndexCache = { perRound };
  matchIndexKey = key;
  return matchIndexCache;
}

// ---- Priority Matching Logic ----
function matchAllRounds() {
  if (state.preferenceOrder.length === 0) return;

  const category = state.userCategory;
  const gender = state.userGender;
  const index = getMatchIndex();
  if (!index) return;

  for (const choice of state.preferenceOrder) {
    // Reset ranks
    for (let r = 1; r <= 5; r++) {
      choice.ranks[r] = null;
    }

    // Match each loaded round
    for (let r = 1; r <= state.loadedRoundsCount; r++) {
      const filtered = index.perRound[r - 1];
      if (!filtered || filtered.length === 0) continue;

      const matches = findMatchesForChoice(choice, filtered);
      if (matches.length > 0) {
        // Sort by quota priority OS > AI > HS
        matches.sort((a, b) => getQuotaPriority(a.quota) - getQuotaPriority(b.quota));
        choice.ranks[r] = matches[0].closeRank;
      }
    }
  }
}

// PERF: this function previously:
//   1. Re-filtered `records` by category+gender on every call (now done once
//      in getMatchIndex()).
//   2. Recomputed normalize(r.instProgStr) on every record on every call
//      (now precomputed at parse time as r.normInstProg).
//   3. Recomputed tokenize(r.instProgStr) on every call (now precomputed as
//      r.tokens and r.sigTokens).
function findMatchesForChoice(choice, filtered) {
  const cn = choice.combinedNorm;
  const matches = [];

  // 1. Direct normalized string containment
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    const rn = r.normInstProg;
    if (!rn) continue;
    if (rn === cn || rn.includes(cn) || cn.includes(rn)) {
      matches.push(r);
    }
  }

  if (matches.length > 0) return matches;

  // 2. Token containment (handles split cells) — uses precomputed sigTokens
  const cToks = choice.sigTokens;
  if (cToks.length >= 3) {
    for (let i = 0; i < filtered.length; i++) {
      const r = filtered[i];
      const rToks = r.sigTokens;
      if (rToks.length < 3) continue;
      let allIn = true;
      for (let j = 0; j < rToks.length; j++) {
        if (!cToks.includes(rToks[j])) { allIn = false; break; }
      }
      if (allIn) matches.push(r);
    }
  }

  if (matches.length > 0) return matches;

  // 3. Fuzzy Jaccard score fallback
  let best = null, bestScore = 0;
  for (let i = 0; i < filtered.length; i++) {
    const r = filtered[i];
    const rToks = r.sigTokens;
    if (rToks.length < 3) continue;
    let overlap = 0;
    for (let j = 0; j < rToks.length; j++) {
      if (cToks.includes(rToks[j])) overlap++;
    }
    const score = overlap / Math.max(rToks.length, cToks.length);
    if (score > bestScore && score > 0.7) {
      bestScore = score;
      best = r;
    }
  }

  if (best) matches.push(best);
  return matches;
}

// ---- Minimalist Advisory Engine ----
function updateAdvisory() {
  if (!state.userRank || !state.allottedChoiceNo || state.preferenceOrder.length === 0 || state.loadedRoundsCount === 0) {
    els.advisoryCard.style.display = 'none';
    return;
  }

  const allotted = state.preferenceOrder.find(c => c.choiceNo === state.allottedChoiceNo);
  if (!allotted) {
    showAdvisory('danger', 'ERROR', `Choice #${state.allottedChoiceNo} is not in the preference list.`);
    return;
  }

  const latestRound = state.loadedRoundsCount;
  const higher = state.preferenceOrder.filter(c => c.choiceNo < state.allottedChoiceNo);

  if (higher.length === 0) {
    showAdvisory('freeze', 'FREEZE', 'You are allotted your #1 preference. No higher choice to float to.');
    return;
  }

  let securedCount = 0;
  let nearestChoice = null;
  let nearGap = Infinity;

  for (const c of higher) {
    const rVal = c.ranks[latestRound];
    if (!rVal) continue;

    const cr = parseInt(rVal.replace('P', ''), 10);
    if (isNaN(cr)) continue;

    const gap = cr - state.userRank;
    if (gap >= 0) {
      securedCount++;
    } else {
      const absGap = Math.abs(gap);
      if (absGap < nearGap) {
        nearGap = absGap;
        nearestChoice = { c, cr, gap: absGap };
      }
    }
  }

  if (securedCount > 0) {
    showAdvisory('float', 'FLOAT', `Rank clears ${securedCount} higher choice${securedCount > 1 ? 's' : ''} in R${latestRound}. Highly recommend floating.`);
  } else if (nearestChoice) {
    const pct = ((nearestChoice.gap / nearestChoice.cr) * 100).toFixed(0);
    if (nearestChoice.gap <= 100 || pct <= 10) {
      showAdvisory('float', 'FLOAT', `Only ${nearestChoice.gap} ranks (${pct}%) from choice #${nearestChoice.c.choiceNo} in R${latestRound}. Recommend floating.`);
    } else {
      showAdvisory('float', 'FLOAT', `Nearest upgrade (#${nearestChoice.c.choiceNo}) is ${nearestChoice.gap} ranks away (${pct}%). Recommend floating to keep options open.`);
    }
  } else {
    showAdvisory('freeze', 'INFO', 'No cutoff data found for higher preferences in this round.');
  }
}

function showAdvisory(cls, badge, text) {
  els.advisoryCard.style.display = 'flex';
  els.advisoryCard.className = 'advisory-bar ' + cls;
  els.advisoryBadge.textContent = badge;
  els.advisoryDescription.textContent = text;
}

// ---- Gap HTML helper (extracted for reuse by incremental updates) ----
function computeGapHtml(choice) {
  let gapHtml = '<span class="gap none">—</span>';
  const latestVal = choice.ranks[state.loadedRoundsCount];
  if (latestVal && state.userRank) {
    const cr = parseInt(latestVal.replace('P', ''), 10);
    if (!isNaN(cr)) {
      const diff = cr - state.userRank;
      if (diff >= 0) {
        gapHtml = `<span class="gap pos">+${diff}</span>`;
      } else {
        const absDiff = Math.abs(diff);
        const margin = cr * 0.15;
        if (absDiff <= Math.max(150, margin)) {
          gapHtml = `<span class="gap close">-${absDiff}</span>`;
        } else {
          gapHtml = `<span class="gap neg">-${absDiff}</span>`;
        }
      }
    }
  }
  return gapHtml;
}

// Compute the row class for a choice based on current allotment.
function computeRowClass(choice) {
  if (!state.allottedChoiceNo) return '';
  if (choice.choiceNo === state.allottedChoiceNo) return 'allotted-seat';
  if (choice.choiceNo > state.allottedChoiceNo) return 'lower-preference';
  return '';
}

// ---- Table Rendering ----
function renderTable() {
  const query = (els.tableSearch.value || '').trim().toLowerCase();
  const filter = els.matchStatusFilter.value;

  if (state.preferenceOrder.length === 0) {
    renderedRowCache.clear();
    els.tableThead.innerHTML = `<tr>
      <th class="text-center" width="55">#</th>
      <th>Institute Name</th>
      <th>Program Name</th>
      <th class="text-center" width="85">Gap</th>
    </tr>`;
    els.tableBody.innerHTML = `<tr>
      <td colspan="4" class="empty-state">
        <p>Enter and load your preference order text list in the left panel to begin analysis.</p>
      </td>
    </tr>`;
    els.tableSummaryText.textContent = 'No preference order loaded.';
    return;
  }

  // Set headers dynamically based on loaded rounds
  let roundHeaders = '';
  for (let r = 1; r <= state.loadedRoundsCount; r++) {
    roundHeaders += `<th class="text-center" width="70">R${r}</th>`;
  }
  els.tableThead.innerHTML = `<tr>
    <th class="text-center" width="55">#</th>
    <th>Institute Name</th>
    <th>Program Name</th>
    ${roundHeaders}
    <th class="text-center" width="85">Gap</th>
  </tr>`;

  const list = state.preferenceOrder.filter(c => {
    if (query && !c.institute.toLowerCase().includes(query) && !c.program.toLowerCase().includes(query)) return false;
    if (filter === 'matched' && !Object.values(c.ranks).some(r => r)) return false;
    if (filter === 'above' && state.allottedChoiceNo && c.choiceNo >= state.allottedChoiceNo) return false;
    return true;
  });

  els.tableSummaryText.textContent = `${list.length} of ${state.preferenceOrder.length} choices shown`;

  if (list.length === 0) {
    renderedRowCache.clear();
    els.tableBody.innerHTML = `<tr><td colspan="${3 + state.loadedRoundsCount + 1}" class="empty-state">No matching preferences found.</td></tr>`;
    return;
  }

  let html = '';
  for (const c of list) {
    const rowClass = computeRowClass(c);
    const gapHtml = computeGapHtml(c);

    // Render round cells
    let roundCells = '';
    for (let r = 1; r <= state.loadedRoundsCount; r++) {
      const val = c.ranks[r];
      roundCells += val
        ? `<td class="text-center"><span class="rank-val">${val}</span></td>`
        : `<td class="text-center" style="color:var(--text-muted)">—</td>`;
    }

    html += `<tr class="${rowClass}" data-choice-no="${c.choiceNo}">
      <td class="text-center" style="font-weight:700">${c.choiceNo}</td>
      <td>${c.institute}</td>
      <td>${c.program}</td>
      ${roundCells}
      <td class="text-center">${gapHtml}</td>
    </tr>`;
  }

  els.tableBody.innerHTML = html;

  // PERF: rebuild the row cache so incremental updates can run without a
  // full innerHTML rebuild. We query the DOM once here and store references
  // to each row's <tr> and its last <td> (the gap cell).
  renderedRowCache.clear();
  const rows = els.tableBody.querySelectorAll('tr[data-choice-no]');
  for (let i = 0; i < rows.length; i++) {
    const tr = rows[i];
    const choiceNo = parseInt(tr.getAttribute('data-choice-no'), 10);
    const cells = tr.children;
    const gapCell = cells[cells.length - 1]; // last cell is always gap
    renderedRowCache.set(choiceNo, {
      tr,
      gapCell,
      currentRowClass: tr.className,
      currentGapHtml: gapCell.innerHTML
    });
  }
}

// PERF: incremental table update — only touches gap cells and row classes
// that actually changed. Avoids the full innerHTML rebuild that was the
// remaining bottleneck on rank/allotment keystrokes (200 rows × 8 cols =
// 1600 cells of DOM teardown + layout + paint per keystroke).
//
// Precondition: renderTable() must have been called at least once since the
// last full state change (preference load / category / gender / search / filter).
// If the cache is empty (e.g. table is showing empty state), this is a no-op.
function updateTableIncremental() {
  if (renderedRowCache.size === 0) {
    // No rows cached — fall back to full render. This happens when the table
    // is showing the empty state or "No matching preferences found".
    renderTable();
    return;
  }

  for (const [choiceNo, cache] of renderedRowCache) {
    const choice = state.preferenceOrder.find(c => c.choiceNo === choiceNo);
    // If the choice is no longer in the preference list (e.g. user re-loaded
    // prefs), skip — a full render will be triggered by the prefs change.
    if (!choice) continue;

    // Recompute row class
    const newRowClass = computeRowClass(choice);
    if (newRowClass !== cache.currentRowClass) {
      cache.tr.className = newRowClass;
      cache.currentRowClass = newRowClass;
    }

    // Recompute gap HTML
    const newGapHtml = computeGapHtml(choice);
    if (newGapHtml !== cache.currentGapHtml) {
      cache.gapCell.innerHTML = newGapHtml;
      cache.currentGapHtml = newGapHtml;
    }
  }
}

// ---- Render-path split (PERF) ----
// Heavy path: preferences, category, or gender changed -> re-run matching.
function recalculateAndRender() {
  refinePreferenceSplits(); // Fix institute/program split using round data
  matchAllRounds();
  updateAdvisory();
  renderTable();
}

// Light path: only rank or allotment changed -> matching is unaffected,
// just re-render advisory + incrementally update table (gap cells + row classes).
// No full innerHTML rebuild — this is the key win for large preference lists.
function renderAdvisoryAndTable() {
  updateAdvisory();
  updateTableIncremental();
}

// ---- State Management ----
// Bump this when the stored preference format changes — old data is discarded
// so users don't see stale/broken parses from a previous version of the parser.
const STATE_VERSION = 2;

// PERF: debounced save — typing 5 digits in the rank box used to JSON.stringify
// the entire preference list (which can be hundreds of KB) 5 times. Now we
// coalesce rapid changes into a single save 400ms after the last keystroke,
// and force an immediate save on blur.
const schedulePersist = debounce(() => saveStateToLocalStorage(), 400);
function flushPersist() { schedulePersist.flush(); }

function saveStateToLocalStorage() {
  try {
    localStorage.setItem('josaa_analyzer_state', JSON.stringify({
      version: STATE_VERSION,
      preferenceOrder: state.preferenceOrder,
      userRank: state.userRank,
      allottedChoiceNo: state.allottedChoiceNo,
      userCategory: state.userCategory,
      userGender: state.userGender
    }));
  } catch (e) {
    console.error('Failed to save state to localStorage:', e);
  }
}

function loadStateFromLocalStorage() {
  try {
    const raw = localStorage.getItem('josaa_analyzer_state');
    if (!raw) return;

    const s = JSON.parse(raw);
    // Discard old state from previous parser versions — they may have the
    // institute/program split wrong, and re-parsing is safer than trusting
    // stale data.
    if (!s.version || s.version < STATE_VERSION) {
      console.warn('Discarding old localStorage data (version mismatch).');
      localStorage.removeItem('josaa_analyzer_state');
      return;
    }

    state.preferenceOrder = s.preferenceOrder || [];
    state.userRank = s.userRank || null;
    state.allottedChoiceNo = s.allottedChoiceNo || null;
    state.userCategory = s.userCategory || 'OBC-NCL';
    state.userGender = s.userGender || 'Gender-Neutral';

    // Set UI values
    if (state.preferenceOrder.length > 0) {
      els.prefLoadStatus.textContent = `${state.preferenceOrder.length} choices loaded`;
      els.prefLoadStatus.className = 'load-status success';

      // Reconstruct paste field contents
      let text = '';
      for (const c of state.preferenceOrder) {
        text += `${c.choiceNo}\t${c.institute}\t${c.program}\n`;
      }
      els.prefPasteInput.value = text;
    }

    els.userCategory.value = state.userCategory;
    els.userGender.value = state.userGender;
    if (state.userRank) els.userRankInput.value = state.userRank;
    if (state.allottedChoiceNo) els.userAllotmentInput.value = state.allottedChoiceNo;
  } catch (e) {
    console.error('Failed to load state from localStorage:', e);
  }
}
