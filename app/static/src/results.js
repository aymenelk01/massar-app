/* ============================================================
   results.js — Massar Portal Results Page Logic
   GET /results with Bearer Token → Render Student Details & Grades
   ============================================================ */

// API base URL — replace with your actual CloudFront 
const API_BASE_URL = "/api";

// DOM references
const loadingState = document.getElementById("loading-state");
const resultsState = document.getElementById("results-state");
const errorState   = document.getElementById("error-state");
const errorMsgText = document.getElementById("error-msg-text");

const studentName  = document.getElementById("student-name");
const studentCode  = document.getElementById("student-code");
const studentBranch = document.getElementById("student-branch");
const studentLevel = document.getElementById("student-level");
const resultBadge  = document.getElementById("result-badge");
const resultLabel  = document.getElementById("result-label");
const averageRegional = document.getElementById("average-regional");
const averageCc       = document.getElementById("average-cc");
const averageNational = document.getElementById("average-national");
const averageNationalCard = document.getElementById("average-national-card");
const averageOverall  = document.getElementById("average-overall");
const averageMention   = document.getElementById("average-mention");
const resultsTablesContainer = document.getElementById("results-tables-container");
const logoutBtn    = document.getElementById("logout-btn");
const downloadDiplomaBtn = document.getElementById("download-diploma-btn");
const diplomaStatusText  = document.getElementById("diploma-status-text");

// ── Auth Guard: check token presence ──────────────────────────
const token = sessionStorage.getItem("access_token");
if (!token) {
  sessionStorage.clear();
  window.location.replace("login.html");
}

// ── Helper: Clear sessions and route to login ────────────────
function handleSessionExpiry() {
  sessionStorage.clear();
  window.location.replace("login.html");
}

// ── Helper: Calculate Grade Status ───────────────────────────
/**
 * Determines grade status description.
 * @param {number} grade
 * @returns {{text: string, className: string}}
 */
function getGradeStatus(grade) {
  if (grade >= 10.0) {
    return { text: "Passed", className: "grade-badge--pass" };
  } else {
    return { text: "Failed", className: "grade-badge--fail" };
  }
}

