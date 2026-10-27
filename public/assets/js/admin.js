// Admin console entry: side navigation, sheet dialogs, then the workspace and user modules.
import { setupDialogs } from '/assets/js/dialog.js';
import { setupTabs } from '/assets/js/hub.js';
import '/assets/js/admin-clients.js';
import '/assets/js/admin-users.js';

setupDialogs();
setupTabs(document.querySelector('.hub-sidenav'));
