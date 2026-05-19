/**
 * GUC Transcript GPA Calculator - Popup Script
 * Handles settings and communication with content script
 */

document.addEventListener('DOMContentLoaded', async () => {
  const toggleEnabled = document.getElementById('toggle-enabled');
  const btnReset = document.getElementById('btn-reset');
  const btnOpenTranscript = document.getElementById('btn-open-transcript');
  const statusMessage = document.getElementById('status-message');

  // New elements for user courses and target GPA
  const coursesForm = document.getElementById('courses-form');
  const courseNameInput = document.getElementById('course-name');
  const courseCreditsInput = document.getElementById('course-credits');
  const coursesList = document.getElementById('courses-list');
  const targetGpaInput = document.getElementById('target-gpa');
  const btnCalcTarget = document.getElementById('btn-calc-target');
  const targetResult = document.getElementById('target-result');

  // Storage keys
  const USER_COURSES_KEY = 'userPendingCourses';
  const USER_TARGET_GPA_KEY = 'userTargetGpa';

  // Load user courses and target GPA
  let userCourses = [];
  let userTargetGpa = '';
  loadUserCourses();
  loadUserTargetGpa();
  // --- User Courses Logic ---
  coursesForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = courseNameInput.value.trim();
    const credits = parseFloat(courseCreditsInput.value);
    if (!name || isNaN(credits) || credits <= 0) {
      showStatus('Enter valid course name and credits.', 'error');
      return;
    }
    userCourses.push({
      id: Date.now() + Math.random(),
      courseName: name,
      creditHours: credits
    });
    await chrome.storage.local.set({ [USER_COURSES_KEY]: userCourses });
    courseNameInput.value = '';
    courseCreditsInput.value = '';
    renderCoursesList();
  });

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

  function renderCoursesList() {
    coursesList.innerHTML = '';
    userCourses.forEach((course, idx) => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.justifyContent = 'space-between';
      li.style.alignItems = 'center';
      li.style.gap = '8px';
      li.style.marginBottom = '6px';

      const nameSpan = document.createElement('span');
      nameSpan.textContent = `${course.courseName} (${course.creditHours} cr)`;
      nameSpan.style.flex = '1';
      nameSpan.style.overflow = 'hidden';
      nameSpan.style.textOverflow = 'ellipsis';
      nameSpan.style.whiteSpace = 'nowrap';

      const dropdownWrapper = document.createElement('div');
      dropdownWrapper.innerHTML = getDropdownHTML(idx, course.predictedGrade);
      const container = dropdownWrapper.firstElementChild;
      
      const selectedEl = container.querySelector('.guc-dropdown-selected');
      const menuEl = container.querySelector('.guc-dropdown-menu');

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
          // BUG-4 FIX: store null (not "") when Pending is selected so falsy checks work cleanly
          userCourses[idx].predictedGrade = value || null;
          await chrome.storage.local.set({ [USER_COURSES_KEY]: userCourses });
          renderCoursesList();
          calculateRequiredAverageWithTranscript();
        });
      });

      // Remove button
      const btnRemove = document.createElement('button');
      btnRemove.textContent = '✖';
      btnRemove.style.background = 'none';
      btnRemove.style.border = 'none';
      btnRemove.style.color = '#dc3545';
      btnRemove.style.cursor = 'pointer';
      btnRemove.style.fontSize = '14px';
      btnRemove.title = 'Remove course';
      btnRemove.onclick = async () => {
        userCourses.splice(idx, 1);
        await chrome.storage.local.set({ [USER_COURSES_KEY]: userCourses });
        renderCoursesList();
        calculateRequiredAverageWithTranscript();
      };
      
      li.appendChild(nameSpan);
      li.appendChild(container);
      li.appendChild(btnRemove);
      coursesList.appendChild(li);
    });
  }

  // Close dropdowns on outside click
  document.addEventListener('click', () => {
    document.querySelectorAll('.guc-dropdown-menu.guc-show').forEach(m => m.classList.remove('guc-show'));
  });

  async function loadUserCourses() {
    const storage = await chrome.storage.local.get([USER_COURSES_KEY]);
    userCourses = Array.isArray(storage[USER_COURSES_KEY]) ? storage[USER_COURSES_KEY] : [];
    renderCoursesList();
  }

  // --- Target GPA Logic ---
  btnCalcTarget.addEventListener('click', async () => {
    const target = parseFloat(targetGpaInput.value);
    if (isNaN(target) || target < 0.7 || target > 5.0) {
      showStatus('Enter a valid target GPA (0.7 - 5.0)', 'error');
      return;
    }
    userTargetGpa = target;
    await chrome.storage.local.set({ [USER_TARGET_GPA_KEY]: userTargetGpa });
    calculateRequiredAverageWithTranscript();
  });

  async function loadUserTargetGpa() {
    const storage = await chrome.storage.local.get([USER_TARGET_GPA_KEY]);
    userTargetGpa = storage[USER_TARGET_GPA_KEY] || '';
    if (userTargetGpa) targetGpaInput.value = userTargetGpa;
    calculateRequiredAverageWithTranscript();
  }

  // Request completed courses from content script and calculate required average
  // --- Grade Combination Suggestion Logic ---
  let gradeCombinations = [];
  let currentCombinationIndex = 0;
  // BUG-2 FIX: store the full pending list at outer scope so showCurrentCombination always has it
  let lastTrulyPendingCourses = [];

  async function calculateRequiredAverageWithTranscript() {
    if (!userTargetGpa) {
      targetResult.textContent = '';
      return;
    }
    // Get completed courses from the transcript (content script)
    let completedCourses = [];
    let transcriptPendingCourses = [];
    let predictedGrades = {};
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('apps.guc.edu.eg')) {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getCompletedCourses' });
        if (response) {
          completedCourses = response.completedCourses || [];
          transcriptPendingCourses = response.transcriptPendingCourses || [];
          predictedGrades = response.predictedGrades || {};
        }
      }
    } catch (e) {
      completedCourses = [];
      transcriptPendingCourses = [];
      predictedGrades = {};
    }

    const trulyPendingCourses = userCourses.filter(c => !c.predictedGrade);
    const predictedPendingCourses = userCourses.filter(c => c.predictedGrade);

    let completedCredits = completedCourses.reduce((sum, c) => sum + Number(c.creditHours), 0);
    let completedWeightedSum = completedCourses.reduce((sum, c) => sum + (Number(c.grade) * Number(c.creditHours)), 0);

    transcriptPendingCourses.forEach(c => {
      // BUG-3 FIX: use parseFloat and guard against empty string / zero
      const savedGrade = parseFloat(predictedGrades[c.courseName]);
      if (!isNaN(savedGrade) && savedGrade > 0) {
        completedCredits += Number(c.creditHours);
        completedWeightedSum += savedGrade * Number(c.creditHours);
      } else {
        // BUG-2 FIX: push into the same trulyPendingCourses array that is saved to outer scope
        trulyPendingCourses.push({
          courseName: c.courseName,
          creditHours: Number(c.creditHours)
        });
      }
    });

    // Add predicted pending courses to the "completed" totals
    predictedPendingCourses.forEach(c => {
      completedCredits += Number(c.creditHours);
      completedWeightedSum += Number(c.predictedGrade) * Number(c.creditHours);
    });

    const pendingCredits = trulyPendingCourses.reduce((sum, c) => sum + Number(c.creditHours), 0);

    if (pendingCredits === 0) {
      const resultingGPA = completedCredits > 0 ? (completedWeightedSum / completedCredits).toFixed(2) : 'N/A';
      targetResult.innerHTML = `<span style="color:#28a745">All pending courses have predicted grades. Projected GPA: <b>${resultingGPA}</b></span>`;
      const btn = document.getElementById('show-other-suggestions');
      if (btn) btn.remove();
      lastTrulyPendingCourses = [];
      return;
    }

    const totalCredits = completedCredits + pendingCredits;
    const targetWeightedSum = userTargetGpa * totalCredits;
    const requiredPendingWeightedSum = targetWeightedSum - completedWeightedSum;
    const requiredAvgGrade = requiredPendingWeightedSum / pendingCredits;

    if (requiredAvgGrade < 0.7) {
      targetResult.innerHTML = `❌ Not possible: The best achievable grade is 0.7, but you would need an average of <b>${requiredAvgGrade.toFixed(2)}</b>.<br>`;
      return;
    }
    if (requiredAvgGrade > 5.0) {
      targetResult.innerHTML = `❌ Achieving a GPA of <b>${userTargetGpa}</b> is not possible.<br>Would require: <b>${requiredAvgGrade.toFixed(2)}</b> (above failing)`;
      return;
    }

    // BUG-2 FIX: save the full list before generating combos so showCurrentCombination can use it
    lastTrulyPendingCourses = trulyPendingCourses.slice();

    // BUG-1 FIX: pass completedCourses into generateGradeCombinations so GPA is calculated correctly
    gradeCombinations = generateGradeCombinations(trulyPendingCourses, completedCourses, completedCredits, completedWeightedSum);
    currentCombinationIndex = 0;

    if (gradeCombinations.length === 0) {
      targetResult.innerHTML = `❌ No valid grade combinations found to achieve a GPA of <b>${userTargetGpa}</b> with your current courses.`;
      return;
    }

    showCurrentCombination();
    if (gradeCombinations.length > 1) {
      if (!document.getElementById('show-other-suggestions')) {
        const btn = document.createElement('button');
        btn.id = 'show-other-suggestions';
        btn.textContent = 'Show Other Suggestions';
        btn.className = 'btn btn-secondary';
        btn.style.marginTop = '8px';
        btn.onclick = () => {
          currentCombinationIndex = (currentCombinationIndex + 1) % gradeCombinations.length;
          showCurrentCombination();
        };
        targetResult.parentNode.appendChild(btn);
      }
    } else {
      const btn = document.getElementById('show-other-suggestions');
      if (btn) btn.remove();
    }
  }

  // BUG-1 FIX: completedCourses, completedCredits, completedWeightedSum passed as explicit params
  function generateGradeCombinations(pendingCourses, completedCourses, completedCredits, completedWeightedSum) {
    const gradeSteps = [0.7, 1.0, 1.3, 1.7, 2.0, 2.3, 2.7, 3.0, 3.3, 3.7, 4.0, 5.0];
    const n = pendingCourses.length;
    const credits = pendingCourses.map(c => Number(c.creditHours));
    const combinations = [];

    function tryCombinations(idx, current) {
      if (idx === n) {
        // BUG-1 FIX: include real completed courses in GPA check
        let pendingWeightedSum = 0, pendingTotalCredits = 0;
        for (let i = 0; i < n; ++i) {
          pendingWeightedSum += current[i] * credits[i];
          pendingTotalCredits += credits[i];
        }
        const totalW = completedWeightedSum + pendingWeightedSum;
        const totalC = completedCredits + pendingTotalCredits;
        const gpa = totalC > 0 ? totalW / totalC : 0;
        if (gpa >= userTargetGpa - 0.0001) {
          combinations.push({ grades: [...current], gpa, sum: current.reduce((a, b) => a + b, 0) });
        }
        return;
      }
      for (const g of gradeSteps) {
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
      // For more than 4 courses suggest the equal grade that just meets the target
      const pendingTotalCredits = credits.reduce((a, b) => a + b, 0);
      const totalCredits = completedCredits + pendingTotalCredits;
      const needed = (userTargetGpa * totalCredits - completedWeightedSum) / pendingTotalCredits;
      const valid = gradeSteps.filter(g => g >= needed);
      if (valid.length > 0 && valid[0] <= 5.0) {
        return [Array(n).fill(valid[0])];
      }
      setTimeout(() => {
        let warn = document.getElementById('combination-warning');
        if (!warn) {
          warn = document.createElement('div');
          warn.id = 'combination-warning';
          warn.style.color = '#d48806';
          warn.style.fontSize = '12px';
          warn.style.marginTop = '8px';
          warn.innerText = 'Only equal-grade suggestion is shown for 5+ courses (for performance reasons).';
          if (targetResult && targetResult.parentNode) targetResult.parentNode.appendChild(warn);
        }
      }, 100);
      return [];
    }
  }

  // BUG-2 FIX: use lastTrulyPendingCourses (set in calculateRequiredAverageWithTranscript)
  // so transcript pending courses are labelled correctly in suggestions
  function showCurrentCombination() {
    if (!gradeCombinations.length) return;
    const comb = gradeCombinations[currentCombinationIndex];
    let html = `<b>Possible grade combination:</b><br><ul style="margin:8px 0 0 0;">`;
    for (let i = 0; i < comb.length; ++i) {
      const num = comb[i];
      const letter = numericToLetterGrade(num);
      const name = lastTrulyPendingCourses[i]?.courseName || `Course ${i + 1}`;
      html += `<li>${name}: <b>${num}</b> (${letter})</li>`;
    }
    html += '</ul>';
    html += `<div style="margin-top:6px;font-size:12px;color:#888;">Suggestion ${currentCombinationIndex + 1} of ${gradeCombinations.length}</div>`;
    targetResult.innerHTML = html;
  }

  // Numeric to letter grade conversion (GUC/European scale, lowest value for each letter)
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

  // Load current state from storage
  const storage = await chrome.storage.local.get(['enabled']);
  toggleEnabled.checked = storage.enabled !== false;

  // Toggle extension enabled/disabled
  toggleEnabled.addEventListener('change', async () => {
    const enabled = toggleEnabled.checked;
    await chrome.storage.local.set({ enabled });

    // Send message to active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('apps.guc.edu.eg')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'toggle', enabled });
        showStatus(enabled ? 'Extension enabled!' : 'Extension disabled', 'success');
      } else {
        showStatus('Settings saved. Reload the transcript page to apply.', 'warning');
      }
    } catch (error) {
      showStatus('Settings saved. Reload the transcript page to apply.', 'warning');
    }
  });

  // Reset all predictions
  btnReset.addEventListener('click', async () => {
    // Clear storage
    await chrome.storage.local.set({ predictedGrades: {} });

    // Try to send message to active tab
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url && tab.url.includes('apps.guc.edu.eg')) {
        await chrome.tabs.sendMessage(tab.id, { action: 'reset' });
        showStatus('All predictions cleared!', 'success');
      } else {
        showStatus('Predictions cleared. Refresh transcript to see changes.', 'success');
      }
    } catch (error) {
      showStatus('Predictions cleared from storage.', 'success');
    }
  });

  // Open transcript page
  btnOpenTranscript.addEventListener('click', async () => {
    await chrome.tabs.create({
      url: 'https://apps.guc.edu.eg/student_ext/Grade/Transcript_001.aspx'
    });
    window.close();
  });

  // Show status message
  function showStatus(message, type) {
    statusMessage.textContent = message;
    statusMessage.className = `status-message ${type}`;
    // Auto-hide after 3 seconds
    setTimeout(() => {
      statusMessage.className = 'status-message';
    }, 3000);
  }
});
