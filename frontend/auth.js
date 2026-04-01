const ACCOUNT_STORAGE_KEY = "bagelshopAccount";
const REGISTERED_ACCOUNT_STORAGE_KEY = "bagelshopRegisteredAccount";
const DEFAULT_PROFILE_IMAGE = "../assets/images/profilepicblank.png";

const signInForm = document.getElementById("sign-in-form");
const createAccountForm = document.getElementById("create-account-form");
const continueWithGoogleButton = document.getElementById("continue-with-google");

function getSavedAccount() {
    try {
        const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
}

function getRegisteredAccount() {
    try {
        const raw = localStorage.getItem(REGISTERED_ACCOUNT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
}

function saveSessionAccount(account) {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

function saveRegisteredAccount(account) {
    localStorage.setItem(REGISTERED_ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

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

const existingSession = getSavedAccount();
if (existingSession) {
    redirectToAccount();
}

signInForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFeedback();

    const registered = getRegisteredAccount();
    const formData = new FormData(signInForm);
    const username = String(formData.get("username") || "").trim();
    const password = String(formData.get("password") || "");

    if (!registered || registered.authMethod !== "local") {
        setFeedback("sign-in-message", "No local account has been created in this browser yet.", "error");
        return;
    }

    const usernameMatches = username === registered.username || username === registered.email;
    if (!usernameMatches || password !== registered.password) {
        setFeedback("sign-in-message", "Incorrect username/email or password.", "error");
        return;
    }

    saveSessionAccount({ ...registered, password: undefined });
    redirectToAccount();
});

createAccountForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFeedback();

    const formData = new FormData(createAccountForm);
    const username = String(formData.get("username") || "").trim();
    const email = String(formData.get("email") || "").trim();
    const password = String(formData.get("password") || "");
    const confirmPassword = String(formData.get("confirm_password") || "");

    if (!username) {
        setFeedback("create-account-message", "Username is required.", "error");
        return;
    }

    if (password.length < 6) {
        setFeedback("create-account-message", "Use at least 6 characters for the password.", "error");
        return;
    }

    if (password !== confirmPassword) {
        setFeedback("create-account-message", "Passwords do not match.", "error");
        return;
    }

    const nextAccount = {
        authMethod: "local",
        username,
        displayName: username,
        email,
        phone: "",
        profileImageUrl: DEFAULT_PROFILE_IMAGE,
        linkedCustomerId: "",
        hasPassword: true,
        password,
        passwordUpdatedAt: new Date().toISOString(),
    };

    saveRegisteredAccount(nextAccount);
    saveSessionAccount({ ...nextAccount, password: undefined });
    redirectToAccount();
});

continueWithGoogleButton.addEventListener("click", () => {
    clearFeedback();

    const nextAccount = {
        authMethod: "google",
        username: "googleuser",
        displayName: "Google User",
        email: "google.user@example.com",
        phone: "",
        profileImageUrl: DEFAULT_PROFILE_IMAGE,
        linkedCustomerId: "",
        hasPassword: false,
    };

    saveSessionAccount(nextAccount);
    redirectToAccount();
});