const LOCAL_BACKEND_BASE = "http://127.0.0.1:5000";
const EVENTS_BACKEND_BASE =
    window.location.protocol === "file:" || ["127.0.0.1:5501", "localhost:5501"].includes(window.location.host)
        ? LOCAL_BACKEND_BASE
        : window.location.origin;
const EVENTS_API_ROOT = `${EVENTS_BACKEND_BASE}/api`;
const calendarGrid = document.getElementById("calendar-grid");
const calendarMonthLabel = document.getElementById("calendar-month-label");
const calendarStatus = document.getElementById("calendar-status");
const previousMonthButton = document.getElementById("calendar-prev-month");
const nextMonthButton = document.getElementById("calendar-next-month");
const calendarDetailOverlay = document.getElementById("calendar-detail-overlay");
const calendarDetailBackdrop = document.getElementById("calendar-detail-backdrop");
const calendarDetailClose = document.getElementById("calendar-detail-close");
const calendarDetailTitle = document.getElementById("calendar-detail-title");
const calendarDetailSubtitle = document.getElementById("calendar-detail-subtitle");
const calendarDetailList = document.getElementById("calendar-detail-list");

let visibleMonth = new Date();
visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth(), 1);
let monthEvents = [];

function getMonthKey(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatMonthLabel(date) {
    return new Intl.DateTimeFormat("en-US", {
        month: "long",
        year: "numeric",
    }).format(date);
}

function formatFullDate(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }
    const date = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(date.getTime())) {
        return raw;
    }
    return new Intl.DateTimeFormat("en-US", {
        weekday: "long",
        month: "long",
        day: "numeric",
        year: "numeric",
    }).format(date);
}

function formatClockTime(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    const match = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (!match) {
        return raw;
    }

    let hours = Number(match[1]);
    const minutes = match[2];
    const suffix = hours >= 12 ? "PM" : "AM";
    hours %= 12;
    if (hours === 0) {
        hours = 12;
    }
    return `${hours}:${minutes} ${suffix}`;
}

function summarizeLocation(value) {
    const raw = String(value || "").trim();
    if (!raw) {
        return "";
    }

    const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 3) {
        const city = parts[parts.length - 2] || "";
        const statePostal = parts[parts.length - 1] || "";
        const state = statePostal.split(/\s+/)[0] || statePostal;
        return [city, state].filter(Boolean).join(", ");
    }
    if (parts.length === 2) {
        return parts.join(", ");
    }
    return raw;
}

function formatEventTimeRange(event) {
    const start = formatClockTime(event.start_time);
    const end = formatClockTime(event.end_time);
    if (!start && !end) {
        return "Time TBD";
    }
    if (start && end) {
        return `${start}–${end}`;
    }
    return start || end;
}

function formatEventMeta(event) {
    const location = summarizeLocation(event.location);
    const timeRange = formatEventTimeRange(event);
    if (location && timeRange && timeRange !== "Time TBD") {
        return `${location} · ${timeRange}`;
    }
    if (location) {
        return location;
    }
    return timeRange;
}

function openDayDetails(isoDate, events) {
    if (!calendarDetailOverlay || !calendarDetailTitle || !calendarDetailSubtitle || !calendarDetailList) {
        return;
    }
    if (!Array.isArray(events) || events.length === 0) {
        return;
    }

    calendarDetailTitle.textContent = formatFullDate(isoDate) || "Event details";
    calendarDetailSubtitle.textContent = `${events.length} event${events.length === 1 ? "" : "s"} scheduled`;
    calendarDetailList.innerHTML = "";

    for (const event of events) {
        const article = document.createElement("article");
        article.className = "calendar-detail-item";

        const title = document.createElement("h4");
        title.textContent = String(event.name || "").trim() || "Untitled event";

        const meta = document.createElement("p");
        meta.className = "calendar-detail-item-meta";
        meta.textContent = formatEventMeta(event) || "Details coming soon";

        const address = String(event.location || "").trim();
        if (address) {
            const addressLine = document.createElement("p");
            addressLine.className = "calendar-detail-item-address";
            addressLine.textContent = address;
            article.append(title, meta, addressLine);
        } else {
            article.append(title, meta);
        }

        calendarDetailList.appendChild(article);
    }

    calendarDetailOverlay.hidden = false;
    document.body.classList.add("modal-open");
}

function closeDayDetails() {
    if (!calendarDetailOverlay) {
        return;
    }
    calendarDetailOverlay.hidden = true;
    document.body.classList.remove("modal-open");
}