// ── Fetch and Render Results ─────────────────────────────────
async function loadResults() {
  try {
    const response = await fetch(`${API_BASE_URL}/results`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`
      }
    });

    // If unauthorized or forbidden, redirect back to login page
    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // Ignore parsing errors
    }

    if (response.ok) {
      // 1. Student Info & Badge
      studentName.textContent = data.full_name || "—";
      studentCode.textContent = data.code_massar || "—";
      studentBranch.textContent = `Filière: ${data.branch || "—"}`;
      if (studentLevel) studentLevel.textContent = data.level || "2ème Bac";

      const outcome = data.result || "Ajourné";
      const is1Bac = (data.level || '2ème Bac') === '1ère Bac';

      if (outcome === "Admis") {
        resultLabel.textContent = "Admis";
        resultBadge.className = "result-badge result-badge--pass";
        if (downloadDiplomaBtn) {
          downloadDiplomaBtn.disabled = false;
          diplomaStatusText.textContent = "";
        }
      } else if (outcome === "En cours") {
        resultLabel.textContent = "En cours";
        resultBadge.className = "result-badge result-badge--pending";
        if (downloadDiplomaBtn) {
          downloadDiplomaBtn.disabled = true;
          diplomaStatusText.textContent = "Le diplôme est disponible uniquement pour les élèves de 2ème Bac admis.";
        }
      } else {
        resultLabel.textContent = "Ajourné";
        resultBadge.className = "result-badge result-badge--fail";
        if (downloadDiplomaBtn) {
          downloadDiplomaBtn.disabled = true;
          diplomaStatusText.textContent = "Les diplômes sont disponibles uniquement pour les élèves admis.";
        }
      }

      // Render averages
      const formatAvg = (val) => (val !== undefined && val !== null && !isNaN(val)) ? parseFloat(val).toFixed(2) : "0.00";
      averageRegional.textContent = formatAvg(data.average_regional) + "/20";
      averageCc.textContent = formatAvg(data.average_cc) + "/20";

      // Only show National average card for 2ème Bac
      if (averageNationalCard) {
        averageNationalCard.style.display = is1Bac ? "none" : "";
      }
      if (averageNational) {
        averageNational.textContent = formatAvg(data.average_national) + "/20";
      }

      const overallAvg = parseFloat(data.average || 0.0);
      averageOverall.textContent = overallAvg.toFixed(2) + "/20";

      // Render Mention (only for 2ème Bac final results)
      if (outcome === "Admis") {
        if (overallAvg >= 16.0) averageMention.textContent = "Mention: Très Bien";
        else if (overallAvg >= 14.0) averageMention.textContent = "Mention: Bien";
        else if (overallAvg >= 12.0) averageMention.textContent = "Mention: Assez Bien";
        else averageMention.textContent = "Mention: Passable";
      } else if (outcome === "En cours") {
        averageMention.textContent = "Résultats provisoires — année en cours";
      } else {
        averageMention.textContent = overallAvg >= 8.0 ? "Eligible pour Rattrapage" : "Ajourné";
      }

      // 2. Clear subjects tables container
      resultsTablesContainer.innerHTML = "";

      const subjects = data.subject_results || [];

      // Group subjects by exam_type; skip National exam for 1ère Bac
      const examTypes = is1Bac
        ? ["Examen Régional", "Contrôle Continu"]
        : ["Examen Régional", "Contrôle Continu", "Examen National"];
      const coefsSpec = {
        "Sciences Physiques": {
          "Examen Régional": { "Langue arabe": 2, "Français": 4, "Éducation islamique": 2, "Histoire-Géographie": 2 },
          "Contrôle Continu": { "Mathématiques": 7, "Physique-Chimie": 7, "Sciences de la Vie et de la Terre": 5, "Philosophie": 2, "Anglais": 2 },
          "Examen National": { "Mathématiques": 7, "Physique-Chimie": 7, "Sciences de la Vie et de la Terre": 5, "Philosophie": 2, "Anglais": 2 }
        },
        "Sciences Mathématiques A": {
          "Examen Régional": { "Langue arabe": 2, "Français": 4, "Éducation islamique": 2, "Histoire-Géographie": 2 },
          "Contrôle Continu": { "Mathématiques": 9, "Physique-Chimie": 7, "Sciences de la Vie et de la Terre": 3, "Philosophie": 2, "Anglais": 2 },
          "Examen National": { "Mathématiques": 9, "Physique-Chimie": 7, "Sciences de la Vie et de la Terre": 3, "Philosophie": 2, "Anglais": 2 }
        }
      };

      const branchSpec = coefsSpec[data.branch] || coefsSpec["Sciences Physiques"];

      examTypes.forEach(type => {
        const typeSubjects = subjects.filter(s => s.exam_type === type);
        if (typeSubjects.length === 0) return;

        // Create table container
        const section = document.createElement("div");
        section.className = "table-wrapper";
        section.style.marginBottom = "24px";
        
        let titleColor = "var(--neutral-800)";
        if (type === "Examen Régional") titleColor = "#2980b9";
        else if (type === "Contrôle Continu") titleColor = "#8e44ad";
        else if (type === "Examen National") titleColor = "var(--green-700)";

        let componentAvgVal = 0.0;
        if (type === "Examen Régional") componentAvgVal = data.average_regional;
        else if (type === "Contrôle Continu") componentAvgVal = data.average_cc;
        else if (type === "Examen National") componentAvgVal = data.average_national;

        let tableHtml = `
          <h3 style="margin-top: 10px; margin-bottom: 12px; color: ${titleColor}; font-size: 1.05rem; font-weight: bold; border-left: 4px solid ${titleColor}; padding-left: 8px;">
            ${type} <span style="font-weight: normal; font-size: 0.85rem; color: var(--neutral-600); margin-left: 8px;">(Moyenne: ${formatAvg(componentAvgVal)}/20)</span>
          </h3>
          <table class="results-table">
            <thead>
              <tr>
                <th scope="col">Subject</th>
                <th scope="col" style="text-align: center; width: 100px;">Coefficient</th>
                <th scope="col" class="grade-col" style="width: 100px;">Grade / 20</th>
                <th scope="col" class="status-col" style="width: 120px;">Status</th>
              </tr>
            </thead>
            <tbody>
        `;

        typeSubjects.forEach(sub => {
          const gradeValue = parseFloat(sub.grade);
          const hasGrade = !isNaN(gradeValue);
          const status = hasGrade ? getGradeStatus(gradeValue) : { text: "—", className: "" };
          const gradeText = hasGrade ? gradeValue.toFixed(2) : "—";
          const coef = branchSpec[type] ? (branchSpec[type][sub.subject_name] || "—") : "—";

          tableHtml += `
            <tr>
              <td>${sub.subject_name || "—"}</td>
              <td style="text-align: center;">${coef}</td>
              <td class="grade-col">${gradeText}</td>
              <td class="status-col">
                ${hasGrade ? `<span class="grade-badge ${status.className}">${status.text}</span>` : "—"}
              </td>
            </tr>
          `;
        });

        tableHtml += `
            </tbody>
          </table>
        `;
        section.innerHTML = tableHtml;
        resultsTablesContainer.appendChild(section);
      });

      // 5. Toggle views
      loadingState.hidden = true;
      resultsState.hidden = false;
    } else {
      const serverMessage = data.message || data.error || "Unknown server error.";
      showError(serverMessage);
    }
  } catch (err) {
    console.error("Error fetching results:", err);
    showError("Could not connect to the server. Please check your internet connection.");
  }
}

/**
 * Display the error state banner.
 * @param {string} message
 */
function showError(message) {
  errorMsgText.textContent = message;
  loadingState.hidden = true;
  errorState.hidden = false;
}

// ── Event Handlers ───────────────────────────────────────────
logoutBtn.addEventListener("click", () => {
  handleSessionExpiry();
});

if (downloadDiplomaBtn) {
  downloadDiplomaBtn.addEventListener("click", async () => {
    downloadDiplomaBtn.disabled = true;
    diplomaStatusText.style.color = "var(--neutral-600)";
    diplomaStatusText.textContent = "Requesting download link...";

    try {
      const response = await fetch(`${API_BASE_URL}/student/diploma`, {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${token}`
        }
      });

      if (response.status === 401 || response.status === 403) {
        handleSessionExpiry();
        return;
      }

      const data = await response.json();

      if (response.ok) {
        diplomaStatusText.style.color = "var(--green-700)";
        diplomaStatusText.textContent = "Download started.";
        window.open(data.downloadUrl, "_blank");
      } else if (response.status === 404) {
        diplomaStatusText.style.color = "var(--neutral-600)";
        diplomaStatusText.textContent = "Your diploma is currently being generated. Please check back in a few minutes.";
      } else {
        diplomaStatusText.style.color = "var(--red-600)";
        diplomaStatusText.textContent = data.error || "Failed to download diploma.";
      }
    } catch (err) {
      console.error("Error downloading diploma:", err);
      diplomaStatusText.style.color = "var(--red-600)";
      diplomaStatusText.textContent = "Could not connect to the server.";
    } finally {
      downloadDiplomaBtn.disabled = false;
    }
  });
}

