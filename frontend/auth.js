const LOCAL_BACKEND_BASE = "http://127.0.0.1:5000";
const BACKEND_BASE =
    window.location.protocol === "file:" || ["127.0.0.1:5501", "localhost:5501"].includes(window.location.host)
        ? LOCAL_BACKEND_BASE
        : window.location.origin;
const API_BASE = `${BACKEND_BASE}/api`;

const signInForm = document.getElementById("sign-in-form");
const createAccountForm = document.getElementById("create-account-form");
const continueWithGoogleButton = document.getElementById("continue-with-google");
const resendVerificationButton = document.getElementById("resend-verification-button");
const verificationStatusMessage = document.getElementById("verification-status-message");
const recaptchaSlot = document.getElementById("recaptcha-slot");

let authConfig = {
    recaptcha_enabled: false,
    recaptcha_site_key: "",
    recaptcha_mode: "disabled",
    email_verification_required: true,
};
let pendingVerificationEmail = "";
let recaptchaScriptLoadingPromise = null;

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
    const params = new URLSearchParams(window.location.search);
    const next = String(params.get("next") || "").trim().toLowerCase();
    if (next === "contact") {
        window.location.href = "contact.html";
        return;
    }
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
        const error = new Error(data?.error || "Request failed");
        error.data = data;
        throw error;
    }
    return data;
}

function setVerificationStatus(message, type = "success") {
    if (!verificationStatusMessage) {
        return;
    }
    verificationStatusMessage.textContent = message;
    verificationStatusMessage.classList.remove("success", "error");
    if (message) {
        verificationStatusMessage.classList.add(type);
    }
}

function updateResendButtonVisibility() {
    if (!resendVerificationButton) {
        return;
    }
    resendVerificationButton.hidden = !pendingVerificationEmail;
}

async function getRecaptchaToken() {
    if (!authConfig.recaptcha_enabled) {
        return "";
    }
    if (authConfig.recaptcha_mode !== "v3") {
        return "";
    }
    await loadRecaptcha(authConfig.recaptcha_site_key);
    if (!window.grecaptcha) {
        return "";
    }
    return window.grecaptcha.execute(authConfig.recaptcha_site_key, { action: "register" });
}

function loadRecaptcha(siteKey) {
    if (!recaptchaSlot || !siteKey) {
        return Promise.resolve();
    }

    recaptchaSlot.hidden = false;
    recaptchaSlot.textContent = "Protected by reCAPTCHA v3.";

    if (window.grecaptcha) {
        return Promise.resolve();
    }

    if (recaptchaScriptLoadingPromise) {
        return recaptchaScriptLoadingPromise;
    }

    recaptchaScriptLoadingPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
        script.async = true;
        script.defer = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Could not load reCAPTCHA."));
        document.head.appendChild(script);
    });

    return recaptchaScriptLoadingPromise;
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

async function loadAuthConfig() {
    try {
        authConfig = await apiRequest("/auth/config", { method: "GET" });
        if (authConfig.recaptcha_enabled && authConfig.recaptcha_site_key) {
            await loadRecaptcha(authConfig.recaptcha_site_key);
        }
    } catch (error) {
        authConfig = {
            recaptcha_enabled: false,
            recaptcha_site_key: "",
            recaptcha_mode: "disabled",
            email_verification_required: true,
        };
    }
}

function showOAuthErrorFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get("error");
    const verified = params.get("verified");
    const verifiedEmail = params.get("email");

    if (verified === "1") {
        setFeedback("sign-in-message", "Email verified. You can sign in now.", "success");
        if (verifiedEmail && signInForm?.elements.email) {
            signInForm.elements.email.value = verifiedEmail;
        }
    }

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
        missing_verification_token: "The email verification link is missing its token.",
        invalid_verification_token: "That verification link is invalid or has already been used.",
        verification_link_expired: "That verification link has expired. Request a new one and try again.",
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
        pendingVerificationEmail = String(formData.get("email") || "").trim();
        if (!error.data?.verification_required) {
            pendingVerificationEmail = "";
        }
        updateResendButtonVisibility();
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
        const recaptchaToken = await getRecaptchaToken();
        if (authConfig.recaptcha_enabled && !recaptchaToken) {
            setFeedback("create-account-message", "reCAPTCHA verification could not be completed. Please try again.", "error");
            return;
        }
        const email = String(formData.get("email") || "").trim();
        const data = await apiRequest("/auth/register", {
            method: "POST",
            body: JSON.stringify({
                name: String(formData.get("name") || "").trim(),
                email,
                password,
                recaptcha_token: recaptchaToken,
            }),
        });
        createAccountForm.reset();

        if (data?.verification_required) {
            pendingVerificationEmail = email;
            updateResendButtonVisibility();
            const consoleNote = data.delivery === "console"
                ? " Email delivery is in console mode, so check the backend log for the verification link."
                : "";
            setVerificationStatus(`Account created. Check your email for a verification link.${consoleNote}`, "success");
            setFeedback("create-account-message", "Verification email sent.", "success");
            if (signInForm?.elements.email) {
                signInForm.elements.email.value = email;
            }
            return;
        }

        redirectToAccount();
    } catch (error) {
        setFeedback("create-account-message", String(error.message || error), "error");
    }
});

resendVerificationButton.addEventListener("click", async () => {
    clearFeedback();
    setVerificationStatus("");
    if (!pendingVerificationEmail) {
        setFeedback("sign-in-message", "Enter your email and try signing in first if you need a new verification email.", "error");
        return;
    }

    try {
        const data = await apiRequest("/auth/resend-verification", {
            method: "POST",
            body: JSON.stringify({ email: pendingVerificationEmail }),
        });
        const consoleNote = data.delivery === "console"
            ? " Check the backend log for the verification link."
            : "";
        setFeedback("sign-in-message", `${data.message || "Verification email sent."}${consoleNote}`, "success");
    } catch (error) {
        setFeedback("sign-in-message", String(error.message || error), "error");
    }
});

continueWithGoogleButton.addEventListener("click", () => {
    window.location.href = `${BACKEND_BASE}/auth/google/start`;
});

loadAuthConfig();
checkExistingSession();
showOAuthErrorFromUrl();