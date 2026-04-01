const API_BASE = "http://127.0.0.1:5000/api";
const ACCOUNT_STORAGE_KEY = "bagelshopAccount";
const REGISTERED_ACCOUNT_STORAGE_KEY = "bagelshopRegisteredAccount";
const DEFAULT_PROFILE_IMAGE = "../assets/images/profilepicblank.png";

const accountProfileImage = document.getElementById("account-profile-image");
const accountDisplayName = document.getElementById("account-display-name");
const accountSummaryText = document.getElementById("account-summary-text");
const accountDetailsForm = document.getElementById("account-details-form");
const passwordResetForm = document.getElementById("password-reset-form");
const signOutButton = document.getElementById("sign-out-button");
const refreshOrdersButton = document.getElementById("refresh-orders");
const ordersStatus = document.getElementById("orders-status");
const ordersList = document.getElementById("orders-list");

function getSavedAccount() {
    try {
        const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
}

function saveAccount(account) {
    localStorage.setItem(ACCOUNT_STORAGE_KEY, JSON.stringify(account));
}

function getRegisteredAccount() {
    try {
        const raw = localStorage.getItem(REGISTERED_ACCOUNT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
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

function getAccountSummary(account) {
    if (!account) {
        return {
            title: "Guest",
            text: "Create an account or preview Google sign-in to personalize your bagel orders.",
            image: DEFAULT_PROFILE_IMAGE,
        };
    }

    const authLabel = account.authMethod === "google" ? "Signed in with Google" : "Signed in with a local account";
    return {
        title: account.displayName || account.username || "Account",
        text: `${authLabel}. Update your profile details, reset your password, and review your past orders here.`,
        image: account.profileImageUrl || DEFAULT_PROFILE_IMAGE,
    };
}

function populateForms(account) {
    accountDetailsForm.elements.display_name.value = account?.displayName || "";
    accountDetailsForm.elements.username.value = account?.username || "";
    accountDetailsForm.elements.email.value = account?.email || "";
    accountDetailsForm.elements.phone.value = account?.phone || "";
    accountDetailsForm.elements.profile_image_url.value = account?.profileImageUrl || "";
    accountDetailsForm.elements.linked_customer_id.value = account?.linkedCustomerId || "";
}

function requireAccount() {
    const account = getSavedAccount();
    if (!account) {
        window.location.href = "auth.html";
        return null;
    }
    return account;
}

function renderSummary() {
    const account = getSavedAccount();
    const summary = getAccountSummary(account);

    accountDisplayName.textContent = summary.title;
    accountSummaryText.textContent = summary.text;
    accountProfileImage.src = summary.image;
    populateForms(account);
}

function renderEmptyOrders(message) {
    ordersStatus.textContent = message;
    ordersList.innerHTML = `<div class="empty-state">${message}</div>`;
}

function moneyFromCents(cents) {
    return `$${(Number(cents) / 100).toFixed(2)}`;
}

function createOrderCard(order) {
    const article = document.createElement("article");
    article.className = "order-card";

    const header = document.createElement("div");
    header.className = "order-card-header";

    const titleBlock = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = `Order #${order.id}`;
    const meta = document.createElement("p");
    meta.className = "order-meta";
    meta.textContent = `${order.created_at || ""} · ${order.payment_status || "pending"}`;
    titleBlock.append(title, meta);

    const total = document.createElement("span");
    total.className = "price-pill";
    total.textContent = moneyFromCents(order.total_cents);

    header.append(titleBlock, total);
    article.appendChild(header);

    const items = document.createElement("ul");
    items.className = "order-items";

    for (const item of order.items || []) {
        const li = document.createElement("li");
        li.textContent = `${item.quantity} × ${item.menu_item_name} — ${moneyFromCents(item.line_total_cents)}`;
        items.appendChild(li);
    }

    if (items.childElementCount > 0) {
        article.appendChild(items);
    }

    return article;
}

async function loadPastOrders() {
    const account = getSavedAccount();
    const linkedCustomerId = Number(account?.linkedCustomerId || 0);

    if (!account) {
        renderEmptyOrders("Sign in first to start collecting account details and order history.");
        return;
    }

    if (!linkedCustomerId) {
        renderEmptyOrders("Add your existing customer ID above, then refresh orders to see matching purchases.");
        return;
    }

    ordersStatus.textContent = "Loading your orders...";
    ordersList.innerHTML = "";

    try {
        const response = await fetch(`${API_BASE}/orders`);
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data?.error || "request failed");
        }

        const matchingOrders = (Array.isArray(data) ? data : []).filter(
            (order) => Number(order.customer_id) === linkedCustomerId,
        );

        if (matchingOrders.length === 0) {
            renderEmptyOrders("No past orders match that customer ID yet.");
            return;
        }

        ordersStatus.textContent = `${matchingOrders.length} past order${matchingOrders.length === 1 ? "" : "s"} found.`;
        for (const order of matchingOrders) {
            ordersList.appendChild(createOrderCard(order));
        }
    } catch (error) {
        renderEmptyOrders(`Could not load orders: ${error}`);
    }
}

accountDetailsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFeedback();

    const existing = getSavedAccount() || { authMethod: "local", hasPassword: false };
    const formData = new FormData(accountDetailsForm);

    const nextAccount = {
        ...existing,
        displayName: String(formData.get("display_name") || "").trim(),
        username: String(formData.get("username") || "").trim(),
        email: String(formData.get("email") || "").trim(),
        phone: String(formData.get("phone") || "").trim(),
        profileImageUrl: String(formData.get("profile_image_url") || "").trim() || DEFAULT_PROFILE_IMAGE,
        linkedCustomerId: String(formData.get("linked_customer_id") || "").trim(),
    };

    saveAccount(nextAccount);
    if (nextAccount.authMethod === "local") {
        const registered = getRegisteredAccount();
        saveRegisteredAccount({
            ...(registered || {}),
            ...nextAccount,
            password: registered?.password || "",
        });
    }
    renderSummary();
    loadPastOrders();
    setFeedback("account-details-message", "Account details updated.");
});

