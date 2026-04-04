const EVENTS_API_ROOT = "http://127.0.0.1:5000/api";
const calendarGrid = document.getElementById("calendar-grid");
const calendarMonthLabel = document.getElementById("calendar-month-label");
const calendarStatus = document.getElementById("calendar-status");
const previousMonthButton = document.getElementById("calendar-prev-month");
const nextMonthButton = document.getElementById("calendar-next-month");

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

function formatEventTimeRange(event) {
    const start = String(event.start_time || "").trim();
    const end = String(event.end_time || "").trim();
    if (!start && !end) {
        return "Time TBD";
    }
    if (start && end) {
        return `${start}–${end}`;
    }
    return start || end;
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
        title.textContent = event.location || "Event";

        const meta = document.createElement("span");
        meta.textContent = formatEventTimeRange(event);

        chip.append(title, meta);
        eventList.appendChild(chip);
    }

    if (events.length === 0 && isCurrentMonth) {
        const empty = document.createElement("span");
        empty.className = "calendar-empty-note";
        empty.textContent = "No events";
        eventList.appendChild(empty);
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
    try {
        const response = await fetch(`${EVENTS_API_ROOT}/events?month=${getMonthKey(visibleMonth)}`, {
            credentials: "include",
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
        calendarStatus.textContent = String(error.message || error);
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

loadMonth();
