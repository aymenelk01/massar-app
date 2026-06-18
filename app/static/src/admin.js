/* ============================================================
   admin.js — Massar Portal Admin Console Logic
   ============================================================ */

// API base URL
const API_BASE_URL = "/api";

// DOM references
const loadingState      = document.getElementById("loading-state");
const studentsCard      = document.getElementById("students-card");
const studentsTbody     = document.getElementById("students-tbody");
const teachersCard      = document.getElementById("teachers-card");
const teachersTbody     = document.getElementById("teachers-tbody");
const successAlert      = document.getElementById("success-alert");
const successAlertText  = document.getElementById("success-alert-text");
const errorAlert        = document.getElementById("error-alert");
const errorAlertText    = document.getElementById("error-alert-text");

// Tabs references
const tabStudents       = document.getElementById("tab-students");
const tabTeachers       = document.getElementById("tab-teachers");
const studentsTabContent = document.getElementById("students-tab-content");
const teachersTabContent = document.getElementById("teachers-tab-content");

// Actions references
const addStudentBtn     = document.getElementById("add-student-btn");
const releaseResultsBtn = document.getElementById("release-results-btn");
const addTeacherBtn     = document.getElementById("add-teacher-btn");

// Student Modal references
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

// Teacher Modal references
const teacherModalBackdrop   = document.getElementById("teacher-modal-backdrop");
const teacherModalCloseBtn   = document.getElementById("teacher-modal-close-btn");
const teacherModalCancelBtn  = document.getElementById("teacher-modal-cancel-btn");
const teacherForm            = document.getElementById("teacher-form");
const teacherModalTitle       = document.getElementById("teacher-modal-title");
const teacherUsernameGroup   = document.getElementById("teacher-username-group");
const teacherUsernameInput   = document.getElementById("teacher-username");
const teacherNameInput       = document.getElementById("teacher-name");
const teacherEmailInput      = document.getElementById("teacher-email");
const teacherPhoneInput      = document.getElementById("teacher-phone");
const teacherSubjectInput    = document.getElementById("teacher-subject");

const teacherSaveBtnLabel    = document.getElementById("teacher-save-btn-label");
const teacherSaveBtnSpinner  = document.getElementById("teacher-save-btn-spinner");
const teacherModalSaveBtn    = document.getElementById("teacher-modal-save-btn");
const teacherModalErrorAlert = document.getElementById("teacher-modal-error-alert");
const teacherModalErrorText  = document.getElementById("teacher-modal-error-text");

const logoutBtn            = document.getElementById("logout-btn");

// Confirm Dialog Modal references
const confirmModalBackdrop = document.getElementById("confirm-modal-backdrop");
const confirmModalTitle    = document.getElementById("confirm-modal-title");
const confirmModalMessage  = document.getElementById("confirm-modal-message");
const confirmOkBtn         = document.getElementById("confirm-ok-btn");
const confirmCancelBtn     = document.getElementById("confirm-cancel-btn");

// Global states
let activeTab = "students";
let studentsList = [];
let teachersList = [];
let isEditTeacherMode = false;

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
  window.location.replace("login-admin.html");
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
  if (teacherModalErrorAlert) teacherModalErrorAlert.hidden = true;
}

// ── Confirm Dialog ─────────────────────────────────────────────────────────
/**
 * Shows a modern confirmation dialog instead of the native browser confirm().
 * @param {string} title - Modal heading
 * @param {string} message - Body text
 * @param {{ confirmLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>} resolves true if user confirms, false if cancelled
 */
