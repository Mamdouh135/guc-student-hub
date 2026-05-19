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

    // Find transcript table on current page
    transcriptTable = findTranscriptTable();
    if (!transcriptTable) {
      console.log('🎓 GUC GPA Calculator: No transcript table found on this page');
      // Still show dashboard with stored semesters
      createDashboard();
      updateGPACalculations();
      return;
    }

    console.log('🎓 GUC GPA Calculator: Found transcript table!');
    
    // Detect column indices
    detectColumns();
    
    if (creditHoursCol === -1 || gradeCol === -1) {
      console.log('🎓 GUC GPA Calculator: Could not detect Credit Hours or Grade columns');
      return;
    }

    console.log(`🎓 Credit Hours column: ${creditHoursCol}, Grade column: ${gradeCol}`);

    // Scrape current page's transcript
    scrapeCurrentSemester();
    
    // Save current semester to storage
    await saveSemesterData();
    
    injectPredictorInputs();
    createDashboard();
    updateGPACalculations();
    
    // Apply dark mode if enabled
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

  // Handle semester dropdown change
  async function onSemesterChange() {
    console.log('🎓 Semester changed, waiting for page update...');
    
    // Wait a bit for page to update (AJAX or page reload)
    setTimeout(async () => {
      currentSemesterId = getSemesterIdFromDropdown();
      console.log(`🎓 New semester: ${currentSemesterId}`);
      
      // Re-find and re-scrape
      transcriptTable = findTranscriptTable();
      if (transcriptTable) {
        creditHoursCol = -1;
        gradeCol = -1;
        detectColumns();
        scrapeCurrentSemester();
        await saveSemesterData();
        updateGPACalculations();
      }
    }, 1000);
  }

  // Find transcript table on current page
  function findTranscriptTable() {
    // Try common IDs first
    const commonIds = ['gvTranscript', 'GridView1', 'dgTranscript', 'tblTranscript', 'ContentPlaceHolder1_gvTranscript'];
    for (const id of commonIds) {
      const table = document.getElementById(id);
      if (table && table.tagName === 'TABLE') {
        console.log(`🎓 Found table by ID: ${id}`);
        return table;
      }
    }

    // Search all tables for ones that look like transcripts
    const tables = document.querySelectorAll('table');
    console.log(`🎓 Searching ${tables.length} tables for transcript data...`);
    
    for (const table of tables) {
      if (isTranscriptTable(table)) {
        console.log('🎓 Found transcript table by content analysis');
        return table;
      }
    }

    return null;
  }

  // Check if a table looks like a transcript
  function isTranscriptTable(table) {
    const text = table.textContent.toLowerCase();
    const rows = table.querySelectorAll('tr');
    
    // Must have multiple rows
    if (rows.length < 3) return false;
    
    // Look for keywords that indicate a transcript
    const keywords = ['grade', 'credit', 'course', 'gpa', 'semester', 'hours', 'code'];
    let keywordCount = 0;
    for (const keyword of keywords) {
      if (text.includes(keyword)) keywordCount++;
    }
    
    // Also check for numeric grades (0.7 to 5.0 pattern)
    const gradePattern = /\b[0-4]\.[0-9]\b/;
    const hasGrades = gradePattern.test(table.textContent);
    
    return keywordCount >= 2 || hasGrades;
  }

  // Detect which columns contain credit hours and grades
  function detectColumns() {
    if (!transcriptTable) return;
    
    const headerRow = transcriptTable.querySelector('tr');
    if (!headerRow) return;

    const headers = headerRow.querySelectorAll('th, td');
    
    headers.forEach((header, index) => {
      const text = header.textContent.toLowerCase().trim();
      
      // Detect credit hours column
      if (creditHoursCol === -1 && (text.includes('credit') || text.includes('hours') || text.includes('ch') || text.includes('cr.') || text === 'cr')) {
        creditHoursCol = index;
        console.log(`🎓 Detected Credit Hours at column ${index}: "${header.textContent.trim()}"`);
      }
      
      // Detect grade column
      if (gradeCol === -1 && ((text.includes('grade') || text === 'gr' || text === 'gr.') && !text.includes('point'))) {
        gradeCol = index;
        console.log(`🎓 Detected Grade at column ${index}: "${header.textContent.trim()}"`);
      }
    });

    // If not found by headers, try to detect by content
    if (creditHoursCol === -1 || gradeCol === -1) {
      detectColumnsByContent();
    }
  }

  // Detect columns by analyzing actual data content
  function detectColumnsByContent() {
    if (!transcriptTable) return;
    
    const columnPatterns = {};
    const rows = transcriptTable.querySelectorAll('tr');
    if (rows.length < 2) return;

    // Analyze a few data rows
    const dataRows = Array.from(rows).slice(1, Math.min(6, rows.length));
    
    dataRows.forEach(row => {
      const cells = row.querySelectorAll('td');
      cells.forEach((cell, index) => {
        if (!columnPatterns[index]) {
          columnPatterns[index] = { creditLike: 0, gradeLike: 0 };
        }
        
        const text = cell.textContent.trim();
        const num = parseFloat(text);
        
        // Credit hours are usually small integers (1-6)
        if (!isNaN(num) && num >= 1 && num <= 6 && Number.isInteger(num)) {
          columnPatterns[index].creditLike++;
        }
        
        // Grades are decimals between 0.7 and 5.0
        if (!isNaN(num) && num >= 0.7 && num <= 5.0 && text.includes('.')) {
          columnPatterns[index].gradeLike++;
        }
      });
    });

    // Find best matches
    let bestCreditCol = -1, bestCreditScore = 0;
    let bestGradeCol = -1, bestGradeScore = 0;
    
    for (const [col, patterns] of Object.entries(columnPatterns)) {
      if (patterns.creditLike > bestCreditScore) {
        bestCreditScore = patterns.creditLike;
        bestCreditCol = parseInt(col);
      }
      if (patterns.gradeLike > bestGradeScore) {
        bestGradeScore = patterns.gradeLike;
        bestGradeCol = parseInt(col);
      }
    }

    if (creditHoursCol === -1 && bestCreditCol !== -1) {
      creditHoursCol = bestCreditCol;
      console.log(`🎓 Auto-detected Credit Hours at column ${creditHoursCol} (by content)`);
    }
    
    if (gradeCol === -1 && bestGradeCol !== -1) {
      gradeCol = bestGradeCol;
      console.log(`🎓 Auto-detected Grade at column ${gradeCol} (by content)`);
    }
  }

  // Scrape current page's transcript (single semester)
  function scrapeCurrentSemester() {
    currentSemesterData = [];
    if (!transcriptTable) return;

    const rows = transcriptTable.querySelectorAll('tr');
    let rowIndex = 0;
    let isFirstRow = true;

    rows.forEach((row) => {
      // Skip header rows
      if (isFirstRow || row.querySelectorAll('th').length > 0) {
        isFirstRow = false;
        return;
      }

      const cells = row.querySelectorAll('td');
      if (cells.length <= Math.max(creditHoursCol, gradeCol)) return;

      const creditHoursText = cells[creditHoursCol]?.textContent?.trim();
      const gradeText = cells[gradeCol]?.textContent?.trim();
      
      const creditHours = parseFloat(creditHoursText);
      const grade = parseFloat(gradeText);

      // Get course name (usually first or second column)
      const courseName = cells[1]?.textContent?.trim() || cells[0]?.textContent?.trim() || `Course ${rowIndex}`;

      const isPending = !gradeText || 
                        gradeText.toLowerCase() === 'pending' || 
                        gradeText === '-' || 
                        gradeText === '' ||
                        gradeText === 'N/A' ||
                        gradeText === '--' ||
                        isNaN(grade);

      // Only add rows that look like actual course entries
      if (!isNaN(creditHours) && creditHours > 0) {
        // Detect language course type
        const langInfo = detectLanguageCourse(courseName, creditHours);
        
        currentSemesterData.push({
          rowIndex: rowIndex,
          row: row,
          gradeCell: cells[gradeCol],
          courseName: courseName,
          creditHours: creditHours,
          grade: isPending ? null : grade,
          isPending: isPending,
          isGerman: langInfo.isGerman,
          germanLevel: langInfo.germanLevel,
          isEnglish: langInfo.isEnglish,
          semesterId: currentSemesterId
        });
        
        rowIndex++;
      }
    });

    console.log(`🎓 Scraped ${currentSemesterData.length} courses from current semester: ${currentSemesterId}`);
  }

  // Save current semester data to Chrome storage
  async function saveSemesterData() {
    if (currentSemesterData.length === 0) return;

    // Create serializable version (without DOM references)
    const coursesToStore = currentSemesterData.map(course => ({
      courseName: course.courseName,
      creditHours: course.creditHours,
      grade: course.grade,
      isPending: course.isPending,
      isGerman: course.isGerman,
      germanLevel: course.germanLevel,
      isEnglish: course.isEnglish
    }));

    // Update stored semesters
    allSemestersData[currentSemesterId] = {
      courses: coursesToStore,
      semesterName: getSemesterDisplayName(),
      lastUpdated: new Date().toISOString()
    };

    // Save to Chrome storage
    try {
      await chrome.storage.local.set({ [CONFIG.STORAGE_KEY]: allSemestersData });
      console.log(`🎓 Saved semester "${currentSemesterId}" to storage. Total semesters: ${Object.keys(allSemestersData).length}`);
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

  // Get all courses from all stored semesters (for cumulative GPA)
  function getAllStoredCourses() {
    const allCourses = [];
    
    for (const [semesterId, semesterInfo] of Object.entries(allSemestersData)) {
      if (semesterInfo.courses) {
        semesterInfo.courses.forEach(course => {
          allCourses.push({
            ...course,
            semesterId: semesterId,
            semesterName: semesterInfo.semesterName
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
    const toggleOverview = document.getElementById('toggle-overview');
    const toggleGoal = document.getElementById('toggle-goal');
    toggleOverview.addEventListener('click', () => {
      if (overviewBody.style.display === 'none') {
        overviewBody.style.display = '';
        toggleOverview.textContent = '▲';
      } else {
        overviewBody.style.display = 'none';
        toggleOverview.textContent = '▼';
      }
    });
    toggleGoal.addEventListener('click', () => {
      if (goalBody.style.display === 'none') {
        goalBody.style.display = '';
        toggleGoal.textContent = '▼';
      } else {
        goalBody.style.display = 'none';
        toggleGoal.textContent = '▲';
      }
    });
    // Default: Overview open, Goal closed
    overviewBody.style.display = '';
    goalBody.style.display = 'none';

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

  function numericToLetterGrade(grade) {
    if (grade === 0.7) return 'A+';
    if (grade === 1.0) return 'A';
    if (grade === 1.3) return 'A-';
    if (grade === 1.7) return 'B+';
    if (grade === 2.0) return 'B';
    if (grade === 2.3) return 'B-';
    if (grade <= 2.7) return 'C+';
    if (grade <= 3.0) return 'C';
    if (grade <= 3.3) return 'C-';
    if (grade <= 3.7) return 'D+';
    if (grade <= 4.0) return 'D';
    return 'F';
  }

  // Update GPA calculations using ALL stored semesters
  function updateGPACalculations() {
    // Get all courses from all stored semesters
    let allCourses = getAllStoredCourses();
    
    // Process German courses across all semesters
    allCourses = processGermanCourses(allCourses);

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
    if (pendingCountEl) pendingCountEl.textContent = pendingCount;
    if (totalCreditsEl) {
      const pendingCreditsTotal = allCourses.filter(c => c.isPending).reduce((sum, c) => sum + c.creditHours, 0);
      totalCreditsEl.textContent = completedCredits + pendingCreditsTotal;
    }

    // Update stored semesters list
    updateSemestersList();

    colorCodeGPA('guc-current-gpa', parseFloat(currentGPA));
    colorCodeGPA('guc-predicted-gpa', parseFloat(predictedGPA));
    colorCodeGPA('guc-gpa-no-german', parseFloat(noGermanGPA));
    colorCodeGPA('guc-gpa-with-english', parseFloat(withEnglishGPA));
  }

  // Update the semesters list in dashboard
  function updateSemestersList() {
    const listEl = document.getElementById('guc-semesters-list');
    if (!listEl) return;

    const semesters = Object.entries(allSemestersData);
    
    if (semesters.length === 0) {
      listEl.innerHTML = '<span class="guc-no-semesters">No semesters stored yet. Visit each semester page to collect data.</span>';
      return;
    }

    listEl.innerHTML = semesters.map(([id, info]) => {
      const courseCount = info.courses ? info.courses.length : 0;
      const completedCount = info.courses ? info.courses.filter(c => !c.isPending && c.grade !== null).length : 0;
      const isCurrent = id === currentSemesterId;
      return `
        <div class="guc-semester-item ${isCurrent ? 'guc-current-semester' : ''}">
          <span class="guc-semester-name">${info.semesterName || id}</span>
          <span class="guc-semester-info">${completedCount}/${courseCount} courses</span>
          ${isCurrent ? '<span class="guc-current-badge">Current</span>' : ''}
        </div>
      `;
    }).join('');
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
    } else if (requiredAvgGrade > CONFIG.PASS_THRESHOLD) {
      resultDiv.innerHTML = `
        <span class="guc-error">
          ❌ Unfortunately, achieving a <strong>${targetGPA}</strong> GPA is not possible.
          <br>Would require: <strong>${requiredAvgGrade.toFixed(2)}</strong> (above passing threshold)
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