/* ============================================================
   teacher.js — Massar Portal Teacher Space Logic
   GET /teacher/students with Bearer Token → Render Students List
   POST /teacher/grades with Bearer Token → Update grades
   ============================================================ */

// API base URL
const API_BASE_URL = "/api";

// DOM references
const loadingState      = document.getElementById("loading-state");
const studentsCard      = document.getElementById("students-card");
const studentsTbody     = document.getElementById("students-tbody");
const successAlert      = document.getElementById("success-alert");
const successAlertText  = document.getElementById("success-alert-text");
const errorAlert        = document.getElementById("error-alert");
const errorAlertText    = document.getElementById("error-alert-text");

// Modal references
const editModalBackdrop = document.getElementById("edit-modal-backdrop");
const modalCloseBtn     = document.getElementById("modal-close-btn");
const modalCancelBtn    = document.getElementById("modal-cancel-btn");
const editGradeForm     = document.getElementById("edit-grade-form");
const modalStudentName  = document.getElementById("modal-student-name");
const modalStudentCode  = document.getElementById("modal-student-code");
const modalErrorAlert   = document.getElementById("modal-error-alert");
const modalErrorText    = document.getElementById("modal-error-text");

const tabNational       = document.getElementById("tab-national");
const panelRegional     = document.getElementById("panel-regional");
const panelCc           = document.getElementById("panel-cc");
const panelNational     = document.getElementById("panel-national");
const modalTabContainer = document.getElementById("modal-tab-container");

const saveBtnLabel      = document.getElementById("save-btn-label");
const saveBtnSpinner    = document.getElementById("save-btn-spinner");
const modalSaveBtn      = document.getElementById("modal-save-btn");

const logoutBtn         = document.getElementById("logout-btn");

// Global states
let studentsList = [];
let currentStudent = null;

// ── Auth Guard: Verify session tokens and Cognito group ───────────────────
const accessToken = sessionStorage.getItem("access_token");
const idToken = sessionStorage.getItem("id_token");

function decodeJwt(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const pad = base64.length % 4;
    const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
    return JSON.parse(atob(padded));
  } catch (e) {
    return null;
  }
}

if (!accessToken || !idToken) {
  handleSessionExpiry();
} else {
  const payload = decodeJwt(idToken);
  if (!payload) {
    handleSessionExpiry();
  } else {
    const groups = payload["cognito:groups"] || [];
    if (!groups.includes("teachers")) {
      handleSessionExpiry();
    }
  }
}

// ── Helper: Clear session and redirect to login ───────────────────────────
function handleSessionExpiry() {
  sessionStorage.clear();
  window.location.replace("login-teacher.html");
}

