# GUC Student Hub

A Chrome Extension (Manifest V3) for the German University in Cairo (GUC) Student Portal.

## Features

### 📊 Real-time GPA Calculation
- Automatically calculates your current GPA from completed courses
- Uses the European grading scale (0.7 = best, 5.0 = fail)
- Weighted calculation: (Grade × Credit Hours) / Total Credit Hours

### 🎯 Grade Predictor
- Detects pending/empty grades in your transcript
- Inject predicted grades into pending courses
- Instantly see how predicted grades affect your overall GPA

### 🏆 Goal Finder
- Set a target GPA (e.g., 1.7)
- Calculate the average grade needed in pending courses to reach your goal
- Get feedback on whether the goal is achievable

### 📅 Weekly Schedule & Calendar Export
- View your weekly schedule directly on the portal
- Export your schedule to calendar applications

### 📝 Auto-fill Staff Evaluations
- Automatically fill staff evaluations to save time

### 🌙 Dark Mode
- Toggle between light and dark themes
- GUC-inspired color scheme (Dark Blue & Gold)

### 📱 Floating Dashboard
- Draggable, minimizable interface
- Non-intrusive design that doesn't break the portal layout
- Statistics overview (completed courses, pending courses, total credits)

## Installation

### Step 1: Generate Icons
1. Open `icons/generate-icons.html` in Chrome
2. Click "Download All Icons"
3. Save the three PNG files (`icon16.png`, `icon48.png`, `icon128.png`) to the `icons` folder

### Step 2: Load the Extension
1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle in the top-right corner)
3. Click **Load unpacked**
4. Select the `guc` folder (the folder containing `manifest.json`)
5. The extension should now appear in your extensions list

### Step 3: Use the Extension
1. Navigate to the supported GUC portal pages:
   - Transcript: `https://apps.guc.edu.eg/student_ext/Grade/Transcript_001.aspx`
   - Evaluations: `https://apps.guc.edu.eg/student_ext/Evaluation/EvaluateStaff.aspx`
   - Schedule: `https://apps.guc.edu.eg/student_ext/Scheduling/GroupSchedule.aspx`
2. The floating dashboard will appear at the bottom-right on supported pages.
3. Enjoy the features!

## File Structure

```
guc/
├── manifest.json      # Extension configuration
├── content.js         # Core logic (scraping, calculations, UI)
├── style.css          # GUC-themed styles
├── popup.html         # Settings popup UI
├── popup.js           # Popup functionality
├── schedule.js        # Schedule feature functionality
├── schedule.css       # Schedule styling
├── evaluation.js      # Evaluation auto-fill logic
├── evaluation.css     # Evaluation styling
├── icons/
│   ├── generate-icons.html  # Icon generator tool
│   ├── icon16.png     # 16x16 icon (generate this)
│   ├── icon48.png     # 48x48 icon (generate this)
│   └── icon128.png    # 128x128 icon (generate this)
└── README.md          # This file
```

## GUC Grading Scale Reference

| Grade Range | Classification        |
| ----------- | --------------------- |
| 0.7 - 1.0   | Excellent (A+/A)      |
| 1.0 - 1.7   | Very Good (A-/B+)     |
| 1.7 - 2.7   | Good (B/B-/C+)        |
| 2.7 - 4.0   | Satisfactory (C/C-/D) |
| > 4.0       | Fail (F)              |

## Troubleshooting

### Extension not appearing
- Make sure you're on the correct URL (Transcript, Evaluation, or Schedule)
- Check that the extension is enabled in `chrome://extensions/`
- Try refreshing the page

### Icons not showing
- Make sure you've generated and saved the PNG icons to the `icons` folder
- Reload the extension in `chrome://extensions/`

### Dashboard not appearing
- Open the extension popup and ensure "Extension Enabled" is turned on
- Check the browser console for any errors (F12 → Console)

## Privacy

This extension:
- ✅ Runs only on the GUC portal pages
- ✅ Stores settings and predicted grades locally in Chrome storage
- ✅ Does NOT send any data to external servers
- ✅ Does NOT modify your actual grades (predictions are visual only)

## License

MIT License - Feel free to modify and share!

---

**Made with ❤️ for GUC Students**
