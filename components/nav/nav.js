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
const navLinks = document.querySelectorAll('.navigation a:not(.nav-cta)');
if (navLinks.length > 0) {
  const currentPath = window.location.pathname.replace('.html', '').replace(/\/$/, '');
  navLinks.forEach(link => {
    link.style.color = ''; // reset
    const linkPath = new URL(link.href).pathname.replace('.html', '').replace(/\/$/, '');
    if (linkPath === currentPath) {
      link.style.color = 'var(--purple)';
    } else if (currentPath === '/' && linkPath.endsWith('/index')) {
      link.style.color = 'var(--purple)';
    }
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
