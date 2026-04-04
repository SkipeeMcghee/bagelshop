(() => {

const BACKEND_BASE = "http://127.0.0.1:5000";
const API_BASE = `${BACKEND_BASE}/api`;

const contactForm = document.getElementById("contact-form");
const contactFormMessage = document.getElementById("contact-form-message");
const contactAccessNote = document.getElementById("contact-access-note");
const contactAuthActions = document.getElementById("contact-auth-actions");
const contactSignInLink = document.getElementById("contact-sign-in-link");
const contactSubmitButton = document.getElementById("contact-submit-button");

let currentContactUser = null;

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
        const error = new Error(data?.error || "Request failed");
        error.status = response.status;
        error.data = data;
        throw error;
    }
    return data;
}

function setContactFeedback(message, type = "success") {
    if (!contactFormMessage) {
        return;
    }
    contactFormMessage.textContent = message;
    contactFormMessage.classList.remove("success", "error");
    if (message) {
        contactFormMessage.classList.add(type);
    }
}

function canUseContactForm(user) {
    return Boolean(user && (user.is_google_account || user.email_verified));
}

function setFormDisabled(disabled) {
    if (!contactForm) {
        return;
    }
    for (const element of Array.from(contactForm.elements)) {
        element.disabled = disabled;
    }
    if (contactSubmitButton) {
        contactSubmitButton.disabled = disabled;
    }
}

function updateContactAccessUi() {
    const authenticated = Boolean(currentContactUser);
    const allowed = canUseContactForm(currentContactUser);

    if (contactAuthActions) {
        contactAuthActions.hidden = authenticated;
        contactAuthActions.style.display = authenticated ? "none" : "flex";
    }
    if (contactSignInLink) {
        contactSignInLink.hidden = authenticated;
        contactSignInLink.style.display = authenticated ? "none" : "inline-flex";
    }

    if (!contactForm) {
        return;
    }

    if (!authenticated) {
        setFormDisabled(true);
        if (contactAccessNote) {
            contactAccessNote.textContent = "Sign in with Google or create a verified account to use the contact form.";
        }
        return;
    }

    if (!allowed) {
        setFormDisabled(true);
        if (contactAccessNote) {
            contactAccessNote.textContent = "Verify your email to unlock the contact form, or sign in with Google instead.";
        }
        return;
    }

    setFormDisabled(false);
    if (contactAccessNote) {
        contactAccessNote.textContent = currentContactUser?.is_google_account
            ? "Signed in with Google. You can send a message below."
            : "Verified account confirmed. You can send a message below.";
    }
}

async function loadContactAccess() {
    try {
        const data = await apiRequest("/me", { method: "GET" });
        currentContactUser = data?.authenticated ? data.user || null : null;
    } catch (error) {
        currentContactUser = null;
    }

    if (contactForm && currentContactUser) {
        if (contactForm.elements.name) {
            contactForm.elements.name.value = currentContactUser.name || "";
            contactForm.elements.name.readOnly = true;
        }
        if (contactForm.elements.email) {
            contactForm.elements.email.value = currentContactUser.email || "";
            contactForm.elements.email.readOnly = true;
        }
    }

    updateContactAccessUi();
}

if (contactForm) {
    contactForm.addEventListener("submit", async (event) => {
        event.preventDefault();
        setContactFeedback("");

        if (!canUseContactForm(currentContactUser)) {
            setContactFeedback("Sign in with Google or verify your email before sending a message.", "error");
            updateContactAccessUi();
            return;
        }

        const payload = {
            name: String(contactForm.elements.name?.value || "").trim(),
            email: String(contactForm.elements.email?.value || "").trim(),
            subject: String(contactForm.elements.subject?.value || "").trim(),
            message: String(contactForm.elements.message?.value || "").trim(),
        };

        try {
            const data = await apiRequest("/contact", {
                method: "POST",
                body: JSON.stringify(payload),
            });
            if (contactForm.elements.subject) {
                contactForm.elements.subject.value = "";
            }
            if (contactForm.elements.message) {
                contactForm.elements.message.value = "";
            }
            setContactFeedback(data?.message || "Your message was accepted.", "success");
        } catch (error) {
            if (error?.status === 401 || error?.status === 403) {
                await loadContactAccess();
            }
            setContactFeedback(String(error.message || error), "error");
        }
    });
}

loadContactAccess();

})();
