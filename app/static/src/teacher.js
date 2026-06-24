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

const gradeExamType     = document.getElementById("grade-exam-type");
const gradeSubject      = document.getElementById("grade-subject");
const gradeValue        = document.getElementById("grade-value");

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

// ── Modal Actions ──────────────────────────────────────────────────────────
// A mapping of exam types to their respective Moroccan Baccalaureate subjects
const EXAM_SUBJECTS = {
  "Examen Régional": ["Français", "Langue arabe", "Éducation islamique", "Histoire-Géographie"],
  "Contrôle Continu": ["Mathématiques", "Physique-Chimie", "Sciences de la Vie et de la Terre", "Philosophie", "Anglais"],
  "Examen National": ["Mathématiques", "Physique-Chimie", "Sciences de la Vie et de la Terre", "Philosophie", "Anglais"]
};

function populateSubjects() {
  const examType = gradeExamType.value;
  const subjects = EXAM_SUBJECTS[examType] || [];
  
  gradeSubject.innerHTML = "";
  subjects.forEach(sub => {
    const opt = document.createElement("option");
    opt.value = sub;
    opt.textContent = sub;
    gradeSubject.appendChild(opt);
  });
  
  updateGradeInputFromStudent();
}

function updateGradeInputFromStudent() {
  if (!currentStudent) return;
  const examType = gradeExamType.value;
  const subjectName = gradeSubject.value;
  
  const results = currentStudent.subject_results || [];
  const found = results.find(r => r.subject_name === subjectName && r.exam_type === examType);
  if (found && !isNaN(parseFloat(found.grade))) {
    gradeValue.value = parseFloat(found.grade);
  } else {
    gradeValue.value = "";
  }
}

function updateExamTypeOptions(student) {
  const is1Bac = student && student.level === '1ère Bac';
  const nationalOpt = Array.from(gradeExamType.options).find(opt => opt.value === "Examen National");
  if (nationalOpt) {
    if (is1Bac) {
      nationalOpt.disabled = true;
      nationalOpt.style.display = "none";
    } else {
      nationalOpt.disabled = false;
      nationalOpt.style.display = "";
    }
  }
}

// ── Modal Actions ──────────────────────────────────────────────────────────
function openEditModal(student) {
  currentStudent = student;
  modalStudentName.textContent = student.full_name || "—";
  modalStudentCode.textContent = ` (${student.code_massar || "—"})`;
  
  hideAlerts();

  // Setup dropdown values
  updateExamTypeOptions(student);
  gradeExamType.value = "Contrôle Continu";
  populateSubjects();

  editModalBackdrop.style.display = "flex";
  gradeValue.focus();
}

function closeModal() {
  editModalBackdrop.style.display = "none";
  currentStudent = null;
}

function setModalLoading(loading) {
  modalSaveBtn.disabled = loading;
  modalCancelBtn.disabled = loading;
  modalCloseBtn.disabled = loading;
  saveBtnLabel.textContent = loading ? "Saving..." : "Save Changes";
  saveBtnSpinner.hidden = !loading;
}

// ── Submit Edit Grade Form ──────────────────────────────────────────────────
editGradeForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  modalErrorAlert.hidden = true;

  if (!currentStudent) return;

  const examType = gradeExamType.value;
  const subjectName = gradeSubject.value;
  const valString = gradeValue.value.trim();

  if (!valString) {
    showModalError("Please provide a grade.");
    return;
  }

  const val = parseFloat(valString);
  if (isNaN(val) || val < 0 || val > 20) {
    showModalError("Grade must be a number between 0 and 20.");
    return;
  }

  // Check if changed
  const currentResults = currentStudent.subject_results || [];
  const oldResult = currentResults.find(r => r.subject_name === subjectName && r.exam_type === examType);
  const oldVal = oldResult ? parseFloat(oldResult.grade) : null;

  if (oldVal === null || oldVal !== val) {
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
          subject_name: subjectName,
          exam_type: examType,
          grade: val
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
        throw new Error(resData.error || "Failed to update grade.");
      }

      showSuccess(`Successfully updated ${subjectName} (${examType}) grade for ${currentStudent.full_name} to ${val.toFixed(2)}.`);
      closeModal();
      await loadStudents(); // Reload main table
    } catch (err) {
      console.error("Error submitting grade updates:", err);
      showModalError(err.message || "Failed to save grade updates. Please try again.");
    } finally {
      setModalLoading(false);
    }
  } else {
    // If no changes, just close the modal
    closeModal();
  }
});

// Setup dynamic dropdown event listeners
gradeExamType.addEventListener("change", populateSubjects);
gradeSubject.addEventListener("change", updateGradeInputFromStudent);

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