function groupEventsByDate(events) {
    const grouped = new Map();
    for (const event of events) {
        const key = String(event.event_date || "").trim();
        if (!grouped.has(key)) {
            grouped.set(key, []);
        }
        grouped.get(key).push(event);
    }
    return grouped;
}

function createDayCell(date, isCurrentMonth, eventsByDate) {
    const isoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const card = document.createElement("article");
    card.className = `calendar-day${isCurrentMonth ? "" : " is-outside-month"}`;

    const dayHeader = document.createElement("div");
    dayHeader.className = "calendar-day-header";

    const dayNumber = document.createElement("span");
    dayNumber.className = "calendar-day-number";
    dayNumber.textContent = String(date.getDate());
    dayHeader.appendChild(dayNumber);

    const events = eventsByDate.get(isoDate) || [];
    if (events.length > 0 && isCurrentMonth) {
        card.classList.add("has-events");
        card.tabIndex = 0;
        card.setAttribute("role", "button");
        card.setAttribute("aria-label", `View ${events.length} event${events.length === 1 ? "" : "s"} for ${formatFullDate(isoDate)}`);
        card.addEventListener("click", () => openDayDetails(isoDate, events));
        card.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openDayDetails(isoDate, events);
            }
        });
    }

    if (events.length > 0) {
        const count = document.createElement("span");
        count.className = "calendar-event-count";
        count.textContent = `${events.length} event${events.length === 1 ? "" : "s"}`;
        dayHeader.appendChild(count);
    }

    const eventList = document.createElement("div");
    eventList.className = "calendar-day-events";

    for (const event of events) {
        const chip = document.createElement("div");
        chip.className = "calendar-event-chip";

        const title = document.createElement("strong");
        title.textContent = String(event.name || "").trim() || "Untitled event";

        const meta = document.createElement("span");
        meta.className = "calendar-event-chip-meta";
        meta.textContent = formatEventMeta(event) || "Details coming soon";

        chip.append(title, meta);
        eventList.appendChild(chip);
    }

    card.append(dayHeader, eventList);
    return card;
}

function renderCalendar() {
    if (!calendarGrid || !calendarMonthLabel || !calendarStatus) {
        return;
    }

    calendarMonthLabel.textContent = formatMonthLabel(visibleMonth);
    calendarGrid.innerHTML = "";

    const year = visibleMonth.getFullYear();
    const month = visibleMonth.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const startOffset = firstDay.getDay();
    const gridStart = new Date(year, month, 1 - startOffset);
    const eventsByDate = groupEventsByDate(monthEvents);

    for (let index = 0; index < 42; index += 1) {
        const currentDate = new Date(gridStart);
        currentDate.setDate(gridStart.getDate() + index);
        calendarGrid.appendChild(createDayCell(currentDate, currentDate.getMonth() === month, eventsByDate));
    }

    if (monthEvents.length === 0) {
        calendarStatus.textContent = "No events scheduled for this month yet.";
    } else {
        calendarStatus.textContent = `${monthEvents.length} event${monthEvents.length === 1 ? "" : "s"} scheduled this month.`;
    }
}

async function loadMonth() {
    if (!calendarStatus) {
        return;
    }

    calendarStatus.textContent = "Loading events...";
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 12000);
    try {
        const response = await fetch(`${EVENTS_API_ROOT}/events?month=${getMonthKey(visibleMonth)}`, {
            credentials: "include",
            signal: controller.signal,
        });
        const data = await response.json().catch(() => []);
        if (!response.ok) {
            throw new Error(data?.error || "Could not load events");
        }
        monthEvents = Array.isArray(data) ? data : [];
        renderCalendar();
    } catch (error) {
        monthEvents = [];
        renderCalendar();
        calendarStatus.textContent = error?.name === "AbortError"
            ? "Timed out loading events. Please refresh and try again."
            : String(error.message || error);
    } finally {
        window.clearTimeout(timeoutId);
    }
}

previousMonthButton?.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() - 1, 1);
    loadMonth();
});

nextMonthButton?.addEventListener("click", () => {
    visibleMonth = new Date(visibleMonth.getFullYear(), visibleMonth.getMonth() + 1, 1);
    loadMonth();
});

calendarDetailClose?.addEventListener("click", closeDayDetails);
calendarDetailBackdrop?.addEventListener("click", closeDayDetails);
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !calendarDetailOverlay?.hidden) {
        closeDayDetails();
    }
});

loadMonth();
