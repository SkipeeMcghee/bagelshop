(() => {

const LOCAL_BACKEND_BASE = "http://127.0.0.1:5000";
const MANAGER_BACKEND_BASE =
    window.location.protocol === "file:" || ["127.0.0.1:5501", "localhost:5501"].includes(window.location.host)
        ? LOCAL_BACKEND_BASE
        : window.location.origin;
const MANAGER_API_ROOT = `${MANAGER_BACKEND_BASE}/api`;

const accessLabel = document.getElementById("manager-access-label");
const accessCopy = document.getElementById("manager-access-copy");
const tableStatus = document.getElementById("manager-table-status");
const tableList = document.getElementById("manager-table-list");
const currentTableTitle = document.getElementById("manager-current-table");
const currentTableMeta = document.getElementById("manager-current-table-meta");
const tableWrapper = document.getElementById("manager-table-wrapper");
const refreshTableButton = document.getElementById("manager-refresh-table");
const newRowButton = document.getElementById("manager-new-row");
const rowMessage = document.getElementById("manager-row-message");
const editorTitle = document.getElementById("manager-editor-title");
const recordNote = document.getElementById("manager-record-note");
const saveRowButton = document.getElementById("manager-save-row");
const deleteRowButton = document.getElementById("manager-delete-row");
const duplicateEventButton = document.getElementById("manager-duplicate-event");
const ordersDetailButton = document.getElementById("manager-orders-detail");
const recordFields = document.getElementById("manager-record-fields");
const ordersDetailOverlay = document.getElementById("orders-detail-overlay");
const ordersDetailBackdrop = document.getElementById("orders-detail-backdrop");
const ordersDetailClose = document.getElementById("orders-detail-close");
const ordersDetailTitle = document.getElementById("orders-detail-title");
const ordersDetailSubtitle = document.getElementById("orders-detail-subtitle");
const ordersDetailList = document.getElementById("orders-detail-list");

let currentUser = null;
let tables = [];
let currentTable = null;
let currentTableData = null;
let selectedRow = null;
let selectedPrimaryKey = null;
let isCreatingRecord = false;

if (duplicateEventButton) {
    duplicateEventButton.textContent = "Duplicate +7 Days";
    duplicateEventButton.hidden = true;
}

if (ordersDetailButton) {
    ordersDetailButton.textContent = "Detailed View";
    ordersDetailButton.hidden = true;
}

async function managerApi(path, options = {}) {
    const response = await fetch(`${MANAGER_API_ROOT}${path}`, {
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
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function setFeedback(element, message, type = "success") {
    if (!element) {
        return;
    }
    element.textContent = message;
    element.classList.remove("success", "error");
    if (message) {
        element.classList.add(type);
    }
}

function clearFeedback() {
    setFeedback(rowMessage, "");
}

function updateEventDuplicateButton() {
    if (!duplicateEventButton) {
        return;
    }
    duplicateEventButton.textContent = "Duplicate +7 Days";
    duplicateEventButton.hidden = !(currentTable === "events" && selectedRow && !isCreatingRecord);
}

function updateOrdersDetailButton() {
    if (!ordersDetailButton) {
        return;
    }
    ordersDetailButton.textContent = "Detailed View";
    ordersDetailButton.hidden = !(currentTable === "orders" && Array.isArray(currentTableData?.rows) && currentTableData.rows.length > 0);
}

function updateContextActionButtons() {
    updateEventDuplicateButton();
    updateOrdersDetailButton();
}

function moneyFromCents(cents) {
    return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function formatDateTime(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "Not recorded";
    }
    const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
        return raw;
    }
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(date);
}

function closeOrdersDetails() {
    if (!ordersDetailOverlay) {
        return;
    }
    ordersDetailOverlay.hidden = true;
    document.body.classList.remove("modal-open");
}

function renderOrderDetailCard(order) {
    const article = document.createElement("article");
    article.className = "orders-detail-item";

    const header = document.createElement("div");
    header.className = "orders-detail-item-header";

    const titleBlock = document.createElement("div");
    const title = document.createElement("h4");
    title.textContent = `Order #${order.id}`;

    const buyer = document.createElement("p");
    buyer.className = "orders-detail-buyer";
    buyer.textContent = order.buyer_email
        ? `${order.buyer_name} · ${order.buyer_email}`
        : order.buyer_name || "Guest customer";

    const timing = document.createElement("p");
    timing.className = "orders-detail-meta";
    timing.textContent = `Paid at: ${formatDateTime(order.paid_at)} · Status: ${String(order.payment_status || "pending")}`;

    titleBlock.append(title, buyer, timing);

    const total = document.createElement("strong");
    total.className = "orders-detail-total";
    total.textContent = moneyFromCents(order.total_cents);

    header.append(titleBlock, total);

    const itemSection = document.createElement("div");
    itemSection.className = "orders-detail-section";

    const itemHeading = document.createElement("p");
    itemHeading.className = "orders-detail-section-title";
    itemHeading.textContent = "Items";
    itemSection.appendChild(itemHeading);

    if ((order.items || []).length === 0) {
        const empty = document.createElement("p");
        empty.className = "orders-detail-empty";
        empty.textContent = "No line items recorded for this order.";
        itemSection.appendChild(empty);
    } else {
        const itemList = document.createElement("div");
        itemList.className = "orders-detail-lines";
        for (const item of order.items || []) {
            const row = document.createElement("div");
            row.className = "orders-detail-line";

            const label = document.createElement("span");
            label.textContent = `${item.quantity} × ${item.menu_item_name}`;

            const value = document.createElement("span");
            value.textContent = moneyFromCents(item.line_total_cents);

            row.append(label, value);
            itemList.appendChild(row);
        }
        itemSection.appendChild(itemList);
    }

    const summary = document.createElement("div");
    summary.className = "orders-detail-summary";

    const subtotalRow = document.createElement("div");
    subtotalRow.className = "orders-detail-line";
    subtotalRow.innerHTML = `<span>Subtotal</span><span>${moneyFromCents(order.subtotal_cents)}</span>`;
    summary.appendChild(subtotalRow);

    if ((order.fees || []).length > 0) {
        for (const fee of order.fees || []) {
            const feeRow = document.createElement("div");
            feeRow.className = "orders-detail-line";
            feeRow.innerHTML = `<span>${fee.label}</span><span>${moneyFromCents(fee.amount_cents)}</span>`;
            summary.appendChild(feeRow);
        }
    } else {
        const noFeeRow = document.createElement("div");
        noFeeRow.className = "orders-detail-line muted";
        noFeeRow.innerHTML = `<span>Additional fees</span><span>${moneyFromCents(0)}</span>`;
        summary.appendChild(noFeeRow);
    }

    const totalRow = document.createElement("div");
    totalRow.className = "orders-detail-line total";
    totalRow.innerHTML = `<span>Total</span><span>${moneyFromCents(order.total_cents)}</span>`;
    summary.appendChild(totalRow);

    article.append(header, itemSection, summary);

    if (order.notes) {
        const notes = document.createElement("p");
        notes.className = "orders-detail-notes";
        notes.textContent = `Notes: ${order.notes}`;
        article.appendChild(notes);
    }

    return article;
}

async function openOrdersDetails() {
    if (!ordersDetailOverlay || !ordersDetailList || currentTable !== "orders") {
        return;
    }

    try {
        const orders = await managerApi("/admin/orders/details");
        ordersDetailTitle.textContent = "All orders";
        ordersDetailSubtitle.textContent = `${orders.length} order${orders.length === 1 ? "" : "s"} in the system`;
        ordersDetailList.innerHTML = "";

        if (!Array.isArray(orders) || orders.length === 0) {
            const empty = document.createElement("div");
            empty.className = "empty-state";
            empty.textContent = "No orders are available yet.";
            ordersDetailList.appendChild(empty);
        } else {
            for (const order of orders) {
                ordersDetailList.appendChild(renderOrderDetailCard(order));
            }
        }

        ordersDetailOverlay.hidden = false;
        document.body.classList.add("modal-open");
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

function addDaysToIsoDate(isoDate, days) {
    const raw = String(isoDate || "").trim();
    if (!raw) {
        return "";
    }
    const date = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        return raw;
    }
    date.setDate(date.getDate() + days);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

function getColumnMeta(columnName) {
    return (currentTableData?.columns || []).find((column) => column.name === columnName) || null;
}

function getPreferredInputType(column) {
    const type = String(column?.type || "").toUpperCase();
    const name = String(column?.name || "").toLowerCase();

    if (type.includes("INT")) {
        return "number";
    }
    if (name.includes("date")) {
        return "date";
    }
    if (name.includes("time")) {
        return "time";
    }
    return "text";
}

function shouldUseTextarea(column) {
    const name = String(column?.name || "").toLowerCase();
    return name.includes("description") || name.includes("notes") || name.includes("message");
}

function normalizeInputValue(rawValue, column) {
    if (rawValue === "") {
        return null;
    }

    const type = String(column?.type || "").toUpperCase();
    if (type.includes("INT")) {
        const parsed = Number(rawValue);
        return Number.isFinite(parsed) ? parsed : rawValue;
    }

    return rawValue;
}

function createField(column, value) {
    const wrapper = document.createElement("label");
    wrapper.className = "manager-field";

    const label = document.createElement("span");
    label.className = "manager-field-label";
    label.textContent = column.name;

    const meta = document.createElement("span");
    meta.className = "manager-field-meta";
    meta.textContent = `${column.type || "TEXT"}${column.pk ? " · primary key" : ""}${column.notnull ? " · required" : ""}`;

    const input = shouldUseTextarea(column)
        ? document.createElement("textarea")
        : document.createElement("input");

    input.className = "manager-field-input";
    input.name = column.name;
    input.dataset.columnName = column.name;

    if (input.tagName === "TEXTAREA") {
        input.rows = 4;
    } else {
        input.type = getPreferredInputType(column);
    }

    if (value !== null && value !== undefined) {
        input.value = String(value);
    }

    if (column.pk && !isCreatingRecord) {
        input.disabled = true;
    }

    wrapper.append(label, meta, input);
    return wrapper;
}

function renderRecordForm(row = null) {
    if (!recordFields) {
        return;
    }

    recordFields.innerHTML = "";
    const columns = currentTableData?.columns || [];
    if (columns.length === 0) {
        recordFields.innerHTML = '<div class="empty-state">Select a table first.</div>';
        return;
    }

    for (const column of columns) {
        recordFields.appendChild(createField(column, row ? row[column.name] : null));
    }

}

function selectRow(row) {
    selectedRow = row;
    selectedPrimaryKey = currentTableData?.primary_key || null;
    isCreatingRecord = false;
    editorTitle.textContent = selectedPrimaryKey && row?.[selectedPrimaryKey] !== undefined
        ? `Editing record #${row[selectedPrimaryKey]}`
        : "Editing record";
    recordNote.textContent = "Update fields below and click Save Changes, or use Delete Record to remove the selected row.";
    deleteRowButton.disabled = !selectedPrimaryKey || !row;
    renderRecordForm(row);
    updateContextActionButtons();
    renderTableRows();
}

function startNewRecord() {
    if (!currentTableData) {
        setFeedback(rowMessage, "Select a table first.", "error");
        return;
    }

    clearFeedback();
    selectedRow = null;
    selectedPrimaryKey = currentTableData.primary_key || null;
    isCreatingRecord = true;
    editorTitle.textContent = `Creating new ${currentTable || "record"}`;
    recordNote.textContent = "Enter values for the new record below, then click Save Changes to insert it.";
    deleteRowButton.disabled = true;
    renderRecordForm(null);
    updateContextActionButtons();
    renderTableRows();
}

function renderTableList() {
    if (!tableList) {
        return;
    }

    tableList.innerHTML = "";
    for (const table of tables) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `manager-table-button${currentTable === table.name ? " active" : ""}`;

        const copy = document.createElement("div");
        copy.className = "manager-table-button-copy";

        const title = document.createElement("strong");
        title.textContent = table.name;

        const meta = document.createElement("span");
        meta.textContent = `${table.row_count} row${table.row_count === 1 ? "" : "s"}`;

        const chips = document.createElement("div");
        chips.className = "manager-table-chips";
        for (const column of table.columns.slice(0, 4)) {
            const chip = document.createElement("span");
            chip.className = "manager-table-chip";
            chip.textContent = column.name;
            chips.appendChild(chip);
        }
        if (table.columns.length > 4) {
            const chip = document.createElement("span");
            chip.className = "manager-table-chip more";
            chip.textContent = `+${table.columns.length - 4} more`;
            chips.appendChild(chip);
        }

        copy.append(title, meta, chips);
        button.appendChild(copy);
        button.addEventListener("click", () => loadTable(table.name));
        tableList.appendChild(button);
    }
}

function renderTableRows() {
    if (!tableWrapper) {
        return;
    }
    tableWrapper.innerHTML = "";

    if (!currentTableData || !Array.isArray(currentTableData.rows) || currentTableData.rows.length === 0) {
        tableWrapper.innerHTML = '<div class="empty-state">No rows found for this table.</div>';
        return;
    }

    const table = document.createElement("table");
    table.className = "manager-data-table";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of currentTableData.columns || []) {
        const th = document.createElement("th");
        th.textContent = column.name;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of currentTableData.rows) {
        const tr = document.createElement("tr");
        if (selectedPrimaryKey && selectedRow && row[selectedPrimaryKey] === selectedRow[selectedPrimaryKey]) {
            tr.classList.add("active");
        }
        tr.addEventListener("click", () => selectRow(row));

        for (const column of currentTableData.columns || []) {
            const td = document.createElement("td");
            const value = row[column.name];
            td.textContent = value === null || value === undefined ? "" : String(value);
            tr.appendChild(td);
        }

        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    tableWrapper.appendChild(table);
}

async function loadTables() {
    tableStatus.textContent = "Loading tables...";
    try {
        tables = await managerApi("/admin/db/tables");
        tableStatus.textContent = `${tables.length} table${tables.length === 1 ? "" : "s"} available.`;
        renderTableList();

        if (!currentTable && tables.length > 0) {
            await loadTable(tables[0].name);
        }
    } catch (error) {
        tableStatus.textContent = `Could not load tables: ${String(error.message || error)}`;
        throw error;
    }
}

async function loadTable(tableName) {
    clearFeedback();
    currentTable = tableName;
    selectedRow = null;
    selectedPrimaryKey = null;
    isCreatingRecord = false;
    currentTableData = null;
    updateContextActionButtons();
    renderTableList();
    currentTableTitle.textContent = tableName;
    currentTableMeta.textContent = "Loading table data...";
    try {
        const data = await managerApi(`/admin/db/tables/${encodeURIComponent(tableName)}?limit=200&offset=0`);
        currentTableData = data;
        currentTableMeta.textContent = `${data.total_rows} row${data.total_rows === 1 ? "" : "s"} · primary key: ${data.primary_key || "none"}`;

        if (data.rows[0]) {
            selectRow(data.rows[0]);
        } else {
            isCreatingRecord = true;
            selectedRow = null;
            selectedPrimaryKey = data.primary_key || null;
            editorTitle.textContent = `Create first ${tableName} record`;
            recordNote.textContent = "This table is empty. Fill in the fields below and click Save Changes to create the first row.";
            deleteRowButton.disabled = true;
            renderRecordForm(null);
            updateContextActionButtons();
            renderTableRows();
        }
    } catch (error) {
        currentTableMeta.textContent = `Could not load table: ${String(error.message || error)}`;
        tableWrapper.innerHTML = '<div class="empty-state">This table could not be loaded.</div>';
        throw error;
    }
}

function collectFormPayload() {
    const payload = {};
    const inputs = recordFields?.querySelectorAll("[data-column-name]") || [];

    for (const input of inputs) {
        const columnName = input.dataset.columnName;
        const column = getColumnMeta(columnName);
        if (!column) {
            continue;
        }

        if (column.pk && isCreatingRecord && input.value === "") {
            continue;
        }

        if (column.pk && input.disabled) {
            continue;
        }

        payload[columnName] = normalizeInputValue(input.value, column);
    }

    return payload;
}

async function saveRow() {
    if (!currentTableData || !currentTable) {
        setFeedback(rowMessage, "Select a table first.", "error");
        return;
    }

    const payload = collectFormPayload();

    try {
        if (!isCreatingRecord && selectedRow && selectedPrimaryKey) {
            await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows/${encodeURIComponent(selectedRow[selectedPrimaryKey])}`, {
                method: "PATCH",
                body: JSON.stringify({ row: payload }),
            });
            setFeedback(rowMessage, "Record updated.", "success");
        } else {
            await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows`, {
                method: "POST",
                body: JSON.stringify({ row: payload }),
            });
            setFeedback(rowMessage, "Record created.", "success");
        }

        await loadTables();
        await loadTable(currentTable);
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

async function deleteRow() {
    if (!currentTable || !selectedRow || !selectedPrimaryKey) {
        setFeedback(rowMessage, "Select an existing record first.", "error");
        return;
    }

    try {
        await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows/${encodeURIComponent(selectedRow[selectedPrimaryKey])}`, {
            method: "DELETE",
        });
        setFeedback(rowMessage, "Record deleted.", "success");
        selectedRow = null;
        await loadTables();
        await loadTable(currentTable);
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

async function duplicateSelectedEvent() {
    if (currentTable !== "events" || !selectedRow || isCreatingRecord) {
        setFeedback(rowMessage, "Select an existing event first.", "error");
        return;
    }

    try {
        const selectedEventId = selectedRow?.id ?? selectedRow?.[selectedPrimaryKey || "id"];
        let result = null;

        if (selectedEventId !== null && selectedEventId !== undefined && selectedEventId !== "") {
            try {
                result = await managerApi(`/admin/events/${encodeURIComponent(selectedEventId)}/duplicate-week`, {
                    method: "POST",
                });
            } catch (error) {
                if (![400, 404, 405, 500].includes(Number(error?.status || 0))) {
                    throw error;
                }
            }
        }

        if (!result?.row) {
            const duplicatedRow = {
                ...selectedRow,
                event_date: addDaysToIsoDate(selectedRow?.event_date, 7),
            };
            delete duplicatedRow.id;
            result = await managerApi(`/admin/db/tables/${encodeURIComponent("events")}/rows`, {
                method: "POST",
                body: JSON.stringify({ row: duplicatedRow }),
            });
        }

        setFeedback(rowMessage, "Event duplicated for seven days later.", "success");
        await loadTables();
        await loadTable(currentTable);
        if (result?.row) {
            selectRow(result.row);
        }
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

async function bootstrapManagerPortal() {
    try {
        const sessionData = await managerApi("/me");
        if (!sessionData?.authenticated || !sessionData.user) {
            window.location.href = "auth.html";
            return;
        }
        currentUser = sessionData.user;
        if (!currentUser.is_admin) {
            window.location.href = "account.html";
            return;
        }
        accessLabel.textContent = `Admin access granted to ${currentUser.name || currentUser.email || "manager"}`;
        accessCopy.textContent = "Changes made here save directly to the live SQLite database through clickable manager controls.";
        await loadTables();
    } catch (error) {
        if (error?.status === 401) {
            window.location.href = "auth.html";
            return;
        }
        if (error?.status === 403) {
            window.location.href = "account.html";
            return;
        }
        accessLabel.textContent = "Manager portal unavailable";
        accessCopy.textContent = String(error.message || error);
    }
}

refreshTableButton?.addEventListener("click", () => {
    if (currentTable) {
        loadTable(currentTable);
    }
});

newRowButton?.addEventListener("click", startNewRecord);
saveRowButton?.addEventListener("click", saveRow);
deleteRowButton?.addEventListener("click", deleteRow);
duplicateEventButton?.addEventListener("click", duplicateSelectedEvent);
ordersDetailButton?.addEventListener("click", openOrdersDetails);
ordersDetailClose?.addEventListener("click", closeOrdersDetails);
ordersDetailBackdrop?.addEventListener("click", closeOrdersDetails);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ordersDetailOverlay?.hidden) {
        closeOrdersDetails();
    }
});

bootstrapManagerPortal();

})();
