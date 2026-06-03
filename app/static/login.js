/* =============================================================
   login.js — Massar Portal Login Logic
   POST /login → store access_token → redirect to results.html
   ============================================================= */

/// API base URL — replace with your actual CloudFront 
const API_BASE_URL = "https://d7w3mygjx3srq.cloudfront.net";

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

// ── Redirect if already authenticated ────────────────────────
if (sessionStorage.getItem("access_token")) {
  window.location.replace("results.html");
}

// ── Password visibility toggle ───────────────────────────────
passwordToggle.addEventListener("click", function () {
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  this.setAttribute("aria-pressed", isPassword);
  const icon = document.getElementById("eye-icon");
  icon.style.opacity = isPassword ? "0.5" : "1";
});

// ── Helpers ──────────────────────────────────────────────────

/**
 * Show an error banner with the given message.
 * @param {string} message
 */
function showError(message) {
  errorMsgText.textContent = message;
  errorMsg.hidden = false;
  errorMsg.focus();
}

/** Hide the error banner. */
function hideError() {
  errorMsg.hidden = true;
  errorMsgText.textContent = "";
}

/**
 * Set loading state on the submit button.
 * @param {boolean} loading
 */
function setLoading(loading) {
  submitBtn.disabled = loading;
  btnLabel.textContent = loading ? "Authenticating..." : "Log In";
  btnSpinner.hidden = !loading;
}

// ── Form Submit Handler ───────────────────────────────────────
form.addEventListener("submit", async function (event) {
  event.preventDefault();
  hideError();

  const username = usernameInput.value.trim();
  const password = passwordInput.value;

  // Basic client-side validation
  if (!username || !password) {
    showError("Please enter your Massar Code and password.");
    return;
  }

  setLoading(true);

  try {
    const userPool = new AmazonCognitoIdentity.CognitoUserPool({
      UserPoolId: "eu-south-1_X8QQOtXmF",
      ClientId: "4pi2acv9r8a14vnpjbvdf5egjb"
    });

    const authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
      Username: username,
      Password: password
    });

    const cognitoUser = new AmazonCognitoIdentity.CognitoUser({
      Username: username,
      Pool: userPool
    });

    cognitoUser.setAuthenticationFlowType('USER_PASSWORD_AUTH');

    const isTeacher = await new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (result) => {
          const idToken = result.getIdToken().getJwtToken();
          sessionStorage.setItem("access_token", result.getAccessToken().getJwtToken());
          sessionStorage.setItem("id_token", idToken);
          sessionStorage.setItem("refresh_token", result.getRefreshToken().getToken());

          let isTeacherRole = false;
          try {
            const payload = JSON.parse(atob(idToken.split('.')[1]));
            const groups = payload["cognito:groups"] || [];
            if (groups.includes("teachers")) {
              isTeacherRole = true;
            }
          } catch (e) {
            console.error("Error parsing ID token:", e);
          }
          resolve(isTeacherRole);
        },
        onFailure: (err) => {
          reject(err);
        }
      });
    });

    if (isTeacher) {
      window.location.replace("teacher.html");
    } else {
      window.location.replace("results.html");
    }
  } catch (networkError) {
    console.error("Network error during login:", networkError);
    showError("Failed to connect to the server. Please check your internet connection and try again.");
  } finally {
    setLoading(false);
  }
});

// Clear error on input change
usernameInput.addEventListener("input", hideError);
passwordInput.addEventListener("input", hideError);
