// Template: insert inside createRequestHandler() in src/server/server.mjs, before the final 404.
// Replace widgets/Widget names; add listWidgets/createWidget to src/server/db.mjs and import them.

    if (pathname === '/api/v1/widgets') {
      const session = await getSession(getBearerToken(request));
      if (!session) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } });
      }
      const user = await getUserById(session.user_id);
      if (!user) {
        return respond(response, 401, { error: { code: 'UNAUTHORIZED', message: 'User not found.' } });
      }

      if (request.method === 'GET') {
        const items = await listWidgets(user.id);
        return respond(response, 200, { items, total: items.length });
      }

      if (request.method === 'POST') {
        let input;
        try {
          input = await readJson(request);
        } catch (err) {
          return respond(response, err.statusCode ?? 400, { error: { code: 'BAD_REQUEST', message: err.message } });
        }
        const name = sanitizeText(input?.name, 120);
        if (!name) {
          return respond(response, 400, { error: { code: 'VALIDATION_ERROR', message: 'Enter a name.' } });
        }
        const widget = await createWidget({ userId: user.id, name });
        return respond(response, 201, widget);
      }

      response.setHeader('Allow', 'GET, POST');
      return respond(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    }
