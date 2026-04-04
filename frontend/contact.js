const contactForm = document.getElementById("contact-form");
const contactFormMessage = document.getElementById("contact-form-message");

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

if (contactForm) {
    contactForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const name = String(contactForm.elements.name?.value || "").trim();
        const email = String(contactForm.elements.email?.value || "").trim();

        setContactFeedback(
            `Thanks${name ? `, ${name}` : ""}. This placeholder form is ready, but email sending is not connected yet. For now, no message was sent from ${email || "the form"}.`,
            "success"
        );
    });
}
