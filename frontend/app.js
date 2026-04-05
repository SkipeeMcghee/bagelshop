const LOCAL_BACKEND_BASE = "http://127.0.0.1:5000";
const BACKEND_BASE =
    window.location.protocol === "file:" || ["127.0.0.1:5501", "localhost:5501"].includes(window.location.host)
        ? LOCAL_BACKEND_BASE
        : window.location.origin;
const API_BASE = `${BACKEND_BASE}/api`;
const DEFAULT_PROFILE_IMAGE = "/assets/images/profilepicblank.png";

const menuList = document.getElementById("menu-list");
const menuTabs = document.getElementById("menu-tabs");
const menuStatus = document.getElementById("menu-status");
const refreshMenuButton = document.getElementById("refresh-menu");
const clearCartButton = document.getElementById("clear-cart");
const cartItems = document.getElementById("cart-items");
const cartStatus = document.getElementById("cart-status");
const cartTotal = document.getElementById("cart-total");
const checkoutForm = document.getElementById("checkout-form");
const checkoutButton = document.getElementById("checkout-button");
const checkoutMessage = document.getElementById("checkout-message");
const checkoutNotes = document.getElementById("checkout-notes");
const checkoutQuote = document.getElementById("checkout-quote");
const fulfillmentMethodInputs = Array.from(document.querySelectorAll('input[name="fulfillment_method"]'));
const accountLinks = document.querySelectorAll(".account-link");
const adminNavLinks = document.querySelectorAll(".admin-nav-link");
const headerProfileImage = document.getElementById("header-profile-image");
const headerAccountLabel = document.getElementById("header-account-label");
const headerAccountStatus = document.getElementById("header-account-status");

const checkoutDetailsOverlay = document.getElementById("checkout-details-overlay");
const checkoutDetailsClose = document.getElementById("checkout-details-close");
const checkoutDetailsCancel = document.getElementById("checkout-details-cancel");
const checkoutDetailsForm = document.getElementById("checkout-details-form");
const checkoutDetailsTitle = document.getElementById("checkout-details-title");
const checkoutDetailsSubtitle = document.getElementById("checkout-details-subtitle");
const checkoutDetailsMessage = document.getElementById("checkout-details-message");
const checkoutDetailsPhoneGroup = document.getElementById("checkout-details-phone-group");
const checkoutDetailsAddressGroup = document.getElementById("checkout-details-address-group");
const checkoutDetailsPhone = document.getElementById("checkout-details-phone");
const checkoutDetailsLine1 = document.getElementById("checkout-details-line1");
const checkoutDetailsLine2 = document.getElementById("checkout-details-line2");
const checkoutDetailsCity = document.getElementById("checkout-details-city");
const checkoutDetailsStateInput = document.getElementById("checkout-details-state");
const checkoutDetailsPostal = document.getElementById("checkout-details-postal");
const checkoutDetailsCountry = document.getElementById("checkout-details-country");
const checkoutDetailsSave = document.getElementById("checkout-details-save");

const CART_STORAGE_KEY = "bagelshop-cart-v1";

let currentUser = null;
let currentMenuItems = [];
let cart = loadCart();
let selectedMenuCategory = "";
let fulfillmentConfig = null;
let latestQuote = null;
let latestQuoteRequest = 0;
let checkoutDetailsDraft = {
    buyer_phone: "",
    delivery_address_line1: "",
    delivery_address_line2: "",
    delivery_city: "",
    delivery_state: "",
    delivery_postal_code: "",
    delivery_country: "US",
};
let checkoutDetailsRequirements = {
    requirePhone: false,
    requireAddress: false,
};
let checkoutDetailsResolver = null;

