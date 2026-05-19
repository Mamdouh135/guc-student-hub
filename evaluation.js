(function() {
  console.log('🎓 GUC Student Tools: Evaluation script loaded');

  let observer = null;

  function init() {
    const radios = document.querySelectorAll('input[type="radio"]');
    if (radios.length === 0) {
      console.log('🎓 No evaluation radio buttons found yet. Watching for dynamic content...');
      // BUG-7 FIX: use MutationObserver instead of one-shot setTimeout
      // so we correctly detect radio buttons added by ASP.NET postbacks at any time
      watchForRadios();
      return;
    }
    createDashboard();
  }

  // BUG-7 FIX: Watch the DOM for radio buttons being added dynamically
  function watchForRadios() {
    if (observer) return; // already watching
    observer = new MutationObserver(() => {
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios.length > 0 && !document.querySelector('.guc-eval-dashboard')) {
        observer.disconnect();
        observer = null;
        console.log('🎓 Radio buttons detected via MutationObserver. Injecting panel.');
        createDashboard();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Safety fallback: stop watching after 30 seconds to avoid memory leaks
    setTimeout(() => {
      if (observer) {
        observer.disconnect();
        observer = null;
        console.log('🎓 MutationObserver timed out after 30s without finding radio buttons.');
      }
    }, 30000);
  }

  function createDashboard() {
    if (document.querySelector('.guc-eval-dashboard')) return; // prevent duplicates

    const dashboard = document.createElement('div');
    dashboard.className = 'guc-eval-dashboard';

    dashboard.innerHTML = `
      <div class="guc-eval-header">
        <span>⚡ Quick Staff Evaluation</span>
      </div>
      <div class="guc-eval-content">
        <button class="guc-eval-btn" id="guc-eval-excellent">⭐️ Rate All Excellent</button>
        <button class="guc-eval-btn" id="guc-eval-vgood">👍 Rate All Very Good</button>
        <button class="guc-eval-btn" id="guc-eval-good">👌 Rate All Good</button>
        <button class="guc-eval-btn guc-eval-btn-secondary" id="guc-eval-random">🎲 Rate Randomly (Positive)</button>
        <button class="guc-eval-btn guc-eval-btn-danger" id="guc-eval-random-negative">🎲 Rate Randomly (Negative)</button>
      </div>
    `;

    document.body.appendChild(dashboard);

    document.getElementById('guc-eval-excellent').addEventListener('click', () => rateAll(0));
    document.getElementById('guc-eval-vgood').addEventListener('click', () => rateAll(1));
    document.getElementById('guc-eval-good').addEventListener('click', () => rateAll(2));
    // Randomize between top 3 choices (Excellent, Very Good, Good)
    document.getElementById('guc-eval-random').addEventListener('click', () => rateRandomly([0, 1, 2]));
    // Randomize between bottom 2 choices (e.g. Satisfactory, Poor)
    document.getElementById('guc-eval-random-negative').addEventListener('click', () => rateRandomly([-2, -1]));
  }

  // Groups radio buttons by their "name" attribute (which groups options for a single question)
  function getRadioGroups() {
    const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
    const groups = {};
    radios.forEach(r => {
      // Ignore hidden or disabled radios
      if (r.disabled || r.style.display === 'none') return;
      if (!groups[r.name]) groups[r.name] = [];
      groups[r.name].push(r);
    });
    return groups;
  }

  // Rates all questions by selecting the nth radio button in each group
  function rateAll(index) {
    const groups = getRadioGroups();
    let count = 0;
    Object.values(groups).forEach(group => {
      if (group.length > index) {
        group[index].checked = true;
        // Dispatch change and click events to ensure GUC validation scripts detect it
        group[index].dispatchEvent(new Event('change', { bubbles: true }));
        group[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        count++;
      }
    });
    console.log(`🎓 Rated ${count} questions.`);
  }

  // Randomly picks a rating from the allowed indices for each question
  // Supports negative indices (e.g. -1 for last)
  function rateRandomly(indices) {
    const groups = getRadioGroups();
    let count = 0;
    Object.values(groups).forEach(group => {
      const validIndices = indices
        .map(i => i < 0 ? group.length + i : i)
        .filter(i => i >= 0 && i < group.length);
      if (validIndices.length > 0) {
        const randomIndex = validIndices[Math.floor(Math.random() * validIndices.length)];
        group[randomIndex].checked = true;
        group[randomIndex].dispatchEvent(new Event('change', { bubbles: true }));
        group[randomIndex].dispatchEvent(new MouseEvent('click', { bubbles: true }));
        count++;
      }
    });
    console.log(`🎓 Randomly rated ${count} questions.`);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
