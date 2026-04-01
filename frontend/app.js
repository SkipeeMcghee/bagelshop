const API_BASE = "http://127.0.0.1:5000/api";
const ACCOUNT_STORAGE_KEY = "bagelshopAccount";
const DEFAULT_PROFILE_IMAGE = "../assets/images/profilepicblank.png";

const menuList = document.getElementById("menu-list");
const menuStatus = document.getElementById("menu-status");
const refreshMenuButton = document.getElementById("refresh-menu");
const accountLinks = document.querySelectorAll(".account-link");
const headerProfileImage = document.getElementById("header-profile-image");
const headerAccountStatus = document.getElementById("header-account-status");

function moneyFromCents(cents) {
    return `$${(Number(cents) / 100).toFixed(2)}`;
}

function getSavedAccount() {
    try {
        const raw = localStorage.getItem(ACCOUNT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (error) {
        return null;
    }
}

function updateHeaderAccountState() {
    const account = getSavedAccount();
    const profileImageUrl = account?.profileImageUrl || DEFAULT_PROFILE_IMAGE;
    const label = account?.displayName || account?.username || "Create or sign in";
    const destination = account ? "account.html" : "auth.html";

    for (const link of accountLinks) {
        link.href = destination;
    }

    if (headerProfileImage) {
        headerProfileImage.src = profileImageUrl;
    }

    if (headerAccountStatus) {
        headerAccountStatus.textContent = account ? label : "Create or sign in";
    }
}

function createMenuCard(item) {
    const article = document.createElement("article");
    article.className = "menu-card";

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

    const availability = document.createElement("span");
    availability.className = `availability-pill${item.is_available ? "" : " unavailable"}`;
    availability.textContent = item.is_available ? "Available now" : "Currently unavailable";

    article.append(header, availability);
    return article;
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

        if (!Array.isArray(items) || items.length === 0) {
            menuStatus.textContent = "No menu items yet.";
            menuList.innerHTML = '<div class="empty-state">The menu is still empty. Seed or add menu items from the backend first.</div>';
            return;
        }

        menuStatus.textContent = `${items.length} item${items.length === 1 ? "" : "s"} available.`;
        for (const item of items) {
            menuList.appendChild(createMenuCard(item));
        }
    } catch (error) {
        menuStatus.textContent = "Could not load the menu.";
        menuList.innerHTML = `<div class="empty-state">${error}</div>`;
    }
}

if (refreshMenuButton) {
    refreshMenuButton.addEventListener("click", fetchMenu);
}
window.addEventListener("storage", updateHeaderAccountState);

updateHeaderAccountState();

if (menuList && menuStatus && refreshMenuButton) {
    fetchMenu();
}