function showConfirm(title, message, { confirmLabel = "Confirm", danger = true } = {}) {
  return new Promise((resolve) => {
    confirmModalTitle.textContent = title;
    confirmModalMessage.textContent = message;
    confirmOkBtn.textContent = confirmLabel;
    confirmOkBtn.className = `btn ${danger ? "btn--danger" : "btn--primary"}`;
    confirmModalBackdrop.style.display = "flex";
    confirmOkBtn.focus();

    function onOk() { close(true); }
    function onCancel() { close(false); }
    function onBackdrop(e) { if (e.target === confirmModalBackdrop) close(false); }

    function close(result) {
      confirmModalBackdrop.style.display = "none";
      confirmOkBtn.removeEventListener("click", onOk);
      confirmCancelBtn.removeEventListener("click", onCancel);
      confirmModalBackdrop.removeEventListener("click", onBackdrop);
      resolve(result);
    }

    confirmOkBtn.addEventListener("click", onOk);
    confirmCancelBtn.addEventListener("click", onCancel);
    confirmModalBackdrop.addEventListener("click", onBackdrop);
  });
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
    row.innerHTML = `<td colspan="7" style="text-align: center; color: var(--neutral-600);">No student records found.</td>`;
    studentsTbody.appendChild(row);
    return;
  }

  studentsList.forEach(student => {
    const statusLabel = student.result || "Ajourné";
    const statusClass = statusLabel === "Admis" ? "badge-status--admis" : "badge-status--ajourne";

    const isEnabled = student.enabled !== 0; // Default enabled
    const accountLabel = isEnabled ? "Active" : "Suspended";
    const accountClass = isEnabled ? "badge-status--admis" : "badge-status--ajourne";
    const toggleButtonLabel = isEnabled ? "Disable" : "Enable";
    const toggleButtonStyle = isEnabled ? "color: var(--red-600); border-color: #f5c6c2;" : "color: var(--green-700); border-color: #a3d9b1;";

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${student.code_massar || "—"}</strong></td>
      <td>${student.full_name || "—"}</td>
      <td>${student.email || "—"}</td>
      <td>${student.phone || "—"}</td>
      <td style="text-align: center;">
        <span class="badge-status ${statusClass}">${statusLabel}</span>
      </td>
      <td style="text-align: center;">
        <span class="badge-status ${accountClass}">${accountLabel}</span>
      </td>
      <td style="text-align: center; display: flex; gap: 8px; justify-content: center;">
        <button class="btn btn--ghost btn--sm edit-student-action" type="button">Edit</button>
        <button class="btn btn--ghost btn--sm toggle-student-status-action" type="button" style="${toggleButtonStyle}">${toggleButtonLabel}</button>
        <button class="btn btn--ghost btn--sm btn--danger delete-student-action" type="button">Delete</button>
      </td>
    `;

    // Hook edit action
    row.querySelector(".edit-student-action").addEventListener("click", () => {
      openStudentModal(student);
    });

    // Hook toggle status action
    row.querySelector(".toggle-student-status-action").addEventListener("click", () => {
      toggleStudentStatus(student);
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
  const confirmed = await showConfirm(
    "Delete Student",
    `Are you sure you want to delete "${student.full_name}" (${student.code_massar})? This will permanently remove all their subject grades and cannot be undone.`,
    { confirmLabel: "Delete", danger: true }
  );
  if (!confirmed) return;

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

// ── Toggle Student Account Status ─────────────────────────────────────────
async function toggleStudentStatus(student) {
  const isEnabled = student.enabled !== 0;
  const targetStatus = !isEnabled;
  const actionText = targetStatus ? "enable" : "disable";
  const confirmed = await showConfirm(
    `${targetStatus ? "Enable" : "Suspend"} Student Account`,
    `Are you sure you want to ${actionText} the account for "${student.full_name}" (${student.code_massar})?`,
    { confirmLabel: targetStatus ? "Enable" : "Suspend", danger: !targetStatus }
  );
  if (!confirmed) return;

  try {
    const response = await fetch(`${API_BASE_URL}/admin/students/${student.id}/status`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({ enabled: targetStatus })
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (response.ok) {
      showSuccess(`Successfully ${targetStatus ? "enabled" : "disabled"} student account "${student.full_name}".`);
      await loadStudents();
    } else {
      showError(data.error || `Failed to update status for student "${student.full_name}".`);
    }
  } catch (err) {
    console.error("Error toggling student status:", err);
    showError("Could not connect to the server to update the student account status.");
  }
}

// ── Release Results Notifications (SQS) ───────────────────────────────────
async function triggerReleaseResults() {
  const confirmed = await showConfirm(
    "Release Exam Results",
    "Are you sure you want to release exam results to all students? This will queue SMS and email notifications for every registered student record.",
    { confirmLabel: "Release Results", danger: false }
  );
  if (!confirmed) return;

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

// ── Fetch and Render Teachers ──────────────────────────────────────────────
async function loadTeachers() {
  try {
    loadingState.hidden = false;
    teachersCard.hidden = true;

    const response = await fetch(`${API_BASE_URL}/admin/teachers`, {
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
      teachersList = data;
      renderTeachersTable();
      loadingState.hidden = true;
      teachersCard.hidden = false;
    } else {
      const serverMessage = data.message || data.error || "Failed to load teacher directory.";
      showError(serverMessage);
      loadingState.hidden = true;
    }
  } catch (err) {
    console.error("Error loading teachers list:", err);
    showError("Could not retrieve teacher list. Please check your network connection.");
    loadingState.hidden = true;
  }
}

function renderTeachersTable() {
  teachersTbody.innerHTML = "";

  if (teachersList.length === 0) {
    const row = document.createElement("tr");
    row.innerHTML = `<td colspan="7" style="text-align: center; color: var(--neutral-600);">No teacher records found.</td>`;
    teachersTbody.appendChild(row);
    return;
  }

  teachersList.forEach(teacher => {
    const isEnabled = teacher.enabled !== 0; // Default enabled
    const accountLabel = isEnabled ? "Active" : "Suspended";
    const accountClass = isEnabled ? "badge-status--admis" : "badge-status--ajourne";
    const toggleButtonLabel = isEnabled ? "Disable" : "Enable";
    const toggleButtonStyle = isEnabled ? "color: var(--red-600); border-color: #f5c6c2;" : "color: var(--green-700); border-color: #a3d9b1;";

    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${teacher.username || "—"}</strong></td>
      <td>${teacher.full_name || "—"}</td>
      <td>${teacher.email || "—"}</td>
      <td>${teacher.phone || "—"}</td>
      <td>${teacher.subject || "—"}</td>
      <td style="text-align: center;">
        <span class="badge-status ${accountClass}">${accountLabel}</span>
      </td>
      <td style="text-align: center; display: flex; gap: 8px; justify-content: center;">
        <button class="btn btn--ghost btn--sm edit-teacher-action" type="button">Edit</button>
        <button class="btn btn--ghost btn--sm toggle-teacher-status-action" type="button" style="${toggleButtonStyle}">${toggleButtonLabel}</button>
        <button class="btn btn--ghost btn--sm btn--danger delete-teacher-action" type="button">Delete</button>
      </td>
    `;

    // Hook edit action
    row.querySelector(".edit-teacher-action").addEventListener("click", () => {
      openTeacherModal(teacher);
    });

    // Hook toggle status action
    row.querySelector(".toggle-teacher-status-action").addEventListener("click", () => {
      toggleTeacherStatus(teacher);
    });

    // Hook delete action
    row.querySelector(".delete-teacher-action").addEventListener("click", () => {
      deleteTeacher(teacher);
    });

    teachersTbody.appendChild(row);
  });
}

