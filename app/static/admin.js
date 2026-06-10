/* ============================================================
   admin.js — Massar Portal Admin Console Logic
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

// Actions references
const addStudentBtn     = document.getElementById("add-student-btn");
const releaseResultsBtn = document.getElementById("release-results-btn");

// Modal references
const studentModalBackdrop = document.getElementById("student-modal-backdrop");
const modalCloseBtn        = document.getElementById("modal-close-btn");
const modalCancelBtn       = document.getElementById("modal-cancel-btn");
const studentForm          = document.getElementById("student-form");
const modalTitle           = document.getElementById("modal-title");
const studentIdInput       = document.getElementById("student-id-input");
const studentNameInput     = document.getElementById("student-name");
const studentEmailInput    = document.getElementById("student-email");
const studentPhoneInput    = document.getElementById("student-phone");

const saveBtnLabel         = document.getElementById("save-btn-label");
const saveBtnSpinner       = document.getElementById("save-btn-spinner");
const modalSaveBtn         = document.getElementById("modal-save-btn");

const logoutBtn            = document.getElementById("logout-btn");

// Global states
let studentsList = [];

// ── Auth Guard: Verify session tokens and Cognito admins group ────────────
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
    if (!groups.includes("admins")) {
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
  const modalErrorAlert = document.getElementById("modal-error-alert");
  const modalErrorText  = document.getElementById("modal-error-text");
  modalErrorText.textContent = message;
  modalErrorAlert.hidden = false;
}

function hideAlerts() {
  successAlert.hidden = true;
  errorAlert.hidden = true;
  const modalErrorAlert = document.getElementById("modal-error-alert");
  if (modalErrorAlert) modalErrorAlert.hidden = true;
}

// ── Fetch and Render Students ──────────────────────────────────────────────
async function loadStudents() {
  try {
    loadingState.hidden = false;
    studentsCard.hidden = true;

    const response = await fetch(`${API_BASE_URL}/admin/students`, {
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
      // Ignore
    }

    if (response.ok) {
      studentsList = data;
      renderStudentsTable();
      loadingState.hidden = true;
      studentsCard.hidden = false;
    } else {
      const serverMessage = data.message || data.error || "Failed to load student directory.";
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
    row.innerHTML = `
      <td><strong>${student.code_massar || "—"}</strong></td>
      <td>${student.full_name || "—"}</td>
      <td>${student.email || "—"}</td>
      <td>${student.phone || "—"}</td>
      <td style="text-align: center;">
        <span class="badge-status ${statusClass}">${statusLabel}</span>
      </td>
      <td style="text-align: center; display: flex; gap: 8px; justify-content: center;">
        <button class="btn btn--ghost btn--sm edit-student-action" type="button">Edit</button>
        <button class="btn btn--ghost btn--sm btn--danger delete-student-action" type="button" style="color: var(--red-600); border-color: #f5c6c2;">Delete</button>
      </td>
    `;

    // Hook edit action
    row.querySelector(".edit-student-action").addEventListener("click", () => {
      openStudentModal(student);
    });

    // Hook delete action
    row.querySelector(".delete-student-action").addEventListener("click", () => {
      deleteStudent(student);
    });

    studentsTbody.appendChild(row);
  });
}

// ── Modal Actions ──────────────────────────────────────────────────────────
function openStudentModal(student = null) {
  hideAlerts();
  
  if (student) {
    // Edit mode
    modalTitle.textContent = "Edit Student Profile";
    saveBtnLabel.textContent = "Save Changes";
    studentIdInput.value = student.id;
    studentNameInput.value = student.full_name || "";
    studentEmailInput.value = student.email || "";
    studentPhoneInput.value = student.phone || "";
  } else {
    // Create mode
    modalTitle.textContent = "Add Student";
    saveBtnLabel.textContent = "Save Student";
    studentIdInput.value = "";
    studentNameInput.value = "";
    studentEmailInput.value = "";
    studentPhoneInput.value = "";
  }

  studentModalBackdrop.style.display = "flex";
  studentNameInput.focus();
}

function closeModal() {
  studentModalBackdrop.style.display = "none";
}

function setModalLoading(loading) {
  modalSaveBtn.disabled = loading;
  modalCancelBtn.disabled = loading;
  modalCloseBtn.disabled = loading;
  saveBtnLabel.textContent = loading ? "Saving..." : (studentIdInput.value ? "Save Changes" : "Save Student");
  saveBtnSpinner.hidden = !loading;
}

// ── Student Form Submission (Add / Edit) ──────────────────────────────
studentForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  hideAlerts();

  const name  = studentNameInput.value.trim();
  const email = studentEmailInput.value.trim();
  const phone = studentPhoneInput.value.trim();
  const id    = studentIdInput.value;

  if (!name || !email || !phone) {
    showModalError("All profile fields are required.");
    return;
  }

  setModalLoading(true);

  try {
    const isEdit = !!id;
    const url = isEdit ? `${API_BASE_URL}/admin/students/${id}` : `${API_BASE_URL}/admin/students`;
    const method = isEdit ? "PUT" : "POST";

    const response = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        full_name: name,
        email: email,
        phone: phone
      })
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // Ignore
    }

    if (response.ok) {
      const successMsg = isEdit 
        ? `Successfully updated student profile for ${name}.` 
        : `Successfully created student ${name} with Massar Code ${data.student?.code_massar || ""}.`;
      
      showSuccess(successMsg);
      closeModal();
      await loadStudents();
    } else {
      showModalError(data.error || "Failed to process student profile request.");
    }
  } catch (err) {
    console.error("Error submitting student form:", err);
    showModalError("Failed to connect to the server. Please verify connection.");
  } finally {
    setModalLoading(false);
  }
});

// ── Delete Student Record ──────────────────────────────────────────────────
async function deleteStudent(student) {
  const confirmDelete = confirm(`Are you sure you want to delete student "${student.full_name}" (${student.code_massar})?\nThis action will also delete all their subject grades and cannot be undone.`);
  if (!confirmDelete) return;

  try {
    const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer ${accessToken}`
      }
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // Ignore
    }

    if (response.ok) {
      showSuccess(`Successfully deleted student "${student.full_name}".`);
      await loadStudents();
    } else {
      showError(data.error || `Failed to delete student "${student.full_name}".`);
    }
  } catch (err) {
    console.error("Error deleting student:", err);
    showError("Could not connect to the server to delete the student.");
  }
}

// ── Release Results Notifications (SQS) ───────────────────────────────────
async function triggerReleaseResults() {
  const confirmRelease = confirm("Are you sure you want to release exam results to all students?\nThis will queue SMS/email alerts for all registered student records.");
  if (!confirmRelease) return;

  hideAlerts();
  releaseResultsBtn.disabled = true;

  try {
    const response = await fetch(`${API_BASE_URL}/admin/release-results`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {
      // Ignore
    }

    if (response.ok) {
      const count = typeof data.count !== "undefined" ? data.count : 0;
      showSuccess(`Successfully queued results notifications for ${count} students on the SQS queue.`);
    } else {
      showError(data.error || "Failed to trigger results notifications release.");
    }
  } catch (err) {
    console.error("Error releasing results:", err);
    showError("Could not connect to the server to release results.");
  } finally {
    releaseResultsBtn.disabled = false;
  }
}

// ── Event Handlers ──────────────────────────────────────────────────────────
addStudentBtn.addEventListener("click", () => {
  openStudentModal();
});

releaseResultsBtn.addEventListener("click", () => {
  triggerReleaseResults();
});

modalCloseBtn.addEventListener("click", closeModal);
modalCancelBtn.addEventListener("click", closeModal);

studentModalBackdrop.addEventListener("click", function (e) {
  if (e.target === studentModalBackdrop) {
    closeModal();
  }
});

logoutBtn.addEventListener("click", () => {
  handleSessionExpiry();
});

// Run load on start
loadStudents();