// ── Guidance Report Logic ────────────────────────────────────

// Inject spinner keyframe into the document once
(function injectSpinnerKeyframe() {
  const style = document.createElement("style");
  style.textContent = `@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`;
  document.head.appendChild(style);
})();

const guidanceBtn          = document.getElementById("guidance-btn");
const guidanceBtnIcon      = document.getElementById("guidance-btn-icon");
const guidanceBtnSpinner   = document.getElementById("guidance-btn-spinner");
const guidanceBtnLabel     = document.getElementById("guidance-btn-label");
const guidanceError        = document.getElementById("guidance-error");
const guidanceModalBackdrop = document.getElementById("guidance-modal-backdrop");
const guidanceModalBody    = document.getElementById("guidance-modal-body");
const guidanceModalMeta    = document.getElementById("guidance-modal-meta");
const guidanceMetaResult   = document.getElementById("guidance-meta-result");
const guidanceMetaAvg      = document.getElementById("guidance-meta-avg");
const guidanceMetaMention  = document.getElementById("guidance-meta-mention");
const guidanceModalClose   = document.getElementById("guidance-modal-close");
const guidanceModalCloseFooter = document.getElementById("guidance-modal-close-footer");

/**
 * Convert the AI's markdown response (## headers + paragraphs) to safe HTML.
 * This is a minimal, no-library renderer — it only handles what Nova Pro will output.
 */
