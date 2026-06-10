/* =============================================================
   login.js — Massar Portal Login Logic
   POST /login → store access_token → redirect to results.html
   ============================================================= */

/// API base URL — replace with your actual CloudFront 
const API_BASE_URL = "/api";

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
  if (btnSpinner) {
    btnSpinner.hidden = !loading;
  }
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
      UserPoolId: "eu-south-1_3QYn6cnDA",
      ClientId: "2qh5hv6o7jk4eei2gnrv0q9ail"
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

    const targetRoute = await new Promise((resolve, reject) => {
      cognitoUser.authenticateUser(authDetails, {
        onSuccess: (result) => {
          const idToken = result.getIdToken().getJwtToken();
          sessionStorage.setItem("access_token", result.getAccessToken().getJwtToken());
          sessionStorage.setItem("id_token", idToken);
          sessionStorage.setItem("refresh_token", result.getRefreshToken().getToken());

          let route = "results.html";
          try {
            const base64Url = idToken.split('.')[1];
            const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
            const pad = base64.length % 4;
            const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
            const payload = JSON.parse(atob(padded));
            
            const groups = payload["cognito:groups"] || [];
            if (groups.includes("admins")) {
              route = "admin.html";
            } else if (groups.includes("teachers")) {
              route = "teacher.html";
            }
          } catch (e) {
            console.error("Error parsing ID token:", e);
          }
          resolve(route);
        },
        onFailure: (err) => {
          reject(err);
        }
      });
    });

    window.location.replace(targetRoute);
  } catch (networkError) {
    console.error("Network error during login:", networkError);
    showError("Your Massar Code or password is incorrect. Please try again.");
  } finally {
    setLoading(false);
  }
});

// Clear error on input change
usernameInput.addEventListener("input", hideError);
passwordInput.addEventListener("input", hideError);