// ── Alert Helpers ──────────────────────────────────────────────────────────
function showSuccess(message) {
  hideAlerts();
  successAlertText.textContent = message;
  successAlert.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showError(message) {
  hideAlerts();
  errorAlertText.textContent = message;
  errorAlert.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showModalError(message) {
  modalErrorText.textContent = message;
  modalErrorAlert.hidden = false;
}

function hideAlerts() {
  successAlert.hidden = true;
  errorAlert.hidden = true;
  modalErrorAlert.hidden = true;
}

// ── Fetch and Render Students ──────────────────────────────────────────────
async function loadStudents() {
  try {
    loadingState.hidden = false;
    studentsCard.hidden = true;

    const response = await fetch(`${API_BASE_URL}/teacher/students`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = [];
    try {
      data = await response.json();
    } catch (_) {
      // Ignore JSON parse errors
    }

    if (response.ok) {
      studentsList = data;
      renderStudentsTable();
      loadingState.hidden = true;
      studentsCard.hidden = false;
    } else {
      const serverMessage = data.message || data.error || "Failed to retrieve students.";
      showError(serverMessage);
      loadingState.hidden = true;
    }
  } catch (err) {
    console.error("Error loading students list:", err);
    showError("Could not retrieve student list. Please check your network connection.");
    loadingState.hidden = true;
  }
}

function renderStudentsTable() {
  studentsTbody.innerHTML = "";

  if (studentsList.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" style="text-align: center; color: var(--neutral-600);">No student records found.</td>`;
    studentsTbody.appendChild(row);
    return;
  }

  studentsList.forEach(student => {
    const statusLabel = student.result || "Ajourné";
    const statusClass = statusLabel === "Admis" 
      ? "badge-status--admis" 
      : statusLabel === "En cours"
        ? "badge-status--pending"
        : "badge-status--ajourne";

    const levelLabel = student.level || '2ème Bac';
    const levelClass = levelLabel === '1ère Bac' ? 'badge-status--pending' : 'badge-status--info';

    const row = document.createElement("tr");
    row.className = "student-list-row";
    row.innerHTML = `
      <td><strong>${student.code_massar || "—"}</strong></td>
      <td>${student.full_name || "—"}<br/><small style="color: var(--neutral-600);">${student.branch || "Sciences Physiques"}</small></td>
      <td>${student.email || "—"}</td>
      <td>${student.phone || "—"}</td>
      <td style="text-align: center;">
        <span class="badge-status ${levelClass}">${levelLabel}</span>
      </td>
      <td style="text-align: center;">
        <span class="badge-status ${statusClass}">${statusLabel}</span><br/>
        <small style="color: var(--neutral-600); font-weight: 500;">${student.average ? parseFloat(student.average).toFixed(2) + '/20' : '0.00/20'}</small>
      </td>
      <td style="text-align: center;">
        <button class="btn btn--ghost btn--sm edit-action-btn" type="button" data-id="${student.id}">Edit Grades</button>
      </td>
    `;

    // Clicking the row or the actions button opens the edit modal
    row.addEventListener("click", (e) => {
      // Avoid triggering when user copies text or clicks another interactive element
      if (e.target.tagName !== "BUTTON" && e.target.tagName !== "A") {
        openEditModal(student);
      }
    });

    const editBtn = row.querySelector(".edit-action-btn");
    editBtn.addEventListener("click", () => {
      openEditModal(student);
    });

    studentsTbody.appendChild(row);
  });
}

// ── Modal Actions & Dynamic Form Generation ───────────────────────────────
// A mapping of exam types to their respective Moroccan Baccalaureate subjects
const EXAM_SUBJECTS = {
  "Examen Régional": [
    { name: "Français", coefs: { "Sciences Physiques": 4, "Sciences Mathématiques A": 4 } },
    { name: "Langue arabe", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } },
    { name: "Éducation islamique", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } },
    { name: "Histoire-Géographie", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } }
  ],
  "Contrôle Continu": [
    { name: "Mathématiques", coefs: { "Sciences Physiques": 7, "Sciences Mathématiques A": 9 } },
    { name: "Physique-Chimie", coefs: { "Sciences Physiques": 7, "Sciences Mathématiques A": 7 } },
    { name: "Sciences de la Vie et de la Terre", coefs: { "Sciences Physiques": 5, "Sciences Mathématiques A": 3 } },
    { name: "Philosophie", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } },
    { name: "Anglais", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } }
  ],
  "Examen National": [
    { name: "Mathématiques", coefs: { "Sciences Physiques": 7, "Sciences Mathématiques A": 9 } },
    { name: "Physique-Chimie", coefs: { "Sciences Physiques": 7, "Sciences Mathématiques A": 7 } },
    { name: "Sciences de la Vie et de la Terre", coefs: { "Sciences Physiques": 5, "Sciences Mathématiques A": 3 } },
    { name: "Philosophie", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } },
    { name: "Anglais", coefs: { "Sciences Physiques": 2, "Sciences Mathématiques A": 2 } }
  ]
};

function getCoeff(examType, subjectName, branch) {
  const list = EXAM_SUBJECTS[examType] || [];
  const item = list.find(s => s.name === subjectName);
  return item ? (item.coefs[branch] || 2) : 2;
}

function generateGradeInputs() {
  const branch = currentStudent.branch || "Sciences Physiques";
  const is1Bac = currentStudent.level === "1ère Bac";

  // 1. Regional Panel
  renderPanelInputs(panelRegional, "Examen Régional", EXAM_SUBJECTS["Examen Régional"], branch);

  // 2. CC Panel
  renderPanelInputs(panelCc, "Contrôle Continu", EXAM_SUBJECTS["Contrôle Continu"], branch);

  // 3. National Panel (if not 1ère Bac)
  if (is1Bac) {
    panelNational.innerHTML = `<div style="text-align: center; color: var(--neutral-600); padding: 20px;">L'Examen National n'est pas applicable pour les élèves de la 1ère Bac.</div>`;
    tabNational.style.display = "none";
  } else {
    tabNational.style.display = "";
    renderPanelInputs(panelNational, "Examen National", EXAM_SUBJECTS["Examen National"], branch);
  }
}

