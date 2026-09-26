const fileInput = document.getElementById("csv-file-input");
const statusEl = document.getElementById("status");
const tableContainer = document.getElementById("table-container");

// Schema. "Transaction" is quoted because TRANSACTION is an SQLite
// keyword. Timestamp is stored as epoch milliseconds so that
// chronological sorting is a true numeric comparison.
const COLUMNS = [
    { name: "AccountLastFour", type: "INTEGER" },
    { name: "AccountName", type: "TEXT" },
    { name: "Pocket", type: "TEXT" },
    { name: "Title", type: "TEXT" },
    { name: "Memo", type: "TEXT" },
    { name: "Amount", type: "REAL" },
    { name: "Timestamp", type: "INTEGER" },
    { name: "Status", type: "TEXT" },
    { name: "Type", type: "TEXT" },
    { name: "CardLastFour", type: "INTEGER" },
    { name: "Note", type: "TEXT" },
];

const COLUMN_NAMES = COLUMNS.map((column) => column.name);

const SCHEMA =
    'CREATE TABLE "Transaction" (' +
    COLUMNS.map((c) => `"${c.name}" ${c.type}`).join(", ") +
    ")";

// Only schema-defined names are ever interpolated into SQL, so CSV
// headers can never influence the query text.
function quote(name) {
    if (!COLUMN_NAMES.includes(name)) {
        throw new Error(`Unknown column: ${name}`);
    }
    return `"${name}"`;
}

const COLUMN_LIST = COLUMN_NAMES.map((n) => `"${n}"`).join(", ");

// Paging happens in SQL (LIMIT/OFFSET) rather than in JS, so only
// the visible page of rows is ever materialised.
const PAGE_SIZE = 10;
let pageState = { page: 1 };

function countRows() {
    const statement = db.prepare(
        'SELECT COUNT(*) AS total FROM "Transaction"'
    );
    try {
        // get() returns a positional array, so read the count via
        // getAsObject() instead of get().total.
        if (!statement.step()) return 0;
        return Number(statement.getAsObject().total) || 0;
    } finally {
        statement.free();
    }
}


// CSV headers are matched to the schema case- and separator-
// insensitively, so "account_last_four", "AccountLastFour" and
// "ACCOUNT LAST FOUR" all resolve to the same column. Without this,
// any mismatch silently turned every value in that column NULL.
function normalizeHeader(header) {
    return String(header)
        .replace(/^\uFEFF/, "")
        .trim()
        .replace(/[^A-Za-z0-9]/g, "")
        .toLowerCase();
}

const HEADER_ALIASES = new Map(
    COLUMN_NAMES.map((name) => [normalizeHeader(name), name])
);

// A few common alternative spellings for the same field.
const EXTRA_ALIASES = new Map([
    ["date", "Timestamp"],
    ["transactiondate", "Timestamp"],
    ["posteddate", "Timestamp"],
    ["description", "Memo"],
    ["notes", "Note"],
    ["card", "CardLastFour"],
    ["account", "AccountName"],
]);

function resolveHeader(header) {
    const key = normalizeHeader(header);
    return (
        HEADER_ALIASES.get(key) || EXTRA_ALIASES.get(key) || null
    );
}

// Rewrites PapaParse's row objects so every key is a schema column
// name. Keys that match nothing are returned separately instead of
// being dropped without a trace.
function normalizeRows(rows) {
    const unknown = new Set();
    const collisions = new Set();
    const normalized = rows.map((row) => {
        const out = {};
        for (const [key, value] of Object.entries(row)) {
            const column = resolveHeader(key);
            if (!column) {
                unknown.add(key);
            } else if (
                Object.prototype.hasOwnProperty.call(out, column)
            ) {
                // Two CSV columns map to one schema column
                // (e.g. "Description" and "Memo"). Keep the first
                // rather than letting a later key overwrite it.
                collisions.add(key);
            } else {
                out[column] = value;
            }
        }
        return out;
    });
    return { rows: normalized, unknown: [...unknown], collisions: [...collisions] };
}


let db = null;
let sortState = { column: null, direction: "asc" };

statusEl.textContent = "Loading database…";