// ── Teacher Modal Actions ──────────────────────────────────────────────────
function openTeacherModal(teacher = null) {
  hideAlerts();
  
  if (teacher) {
    // Edit mode
    isEditTeacherMode = true;
    teacherModalTitle.textContent = "Edit Teacher Profile";
    teacherSaveBtnLabel.textContent = "Save Changes";
    teacherUsernameGroup.style.display = "none";
    teacherUsernameInput.required = false;
    teacherUsernameInput.value = teacher.username || "";
    teacherNameInput.value = teacher.full_name || "";
    teacherEmailInput.value = teacher.email || "";
    teacherPhoneInput.value = teacher.phone || "";
    teacherSubjectInput.value = teacher.subject || "";
  } else {
    // Create mode
    isEditTeacherMode = false;
    teacherModalTitle.textContent = "Add Teacher";
    teacherSaveBtnLabel.textContent = "Save Teacher";
    teacherUsernameGroup.style.display = "flex";
    teacherUsernameInput.required = true;
    teacherUsernameInput.value = "";
    teacherNameInput.value = "";
    teacherEmailInput.value = "";
    teacherPhoneInput.value = "";
    teacherSubjectInput.value = "";
  }

  teacherModalBackdrop.style.display = "flex";
  if (!teacher) {
    teacherUsernameInput.focus();
  } else {
    teacherNameInput.focus();
  }
}

function closeTeacherModal() {
  teacherModalBackdrop.style.display = "none";
}

function setTeacherModalLoading(loading) {
  teacherModalSaveBtn.disabled = loading;
  teacherModalCancelBtn.disabled = loading;
  teacherModalCloseBtn.disabled = loading;
  teacherSaveBtnLabel.textContent = loading ? "Saving..." : (isEditTeacherMode ? "Save Changes" : "Save Teacher");
  teacherSaveBtnSpinner.hidden = !loading;
}

function showTeacherModalError(message) {
  teacherModalErrorText.textContent = message;
  teacherModalErrorAlert.hidden = false;
}

