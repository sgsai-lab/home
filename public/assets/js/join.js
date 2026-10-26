import { api, ApiError, describeError, getCurrentUser, hasSessionHint, showStatus, signOut } from '/assets/js/auth.js';
import { ROLE } from '/assets/js/hub.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('token');
const here = `/workspace/join/?token=${encodeURIComponent(token ?? '')}`;

async function main() {
  if (!token) throw new ApiError(400, 'INVITE_INVALID', 'This invitation link is incomplete. Open it again from your email.');
  const invite = await api(`/invites/preview?token=${encodeURIComponent(token)}`, { auth: false });
  $('invite-summary').textContent = `You have been invited to join ${invite.client_name} as ${ROLE[invite.role].toLowerCase()} (${invite.email}).`;

  let user = null;
  if (hasSessionHint()) user = await getCurrentUser().catch(() => null);
  if (!user) {
    $('join-signup').href = `/signup/?invite=${encodeURIComponent(token)}`;
    $('join-login').href = `/login/?next=${encodeURIComponent(here)}`;
    $('join-signed-out').hidden = false;
    return;
  }
  $('join-email').textContent = user.email;
  $('join-signed-in').hidden = false;
  if (user.email !== invite.email) {
    showStatus($('status'), `This invitation is for ${invite.email}. Sign in with that address to accept it.`, 'info');
    $('accept-invite').disabled = true;
  }
  $('accept-invite').addEventListener('click', async () => {
    $('accept-invite').disabled = true;
    try {
      const { client } = await api('/invites/accept', { method: 'POST', body: { token } });
      location.replace(`/workspace/?client=${encodeURIComponent(client.id)}`);
    } catch (error) {
      showStatus($('status'), describeError(error));
      $('accept-invite').disabled = false;
    }
  });
  $('switch-account').addEventListener('click', async () => {
    await signOut();
    location.assign(`/login/?next=${encodeURIComponent(here)}`);
  });
}

main().catch((error) => {
  $('invite-summary').textContent = '';
  showStatus($('status'), describeError(error));
});
