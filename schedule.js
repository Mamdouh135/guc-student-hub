/**
 * GUC Student Hub — Schedule Content Script v2
 * Correct orientation: rows=days, cols=periods
 * Supports Saturday, multiple courses per cell
 */
(function () {
  console.log('📅 GUC Student Hub: Schedule script loaded');

  // GUC standard time slots indexed by period (0-based)
  const TIME_SLOTS = [
    { label: '8:15–9:45',   start: '08:15', end: '09:45' },
    { label: '10:00–11:30', start: '10:00', end: '11:30' },
    { label: '11:45–13:15', start: '11:45', end: '13:15' },
    { label: '13:30–15:00', start: '13:30', end: '15:00' },
    { label: '15:15–16:45', start: '15:15', end: '16:45' },
    { label: '17:00–18:30', start: '17:00', end: '18:30' },
  ];

  // Display days (columns): Sat first — GUC week
  const DAYS = ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
  const DAY_SHORT = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu'];

  // JS getDay() → our display column index
  const JS_TO_DISPLAY = { 6: 0, 0: 1, 1: 2, 2: 3, 3: 4, 4: 5 };

  // Day name (lowercase) → display column index
  const DAY_NAME_TO_IDX = {
    saturday: 0, sunday: 1, monday: 2, tuesday: 3, wednesday: 4, thursday: 5
  };

  // Period keyword → slot index
  const PERIOD_WORDS = ['first','second','third','fourth','fifth','sixth'];

  // ICS RRULE day codes (display index → BYDAY)
  const DISPLAY_TO_BYDAY = ['SA','SU','MO','TU','WE','TH'];

  const COURSE_COLORS = [
    ['#1565c0','#1976d2'], ['#6a1b9a','#8e24aa'], ['#00695c','#00897b'],
    ['#c62828','#e53935'], ['#e65100','#f57c00'], ['#37474f','#546e7a'],
    ['#1b5e20','#2e7d32'], ['#880e4f','#ad1457'], ['#004d40','#00695c'],
    ['#3e2723','#5d4037'], ['#1a237e','#283593'], ['#b71c1c','#c62828'],
  ];

  let isDarkMode = false;
  let scheduleSlots = [];
  let customSlots   = [];   // user-added entries, persisted
  let editMode      = false;
  const CUSTOM_KEY  = 'gucScheduleCustom';

  // ─── Init ────────────────────────────────────────────────────────────────
  async function init() {
    const href = window.location.href.toLowerCase();
    if (!href.includes('groupschedule') && !href.includes('scheduling')) return;

    try {
      const s = await chrome.storage.local.get(['darkMode', CUSTOM_KEY]);
      isDarkMode  = s.darkMode || false;
      customSlots = s[CUSTOM_KEY] || [];
    } catch (e) {}

    scheduleSlots = scrapeSchedule();
    createDashboard();
    if (isDarkMode) document.body.classList.add('guc-dark-mode');
    console.log(`📅 GUC Schedule: scraped ${scheduleSlots.length} + ${customSlots.length} custom slot(s)`);
  }

  // ─── Scraper ─────────────────────────────────────────────────────────────
  // Confirmed GUC GroupSchedule.aspx structure:
  //   - Outer table rows = days (Saturday → Thursday)
  //   - Outer table cols = periods (First Period … Sixth Period)
  //   - Free day: one colspan td with text "Free"
  //   - Course cell: contains a nested <table> where each <tr> = one course entry
  //     Each course <tr> has 3 <td>: [0]=group, [1]=room, [2]=course+type
  //     col[2] may have a title attribute with the full course name
  function scrapeSchedule() {
    const slots = [];
    const table = findScheduleTable();
    if (!table) { console.log('📅 GUC Schedule: table not found'); return slots; }

    // Get only direct child rows (avoid grabbing nested table rows)
    const tbody = table.querySelector(':scope > tbody') || table;
    const rows = Array.from(tbody.querySelectorAll(':scope > tr'));
    if (rows.length < 2) return slots;

    // ── Build column → period slot index from header row ──
    const headerCells = Array.from(rows[0].querySelectorAll(':scope > th, :scope > td'));
    const colToSlot = {};
    headerCells.forEach((cell, ci) => {
      const t = cell.textContent.trim().toLowerCase();
      PERIOD_WORDS.forEach((word, pi) => { if (t.includes(word)) colToSlot[ci] = pi; });
    });
    if (Object.keys(colToSlot).length === 0) {
      headerCells.slice(1).forEach((_, i) => { colToSlot[i + 1] = i; });
    }

    // ── Read day rows ──
    rows.slice(1).forEach(row => {
      const cells = Array.from(row.querySelectorAll(':scope > td, :scope > th'));
      if (cells.length === 0) return;

      // Identify the day from the first cell
      const dayText = cells[0].textContent.trim().toLowerCase();
      let dayIdx = -1;
      for (const [name, idx] of Object.entries(DAY_NAME_TO_IDX)) {
        if (dayText.includes(name)) { dayIdx = idx; break; }
      }
      if (dayIdx === -1) return;

      // cells.length === 2 and second cell says "Free" → whole day is free
      if (cells.length === 2 && /^free$/i.test(cells[1].textContent.trim())) return;

      // ── Read each period cell ──
      cells.slice(1).forEach((periodCell, offset) => {
        const ci = offset + 1;
        const slotIdx = colToSlot[ci];
        if (slotIdx === undefined) return;

        const cellText = periodCell.textContent.trim();
        if (!cellText || /^free$/i.test(cellText)) return;

        const timeInfo = TIME_SLOTS[slotIdx] || { label: `P${slotIdx+1}`, start:'08:00', end:'09:30' };
        const courses = parseCoursesFromCell(periodCell);

        courses.forEach(course => {
          slots.push({
            dayIndex: dayIdx,
            slotIndex: slotIdx,
            timeLabel: timeInfo.label,
            start: timeInfo.start,
            end: timeInfo.end,
            ...course,
          });
        });
      });
    });

    return slots;
  }

  // Find schedule table — exact known ID first, then fallbacks
  function findScheduleTable() {
    // Exact ID confirmed from GUC GroupSchedule.aspx
    const exact = document.getElementById('ContentPlaceHolderright_ContentPlaceHoldercontent_scdTbl');
    if (exact) return exact;

    const ids = ['scdTbl','ScheduleTable','tblSchedule','tblGroupSchedule',
                 'GridView1','gvSchedule','ContentPlaceHolder1_scdTbl'];
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el && el.tagName === 'TABLE') return el;
    }
    // Table whose first COLUMN has day names
    for (const t of document.querySelectorAll('table')) {
      const firstCells = Array.from(t.querySelectorAll('tr'))
        .map(r => r.querySelector('td,th')?.textContent?.trim().toLowerCase() || '');
      if (DAYS.some(d => firstCells.some(c => c.includes(d.toLowerCase())))) return t;
    }
    return null;
  }

  // Parse all course entries from one period cell.
  // Each cell contains a nested <table>; each <tr> in that table = one course entry.
  // Course entry columns: [0]=group, [1]=room, [2]=course+type (title attr = full name)
  function parseCoursesFromCell(cell) {
    const courses = [];
    const rawText = cell.textContent.trim();
    if (!rawText || /^free$/i.test(rawText)) return courses;

    // Strategy 1: find nested tables and iterate their direct rows
    const nestedTables = cell.querySelectorAll(':scope > table, :scope > * > table');
    if (nestedTables.length > 0) {
      nestedTables.forEach(nt => {
        const ntBody = nt.querySelector(':scope > tbody') || nt;
        const ntRows = Array.from(ntBody.querySelectorAll(':scope > tr'));
        ntRows.forEach(nRow => {
          const tds = Array.from(nRow.querySelectorAll(':scope > td, :scope > th'));
          if (tds.length < 1) return;

          let group = '', location = '', courseName = '', type = '';
          if (tds.length >= 3) {
            group    = tds[0].textContent.trim();
            location = tds[1].textContent.trim();
            // col[2]: use title attribute for full name if available
            const fullTitle = tds[2].getAttribute('title')?.trim() || '';
            const col2text  = tds[2].textContent.replace(/\s+/g,' ').trim();
            const parsed    = splitCourseAndType(col2text);
            courseName = fullTitle || parsed.name;
            type       = parsed.type;
          } else if (tds.length === 2) {
            location = tds[0].textContent.trim();
            const parsed = splitCourseAndType(tds[1].textContent.trim());
            courseName = parsed.name; type = parsed.type;
          } else {
            const parsed = splitCourseAndType(tds[0].textContent.trim());
            courseName = parsed.name; type = parsed.type;
          }

          if (courseName) courses.push({ courseName, location, type, group });
        });
      });
      if (courses.length > 0) return courses;
    }

    // Strategy 2: direct child tds (flat layout)
    const directTds = Array.from(cell.querySelectorAll(':scope > td, :scope > th'));
    if (directTds.length >= 3) {
      const group    = directTds[0].textContent.trim();
      const location = directTds[1].textContent.trim();
      const fullTitle = directTds[2].getAttribute('title')?.trim() || '';
      const parsed   = splitCourseAndType(directTds[2].textContent.replace(/\s+/g,' ').trim());
      const courseName = fullTitle || parsed.name;
      if (courseName) { courses.push({ courseName, location, type: parsed.type, group }); return courses; }
    }

    // Strategy 3: <br>-split text lines (3-column pattern)
    const lines = cell.innerHTML
      .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .split('\n').map(s => s.trim()).filter(Boolean);
    if (lines.length >= 3) {
      const parsed = splitCourseAndType(lines[2]);
      if (parsed.name) { courses.push({ courseName: parsed.name, location: lines[1], type: parsed.type, group: lines[0] }); return courses; }
    }

    // Strategy 4: whole cell text
    const p = splitCourseAndType(rawText);
    if (p.name) courses.push({ courseName: p.name, location: '', type: p.type, group: '' });
    return courses;
  }

  // Split "COMM 401 Lab" → { name: "COMM 401", type: "Lab" }
  // The type keyword is always the last word if it matches Lab/Lec/Tut/Lecture/Tutorial
  function splitCourseAndType(text) {
    if (!text) return { name: '', type: '' };
    const clean = text.replace(/\s+/g, ' ').trim();
    const typeRe = /\b(lab|lecture|lec|tutorial|tut|seminar|sem)\s*$/i;
    const typeMatch = clean.match(typeRe);
    const type = typeMatch ? normalizeType(typeMatch[1]) : '';
    const name = clean.replace(typeRe, '').trim();
    return { name: name || clean, type };
  }

  function normalizeType(t) {
    const l = t.toLowerCase();
    if (l.startsWith('lec')) return 'Lec';
    if (l.startsWith('tut')) return 'Tut';
    if (l.startsWith('lab')) return 'Lab';
    if (l.startsWith('sem')) return 'Sem';
    return t;
  }

  function cleanCourseName(name) {
    return name.replace(/\b(lecture|tutorial|lab|seminar)\b/gi, '').replace(/[-–|]+/g,'').trim();
  }

  // ─── Dashboard ───────────────────────────────────────────────────────────
  function createDashboard() {
    const existing = document.getElementById('guc-sched-dashboard');
    if (existing) existing.remove();

    const dashboard = document.createElement('div');
    dashboard.id = 'guc-sched-dashboard';
    dashboard.className = 'guc-sched-dashboard';

    const semStart = getNearestSaturday();
    const semEnd = new Date(semStart);
    semEnd.setDate(semEnd.getDate() + 16 * 7);

    dashboard.innerHTML = `
      <div class="guc-sched-header" id="guc-sched-header">
        <div class="guc-sched-title">📅 Weekly Timetable</div>
        <div class="guc-sched-controls">
          <button id="guc-sched-edit" class="guc-sched-btn" title="Toggle edit mode">✏️ Edit</button>
          <button id="guc-sched-dark" class="guc-sched-btn guc-sched-btn-icon" title="Toggle dark mode">${isDarkMode ? '☀️' : '🌙'}</button>
          <button id="guc-sched-minimize" class="guc-sched-btn guc-sched-btn-icon" title="Minimize">➖</button>
        </div>
      </div>
      <div id="guc-sched-collapsible">
        <div class="guc-sched-export-bar">
          <label>📋 Export: </label>
          <label>Start</label>
          <input type="date" id="guc-sem-start" value="${fmtDate(semStart)}">
          <label>End</label>
          <input type="date" id="guc-sem-end" value="${fmtDate(semEnd)}">
          <button id="guc-export-ics" class="guc-sched-btn">⬇️ Download .ics</button>
          <button id="guc-ics-help" class="guc-sched-btn guc-help-btn" title="How to import">?</button>
        </div>
        <div id="guc-ics-help-box" class="guc-ics-help-box" style="display:none;">
          <b>📌 How to import your schedule:</b>
          <ul>
            <li>🔵 <b>Google Calendar:</b> Open <a href="https://calendar.google.com/calendar/r/settings/import" target="_blank">Google Calendar → Settings → Import</a>, then select the downloaded <code>.ics</code> file.</li>
            <li>🟠 <b>Outlook:</b> Open Outlook → File → Open &amp; Export → Import/Export → Import an iCalendar file.</li>
            <li>🍏 <b>Apple Calendar:</b> Double-click the <code>.ics</code> file — it opens and imports automatically.</li>
          </ul>
        </div>
        <div class="guc-sched-body">
          <div id="guc-timetable-container"></div>
        </div>
      </div>`;

    document.body.appendChild(dashboard);

    if (!document.getElementById('guc-sched-tooltip')) {
      const tt = document.createElement('div');
      tt.id = 'guc-sched-tooltip';
      tt.className = 'guc-sched-tooltip';
      document.body.appendChild(tt);
    }

    renderTimetable();

    document.getElementById('guc-sched-edit').addEventListener('click', toggleEditMode);
    document.getElementById('guc-sched-dark').addEventListener('click', toggleDarkMode);
    document.getElementById('guc-sched-minimize').addEventListener('click', toggleMinimize);
    document.getElementById('guc-export-ics').addEventListener('click', () => {
      const all = [...scheduleSlots, ...customSlots];
      exportToICS(all,
        document.getElementById('guc-sem-start').value,
        document.getElementById('guc-sem-end').value);
    });
    document.getElementById('guc-ics-help').addEventListener('click', () => {
      const box = document.getElementById('guc-ics-help-box');
      if (box) box.style.display = box.style.display === 'none' ? 'block' : 'none';
    });
    makeDraggable(dashboard, document.getElementById('guc-sched-header'));
  }

  // ─── Edit Mode ───────────────────────────────────────────────────────────
  function toggleEditMode() {
    editMode = !editMode;
    const btn = document.getElementById('guc-sched-edit');
    if (btn) {
      btn.textContent = editMode ? '✅ Done' : '✏️ Edit';
      btn.classList.toggle('guc-edit-active', editMode);
    }
    renderTimetable();
  }

  async function saveCustomSlots() {
    try { await chrome.storage.local.set({ [CUSTOM_KEY]: customSlots }); } catch(e) {}
  }

  // Show add/edit modal
  function showCourseForm(dayIdx, slotIdx, existingSlot = null) {
    document.getElementById('guc-course-modal')?.remove();
    const timeLabel = TIME_SLOTS[slotIdx]?.label || `Slot ${slotIdx+1}`;
    const dayName   = DAYS[dayIdx] || '';
    const isEdit    = !!existingSlot;

    const modal = document.createElement('div');
    modal.id = 'guc-course-modal';
    modal.className = 'guc-modal-overlay';
    modal.innerHTML = `
      <div class="guc-modal">
        <div class="guc-modal-header">
          <span>${isEdit ? '✏️ Edit Entry' : '➕ Add Entry'} — ${dayName} ${timeLabel}</span>
          <button class="guc-modal-close" id="guc-modal-close">✕</button>
        </div>
        <div class="guc-modal-body">
          <label>Course Name *</label>
          <input id="guc-f-name" type="text" placeholder="e.g. CSEN 401" value="${escHtml(existingSlot?.courseName||'')}">
          <label>Room / Location</label>
          <input id="guc-f-loc" type="text" placeholder="e.g. H14, C7.301" value="${escHtml(existingSlot?.location||'')}">
          <label>Type</label>
          <select id="guc-f-type">
            ${['','Lec','Tut','Lab','Sem','Other'].map(t =>
              `<option value="${t}" ${(existingSlot?.type||'')=== t?'selected':''}>${t||'—'}</option>`
            ).join('')}
          </select>
          <label>Group / Section</label>
          <input id="guc-f-group" type="text" placeholder="e.g. 4MET P017" value="${escHtml(existingSlot?.group||'')}">
        </div>
        <div class="guc-modal-footer">
          ${isEdit ? '<button class="guc-modal-btn guc-modal-btn-danger" id="guc-modal-delete">🗑️ Delete</button>' : ''}
          <button class="guc-modal-btn" id="guc-modal-cancel">Cancel</button>
          <button class="guc-modal-btn guc-modal-btn-primary" id="guc-modal-save">💾 Save</button>
        </div>
      </div>`;

    document.body.appendChild(modal);

    document.getElementById('guc-modal-close').onclick  = () => modal.remove();
    document.getElementById('guc-modal-cancel').onclick = () => modal.remove();
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

    if (isEdit) {
      document.getElementById('guc-modal-delete').onclick = () => {
        customSlots = customSlots.filter(s => s.id !== existingSlot.id);
        saveCustomSlots();
        modal.remove();
        renderTimetable();
      };
    }

    document.getElementById('guc-modal-save').onclick = () => {
      const name = document.getElementById('guc-f-name').value.trim();
      if (!name) { document.getElementById('guc-f-name').focus(); return; }
      const entry = {
        id:         existingSlot?.id || `c-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        dayIndex:   dayIdx,
        slotIndex:  slotIdx,
        timeLabel:  timeLabel,
        start:      TIME_SLOTS[slotIdx]?.start || '08:00',
        end:        TIME_SLOTS[slotIdx]?.end   || '09:30',
        courseName: name,
        location:   document.getElementById('guc-f-loc').value.trim(),
        type:       document.getElementById('guc-f-type').value,
        group:      document.getElementById('guc-f-group').value.trim(),
        isCustom:   true,
      };
      if (isEdit) {
        const idx = customSlots.findIndex(s => s.id === existingSlot.id);
        if (idx !== -1) customSlots[idx] = entry; else customSlots.push(entry);
      } else {
        customSlots.push(entry);
      }
      saveCustomSlots();
      modal.remove();
      renderTimetable();
    };

    setTimeout(() => document.getElementById('guc-f-name')?.focus(), 50);
  }

  // ─── Renderer ────────────────────────────────────────────────────────────
  function renderTimetable() {
    const container = document.getElementById('guc-timetable-container');
    if (!container) return;

    // Merge scraped + custom slots
    const allSlots = [...scheduleSlots, ...customSlots];

    if (!allSlots.length && !editMode) {
      container.innerHTML = `<div class="guc-sched-empty"><span>🗓️</span>No schedule data found.<br><small>Make sure you are on the GroupSchedule page and the table has loaded.</small></div>`;
      return;
    }

    const grid = {};
    const maxSlot = Math.max(...(allSlots.length ? allSlots.map(s => s.slotIndex) : [0]), TIME_SLOTS.length - 1);
    allSlots.forEach(s => {
      if (!grid[s.slotIndex]) grid[s.slotIndex] = {};
      if (!grid[s.slotIndex][s.dayIndex]) grid[s.slotIndex][s.dayIndex] = [];
      grid[s.slotIndex][s.dayIndex].push(s);
    });

    const colorMap = buildColorMap(allSlots);
    const todayDisplay = JS_TO_DISPLAY[new Date().getDay()] ?? -1;

    let html = `<table class="guc-timetable${editMode?' guc-edit-mode':''}"><thead><tr><th style="width:62px;"></th>`;
    DAYS.forEach((_, i) => {
      html += `<th class="${i === todayDisplay ? 'guc-today' : ''}">${DAY_SHORT[i]}</th>`;
    });
    html += `</tr></thead><tbody>`;

    for (let si = 0; si <= maxSlot; si++) {
      const ti = TIME_SLOTS[si] || { label: `P${si + 1}` };
      html += `<tr><td class="guc-time-cell">${ti.label}</td>`;

      DAYS.forEach((_, di) => {
        const isToday   = di === todayDisplay;
        const cellSlots = grid[si]?.[di] || [];
        html += `<td class="guc-slot-cell${isToday?' guc-today-col':''}" data-si="${si}" data-di="${di}">`;
        if (cellSlots.length) {
          html += `<div class="guc-multi-cell">`;
          cellSlots.forEach(slot => {
            const [bg, accent] = colorMap[slot.courseName] || ['#004a99','#1976d2'];
            const customBg = slot.isCustom ? 'linear-gradient(135deg,#5c35a0,#8b5cf6)' : `linear-gradient(135deg,${bg},${accent})`;
            html += `<div class="guc-course-block${slot.isCustom?' guc-custom-block':''}"
              style="background:${customBg};color:white;"
              data-course="${escHtml(slot.courseName)}"
              data-location="${escHtml(slot.location)}"
              data-type="${escHtml(slot.type)}"
              data-group="${escHtml(slot.group||'')}"
              data-time="${escHtml(slot.timeLabel)}"
              data-id="${escHtml(slot.id||'')}">
              <span class="guc-course-name">${escHtml(slot.courseName)}</span>
              ${slot.isCustom?'<span class="guc-custom-badge">&#9733; Custom</span>':''}
              <div class="guc-course-meta">
                <span class="guc-course-location">${escHtml(slot.location||'—')}</span>
                ${slot.type?`<span class="guc-course-type">${escHtml(slot.type)}</span>`:''}
              </div>

              ${editMode?`<div class="guc-edit-actions">${slot.isCustom?`<button class="guc-ea-btn" data-action="edit" data-id="${escHtml(slot.id)}">✏️</button>`:'<span class="guc-ea-locked">🔒</span>'}<button class="guc-ea-btn guc-ea-del" data-action="delete" data-id="${escHtml(slot.id||'')}" data-custom="${slot.isCustom?'1':'0'}">🗑️</button></div>`:''}
            </div>`;
          });
          html += `</div>`;
        } else if (editMode) {
          html += `<div class="guc-slot-empty guc-slot-addable"></div>`;
        } else {
          html += `<div class="guc-slot-empty"></div>`;
        }
        html += `</td>`;
      });
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;

    // ── Tooltip (non-edit mode) ──
    const tooltip = document.getElementById('guc-sched-tooltip');
    if (!editMode) {
      container.querySelectorAll('.guc-course-block').forEach(block => {
        block.addEventListener('mouseenter', () => {
          tooltip.style.display = 'block';
          tooltip.innerHTML = [
            `<b>${escHtml(block.dataset.course)}</b>`,
            block.dataset.group ? `👥 ${escHtml(block.dataset.group)}` : '',
            `📍 ${escHtml(block.dataset.location||'N/A')}`,
            `🕐 ${escHtml(block.dataset.time)}`,
            block.dataset.type ? `📌 ${escHtml(block.dataset.type)}` : ''
          ].filter(Boolean).join('<br>');
        });
        block.addEventListener('mousemove', e => {
          tooltip.style.left = (e.clientX+14)+'px';
          tooltip.style.top  = (e.clientY-60)+'px';
        });
        block.addEventListener('mouseleave', () => { tooltip.style.display='none'; });
      });
    }

    // ── Edit mode interactions ──
    if (editMode) {
      tooltip.style.display = 'none';

      // Add button on empty cells
      container.querySelectorAll('.guc-slot-addable').forEach(empty => {
        empty.innerHTML = '<button class="guc-add-slot-btn">➕</button>';
        empty.querySelector('button').addEventListener('click', () => {
          const td = empty.closest('td');
          showCourseForm(+td.dataset.di, +td.dataset.si);
        });
      });

      // Edit action buttons
      container.querySelectorAll('[data-action="edit"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const id   = btn.dataset.id;
          const slot = customSlots.find(s => s.id === id);
          if (slot) showCourseForm(slot.dayIndex, slot.slotIndex, slot);
        });
      });

      // Delete action buttons
      container.querySelectorAll('[data-action="delete"]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const isCustom = btn.dataset.custom === '1';
          const id = btn.dataset.id;
          if (!isCustom) { alert('Scraped entries cannot be deleted. Only custom entries can be removed.'); return; }
          if (!confirm('Delete this entry?')) return;
          customSlots = customSlots.filter(s => s.id !== id);
          saveCustomSlots();
          renderTimetable();
        });
      });
    }
  }

  function buildColorMap(slots) {
    const map = {};
    [...new Set(slots.map(s => s.courseName))].forEach((name, i) => {
      map[name] = COURSE_COLORS[i % COURSE_COLORS.length];
    });
    return map;
  }

  // ─── ICS Export ──────────────────────────────────────────────────────────
  function exportToICS(slots, startStr, endStr) {
    if (!slots.length) { alert('No schedule data to export.'); return; }
    const semStart = new Date(startStr), semEnd = new Date(endStr);
    if (isNaN(semStart) || isNaN(semEnd) || semEnd <= semStart) {
      alert('Invalid date range.'); return;
    }

    const lines = [
      'BEGIN:VCALENDAR','VERSION:2.0',
      'PRODID:-//GUC Student Hub//Schedule Export//EN',
      'CALSCALE:GREGORIAN','METHOD:PUBLISH',
      'X-WR-CALNAME:GUC Schedule','X-WR-TIMEZONE:Africa/Cairo',
      'BEGIN:VTIMEZONE','TZID:Africa/Cairo',
      'BEGIN:STANDARD','DTSTART:19700101T000000',
      'TZOFFSETFROM:+0200','TZOFFSETTO:+0200','TZNAME:EET',
      'END:STANDARD','END:VTIMEZONE',
    ];

    // Expand recurring events into individual VEVENTs per week.
    // This avoids RRULE which is unsupported in Windows Calendar and some other apps.
    slots.forEach(slot => {
      const jsDay    = [6,0,1,2,3,4][slot.dayIndex];
      const [sh, sm] = slot.start.split(':').map(Number);
      const [eh, em] = slot.end.split(':').map(Number);
      const baseUid  = `guc-${slot.dayIndex}-${slot.slotIndex}-${sanitize(slot.courseName)}@hub`;
      const summary  = icsEsc(slot.courseName + (slot.type ? ` (${slot.type})` : ''));
      const location = icsEsc(slot.location || '');
      const description = icsEsc([
        slot.type     && `Type: ${slot.type}`,
        slot.location && `Room: ${slot.location}`
      ].filter(Boolean).join('\\n'));

      // Walk week by week from first occurrence until semEnd
      let occurrence = firstOccurrence(semStart, jsDay);
      let weekIndex  = 0;
      while (occurrence && occurrence <= semEnd) {
        lines.push(
          'BEGIN:VEVENT',
          `UID:${baseUid}-w${weekIndex}`,
          `DTSTART;TZID=Africa/Cairo:${fmtICSDateTime(occurrence, sh, sm)}`,
          `DTEND;TZID=Africa/Cairo:${fmtICSDateTime(occurrence, eh, em)}`,
          `SUMMARY:${summary}`,
          `LOCATION:${location}`,
          `DESCRIPTION:${description}`,
          'STATUS:CONFIRMED',
          'END:VEVENT'
        );
        occurrence = new Date(occurrence);
        occurrence.setDate(occurrence.getDate() + 7);
        weekIndex++;
      }
    });

    lines.push('END:VCALENDAR');
    const blob = new Blob([lines.join('\r\n')], { type:'text/calendar;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = Object.assign(document.createElement('a'), { href: url, download: 'GUC_Schedule.ics' });
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  function toggleDarkMode() {
    isDarkMode = !isDarkMode;
    document.body.classList.toggle('guc-dark-mode', isDarkMode);
    const btn = document.getElementById('guc-sched-dark');
    if (btn) btn.textContent = isDarkMode ? '☀️' : '🌙';
    try { chrome.storage.local.set({ darkMode: isDarkMode }); } catch(e) {}
  }

  function toggleMinimize() {
    const body = document.getElementById('guc-sched-collapsible');
    const btn  = document.getElementById('guc-sched-minimize');
    if (!body) return;
    const hidden = body.classList.toggle('guc-sched-hidden');
    if (btn) btn.textContent = hidden ? '➕' : '➖';
  }

  function makeDraggable(el, handle) {
    let drag = false, sx, sy, sl, st;
    handle.addEventListener('mousedown', e => {
      if (e.target.tagName === 'BUTTON') return;
      drag = true; sx = e.clientX; sy = e.clientY;
      const r = el.getBoundingClientRect(); sl = r.left; st = r.top;
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      el.style.left = (sl + e.clientX - sx) + 'px';
      el.style.top  = (st + e.clientY - sy) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  function getNearestSaturday() {
    const d = new Date();
    const diff = (6 - d.getDay() + 7) % 7;
    d.setDate(d.getDate() - (diff === 0 ? 0 : 7 - diff));
    return d;
  }

  function firstOccurrence(base, targetJSDay) {
    const d = new Date(base);
    const diff = (targetJSDay - d.getDay() + 7) % 7;
    d.setDate(d.getDate() + diff);
    return d;
  }

  function fmtDate(d) { return d.toISOString().slice(0,10); }
  function fmtICSDate(d) { return d.toISOString().replace(/[-:]/g,'').slice(0,15)+'Z'; }
  function fmtICSDateTime(d, h, m) {
    return `${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}T${p2(h)}${p2(m)}00`;
  }
  function p2(n) { return String(n).padStart(2,'0'); }
  function icsEsc(s) { return (s||'').replace(/[\\;,]/g,c=>'\\'+c).replace(/\n/g,'\\n'); }
  function sanitize(s) { return (s||'').replace(/[^a-z0-9]/gi,'-').toLowerCase().slice(0,30); }
  function escHtml(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  // ─── Bootstrap ───────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    setTimeout(init, 800);
  }
})();
