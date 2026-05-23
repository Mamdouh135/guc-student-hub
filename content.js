//
/**
 * GUC Transcript GPA Calculator - Content Script
 * Multi-page semester support: stores each semester separately
 * Aggregates all stored semesters for cumulative GPA
 */
(function() {
  console.log('🎓 GUC GPA Calculator: Script loaded');
  
  // Configuration
  const CONFIG = {
    MIN_GRADE: 0.7,       // Best grade
    MAX_GRADE: 5.0,       // Failing grade
    PASS_THRESHOLD: 4.0,  // Grades above this are failing
    STORAGE_KEY: 'gucSemesters',  // Key for storing all semesters
    GERMAN_CREDITS: {
      1: 2,  // German 1: 2 credits
      2: 4,  // German 2: 4 credits (replaces German 1)
      3: 6,  // German 3: 6 credits (replaces German 1 & 2)
      4: 8   // German 4: 8 credits (replaces all previous)
    }
  };

  // State
  let isEnabled = true;
  let isDarkMode = false;
  let currentSemesterData = [];   // Courses from current page
  let allSemestersData = {};      // All stored semesters {semesterId: courses[]}
  let predictedGrades = {};
  let userPendingCourses = [];
  const USER_PENDING_KEY = 'userPendingCourses';
  let transcriptTable = null;
  let semesterDropdown = null;
  let currentSemesterId = '';
  let creditHoursCol = -1;
  let gradeCol = -1;
  let whatIfOverrides = {};        // In-memory only — never persisted

  // Initialize extension
  async function init() {
    console.log('🎓 GUC GPA Calculator: Initializing...');
    
    // Safety check: Only run on the transcript page
    if (!window.location.href.toLowerCase().includes('transcript_001.aspx')) {
      console.log('🎓 GUC GPA Calculator: Not on transcript page. Aborting execution to prevent data corruption.');
      return;
    }
    
    // Load stored data

    try {
      const storage = await chrome.storage.local.get(['enabled', 'darkMode', 'predictedGrades', CONFIG.STORAGE_KEY, USER_PENDING_KEY]);
      isEnabled = storage.enabled !== false;
      isDarkMode = storage.darkMode || false;
      predictedGrades = storage.predictedGrades || {};
      allSemestersData = storage[CONFIG.STORAGE_KEY] || {};
      userPendingCourses = Array.isArray(storage[USER_PENDING_KEY]) ? storage[USER_PENDING_KEY] : [];
    } catch (e) {
      console.log('🎓 Storage not available, using defaults');
    }

    console.log(`🎓 Loaded ${Object.keys(allSemestersData).length} stored semester(s)`);

    if (!isEnabled) {
      console.log('🎓 GUC GPA Calculator: Extension disabled');
      return;
    }

    // Find semester dropdown first
    semesterDropdown = findSemesterDropdown();
    if (semesterDropdown) {
      currentSemesterId = getSemesterIdFromDropdown();
      console.log(`🎓 Current semester: ${currentSemesterId}`);
      
      // Watch for dropdown changes
      semesterDropdown.addEventListener('change', onSemesterChange);
    } else {
      console.log('🎓 No semester dropdown found, using page URL as identifier');
      currentSemesterId = window.location.href;
    }

    // Find all semester tables on the current year page
    const semTables = findAllSemesterTables();
    if (semTables.length === 0) {
      console.log('🎓 GUC GPA Calculator: No semester tables found — showing stored data.');
      createDashboard();
      updateGPACalculations();
      return;
    }

    console.log(`🎓 GUC GPA Calculator: Found ${semTables.length} semester table(s).`);

    // Scrape every semester table and save all at once
    scrapeCurrentSemester(semTables);
    await saveSemesterData();

    injectPredictorInputs();
    createDashboard();
    updateGPACalculations();

    if (isDarkMode) {
      document.body.classList.add('guc-dark-mode');
    }

    console.log('🎓 GUC GPA Calculator: Fully initialized!');
  }

  // Find semester selection dropdown
  function findSemesterDropdown() {
    // Common patterns for semester dropdowns
    const selectors = [
      'select[name*="semester" i]',
      'select[name*="term" i]',
      'select[id*="semester" i]',
      'select[id*="term" i]',
      'select[id*="ddl" i]',
      '#ContentPlaceHolder1_ddlSemester',
      '#ddlSemester',
      '#cboSemester'
    ];

    for (const selector of selectors) {
      const dropdown = document.querySelector(selector);
      if (dropdown) {
        console.log(`🎓 Found semester dropdown: ${selector}`);
        return dropdown;
      }
    }

    // Fallback: find any select that has semester-like options
    const allSelects = document.querySelectorAll('select');
    for (const select of allSelects) {
      const options = select.querySelectorAll('option');
      for (const opt of options) {
        const text = opt.textContent.toLowerCase();
        if (text.includes('fall') || text.includes('spring') || text.includes('summer') || 
            text.includes('semester') || text.includes('winter') || /20\d{2}/.test(text)) {
          console.log('🎓 Found semester dropdown by option content');
          return select;
        }
      }
    }

    return null;
  }

  // Get current semester ID from dropdown
  function getSemesterIdFromDropdown() {
    if (!semesterDropdown) return 'default';
    
    const selectedOption = semesterDropdown.options[semesterDropdown.selectedIndex];
    // Use both value and text for unique identification
    return selectedOption ? `${selectedOption.value}_${selectedOption.textContent.trim()}` : 'default';
  }

  async function onSemesterChange() {
    console.log('🎓 Semester changed, waiting for page update...');
    setTimeout(async () => {
      currentSemesterId = getSemesterIdFromDropdown();
      console.log(`🎓 New semester: ${currentSemesterId}`);
      const semTables = findAllSemesterTables();
      if (semTables.length > 0) {
        scrapeCurrentSemester(semTables);
        await saveSemesterData();
        updateGPACalculations();
        injectPredictorInputs();
      }
    }, 1000);
  }

  // ── Semester table discovery ──────────────────────────────────────────────
  // The GUC transcript page for a selected year renders EACH semester period
  // (Winter, Spring Makeup, Spring, Summer R1…) as its own <table>.  Every
  // such table has a <strong> semester-name label in its very first <tr>.
  // This function finds all of them and returns metadata alongside the element.
  function findAllSemesterTables() {
    const results = [];
    document.querySelectorAll('table').forEach(table => {
      const firstRow = table.querySelector('tr');
      if (!firstRow) return;
      const strong = firstRow.querySelector('strong');
      if (!strong) return;
      const label = strong.textContent.trim();
      // Only accept rows whose label looks like a real semester name
      if (!label || label.length < 3) return;
      // Must have at least 3 rows (title + header + one data or GPA row)
      if (table.querySelectorAll('tr').length < 3) return;
      // Exclude tables that are clearly not transcript tables
      const tableText = table.textContent;
      if (!(/\b(winter|spring|summer|fall|makeup|round)/i.test(label) || /\d{4}/.test(label))) return;

      const isMakeup = /makeup/i.test(label);
      // GUC uses negative session IDs for makeup/retake sessions
      const hiddenInput = firstRow.querySelector('input[type="hidden"]');
      const sessionIdVal = hiddenInput ? parseInt(hiddenInput.value) : 0;
      const isNegativeSession = sessionIdVal < 0;

      results.push({
        table,
        label,                             // e.g. "Winter 2024"
        isMakeup: isMakeup || isNegativeSession
      });
    });
    return results;
  }

  // Detect grade col + credit col for a single table using content analysis.
  // Returns { gradeCol, creditHoursCol } or null if detection fails.
  function detectColumnsForTable(table) {
    const rows = table.querySelectorAll('tr');
    if (rows.length < 2) return null;

    // Always prefer content-based detection for the GUC layout:
    // Row 0 = semester title (colspan cells), Row 1 = column headers,
    // Row 2+ = actual data.  We analyse rows 2-6.
    const columnPatterns = {};
    const dataRows = Array.from(rows).slice(2, Math.min(8, rows.length));

    dataRows.forEach(row => {
      // Skip the semester-GPA summary row
      if (row.textContent.includes('Semester GPA') || row.textContent.includes('Cumulative GPA')) return;
      const cells = row.querySelectorAll('td');
      cells.forEach((cell, idx) => {
        if (!columnPatterns[idx]) columnPatterns[idx] = { creditLike: 0, gradeLike: 0 };
        const text = cell.textContent.trim();
        const num = parseFloat(text);
        // Credit hours: integer 1–30 (GUC can have 8-credit courses)
        if (!isNaN(num) && Number.isInteger(num) && num >= 1 && num <= 30) {
          columnPatterns[idx].creditLike++;
        }
        // Numeric grades: decimal in 0.7–5.0 range with a dot
        if (!isNaN(num) && num >= 0.7 && num <= 5.0 && text.includes('.')) {
          columnPatterns[idx].gradeLike++;
        }
      });
    });

    let bestCreditCol = -1, bestCreditScore = 0;
    let bestGradeCol = -1, bestGradeScore = 0;
    for (const [col, p] of Object.entries(columnPatterns)) {
      const c = parseInt(col);
      if (p.creditLike > bestCreditScore) { bestCreditScore = p.creditLike; bestCreditCol = c; }
      if (p.gradeLike  > bestGradeScore)  { bestGradeScore  = p.gradeLike;  bestGradeCol  = c; }
    }

    // Fallback: check header row (row 1) for known keywords
    if (bestCreditCol === -1 || bestGradeCol === -1) {
      const headerRow = rows[1];
      if (headerRow) {
        headerRow.querySelectorAll('th, td').forEach((cell, idx) => {
          const t = cell.textContent.toLowerCase().trim();
          if (bestCreditCol === -1 && (t.includes('hour') || t.includes('credit') || t === 'cr')) bestCreditCol = idx;
          if (bestGradeCol  === -1 && (t.includes('numeric') || t === 'gr' || (t.includes('grade') && !t.includes('point')))) bestGradeCol = idx;
        });
      }
    }

    if (bestCreditCol === -1 || bestGradeCol === -1) return null;
    return { gradeCol: bestGradeCol, creditHoursCol: bestCreditCol };
  }

  // Keep legacy references alive (used by injectPredictorInputs which still
  // operates on the first table found for the current semester).
  function findTranscriptTable() {
    const semTables = findAllSemesterTables();
    return semTables.length > 0 ? semTables[0].table : null;
  }
  function detectColumns() { /* no-op: now handled per-table in scrapeCurrentSemester */ }

  // Scrape ALL semester tables found on the current year page.
  // Each table is stored as a separate period entry in allSemestersData so
  // the GPA chart and stats can distinguish Winter vs Spring vs Summer, etc.
  function scrapeCurrentSemester(semTables) {
    currentSemesterData = [];
    if (!semTables || semTables.length === 0) return;

    // Keep a reference to the first table for injectPredictorInputs (legacy)
    transcriptTable = semTables[0].table;

    semTables.forEach(({ table, label, isMakeup }) => {
      // Detect columns independently for each table
      const cols = detectColumnsForTable(table);
      if (!cols) {
        console.log(`🎓 Could not detect columns for table "${label}" — skipping.`);
        return;
      }
      const { gradeCol: gCol, creditHoursCol: chCol } = cols;

      // Unique storage key for this period: yearId + sanitised label
      const periodId = `${currentSemesterId}__${label.replace(/\s+/g, '_')}`;

      const rows = table.querySelectorAll('tr');
      let rowIndex = 0;

      rows.forEach((row, ri) => {
        // Row 0 = semester title, Row 1 = column headers — always skip both
        if (ri <= 1) return;

        // Skip the "Semester GPA" summary row
        if (row.textContent.includes('Semester GPA') || row.textContent.includes('Cumulative GPA')) return;

        const cells = row.querySelectorAll('td');
        if (cells.length <= Math.max(chCol, gCol)) return;

        const creditHoursText = cells[chCol]?.textContent?.trim();
        const gradeText       = cells[gCol]?.textContent?.trim();
        const creditHours     = parseFloat(creditHoursText);
        const grade           = parseFloat(gradeText);
        const courseName      = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || `Course ${rowIndex}`;

        // Sanity-check: reject the GPA-total row (very high credit value) and empty rows
        if (!courseName || (creditHours > 30)) return;

        const isPending = !gradeText ||
          gradeText.toLowerCase() === 'pending' ||
          ['', '-', '--', 'n/a'].includes(gradeText.toLowerCase()) ||
          isNaN(grade);

        if (!isNaN(creditHours) && creditHours > 0) {
          const langInfo = detectLanguageCourse(courseName, creditHours);
          currentSemesterData.push({
            rowIndex:    rowIndex,
            row:         row,
            gradeCell:   cells[gCol],
            courseName,
            creditHours,
            grade:       isPending ? null : grade,
            isPending,
            isGerman:    langInfo.isGerman,
            germanLevel: langInfo.germanLevel,
            isEnglish:   langInfo.isEnglish,
            isMakeup,                // true for Makeup/negative-session tables
            semesterId:  periodId    // per-period key, not just the year
          });
          rowIndex++;
        }
      });

      console.log(`🎓 Scraped ${rowIndex} courses from "${label}" (${isMakeup ? 'makeup' : 'regular'})`);
    });

    // Keep global col vars in sync with first table (for legacy code)
    const firstCols = detectColumnsForTable(semTables[0].table);
    if (firstCols) {
      gradeCol = firstCols.gradeCol;
      creditHoursCol = firstCols.creditHoursCol;
    }

    console.log(`🎓 Total courses scraped this page: ${currentSemesterData.length}`);
  }

  // Persist every semester period found on the current page.
  // Each period gets its own key in allSemestersData so the chart and
  // stats distinguish Winter, Spring, Summer rounds, etc.
  async function saveSemesterData() {
    if (currentSemesterData.length === 0) return;

    // Group scraped courses by their periodId
    const byPeriod = {};
    currentSemesterData.forEach(course => {
      const pid = course.semesterId;
      if (!byPeriod[pid]) byPeriod[pid] = [];
      byPeriod[pid].push(course);
    });

    for (const [periodId, courses] of Object.entries(byPeriod)) {
      // Derive a human-readable label from the periodId
      // Format: "22_2024-2025__Winter_2024"  →  "Winter 2024"
      const parts = periodId.split('__');
      const semesterLabel = parts[1] ? parts[1].replace(/_/g, ' ') : getSemesterDisplayName();

      const coursesToStore = courses.map(c => ({
        courseName:  c.courseName,
        creditHours: c.creditHours,
        grade:       c.grade,
        isPending:   c.isPending,
        isGerman:    c.isGerman,
        germanLevel: c.germanLevel,
        isEnglish:   c.isEnglish,
        isMakeup:    c.isMakeup
      }));

      allSemestersData[periodId] = {
        courses:      coursesToStore,
        semesterName: semesterLabel,
        lastUpdated:  new Date().toISOString()
      };
    }

    try {
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: allSemestersData });
      console.log(`🎓 Saved ${Object.keys(byPeriod).length} period(s) for year "${currentSemesterId}". Total stored: ${Object.keys(allSemestersData).length}`);
    } catch (e) {
      console.log('🎓 Could not save to storage:', e);
    }
  }

  // Get display name for current semester
  function getSemesterDisplayName() {
    if (semesterDropdown) {
      const selectedOption = semesterDropdown.options[semesterDropdown.selectedIndex];
      return selectedOption ? selectedOption.textContent.trim() : currentSemesterId;
    }
    return currentSemesterId;
  }

  // Get all courses from all stored semesters (for cumulative GPA).
  // FIX-1: each call returns fresh plain objects (isSuperseded reset to false)
  // so processing functions never pollute the shared allSemestersData store.
  function getAllStoredCourses() {
    const allCourses = [];
    
    for (const [semesterId, semesterInfo] of Object.entries(allSemestersData)) {
      if (semesterInfo.courses) {
        semesterInfo.courses.forEach(course => {
          allCourses.push({
            ...course,
            semesterId: semesterId,
            semesterName: semesterInfo.semesterName,
            isSuperseded: false   // always start clean; processing functions set this
          });
        });
      }
    }
    
    return allCourses;
  }

  // Clear all stored semester data
  async function clearStoredSemesters() {
    allSemestersData = {};
    try {
      await chrome.storage.local.remove(CONFIG.STORAGE_KEY);
      console.log('🎓 Cleared all stored semesters');
    } catch (e) {
      console.log('🎓 Could not clear storage:', e);
    }
    updateGPACalculations();
  }

  // Detect if a course is German or English
  function detectLanguageCourse(courseName, creditHours) {
    const name = courseName.toLowerCase();
    let isGerman = false;
    let germanLevel = 0;
    let isEnglish = false;

    // German course detection
    // Patterns: "German 1", "German I", "GERM1", "German Language 1", etc.
    const germanPatterns = [
      /german\s*(language)?\s*(1|i|one)\b/i,
      /germ\s*1\b/i,
      /\bgerman\s*[i1]\b/i
    ];
    const germanPatterns2 = [
      /german\s*(language)?\s*(2|ii|two)\b/i,
      /germ\s*2\b/i,
      /\bgerman\s*[ii2]\b/i
    ];
    const germanPatterns3 = [
      /german\s*(language)?\s*(3|iii|three)\b/i,
      /germ\s*3\b/i,
      /\bgerman\s*iii\b/i
    ];
    const germanPatterns4 = [
      /german\s*(language)?\s*(4|iv|four)\b/i,
      /germ\s*4\b/i,
      /\bgerman\s*iv\b/i
    ];

    // Check German levels (check higher levels first)
    if (germanPatterns4.some(p => p.test(name)) || (name.includes('german') && creditHours === 8)) {
      isGerman = true;
      germanLevel = 4;
    } else if (germanPatterns3.some(p => p.test(name)) || (name.includes('german') && creditHours === 6)) {
      isGerman = true;
      germanLevel = 3;
    } else if (germanPatterns2.some(p => p.test(name)) || (name.includes('german') && creditHours === 4 && name.includes('german'))) {
      isGerman = true;
      germanLevel = 2;
    } else if (germanPatterns.some(p => p.test(name)) || (name.includes('german') && creditHours === 2)) {
      isGerman = true;
      germanLevel = 1;
    } else if (name.includes('german') || name.includes('germ')) {
      // Generic German course detection by credit hours
      isGerman = true;
      if (creditHours === 2) germanLevel = 1;
      else if (creditHours === 4) germanLevel = 2;
      else if (creditHours === 6) germanLevel = 3;
      else if (creditHours === 8) germanLevel = 4;
      else germanLevel = 1; // Default
    }

    // English course detection
    // Patterns: "Academic English", "AE", "English", "ENGL", etc.
    // Note: AE is typically 4 credit hours
    const englishPatterns = [
      /\bae\b/i,
      /academic\s*english/i,
      /\benglish\b/i,
      /\bengl\b/i,
      /\beng\s*\d/i
    ];

    if (!isGerman && englishPatterns.some(p => p.test(name))) {
      isEnglish = true;
    }

    return { isGerman, germanLevel, isEnglish };
  }

  // Process German courses - mark lower levels as excluded (across all semesters)
  function processGermanCourses(courses) {
    // Find all German courses
    const germanCourses = courses.filter(c => c.isGerman && !c.isPending && c.grade !== null);
    
    if (germanCourses.length <= 1) return courses;

    // Find the highest level German course completed
    const highestLevel = Math.max(...germanCourses.map(c => c.germanLevel));
    
    // Mark lower level German courses as superseded
    courses.forEach(course => {
      if (course.isGerman && course.germanLevel < highestLevel && !course.isPending) {
        course.isSuperseded = true;
        console.log(`🎓 German ${course.germanLevel} superseded by German ${highestLevel}`);
      }
    });
    
    return courses;
  }

  // Process makeup / retaken courses using GUC policy:
  //
  //  Key rule — a course is considered the SAME course only when BOTH
  //  the course name (case-insensitive) AND the credit hours match.
  //  Example: "Chemistry" (4 cr, lecture) vs "Chemistry" (2 cr, lab)
  //  are two DIFFERENT courses and both count independently.
  //
  //  Deduplication rules once we have confirmed duplicates:
  //  1. If any entry comes from a *Makeup session* (isMakeup=true):
  //       → The makeup grade ALWAYS replaces the original (F/FF).
  //         Supersede all non-makeup entries.
  //  2. If all entries are from regular/summer sessions (no makeup):
  //       → Keep the entry with the best (lowest) numeric grade.
  //         This handles summer retakes where the student improved.
  function processMakeupCourses(courses) {
    // Group graded courses by normalised name + credit hours
    const byKey = {};
    courses.forEach(course => {
      if (course.isPending || course.grade === null || course.isSuperseded) return;
      // Key includes credit hours so same-name-different-credit courses are NOT merged
      const key = `${course.courseName.trim().toLowerCase()}||${course.creditHours}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(course);
    });

    for (const [key, group] of Object.entries(byKey)) {
      if (group.length <= 1) continue;

      const makeupEntries  = group.filter(c =>  c.isMakeup);
      const regularEntries = group.filter(c => !c.isMakeup);

      if (makeupEntries.length > 0) {
        // Rule 1: Makeup session exists → supersede ALL regular/summer entries.
        regularEntries.forEach(c => {
          c.isSuperseded = true;
          console.log(`🎓 Makeup supersedes: "${c.courseName}" (${c.creditHours} cr) original grade ${c.grade}`);
        });
        // If multiple makeup entries (edge case), keep the best one.
        if (makeupEntries.length > 1) {
          const best = Math.min(...makeupEntries.map(c => c.grade));
          let keptOne = false;
          makeupEntries.forEach(c => {
            if (c.grade === best && !keptOne) { keptOne = true; }
            else { c.isSuperseded = true; }
          });
        }
      } else {
        // Rule 2: All regular/summer — keep the best (lowest) grade.
        const best = Math.min(...regularEntries.map(c => c.grade));
        let keptOne = false;
        regularEntries.forEach(c => {
          if (c.grade === best && !keptOne) { keptOne = true; }
          else {
            c.isSuperseded = true;
            console.log(`🎓 Retake supersedes: "${c.courseName}" (${c.creditHours} cr) grade ${c.grade} → kept ${best}`);
          }
        });
      }
    }

    return courses;
  }

  // Inject input fields for pending grades (current semester only)
  function injectPredictorInputs() {
    currentSemesterData.forEach((course) => {
      if (course.isPending && course.gradeCell) {
        // Check if input already exists
        if (course.gradeCell.querySelector('.guc-grade-input')) return;

        const originalContent = course.gradeCell.innerHTML;
        
        // Create input wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'guc-input-wrapper';
        
        // Preserve original content if any
        if (originalContent && originalContent.trim() && originalContent.trim() !== '-') {
          const originalSpan = document.createElement('span');
          originalSpan.className = 'guc-original-grade';
          originalSpan.textContent = originalContent;
          wrapper.appendChild(originalSpan);
        }

        // Create input
        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'guc-grade-input';
        input.placeholder = 'Grade';
        input.min = CONFIG.MIN_GRADE;
        input.max = CONFIG.MAX_GRADE;
        input.step = '0.1';
        input.dataset.rowIndex = course.rowIndex;
        input.dataset.courseName = course.courseName;

        // Restore saved predicted grade
        const savedGrade = predictedGrades[course.courseName];
        if (savedGrade !== undefined) {
          input.value = savedGrade;
        }

        // Add event listener for real-time updates
        input.addEventListener('input', handleGradeInput);
        input.addEventListener('change', handleGradeInput);

        wrapper.appendChild(input);
        course.gradeCell.innerHTML = '';
        course.gradeCell.appendChild(wrapper);
      }
    });
  }

  // Handle grade input changes
  function handleGradeInput(event) {
    const input = event.target;
    const courseName = input.dataset.courseName;
    const value = parseFloat(input.value);

    // Validate input
    if (!isNaN(value)) {
      if (value < CONFIG.MIN_GRADE) {
        input.value = CONFIG.MIN_GRADE;
        predictedGrades[courseName] = CONFIG.MIN_GRADE;
      } else if (value > CONFIG.MAX_GRADE) {
        input.value = CONFIG.MAX_GRADE;
        predictedGrades[courseName] = CONFIG.MAX_GRADE;
      } else {
        predictedGrades[courseName] = value;
      }
    } else {
      delete predictedGrades[courseName];
    }

    // Save to storage
    try {
      chrome.storage.local.set({ predictedGrades: predictedGrades });
    } catch (e) {
      console.log('🎓 Could not save to storage');
    }

    // Update calculations
    updateGPACalculations();
  }

  // Create floating dashboard
  function createDashboard() {
    // Remove existing dashboard if any
    const existingDashboard = document.getElementById('guc-gpa-dashboard');
    if (existingDashboard) existingDashboard.remove();

    const dashboard = document.createElement('div');
    dashboard.id = 'guc-gpa-dashboard';
    dashboard.className = 'guc-dashboard';

    dashboard.innerHTML = `
      <div class="guc-dashboard-header">
        <h3>📊 GPA Calculator</h3>
        <div class="guc-dashboard-controls">
          <button id="guc-dark-toggle" class="guc-btn guc-btn-icon" title="Toggle Dark Mode">🌙</button>
          <button id="guc-minimize" class="guc-btn guc-btn-icon" title="Minimize">➖</button>
        </div>
      </div>

      <div class="guc-dashboard-content">
        <div class="guc-section" id="guc-section-overview">
          <div class="guc-section-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:15px;font-weight:600;">📈 GPA Overview & Stats</span>
            <button id="toggle-overview" class="guc-btn-small" style="font-size:16px;">▲</button>
          </div>
          <div class="guc-section-body" id="guc-overview-body">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
              <button id="guc-add-pending-btn" class="guc-btn-small" style="font-size:14px;">➕ Add Pending Course</button>
            </div>
            <form id="guc-add-pending-form" class="guc-pending-form" style="display:none;">
              <div class="guc-pending-form-fields">
                <input id="guc-pending-name" type="text" placeholder="Course Name" required />
                <input id="guc-pending-credits" type="number" min="1" step="1" placeholder="Credits" required />
                <button type="submit" class="guc-btn guc-btn-primary">Add</button>
                <button type="button" id="guc-cancel-pending" class="guc-btn guc-btn-small">Cancel</button>
              </div>
            </form>
            <div id="guc-pending-list-section" class="guc-pending-list-section" style="display:none;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;">
                <span style="font-size:13px;font-weight:600;">Pending Courses</span>
                <button id="guc-delete-all-pending" class="guc-btn guc-btn-small" style="color:#dc3545;font-size:13px;">🗑️ Delete All</button>
              </div>
              <ul id="guc-pending-list" class="guc-pending-list"></ul>
            </div>
            <div class="guc-gpa-section">
              <div class="guc-gpa-box">
                <span class="guc-gpa-label">Current GPA</span>
                <span id="guc-current-gpa" class="guc-gpa-value">-</span>
                <span id="guc-current-credits" class="guc-credits-info">0 credits</span>
              </div>
              <div class="guc-gpa-box guc-predicted">
                <span class="guc-gpa-label">Predicted GPA</span>
                <span id="guc-predicted-gpa" class="guc-gpa-value">-</span>
                <span id="guc-predicted-credits" class="guc-credits-info">0 credits</span>
              </div>
            </div>
            <div class="guc-lang-section">
              <h4>🌍 Language GPA Variations</h4>
              <div class="guc-lang-grid">
                <div class="guc-lang-box">
                  <span class="guc-lang-label">With English</span>
                  <span id="guc-gpa-with-english" class="guc-lang-value">-</span>
                </div>
                <div class="guc-lang-box">
                  <span class="guc-lang-label">Without German</span>
                  <span id="guc-gpa-no-german" class="guc-lang-value">-</span>
                </div>
              </div>
            </div>
            <div id="guc-lang-info" class="guc-lang-info"></div>
            <div class="guc-stats-section">
              <h4>📊 Statistics</h4>
              <div class="guc-stats-grid">
                <div class="guc-stat-item">
                  <span class="guc-stat-label">Semesters</span>
                  <span id="guc-semester-count" class="guc-stat-value">0</span>
                </div>
                <div class="guc-stat-item">
                  <span class="guc-stat-label">Completed</span>
                  <span id="guc-completed-count" class="guc-stat-value">0</span>
                </div>
                <div class="guc-stat-item">
                  <span class="guc-stat-label">Pending</span>
                  <span id="guc-pending-count" class="guc-stat-value">0</span>
                </div>
                <div class="guc-stat-item">
                  <span class="guc-stat-label">Total Cr.</span>
                  <span id="guc-total-credits" class="guc-stat-value">0</span>
                </div>
              </div>
            </div>
            <div class="guc-semesters-section">
              <h4>📚 Stored Semesters <button id="guc-clear-semesters" class="guc-btn-small" title="Clear all stored semesters">🗑️</button></h4>
              <div id="guc-semesters-list" class="guc-semesters-list">
                <span class="guc-no-semesters">No semesters stored yet. Visit each semester page to collect data.</span>
              </div>
            </div>
          </div>
        </div>

        <div class="guc-section" id="guc-section-goal">
          <div class="guc-section-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:15px;font-weight:600;">🎯 Set Target GPA</span>
            <button id="toggle-goal" class="guc-btn-small" style="font-size:16px;">▼</button>
          </div>
          <div class="guc-section-body" id="guc-goal-body" style="display:none;">
            <div class="guc-goal-section">
              <div class="guc-goal-input-group">
                <label for="guc-target-gpa">Target GPA:</label>
                <input type="number" id="guc-target-gpa" min="0.7" max="5.0" step="0.01" placeholder="e.g., 1.7">
                <button id="guc-calculate-goal" class="guc-btn guc-btn-primary">Calculate</button>
              </div>
              <div id="guc-goal-result" class="guc-goal-result"></div>
              <button id="guc-show-other-suggestions" class="guc-btn guc-btn-primary" style="margin-top:8px;display:none;">Show Other Suggestions</button>
            </div>
            <div class="info-box" style="margin:18px 0 0 0;">
              <h3 style="font-size:15px;margin-bottom:4px;">ℹ️ GUC Grading & GPA Calculation</h3>
              <div style="font-size:13px;line-height:1.6;">
                <b>GPA is calculated using the lowest value for each letter grade:</b><br>
                <table style="margin:8px 0 0 0;font-size:13px;width:100%;border-collapse:collapse;">
                  <tr><td>A+</td><td>= 0.7</td><td>A</td><td>= 1.0</td><td>A-</td><td>= 1.3</td></tr>
                  <tr><td>B+</td><td>= 1.7</td><td>B</td><td>= 2.0</td><td>B-</td><td>= 2.3</td></tr>
                  <tr><td>C+</td><td>= 2.7</td><td>C</td><td>= 3.0</td><td>C-</td><td>= 3.3</td></tr>
                  <tr><td>D+</td><td>= 3.7</td><td>D</td><td>= 4.0</td><td>F</td><td>= 5.0</td></tr>
                </table>
                <div style="margin-top:6px;color:#666;">For example, if you get an A+ (0.7–1.0), your GPA is calculated using <b>0.7</b>.</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Feature 2: GPA History Chart -->
        <div class="guc-section" id="guc-section-chart">
          <div class="guc-section-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:15px;font-weight:600;">📈 GPA History</span>
            <button id="toggle-chart" class="guc-btn-small" style="font-size:16px;">▼</button>
          </div>
          <div class="guc-section-body" id="guc-chart-body" style="display:none;">
            <div class="guc-chart-section">
              <div id="guc-chart-container"><span class="guc-chart-empty">Sync semesters to see your GPA history chart.</span></div>
            </div>
          </div>
        </div>

        <!-- Feature 3: What-If Simulator -->
        <div class="guc-section" id="guc-section-whatif">
          <div class="guc-section-header" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
            <span style="font-size:15px;font-weight:600;">🧮 What-If Simulator</span>
            <button id="toggle-whatif" class="guc-btn-small" style="font-size:16px;">▼</button>
          </div>
          <div class="guc-section-body" id="guc-whatif-body" style="display:none;">
            <div class="guc-whatif-section">
              <div class="guc-whatif-result" id="guc-whatif-result" style="display:none;">
                <span class="guc-whatif-gpa" id="guc-whatif-gpa">-</span>
                <span class="guc-whatif-delta" id="guc-whatif-delta"></span>
              </div>
              <ul class="guc-whatif-list" id="guc-whatif-list"></ul>
              <button class="guc-whatif-reset" id="guc-whatif-reset">🔄 Reset Simulation</button>
            </div>
          </div>
        </div>

      </div>
    `;


    document.body.appendChild(dashboard);

    // Add Pending Course logic
    const addPendingBtn = document.getElementById('guc-add-pending-btn');
    const addPendingForm = document.getElementById('guc-add-pending-form');
    const pendingNameInput = document.getElementById('guc-pending-name');
    const pendingCreditsInput = document.getElementById('guc-pending-credits');
    const cancelPendingBtn = document.getElementById('guc-cancel-pending');
    if (addPendingBtn && addPendingForm && pendingNameInput && pendingCreditsInput && cancelPendingBtn) {
      addPendingBtn.addEventListener('click', () => {
        addPendingForm.style.display = 'block';
        addPendingBtn.style.display = 'none';
        pendingNameInput.value = '';
        pendingCreditsInput.value = '';
        renderPendingList();
      });
      cancelPendingBtn.addEventListener('click', () => {
        addPendingForm.style.display = 'none';
        addPendingBtn.style.display = '';
        renderPendingList();
      });
      addPendingForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const name = pendingNameInput.value.trim();
        const credits = parseInt(pendingCreditsInput.value, 10);
        if (!name || isNaN(credits) || credits <= 0) return;
        userPendingCourses.push({
          id: Date.now() + Math.random(),
          courseName: name,
          creditHours: credits
        });
        await chrome.storage.local.set({ [USER_PENDING_KEY]: userPendingCourses });
        addPendingForm.style.display = 'none';
        addPendingBtn.style.display = '';
        updateGPACalculations();
        renderPendingList();
      });
      // Delete all pending
      const deleteAllBtn = document.getElementById('guc-delete-all-pending');
      if (deleteAllBtn) {
        deleteAllBtn.addEventListener('click', async () => {
          userPendingCourses = [];
          await chrome.storage.local.set({ [USER_PENDING_KEY]: userPendingCourses });
          updateGPACalculations();
          renderPendingList();
        });
      }
    }

    // Helper to generate the custom dropdown HTML
    function getDropdownHTML(courseId, selectedGrade) {
      const grades = [
        { val: '', text: 'Pending', tier: 'guc-grade-tier-neutral', points: '' },
        { divider: 'A Range' },
        { val: '0.7', text: 'A+', tier: 'guc-grade-tier-a', points: '0.7' },
        { val: '1.0', text: 'A', tier: 'guc-grade-tier-a', points: '1.0' },
        { val: '1.3', text: 'A-', tier: 'guc-grade-tier-a', points: '1.3' },
        { divider: 'B Range' },
        { val: '1.7', text: 'B+', tier: 'guc-grade-tier-b', points: '1.7' },
        { val: '2.0', text: 'B', tier: 'guc-grade-tier-b', points: '2.0' },
        { val: '2.3', text: 'B-', tier: 'guc-grade-tier-b', points: '2.3' },
        { divider: 'C Range' },
        { val: '2.7', text: 'C+', tier: 'guc-grade-tier-c', points: '2.7' },
        { val: '3.0', text: 'C', tier: 'guc-grade-tier-c', points: '3.0' },
        { val: '3.3', text: 'C-', tier: 'guc-grade-tier-c', points: '3.3' },
        { divider: 'D/F Range' },
        { val: '3.7', text: 'D+', tier: 'guc-grade-tier-df', points: '3.7' },
        { val: '4.0', text: 'D', tier: 'guc-grade-tier-df', points: '4.0' },
        { val: '5.0', text: 'F', tier: 'guc-grade-tier-df', points: '5.0' }
      ];

      let selectedText = 'Pending';
      let selectedTier = 'guc-grade-tier-neutral';
      
      if (selectedGrade) {
        const found = grades.find(g => g.val === selectedGrade);
        if (found) {
          selectedText = found.text;
          selectedTier = found.tier;
        }
      }

      let menuHTML = '';
      grades.forEach(g => {
        if (g.divider) {
          menuHTML += `<div class="guc-dropdown-divider">${g.divider}</div>`;
        } else {
          menuHTML += `
            <div class="guc-dropdown-item ${g.tier}" data-value="${g.val}">
              <span>${g.text}</span>
              ${g.points ? `<span class="guc-grade-points">${g.points}</span>` : ''}
            </div>
          `;
        }
      });

      return `
        <div class="guc-dropdown-container" data-id="${courseId}">
          <div class="guc-dropdown-selected ${selectedTier}">
            <span class="guc-selected-text">${selectedText}</span>
          </div>
          <div class="guc-dropdown-menu">
            ${menuHTML}
          </div>
        </div>
      `;
    }

    // Render pending courses list
    function renderPendingList() {
      const pendingListSection = document.getElementById('guc-pending-list-section');
      const pendingList = document.getElementById('guc-pending-list');
      if (!pendingListSection || !pendingList) return;
      const pending = userPendingCourses;
      if (pending.length === 0) {
        pendingListSection.style.display = 'none';
        pendingList.innerHTML = '';
        return;
      }
      pendingListSection.style.display = 'block';
      pendingList.innerHTML = pending.map((c, idx) => `
        <li class="guc-pending-item">
          <span class="guc-pending-name">${c.courseName}</span>
          <span class="guc-pending-credits">${c.creditHours} cr</span>
          ${getDropdownHTML(c.id, c.predictedGrade)}
          <button class="guc-btn guc-btn-small guc-delete-pending" data-id="${c.id}" title="Delete">🗑️</button>
        </li>
      `).join('');
      // Add delete listeners
      pendingList.querySelectorAll('.guc-delete-pending').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const id = btn.getAttribute('data-id');
          const i = userPendingCourses.findIndex(c => String(c.id) === String(id));
          if (i !== -1) {
            userPendingCourses.splice(i, 1);
            await chrome.storage.local.set({ [USER_PENDING_KEY]: userPendingCourses });
            updateGPACalculations();
            renderPendingList();
          }
        });
      });
      // Add custom dropdown listeners
      pendingList.querySelectorAll('.guc-dropdown-container').forEach(container => {
        const selectedEl = container.querySelector('.guc-dropdown-selected');
        const menuEl = container.querySelector('.guc-dropdown-menu');
        const id = container.getAttribute('data-id');

        selectedEl.addEventListener('click', (e) => {
          e.stopPropagation();
          document.querySelectorAll('.guc-dropdown-menu.guc-show').forEach(m => {
            if (m !== menuEl) m.classList.remove('guc-show');
          });
          menuEl.classList.toggle('guc-show');
        });

        container.querySelectorAll('.guc-dropdown-item').forEach(item => {
          item.addEventListener('click', async (e) => {
            e.stopPropagation();
            const value = item.getAttribute('data-value');
            const course = userPendingCourses.find(c => String(c.id) === String(id));
            if (course) {
              // Store null (not "") when Pending is selected, consistent with BUG-4 fix
              course.predictedGrade = value || null;
              await chrome.storage.local.set({ [USER_PENDING_KEY]: userPendingCourses });
              updateGPACalculations();
              renderPendingList();
            }
          });
        });
      });
    }

    // Close dropdowns on outside click
    document.addEventListener('click', () => {
      document.querySelectorAll('.guc-dropdown-menu.guc-show').forEach(m => m.classList.remove('guc-show'));
    });
    // Render on dashboard open
    renderPendingList();

    // Add event listeners
    document.getElementById('guc-dark-toggle').addEventListener('click', toggleDarkMode);
    document.getElementById('guc-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('guc-calculate-goal').addEventListener('click', (e) => { e.preventDefault(); calculateGoalWithSuggestions(); });
    document.getElementById('guc-target-gpa').addEventListener('keypress', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); calculateGoalWithSuggestions(); }
    });
    document.getElementById('guc-show-other-suggestions').addEventListener('click', showOtherGradeSuggestion);
    document.getElementById('guc-clear-semesters').addEventListener('click', clearStoredSemesters);

    // Collapsible section toggles
    const overviewBody = document.getElementById('guc-overview-body');
    const goalBody = document.getElementById('guc-goal-body');
    const chartBody = document.getElementById('guc-chart-body');
    const whatifBody = document.getElementById('guc-whatif-body');
    const toggleOverview = document.getElementById('toggle-overview');
    const toggleGoal = document.getElementById('toggle-goal');
    const toggleChart = document.getElementById('toggle-chart');
    const toggleWhatif = document.getElementById('toggle-whatif');

    function makeToggle(body, btn, defaultOpen) {
      if (defaultOpen) { body.style.display = ''; btn.textContent = '▲'; }
      else             { body.style.display = 'none'; btn.textContent = '▼'; }
      btn.addEventListener('click', () => {
        const open = body.style.display !== 'none';
        body.style.display = open ? 'none' : '';
        btn.textContent = open ? '▼' : '▲';
        if (!open && btn === toggleChart) renderGPAChart();
        if (!open && btn === toggleWhatif) renderWhatIfSection();
      });
    }

    makeToggle(overviewBody, toggleOverview, true);
    makeToggle(goalBody, toggleGoal, false);
    makeToggle(chartBody, toggleChart, false);
    makeToggle(whatifBody, toggleWhatif, false);

    // What-If reset button
    document.getElementById('guc-whatif-reset').addEventListener('click', () => {
      whatIfOverrides = {};
      renderWhatIfSection();
    });

    // Make dashboard draggable
    makeDraggable(dashboard);
  }

  // --- Target GPA with Grade Combination Suggestions ---
  let gradeCombinations = [];
  let currentCombinationIndex = 0;

  function calculateGoalWithSuggestions() {
    const targetGpaInput = document.getElementById('guc-target-gpa');
    const targetResult = document.getElementById('guc-goal-result');
    const showOtherBtn = document.getElementById('guc-show-other-suggestions');
    const target = parseFloat(targetGpaInput.value);
    if (isNaN(target) || target < CONFIG.MIN_GRADE || target > CONFIG.MAX_GRADE) {
      targetResult.innerHTML = '<span style="color:#d48806">Enter a valid target GPA (' + CONFIG.MIN_GRADE + ' - ' + CONFIG.MAX_GRADE + ')</span>';
      showOtherBtn.style.display = 'none';
      return;
    }

    // Get completed and pending courses from all semesters
    let completedCourses = getAllStoredCourses().filter(c => !c.isPending && c.grade !== null);
    let pendingCourses = userPendingCourses.slice();

    const completedCredits = completedCourses.reduce((sum, c) => sum + Number(c.creditHours), 0);
    const completedWeightedSum = completedCourses.reduce((sum, c) => sum + (Number(c.grade) * Number(c.creditHours)), 0);
    const pendingCredits = pendingCourses.reduce((sum, c) => sum + Number(c.creditHours), 0);

    if (pendingCredits === 0) {
      targetResult.innerHTML = '<span style="color:#d48806">No pending courses entered.</span>';
      showOtherBtn.style.display = 'none';
      return;
    }

    const totalCredits = completedCredits + pendingCredits;
    const targetWeightedSum = target * totalCredits;
    const requiredPendingWeightedSum = targetWeightedSum - completedWeightedSum;
    const requiredAvgGrade = requiredPendingWeightedSum / pendingCredits;

    if (requiredAvgGrade < CONFIG.MIN_GRADE) {
      targetResult.innerHTML = `❌ Not possible: The best achievable grade is ${CONFIG.MIN_GRADE}, but you would need an average of <b>${requiredAvgGrade.toFixed(2)}</b>.<br>`;
      showOtherBtn.style.display = 'none';
      return;
    }
    if (requiredAvgGrade > CONFIG.MAX_GRADE) {
      targetResult.innerHTML = `❌ Achieving a GPA of <b>${target}</b> is not possible.<br>Would require: <b>${requiredAvgGrade.toFixed(2)}</b> (above failing)`;
      showOtherBtn.style.display = 'none';
      return;
    }

    // Generate all possible grade combinations for pending courses
    gradeCombinations = generateGradeCombinations(pendingCourses, requiredPendingWeightedSum, target, completedCourses);
    currentCombinationIndex = 0;

    if (gradeCombinations.length === 0) {
      targetResult.innerHTML = `❌ No valid grade combinations found to achieve a GPA of <b>${target}</b> with your current courses.`;
      showOtherBtn.style.display = 'none';
      return;
    }

    showCurrentGradeCombination();
    if (gradeCombinations.length > 1) {
      showOtherBtn.style.display = '';
    } else {
      showOtherBtn.style.display = 'none';
    }
  }

  function generateGradeCombinations(pendingCourses, requiredSum, userTargetGpa, completedCourses) {
    // D (4.0) was missing from the original list — now included
    const gradeSteps = [0.7, 1.0, 1.3, 1.7, 2.0, 2.3, 2.7, 3.0, 3.3, 3.7, 4.0, 5.0];
    const n = pendingCourses.length;
    const credits = pendingCourses.map(c => Number(c.creditHours));
    const combinations = [];
    // Try all combinations for up to 4 courses
    function tryCombinations(idx, current) {
      if (idx === n) {
        // Calculate GPA for this combination
        let weightedSum = 0, totalCredits = 0;
        for (let i = 0; i < n; ++i) {
          weightedSum += current[i] * credits[i];
          totalCredits += credits[i];
        }
        if (completedCourses) {
          for (const c of completedCourses) {
            weightedSum += c.grade * c.creditHours;
            totalCredits += c.creditHours;
          }
        }
        const gpa = weightedSum / totalCredits;
        if (gpa >= userTargetGpa - 0.0001) {
          combinations.push({ grades: [...current], gpa: gpa, sum: current.reduce((a, b) => a + b, 0) });
        }
        return;
      }
      for (let g of gradeSteps) {
        current.push(g);
        tryCombinations(idx + 1, current);
        current.pop();
      }
    }
    if (n >= 1 && n <= 4) {
      tryCombinations(0, []);
      combinations.sort((a, b) => (a.gpa - b.gpa) || (a.sum - b.sum));
      if (combinations.length > 0) {
        const minGPA = combinations[0].gpa;
        return combinations.filter(c => Math.abs(c.gpa - minGPA) < 0.01).map(c => c.grades);
      }
      return [];
    } else {
      // For more than 4 courses, just suggest equal grades (minimum that meets/exceeds target)
      let totalCredits = credits.reduce((a, b) => a + b, 0);
      let completedWeightedSum = 0, completedCredits = 0;
      if (completedCourses) {
        for (const c of completedCourses) {
          completedWeightedSum += c.grade * c.creditHours;
          completedCredits += c.creditHours;
        }
      }
      let needed = (userTargetGpa * (totalCredits + completedCredits) - completedWeightedSum) / totalCredits;
      let valid = gradeSteps.filter(g => g >= needed);
      if (valid.length > 0 && valid[0] <= 5.0) {
        return [Array(n).fill(valid[0])];
      }
      return [];
    }
  }

  function showCurrentGradeCombination() {
    const targetResult = document.getElementById('guc-goal-result');
    if (!gradeCombinations.length) return;
    const comb = gradeCombinations[currentCombinationIndex];
    let html = `<b>Possible grade combination:</b><br><ul style="margin:8px 0 0 0;">`;
    let pendingCourses = userPendingCourses.slice();
    for (let i = 0; i < comb.length; ++i) {
      const num = comb[i];
      const letter = numericToLetterGrade(num);
      const name = pendingCourses[i]?.courseName || `Course ${i+1}`;
      html += `<li>${name}: <b>${num}</b> (${letter})</li>`;
    }
    html += '</ul>';
    html += `<div style="margin-top:6px;font-size:12px;color:#888;">Suggestion ${currentCombinationIndex + 1} of ${gradeCombinations.length}</div>`;
    targetResult.innerHTML = html;
  }

  function showOtherGradeSuggestion() {
    if (!gradeCombinations.length) return;
    currentCombinationIndex = (currentCombinationIndex + 1) % gradeCombinations.length;
    showCurrentGradeCombination();
  }

  // FIX-6: use === for every grade step (consistent with A/B range).
  // The GUC scale only has the 12 discrete values below; any other value returns 'F'.
  function numericToLetterGrade(grade) {
    if (grade === 0.7) return 'A+';
    if (grade === 1.0) return 'A';
    if (grade === 1.3) return 'A-';
    if (grade === 1.7) return 'B+';
    if (grade === 2.0) return 'B';
    if (grade === 2.3) return 'B-';
    if (grade === 2.7) return 'C+';
    if (grade === 3.0) return 'C';
    if (grade === 3.3) return 'C-';
    if (grade === 3.7) return 'D+';
    if (grade === 4.0) return 'D';
    return 'F';
  }

  // Update GPA calculations using ALL stored semesters
  function updateGPACalculations() {
    // Get all courses from all stored semesters
    let allCourses = getAllStoredCourses();
    
    // Process German courses across all semesters
    allCourses = processGermanCourses(allCourses);
    // Process makeup / retaken courses — only count the best grade
    allCourses = processMakeupCourses(allCourses);

    // Initialize all counters
    let completedCredits = 0;
    let completedWeightedSum = 0;
    let predictedCredits = 0;
    let predictedWeightedSum = 0;
    let completedCount = 0;
    let pendingCount = 0;

    // Language-specific counters
    let englishCompletedCredits = 0, englishCompletedWeightedSum = 0;
    let germanCompletedCredits = 0, germanCompletedWeightedSum = 0;
    
    // Track language courses for info display
    let germanCourses = [];
    let englishCourses = [];

    allCourses.forEach((course) => {
      if (course.creditHours <= 0) return;
      // Skip superseded German courses (lower levels)
      if (course.isSuperseded) return;

      if (!course.isPending && course.grade !== null) {
        if (course.isEnglish) {
          englishCompletedCredits += course.creditHours;
          englishCompletedWeightedSum += course.grade * course.creditHours;
          englishCourses.push({ name: course.courseName, grade: course.grade, credits: course.creditHours });
        } else {
          // Main completed course (NO ENGLISH)
          completedCredits += course.creditHours;
          completedWeightedSum += course.grade * course.creditHours;
          completedCount++;

          // Also add to predicted totals
          predictedCredits += course.creditHours;
          predictedWeightedSum += course.grade * course.creditHours;

          if (course.isGerman) {
            germanCompletedCredits += course.creditHours;
            germanCompletedWeightedSum += course.grade * course.creditHours;
            germanCourses.push({ name: course.courseName, grade: course.grade, credits: course.creditHours, level: course.germanLevel });
          }
        }
      } else if (course.isPending) {
        pendingCount++;
        // BUG-3 FIX: use parseFloat + grade > 0 guard so empty string never injects grade 0
        const savedGrade = parseFloat(predictedGrades[course.courseName]);
        if (!isNaN(savedGrade) && savedGrade > 0) {
          if (!course.isEnglish) {
            predictedCredits += course.creditHours;
            predictedWeightedSum += savedGrade * course.creditHours;
          }
        }
      }
    });

    // Add predicted grades from userPendingCourses (assuming they are regular courses)
    userPendingCourses.forEach((course) => {
      if (course.predictedGrade) {
        predictedCredits += course.creditHours;
        predictedWeightedSum += Number(course.predictedGrade) * course.creditHours;
      }
    });

    // Calculate GPAs
    const currentGPA = completedCredits > 0 ? 
      (completedWeightedSum / completedCredits).toFixed(2) : '-';
    const predictedGPA = predictedCredits > 0 ? 
      (predictedWeightedSum / predictedCredits).toFixed(2) : '-';
    
    // Calculate language GPAs
    const withEnglishCredits = completedCredits + englishCompletedCredits;
    const withEnglishGPA = withEnglishCredits > 0 ? 
      ((completedWeightedSum + englishCompletedWeightedSum) / withEnglishCredits).toFixed(2) : '-';
      
    const noGermanCredits = completedCredits - germanCompletedCredits;
    const noGermanGPA = noGermanCredits > 0 ? 
      ((completedWeightedSum - germanCompletedWeightedSum) / noGermanCredits).toFixed(2) : '-';

    // Update dashboard - main GPA
    const currentGpaEl = document.getElementById('guc-current-gpa');
    const predictedGpaEl = document.getElementById('guc-predicted-gpa');
    
    if (currentGpaEl) {
      currentGpaEl.textContent = currentGPA;
      document.getElementById('guc-current-credits').textContent = `${completedCredits} credits`;
    }
    if (predictedGpaEl) {
      predictedGpaEl.textContent = predictedGPA;
      document.getElementById('guc-predicted-credits').textContent = `${predictedCredits} credits`;
    }
    
    // Update language-excluded GPAs
    const noGermanEl = document.getElementById('guc-gpa-no-german');
    const withEnglishEl = document.getElementById('guc-gpa-with-english');
    
    if (noGermanEl) noGermanEl.textContent = noGermanGPA;
    if (withEnglishEl) withEnglishEl.textContent = withEnglishGPA;

    // Update language info
    const langInfoEl = document.getElementById('guc-lang-info');
    if (langInfoEl) {
      let infoHtml = '';
      if (germanCourses.length > 0) {
        const gc = germanCourses[germanCourses.length - 1]; // Highest level
        infoHtml += `<div>🇩🇪 German ${gc.level}: ${gc.grade} (${gc.credits} cr)</div>`;
      }
      if (englishCourses.length > 0) {
        infoHtml += `<div>🇬🇧 English: ${englishCourses.map(e => e.grade).join(', ')} (${englishCourses.reduce((s,e) => s + e.credits, 0)} cr)</div>`;
      }
      langInfoEl.innerHTML = infoHtml;
    }
    
    const completedCountEl = document.getElementById('guc-completed-count');
    const pendingCountEl = document.getElementById('guc-pending-count');
    const totalCreditsEl = document.getElementById('guc-total-credits');
    const semesterCountEl = document.getElementById('guc-semester-count');
    
    const numSemesters = Object.keys(allSemestersData).length;
    if (semesterCountEl) semesterCountEl.textContent = numSemesters;
    if (completedCountEl) completedCountEl.textContent = completedCount;
    // FIX-4: pending count includes user-added courses (those not yet in the transcript)
    const userPendingNoGrade = userPendingCourses.filter(c => !c.predictedGrade).length;
    if (pendingCountEl) pendingCountEl.textContent = pendingCount + userPendingNoGrade;
    if (totalCreditsEl) {
      const transcriptPendingCredits = allCourses.filter(c => c.isPending && !c.isSuperseded).reduce((sum, c) => sum + c.creditHours, 0);
      const userPendingCredits = userPendingCourses.reduce((sum, c) => sum + Number(c.creditHours), 0);
      totalCreditsEl.textContent = completedCredits + transcriptPendingCredits + userPendingCredits;
    }

    // Update stored semesters list
    updateSemestersList();

    colorCodeGPA('guc-current-gpa', parseFloat(currentGPA));
    colorCodeGPA('guc-predicted-gpa', parseFloat(predictedGPA));
    colorCodeGPA('guc-gpa-no-german', parseFloat(noGermanGPA));
    colorCodeGPA('guc-gpa-with-english', parseFloat(withEnglishGPA));

    // Refresh chart if it is open (Feature 2)
    const chartBody = document.getElementById('guc-chart-body');
    if (chartBody && chartBody.style.display !== 'none') renderGPAChart();
    // Refresh what-if if open (Feature 3)
    const whatifBody = document.getElementById('guc-whatif-body');
    if (whatifBody && whatifBody.style.display !== 'none') renderWhatIfSection();
  }

  // Update the semesters list — grouped by academic year, collapsible.
  // Period IDs have the form  "22_2024-2025__Winter_2024".
  // We strip the "__..." suffix to get the year group key.
  function updateSemestersList() {
    const listEl = document.getElementById('guc-semesters-list');
    if (!listEl) return;

    const semesters = Object.entries(allSemestersData);
    if (semesters.length === 0) {
      listEl.innerHTML = '<span class="guc-no-semesters">No semesters stored yet. Visit each year\'s transcript page to collect data.</span>';
      return;
    }

    // Group periods by academic year (the part before "__")
    const yearGroups = {};  // yearKey → { label, periods[] }
    semesters.forEach(([id, info]) => {
      const parts   = id.split('__');
      const yearKey = parts[0];  // e.g. "22_2024-2025"
      // Human-readable year label: extract the "2024-2025" portion
      const yearLabel = yearKey.replace(/^\d+_/, '') || yearKey;
      if (!yearGroups[yearKey]) yearGroups[yearKey] = { label: yearLabel, periods: [] };
      yearGroups[yearKey].periods.push({ id, info });
    });

    // Build HTML: one accordion per academic year
    const isCurrentYear = (yearKey) => currentSemesterId && currentSemesterId.startsWith(yearKey);

    let html = '';
    Object.entries(yearGroups).forEach(([yearKey, { label, periods }]) => {
      const current = isCurrentYear(yearKey);
      const totalCourses    = periods.reduce((s, { info }) => s + (info.courses ? info.courses.length : 0), 0);
      const completedCourses = periods.reduce((s, { info }) => s + (info.courses ? info.courses.filter(c => !c.isPending && c.grade !== null).length : 0), 0);

      html += `
        <div class="guc-year-group ${current ? 'guc-year-current' : ''}">
          <div class="guc-year-header" onclick="this.parentElement.classList.toggle('guc-year-open')">
            <span class="guc-year-label">📅 ${label}</span>
            <span class="guc-year-meta">${completedCourses}/${totalCourses} courses</span>
            <span class="guc-year-chevron">▼</span>
            ${current ? '<span class="guc-current-badge">Current</span>' : ''}
          </div>
          <div class="guc-year-periods">
      `;

      periods.forEach(({ id, info }) => {
        const cCount   = info.courses ? info.courses.length : 0;
        const doneCount = info.courses ? info.courses.filter(c => !c.isPending && c.grade !== null).length : 0;
        const name     = info.semesterName || id.split('__')[1]?.replace(/_/g, ' ') || id;
        // Tag makeup / summer periods
        const isMakeupPeriod = /makeup/i.test(name);
        const isSummerPeriod = /summer/i.test(name);
        const tag = isMakeupPeriod ? '<span class="guc-period-tag makeup">Makeup</span>'
                  : isSummerPeriod ? '<span class="guc-period-tag summer">Summer</span>'
                  : '';
        html += `
          <div class="guc-period-item">
            <span class="guc-period-name">${name}${tag}</span>
            <span class="guc-period-info">${doneCount}/${cCount}</span>
          </div>`;
      });

      html += `</div></div>`;
    });

    listEl.innerHTML = html;

    // Auto-open the current year
    listEl.querySelectorAll('.guc-year-current').forEach(el => el.classList.add('guc-year-open'));
  }

  // ============================================================
  // FEATURE 2 — GPA History Chart (Canvas API, no external libs)
  // ============================================================
  function renderGPAChart() {
    const container = document.getElementById('guc-chart-container');
    if (!container) return;

    // Build chronological data points: per-semester cumulative GPA
    const semesters = Object.entries(allSemestersData);
    if (semesters.length < 2) {
      container.innerHTML = '<span class="guc-chart-empty">Need at least 2 synced semesters to show the chart.</span>';
      return;
    }

    // FIX-2: Apply deduplication (German levels + makeups) before plotting.
    // Build a Set of valid "semesterId||courseName" keys from the globally
    // processed list, then filter each semester's raw courses against it.
    let allProcessedForChart = getAllStoredCourses();
    allProcessedForChart = processGermanCourses(allProcessedForChart);
    allProcessedForChart = processMakeupCourses(allProcessedForChart);
    const validChartKeys = new Set(
      allProcessedForChart
        .filter(c => !c.isSuperseded && !c.isPending && c.grade !== null && c.creditHours > 0 && !c.isEnglish)
        .map(c => `${c.semesterId}||${c.courseName.trim().toLowerCase()}`)
    );

    // Compute cumulative GPA up to each semester (sorted by storage order / name)
    const dataPoints = [];
    let runCredits = 0, runWeightedSum = 0;

    semesters.forEach(([id, info]) => {
      const semName = info.semesterName || id.split('_').slice(1).join(' ') || id;
      const courses = (info.courses || []).filter(c =>
        validChartKeys.has(`${id}||${(c.courseName || '').trim().toLowerCase()}`)
      );
      courses.forEach(c => {
        runCredits += Number(c.creditHours);
        runWeightedSum += Number(c.grade) * Number(c.creditHours);
      });
      if (runCredits > 0) {
        dataPoints.push({ label: semName, gpa: runWeightedSum / runCredits });
      }
    });

    if (dataPoints.length < 2) {
      container.innerHTML = '<span class="guc-chart-empty">Not enough graded data to plot. Sync more semesters.</span>';
      return;
    }

    // Canvas setup
    const W = 290, H = 140;
    const PAD = { top: 14, right: 14, bottom: 28, left: 36 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    container.innerHTML = `<canvas id="guc-chart-canvas" class="guc-chart-canvas" width="${W}" height="${H}" style="width:100%;"></canvas>`;
    const canvas = document.getElementById('guc-chart-canvas');
    const ctx = canvas.getContext('2d');

    // Y: GPA 0.7 (best, top) to 5.0 (fail, bottom)
    const Y_MIN = 0.7, Y_MAX = 5.0;
    const gpaToY = g => PAD.top + ((g - Y_MIN) / (Y_MAX - Y_MIN)) * plotH;
    const xStep = plotW / (dataPoints.length - 1);
    const pts = dataPoints.map((d, i) => ({ x: PAD.left + i * xStep, y: gpaToY(d.gpa), gpa: d.gpa, label: d.label }));

    // Grid lines
    ctx.strokeStyle = 'rgba(0,74,153,0.08)';
    ctx.lineWidth = 1;
    [1.0, 2.0, 3.0, 4.0].forEach(g => {
      const y = gpaToY(g);
      ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + plotW, y); ctx.stroke();
    });

    // Y axis labels
    ctx.fillStyle = '#aaa';
    ctx.font = '9px Segoe UI,sans-serif';
    ctx.textAlign = 'right';
    [1.0, 2.0, 3.0, 4.0].forEach(g => { ctx.fillText(g.toFixed(1), PAD.left - 4, gpaToY(g) + 3); });

    // Gradient fill under line
    const grad = ctx.createLinearGradient(0, PAD.top, 0, PAD.top + plotH);
    grad.addColorStop(0, 'rgba(0,74,153,0.18)');
    grad.addColorStop(1, 'rgba(0,74,153,0.01)');
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, PAD.top + plotH);
    ctx.lineTo(pts[0].x, PAD.top + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    pts.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.strokeStyle = '#004a99';
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Dots — color-coded by GPA quality
    pts.forEach(p => {
      const color = p.gpa <= 1.3 ? '#28a745' : p.gpa <= 2.3 ? '#d4a843' : p.gpa <= 3.3 ? '#fd7e14' : '#dc3545';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });

    // X axis labels (abbreviated)
    ctx.fillStyle = '#888';
    ctx.font = '9px Segoe UI,sans-serif';
    ctx.textAlign = 'center';
    pts.forEach(p => {
      const short = p.label.replace(/semester/i, 'Sem').substring(0, 10);
      ctx.fillText(short, p.x, PAD.top + plotH + 14);
    });

    // Hover tooltip
    let tooltip = document.getElementById('guc-chart-tooltip');
    if (!tooltip) {
      tooltip = document.createElement('div');
      tooltip.id = 'guc-chart-tooltip';
      tooltip.className = 'guc-chart-tooltip';
      document.body.appendChild(tooltip);
    }

    canvas.addEventListener('mousemove', (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = W / rect.width;
      const mx = (e.clientX - rect.left) * scaleX;
      let closest = null, minDist = Infinity;
      pts.forEach(p => { const d = Math.abs(p.x - mx); if (d < minDist) { minDist = d; closest = p; } });
      if (closest && minDist < 20) {
        tooltip.style.display = 'block';
        tooltip.style.left = (e.clientX + 12) + 'px';
        tooltip.style.top = (e.clientY - 28) + 'px';
        tooltip.textContent = `${closest.label}: ${closest.gpa.toFixed(2)}`;
      } else {
        tooltip.style.display = 'none';
      }
    });
    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
  }

  // ============================================================
  // FEATURE 3 — What-If Grade Simulator
  // ============================================================

  // Calculate simulated GPA using whatIfOverrides (never touches storage)
  function calculateWhatIfGPA() {
    let allCourses = getAllStoredCourses();
    allCourses = processGermanCourses(allCourses);
    allCourses = processMakeupCourses(allCourses);  // FIX-3: exclude retaken originals

    let credits = 0, weightedSum = 0;
    allCourses.forEach(c => {
      if (c.creditHours <= 0 || c.isSuperseded || c.isEnglish || c.isPending || c.grade === null) return;
      const override = parseFloat(whatIfOverrides[c.courseName]);
      const grade = (!isNaN(override) && override > 0) ? override : Number(c.grade);
      credits += c.creditHours;
      weightedSum += grade * c.creditHours;
    });
    return credits > 0 ? weightedSum / credits : null;
  }

  // Render the What-If section: list of completed courses with override dropdowns
  function renderWhatIfSection() {
    const list = document.getElementById('guc-whatif-list');
    const resultEl = document.getElementById('guc-whatif-result');
    const gpaEl = document.getElementById('guc-whatif-gpa');
    const deltaEl = document.getElementById('guc-whatif-delta');
    if (!list) return;

    let allCourses = getAllStoredCourses();
    allCourses = processGermanCourses(allCourses);
    allCourses = processMakeupCourses(allCourses);  // FIX-3: exclude retaken originals
    const completed = allCourses.filter(c => !c.isPending && c.grade !== null && c.creditHours > 0 && !c.isSuperseded && !c.isEnglish);

    if (completed.length === 0) {
      list.innerHTML = '<li style="font-size:12px;color:#999;padding:8px 0;">No completed courses found. Sync semesters first.</li>';
      if (resultEl) resultEl.style.display = 'none';
      return;
    }

    const gradeSteps = [
      { val: '0.7', label: 'A+ (0.7)' }, { val: '1.0', label: 'A (1.0)' }, { val: '1.3', label: 'A- (1.3)' },
      { val: '1.7', label: 'B+ (1.7)' }, { val: '2.0', label: 'B (2.0)' }, { val: '2.3', label: 'B- (2.3)' },
      { val: '2.7', label: 'C+ (2.7)' }, { val: '3.0', label: 'C (3.0)' }, { val: '3.3', label: 'C- (3.3)' },
      { val: '3.7', label: 'D+ (3.7)' }, { val: '4.0', label: 'D (4.0)' }, { val: '5.0', label: 'F (5.0)' }
    ];

    list.innerHTML = completed.map((c, idx) => {
      const override = whatIfOverrides[c.courseName];
      const options = gradeSteps.map(g =>
        `<option value="${g.val}" ${override == g.val ? 'selected' : g.val == c.grade && !override ? 'selected' : ''}>${g.label}</option>`
      ).join('');
      const shortName = c.courseName.length > 22 ? c.courseName.substring(0, 20) + '…' : c.courseName;
      return `
        <li class="guc-whatif-item" data-idx="${idx}">
          <span class="guc-whatif-name" title="${c.courseName}">${shortName}</span>
          <span class="guc-whatif-original">${c.creditHours}cr</span>
          <select class="guc-whatif-select" data-course="${c.courseName}" style="font-size:11px;border-radius:5px;border:1px solid #ccc;padding:2px 4px;max-width:90px;">
            ${options}
          </select>
        </li>`;
    }).join('');

    // Wire dropdowns
    list.querySelectorAll('.guc-whatif-select').forEach(sel => {
      sel.addEventListener('change', () => {
        whatIfOverrides[sel.dataset.course] = sel.value;
        updateWhatIfResult();
      });
    });

    updateWhatIfResult();

    function updateWhatIfResult() {
      const simGPA = calculateWhatIfGPA();
      if (simGPA === null) { if (resultEl) resultEl.style.display = 'none'; return; }

      // Real GPA (no overrides)
      const realGPAStr = document.getElementById('guc-current-gpa')?.textContent;
      const realGPA = parseFloat(realGPAStr);

      if (resultEl) resultEl.style.display = 'flex';
      if (gpaEl) gpaEl.textContent = simGPA.toFixed(2);
      if (deltaEl && !isNaN(realGPA)) {
        const delta = realGPA - simGPA; // positive delta = improvement (lower GPA = better)
        deltaEl.className = 'guc-whatif-delta ' + (Math.abs(delta) < 0.005 ? 'neutral' : delta > 0 ? 'positive' : 'negative');
        const sign = delta > 0.005 ? '▼ ' : delta < -0.005 ? '▲ ' : '';
        deltaEl.textContent = delta === 0 ? 'No change' : `${sign}${Math.abs(delta).toFixed(2)} vs real`;
      }
    }
  }

  // Color code GPA based on value
  function colorCodeGPA(elementId, gpa) {
    const element = document.getElementById(elementId);
    if (!element || isNaN(gpa)) return;

    element.classList.remove('guc-gpa-excellent', 'guc-gpa-good', 'guc-gpa-average', 'guc-gpa-poor', 'guc-gpa-fail');

    if (gpa <= 1.0) {
      element.classList.add('guc-gpa-excellent');
    } else if (gpa <= 1.7) {
      element.classList.add('guc-gpa-good');
    } else if (gpa <= 2.7) {
      element.classList.add('guc-gpa-average');
    } else if (gpa <= 4.0) {
      element.classList.add('guc-gpa-poor');
    } else {
      element.classList.add('guc-gpa-fail');
    }
  }

  // Calculate goal - what grade needed in pending courses to reach target
  function calculateGoal() {
    const targetInput = document.getElementById('guc-target-gpa');
    const resultDiv = document.getElementById('guc-goal-result');
    const targetGPA = parseFloat(targetInput.value);

    if (isNaN(targetGPA) || targetGPA < CONFIG.MIN_GRADE || targetGPA > CONFIG.MAX_GRADE) {
      resultDiv.innerHTML = `<span class="guc-error">Please enter a valid target GPA (${CONFIG.MIN_GRADE} - ${CONFIG.MAX_GRADE})</span>`;
      return;
    }

    // Get all courses from all stored semesters
    let allCourses = getAllStoredCourses();
    allCourses = processGermanCourses(allCourses);
    allCourses = processMakeupCourses(allCourses);

    const trulyPendingCourses = userPendingCourses.filter(c => !c.predictedGrade);
    const predictedPendingCourses = userPendingCourses.filter(c => c.predictedGrade);

    // Calculate current totals
    let completedCredits = 0;
    let completedWeightedSum = 0;
    let transcriptPendingCredits = 0;
    let transcriptPendingCount = 0;

    allCourses.forEach((course) => {
      if (course.creditHours <= 0 || course.isSuperseded || course.isEnglish) return;
      if (!course.isPending && course.grade !== null) {
        completedCredits += course.creditHours;
        completedWeightedSum += course.grade * course.creditHours;
      } else if (course.isPending) {
        // BUG-3 FIX: use parseFloat + grade > 0 guard
        const savedGrade = parseFloat(predictedGrades[course.courseName]);
        if (!isNaN(savedGrade) && savedGrade > 0) {
          completedCredits += course.creditHours;
          completedWeightedSum += savedGrade * course.creditHours;
        } else {
          transcriptPendingCredits += course.creditHours;
          transcriptPendingCount++;
        }
      }
    });

    // Add predicted pending courses to the "completed" totals
    predictedPendingCourses.forEach(c => {
      completedCredits += Number(c.creditHours);
      completedWeightedSum += Number(c.predictedGrade) * Number(c.creditHours);
    });

    let pendingCredits = trulyPendingCourses.reduce((sum, c) => sum + Number(c.creditHours), 0) + transcriptPendingCredits;

    if (pendingCredits === 0) {
      const resultingGPA = completedCredits > 0 ? (completedWeightedSum / completedCredits).toFixed(2) : 'N/A';
      resultDiv.innerHTML = `<span class="guc-success">All pending courses have predicted grades. Projected GPA: <b>${resultingGPA}</b></span>`;
      return;
    }

    // Calculate required average grade for pending courses
    const totalCredits = completedCredits + pendingCredits;
    const targetWeightedSum = targetGPA * totalCredits;
    const requiredPendingWeightedSum = targetWeightedSum - completedWeightedSum;
    const requiredAvgGrade = requiredPendingWeightedSum / pendingCredits;

    // Check if goal is achievable
    if (requiredAvgGrade < CONFIG.MIN_GRADE) {
      resultDiv.innerHTML = `
        <span class="guc-success">
          ✅ Great news! You can achieve a <strong>${targetGPA}</strong> GPA even with the best possible grade (${CONFIG.MIN_GRADE})!
          <br>Required average: <strong>${requiredAvgGrade.toFixed(2)}</strong> (better than ${CONFIG.MIN_GRADE})
        </span>
      `;
    } else if (requiredAvgGrade > CONFIG.MAX_GRADE) {
      // FIX-5: use MAX_GRADE (5.0 = F) not PASS_THRESHOLD (4.0 = D).
      // A required average of e.g. 4.5 IS theoretically achievable on GUC scale.
      resultDiv.innerHTML = `
        <span class="guc-error">
          ❌ Unfortunately, achieving a <strong>${targetGPA}</strong> GPA is not possible.
          <br>Would require: <strong>${requiredAvgGrade.toFixed(2)}</strong> (higher than the maximum grade 5.0)
        </span>
      `;
    } else {
      let difficultyClass = 'guc-info';
      let emoji = '📝';
      
      if (requiredAvgGrade <= 1.3) {
        difficultyClass = 'guc-success';
        emoji = '🌟';
      } else if (requiredAvgGrade <= 2.0) {
        difficultyClass = 'guc-info';
        emoji = '💪';
      } else if (requiredAvgGrade <= 3.0) {
        difficultyClass = 'guc-warning';
        emoji = '⚠️';
      } else {
        difficultyClass = 'guc-error';
        emoji = '🔥';
      }

      resultDiv.innerHTML = `
        <span class="${difficultyClass}">
          ${emoji} To achieve a <strong>${targetGPA}</strong> GPA:
          <br>Average grade needed in pending courses: <strong>${requiredAvgGrade.toFixed(2)}</strong>
          <br><small>(${pendingCredits} pending credits across ${trulyPendingCourses.length + transcriptPendingCount} courses)</small>
        </span>
      `;
    }
  }

  // Toggle dark mode
  function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('guc-dark-mode', isDarkMode);
    try {
      chrome.storage.local.set({ darkMode: isDarkMode });
    } catch (e) {}
    
    const btn = document.getElementById('guc-dark-toggle');
    if (btn) btn.textContent = isDarkMode ? '☀️' : '🌙';
  }

  // Toggle dashboard minimize
  function toggleMinimize() {
    const dashboard = document.getElementById('guc-gpa-dashboard');
    const content = dashboard.querySelector('.guc-dashboard-content');
    const btn = document.getElementById('guc-minimize');
    
    content.classList.toggle('guc-hidden');
    if (btn) btn.textContent = content.classList.contains('guc-hidden') ? '➕' : '➖';
  }

  // Make element draggable
  function makeDraggable(element) {
    const header = element.querySelector('.guc-dashboard-header');
    let isDragging = false;
    let startX, startY, startLeft, startBottom;

    header.addEventListener('mousedown', (e) => {
      if (e.target.tagName === 'BUTTON') return;
      
      isDragging = true;
      startX = e.clientX;
      startY = e.clientY;
      
      const rect = element.getBoundingClientRect();
      startLeft = rect.left;
      startBottom = window.innerHeight - rect.bottom;
      
      header.style.cursor = 'grabbing';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      
      const deltaX = e.clientX - startX;
      const deltaY = e.clientY - startY;
      
      element.style.left = `${startLeft + deltaX}px`;
      element.style.bottom = `${startBottom - deltaY}px`;
      element.style.right = 'auto';
    });

    document.addEventListener('mouseup', () => {
      isDragging = false;
      header.style.cursor = 'grab';
    });
  }

  // Reset all predicted grades
  window.resetPredictedGrades = function() {
    predictedGrades = {};
    try {
      chrome.storage.local.set({ predictedGrades: {} });
    } catch (e) {}
    
    // Clear all inputs
    document.querySelectorAll('.guc-grade-input').forEach(input => {
      input.value = '';
    });
    
    updateGPACalculations();
  };

  // Listen for messages from popup
  try {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'reset') {
        window.resetPredictedGrades();
        sendResponse({ success: true });
      } else if (message.action === 'toggle') {
        isEnabled = message.enabled;
        if (!isEnabled) {
          // Remove dashboard
          const dashboard = document.getElementById('guc-gpa-dashboard');
          if (dashboard) dashboard.remove();
          
          // Remove injected inputs
          document.querySelectorAll('.guc-input-wrapper').forEach(wrapper => {
            const original = wrapper.querySelector('.guc-original-grade');
            if (wrapper.parentElement) {
              wrapper.parentElement.innerHTML = original ? original.textContent : '';
            }
          });
        } else {
          init();
        }
        sendResponse({ success: true });
      } else if (message.action === 'getStatus') {
        sendResponse({ 
          enabled: isEnabled,
          darkMode: isDarkMode,
          hasDashboard: !!document.getElementById('guc-gpa-dashboard')
        });
      } else if (message.action === 'getCompletedCourses') {
        // Return all completed courses (with grades and credits)
        let allCourses = getAllStoredCourses();
        allCourses = processGermanCourses(allCourses);
        allCourses = processMakeupCourses(allCourses);
        const completed = allCourses.filter(c => !c.isPending && c.grade !== null && c.creditHours > 0 && !c.isSuperseded && !c.isEnglish)
          .map(c => ({
            courseName: c.courseName,
            creditHours: c.creditHours,
            grade: c.grade
          }));
        const transcriptPending = allCourses.filter(c => c.isPending && c.creditHours > 0 && !c.isSuperseded && !c.isEnglish)
          .map(c => ({
            courseName: c.courseName,
            creditHours: c.creditHours
          }));
        sendResponse({ 
          completedCourses: completed, 
          transcriptPendingCourses: transcriptPending,
          predictedGrades: predictedGrades || {}
        });
      }
      return true;
    });
  } catch (e) {
    console.log('🎓 Message listener not available');
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Small delay to ensure page is fully loaded
    setTimeout(init, 500);
  }
})();