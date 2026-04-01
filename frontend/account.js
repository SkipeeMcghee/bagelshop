const BACKEND_BASE = "http://127.0.0.1:5000";
const API_BASE = `${BACKEND_BASE}/api`;
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
let currentUser = null;

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
            text: "Sign in to manage your profile and view your orders.",
            image: DEFAULT_PROFILE_IMAGE,
        };
    }

    const authLabel = account.auth_provider === "google" ? "Signed in with Google" : "Signed in with a local account";
    return {
        title: account.display_name || account.username || "Account",
        text: `${authLabel}. Update your profile details, reset your password, and review your past orders here.`,
        image: account.profile_image_url || DEFAULT_PROFILE_IMAGE,
    };
}

function populateForms(account) {
    accountDetailsForm.elements.display_name.value = account?.display_name || "";
    accountDetailsForm.elements.username.value = account?.username || "";
    accountDetailsForm.elements.email.value = account?.email || "";
    accountDetailsForm.elements.phone.value = account?.phone || "";
    accountDetailsForm.elements.profile_image_url.value = account?.profile_image_url || "";
    accountDetailsForm.elements.linked_customer_id.value = account?.customer_id || "";
}

function renderSummary(account) {
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
    if (!currentUser) {
        renderEmptyOrders("Sign in first to start collecting account details and order history.");
        return;
    }

    ordersStatus.textContent = "Loading your orders...";
    ordersList.innerHTML = "";

    try {
        const matchingOrders = await apiRequest("/my/orders", { method: "GET" });

        if (matchingOrders.length === 0) {
            renderEmptyOrders("No past orders yet.");
            return;
        }

        ordersStatus.textContent = `${matchingOrders.length} past order${matchingOrders.length === 1 ? "" : "s"} found.`;
        for (const order of matchingOrders) {
            ordersList.appendChild(createOrderCard(order));
        }
    } catch (error) {
        renderEmptyOrders(`Could not load orders: ${error.message || error}`);
    }
}

accountDetailsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    const formData = new FormData(accountDetailsForm);
    try {
        const data = await apiRequest("/me", {
            method: "POST",
            body: JSON.stringify({
                display_name: String(formData.get("display_name") || "").trim(),
                username: String(formData.get("username") || "").trim(),
                email: String(formData.get("email") || "").trim(),
                phone: String(formData.get("phone") || "").trim(),
                profile_image_url:
                    String(formData.get("profile_image_url") || "").trim() || DEFAULT_PROFILE_IMAGE,
            }),
        });
        currentUser = data.user;
        renderSummary(currentUser);
        setFeedback("account-details-message", "Account details updated.");
    } catch (error) {
        setFeedback("account-details-message", String(error.message || error), "error");
    }
});

passwordResetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    if (!currentUser) {
        setFeedback("password-reset-message", "Sign in before resetting a password.", "error");
        return;
    }

    if (currentUser.auth_provider === "google") {
        setFeedback("password-reset-message", "Google sign-in uses Google credentials, so there is no local password to reset here.", "error");
        return;
    }

    const formData = new FormData(passwordResetForm);
    const currentPassword = String(formData.get("current_password") || "");
    const newPassword = String(formData.get("new_password") || "");
    const confirmPassword = String(formData.get("confirm_new_password") || "");

    if (newPassword !== confirmPassword) {
        setFeedback("password-reset-message", "New passwords do not match.", "error");
        return;
    }

    try {
        await apiRequest("/me/password", {
            method: "POST",
            body: JSON.stringify({
                current_password: currentPassword,
                new_password: newPassword,
            }),
        });
        passwordResetForm.reset();
        setFeedback("password-reset-message", "Password updated.");
    } catch (error) {
        setFeedback("password-reset-message", String(error.message || error), "error");
    }
});

signOutButton.addEventListener("click", async () => {
    window.location.href = `${BACKEND_BASE}/logout`;
});

refreshOrdersButton.addEventListener("click", loadPastOrders);

async function bootstrapAccountPage() {
    try {
        const data = await apiRequest("/me", { method: "GET" });
        if (!data?.authenticated || !data.user) {
            window.location.href = "auth.html";
            return;
        }
        currentUser = data.user;
        renderSummary(currentUser);
        loadPastOrders();
    } catch (error) {
        window.location.href = "auth.html";
    }
}

bootstrapAccountPage();