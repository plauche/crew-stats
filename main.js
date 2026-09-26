const fileInput = document.getElementById("csv-file-input");
const statusEl = document.getElementById("status");
const tableContainer = document.getElementById("table-container");
const cardDialog = document.getElementById("transaction-card");
const cardTitle = document.getElementById("transaction-card-title");
const cardFields = document.getElementById("transaction-card-fields");
const cardClose = document.getElementById("transaction-card-close");
const tabButtons = [...document.querySelectorAll('[role="tab"]')];
const tabPanels = [...document.querySelectorAll('[role="tabpanel"]')];
const pocketSelect = document.getElementById("pocket-select");
const pocketStatus = document.getElementById("pocket-status");
const pocketContainer = document.getElementById("pocket-container");
const pocketChartFigure = document.getElementById("pocket-chart-figure");
const pocketChartCaption = document.getElementById("pocket-chart-caption");
const pocketChartWrap = document.getElementById("pocket-chart-wrap");
const pocketChartCanvas = document.getElementById("pocket-chart");
const pocketStats = document.getElementById("pocket-stats");
const pocketStatsList = document.getElementById("pocket-stats-list");

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

const TEXT_COLUMNS = new Set(
    COLUMNS.filter((c) => c.type === "TEXT").map((c) => c.name)
);

// Columns shown in the table, in display order, with their header
// labels. Sorting still runs against the underlying schema column,
// so "Date" sorts by Timestamp.
const DISPLAY_COLUMNS = [
    { label: "Date", column: "Timestamp" },
    { label: "Title", column: "Title" },
    { label: "Pocket", column: "Pocket" },
    { label: "Amount", column: "Amount" },
];

// Columns shown in the Pockets tab, in display order. Same shape as
// DISPLAY_COLUMNS so more fields can be added here alone; this view
// is not sortable, so the column names are only used for lookup.
// Note carries the pocket a row was moved out of (see
// repairPocketLabels), so a pocket can be reviewed without opening
// every row.
const POCKET_COLUMNS = [
    { label: "Date", column: "Timestamp" },
    { label: "Title", column: "Title" },
    { label: "Amount", column: "Amount" },
    { label: "Note", column: "Note" },
];

// Paging happens in SQL (LIMIT/OFFSET) rather than in JS, so only
// the visible page of rows is ever materialised. Every path that
// shrinks the table (a new import) or re-orders it (a new sort) also
// resets this to 1, so it is never left pointing past the end.
const PAGE_SIZE = 10;
let currentPage = 1;

// Pockets tab state. The page is reset whenever the selected pocket
// changes or a new file is imported, so it is likewise never left
// pointing past the end of the pocket's rows.
let pocketState = { pocket: null, page: 1 };

// The live Chart.js instance and the pocket the chart and statistics
// were built for, so re-rendering the list while paging does not
// rebuild either. destroyPocketChart() always resets the chart, and
// hidePocketSummary() resets the key too.
let pocketChart = null;
let pocketSummaryKey = null;

// How many monthly buckets the chart shows, ending with the most
// recent month recorded across all pockets.
const MONTHS_IN_WINDOW = 12;

// Averaging periods for the statistics, counted back from the end of
// that same window (the most recent month), so they are always a tail
// of the charted months.
const SPENDING_PERIODS = [3, 6, 12];


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

// The export sometimes loses the pocket assignment on Autopilot
// Reserve transfers: the Title names the funding pocket, but the row
// is filed under a pocket that neither the Title nor the Memo
// mentions. Such rows are parked in REVIEW_POCKET so the wrong pocket
// is not silently inflated, and their original pocket is kept in Note
// so the review queue still says where they belonged.
//
// Both comparisons are case-insensitive because the full export
// spells the title "Autopilot reserve" as often as "Autopilot
// Reserve". Note is only written here, never read, so importing the
// same file again derives the same result.
const AUTOPILOT_RESERVE_TITLE = "Autopilot Reserve";
// Older exports spell the transfer title just "Autopilot", without
// the "Reserve" suffix, so both filters below match this shorter
// form; every title containing "Autopilot Reserve" contains it too.
const AUTOPILOT_TITLE = "Autopilot";
const REVIEW_POCKET = "Needs Attention";