function renderPanelInputs(container, examType, subjects, branch) {
  container.innerHTML = "";

  const table = document.createElement("table");
  table.className = "results-table";
  table.style.width = "100%";
  table.style.marginBottom = "0";

  table.innerHTML = `
    <thead>
      <tr>
        <th scope="col" style="text-align: left;">Matière</th>
        <th scope="col" style="text-align: center; width: 100px;">Coefficient</th>
        <th scope="col" style="text-align: right; width: 150px;">Note / 20</th>
      </tr>
    </thead>
    <tbody>
    </tbody>
  `;

  const tbody = table.querySelector("tbody");
  const studentResults = currentStudent.subject_results || [];

  subjects.forEach(subject => {
    const coef = subject.coefs[branch] || 2;
    const existing = studentResults.find(r => r.subject_name === subject.name && r.exam_type === examType);
    const initialValue = (existing && !isNaN(parseFloat(existing.grade))) ? parseFloat(existing.grade).toFixed(2) : "";

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td style="text-align: left; font-weight: 500;">${subject.name}</td>
      <td style="text-align: center; color: var(--neutral-600);">${coef}</td>
      <td style="text-align: right;">
        <input class="form-input grade-cell-input" 
               type="number" 
               step="0.25" 
               min="0" 
               max="20" 
               placeholder="—" 
               data-subject="${subject.name}" 
               data-exam-type="${examType}" 
               value="${initialValue}"
               style="width: 110px; text-align: center; padding: 6px; font-weight: bold; border-radius: 6px; border: 1px solid var(--neutral-300);" />
      </td>
    `;
    tbody.appendChild(tr);
  });

  container.appendChild(table);
}

// ── Tab Event Handlers ──────────────────────────────────────────────────────
function setupTabs() {
  const tabs = modalTabContainer.querySelectorAll(".tab-btn");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      // Deactivate all
      tabs.forEach(t => t.classList.remove("tab-btn--active"));
      panelRegional.style.display = "none";
      panelCc.style.display = "none";
      panelNational.style.display = "none";

      // Activate clicked
      tab.classList.add("tab-btn--active");
      const target = tab.getAttribute("data-tab");
      if (target === "regional") panelRegional.style.display = "block";
      else if (target === "cc") panelCc.style.display = "block";
      else if (target === "national") panelNational.style.display = "block";
    });
  });
}

function openEditModal(student) {
  currentStudent = student;
  modalStudentName.textContent = student.full_name || "—";
  modalStudentCode.textContent = ` (${student.code_massar || "—"})`;
  
  hideAlerts();

  // Reset active tab to first tab
  const tabs = modalTabContainer.querySelectorAll(".tab-btn");
  tabs.forEach(t => t.classList.remove("tab-btn--active"));
  tabs[0].classList.add("tab-btn--active");
  panelRegional.style.display = "block";
  panelCc.style.display = "none";
  panelNational.style.display = "none";

  // Generate Inputs
  generateGradeInputs();

  editModalBackdrop.style.display = "flex";
}

function closeModal() {
  editModalBackdrop.style.display = "none";
  currentStudent = null;
}

function setModalLoading(loading) {
  modalSaveBtn.disabled = loading;
  modalCancelBtn.disabled = loading;
  modalCloseBtn.disabled = loading;
  saveBtnLabel.textContent = loading ? "Saving Grades..." : "Save All Changes";
  saveBtnSpinner.hidden = !loading;
}

// ── Submit Bulk Edit Grade Form ─────────────────────────────────────────────
editGradeForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  modalErrorAlert.hidden = true;

  if (!currentStudent) return;

  const inputs = Array.from(editGradeForm.querySelectorAll(".grade-cell-input"));
  const updates = [];
  let validationError = null;

  inputs.forEach(input => {
    const valString = input.value.trim();
    if (valString !== "") {
      const val = parseFloat(valString);
      if (isNaN(val) || val < 0 || val > 20) {
        validationError = `Note pour ${input.getAttribute("data-subject")} (${input.getAttribute("data-exam-type")}) doit être comprise entre 0 et 20.`;
      } else {
        updates.push({
          subject_name: input.getAttribute("data-subject"),
          exam_type: input.getAttribute("data-exam-type"),
          grade: val
        });
      }
    }
  });

  if (validationError) {
    showModalError(validationError);
    return;
  }

  // Compare updates with current subject results to send only changed grades
  const studentResults = currentStudent.subject_results || [];
  const modifiedGrades = [];

  updates.forEach(upd => {
    const existing = studentResults.find(r => r.subject_name === upd.subject_name && r.exam_type === upd.exam_type);
    const existingGrade = existing ? parseFloat(existing.grade) : null;
    if (existingGrade === null || Math.abs(existingGrade - upd.grade) > 0.001) {
      modifiedGrades.push(upd);
    }
  });

  // If no changes, just close the modal
  if (modifiedGrades.length === 0) {
    closeModal();
    return;
  }

  setModalLoading(true);

  try {
    const response = await fetch(`${API_BASE_URL}/teacher/grades`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        code_massar: currentStudent.code_massar,
        grades: modifiedGrades
      })
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      throw new Error("Session expired. Please log in again.");
    }

    let resData = {};
    try {
      resData = await response.json();
    } catch (_) {
      // Ignore
    }

    if (!response.ok) {
      throw new Error(resData.error || "Failed to update grades.");
    }

    showSuccess(`Enregistrement réussi : ${modifiedGrades.length} notes ont été mises à jour pour l'élève ${currentStudent.full_name}.`);
    closeModal();
    await loadStudents(); // Reload main table
  } catch (err) {
    console.error("Error submitting grade updates:", err);
    showModalError(err.message || "Failed to save grade updates. Please try again.");
  } finally {
    setModalLoading(false);
  }
});

// Setup tabs listener
setupTabs();

// ── Event Listeners ────────────────────────────────────────────────────────
modalCloseBtn.addEventListener("click", closeModal);
modalCancelBtn.addEventListener("click", closeModal);

// Close modal on clicking outside the modal dialog box
editModalBackdrop.addEventListener("click", function (e) {
  if (e.target === editModalBackdrop) {
    closeModal();
  }
});

logoutBtn.addEventListener("click", () => {
  handleSessionExpiry();
});

// Load the dashboard on startup
loadStudents();
