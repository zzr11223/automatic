/**
 * 账号密码读写（独立文件，不放在主配置里，便于单独排除/删除）
 */
const fs = require('fs');
const path = require('path');
const { resolvePath } = require('./util');

function credPath(cfg) {
  const f = (cfg.login && cfg.login.credentialsFile) || 'credentials.json';
  return resolvePath(f);
}

function loadCredentials(cfg) {
  const p = credPath(cfg);
  if (!fs.existsSync(p)) return null;
  let json;
  try {
    json = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`credentials.json 格式错误：${e.message}`);
  }
  const phone = String(json.phone || '').trim();
  const password = String(json.password || '').trim();
  if (!phone || !password) return null;
  return { phone, password };
}

function saveCredentials(cfg, phone, password) {
  const p = credPath(cfg);
  const payload = {
    _警告: '本文件包含账号和密码。请不要发给任何人、不要上传到网盘或代码仓库。',
    _说明: 'phone = 登录手机号；password = 登录密码。改完保存即可。',
    phone,
    password,
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2), 'utf8');
  return p;
}

/** 打码显示，避免日志里泄露完整密码 */
function maskPhone(phone) {
  const s = String(phone);
  return s.length >= 11 ? s.slice(0, 3) + '****' + s.slice(-4) : s;
}

module.exports = { loadCredentials, saveCredentials, credPath, maskPhone };
