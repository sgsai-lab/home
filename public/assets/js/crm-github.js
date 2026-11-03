import { api, describeError, h, showStatus } from '/assets/js/auth.js?v=__ASSET_VERSION__';

const requestBase = (projectId) => `/projects/${encodeURIComponent(projectId)}/github-crm`;

function label(text, control) {
  return h('label', {}, h('span', { text }), control);
}

function input(name, title, { type = 'text', required = false, maxLength } = {}) {
  return label(title, h('input', {
    name,
    type,
    required,
    ...(maxLength ? { maxlength: maxLength } : {})
  }));
}

function newCommandKey() {
  return crypto.randomUUID();
}

export function mountGithub(container, { projectId, clientId, capabilities = {} }) {
  if (!(container instanceof Element) || !projectId) throw new TypeError('A container and projectId are required.');
  if (clientId !== undefined && typeof clientId !== 'string') throw new TypeError('clientId must be a string when provided.');

  const lifecycle = new AbortController();
  let mounted = true;
  const canManage = capabilities.can_manage === true || capabilities.can_prepare === true;
  const status = h('p', { role: 'status', 'aria-live': 'polite', hidden: true });
  const commandActivity = h('div', { 'aria-live': 'polite' });
  const content = h('div', {});
  const section = h('section', { className: 'crm-github' },
    h('h2', { text: 'GitHub project' }),
    h('p', { text: 'Issues, pull requests, project status, and sprint iterations for this project.' }),
    status,
    commandActivity,
    content);
  container.replaceChildren(section);

  function cleanup() {
    if (!mounted) return;
    mounted = false;
    lifecycle.abort();
    window.removeEventListener('pagehide', cleanup);
    container.replaceChildren();
  }

  window.addEventListener('pagehide', cleanup, { once: true });

  function report(error) {
    if (mounted) showStatus(status, describeError(error));
  }

  async function submit(form, handler) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      showStatus(status, '');
      const controls = [...form.querySelectorAll('button, input, select, textarea')];
      controls.forEach((control) => { control.disabled = true; });
      try {
        await handler(Object.fromEntries(new FormData(form)));
      } catch (error) {
        report(error);
      } finally {
        controls.forEach((control) => { control.disabled = false; });
      }
    }, { signal: lifecycle.signal });
  }

  async function action(button, handler) {
    button.addEventListener('click', async () => {
      showStatus(status, '');
      button.disabled = true;
      try {
        await handler();
      } catch (error) {
        report(error);
      } finally {
        button.disabled = false;
      }
    }, { signal: lifecycle.signal });
  }

  async function sendCommand(form, data) {
    const key = form.dataset.idempotencyKey ?? newCommandKey();
    form.dataset.idempotencyKey = key;
    try {
      const result = await api(`${requestBase(projectId)}/commands`, {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: data
      });
      delete form.dataset.idempotencyKey;
      return result;
    } catch (error) {
      if (error.status > 0 && error.status < 500) delete form.dataset.idempotencyKey;
      throw error;
    }
  }

  function showCommandResult(command) {
    const message = command.status === 'completed'
      ? `GitHub command completed${command.external_url ? `: ${command.external_url}` : '.'}`
      : `GitHub command status: ${command.status}. ${command.error_message ?? ''}`.trim();
    const children = [h('p', { text: message })];
    if (['failed', 'reconciliation_required'].includes(command.status)) {
      const retry = h('button', { type: 'button', className: 'button button-secondary', text: 'Explicitly retry command' });
      action(retry, async () => {
        const result = await api(`${requestBase(projectId)}/commands/${encodeURIComponent(command.id)}/retry`, {
          method: 'POST',
          body: {}
        });
        showCommandResult(result);
        if (mounted) await load();
      });
      children.push(retry);
    }
    commandActivity.replaceChildren(...children);
  }

  function createIssueForm() {
    const form = h('form', { className: 'crm-github-form' },
      h('h3', { text: 'Create issue' }),
      input('title', 'Title', { required: true, maxLength: 256 }),
      label('Description', h('textarea', { name: 'body', maxlength: 6000, rows: 4 })),
      h('button', { type: 'submit', className: 'button button-primary', text: 'Create issue' }));
    submit(form, async (values) => {
      const result = await sendCommand(form, { type: 'issue.create', title: values.title, body: values.body });
      showCommandResult(result);
      if (mounted) await load();
    });
    return form;
  }

  function renderItems(data) {
    const items = data.items ?? [];
    const rows = items.map((item) => {
      const heading = h('h4', { text: `#${item.number} ${item.title}` });
      const link = h('a', {
        href: item.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        text: item.type === 'pull_request' ? 'Pull request' : 'Issue'
      });
      const fields = h('p', { text: `State: ${item.state}; status: ${item.status ?? 'Not set'}; iteration: ${item.iteration ?? 'Not set'}` });
      const card = h('article', { className: 'crm-github-item' }, heading, link, fields);

      if (canManage && data.status_options?.length) {
        for (const field of data.status_options) {
          if (!field.options?.length) continue;
          const form = h('form', { className: 'crm-github-form' },
            h('input', { type: 'hidden', name: 'item_id', value: item.id }),
            h('input', { type: 'hidden', name: 'field_id', value: field.field_id }),
            label('Status', h('select', { name: 'option_id', required: true },
              ...field.options.map((option) => h('option', { value: option.id, text: option.name })))),
            h('button', { type: 'submit', className: 'button button-secondary button-small', text: 'Update status' }));
          submit(form, async (values) => {
            const result = await sendCommand(form, {
              type: 'issue.status', item_id: values.item_id, field_id: values.field_id, option_id: values.option_id
            });
            showCommandResult(result);
            if (mounted) await load();
          });
          card.append(form);
        }
      }

      const iterationFields = [...new Map((data.iterations ?? []).filter((iteration) => iteration.field_id)
        .map((iteration) => [iteration.field_id, iteration])).values()];
      if (canManage && iterationFields.length && (data.iterations ?? []).length) {
        for (const field of iterationFields) {
          const options = data.iterations.filter((iteration) => iteration.field_id === field.field_id);
          const form = h('form', { className: 'crm-github-form' },
            h('input', { type: 'hidden', name: 'item_id', value: item.id }),
            h('input', { type: 'hidden', name: 'field_id', value: field.field_id }),
            label('Iteration', h('select', { name: 'iteration_id', required: true },
              ...options.map((iteration) => h('option', { value: iteration.id, text: iteration.title })))),
            h('button', { type: 'submit', className: 'button button-secondary button-small', text: 'Update iteration' }));
          submit(form, async (values) => {
            const result = await sendCommand(form, {
              type: 'issue.iteration', item_id: values.item_id, field_id: values.field_id, iteration_id: values.iteration_id
            });
            showCommandResult(result);
            if (mounted) await load();
          });
          card.append(form);
        }
      }
      return card;
    });
    const list = h('div', { className: 'crm-github-items' },
      ...(rows.length ? rows : [h('p', { text: 'No GitHub issues or pull requests are in this Project v2 board yet.' })]));
    return list;
  }

  async function load() {
    try {
      const data = await api(requestBase(projectId));
      if (!mounted) return;
      const children = [
        h('h3', { text: data.binding ? 'Connected repository and board' : 'Not connected' })
      ];
      if (data.binding) {
        children.push(h('p', { text: `Repository: ${data.binding.repository}; organization Project v2 #${data.binding.project_v2_number}${data.synced_at ? `; synced ${new Date(data.synced_at).toLocaleString()}` : '; not synced yet'}.` }));
        children.push(h('p', {},
          h('a', { href: data.binding.repository_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open repository' }),
          ' | ',
          h('a', { href: data.binding.project_url, target: '_blank', rel: 'noopener noreferrer', text: 'Open Project v2 board' })));
      } else {
        children.push(h('p', { text: 'An SGS issuer can bind this project to its organization repository and Project v2 board.' }));
      }
      if (canManage) {
        const sync = h('button', { type: 'button', className: 'button button-secondary', text: 'Sync now' });
        action(sync, async () => {
          await api(`${requestBase(projectId)}/sync`, { method: 'POST', body: {} });
          await load();
          showStatus(status, 'GitHub project synchronized.', 'success');
        });
        children.push(sync);
        const form = h('form', { className: 'crm-github-form' },
          h('h3', { text: 'Connect GitHub' }),
          input('repository_url', 'Repository URL', { required: true, maxLength: 500 }),
          input('project_url', 'Organization Project v2 URL', { required: true, maxLength: 500 }),
          h('button', { type: 'submit', className: 'button button-secondary', text: 'Save connection' }));
        submit(form, async (values) => {
          await api(`${requestBase(projectId)}/binding`, { method: 'PUT', body: values });
          await load();
          showStatus(status, 'GitHub connection saved.', 'success');
        });
        children.push(form);
        if (data.binding) children.push(createIssueForm());
      }
      if (data.binding) children.push(h('h3', { text: 'Issues and pull requests' }), renderItems(data));
      content.replaceChildren(...children);
    } catch (error) {
      if (!mounted) return;
      if ([401, 403, 404].includes(error.status)) {
        commandActivity.replaceChildren();
        content.replaceChildren(h('p', { text: 'GitHub project details are unavailable for this account.' }));
      } else {
        report(error);
      }
    }
  }

  void load();
  return cleanup;
}
