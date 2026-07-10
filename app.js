/**
 * JoSAA Round Tracker & Analyzer 2026
 * Application Logic with Multi-Category/Gender support, auto-discovery loader
 */

// Application State
const state = {
  preferenceOrder: [],
  userRank: null,
  allottedChoiceNo: null,
  userCategory: 'OBC-NCL',
  userGender: 'Gender-Neutral',
  roundsData: { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null },
  loadedRoundsCount: 0
};

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
  corsBanner: document.getElementById('cors-banner'),
  corsBannerClose: document.getElementById('cors-banner-close')
};

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

// ---- Initialization ----
document.addEventListener('DOMContentLoaded', async () => {
  setupEventListeners();
  loadStateFromLocalStorage();
  checkProtocol();
  await loadRoundData();
  recalculateAndRender();
});

function checkProtocol() {
  if (window.location.protocol === 'file:') {
    els.corsBanner.style.display = 'flex';
  }
}

function setupEventListeners() {
  // Collapsible tutorial
  els.tutorialToggle.addEventListener('click', () => {
    els.tutorialCard.classList.toggle('collapsed');
  });

  // CORS banner close
  els.corsBannerClose.addEventListener('click', () => {
    els.corsBanner.style.display = 'none';
  });

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
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  els.userGender.addEventListener('change', (e) => {
    state.userGender = e.target.value;
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  els.userRankInput.addEventListener('input', (e) => {
    state.userRank = parseInt(e.target.value) || null;
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  els.userAllotmentInput.addEventListener('input', (e) => {
    state.allottedChoiceNo = parseInt(e.target.value) || null;
    saveStateToLocalStorage();
    recalculateAndRender();
  });

  // Table Search and Filter
  els.tableSearch.addEventListener('input', renderTable);
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
  
  for (let r = 1; r <= 6; r++) {
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
  updateRoundsDisplay();
}

function updateRoundsDisplay() {
  if (state.loadedRoundsCount === 0) {
    els.roundsPills.innerHTML = '<span class="round-pill" style="color:var(--red)">No Data</span>';
    return;
  }
  
  let html = '';
  for (let r = 1; r <= 6; r++) {
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
      
      records.push({
        instProgStr: inst + ' ' + prog,
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
function parseAndLoadPreferenceOrder(text) {
  const lines = text.split('\n');
  const parsed = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    let parts = line.split('\t');
    if (parts.length < 3) {
      parts = line.split(',');
    }
    if (parts.length < 3) continue;
    
    const choiceNoStr = parts[0].trim();
    if (!/^\d+$/.test(choiceNoStr)) {
      continue; // Skip lines that don't start with a number
    }
    
    const choiceNo = parseInt(choiceNoStr, 10);
    const inst = parts[1].trim();
    const prog = parts[2].trim();
    
    const combined = inst + ' ' + prog;
    parsed.push({
      choiceNo,
      institute: inst,
      program: prog,
      combinedNorm: normalize(combined),
      tokens: tokenize(combined),
      ranks: {}
    });
  }
  
  state.preferenceOrder = parsed.sort((a, b) => a.choiceNo - b.choiceNo);
  
  if (state.preferenceOrder.length > 0) {
    els.prefLoadStatus.textContent = `${state.preferenceOrder.length} choices loaded`;
    els.prefLoadStatus.className = 'load-status success';
  } else {
    els.prefLoadStatus.textContent = 'Failed to parse text';
    els.prefLoadStatus.className = 'load-status';
  }
}

// ---- Priority Matching Logic ----
function matchAllRounds() {
  if (state.preferenceOrder.length === 0) return;
  
  const category = state.userCategory;
  const gender = state.userGender;
  
  for (const choice of state.preferenceOrder) {
    // Reset ranks
    for (let r = 1; r <= 6; r++) {
      choice.ranks[r] = null;
    }
    
    // Match each loaded round
    for (let r = 1; r <= state.loadedRoundsCount; r++) {
      const records = state.roundsData[r];
      if (!records) continue;
      
      const matches = findMatchesForChoice(choice, records, category, gender);
      if (matches.length > 0) {
        // Sort by quota priority OS > AI > HS
        matches.sort((a, b) => getQuotaPriority(a.quota) - getQuotaPriority(b.quota));
        choice.ranks[r] = matches[0].closeRank;
      }
    }
  }
}

function findMatchesForChoice(choice, records, category, gender) {
  // Strict filter on category and gender
  const filtered = records.filter(r => r.category === category && r.gender === gender);
  const cn = choice.combinedNorm;
  const matches = [];
  
  // 1. Direct normalized string containment
  for (const r of filtered) {
    const rn = normalize(r.instProgStr);
    if (rn === cn || rn.includes(cn) || cn.includes(rn)) {
      matches.push(r);
    }
  }
  
  if (matches.length > 0) return matches;
  
  // 2. Token containment (handles split cells)
  for (const r of filtered) {
    const rToks = tokenize(r.instProgStr).filter(t => !commonWords.includes(t));
    if (rToks.length >= 3 && rToks.every(t => choice.tokens.includes(t))) {
      matches.push(r);
    }
  }
  
  if (matches.length > 0) return matches;
  
  // 3. Fuzzy Jaccard score fallback
  let best = null, bestScore = 0;
  const cToks = choice.tokens.filter(t => !commonWords.includes(t));
  for (const r of filtered) {
    const rToks = tokenize(r.instProgStr).filter(t => !commonWords.includes(t));
    if (rToks.length < 3) continue;
    let overlap = 0;
    for (const t of rToks) { if (cToks.includes(t)) overlap++; }
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

// ---- Table Rendering ----
function renderTable() {
  const query = (els.tableSearch.value || '').trim().toLowerCase();
  const filter = els.matchStatusFilter.value;
  
  if (state.preferenceOrder.length === 0) {
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
    els.tableBody.innerHTML = `<tr><td colspan="${3 + state.loadedRoundsCount + 1}" class="empty-state">No matching preferences found.</td></tr>`;
    return;
  }
  
  let html = '';
  for (const c of list) {
    let rowClass = '';
    if (state.allottedChoiceNo) {
      if (c.choiceNo === state.allottedChoiceNo) rowClass = 'allotted-seat';
      else if (c.choiceNo > state.allottedChoiceNo) rowClass = 'lower-preference';
    }
    
    // Render round cells
    let roundCells = '';
    for (let r = 1; r <= state.loadedRoundsCount; r++) {
      const val = c.ranks[r];
      roundCells += val
        ? `<td class="text-center"><span class="rank-val">${val}</span></td>`
        : `<td class="text-center" style="color:var(--text-muted)">—</td>`;
    }
    
    // Calculate gap for latest round
    let gapHtml = '<span class="gap none">—</span>';
    const latestVal = c.ranks[state.loadedRoundsCount];
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
    
    html += `<tr class="${rowClass}">
      <td class="text-center" style="font-weight:700">${c.choiceNo}</td>
      <td>${c.institute}</td>
      <td>${c.program}</td>
      ${roundCells}
      <td class="text-center">${gapHtml}</td>
    </tr>`;
  }
  
  els.tableBody.innerHTML = html;
}

function recalculateAndRender() {
  matchAllRounds();
  updateAdvisory();
  renderTable();
}

// ---- State Management ----
function saveStateToLocalStorage() {
  try {
    localStorage.setItem('josaa_analyzer_state', JSON.stringify({
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