// ── Teacher Form Submission ─────────────────────────────────────────────────
teacherForm.addEventListener("submit", async function (e) {
  e.preventDefault();
  hideAlerts();

  const username = teacherUsernameInput.value.trim();
  const name  = teacherNameInput.value.trim();
  const email = teacherEmailInput.value.trim();
  const phone = teacherPhoneInput.value.trim();
  const subject = teacherSubjectInput.value;

  if ((!isEditTeacherMode && !username) || !name || !email || !phone || !subject) {
    showTeacherModalError("All profile fields are required.");
    return;
  }

  setTeacherModalLoading(true);

  try {
    const url = isEditTeacherMode ? `${API_BASE_URL}/admin/teachers/${username}` : `${API_BASE_URL}/admin/teachers`;
    const method = isEditTeacherMode ? "PUT" : "POST";

    const response = await fetch(url, {
      method: method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        username: username,
        full_name: name,
        email: email,
        phone: phone,
        subject: subject
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
      const successMsg = isEditTeacherMode 
        ? `Successfully updated teacher profile for ${name}.` 
        : `Successfully created teacher ${name} with password Massar2024!.`;
      
      showSuccess(successMsg);
      closeTeacherModal();
      await loadTeachers();
    } else {
      showTeacherModalError(data.error || "Failed to process teacher profile request.");
    }
  } catch (err) {
    console.error("Error submitting teacher form:", err);
    showTeacherModalError("Failed to connect to the server. Please verify connection.");
  } finally {
    setTeacherModalLoading(false);
  }
});

// ── Delete Teacher Record ──────────────────────────────────────────────────
async function deleteTeacher(teacher) {
  const confirmed = await showConfirm(
    "Delete Teacher",
    `Are you sure you want to delete "${teacher.full_name}" (@${teacher.username})? This will also remove their Cognito account and cannot be undone.`,
    { confirmLabel: "Delete", danger: true }
  );
  if (!confirmed) return;

  try {
    const response = await fetch(`${API_BASE_URL}/admin/teachers/${teacher.username}`, {
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
      showSuccess(`Successfully deleted teacher "${teacher.full_name}".`);
      await loadTeachers();
    } else {
      showError(data.error || `Failed to delete teacher "${teacher.full_name}".`);
    }
  } catch (err) {
    console.error("Error deleting teacher:", err);
    showError("Could not connect to the server to delete the teacher.");
  }
}

// ── Toggle Teacher Account Status ─────────────────────────────────────────
async function toggleTeacherStatus(teacher) {
  const isEnabled = teacher.enabled !== 0;
  const targetStatus = !isEnabled;
  const actionText = targetStatus ? "enable" : "disable";
  const confirmed = await showConfirm(
    `${targetStatus ? "Enable" : "Suspend"} Teacher Account`,
    `Are you sure you want to ${actionText} the account for "${teacher.full_name}" (@${teacher.username})?`,
    { confirmLabel: targetStatus ? "Enable" : "Suspend", danger: !targetStatus }
  );
  if (!confirmed) return;

  try {
    const response = await fetch(`${API_BASE_URL}/admin/teachers/${teacher.username}/status`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify({ enabled: targetStatus })
    });

    if (response.status === 401 || response.status === 403) {
      handleSessionExpiry();
      return;
    }

    let data = {};
    try {
      data = await response.json();
    } catch (_) {}

    if (response.ok) {
      showSuccess(`Successfully ${targetStatus ? "enabled" : "disabled"} teacher account "${teacher.full_name}".`);
      await loadTeachers();
    } else {
      showError(data.error || `Failed to update status for teacher "${teacher.full_name}".`);
    }
  } catch (err) {
    console.error("Error toggling teacher status:", err);
    showError("Could not connect to the server to update the teacher account status.");
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

// Teacher Actions
addTeacherBtn.addEventListener("click", () => {
  openTeacherModal();
});

teacherModalCloseBtn.addEventListener("click", closeTeacherModal);
teacherModalCancelBtn.addEventListener("click", closeTeacherModal);

teacherModalBackdrop.addEventListener("click", function (e) {
  if (e.target === teacherModalBackdrop) {
    closeTeacherModal();
  }
});

// Tab Switches
tabStudents.addEventListener("click", () => {
  if (activeTab === "students") return;
  activeTab = "students";
  tabStudents.classList.add("tab-btn--active");
  tabTeachers.classList.remove("tab-btn--active");
  studentsTabContent.style.display = "block";
  teachersTabContent.style.display = "none";
  loadStudents();
});

tabTeachers.addEventListener("click", () => {
  if (activeTab === "teachers") return;
  activeTab = "teachers";
  tabTeachers.classList.add("tab-btn--active");
  tabStudents.classList.remove("tab-btn--active");
  teachersTabContent.style.display = "block";
  studentsTabContent.style.display = "none";
  loadTeachers();
});

logoutBtn.addEventListener("click", () => {
  handleSessionExpiry();
});

// Run load on start
loadStudents();
