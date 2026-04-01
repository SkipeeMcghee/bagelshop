const BACKEND_BASE = "http://127.0.0.1:5000";
const API_BASE = `${BACKEND_BASE}/api`;

const signInForm = document.getElementById("sign-in-form");
const createAccountForm = document.getElementById("create-account-form");
const continueWithGoogleButton = document.getElementById("continue-with-google");

function clearFeedback() {
    for (const element of document.querySelectorAll(".feedback-message")) {
        element.textContent = "";
        element.classList.remove("success", "error");
    }
}

function setFeedback(id, message, type = "success") {
    const element = document.getElementById(id);
    if (!element) {
        return;
    }
    element.textContent = message;
    element.classList.remove("success", "error");
    element.classList.add(type);
}

function redirectToAccount() {
    window.location.href = "account.html";
}

async function apiRequest(path, options = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        credentials: "include",
        headers: {
            "Content-Type": "application/json",
            ...(options.headers || {}),
        },
        ...options,
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(data?.error || "Request failed");
    }
    return data;
}

async function checkExistingSession() {
    try {
        const data = await apiRequest("/me", { method: "GET" });
        if (data?.authenticated) {
            redirectToAccount();
        }
    } catch (error) {
        // Stay on auth page if not signed in.
    }
}

function showOAuthErrorFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    if (!error) {
        return;
    }

    const messages = {
        google_not_configured: "Google sign-in is not configured yet on the backend.",
        google_redirect_uri_invalid: "The backend Google redirect URI is not configured correctly.",
        invalid_google_state: "The Google sign-in session expired. Please try again.",
        missing_google_code: "Google did not return an authorization code.",
        google_token_exchange_failed: "Google sign-in failed during token exchange.",
        google_profile_incomplete: "Google did not return the profile information required to sign in.",
        access_denied: "Google sign-in was cancelled or denied.",
    };
    setFeedback("sign-in-message", messages[error] || "Google sign-in failed.", "error");
    window.history.replaceState({}, document.title, window.location.pathname);
}

signInForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    const formData = new FormData(signInForm);
    try {
        await apiRequest("/auth/login", {
            method: "POST",
            body: JSON.stringify({
                email: String(formData.get("email") || "").trim(),
                password: String(formData.get("password") || ""),
            }),
        });
        redirectToAccount();
    } catch (error) {
        setFeedback("sign-in-message", String(error.message || error), "error");
    }
});

createAccountForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    const formData = new FormData(createAccountForm);
    const password = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirm_password") || "");

    if (password !== confirmPassword) {
        setFeedback("create-account-message", "Passwords do not match.", "error");
        return;
    }

    try {
        await apiRequest("/auth/register", {
            method: "POST",
            body: JSON.stringify({
                name: String(formData.get("name") || "").trim(),
                email: String(formData.get("email") || "").trim(),
                password,
            }),
        });
        redirectToAccount();
    } catch (error) {
        setFeedback("create-account-message", String(error.message || error), "error");
    }
});

continueWithGoogleButton.addEventListener("click", () => {
    window.location.href = `${BACKEND_BASE}/auth/google/start`;
});

checkExistingSession();
showOAuthErrorFromUrl();