function repairPocketLabels(rows) {
    let reassigned = 0;

    const repaired = rows.map((row) => {
        const title = (row.Title || "").toLowerCase();
        if (!title.includes(AUTOPILOT_TITLE.toLowerCase())) {
            return row;
        }

        const original = (row.Pocket || "").trim();
        const haystack =
            `${row.Title || ""}\n${row.Memo || ""}`.toLowerCase();
        // Exempt a row the Title (or Memo) already justifies, and a
        // row already filed under the Autopilot Reserve pocket: the
        // pairing pass runs first and puts the negative leg there,
        // possibly with only "Autopilot" in the Title, and that leg
        // must not be bounced to the review queue.
        if (
            original !== "" &&
            (haystack.includes(original.toLowerCase()) ||
                original.toLowerCase() ===
                    AUTOPILOT_RESERVE_TITLE.toLowerCase())
        ) {
            return row;
        }

        reassigned += 1;
        // A blank pocket records itself as such rather than leaving
        // the reviewer to wonder whether the note was lost.
        const label = `was: ${original === "" ? "(blank)" : original}`;
        const note = (row.Note || "").trim();
        return {
            ...row,
            Pocket: REVIEW_POCKET,
            Note: note === "" ? label : `${note} · ${label}`,
        };
    });

    return { rows: repaired, reassigned };
}

// A mirrored pair of Autopilot transfers filed under the same
// pocket on the same day is one movement recorded twice: the positive
// leg belongs to that pocket, while the negative leg is the reserve
// side and is filed under the Autopilot Reserve pocket instead. The
// original pocket is kept in Note, the same way repairPocketLabels
// records it. Both title spellings count, because one leg may read
// "Autopilot" where the other reads "Autopilot Reserve".
//
// This runs before repairPocketLabels so the pairing is done on the
// pockets as filed in the export, and so the moved leg's new pocket
// ("Autopilot Reserve", which a "Autopilot Reserve" title mentions)
// is left alone by the repair pass. Rows without a readable day or a
// non-zero amount are never paired, and a group with no positive leg
// is left untouched.
function pairAutopilotReserveLegs(rows) {
    const groups = new Map();

    rows.forEach((row, index) => {
        const title = (row.Title || "").toLowerCase();
        if (!title.includes(AUTOPILOT_TITLE.toLowerCase())) {
            return;
        }

        const amount = Number(row.Amount);
        const ms = toEpochMs(row.Timestamp);
        if (!Number.isFinite(amount) || amount === 0 || ms === null) {
            return;
        }

        const date = new Date(ms);
        const key = [
            (row.Pocket || "").trim(),
            date.getFullYear(),
            date.getMonth(),
            date.getDate(),
            Math.abs(amount),
        ].join("\u0000");

        const group = groups.get(key);
        if (group === undefined) {
            groups.set(key, [index]);
        } else {
            group.push(index);
        }
    });

    let moved = 0;
    const paired = rows.slice();

    for (const indexes of groups.values()) {
        if (!indexes.some((i) => Number(paired[i].Amount) > 0)) continue;

        for (const i of indexes) {
            if (Number(paired[i].Amount) >= 0) continue;

            const original = (paired[i].Pocket || "").trim();
            const label = `was: ${original === "" ? "(blank)" : original}`;
            const note = (paired[i].Note || "").trim();
            paired[i] = {
                ...paired[i],
                Pocket: AUTOPILOT_RESERVE_TITLE,
                Note: note === "" ? label : `${note} · ${label}`,
            };
            moved += 1;
        }
    }

    return { rows: paired, moved };
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

// Unparseable dates become NULL rather than sorting as 1970. Values
// arrive as strings because PapaParse's dynamicTyping is disabled.
function toEpochMs(value) {
    if (isBlank(value)) return null;
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

// Compact table date like "September 25". The year is left out of
// the table on purpose; the detail card shows the full timestamp.
function formatMonthDay(ms) {
    if (isBlank(ms)) return "";
    const date = new Date(Number(ms));
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleDateString(undefined, {
        month: "long",
        day: "numeric",
    });
}

// Cell value for storage: blank cells become NULL, and Timestamp is
// coerced to epoch milliseconds.
function toDbValue(name, value) {
    if (name === "Timestamp") return toEpochMs(value);
    return isBlank(value) ? null : value;
}

// USD currency for display: "$1,200.50". Non-numeric values fall
// through unchanged so nothing disappears.
function formatCurrency(value) {
    if (isBlank(value)) return "";
    const amount = Number(value);
    if (Number.isNaN(amount)) return String(value);
    return amount.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
    });
}

