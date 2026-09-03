import type { ServerResponse } from 'node:http';
import type { ApiRequest } from '../middleware.js';
import { HttpError, sendJson } from '../middleware.js';
import { login } from '@api/auth/index.js';

export const authHandlers = {
  async login(req: ApiRequest, res: ServerResponse): Promise<void> {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!username || !password) throw new HttpError(400, 'username and password required');
    const token = await login(username, password);
    if (!token) throw new HttpError(401, 'INVALID_CREDENTIALS');
    sendJson(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 28800 });
  },
};
