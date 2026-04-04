const BACKEND_BASE = "http://127.0.0.1:5000";
const API_BASE = `${BACKEND_BASE}/api`;
const DEFAULT_PROFILE_IMAGE = "../assets/images/profilepicblank.png";

const menuList = document.getElementById("menu-list");
const menuStatus = document.getElementById("menu-status");
const refreshMenuButton = document.getElementById("refresh-menu");
const clearCartButton = document.getElementById("clear-cart");
const cartItems = document.getElementById("cart-items");
const cartStatus = document.getElementById("cart-status");
const cartTotal = document.getElementById("cart-total");
const checkoutForm = document.getElementById("checkout-form");
const checkoutButton = document.getElementById("checkout-button");
const checkoutMessage = document.getElementById("checkout-message");
const checkoutEmail = document.getElementById("checkout-email");
const accountLinks = document.querySelectorAll(".account-link");
const adminNavLinks = document.querySelectorAll(".admin-nav-link");
const headerProfileImage = document.getElementById("header-profile-image");
const headerAccountLabel = document.getElementById("header-account-label");
const headerAccountStatus = document.getElementById("header-account-status");

const CART_STORAGE_KEY = "bagelshop-cart-v1";

let currentUser = null;
let currentMenuItems = [];
let cart = loadCart();

function moneyFromCents(cents) {
    return `$${(Number(cents) / 100).toFixed(2)}`;
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

    if (checkoutEmail && account?.email) {
        checkoutEmail.value = account.email;
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

function createMenuCard(item) {
    const article = document.createElement("article");
    article.className = "menu-card";

    const imagePlaceholder = document.createElement("div");
    imagePlaceholder.className = "menu-card-image";

    const imageBadge = document.createElement("span");
    imageBadge.className = "menu-card-image-badge";
    imageBadge.textContent = item.category || "Fresh";

    const imageLabel = document.createElement("strong");
    imageLabel.className = "menu-card-image-label";
    imageLabel.textContent = "Image coming soon";

    const imageHint = document.createElement("span");
    imageHint.className = "menu-card-image-hint";
    imageHint.textContent = item.name;

    imagePlaceholder.append(imageBadge, imageLabel, imageHint);

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

    if (!Array.isArray(currentMenuItems) || currentMenuItems.length === 0) {
        menuStatus.textContent = "No menu items yet.";
        menuList.innerHTML = '<div class="empty-state">Square did not return any menu items yet. Add inventory in Square or check your sandbox credentials.</div>';
        return;
    }

    const groupedItems = groupMenuItemsByCategory(currentMenuItems);
    const categoryCount = groupedItems.size;
    const awaitingAvailability = currentMenuItems.some((item) => item.is_available === null);
    menuStatus.textContent = awaitingAvailability
        ? `Loaded ${currentMenuItems.length} item${currentMenuItems.length === 1 ? "" : "s"}. Checking live Square availability...`
        : `${currentMenuItems.length} item${currentMenuItems.length === 1 ? "" : "s"} across ${categoryCount} categor${categoryCount === 1 ? "y" : "ies"}.`;

    for (const [category, items] of groupedItems.entries()) {
        const section = document.createElement("section");
        section.className = "menu-category-section";

        const heading = document.createElement("div");
        heading.className = "menu-category-heading";

        const title = document.createElement("h3");
        title.textContent = category;

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
        checkoutButton.disabled = true;
        return;
    }

    cartStatus.textContent = `${entries.length} line item${entries.length === 1 ? "" : "s"} ready for checkout.`;
    for (const entry of entries) {
        cartItems.appendChild(createCartItem(entry));
    }
    cartTotal.textContent = moneyFromCents(getCartTotalCents());
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

    const buyerEmail = String(checkoutEmail?.value || currentUser?.email || "").trim();
    const notes = String(document.getElementById("checkout-notes")?.value || "").trim();

    checkoutButton.disabled = true;
    checkoutButton.textContent = "Creating checkout...";

    try {
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
                items: entries.map((entry) => ({
                    menu_item_id: entry.menu_item_id,
                    quantity: entry.quantity,
                })),
            }),
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data?.error || "Checkout failed");
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

getSessionUser().then(updateHeaderAccountState);

if (menuList && menuStatus && refreshMenuButton) {
    renderCart();
    fetchMenu();
}