// Cell value for display: Timestamp as a local date, Amount as USD
// currency; blanks render empty.
function formatCell(name, value) {
    if (name === "Timestamp") return formatTimestamp(value);
    if (name === "Amount") return formatCurrency(value);
    return isBlank(value) ? "" : String(value);
}

// Rows are inserted inside one transaction so a failed import can
// never leave a half-loaded table behind.
function loadRows(rows) {
    db.run("BEGIN TRANSACTION");
    let statement = null;
    try {
        // The table is created once at startup, so a re-import only
        // needs to clear the previous rows.
        db.run('DELETE FROM "Transaction"');

        const placeholders = COLUMN_NAMES.map(() => "?").join(", ");
        // One prepared statement reused for every row replaces the
        // old hand-built multi-row tuple strings.
        statement = db.prepare(
            `INSERT INTO "Transaction" (${COLUMN_LIST}) VALUES (${placeholders})`
        );
        for (const row of rows) {
            statement.run(
                COLUMN_NAMES.map((name) => toDbValue(name, row[name]))
            );
        }

        db.run("COMMIT");
    } catch (error) {
        db.run("ROLLBACK");
        throw error;
    } finally {
        if (statement !== null) statement.free();
    }
}

function buildOrderBy() {
    // NULLS LAST keeps blank cells at the bottom in both directions.
    if (sortState.column === null) return "rowid";

    const direction =
        sortState.direction === "asc" ? "ASC" : "DESC";
    const collate = TEXT_COLUMNS.has(sortState.column)
        ? " COLLATE NOCASE"
        : "";
    return `${quote(sortState.column)}${collate} ${direction} NULLS LAST`;
}

// Fetches the visible page of rows along with the full table size:
// COUNT(*) OVER () is evaluated before LIMIT/OFFSET, so one query
// replaces the old separate count + fetch.
function queryPage() {
    // Named parameters only: sql.js cannot mix "?" placeholders
    // with a named-parameter object ("datatype mismatch").
    const statement = db.prepare(
        `SELECT ${COLUMN_LIST}, COUNT(*) OVER () AS "__total" ` +
            `FROM "Transaction" ` +
            `ORDER BY ${buildOrderBy()} LIMIT $limit OFFSET $offset`,
        { $limit: PAGE_SIZE, $offset: (currentPage - 1) * PAGE_SIZE }
    );
    const rows = [];
    try {
        while (statement.step()) rows.push(statement.getAsObject());
    } finally {
        statement.free();
    }
    // An empty result means an empty table: the page is reset to 1
    // before any operation that could shrink the data, so an offset
    // past the end cannot happen.
    const total = rows.length > 0 ? Number(rows[0]["__total"]) : 0;
    return { rows, total };
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
    currentPage = 1;
    renderTable();
}

function goToPage(page) {
    currentPage = page;
    renderTable();
}

// Shared by both tabs: the callbacks decide which view re-renders,
// and keyPrefix keeps the focus-restore keys unique between them.
function createPagination(page, pageCount, total, { keyPrefix, onPrev, onNext }) {
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
    prev.dataset.focusKey = `${keyPrefix}:prev`;
    prev.textContent = "Previous";
    prev.disabled = page <= 1;
    prev.addEventListener("click", onPrev);

    const next = document.createElement("button");
    next.type = "button";
    next.className = "page-button";
    next.dataset.focusKey = `${keyPrefix}:next`;
    next.textContent = "Next";
    next.disabled = page >= pageCount;
    next.addEventListener("click", onNext);

    const label = document.createElement("span");
    label.className = "pagination-label";
    label.textContent = `Page ${page} of ${pageCount}`;

    nav.appendChild(prev);
    nav.appendChild(label);
    nav.appendChild(next);
    nav.appendChild(info);
    return nav;
}

