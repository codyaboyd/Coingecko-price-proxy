(function () {
  const STORAGE_KEY = 'chrono-admin-nav-state';
  const MOBILE_QUERY = '(max-width: 991.98px)';

  function getStoredState() {
    try {
      return window.localStorage.getItem(STORAGE_KEY);
    } catch (error) {
      return null;
    }
  }

  function setStoredState(state) {
    try {
      window.localStorage.setItem(STORAGE_KEY, state);
    } catch (error) {
      // Navigation remains usable even when localStorage is unavailable.
    }
  }

  function setNavState(isExpanded, toggleButton) {
    document.body.classList.toggle('admin-nav-expanded', isExpanded);
    document.body.classList.toggle('admin-nav-collapsed', !isExpanded);

    if (toggleButton) {
      toggleButton.setAttribute('aria-expanded', String(isExpanded));
      toggleButton.setAttribute('aria-label', isExpanded ? 'Collapse admin navigation' : 'Expand admin navigation');
      toggleButton.title = isExpanded ? 'Collapse navigation' : 'Expand navigation';
    }
  }

  function createToggleButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'admin-nav-toggle';
    button.setAttribute('aria-controls', 'admin-side-navigation');
    button.innerHTML = '<span aria-hidden="true"></span><span aria-hidden="true"></span><span aria-hidden="true"></span>';
    return button;
  }

  function initializeAdminNavigation() {
    const nav = document.querySelector('.navbar');

    if (!nav) {
      return;
    }

    nav.id = nav.id || 'admin-side-navigation';

    const toggleButton = createToggleButton();
    document.body.prepend(toggleButton);

    const storedState = getStoredState();
    const isMobile = window.matchMedia(MOBILE_QUERY).matches;
    const startsExpanded = storedState === 'expanded' || (storedState !== 'collapsed' && !isMobile);

    document.body.classList.add('admin-nav-ready');
    setNavState(startsExpanded, toggleButton);

    toggleButton.addEventListener('click', () => {
      const nextExpanded = !document.body.classList.contains('admin-nav-expanded');
      setNavState(nextExpanded, toggleButton);
      setStoredState(nextExpanded ? 'expanded' : 'collapsed');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeAdminNavigation);
  } else {
    initializeAdminNavigation();
  }
}());