function renderMarkdownToHtml(md) {
  return md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .split("\n")
    .map(line => {
      if (line.startsWith("## ")) {
        return `<h3 style="font-size:1.05rem;font-weight:700;color:#3b5bdb;margin:20px 0 8px;border-bottom:2px solid #e0e7ff;padding-bottom:4px;">${line.slice(3)}</h3>`;
      }
      if (line.startsWith("### ")) {
        return `<h4 style="font-size:0.95rem;font-weight:600;color:#495057;margin:14px 0 6px;">${line.slice(4)}</h4>`;
      }
      if (/^\s*[-*•] /.test(line)) {
        const text = line.replace(/^\s*[-*•] /, "")
          .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
        return `<li style="margin-bottom:4px;">${text}</li>`;
      }
      // Bold (**text**) inside regular lines
      const withBold = line.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
      if (withBold.trim() === "") return "<br/>";
      return `<p style="margin:6px 0;">${withBold}</p>`;
    })
    .join("\n")
    // Wrap consecutive <li> elements in <ul>
    .replace(/(<li[^>]*>[\s\S]*?<\/li>\s*)+/g, match => `<ul style="padding-left:20px;margin:8px 0;">${match}</ul>`);
}

function openGuidanceModal(data) {
  // Populate meta bar
  guidanceMetaResult.textContent  = data.result  || "—";
  guidanceMetaAvg.textContent     = data.overall_average || "—";
  guidanceMetaMention.textContent = data.mention || "—";
  guidanceModalMeta.style.display = "flex";

  // Colour-code the result in the meta bar
  guidanceMetaResult.style.color =
    data.result === "Admis"   ? "#2f9e44" :
    data.result === "Ajourné" ? "#c92a2a" : "#495057";

  // Render the markdown body
  guidanceModalBody.innerHTML = renderMarkdownToHtml(data.guidance || "");

  guidanceModalBackdrop.style.display = "block";
  document.body.style.overflow = "hidden";
  guidanceModalClose.focus();
}

function closeGuidanceModal() {
  guidanceModalBackdrop.style.display = "none";
  document.body.style.overflow = "";
  guidanceModalBody.innerHTML = "";
  guidanceModalMeta.style.display = "none";
}

function setGuidanceBtnLoading(loading) {
  guidanceBtn.disabled       = loading;
  guidanceBtnIcon.hidden     = loading;
  guidanceBtnSpinner.hidden  = !loading;
  guidanceBtnLabel.textContent = loading ? "Generating…" : "Generate Guidance Report";
  guidanceBtn.style.opacity  = loading ? "0.75" : "1";
  guidanceBtn.style.cursor   = loading ? "not-allowed" : "pointer";
}

if (guidanceBtn) {
  guidanceBtn.addEventListener("click", async () => {
    guidanceError.hidden = true;
    guidanceError.textContent = "";
    setGuidanceBtnLoading(true);

    try {
      const response = await fetch(`${API_BASE_URL}/guidance/generate`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/json"
        }
      });

      if (response.status === 401 || response.status === 403) {
        handleSessionExpiry();
        return;
      }

      let data = {};
      try { data = await response.json(); } catch (_) {}

      if (response.ok) {
        openGuidanceModal(data);
      } else {
        guidanceError.hidden = false;
        guidanceError.textContent = data.error || "Failed to generate guidance report. Please try again.";
      }
    } catch (err) {
      console.error("Error generating guidance report:", err);
      guidanceError.hidden = false;
      guidanceError.textContent = "Could not connect to the server. Please check your internet connection.";
    } finally {
      setGuidanceBtnLoading(false);
    }
  });
}

// Modal close handlers
if (guidanceModalClose) {
  guidanceModalClose.addEventListener("click", closeGuidanceModal);
}
if (guidanceModalCloseFooter) {
  guidanceModalCloseFooter.addEventListener("click", closeGuidanceModal);
}
// Close on backdrop click (outside the modal card)
if (guidanceModalBackdrop) {
  guidanceModalBackdrop.addEventListener("click", (e) => {
    if (e.target === guidanceModalBackdrop) closeGuidanceModal();
  });
}
// Close on Escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && guidanceModalBackdrop.style.display === "block") {
    closeGuidanceModal();
  }
});

// Run load on start
loadResults();
