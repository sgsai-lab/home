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

    const validatePhone = (phone) => {
      const re = /^[\+]?[(]?[0-9]{3}[)]?[-\s\.]?[0-9]{3}[-\s\.]?[0-9]{4,6}$/im;
      return re.test(String(phone));
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
              phone: phoneInput.value.trim(),
              subject: subjectInput.value.trim(),
              message: msgInput.value.trim()
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
      input.addEventListener('input', () => clearError(input));
    });
  });
})();