const dbReady = initSqlJs({
    locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/${file}`,
})
    .then((SQL) => {
        db = new SQL.Database();
        db.run(SCHEMA);
        return db;
    })
    .catch((error) => {
        console.error("SQL init error:", error);
        statusEl.textContent =
            "Could not load the database (offline, or the CDN is blocked).";
        throw error;
    });

function isBlank(value) {
    return value === null || value === undefined || value === "";
}

// PapaParse's dynamicTyping only builds a Date for a full ISO
// datetime with a timezone suffix, so Timestamp is coerced here.
// Unparseable dates become NULL rather than sorting as 1970.
function toEpochMs(value) {
    if (isBlank(value)) return null;
    if (value instanceof Date) {
        return Number.isNaN(value.getTime()) ? null : value.getTime();
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
}

function formatTimestamp(ms) {
    if (isBlank(ms)) return "";
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString(undefined, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "numeric",
        minute: "2-digit",
    });
}

function isTextColumn(name) {
    const column = COLUMNS.find((entry) => entry.name === name);
    return column ? column.type === "TEXT" : false;
}

// Rows are inserted inside one transaction so a failed import can
// never leave a half-loaded table behind.
function loadRows(rows) {
    db.run("BEGIN TRANSACTION");
    try {
        db.run('DROP TABLE IF EXISTS "Transaction"');
        db.run(SCHEMA);

        const placeholders = COLUMN_NAMES.map(() => "?").join(", ");

        for (let i = 0; i < rows.length; i += 500) {
            const chunk = rows.slice(i, i + 500);
            const values = [];
            for (const row of chunk) {
                for (const name of COLUMN_NAMES) {
                    values.push(
                        name === "Timestamp"
                            ? toEpochMs(row[name])
                            : isBlank(row[name])
                              ? null
                              : row[name]
                    );
                }
            }
            // Tuples must be comma-separated or the SQL is invalid.
            const tuple = chunk
                .map(() => "(" + placeholders + ")")
                .join(", ");
            db.run(
                `INSERT INTO "Transaction" (${COLUMN_LIST}) VALUES ${tuple}`,
                values
            );
        }

        db.run("COMMIT");
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    }
}

function buildOrderBy() {
    // NULLS LAST keeps blank cells at the bottom in both directions.
    if (sortState.column === null) return "rowid";

    const direction =
        sortState.direction === "asc" ? "ASC" : "DESC";
    const collate = isTextColumn(sortState.column)
        ? " COLLATE NOCASE"
        : "";
    return `${quote(sortState.column)}${collate} ${direction} NULLS LAST`;
}

function queryRows(limit, offset) {
    // Named parameters only: sql.js cannot mix "?" placeholders
    // with a named-parameter object ("datatype mismatch").
    const statement = db.prepare(
        `SELECT ${COLUMN_LIST} FROM "Transaction" ` +
            `ORDER BY ${buildOrderBy()} LIMIT $limit OFFSET $offset`,
        { $limit: limit, $offset: offset }
    );
    const rows = [];
    try {
        while (statement.step()) rows.push(statement.getAsObject());
    } finally {
        statement.free();
    }
    return rows;
}

// Keeps the requested page inside the valid range, which matters
// when a re-upload shrinks the table while the user is on page 3.
function getPage(total) {
    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const page = Math.min(Math.max(1, pageState.page), pageCount);
    pageState.page = page;
    return { page, pageCount };
}

function cycleSort(column) {
    if (sortState.column !== column) {
        sortState = { column, direction: "asc" };
    } else if (sortState.direction === "asc") {
        sortState = { column, direction: "desc" };
    } else {
        sortState = { column: null, direction: "asc" };
    }

    // A new ordering can leave the current page empty, so start
    // again from the first page.
    pageState.page = 1;
    renderTable();
}

function goToPage(page) {
    pageState.page = page;
    renderTable();
}

function createPagination(page, pageCount, total) {
    const nav = document.createElement("nav");
    nav.className = "pagination";
    nav.setAttribute("aria-label", "Pagination");

    const first = (page - 1) * PAGE_SIZE + 1;
    const last = Math.min(page * PAGE_SIZE, total);

    const info = document.createElement("span");
    info.className = "pagination-info";
    info.textContent = `Showing ${first}–${last} of ${total}`;
    // Announce page changes to screen readers.
    info.setAttribute("role", "status");

    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "page-button";
    prev.textContent = "Previous";
    prev.disabled = page <= 1;
    prev.addEventListener("click", () => goToPage(page - 1));

    const next = document.createElement("button");
    next.type = "button";
    next.className = "page-button";
    next.textContent = "Next";
    next.disabled = page >= pageCount;
    next.addEventListener("click", () => goToPage(page + 1));

    const label = document.createElement("span");
    label.className = "pagination-label";
    label.textContent = `Page ${page} of ${pageCount}`;

    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
    nav.appendChild(info);
    return nav;
}

function createHeaderCell(column) {
    const th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.setAttribute(
        "aria-sort",
        sortState.column === column
            ? sortState.direction === "asc"
                ? "ascending"
                : "descending"
            : "none"
    );

    // A real <button> gives keyboard activation and a focus ring
    // for free; the arrow is drawn by CSS so it is not announced.
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sort-button";
    button.textContent = column;
    button.addEventListener("click", () => cycleSort(column));

    th.appendChild(button);
    return th;
}

function renderTable() {
    // Re-rendering destroys the focused button, so remember which
    // column had focus in order to restore it afterwards.
    const active = document.activeElement;
    const focusedColumn =
        active && active.className === "sort-button"
            ? active.textContent
            : null;

    if (db === null) return;

    const total = countRows();
    const { page, pageCount } = getPage(total);
    const rows = queryRows(PAGE_SIZE, (page - 1) * PAGE_SIZE);

    tableContainer.replaceChildren();
    tableContainer.className = "overflow-auto";

    if (total === 0) {
        statusEl.textContent = "No data found in file.";
        return;
    }

    const table = document.createElement("table");
    table.className = "striped";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const column of COLUMN_NAMES) {
        headRow.appendChild(createHeaderCell(column));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
        const tr = document.createElement("tr");
        for (const name of COLUMN_NAMES) {
            const td = document.createElement("td");
            const value = row[name];
            td.textContent =
                name === "Timestamp"
                    ? formatTimestamp(value)
                    : isBlank(value)
                      ? ""
                      : String(value);
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    tableContainer.appendChild(table);

    // Only worth showing when the rows do not all fit on one page.
    if (pageCount > 1) {
        tableContainer.appendChild(
            createPagination(page, pageCount, total)
        );
    }

    if (focusedColumn !== null) {
        const buttons = tableContainer.querySelectorAll(
            ".sort-button"
        );
        for (const button of buttons) {
            if (button.textContent === focusedColumn) {
                button.focus();
                break;
            }
        }
    }
}

fileInput.addEventListener("change", function (event) {
    const file = event.target.files[0];

    if (!file) return;

    // Pass the File object directly to Papa.parse
    Papa.parse(file, {
        header: true, // Optional: turns rows into objects using the first row as headers
        dynamicTyping: true, // Optional: auto-converts numbers and booleans
        complete: function (results) {
            console.log("Parsed data:", results.data);
            console.log("Errors:", results.errors);

            const { rows, unknown, collisions } = normalizeRows(
                Array.isArray(results.data) ? results.data : []
            );

            // Report columns present in the CSV that have no
            // schema counterpart, so nothing disappears quietly.
            const missingColumns = COLUMN_NAMES.filter(
                (name) =>
                    !Object.prototype.hasOwnProperty.call(
                        rows[0] || {},
                        name
                    )
            );

            const badTimestamps = rows.filter(
                (row) =>
                    !isBlank(row.Timestamp) &&
                    toEpochMs(row.Timestamp) === null
            ).length;

            // A new file's headers may not match the old sort.
            sortState = { column: null, direction: "asc" };
            pageState.page = 1;

            // Wait for the WASM module before touching the database,
            // in case a file is chosen before it has finished loading.
            dbReady
                .then(() => {
                    loadRows(rows);
                    renderTable();

                    if (rows.length > 0) {
                        const notes = [];
                        if (results.errors.length > 0) {
                            notes.push(
                                `${results.errors.length} parse issue(s)`
                            );
                        }
                        if (badTimestamps > 0) {
                            notes.push(
                                `${badTimestamps} unreadable timestamp(s)`
                            );
                        }
                        if (unknown.length > 0) {
                            notes.push(
                                `ignored column(s): ${unknown.join(", ")}`
                            );
                        }
                        if (collisions.length > 0) {
                            notes.push(
                                `duplicate mapping ignored: ${collisions.join(", ")}`
                            );
                        }
                        if (missingColumns.length > 0) {
                            notes.push(
                                `not in file: ${missingColumns.join(", ")}`
                            );
                        }
                        statusEl.textContent =
                            `Stored ${rows.length} rows in the database.` +
                            (notes.length > 0
                                ? ` (${notes.join(", ")})`
                                : "");
                    }
                })
                .catch((error) => {
                    console.error("Import error:", error);
                    tableContainer.replaceChildren();
                    statusEl.textContent = `Import error: ${error.message}`;
                });
        },
        error: function (error) {
            console.error("Parse error:", error);
            tableContainer.replaceChildren();
            statusEl.textContent = `Parse error: ${error.message}`;
        },
    });
});