function createHeaderCell(display) {
    const th = document.createElement("th");
    th.setAttribute("scope", "col");
    th.setAttribute(
        "aria-sort",
        sortState.column === display.column
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
    button.textContent = display.label;
    button.dataset.focusKey = "sort:" + display.column;
    button.addEventListener("click", () => cycleSort(display.column));

    th.appendChild(button);
    return th;
}

function renderTable() {
    // Re-rendering destroys the focused control, so remember its
    // data-focus-key in order to restore focus afterwards.
    const active = document.activeElement;
    const focusedKey =
        active && active.dataset ? active.dataset.focusKey || null : null;

    if (db === null) return;

    const { rows, total } = queryPage();

    tableContainer.replaceChildren();
    tableContainer.className = "overflow-auto";

    if (total === 0) {
        statusEl.textContent = "No data found in file.";
        return;
    }

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const table = document.createElement("table");
    table.className = "striped";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const display of DISPLAY_COLUMNS) {
        headRow.appendChild(createHeaderCell(display));
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
        const tr = document.createElement("tr");
        for (const display of DISPLAY_COLUMNS) {
            const td = document.createElement("td");
            const value = row[display.column];
            td.textContent =
                display.column === "Timestamp"
                    ? formatMonthDay(value)
                    : formatCell(display.column, value);
            tr.appendChild(td);
        }
        // The row is the click target; the closure carries the full
        // row data, so no lookup table is needed. Rows are tabbable
        // and open the card with Enter or Space, like a button.
        tr.addEventListener("click", () => openCard(row));
        tr.tabIndex = 0;
        tr.setAttribute("aria-haspopup", "dialog");
        tr.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openCard(row);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    tableContainer.appendChild(table);

    // Only worth showing when the rows do not all fit on one page.
    if (pageCount > 1) {
        tableContainer.appendChild(
            createPagination(currentPage, pageCount, total, {
                keyPrefix: "page",
                onPrev: () => goToPage(currentPage - 1),
                onNext: () => goToPage(currentPage + 1),
            })
        );
    }

    if (focusedKey !== null) {
        const target = tableContainer.querySelector(
            `[data-focus-key="${focusedKey}"]`
        );
        if (target !== null) target.focus();
    }
}

/* ------------------------------ Tabs ------------------------------ */

// Roving-tabindex tab switching: exactly one tab is selected, and its
// panel is the only one visible. Panel ids are derived from tab ids,
// so "panel-transactions" pairs with "tab-transactions".
function selectTab(name) {
    for (const button of tabButtons) {
        const selected = button.id === `tab-${name}`;
        button.setAttribute("aria-selected", selected ? "true" : "false");
        button.tabIndex = selected ? 0 : -1;
    }
    for (const panel of tabPanels) {
        panel.hidden = panel.id !== `panel-${name}`;
    }

    // The Pockets panel is re-rendered on entry so it can never show
    // rows that a newer import has since replaced, and the chart is
    // torn down on the way out so the next one is built against the
    // size the panel really has rather than a hidden canvas.
    if (name === "pockets") {
        renderPocket();
    } else {
        hidePocketSummary();
    }
}

function tabName(button) {
    return button.id.replace(/^tab-/, "");
}

for (const button of tabButtons) {
    button.addEventListener("click", () => selectTab(tabName(button)));

    // Arrow keys move between tabs and select as they go, which is
    // what the ARIA tabs pattern expects.
    button.addEventListener("keydown", (event) => {
        const index = tabButtons.indexOf(button);
        let target = null;
        if (event.key === "ArrowRight") {
            target = tabButtons[(index + 1) % tabButtons.length];
        } else if (event.key === "ArrowLeft") {
            target =
                tabButtons[(index - 1 + tabButtons.length) % tabButtons.length];
        } else if (event.key === "Home") {
            target = tabButtons[0];
        } else if (event.key === "End") {
            target = tabButtons[tabButtons.length - 1];
        }
        if (target === null) return;
        event.preventDefault();
        target.focus();
        selectTab(tabName(target));
    });
}

/* ----------------------------- Pockets ---------------------------- */

const POCKET_PLACEHOLDER = "Select a pocket…";

// Distinct, non-blank pocket names in alphabetical order. DISTINCT
// compares the stored values exactly; only the ordering is
// case-insensitive. A blank Pocket is not a name, so it is excluded.
function queryPocketNames() {
    const statement = db.prepare(
        `SELECT DISTINCT "Pocket" FROM "Transaction" ` +
            `WHERE "Pocket" IS NOT NULL AND TRIM("Pocket") <> '' ` +
            `ORDER BY "Pocket" COLLATE NOCASE ASC`
    );
    const names = [];
    try {
        while (statement.step()) names.push(statement.getAsObject().Pocket);
    } finally {
        statement.free();
    }
    return names;
}

// Rebuilds the dropdown from the current data, keeping the selection
// only when that pocket still exists. Callers that must drop the
// selection (an import) clear pocketState first.
function populatePocketOptions() {
    const names = db === null ? [] : queryPocketNames();

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = POCKET_PLACEHOLDER;

    const options = [placeholder];
    for (const name of names) {
        const option = document.createElement("option");
        option.value = name;
        option.textContent = name;
        options.push(option);
    }
    pocketSelect.replaceChildren(...options);
    pocketSelect.disabled = names.length === 0;

    const keep = pocketState.pocket;
    if (keep !== null && names.includes(keep)) {
        pocketSelect.value = keep;
    } else {
        pocketSelect.value = "";
        pocketState = { pocket: null, page: 1 };
        pocketContainer.replaceChildren();
    }
}

// A new import invalidates the whole tab: the list of pockets can
// change entirely, so any previous selection is dropped.
function resetPocketView() {
    pocketState = { pocket: null, page: 1 };
    pocketContainer.replaceChildren();
    populatePocketOptions();
    // Sets the appropriate instruction / empty-state message.
    renderPocket();
}

// The visible page of one pocket's transactions, newest first. Every
// column is selected (not just the displayed three) so a row click
// can open the same detail card as the Transactions tab. Timestamp
// is epoch milliseconds, so DESC is a true chronological order, and
// rowid breaks ties between equal timestamps.
function queryPocketPage() {
    if (db === null || pocketState.pocket === null) {
        return { rows: [], total: 0 };
    }

    // Named parameters only: sql.js cannot mix "?" placeholders
    // with a named-parameter object ("datatype mismatch").
    const statement = db.prepare(
        `SELECT ${COLUMN_LIST}, COUNT(*) OVER () AS "__total" ` +
            `FROM "Transaction" WHERE "Pocket" = $pocket ` +
            `ORDER BY "Timestamp" DESC NULLS LAST, rowid DESC ` +
            `LIMIT $limit OFFSET $offset`,
        {
            $pocket: pocketState.pocket,
            $limit: PAGE_SIZE,
            $offset: (pocketState.page - 1) * PAGE_SIZE,
        }
    );
    const rows = [];
    try {
        while (statement.step()) rows.push(statement.getAsObject());
    } finally {
        statement.free();
    }
    const total = rows.length > 0 ? Number(rows[0]["__total"]) : 0;
    return { rows, total };
}

function goToPocketPage(page) {
    pocketState = { pocket: pocketState.pocket, page };
    renderPocket();
}

// The single place that keeps the dropdown, the status line and the
// pocket table in step. It re-runs on tab entry, on selection change
// and on paging.
function renderPocket() {
    if (db === null) return;

    // Re-rendering destroys the focused control, so remember its
    // data-focus-key in order to restore focus afterwards.
    const active = document.activeElement;
    const focusedKey =
        active && active.dataset ? active.dataset.focusKey || null : null;

    if (pocketSelect.options.length === 0) populatePocketOptions();

    pocketContainer.replaceChildren();
    pocketContainer.className = "overflow-auto";

    if (pocketSelect.disabled) {
        pocketStatus.textContent = "No pockets in this file.";
        hidePocketSummary();
        return;
    }

    if (pocketState.pocket === null) {
        pocketStatus.textContent = "Select a pocket to view its transactions.";
        hidePocketSummary();
        return;
    }

    const { rows, total } = queryPocketPage();
    if (total === 0) {
        pocketStatus.textContent = `No transactions in ${pocketState.pocket}.`;
        hidePocketSummary();
        return;
    }

    pocketStatus.textContent = "";

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    const table = document.createElement("table");
    table.className = "striped";

    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    for (const display of POCKET_COLUMNS) {
        const th = document.createElement("th");
        th.setAttribute("scope", "col");
        th.textContent = display.label;
        headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    for (const row of rows) {
        const tr = document.createElement("tr");
        for (const display of POCKET_COLUMNS) {
            const td = document.createElement("td");
            const value = row[display.column];
            td.textContent =
                display.column === "Timestamp"
                    ? formatMonthDay(value)
                    : formatCell(display.column, value);
            tr.appendChild(td);
        }
        // Same interaction as the Transactions table: the row is the
        // click target and opens the detail card, and the closure
        // carries the full row so no lookup table is needed.
        tr.addEventListener("click", () => openCard(row));
        tr.tabIndex = 0;
        tr.setAttribute("aria-haspopup", "dialog");
        tr.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            openCard(row);
        });
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    pocketContainer.appendChild(table);

    // Only worth showing when the rows do not all fit on one page.
    if (pageCount > 1) {
        pocketContainer.appendChild(
            createPagination(pocketState.page, pageCount, total, {
                keyPrefix: "pocket-page",
                onPrev: () => goToPocketPage(pocketState.page - 1),
                onNext: () => goToPocketPage(pocketState.page + 1),
            })
        );
    }

    if (focusedKey !== null) {
        const target = pocketContainer.querySelector(
            `[data-focus-key="${focusedKey}"]`
        );
        if (target !== null) target.focus();
    }

    // Rendered last, once the list they describe is in place. A paging
    // re-render leaves the existing chart and statistics alone.
    renderPocketSummary();
}

pocketSelect.addEventListener("change", () => {
    const value = pocketSelect.value;
    // A changed pocket always starts back at its first page.
    pocketState = { pocket: value === "" ? null : value, page: 1 };
    renderPocket();
});

/* --------------------------- Pocket chart -------------------------- */

// Chart.js loads from a CDN next to sql.js and PapaParse. If it is
// blocked the table still works, so every entry point checks first.
function chartAvailable() {
    return typeof Chart !== "undefined";
}

// The window ends with the most recent month that has a usable
// timestamp anywhere in the table (not just the selected pocket), so
// every pocket is charted on the same absolute timeline. Buckets are
// built from local dates to agree with formatMonthDay: SQLite's
// "localtime" modifier is effectively UTC inside the sql.js WASM
// build, so strftime cannot be trusted for month boundaries here.
function monthlySpendingWindow() {
    if (db === null) return null;

    const statement = db.prepare(
        `SELECT MAX("Timestamp") AS "__latest" FROM "Transaction" ` +
            `WHERE "Timestamp" IS NOT NULL`
    );
    let latest = null;
    try {
        if (statement.step()) latest = statement.getAsObject()["__latest"];
    } finally {
        statement.free();
    }
    if (isBlank(latest)) return null;

    const anchor = new Date(Number(latest));
    if (Number.isNaN(anchor.getTime())) return null;

    // The window opens on the first of the month eleven months before
    // the anchor month.
    const start = new Date(
        anchor.getFullYear(),
        anchor.getMonth() - (MONTHS_IN_WINDOW - 1),
        1
    );

    const labels = [];
    const buckets = [];
    for (let i = 0; i < MONTHS_IN_WINDOW; i += 1) {
        const month = new Date(start.getFullYear(), start.getMonth() + i, 1);
        labels.push(
            month.toLocaleDateString(undefined, {
                month: "short",
                year: "numeric",
            })
        );
        buckets.push(month.getFullYear() * MONTHS_IN_WINDOW + month.getMonth());
    }

    return { labels, buckets, startMs: start.getTime(), start };
}

// Spending per month for the selected pocket: only outgoing amounts
// count, so credits and refunds are ignored rather than netting a
// month down, and every bar is positive.
//
// This is the one query that aggregates in JS instead of SQL. It reads
// two columns for a single pocket over twelve months, and there is no
// way to GROUP BY a *local* calendar month in this engine, so the
// window is bucketed after the fetch rather than in the query.
function queryMonthlySpending() {
    const window = monthlySpendingWindow();
    if (window === null || pocketState.pocket === null) return null;

    const totals = window.buckets.map(() => 0);
    const statement = db.prepare(
        `SELECT "Timestamp", "Amount" FROM "Transaction" ` +
            `WHERE "Pocket" = $pocket AND "Timestamp" IS NOT NULL ` +
            `AND "Timestamp" >= $start`,
        { $pocket: pocketState.pocket, $start: window.startMs }
    );
    try {
        while (statement.step()) {
            const row = statement.getAsObject();
            const amount = Number(row.Amount);
            if (Number.isNaN(amount) || amount >= 0) continue;

            const date = new Date(Number(row.Timestamp));
            if (Number.isNaN(date.getTime())) continue;

            const index = window.buckets.indexOf(
                date.getFullYear() * MONTHS_IN_WINDOW + date.getMonth()
            );
            // Anything older than the window (or past the anchor
            // month) is not charted.
            if (index === -1) continue;
            totals[index] -= amount;
        }
    } finally {
        statement.free();
    }

    return {
        labels: window.labels,
        totals,
        first: window.labels[0],
        last: window.labels[MONTHS_IN_WINDOW - 1],
    };
}

// Chart.js needs concrete colour strings, but the palette lives in
// Pico's CSS variables so the chart matches the active theme.
function chartColor(name, fallback) {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    return value === "" ? fallback : value;
}

// A Chart instance keeps the canvas (and its 2D context) alive, and
// new Chart() on a canvas that already has one throws "Canvas is
// already in use", so the instance is always torn down before the
// canvas is reused or hidden.
function destroyPocketChart() {
    if (pocketChart !== null) pocketChart.destroy();
    pocketChart = null;
}

// Statistics mirror the chart's visibility, and are emptied when
// hidden so no previous pocket's numbers are left sitting in the DOM.
function hidePocketStats() {
    pocketStats.hidden = true;
    pocketStatsList.replaceChildren();
}

function hidePocketSummary() {
    pocketChartFigure.hidden = true;
    hidePocketStats();
    destroyPocketChart();
    pocketSummaryKey = null;
}

function hasSpending(spending) {
    return spending.totals.some((total) => total > 0);
}

// Averages over the tail of the charted window: the last 3, 6 and 12
// months, each divided by its own period, so a month with no spending
// counts as a zero month rather than being skipped.
function renderPocketStats(spending) {
    pocketStatsList.replaceChildren();

    for (const months of SPENDING_PERIODS) {
        const recent = spending.totals.slice(-months);
        const average =
            recent.reduce((sum, total) => sum + total, 0) / months;

        const stat = document.createElement("div");
        stat.className = "stat";

        const label = document.createElement("dt");
        label.textContent = `Last ${months} months`;

        const value = document.createElement("dd");
        value.textContent = formatCurrency(average);

        stat.appendChild(label);
        stat.appendChild(value);
        pocketStatsList.appendChild(stat);
    }

    pocketStats.hidden = false;
}

// The chart and the statistics are two views of one query and share a
// lifecycle, so they are rendered together. Both are rebuilt only when
// the selected pocket changed: paging re-renders the list but never
// alters the monthly totals.
function renderPocketSummary() {
    if (pocketState.pocket === null) {
        hidePocketSummary();
        return;
    }

    const key = pocketState.pocket;
    if (key === pocketSummaryKey) return;

    const spending = queryMonthlySpending();
    if (spending === null) {
        // No dated transaction anywhere: there is no timeline to draw.
        hidePocketSummary();
        return;
    }

    const pocket = pocketState.pocket;

    // A bar chart of nothing says less than a sentence does, and an
    // average over zero months helps nobody. The list below can still
    // be showing this pocket's older transactions.
    if (!hasSpending(spending)) {
        destroyPocketChart();
        pocketChartWrap.hidden = true;
        pocketChartFigure.hidden = false;
        hidePocketStats();
        pocketChartCaption.textContent =
            `${pocket} — no spending recorded in the last ` +
            `${MONTHS_IN_WINDOW} months.`;
        pocketChartCanvas.setAttribute(
            "aria-label",
            pocketChartCaption.textContent
        );
        pocketSummaryKey = key;
        return;
    }

    drawPocketChart(spending, pocket);
    renderPocketStats(spending);
    pocketSummaryKey = key;
}

function drawPocketChart(spending, pocket) {
    // With Chart.js unavailable (a blocked CDN) there is nothing to
    // draw, but the statistics below stand on their own.
    if (!chartAvailable()) {
        pocketChartFigure.hidden = true;
        destroyPocketChart();
        return;
    }

    let peak = 0;
    for (let i = 1; i < spending.totals.length; i += 1) {
        if (spending.totals[i] > spending.totals[peak]) peak = i;
    }

    // Free the canvas before a new instance claims it.
    destroyPocketChart();

    pocketChartWrap.hidden = false;
    pocketChartFigure.hidden = false;
    pocketChartCaption.textContent =
        `Spending by month — ${pocket} · ${spending.first} – ${spending.last}`;
    // The canvas renders as an image, so it carries its own text
    // alternative describing the shape of the data.
    pocketChartCanvas.setAttribute(
        "aria-label",
        `Bar chart of total spending per month for ${pocket}, ` +
            `${spending.first} to ${spending.last}. ` +
            `Highest month: ${spending.labels[peak]} at ` +
            `${formatCurrency(spending.totals[peak])}.`
    );

    pocketChart = new Chart(pocketChartCanvas, {
        type: "bar",
        data: {
            labels: spending.labels,
            datasets: [
                {
                    label: "Spending",
                    data: spending.totals,
                    backgroundColor: chartColor("--pico-primary", "#0172ad"),
                    borderRadius: 4,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (context) => formatCurrency(context.parsed.y),
                    },
                },
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: chartColor(
                            "--pico-muted-border-color",
                            "#e0e0e0"
                        ),
                    },
                    ticks: { callback: (value) => formatCurrency(value) },
                },
                x: { grid: { display: false } },
            },
        },
    });
}