passwordResetForm.addEventListener("submit", (event) => {
    event.preventDefault();
    clearFeedback();

    const account = getSavedAccount();
    if (!account) {
        setFeedback("password-reset-message", "Create or preview an account before resetting a password.", "error");
        return;
    }

    if (account.authMethod === "google") {
        setFeedback("password-reset-message", "Google sign-in uses Google credentials, so there is no local password to reset here.", "error");
        return;
    }

    const formData = new FormData(passwordResetForm);
    const newPassword = String(formData.get("new_password") || "");
    const confirmPassword = String(formData.get("confirm_new_password") || "");

    if (newPassword.length < 6) {
        setFeedback("password-reset-message", "Use at least 6 characters for the new password.", "error");
        return;
    }

    if (newPassword !== confirmPassword) {
        setFeedback("password-reset-message", "New passwords do not match.", "error");
        return;
    }

    saveAccount({
        ...account,
        hasPassword: true,
        passwordUpdatedAt: new Date().toISOString(),
    });

    const registered = getRegisteredAccount();
    if (registered && registered.authMethod === "local") {
        saveRegisteredAccount({
            ...registered,
            password: newPassword,
            passwordUpdatedAt: new Date().toISOString(),
        });
    }

    passwordResetForm.reset();
    setFeedback("password-reset-message", "Password reset for this browser preview.");
});

signOutButton.addEventListener("click", () => {
    localStorage.removeItem(ACCOUNT_STORAGE_KEY);
    passwordResetForm.reset();
    clearFeedback();
    window.location.href = "auth.html";
});

refreshOrdersButton.addEventListener("click", loadPastOrders);

if (requireAccount()) {
    renderSummary();
    loadPastOrders();
}