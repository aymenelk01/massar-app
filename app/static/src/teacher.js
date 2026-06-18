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

const gradeMath         = document.getElementById("grade-math");
const gradePhys         = document.getElementById("grade-phys");
const gradeSvt          = document.getElementById("grade-svt");
const gradePhilo        = document.getElementById("grade-philo");

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
  window.location.replace("login.html");
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
    row.innerHTML = `<td colspan="6" style="text-align: center; color: var(--neutral-600);">No student records found.</td>`;
    studentsTbody.appendChild(row);
    return;
  }

  studentsList.forEach(student => {
    const statusLabel = student.result || "Ajourné";
    const statusClass = statusLabel === "Admis" ? "badge-status--admis" : "badge-status--ajourne";

    const row = document.createElement("tr");
    row.className = "student-list-row";
    row.innerHTML = `
      <td><strong>${student.code_massar || "—"}</strong></td>
      <td>${student.full_name || "—"}</td>
      <td>${student.email || "—"}</td>
      <td>${student.phone || "—"}</td>
      <td style="text-align: center;">
        <span class="badge-status ${statusClass}">${statusLabel}</span>
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
function openEditModal(student) {
  currentStudent = student;
  modalStudentName.textContent = student.full_name || "—";
  modalStudentCode.textContent = ` (${student.code_massar || "—"})`;
  
  hideAlerts();

  // Reset inputs
  gradeMath.value = "";
  gradePhys.value = "";
  gradeSvt.value = "";
  gradePhilo.value = "";

  // Prefill grades if they exist in student.subject_results
  const subjects = student.subject_results || [];
  subjects.forEach(sub => {
    const gradeVal = parseFloat(sub.grade);
    if (!isNaN(gradeVal)) {
      if (sub.subject_name === "Mathématiques") gradeMath.value = gradeVal;
      else if (sub.subject_name === "Physique-Chimie") gradePhys.value = gradeVal;
      else if (sub.subject_name === "Sciences de la Vie et de la Terre") gradeSvt.value = gradeVal;
      else if (sub.subject_name === "Philosophie") gradePhilo.value = gradeVal;
    }
  });

  editModalBackdrop.style.display = "flex";
  gradeMath.focus();
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

  const subjectsInputMap = [
    { name: "Mathématiques", element: gradeMath },
    { name: "Physique-Chimie", element: gradePhys },
    { name: "Sciences de la Vie et de la Terre", element: gradeSvt },
    { name: "Philosophie", element: gradePhilo }
  ];

  // Parse and validate fields
  const updates = [];
  for (const item of subjectsInputMap) {
    const valString = item.element.value.trim();
    if (!valString) {
      showModalError(`Please provide a grade for ${item.name}.`);
      return;
    }

    const val = parseFloat(valString);
    if (isNaN(val) || val < 0 || val > 20) {
      showModalError(`Grade for ${item.name} must be a number between 0 and 20.`);
      return;
    }

    // Check if changed
    const currentResults = currentStudent.subject_results || [];
    const oldResult = currentResults.find(r => r.subject_name === item.name);
    const oldVal = oldResult ? parseFloat(oldResult.grade) : null;

    if (oldVal === null || oldVal !== val) {
      updates.push({
        subject_name: item.name,
        grade: val
      });
    }
  }

  // If there are updates, perform requests
  if (updates.length > 0) {
    setModalLoading(true);

    try {
      // Execute all updates in parallel
      const updatePromises = updates.map(async (upd) => {
        const response = await fetch(`${API_BASE_URL}/teacher/grades`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`
          },
          body: JSON.stringify({
            code_massar: currentStudent.code_massar,
            subject_name: upd.subject_name,
            grade: upd.grade
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
          throw new Error(resData.error || `Failed to update grade for ${upd.subject_name}.`);
        }

        return resData;
      });

      await Promise.all(updatePromises);
      showSuccess(`Successfully updated grades for ${currentStudent.full_name}.`);
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