function showError(label, error) {
    console.error(`${label}:`, error);
    tableContainer.replaceChildren();
    statusEl.textContent = `${label}: ${error.message}`;
}

// Human-friendly field heading: AccountLastFour -> "Account Last
// Four". Timestamp is labelled "Date" to match the table header.
function columnLabel(name) {
    if (name === "Timestamp") return "Date";
    return name.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
}

// Opens the detail card for one transaction, listing every schema
// field that actually holds a value in a vertical label/value flow.
function openCard(row) {
    cardTitle.textContent = isBlank(row.Title) ? "Transaction" : row.Title;
    cardFields.replaceChildren();

    for (const { name } of COLUMNS) {
        const value = formatCell(name, row[name]);
        if (value === "") continue;

        const field = document.createElement("div");
        field.className = "field";

        const label = document.createElement("dt");
        label.textContent = columnLabel(name);

        const valueEl = document.createElement("dd");
        valueEl.textContent = value;

        field.appendChild(label);
        field.appendChild(valueEl);
        cardFields.appendChild(field);
    }

    // Pico's utility class stops the page scrolling behind the
    // modal; the close event below removes it for every close path.
    document.documentElement.classList.add("modal-is-open");
    cardDialog.showModal();
}

// Close paths: the × button and clicking off the content (clicks
// that land on the dialog itself, i.e. the backdrop). Escape closes
// natively; the "close" event fires for all of them.
cardClose.addEventListener("click", () => cardDialog.close());
cardDialog.addEventListener("click", (event) => {
    if (event.target === cardDialog) cardDialog.close();
});
cardDialog.addEventListener("close", () => {
    document.documentElement.classList.remove("modal-is-open");
});

