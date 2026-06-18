/* =============================================================
   login.js — Massar Portal Login Logic
   Role-aware: reads window.PORTAL_ROLE set by each HTML page.
   Validates the user belongs to the correct portal role before
   granting access and redirecting.
   ============================================================= */

// Role configuration — each portal defines its target page,
// the Cognito group check, and the wrong-portal error message.
const ROLE_CONFIG = {
  student: {
    redirectTo:  "results.html",
    groupCheck:  (groups) => !groups.includes("admins") && !groups.includes("teachers"),
    errorMsg:    "This portal is for students only. Please use the correct login page for your role.",
    placeholder: "e.g. K130029841",
  },
  teacher: {
    redirectTo:  "teacher.html",
    groupCheck:  (groups) => groups.includes("teachers"),
    errorMsg:    "This portal is for teachers only. Please use the Teacher Portal login page.",
    placeholder: "e.g. t.bennani",
  },
  admin: {
    redirectTo:  "admin.html",
    groupCheck:  (groups) => groups.includes("admins"),
    errorMsg:    "This portal is for administrators only. Access denied.",
    placeholder: "Enter admin username",
  },
};

const role   = window.PORTAL_ROLE || "student";
const config = ROLE_CONFIG[role] || ROLE_CONFIG.student;

// DOM references
const form           = document.getElementById("login-form");
const usernameInput  = document.getElementById("username");
const passwordInput  = document.getElementById("password");
const submitBtn      = document.getElementById("submit-btn");
const btnLabel       = document.getElementById("btn-label");
const btnSpinner     = document.getElementById("btn-spinner");
const errorMsg       = document.getElementById("error-msg");
const errorMsgText   = document.getElementById("error-msg-text");
const passwordToggle = document.getElementById("password-toggle");

// Apply role-specific placeholder to username field
if (usernameInput) usernameInput.placeholder = config.placeholder;

// ── JWT Decoder ───────────────────────────────────────────────
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

// ── Redirect if already authenticated for this portal ─────────
const existingToken   = sessionStorage.getItem("access_token");
const existingIdToken = sessionStorage.getItem("id_token");
if (existingToken && existingIdToken) {
  const payload = decodeJwt(existingIdToken);
  if (payload) {
    const groups = payload["cognito:groups"] || [];
    if (config.groupCheck(groups)) {
      window.location.replace(config.redirectTo);
    }
  }
}

// ── Password visibility toggle ────────────────────────────────
passwordToggle.addEventListener("click", function () {
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  this.setAttribute("aria-pressed", isPassword);
  const icon = document.getElementById("eye-icon");
  icon.style.opacity = isPassword ? "0.5" : "1";
});

// ── Helpers ───────────────────────────────────────────────────
function showError(message) {
  errorMsgText.textContent = message;
  errorMsg.hidden = false;
  errorMsg.focus();
}

function hideError() {
  errorMsg.hidden = true;
  errorMsgText.textContent = "";
}

function setLoading(loading) {
  submitBtn.disabled = loading;
  btnLabel.textContent = loading ? "Authenticating..." : "Log In";
  if (btnSpinner) btnSpinner.hidden = !loading;
}

// ── Form Submit Handler ────────────────────────────────────────
form.addEventListener("submit", async function (event) {
  event.preventDefault();
  hideError();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  if (!username || !password) {
    showError("Please enter your credentials.");
    return;
  }

  setLoading(true);

  try {
    const userPool = new AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: import.meta.env.VITE_COGNITO_USER_POOL_ID,
      ClientId:   import.meta.env.VITE_COGNITO_CLIENT_ID
    });

    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
      Username: username,
      Password: password
    });

    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: username,
      Pool: userPool
    });

    cognitoUser.setAuthenticationFlowType("USER_PASSWORD_AUTH");

    await new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (result) => {
          const idToken = result.getIdToken().getJwtToken();
          const payload = decodeJwt(idToken);
          const groups  = (payload && payload["cognito:groups"]) || [];

          // Reject if the user's role does not match this portal
          if (!config.groupCheck(groups)) {
            sessionStorage.clear();
            reject({ code: "WrongPortal" });
            return;
          }

          sessionStorage.setItem("access_token",  result.getAccessToken().getJwtToken());
          sessionStorage.setItem("id_token",      idToken);
          sessionStorage.setItem("refresh_token", result.getRefreshToken().getToken());
          resolve();
        },
        onFailure: (err) => reject(err),
      });
    });

    window.location.replace(config.redirectTo);

  } catch (err) {
    if (err.code === "WrongPortal") {
      showError(config.errorMsg);
    } else if (err?.code === "NotAuthorizedException" && err.message?.toLowerCase().includes("disabled")) {
      showError("Your account has been suspended. Please contact the administrator.");
    } else {
      showError("Your credentials are incorrect. Please try again.");
    }
  } finally {
    setLoading(false);
  }
});

// Clear error on input change
usernameInput.addEventListener("input", hideError);
passwordInput.addEventListener("input", hideError);
