const MANAGER_API_ROOT = "http://127.0.0.1:5000/api";

const accessLabel = document.getElementById("manager-access-label");
const accessCopy = document.getElementById("manager-access-copy");
const tableStatus = document.getElementById("manager-table-status");
const tableList = document.getElementById("manager-table-list");
const currentTableTitle = document.getElementById("manager-current-table");
const currentTableMeta = document.getElementById("manager-current-table-meta");
const tableWrapper = document.getElementById("manager-table-wrapper");
const refreshTableButton = document.getElementById("manager-refresh-table");
const newRowButton = document.getElementById("manager-new-row");
const rowEditor = document.getElementById("manager-row-editor");
const rowMessage = document.getElementById("manager-row-message");
const editorTitle = document.getElementById("manager-editor-title");
const saveRowButton = document.getElementById("manager-save-row");
const deleteRowButton = document.getElementById("manager-delete-row");
const sqlEditor = document.getElementById("manager-sql-editor");
const sqlParams = document.getElementById("manager-sql-params");
const queryMessage = document.getElementById("manager-query-message");
const queryResults = document.getElementById("manager-query-results");
const runQueryButton = document.getElementById("manager-run-query");

let currentUser = null;
let tables = [];
let currentTable = null;
let currentTableData = null;
let selectedRow = null;
let selectedPrimaryKey = null;

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

function formatJson(value) {
    return JSON.stringify(value, null, 2);
}

function setEditorRow(row, primaryKey) {
    selectedRow = row;
    selectedPrimaryKey = primaryKey || null;
    rowEditor.value = formatJson(row || {});
    editorTitle.textContent = row ? `Editing row${primaryKey ? ` #${row?.[primaryKey]}` : ""}` : "New row";
    deleteRowButton.disabled = !row || !primaryKey;
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
        button.innerHTML = `<span>${table.name}</span><strong>${table.row_count}</strong>`;
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
        tr.addEventListener("click", () => {
            setEditorRow(row, currentTableData.primary_key);
            renderTableRows();
        });
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
    tables = await managerApi("/admin/db/tables");
    tableStatus.textContent = `${tables.length} table${tables.length === 1 ? "" : "s"} available.`;
    renderTableList();

    if (!currentTable && tables.length > 0) {
        await loadTable(tables[0].name);
    }
}

async function loadTable(tableName) {
    currentTable = tableName;
    renderTableList();
    currentTableTitle.textContent = tableName;
    currentTableMeta.textContent = "Loading table data...";
    const data = await managerApi(`/admin/db/tables/${encodeURIComponent(tableName)}?limit=200&offset=0`);
    currentTableData = data;
    currentTableMeta.textContent = `${data.total_rows} row${data.total_rows === 1 ? "" : "s"} · primary key: ${data.primary_key || "none"}`;
    setEditorRow(data.rows[0] || null, data.primary_key);
    renderTableRows();
}

async function saveRow() {
    if (!currentTableData || !currentTable) {
        setFeedback(rowMessage, "Select a table first.", "error");
        return;
    }

    let payload;
    try {
        payload = JSON.parse(rowEditor.value || "{}");
    } catch (error) {
        setFeedback(rowMessage, "Row JSON is invalid.", "error");
        return;
    }

    try {
        if (selectedRow && selectedPrimaryKey && payload[selectedPrimaryKey] !== undefined && payload[selectedPrimaryKey] !== null && payload[selectedPrimaryKey] !== "") {
            const rowId = payload[selectedPrimaryKey];
            await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows/${encodeURIComponent(rowId)}`, {
                method: "PATCH",
                body: JSON.stringify({ row: payload }),
            });
            setFeedback(rowMessage, "Row updated.", "success");
        } else {
            const result = await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows`, {
                method: "POST",
                body: JSON.stringify({ row: payload }),
            });
            setFeedback(rowMessage, "Row inserted.", "success");
            if (result?.row) {
                setEditorRow(result.row, currentTableData.primary_key);
            }
        }
        await loadTables();
        await loadTable(currentTable);
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

async function deleteRow() {
    if (!currentTable || !selectedRow || !selectedPrimaryKey) {
        setFeedback(rowMessage, "Select an existing row first.", "error");
        return;
    }

    try {
        await managerApi(`/admin/db/tables/${encodeURIComponent(currentTable)}/rows/${encodeURIComponent(selectedRow[selectedPrimaryKey])}`, {
            method: "DELETE",
        });
        setFeedback(rowMessage, "Row deleted.", "success");
        setEditorRow(null, currentTableData.primary_key);
        await loadTables();
        await loadTable(currentTable);
    } catch (error) {
        setFeedback(rowMessage, String(error.message || error), "error");
    }
}

async function runQuery() {
    let params = [];
    try {
        params = JSON.parse(sqlParams.value || "[]");
        if (!Array.isArray(params)) {
            throw new Error("Params must be a JSON array.");
        }
    } catch (error) {
        setFeedback(queryMessage, String(error.message || error), "error");
        return;
    }

    try {
        const result = await managerApi("/admin/db/query", {
            method: "POST",
            body: JSON.stringify({
                sql: sqlEditor.value,
                params,
            }),
        });
        queryResults.textContent = formatJson(result);
        setFeedback(queryMessage, "Query completed.", "success");
        await loadTables();
        if (currentTable) {
            await loadTable(currentTable);
        }
    } catch (error) {
        setFeedback(queryMessage, String(error.message || error), "error");
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
        accessCopy.textContent = "Use these tools carefully. Changes save directly to the live SQLite database.";
        await loadTables();
    } catch (error) {
        window.location.href = "auth.html";
    }
}

refreshTableButton?.addEventListener("click", () => {
    if (currentTable) {
        loadTable(currentTable);
    }
});

newRowButton?.addEventListener("click", () => {
    setEditorRow({}, currentTableData?.primary_key || null);
    setFeedback(rowMessage, "Creating a new row.", "success");
});

saveRowButton?.addEventListener("click", saveRow);
deleteRowButton?.addEventListener("click", deleteRow);
runQueryButton?.addEventListener("click", runQuery);

bootstrapManagerPortal();
