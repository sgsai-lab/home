const yearEl = document.querySelector('#year');
if (yearEl) {
    yearEl.textContent = String(new Date().getFullYear());
}
