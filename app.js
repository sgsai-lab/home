document.querySelectorAll('link[data-async-stylesheet]').forEach((preload) => {
  const activateStylesheet = () => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = preload.href;
    document.head.appendChild(stylesheet);
    preload.remove();
  };

  preload.addEventListener('load', activateStylesheet, { once: true });
  if (preload.sheet) activateStylesheet();
});

const components = [
  { id: 'header-mount', path: 'components/header/header', hasCss: true, hasJs: false },
  { id: 'nav-mount', path: 'components/nav/nav', hasCss: true, hasJs: true },
  { id: 'hero-mount', path: 'sections/hero/hero', hasCss: true, hasJs: false },
  { id: 'vision-mount', path: 'sections/vision/vision', hasCss: true, hasJs: false },
  { id: 'services-mount', path: 'sections/services/services', hasCss: true, hasJs: false },
  { id: 'roadmap-mount', path: 'sections/roadmap/roadmap', hasCss: true, hasJs: false },
  { id: 'about-mount', path: 'sections/about/about', hasCss: true, hasJs: false },
  { id: 'contact-mount', path: 'sections/contact/contact', hasCss: true, hasJs: true },
  { id: 'footer-mount', path: 'components/footer/footer', hasCss: true, hasJs: true }
];

async function loadComponent(comp) {
  const container = document.getElementById(comp.id);
  if (!container) return;

  try {
    const response = await fetch(`/${comp.path}.html?v=6`);
    if (!response.ok) return;

    container.innerHTML = await response.text();

    if (comp.hasCss) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/${comp.path}.css?v=6`;
      document.head.appendChild(link);
    }

    if (comp.hasJs) {
      const script = document.createElement('script');
      script.src = `/${comp.path}.js`;
      script.defer = true;
      document.body.appendChild(script);
    }
  } catch (error) {
    console.error(`Failed to load ${comp.path}`, error);
  }
}

async function loadComponents() {
  // The navigation mount is inside the header fragment; load it before the rest.
  await loadComponent(components[0]);
  await Promise.all(components.slice(1).map(loadComponent));
}

document.addEventListener('DOMContentLoaded', () => {
  const componentsLoaded = loadComponents();

  const hashMapping = {
    '#products': '/services',
    '#vision': '/vision',
    '#about': '/about',
    '#roadmap': '/roadmap',
    '#approach': '/vision/#approach'
  };

  const handleHash = async () => {
    const { hash } = window.location;
    if (hashMapping[hash]) {
      window.location.href = hashMapping[hash];
      return;
    }

    if (!hash) return;

    await componentsLoaded;
    document.querySelector(hash)?.scrollIntoView({ behavior: 'smooth' });
  };

  handleHash();
  window.addEventListener('hashchange', handleHash);
}, { once: true });