function moneyFromCents(cents) {
    return `$${(Number(cents) / 100).toFixed(2)}`;
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

async function getSessionUser() {
    try {
        const response = await fetch(`${API_BASE}/me`, {
            credentials: "include",
        });
        const data = await response.json();
        if (!response.ok || !data?.authenticated) {
            return null;
        }
        return data.user || null;
    } catch (error) {
        return null;
    }
}

function loadCart() {
    try {
        const raw = window.localStorage.getItem(CART_STORAGE_KEY);
        const parsed = JSON.parse(raw || "[]");
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function saveCart() {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
}

function setCheckoutMessage(message, type = "success") {
    if (!checkoutMessage) {
        return;
    }
    checkoutMessage.textContent = message;
    checkoutMessage.classList.remove("success", "error");
    if (message) {
        checkoutMessage.classList.add(type);
    }
}

function setCheckoutDetailsMessage(message, type = "error") {
    if (!checkoutDetailsMessage) {
        return;
    }
    checkoutDetailsMessage.textContent = message;
    checkoutDetailsMessage.classList.remove("success", "error");
    if (message) {
        checkoutDetailsMessage.classList.add(type);
    }
}

function getSelectedFulfillmentMethod() {
    return fulfillmentMethodInputs.find((input) => input.checked)?.value || "pickup";
}

function getSavedPhone() {
    return String(currentUser?.phone || checkoutDetailsDraft.buyer_phone || "").trim();
}

function getSavedAddress() {
    const accountAddress = currentUser?.shipping_address || {};
    return {
        line1: String(accountAddress.line1 || checkoutDetailsDraft.delivery_address_line1 || "").trim(),
        line2: String(accountAddress.line2 || checkoutDetailsDraft.delivery_address_line2 || "").trim(),
        city: String(accountAddress.city || checkoutDetailsDraft.delivery_city || "").trim(),
        state: String(accountAddress.state || checkoutDetailsDraft.delivery_state || "").trim(),
        postal_code: String(accountAddress.postal_code || checkoutDetailsDraft.delivery_postal_code || "").trim(),
        country: String(accountAddress.country || checkoutDetailsDraft.delivery_country || "US").trim() || "US",
    };
}

function hasRequiredDeliveryAddress(address = getSavedAddress()) {
    return Boolean(address.line1 && address.city && address.state && address.postal_code);
}

function getFulfillmentPayload() {
    const address = getSavedAddress();
    return {
        fulfillment_method: getSelectedFulfillmentMethod(),
        buyer_phone: getSavedPhone(),
        delivery_address_line1: address.line1,
        delivery_address_line2: address.line2,
        delivery_city: address.city,
        delivery_state: address.state,
        delivery_postal_code: address.postal_code,
        delivery_country: address.country,
    };
}

function getMissingDetailsForSelectedMethod() {
    const method = getSelectedFulfillmentMethod();
    return {
        requirePhone: method === "pickup" && !getSavedPhone(),
        requireAddress: method === "delivery" && !hasRequiredDeliveryAddress(),
    };
}

function buildLocalQuote(subtotalCents, note = "") {
    const method = getSelectedFulfillmentMethod();
    return {
        fulfillment_method: method,
        buyer_phone: getSavedPhone(),
        delivery_address: getSavedAddress(),
        delivery_fee_cents: 0,
        delivery_fee_rule_label: "",
        delivery_fee_waived: false,
        distance_miles: null,
        shipping_deposit_cents: 0,
        shipping_required: false,
        subtotal_cents: subtotalCents,
        total_cents: subtotalCents,
        pickup_location_name: fulfillmentConfig?.pickup_location?.name || "Daytona Supply Warehouse",
        note,
    };
}

function updateHeaderAccountState(account) {
    currentUser = account || null;
    const profileImageUrl = account?.profile_image_url || DEFAULT_PROFILE_IMAGE;
    const label = account?.name || account?.email || "Create or sign in";
    const destination = account ? "account.html" : "auth.html";

    for (const link of accountLinks) {
        link.href = destination;
    }

    for (const link of adminNavLinks) {
        link.hidden = !account?.is_admin;
    }

    if (headerProfileImage) {
        headerProfileImage.src = profileImageUrl;
    }

    if (headerAccountLabel) {
        headerAccountLabel.textContent = account ? "Account" : "Sign In";
    }

    if (headerAccountStatus) {
        headerAccountStatus.textContent = account ? label : "Continue with Google or a local account";
    }

    refreshQuote();
}

function fillCheckoutDetailsForm() {
    const address = getSavedAddress();
    if (checkoutDetailsPhone) {
        checkoutDetailsPhone.value = getSavedPhone();
    }
    if (checkoutDetailsLine1) {
        checkoutDetailsLine1.value = address.line1;
    }
    if (checkoutDetailsLine2) {
        checkoutDetailsLine2.value = address.line2;
    }
    if (checkoutDetailsCity) {
        checkoutDetailsCity.value = address.city;
    }
    if (checkoutDetailsStateInput) {
        checkoutDetailsStateInput.value = address.state;
    }
    if (checkoutDetailsPostal) {
        checkoutDetailsPostal.value = address.postal_code;
    }
    if (checkoutDetailsCountry) {
        checkoutDetailsCountry.value = address.country;
    }
}

function openCheckoutDetailsModal({ requirePhone = false, requireAddress = false, message = "" } = {}) {
    if (!checkoutDetailsOverlay) {
        return Promise.resolve(false);
    }

    checkoutDetailsRequirements = { requirePhone, requireAddress };
    fillCheckoutDetailsForm();
    setCheckoutDetailsMessage("");

    if (checkoutDetailsPhoneGroup) {
        checkoutDetailsPhoneGroup.hidden = !requirePhone;
    }
    if (checkoutDetailsAddressGroup) {
        checkoutDetailsAddressGroup.hidden = !requireAddress;
    }

    if (checkoutDetailsTitle) {
        checkoutDetailsTitle.textContent = requirePhone && requireAddress
            ? "Add your pickup and delivery details"
            : requireAddress
                ? "Add your delivery address"
                : "Add your phone number";
    }

    if (checkoutDetailsSubtitle) {
        checkoutDetailsSubtitle.textContent = message || (
            currentUser
                ? "We found missing order details. Save them once and we’ll update your account for next time."
                : "We found missing order details. Add them here so checkout can continue."
        );
    }

    checkoutDetailsOverlay.hidden = false;
    document.body.classList.add("modal-open");

    window.setTimeout(() => {
        const firstTarget = requirePhone ? checkoutDetailsPhone : checkoutDetailsLine1;
        firstTarget?.focus();
    }, 0);

    return new Promise((resolve) => {
        checkoutDetailsResolver = resolve;
    });
}

function closeCheckoutDetailsModal(saved) {
    if (!checkoutDetailsOverlay) {
        return;
    }

    checkoutDetailsOverlay.hidden = true;
    document.body.classList.remove("modal-open");
    setCheckoutDetailsMessage("");

    if (checkoutDetailsResolver) {
        const resolver = checkoutDetailsResolver;
        checkoutDetailsResolver = null;
        resolver(saved);
    }
}

async function saveCheckoutDetails() {
    const nextPhone = String(checkoutDetailsPhone?.value || "").trim();
    const nextAddress = {
        line1: String(checkoutDetailsLine1?.value || "").trim(),
        line2: String(checkoutDetailsLine2?.value || "").trim(),
        city: String(checkoutDetailsCity?.value || "").trim(),
        state: String(checkoutDetailsStateInput?.value || "").trim(),
        postal_code: String(checkoutDetailsPostal?.value || "").trim(),
        country: String(checkoutDetailsCountry?.value || "US").trim() || "US",
    };

    if (checkoutDetailsRequirements.requirePhone && !nextPhone) {
        setCheckoutDetailsMessage("A phone number is required for pickup orders.");
        return;
    }
    if (checkoutDetailsRequirements.requireAddress && !(nextAddress.line1 && nextAddress.city && nextAddress.state && nextAddress.postal_code)) {
        setCheckoutDetailsMessage("Please complete address line 1, city, state, and ZIP/postal code.");
        return;
    }

    checkoutDetailsDraft = {
        buyer_phone: nextPhone,
        delivery_address_line1: nextAddress.line1,
        delivery_address_line2: nextAddress.line2,
        delivery_city: nextAddress.city,
        delivery_state: nextAddress.state,
        delivery_postal_code: nextAddress.postal_code,
        delivery_country: nextAddress.country,
    };

    if (currentUser) {
        checkoutDetailsSave.disabled = true;
        checkoutDetailsSave.textContent = "Saving...";
        try {
            const data = await apiRequest("/me", {
                method: "POST",
                body: JSON.stringify({
                    phone: checkoutDetailsRequirements.requirePhone ? nextPhone : currentUser.phone,
                    shipping_address_line1: checkoutDetailsRequirements.requireAddress ? nextAddress.line1 : currentUser.shipping_address?.line1 || "",
                    shipping_address_line2: checkoutDetailsRequirements.requireAddress ? nextAddress.line2 : currentUser.shipping_address?.line2 || "",
                    shipping_city: checkoutDetailsRequirements.requireAddress ? nextAddress.city : currentUser.shipping_address?.city || "",
                    shipping_state: checkoutDetailsRequirements.requireAddress ? nextAddress.state : currentUser.shipping_address?.state || "",
                    shipping_postal_code: checkoutDetailsRequirements.requireAddress ? nextAddress.postal_code : currentUser.shipping_address?.postal_code || "",
                    shipping_country: checkoutDetailsRequirements.requireAddress ? nextAddress.country : currentUser.shipping_address?.country || "US",
                }),
            });
            updateHeaderAccountState(data.user || null);
        } catch (error) {
            setCheckoutDetailsMessage(String(error.message || error));
            checkoutDetailsSave.disabled = false;
            checkoutDetailsSave.textContent = "Save and continue";
            return;
        }
        checkoutDetailsSave.disabled = false;
        checkoutDetailsSave.textContent = "Save and continue";
    }

    closeCheckoutDetailsModal(true);
    await refreshQuote();
}

async function ensureFulfillmentDetails(message = "") {
    const missing = getMissingDetailsForSelectedMethod();
    if (!missing.requirePhone && !missing.requireAddress) {
        return true;
    }
    return openCheckoutDetailsModal({
        ...missing,
        message,
    });
}

function renderQuoteSummary() {
    if (!checkoutQuote || !cartTotal) {
        return;
    }

    const subtotalCents = getCartTotalCents();
    if (subtotalCents <= 0) {
        latestQuote = null;
        checkoutQuote.innerHTML = "";
        cartTotal.textContent = moneyFromCents(0);
        return;
    }

    const quote = latestQuote || buildLocalQuote(subtotalCents);
    const parts = [
        `<div class="quote-row"><span>Items</span><strong>${moneyFromCents(quote.subtotal_cents || subtotalCents)}</strong></div>`,
    ];

    if (quote.fulfillment_method === "delivery") {
        if (quote.shipping_required) {
            parts.push(`<div class="quote-row"><span>Shipping deposit</span><strong>${moneyFromCents(quote.shipping_deposit_cents || 0)}</strong></div>`);
        } else {
            const deliveryLabel = quote.delivery_fee_waived ? "Delivery fee waived" : "Delivery fee";
            parts.push(`<div class="quote-row"><span>${deliveryLabel}</span><strong>${moneyFromCents(quote.delivery_fee_cents || 0)}</strong></div>`);
        }
        if (quote.distance_miles) {
            parts.push(`<div class="quote-row quote-row-muted"><span>Distance</span><strong>${Number(quote.distance_miles).toFixed(2)} mi</strong></div>`);
        }
    } else {
        parts.push('<div class="quote-row quote-row-muted"><span>Pickup fee</span><strong>$0.00</strong></div>');
    }

    parts.push(`<div class="quote-row quote-total-row"><span>Total</span><strong>${moneyFromCents(quote.total_cents || subtotalCents)}</strong></div>`);

    if (quote.note) {
        parts.push(`<p class="quote-note">${quote.note}</p>`);
    }

    checkoutQuote.innerHTML = parts.join("");
    cartTotal.textContent = moneyFromCents(quote.total_cents || subtotalCents);
}

async function loadFulfillmentConfig() {
    if (!checkoutForm) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/fulfillment/config`);
        const data = await response.json();
        if (!response.ok) {
            throw new Error(data?.error || "Could not load fulfillment settings.");
        }
        fulfillmentConfig = data;
    } catch (error) {
        fulfillmentConfig = null;
    }
}

async function refreshQuote() {
    if (!checkoutForm || getCartEntries().length === 0) {
        renderQuoteSummary();
        return;
    }

    const subtotalCents = getCartTotalCents();
    const payload = {
        customer_id: currentUser?.customer_id || null,
        items: getCartEntries().map((entry) => ({
            menu_item_id: entry.menu_item_id,
            quantity: entry.quantity,
        })),
        ...getFulfillmentPayload(),
    };

    if (payload.fulfillment_method === "pickup" && !payload.buyer_phone) {
        latestQuote = buildLocalQuote(subtotalCents, "A phone number is required for pickup. We’ll ask for it when you checkout.");
        renderQuoteSummary();
        return;
    }

    if (payload.fulfillment_method === "delivery" && !hasRequiredDeliveryAddress()) {
        latestQuote = buildLocalQuote(subtotalCents, "A saved delivery address is required to calculate delivery fees.");
        renderQuoteSummary();
        return;
    }

    const requestId = ++latestQuoteRequest;
    try {
        const response = await fetch(`${API_BASE}/checkout/quote`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (requestId !== latestQuoteRequest) {
            return;
        }
        if (!response.ok) {
            latestQuote = buildLocalQuote(subtotalCents, data?.error || "Unable to calculate fees yet.");
            renderQuoteSummary();
            return;
        }
        latestQuote = data;
        renderQuoteSummary();
    } catch (error) {
        if (requestId !== latestQuoteRequest) {
            return;
        }
        latestQuote = buildLocalQuote(subtotalCents, "Unable to calculate fees right now.");
        renderQuoteSummary();
    }
}

function getCartQuantity(itemId) {
    const entry = cart.find((cartItem) => cartItem.menu_item_id === itemId);
    return entry ? entry.quantity : 0;
}

function updateCartItemQuantity(itemId, quantity) {
    if (quantity <= 0) {
        cart = cart.filter((item) => item.menu_item_id !== itemId);
    } else {
        const existing = cart.find((item) => item.menu_item_id === itemId);
        if (existing) {
            existing.quantity = quantity;
        } else {
            cart.push({ menu_item_id: itemId, quantity });
        }
    }

    saveCart();
    renderCart();
    renderMenu();
    refreshQuote();
}

function addToCart(itemId) {
    updateCartItemQuantity(itemId, getCartQuantity(itemId) + 1);
}

function getCartEntries() {
    return cart
        .map((entry) => {
            const menuItem = currentMenuItems.find((item) => item.id === entry.menu_item_id);
            if (!menuItem) {
                return null;
            }
            return {
                ...entry,
                menuItem,
                lineTotalCents: Number(menuItem.price_cents) * entry.quantity,
            };
        })
        .filter(Boolean);
}

function getCartTotalCents() {
    return getCartEntries().reduce((sum, entry) => sum + entry.lineTotalCents, 0);
}

function isPortraitMenuCategory(category) {
    const normalized = String(category || "").trim().toLowerCase();
    return normalized === "bagels" || normalized.endsWith(" bagels") || normalized.includes("bagel");
}

function createMenuCard(item) {
    const article = document.createElement("article");
    article.className = "menu-card";
    if (isPortraitMenuCategory(item.category)) {
        article.classList.add("menu-card-portrait");
    }

    const imagePlaceholder = document.createElement("div");
    imagePlaceholder.className = "menu-card-image";

    const imageUrl = String(item.image_url || "").trim();
    if (imageUrl) {
        const image = document.createElement("img");
        image.className = "menu-card-photo";
        image.src = imageUrl;
        image.alt = item.name;
        image.loading = "lazy";
        imagePlaceholder.appendChild(image);
        imagePlaceholder.classList.add("has-photo");
    }

    const imageLabel = document.createElement("strong");
    imageLabel.className = "menu-card-image-label";
    imageLabel.textContent = imageUrl ? item.name : "Image coming soon";

    const imageHint = document.createElement("span");
    imageHint.className = "menu-card-image-hint";
    imageHint.textContent = imageUrl ? "" : item.name;

    imagePlaceholder.append(imageLabel, imageHint);

    const body = document.createElement("div");
    body.className = "menu-card-body";

    const header = document.createElement("div");
    header.className = "menu-card-header";

    const titleBlock = document.createElement("div");
    const title = document.createElement("h3");
    title.textContent = item.name;
    const description = document.createElement("p");
    description.textContent = item.description || "Freshly prepared and ready to order.";
    titleBlock.append(title, description);

    const price = document.createElement("span");
    price.className = "price-pill";
    price.textContent = moneyFromCents(item.price_cents);

    header.append(titleBlock, price);

    const availabilityKnown = typeof item.is_available === "boolean" || item.is_available === 0 || item.is_available === 1;
    const isAvailable = item.is_available === true || item.is_available === 1;
    const availability = document.createElement("span");
    availability.className = `availability-pill${availabilityKnown && isAvailable ? "" : " unavailable"}`;
    availability.textContent = !availabilityKnown
        ? "Checking availability..."
        : isAvailable
            ? "Available now"
            : "Currently unavailable";

    const actions = document.createElement("div");
    actions.className = "menu-card-actions";

    const quantityPill = document.createElement("span");
    quantityPill.className = "cart-quantity-pill";
    const quantity = getCartQuantity(item.id);
    quantityPill.textContent = quantity > 0 ? `${quantity} in cart` : "Not in cart";

    const addButton = document.createElement("button");
    addButton.type = "button";
    addButton.className = "secondary-button add-to-cart-button";
    addButton.textContent = !availabilityKnown ? "Checking..." : isAvailable ? "Add to Cart" : "Unavailable";
    addButton.disabled = !availabilityKnown || !isAvailable;
    addButton.addEventListener("click", () => addToCart(item.id));

    actions.append(quantityPill, addButton);
    body.append(header, availability, actions);
    article.append(imagePlaceholder, body);
    return article;
}

function groupMenuItemsByCategory(items) {
    const groups = new Map();
    for (const item of items) {
        const category = String(item.category || "").trim() || "Uncategorized";
        if (!groups.has(category)) {
            groups.set(category, []);
        }
        groups.get(category).push(item);
    }
    return groups;
}

function renderMenuTabs(categories) {
    if (!menuTabs) {
        return;
    }

    menuTabs.innerHTML = "";
    if (!Array.isArray(categories) || categories.length === 0) {
        menuTabs.hidden = true;
        return;
    }

    menuTabs.hidden = false;
    for (const category of categories) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `menu-tab${selectedMenuCategory === category ? " active" : ""}`;
        button.textContent = category;
        button.setAttribute("aria-pressed", selectedMenuCategory === category ? "true" : "false");
        button.addEventListener("click", () => {
            selectedMenuCategory = category;
            renderMenu();
        });
        menuTabs.appendChild(button);
    }
}

function createCartItem(entry) {
    const article = document.createElement("article");
    article.className = "cart-item";

    const copy = document.createElement("div");
    copy.className = "cart-item-copy";

    const title = document.createElement("h3");
    title.textContent = entry.menuItem.name;
    const meta = document.createElement("p");
    meta.textContent = `${moneyFromCents(entry.menuItem.price_cents)} each`;
    copy.append(title, meta);

    const controls = document.createElement("div");
    controls.className = "cart-item-controls";

    const decrementButton = document.createElement("button");
    decrementButton.type = "button";
    decrementButton.className = "ghost-button quantity-button";
    decrementButton.textContent = "-";
    decrementButton.addEventListener("click", () => updateCartItemQuantity(entry.menu_item_id, entry.quantity - 1));

    const quantity = document.createElement("span");
    quantity.className = "quantity-value";
    quantity.textContent = String(entry.quantity);

    const incrementButton = document.createElement("button");
    incrementButton.type = "button";
    incrementButton.className = "ghost-button quantity-button";
    incrementButton.textContent = "+";
    incrementButton.addEventListener("click", () => updateCartItemQuantity(entry.menu_item_id, entry.quantity + 1));

    const lineTotal = document.createElement("strong");
    lineTotal.className = "cart-line-total";
    lineTotal.textContent = moneyFromCents(entry.lineTotalCents);

    controls.append(decrementButton, quantity, incrementButton, lineTotal);
    article.append(copy, controls);
    return article;
}

function renderMenu() {
    menuList.innerHTML = "";
    if (menuTabs) {
        menuTabs.innerHTML = "";
    }

    if (!Array.isArray(currentMenuItems) || currentMenuItems.length === 0) {
        menuStatus.textContent = "No menu items yet.";
        menuList.innerHTML = '<div class="empty-state">Square did not return any menu items yet. Add inventory in Square or check your sandbox credentials.</div>';
        if (menuTabs) {
            menuTabs.hidden = true;
        }
        return;
    }

    const groupedItems = groupMenuItemsByCategory(currentMenuItems);
    const categories = Array.from(groupedItems.keys());
    if (!selectedMenuCategory || !groupedItems.has(selectedMenuCategory)) {
        selectedMenuCategory = categories[0] || "";
    }
    renderMenuTabs(categories);

    const categoryCount = groupedItems.size;
    const awaitingAvailability = currentMenuItems.some((item) => item.is_available === null);
    menuStatus.textContent = awaitingAvailability
        ? `Loaded ${currentMenuItems.length} item${currentMenuItems.length === 1 ? "" : "s"}. Checking live Square availability...`
        : `${currentMenuItems.length} item${currentMenuItems.length === 1 ? "" : "s"} across ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}.`;

    const items = groupedItems.get(selectedMenuCategory) || [];
    const section = document.createElement("section");
    section.className = "menu-category-section";

    const heading = document.createElement("div");
    heading.className = "menu-category-heading";

    const title = document.createElement("h3");
    title.textContent = selectedMenuCategory;

    const count = document.createElement("span");
    count.className = "menu-category-count";
    count.textContent = `${items.length} item${items.length === 1 ? "" : "s"}`;

    heading.append(title, count);

    const grid = document.createElement("div");
    grid.className = "menu-grid";
    for (const item of items) {
        grid.appendChild(createMenuCard(item));
    }

    section.append(heading, grid);
    menuList.appendChild(section);
}

function renderCart() {
    if (!cartItems || !cartStatus || !cartTotal || !checkoutButton) {
        return;
    }

    cartItems.innerHTML = "";
    const entries = getCartEntries();

    if (entries.length === 0) {
        cartStatus.textContent = "Add items from the menu to start an order.";
        cartItems.innerHTML = '<div class="empty-state">Your cart is empty.</div>';
        cartTotal.textContent = moneyFromCents(0);
        latestQuote = null;
        renderQuoteSummary();
        checkoutButton.disabled = true;
        return;
    }

    cartStatus.textContent = `${entries.length} line item${entries.length === 1 ? "" : "s"} ready for checkout.`;
    for (const entry of entries) {
        cartItems.appendChild(createCartItem(entry));
    }
    renderQuoteSummary();
    checkoutButton.disabled = false;
}

async function fetchMenu() {
    menuStatus.textContent = "Loading menu...";
    menuList.innerHTML = "";

    try {
        const response = await fetch(`${API_BASE}/menu`);
        const items = await response.json();

        if (!response.ok) {
            throw new Error(items?.error || "request failed");
        }

        currentMenuItems = Array.isArray(items) ? items : [];
        renderMenu();
        renderCart();
        refreshQuote();
    } catch (error) {
        menuStatus.textContent = "Could not load the menu.";
        menuList.innerHTML = `<div class="empty-state">${error}</div>`;
    }
}

async function startCheckout(event) {
    event.preventDefault();
    setCheckoutMessage("");

    const entries = getCartEntries();
    if (entries.length === 0) {
        setCheckoutMessage("Add at least one item before checkout.", "error");
        return;
    }

    const hasDetails = await ensureFulfillmentDetails();
    if (!hasDetails) {
        setCheckoutMessage("Checkout needs the required order details first.", "error");
        return;
    }

    const buyerEmail = String(currentUser?.email || "").trim();
    const notes = String(checkoutNotes?.value || "").trim();
    const fulfillmentPayload = getFulfillmentPayload();

    checkoutButton.disabled = true;
    checkoutButton.textContent = "Creating checkout...";

    try {
        await refreshQuote();
        const response = await fetch(`${API_BASE}/checkout`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                customer_id: currentUser?.customer_id || null,
                buyer_email: buyerEmail,
                notes,
                allow_cash_app: true,
                ...fulfillmentPayload,
                items: entries.map((entry) => ({
                    menu_item_id: entry.menu_item_id,
                    quantity: entry.quantity,
                })),
            }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = String(data?.error || "Checkout failed");
            if (/phone number|required/i.test(message)) {
                const saved = await openCheckoutDetailsModal({ requirePhone: true, message });
                if (saved) {
                    checkoutButton.disabled = false;
                    checkoutButton.textContent = "Pay with Square";
                    return startCheckout(event);
                }
            }
            if (/address|required|verify/i.test(message) && getSelectedFulfillmentMethod() === "delivery") {
                const saved = await openCheckoutDetailsModal({ requireAddress: true, message });
                if (saved) {
                    checkoutButton.disabled = false;
                    checkoutButton.textContent = "Pay with Square";
                    return startCheckout(event);
                }
            }
            throw new Error(message);
        }

        cart = [];
        saveCart();
        renderCart();
        renderMenu();
        window.location.href = data.checkout_url;
    } catch (error) {
        setCheckoutMessage(String(error.message || error), "error");
        checkoutButton.disabled = false;
        checkoutButton.textContent = "Pay with Square";
    }
}

if (refreshMenuButton) {
    refreshMenuButton.addEventListener("click", fetchMenu);
}

if (clearCartButton) {
    clearCartButton.addEventListener("click", () => {
        cart = [];
        saveCart();
        renderCart();
        renderMenu();
        setCheckoutMessage("");
    });
}

if (checkoutForm) {
    checkoutForm.addEventListener("submit", startCheckout);
}

for (const input of fulfillmentMethodInputs) {
    input.addEventListener("change", async () => {
        setCheckoutMessage("");
        await refreshQuote();
        const missing = getMissingDetailsForSelectedMethod();
        if (missing.requirePhone || missing.requireAddress) {
            await openCheckoutDetailsModal({
                ...missing,
                message: input.value === "delivery"
                    ? "Delivery uses the address saved on your account. Add it here if it is missing."
                    : "Pickup needs a saved phone number so we can coordinate handoff.",
            });
        }
    });
}

if (checkoutNotes) {
    checkoutNotes.addEventListener("input", () => setCheckoutMessage(""));
}

checkoutDetailsForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCheckoutDetails();
});

checkoutDetailsCancel?.addEventListener("click", () => closeCheckoutDetailsModal(false));
checkoutDetailsClose?.addEventListener("click", () => closeCheckoutDetailsModal(false));
checkoutDetailsOverlay?.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.hasAttribute("data-close-checkout-details")) {
        closeCheckoutDetailsModal(false);
    }
});

document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !checkoutDetailsOverlay?.hidden) {
        closeCheckoutDetailsModal(false);
    }
});

getSessionUser().then(updateHeaderAccountState);

if (menuList && menuStatus && refreshMenuButton) {
    renderCart();
    loadFulfillmentConfig();
    fetchMenu();
}
