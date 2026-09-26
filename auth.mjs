// auth.mjs — 多用户登录（零依赖）：用户存储 + 登录态令牌。
//
// 存储：
//   gallery/users.json         {v:1, users:[{id, username, salt, hash, role, createdAt, updatedAt}]}
//   gallery/auth-sessions.json {v:1, tokens:{<token>:{userId, createdAt, expiresAt}}}
//
// 设计：
// - 密码 scrypt(salt, password) 哈希（hex 存储，常量时间比较），绝不落明文；
// - **每用户自己的 GLM LLM API Key**（用户要求：创建账户时必须填写）：注册必填、
//   随后可在账户设置里更换；claude.mjs 发用户会话消息时用它（ANTHROPIC_AUTH_TOKEN），
//   **任何账户都不回退兜底**（用户明确要求）——未设置的账户发消息直接 403；流水线
//   会话统一用 admin 账户的 Key（adminApiKey）；agent-settings.json 里存量的全局 Key
//   启动时一次性迁给 admin 账户（adoptApiKeyForAdmin），之后全局 Key 概念不复存在；
// - 登录态 = HttpOnly Cookie（archify_auth）里的 256 位随机令牌，服务端可撤销：
//   退出吊销单个；改密码吊销该用户除当前外的全部令牌（其他设备强制下线）；
// - 令牌 30 天有效，剩余不足一半时顺带滑动续期（不逐请求写盘）；
// - admin 账户启动时种子（admin / adminadmin）——已存在则**不重置**（改过的密码保持）；
// - 用户名大小写不敏感唯一（登录也不分大小写），1-30 字符、不含空白与冒号；
// - 注册开放的「首次使用创建账户」语义：任何人都可建普通账户，role 恒为 user。
//
// 数据都在内存、同步读改写 + tmp/rename 原子落盘——单进程内无并发竞态。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TOKEN_TTL_MS = 30 * 24 * 3600_000;
const USERNAME_MAX = 30;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const APIKEY_MIN = 8; // GLM/智谱 Key 形如 xxxxxx.xxxxxx（≥30 字符），下限保守放低
const APIKEY_MAX = 200;
const ADMIN_SEED = { username: 'admin', password: 'adminadmin' };

function validApiKey(key) {
  return typeof key === 'string' && key.trim().length >= APIKEY_MIN && key.trim().length <= APIKEY_MAX;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function hexEqual(a, b) {
  const ba = Buffer.from(String(a || ''), 'hex');
  const bb = Buffer.from(String(b || ''), 'hex');
  return ba.length === bb.length && ba.length > 0 && crypto.timingSafeEqual(ba, bb);
}

function writeJsonAtomic(filePath, data) {
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, filePath);
}

