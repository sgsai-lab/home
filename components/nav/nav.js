const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#primary-navigation');

if (menuToggle && navigation) {
  const closeMenu = () => {
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Open navigation');
    navigation.classList.remove('is-open');
  };

  menuToggle.addEventListener('click', () => {
    const isOpen = menuToggle.getAttribute('aria-expanded') === 'true';
    menuToggle.setAttribute('aria-expanded', String(!isOpen));
    menuToggle.setAttribute('aria-label', isOpen ? 'Open navigation' : 'Close navigation');
    navigation.classList.toggle('is-open', !isOpen);
  });

  navigation.addEventListener('click', (event) => {
    if (event.target instanceof HTMLAnchorElement) closeMenu();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });
}

// Active navigation highlight based on URL
const navLinks = document.querySelectorAll('.navigation > a');
if (navLinks.length > 0) {
  const currentPath = window.location.pathname.replace('.html', '').replace(/\/$/, '');
  navLinks.forEach(link => {
    const linkPath = new URL(link.href).pathname.replace('.html', '').replace(/\/$/, '');
    if (linkPath === currentPath) link.setAttribute('aria-current', 'page');
  });
}

// Header scroll state
const header = document.querySelector('.site-header');
if (header) {
  window.addEventListener('scroll', () => {
    if (window.scrollY > 50) {
      header.classList.add('scrolled');
    } else {
      header.classList.remove('scrolled');
    }
  });
  // Trigger once on load
  if (window.scrollY > 50) header.classList.add('scrolled');
}

// Account dropdown
const accountMenu = document.querySelector('.account-menu');
if (accountMenu) {
  const toggle = accountMenu.querySelector('.account-toggle');
  const dropdown = accountMenu.querySelector('.account-dropdown');
  const setOpen = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    dropdown.hidden = !open;
  };

  toggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setOpen(dropdown.hidden);
  });
  document.addEventListener('click', (event) => {
    if (!accountMenu.contains(event.target)) setOpen(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !dropdown.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  const authPages = ['/login/', '/signup/', '/forgot-password/', '/reset-password/', '/verify-email/'];
  const here = `${window.location.pathname}${window.location.search}`;
  if (!authPages.some((page) => window.location.pathname.startsWith(page.slice(0, -1)))) {
    accountMenu.querySelector('[data-login-link]').href = `/login/?next=${encodeURIComponent(here)}`;
  }

  import('/js/auth.js').then(async (auth) => {
    if (!auth.hasSessionHint()) return;
    const user = await auth.getCurrentUser();
    const firstName = user.full_name.split(/\s+/)[0];
    accountMenu.querySelector('.account-label').textContent = firstName;
    accountMenu.querySelector('.account-avatar').textContent = firstName.charAt(0).toUpperCase();
    accountMenu.querySelector('[data-user-name]').textContent = user.full_name;
    accountMenu.querySelector('[data-user-email]').textContent = user.email;
    accountMenu.querySelector('[data-admin-link]').hidden = user.role !== 'admin';
    accountMenu.querySelector('[data-auth="signed-out"]').hidden = true;
    accountMenu.querySelector('[data-auth="signed-in"]').hidden = false;
    accountMenu.classList.add('is-signed-in');
    accountMenu.querySelector('[data-sign-out]').addEventListener('click', () => auth.logout());
  }).catch(() => {
    // Signed-out state is already rendered.
  });
}
