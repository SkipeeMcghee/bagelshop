const BACKEND_BASE = "http://127.0.0.1:5000";
const API_BASE = `${BACKEND_BASE}/api`;
const DEFAULT_PROFILE_IMAGE = "../assets/images/profilepicblank.png";

const accountProfileImage = document.getElementById("account-profile-image");
const accountDisplayName = document.getElementById("account-display-name");
const accountSummaryText = document.getElementById("account-summary-text");
const accountDetailsForm = document.getElementById("account-details-form");
const deliveryAddressForm = document.getElementById("delivery-address-form");
const passwordResetForm = document.getElementById("password-reset-form");
const passwordPanel = document.getElementById("password-panel");
const sameAsBillingCheckbox = document.getElementById("same-as-billing-checkbox");
const signOutButton = document.getElementById("sign-out-button");
const refreshOrdersButton = document.getElementById("refresh-orders");
const ordersStatus = document.getElementById("orders-status");
const ordersList = document.getElementById("orders-list");
let currentUser = null;

const BILLING_TO_SHIPPING_FIELDS = [
    ["billing_address_line1", "shipping_address_line1"],
    ["billing_address_line2", "shipping_address_line2"],
    ["billing_city", "shipping_city"],
    ["billing_state", "shipping_state"],
    ["billing_postal_code", "shipping_postal_code"],
    ["billing_country", "shipping_country"],
];

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

    const authLabel = account.is_google_account ? "Signed in with Google" : "Signed in with a local account";
    return {
        title: account.name || account.email || "Account",
        text: `${authLabel}. Update your profile details, reset your password, and review your past orders here.`,
        image: account.profile_image_url || DEFAULT_PROFILE_IMAGE,
    };
}

function getInputValue(name) {
    return String(deliveryAddressForm.elements[name]?.value || "").trim();
}

function isSameAsBillingAddress(account) {
    if (!account) {
        return false;
    }

    return BILLING_TO_SHIPPING_FIELDS.every(([billingName, shippingName]) => {
        const billingKey = billingName.replace("billing_", "").replace("address_", "");
        const shippingKey = shippingName.replace("shipping_", "").replace("address_", "");
        const billingAddress = account.billing_address || {};
        const shippingAddress = account.shipping_address || {};
        return String(billingAddress[billingKey] || "") === String(shippingAddress[shippingKey] || "");
    });
}

function syncShippingFromBilling() {
    for (const [billingName, shippingName] of BILLING_TO_SHIPPING_FIELDS) {
        deliveryAddressForm.elements[shippingName].value = deliveryAddressForm.elements[billingName].value;
    }
}

function updateShippingFieldState() {
    const disableShipping = Boolean(sameAsBillingCheckbox?.checked);
    if (disableShipping) {
        syncShippingFromBilling();
    }

    for (const [, shippingName] of BILLING_TO_SHIPPING_FIELDS) {
        deliveryAddressForm.elements[shippingName].disabled = disableShipping;
    }
}

function populateForms(account) {
    accountDetailsForm.elements.name.value = account?.name || "";
    accountDetailsForm.elements.email.value = account?.email || "";
    accountDetailsForm.elements.phone.value = account?.phone || "";

    deliveryAddressForm.elements.shipping_address_line1.value = account?.shipping_address?.line1 || "";
    deliveryAddressForm.elements.shipping_address_line2.value = account?.shipping_address?.line2 || "";
    deliveryAddressForm.elements.shipping_city.value = account?.shipping_address?.city || "";
    deliveryAddressForm.elements.shipping_state.value = account?.shipping_address?.state || "";
    deliveryAddressForm.elements.shipping_postal_code.value = account?.shipping_address?.postal_code || "";
    deliveryAddressForm.elements.shipping_country.value = account?.shipping_address?.country || "";
    deliveryAddressForm.elements.billing_address_line1.value = account?.billing_address?.line1 || "";
    deliveryAddressForm.elements.billing_address_line2.value = account?.billing_address?.line2 || "";
    deliveryAddressForm.elements.billing_city.value = account?.billing_address?.city || "";
    deliveryAddressForm.elements.billing_state.value = account?.billing_address?.state || "";
    deliveryAddressForm.elements.billing_postal_code.value = account?.billing_address?.postal_code || "";
    deliveryAddressForm.elements.billing_country.value = account?.billing_address?.country || "";

    sameAsBillingCheckbox.checked = isSameAsBillingAddress(account);
    updateShippingFieldState();
}

function renderSummary(account) {
    const summary = getAccountSummary(account);

    accountDisplayName.textContent = summary.title;
    accountSummaryText.textContent = summary.text;
    accountProfileImage.src = summary.image;
    passwordPanel.hidden = Boolean(account?.is_google_account);
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
                name: String(formData.get("name") || "").trim(),
                email: String(formData.get("email") || "").trim(),
                phone: String(formData.get("phone") || "").trim(),
            }),
        });
        currentUser = data.user;
        renderSummary(currentUser);
        setFeedback("account-details-message", "Account details updated.");
    } catch (error) {
        setFeedback("account-details-message", String(error.message || error), "error");
    }
});

deliveryAddressForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    if (sameAsBillingCheckbox.checked) {
        syncShippingFromBilling();
    }

    const formData = new FormData(deliveryAddressForm);
    try {
        const data = await apiRequest("/me", {
            method: "POST",
            body: JSON.stringify({
                shipping_address_line1: String(formData.get("shipping_address_line1") || "").trim(),
                shipping_address_line2: String(formData.get("shipping_address_line2") || "").trim(),
                shipping_city: String(formData.get("shipping_city") || "").trim(),
                shipping_state: String(formData.get("shipping_state") || "").trim(),
                shipping_postal_code: String(formData.get("shipping_postal_code") || "").trim(),
                shipping_country: String(formData.get("shipping_country") || "").trim(),
                billing_address_line1: String(formData.get("billing_address_line1") || "").trim(),
                billing_address_line2: String(formData.get("billing_address_line2") || "").trim(),
                billing_city: String(formData.get("billing_city") || "").trim(),
                billing_state: String(formData.get("billing_state") || "").trim(),
                billing_postal_code: String(formData.get("billing_postal_code") || "").trim(),
                billing_country: String(formData.get("billing_country") || "").trim(),
            }),
        });
        currentUser = data.user;
        renderSummary(currentUser);
        setFeedback("delivery-address-message", "Delivery addresses updated.");
    } catch (error) {
        setFeedback("delivery-address-message", String(error.message || error), "error");
    }
});

sameAsBillingCheckbox.addEventListener("change", () => {
    updateShippingFieldState();
});

for (const [billingName] of BILLING_TO_SHIPPING_FIELDS) {
    deliveryAddressForm.elements[billingName].addEventListener("input", () => {
        if (sameAsBillingCheckbox.checked) {
            syncShippingFromBilling();
        }
    });
}

passwordResetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFeedback();

    if (!currentUser) {
        setFeedback("password-reset-message", "Sign in before resetting a password.", "error");
        return;
    }

    if (currentUser.is_google_account) {
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