export function createAuth({ galleryDir }) {
  const usersPath = path.join(galleryDir, 'users.json');
  const tokensPath = path.join(galleryDir, 'auth-sessions.json');

  const findByName = (name) => users.find(
    (u) => u.username.toLowerCase() === String(name || '').toLowerCase(),
  );

  // ---- 用户表 ----
  let users = [];
  try {
    const raw = JSON.parse(fs.readFileSync(usersPath, 'utf8'));
    if (Array.isArray(raw?.users)) users = raw.users.filter((u) => u && typeof u.username === 'string');
  } catch { /* 无文件 = 首次启动 */ }

  function persistUsers() {
    writeJsonAtomic(usersPath, { v: 1, users });
  }

  // 启动种子：admin 不存在才建（存在则不重置密码）
  if (!findByName(ADMIN_SEED.username)) {
    const salt = crypto.randomBytes(16).toString('hex');
    users.push({
      id: `u-${crypto.randomUUID().replaceAll('-', '')}`,
      username: ADMIN_SEED.username,
      salt,
      hash: hashPassword(ADMIN_SEED.password, salt),
      role: 'admin',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    persistUsers();
  }

  // ---- 登录令牌 ----
  /** @type {Map<string, {userId:string, createdAt:number, expiresAt:number}>} */
  let tokens = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf8'));
    if (raw?.tokens && typeof raw.tokens === 'object') {
      tokens = new Map(Object.entries(raw.tokens));
    }
  } catch { /* 无文件 = 全部重新登录 */ }

  function persistTokens() {
    writeJsonAtomic(tokensPath, { v: 1, tokens: Object.fromEntries(tokens) });
  }

  // 启动清一轮过期令牌
  {
    const now = Date.now();
    let dirty = false;
    for (const [t, info] of tokens) {
      if (!info || Number(info.expiresAt) <= now) { tokens.delete(t); dirty = true; }
    }
    if (dirty) persistTokens();
  }

  // 对外只暴露非敏感字段（username/role + 是否已配 Key），绝不带 hash/salt/apiKey 本体
  function publicUser(u) {
    return { username: u.username, role: u.role === 'admin' ? 'admin' : 'user', hasApiKey: Boolean(u.apiKey) };
  }

  function issueToken(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    tokens.set(token, { userId: user.id, createdAt: now, expiresAt: now + TOKEN_TTL_MS });
    persistTokens();
    return token;
  }

  // ---- 登录态解析（server.mjs 每个 /api 请求调一次，纯内存 + 惰性续期） ----
  function userForToken(token) {
    if (!token) return null;
    const info = tokens.get(token);
    if (!info) return null;
    const now = Date.now();
    if (Number(info.expiresAt) <= now) {
      tokens.delete(token);
      persistTokens();
      return null;
    }
    const user = users.find((u) => u.id === info.userId);
    if (!user) { // 用户被删（当前无删除入口，防御性处理）
      tokens.delete(token);
      persistTokens();
      return null;
    }
    if (info.expiresAt - now < TOKEN_TTL_MS / 2) {
      info.expiresAt = now + TOKEN_TTL_MS;
      persistTokens();
    }
    return user;
  }

  function verifyPassword(user, password) {
    return hexEqual(hashPassword(password, user.salt), user.hash);
  }

  // ---- 登录 / 注册 / 登出 / 改密 ----
  function login(username, password) {
    const user = findByName(username);
    if (!user || typeof password !== 'string' || !verifyPassword(user, password)) {
      return { status: 401, error: '用户名或密码不正确' };
    }
    return { user, token: issueToken(user) };
  }

  // 注册：用户名/密码规则见文件头；GLM API Key 必填（用户要求：创建账户时输入自己的
  // LLM Key——用户会话用自己的 Key 计费，与全局 Key 隔离）。
  function register(username, password, apiKey) {
    const name = String(username || '').trim();
    if (!name || name.length > USERNAME_MAX || /[\s:]/.test(name)) {
      return { status: 400, error: `用户名需为 1-${USERNAME_MAX} 个字符，不含空格与冒号` };
    }
    if (findByName(name)) return { status: 409, error: `用户名已存在：${name}` };
    if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
      return { status: 400, error: `密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符` };
    }
    if (!validApiKey(apiKey)) {
      return { status: 400, error: `请填写 GLM API Key（${APIKEY_MIN}-${APIKEY_MAX} 个字符，在 open.bigmodel.cn 获取）` };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: `u-${crypto.randomUUID().replaceAll('-', '')}`,
      username: name,
      salt,
      hash: hashPassword(password, salt),
      apiKey: apiKey.trim(),
      role: 'user',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    users.push(user);
    persistUsers();
    return { user, token: issueToken(user) };
  }

  // 换个人 Key（账户设置里「留空保持不变」的输入框）：验证后覆盖存储
  function updateUserApiKey(currentUser, apiKey) {
    const user = users.find((u) => u.id === currentUser.id);
    if (!user) return { status: 401, error: '登录态已失效，请重新登录' };
    if (!validApiKey(apiKey)) {
      return { status: 400, error: `API Key 需为 ${APIKEY_MIN}-${APIKEY_MAX} 个字符` };
    }
    user.apiKey = apiKey.trim();
    user.updatedAt = Date.now();
    persistUsers();
    return { ok: true };
  }

  // 供 claude.mjs 随用户会话下发（发送者自己的 Key，不回退）；无 Key 返回 ''
  function apiKeyFor(username) {
    if (!username) return '';
    return findByName(username)?.apiKey || '';
  }

  // 流水线会话统一用 admin 账户的个人 Key（用户要求；role=admin 优先，兜底用户名）
  const findAdmin = () => users.find((u) => u.role === 'admin') || findByName('admin');

  function adminApiKey() {
    return findAdmin()?.apiKey || '';
  }

  // 一次性迁移：agent-settings.json 存量的全局 Key 收编给 admin（admin 已有自己的
  // Key 时不覆盖），返回是否收编。全局 apiKey 字段由此废除。
  function adoptApiKeyForAdmin(key) {
    const admin = findAdmin();
    if (!admin || admin.apiKey || !validApiKey(key)) return false;
    admin.apiKey = key.trim();
    admin.updatedAt = Date.now();
    persistUsers();
    return true;
  }

  function revokeToken(token) {
    if (token && tokens.delete(token)) persistTokens();
  }

  // 改密码：必须核对原密码（「通过上次历史密码修改」）；成功后吊销该用户除当前
  // 令牌外的全部登录态（其他设备强制下线），当前会话保持登录。
  function changePassword(currentUser, oldPassword, newPassword, { keepToken = '' } = {}) {
    const user = users.find((u) => u.id === currentUser.id);
    if (!user) return { status: 401, error: '登录态已失效，请重新登录' };
    if (typeof oldPassword !== 'string' || !verifyPassword(user, oldPassword)) {
      return { status: 403, error: '原密码不正确' };
    }
    if (typeof newPassword !== 'string' || newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      return { status: 400, error: `新密码需为 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符` };
    }
    const salt = crypto.randomBytes(16).toString('hex');
    user.salt = salt;
    user.hash = hashPassword(newPassword, salt);
    user.updatedAt = Date.now();
    persistUsers();
    let revoked = 0;
    for (const [t, info] of tokens) {
      if (info.userId === user.id && t !== keepToken) { tokens.delete(t); revoked += 1; }
    }
    if (revoked) persistTokens();
    return { ok: true, revoked };
  }

  return { login, register, revokeToken, userForToken, changePassword, updateUserApiKey, apiKeyFor, adminApiKey, adoptApiKeyForAdmin, publicUser };
}