fileInput.addEventListener("change", function (event) {
    const file = event.target.files[0];

    if (!file) return;

    // Pass the File object directly to Papa.parse
    Papa.parse(file, {
        header: true, // rows become objects keyed by the header row
        complete: async function (results) {
            const { rows: fileRows, unknown, collisions } = normalizeRows(
                Array.isArray(results.data) ? results.data : []
            );

            // Report columns present in the CSV that have no
            // schema counterpart, so nothing disappears quietly.
            // An empty file has no data rows to compare against, and
            // this describes the file, so it is read before the pocket
            // repair writes a Note value the file may not have had.
            const missingColumns =
                fileRows.length > 0
                    ? COLUMN_NAMES.filter((name) => !(name in fileRows[0]))
                    : [];

            const badTimestamps = fileRows.filter(
                (row) =>
                    !isBlank(row.Timestamp) &&
                    toEpochMs(row.Timestamp) === null
            ).length;

            // File mirrored Autopilot Reserve legs under the reserve
            // pocket first (pairing uses the pockets as filed in the
            // export), then repair whatever pocket labels remain,
            // before anything reads them: the table, the dropdown, the
            // chart and the card all render the stored value.
            const { rows: pairedRows, moved } =
                pairAutopilotReserveLegs(fileRows);
            const { rows, reassigned } = repairPocketLabels(pairedRows);

            // A new file's headers may not match the old sort.
            sortState = { column: null, direction: "asc" };
            currentPage = 1;

            try {
                // Wait for the WASM module before touching the
                // database, in case a file is chosen before it has
                // finished loading.
                await dbReady;
                loadRows(rows);

                // A new file replaces every row, so the pocket list
                // and any selection from the previous import go too.
                resetPocketView();

                // Transactions is the default view after an upload,
                // even if the Pockets tab was open beforehand.
                selectTab("transactions");
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
                    if (reassigned > 0) {
                        notes.push(
                            `${reassigned} transaction(s) moved to ` +
                                REVIEW_POCKET
                        );
                    }
                    if (moved > 0) {
                        notes.push(
                            `${moved} transaction(s) moved to ` +
                                AUTOPILOT_RESERVE_TITLE
                        );
                    }
                    statusEl.textContent =
                        `Stored ${rows.length} rows in the database.` +
                        (notes.length > 0
                            ? ` (${notes.join(", ")})`
                            : "");
                }
            } catch (error) {
                showError("Import error", error);
            }
        },
        error: function (error) {
            showError("Parse error", error);
        },
    });
});
