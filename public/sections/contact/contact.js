document.addEventListener('DOMContentLoaded', () => {
  // It might run before html is dynamically injected, so we should attach event listener 
  // when the script is loaded dynamically by app.js.
});

// Since app.js appends this script dynamically, this top-level code runs immediately after contact.html is loaded.
(function initContactForm() {
  const forms = document.querySelectorAll('.contact-form');
  
  forms.forEach(form => {
    const statusEl = form.querySelector('.form-status');
    const submitBtn = form.querySelector('.submit-btn');

    const showError = (input, message) => {
      const group = input.closest('.form-group');
      group.classList.add('has-error');
      const errorSpan = group.querySelector('.error-msg');
      if (errorSpan) errorSpan.textContent = message;
    };

    const clearError = (input) => {
      const group = input.closest('.form-group');
      group.classList.remove('has-error');
    };

    const validateEmail = (email) => {
      const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      return re.test(String(email).toLowerCase());
    };

    // International numbers (E.164 allows up to 15 digits), e.g. +91 81238 79595 or (555) 123-4567.
    const validatePhone = (phone) => {
      const value = String(phone).trim();
      const digits = value.replace(/\D/g, '');
      return /^\+?[\d\s().-]+$/.test(value) && digits.length >= 7 && digits.length <= 15;
    };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      let isValid = true;
      
      // Clear previous status
      statusEl.className = 'form-status';
      statusEl.textContent = '';

      // Inputs
      const nameInput = form.querySelector('input[name="name"]');
      const emailInput = form.querySelector('input[name="email"]');
      const phoneInput = form.querySelector('input[name="phone"]');
      const subjectInput = form.querySelector('input[name="subject"]');
      const msgInput = form.querySelector('textarea[name="message"]');
      const consentInput = form.querySelector('input[name="consent"]');
      const trapInput = form.querySelector('input[name="website"]');

      // Validate Name
      if (!nameInput.value.trim()) {
        showError(nameInput, 'Please enter your name.');
        isValid = false;
      } else {
        clearError(nameInput);
      }

      // Validate Email
      if (!emailInput.value.trim()) {
        showError(emailInput, 'Please enter your email address.');
        isValid = false;
      } else if (!validateEmail(emailInput.value)) {
        showError(emailInput, 'Please enter a valid email address.');
        isValid = false;
      } else {
        clearError(emailInput);
      }

      // Validate Phone
      if (phoneInput.value.trim() !== '') {
        if (!validatePhone(phoneInput.value)) {
          showError(phoneInput, 'Please enter a valid phone number.');
          isValid = false;
        } else {
          clearError(phoneInput);
        }
      } else {
        clearError(phoneInput);
      }

      // Validate Subject
      if (!subjectInput.value.trim()) {
        showError(subjectInput, 'Please enter a subject.');
        isValid = false;
      } else {
        clearError(subjectInput);
      }

      // Validate Message
      if (!msgInput.value.trim()) {
        showError(msgInput, 'Please enter a message.');
        isValid = false;
      } else {
        clearError(msgInput);
      }

      // The API requires explicit consent before it emails the enquiry.
      if (!consentInput.checked) {
        showError(consentInput, 'Please confirm so we can reply.');
        isValid = false;
      } else {
        clearError(consentInput);
      }

      if (isValid) {
        submitBtn.disabled = true;
        submitBtn.classList.add('is-loading');

        try {
          const response = await fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              name: nameInput.value.trim(),
              email: emailInput.value.trim(),
              // The API stores one message field, so subject and phone travel inside it.
              message: [
                `Subject: ${subjectInput.value.trim()}`,
                phoneInput.value.trim() ? `Phone: ${phoneInput.value.trim()}` : '',
                '',
                msgInput.value.trim()
              ].filter((line, index) => line || index === 2).join('\n'),
              consent: true,
              website: trapInput ? trapInput.value : '',
              source: 'contact'
            })
          });

          if (!response.ok) {
            const data = await response.json();
            throw new Error(data.error || 'Failed to send message.');
          }

          submitBtn.disabled = false;
          submitBtn.classList.remove('is-loading');
          
          // Success state
          statusEl.textContent = 'Thank you! Your message has been sent successfully.';
          statusEl.className = 'form-status success';
          
          form.reset();
        } catch (error) {
          submitBtn.disabled = false;
          submitBtn.classList.remove('is-loading');
          
          statusEl.textContent = error.message || 'An error occurred. Please try again.';
          statusEl.className = 'form-status error';
        }
      }
    });

    // Clear error on input
    form.querySelectorAll('input, textarea').forEach(input => {
      input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => clearError(input));
    });
  });
})();
