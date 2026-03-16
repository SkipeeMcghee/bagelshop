const API_BASE = "http://127.0.0.1:5000/api";

const menuList = document.getElementById("menu-list");
const customerForm = document.getElementById("customer-form");
const customerResult = document.getElementById("customer-result");
const orderForm = document.getElementById("order-form");
const orderResult = document.getElementById("order-result");
const checkoutForm = document.getElementById("checkout-form");
const refreshMenuButton = document.getElementById("refresh-menu");

function moneyFromCents(cents) {
    return `$${(cents / 100).toFixed(2)}`;
}

async function fetchMenu() {
    menuList.innerHTML = "<li>Loading menu...</li>";

    try {
        const response = await fetch(`${API_BASE}/menu`);
        const items = await response.json();

        if (!Array.isArray(items) || items.length === 0) {
            menuList.innerHTML = "<li>No menu items yet.</li>";
            return;
        }

        menuList.innerHTML = "";
        for (const item of items) {
            const li = document.createElement("li");
            li.textContent = `#${item.id} - ${item.name} (${moneyFromCents(item.price_cents)}): ${item.description}`;
            menuList.appendChild(li);
        }
    } catch (error) {
        menuList.innerHTML = `<li>Could not load menu: ${error}</li>`;
    }
}

customerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(customerForm);
    const payload = {
        name: formData.get("name"),
        email: formData.get("email"),
        phone: formData.get("phone"),
    };

    try {
        const response = await fetch(`${API_BASE}/customers`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (!response.ok) {
            customerResult.textContent = `Error: ${data.error || "request failed"}`;
            return;
        }

        customerResult.textContent = `Customer saved with ID ${data.id}`;
        customerForm.reset();
    } catch (error) {
        customerResult.textContent = `Error: ${error}`;
    }
});

orderForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(orderForm);
    const payload = {
        customer_id: Number(formData.get("customer_id")),
        notes: formData.get("notes"),
        items: [
            {
                menu_item_id: Number(formData.get("menu_item_id")),
                quantity: Number(formData.get("quantity")),
            },
        ],
    };

    try {
        const response = await fetch(`${API_BASE}/orders`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await response.json();

        if (!response.ok) {
            orderResult.textContent = `Error: ${data.error || "request failed"}`;
            return;
        }

        orderResult.textContent = `Order #${data.id} placed. Total: ${moneyFromCents(data.total_cents)}`;
        orderForm.reset();
    } catch (error) {
        orderResult.textContent = `Error: ${error}`;
    }
});

refreshMenuButton.addEventListener("click", fetchMenu);

if (checkoutForm) {
    checkoutForm.action = `${API_BASE.replace("/api", "")}/checkout`;
}

fetchMenu();
