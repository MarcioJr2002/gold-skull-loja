"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const QRCode = require("qrcode");

/* =========================================================================
   CONFIGURAÇÃO
   ========================================================================= */

const PROD = process.env.NODE_ENV === "production";
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const FORCE_HTTPS = /^(1|true|yes|on)$/i.test(process.env.FORCE_HTTPS || "");
const TRUST_PROXY = process.env.TRUST_PROXY || (PROD ? "1" : "loopback");
// 2FA is temporarily disabled while the admin flow is being tested.
// Set DISABLE_2FA=false to require it again.
const DISABLE_2FA = !/^(0|false|no|off)$/i.test(process.env.DISABLE_2FA || "true");

// IPs liberados para o painel (vazio = liberado para todos)
const ADMIN_ALLOW_IPS = String(process.env.ADMIN_ALLOW_IPS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MIN || 120) * 60 * 1000; // inatividade
const SESSION_MAX_MS = Number(process.env.SESSION_MAX_HOURS || 12) * 60 * 60 * 1000; // duração total
const MIN_PASSWORD = 8;
const LOGIN_MAX_FAILS = 8;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const AUDIT_MAX_BYTES = Number(process.env.AUDIT_MAX_MB || 8) * 1024 * 1024;
const LEDGER_MAX = 20000;
const COUPON_TYPES = ["percent", "free_shipping", "gift"];

const ROOT = __dirname;

function isRailwayHost() {
  return Boolean(
    process.env.RAILWAY_ENVIRONMENT ||
      process.env.RAILWAY_VOLUME_MOUNT_PATH ||
      process.env.RAILWAY_PROJECT_ID
  );
}

function copyDbIfMissing(fromDir, toDir) {
  if (!fromDir || !toDir) return false;
  if (path.resolve(fromDir) === path.resolve(toDir)) return false;
  const src = path.join(fromDir, "db.json");
  const dest = path.join(toDir, "db.json");
  try {
    if (!fs.existsSync(src) || fs.existsSync(dest)) return false;
    fs.mkdirSync(toDir, { recursive: true });
    fs.copyFileSync(src, dest);
    for (const extra of [".admin-ready", ".session-secret", "audit.jsonl"]) {
      const a = path.join(fromDir, extra);
      const b = path.join(toDir, extra);
      if (fs.existsSync(a) && !fs.existsSync(b)) fs.copyFileSync(a, b);
    }
    console.log(`[dados] copiado banco de ${fromDir} para o volume ${toDir}`);
    return true;
  } catch (err) {
    console.warn("[dados] não copiei o banco para o volume:", err && err.message ? err.message : err);
    return false;
  }
}

function inspectDbFile(dir) {
  const file = path.join(dir, "db.json");
  try {
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    const db = JSON.parse(fs.readFileSync(file, "utf8"));
    const users = Array.isArray(db.users) ? db.users : [];
    const products = Array.isArray(db.products) ? db.products : [];
    const established = users.filter((u) => u && u.mustChangePassword === false).length;
    let ready = false;
    try {
      ready = fs.existsSync(path.join(dir, ".admin-ready"));
    } catch {
      ready = false;
    }
    return { dir, users: users.length, products: products.length, established, ready, mtime: st.mtimeMs };
  } catch {
    return null;
  }
}

/** Pasta persistente: no Railway o volume ganha sempre de ./data (disco do container some no deploy). */
function resolveDataDir() {
  const local = path.join(ROOT, "data");
  const envDir = String(process.env.DATA_DIR || "").trim();
  const volume = String(process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
  const railwayData = "/data";
  let dir;
  let reason;
  if (volume) {
    dir = path.resolve(volume);
    reason = "RAILWAY_VOLUME_MOUNT_PATH";
    copyDbIfMissing(local, dir);
    if (envDir) copyDbIfMissing(path.resolve(envDir), dir);
  } else if (envDir) {
    dir = path.resolve(envDir);
    reason = "DATA_DIR";
  } else if (isRailwayHost() && fs.existsSync(railwayData)) {
    try {
      if (fs.statSync(railwayData).isDirectory()) {
        dir = path.resolve(railwayData);
        reason = "/data";
        copyDbIfMissing(local, dir);
      }
    } catch {
      /* segue */
    }
  }
  if (!dir) {
    dir = local;
    reason = "./data";
  }
  debugLogin("A", "server.js:resolveDataDir", "pasta de dados escolhida", {
    dir,
    reason,
    volumeSet: Boolean(volume),
    dataDirSet: Boolean(envDir),
    railway: isRailwayHost(),
    hasDb: fs.existsSync(path.join(dir, "db.json")),
  });
  return dir;
}

const DATA_DIR = resolveDataDir();
const DB_PATH = path.join(DATA_DIR, "db.json");
const ADMIN_READY_PATH = path.join(DATA_DIR, ".admin-ready");
const UPLOADS = path.join(DATA_DIR, "uploads");
const PUBLIC_UPLOADS = path.join(ROOT, "public", "uploads");
const BACKUPS = path.join(ROOT, "backups");
const AUDIT_PATH = path.join(DATA_DIR, "audit.jsonl");

function hasAdminReady() {
  try {
    return fs.existsSync(ADMIN_READY_PATH);
  } catch {
    return false;
  }
}

function markAdminReady() {
  try {
    fs.writeFileSync(ADMIN_READY_PATH, `${new Date().toISOString()}\n`);
  } catch (err) {
    console.warn("[admin] não foi possível gravar .admin-ready:", err && err.message ? err.message : err);
  }
}

function clearAdminReady() {
  try {
    fs.unlinkSync(ADMIN_READY_PATH);
  } catch {
    /* já não existe */
  }
}

function dbHasEstablishedUser() {
  const info = inspectDbFile(DATA_DIR);
  return !!(info && info.established > 0);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(PUBLIC_UPLOADS, { recursive: true });
fs.mkdirSync(BACKUPS, { recursive: true });

function debugLogin(hypothesisId, location, message, data) {
  const payload = {
    sessionId: "c9e7db",
    runId: "run1",
    hypothesisId,
    location,
    message,
    data,
    timestamp: Date.now(),
  };
  // #region agent log
  fetch("http://127.0.0.1:7351/ingest/6cb06698-8d76-42fd-836c-7b3f0be1b80b", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Debug-Session-Id": "c9e7db" },
    body: JSON.stringify(payload),
  }).catch(() => {});
  try {
    fs.appendFileSync(path.join(ROOT, "debug-c9e7db.log"), `${JSON.stringify(payload)}\n`);
  } catch {
    /* ignore */
  }
  console.log("[debug-c9e7db]", JSON.stringify(payload));
  // #endregion
}

function resolveSessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) return secret;
  const secretFile = path.join(DATA_DIR, ".session-secret");
  try {
    if (fs.existsSync(secretFile)) {
      const saved = fs.readFileSync(secretFile, "utf8").trim();
      if (saved.length >= 32) return saved;
    }
  } catch {
    /* segue para gerar */
  }
  if (secret) console.warn("[AVISO] SESSION_SECRET muito curto — usando chave temporária.");
  else if (PROD) console.warn("[AVISO] SESSION_SECRET ausente neste host — gerando chave temporária de teste.");
  const generated = crypto.randomBytes(48).toString("hex");
  try {
    fs.writeFileSync(secretFile, generated);
  } catch {
    /* se não gravar, a sessão muda a cada restart */
  }
  return generated;
}
const SESSION_SECRET = resolveSessionSecret();

/* =========================================================================
   UTILITÁRIOS
   ========================================================================= */

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString("hex")}`;
}

function needsTwoFactorSetup(user) {
  return !DISABLE_2FA && !(user && user.totp && user.totp.confirmedAt);
}

/** Texto seguro: remove nulos/controle, corta no tamanho máximo. */
function str(value, max = 200) {
  return String(value == null ? "" : value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

const INVALID = Symbol("invalid");

/** Número opcional. Retorna null (vazio) ou INVALID quando não é número. */
function optNum(value, { min = 0, max = 1e9, decimals = 2 } = {}) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return INVALID;
  if (n < min || n > max) return INVALID;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function optInt(value, { min = 0, max = 1e7 } = {}) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) return INVALID;
  return n;
}

function bool(value, fallback = false) {
  if (value === true || value === "true" || value === 1 || value === "1") return true;
  if (value === false || value === "false" || value === 0 || value === "0") return false;
  return fallback;
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length !== bufB.length || !bufA.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function clientIp(req) {
  return String(req.ip || req.connection?.remoteAddress || "").replace(/^::ffff:/, "");
}

function uaHash(req) {
  return crypto.createHash("sha256").update(String(req.get("user-agent") || "")).digest("hex").slice(0, 16);
}

/* =========================================================================
   BANCO (arquivo JSON com cache + escrita atômica)
   ========================================================================= */

let dbCache = null;
let dbStamp = "";

function fileStamp() {
  try {
    const st = fs.statSync(DB_PATH);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
}

function normalizeDb(db) {
  if (!db || typeof db !== "object" || Array.isArray(db)) throw new Error("data/db.json inválido");
  if (!db.settings || typeof db.settings !== "object") db.settings = {};
  if (!Array.isArray(db.categories)) db.categories = [];
  if (!Array.isArray(db.products)) db.products = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.customers)) db.customers = [];
  if (!Array.isArray(db.ledger)) db.ledger = [];
  return db;
}

function readDbFromDisk() {
  return normalizeDb(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
}

/** Recarrega do disco se o arquivo mudou fora do servidor (scripts de import). */
function getDb() {
  const stamp = fileStamp();
  if (!dbCache || stamp !== dbStamp) {
    dbCache = readDbFromDisk();
    dbStamp = stamp;
  }
  return dbCache;
}

function saveDb(db) {
  if (db.ledger.length > LEDGER_MAX) db.ledger.length = LEDGER_MAX;
  const tmp = `${DB_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_PATH); // troca atômica: nunca deixa o db pela metade
  dbCache = db;
  dbStamp = fileStamp();
}

/* =========================================================================
   SENHAS (scrypt)
   ========================================================================= */

const KDF = { alg: "scrypt", N: 32768, r: 8, p: 1, keylen: 64 };
const LEGACY_KDF = { alg: "scrypt", N: 16384, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * KDF.N * KDF.r * 4;

const WEAK_PASSWORDS = [
  "goldskull", "goldskull123", "12345678", "123456789", "senha123", "senha1234",
  "admin123", "adminadmin", "password", "qwerty123", "gold1234", "skull123",
];

function kdfOf(user) {
  const k = user.kdf && user.kdf.alg === "scrypt" ? user.kdf : LEGACY_KDF;
  return { N: k.N || LEGACY_KDF.N, r: k.r || LEGACY_KDF.r, p: k.p || LEGACY_KDF.p, keylen: k.keylen || 64 };
}

function scryptAsync(password, salt, k) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      String(salt),
      k.keylen,
      { N: k.N, r: k.r, p: k.p, maxmem: SCRYPT_MAXMEM },
      (err, key) => (err ? reject(err) : resolve(key.toString("hex")))
    );
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await scryptAsync(password, salt, KDF);
  return { salt, hash, kdf: { ...KDF } };
}

function hashPasswordSync(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .scryptSync(String(password), salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p, maxmem: SCRYPT_MAXMEM })
    .toString("hex");
  return { salt, hash, kdf: { ...KDF } };
}

async function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const hash = await scryptAsync(password, user.salt, kdfOf(user));
  return safeEqual(hash, user.hash);
}

function verifyPasswordSync(password, user) {
  try {
    const k = kdfOf(user);
    const hash = crypto
      .scryptSync(String(password), String(user.salt), k.keylen, { N: k.N, r: k.r, p: k.p, maxmem: SCRYPT_MAXMEM })
      .toString("hex");
    return safeEqual(hash, user.hash);
  } catch {
    return false;
  }
}

function passwordProblem(password, username) {
  const pw = String(password || "");
  if (pw.length < MIN_PASSWORD) return `A senha precisa de pelo menos ${MIN_PASSWORD} caracteres.`;
  if (pw.length > 200) return "Senha muito longa.";
  const low = pw.toLowerCase();
  if (WEAK_PASSWORDS.includes(low)) return "Essa senha é muito conhecida. Escolha outra.";
  if (username && low === String(username).toLowerCase()) return "A senha não pode ser igual ao usuário.";
  if (/^(.)\1+$/.test(pw)) return "A senha não pode ser só um caractere repetido.";
  if (/^\d+$/.test(pw)) return "A senha não pode ser só números.";
  return null;
}

/* =========================================================================
   2FA — TOTP (Google Authenticator / Authy) + códigos de recuperação
   ========================================================================= */

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_STEP_MS = 30000;
const TOTP_WINDOW = 1; // aceita o código anterior e o próximo (relógio torto)
const RECOVERY_CODES = 10;

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str32) {
  const clean = String(str32 || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpAt(secretB32, step) {
  const counter = Buffer.alloc(8);
  counter.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  counter.writeUInt32BE(step >>> 0, 4);
  const digest = crypto.createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) | (digest[offset + 1] << 16) | (digest[offset + 2] << 8) | digest[offset + 3];
  return String(binary % 1000000).padStart(6, "0");
}

/** Retorna o step usado (para bloquear reuso) ou null se o código não vale. */
function verifyTotp(secretB32, code, lastStep) {
  const clean = String(code || "").replace(/\D/g, "");
  if (clean.length !== 6) return null;
  const now = Math.floor(Date.now() / TOTP_STEP_MS);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta += 1) {
    const step = now + delta;
    if (lastStep != null && step <= lastStep) continue; // já usado: não repete
    if (safeEqual(totpAt(secretB32, step), clean)) return step;
  }
  return null;
}

function newTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function otpauthUri(secret, username, storeName) {
  const label = encodeURIComponent(`${storeName || "GOLD SKULL"}:${username}`);
  const issuer = encodeURIComponent(storeName || "GOLD SKULL");
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function formatRecoveryCode(raw) {
  return `${raw.slice(0, 5)}-${raw.slice(5, 10)}`.toUpperCase();
}

function hashRecoveryCode(code) {
  const clean = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return crypto.createHash("sha256").update(`gs-recovery:${clean}`).digest("hex");
}

function makeRecoveryCodes() {
  const plain = [];
  const stored = [];
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem 0/O/1/I
  while (plain.length < RECOVERY_CODES) {
    let raw = "";
    while (raw.length < 10) {
      const byte = crypto.randomBytes(1)[0];
      if (byte >= 256 - (256 % alphabet.length)) continue; // sem viés
      raw += alphabet[byte % alphabet.length];
    }
    const formatted = formatRecoveryCode(raw);
    plain.push(formatted);
    stored.push({ hash: hashRecoveryCode(formatted), usedAt: null });
  }
  return { plain, stored };
}

function recoveryLeft(user) {
  return (user.recoveryCodes || []).filter((c) => !c.usedAt).length;
}

/** Consome um código de recuperação. Retorna true se valia. */
function useRecoveryCode(user, code) {
  const hash = hashRecoveryCode(code);
  const entry = (user.recoveryCodes || []).find((c) => !c.usedAt && safeEqual(c.hash, hash));
  if (!entry) return false;
  entry.usedAt = new Date().toISOString();
  return true;
}

/* =========================================================================
   LOG DE AUDITORIA (arquivo append-only, fora do db.json)
   ========================================================================= */

const AUDIT_ACTIONS = {
  "auth.login": "Entrou no painel",
  "auth.login_failed": "Tentativa de login falhou",
  "auth.logout": "Saiu do painel",
  "auth.locked": "Conta bloqueada por tentativas",
  "auth.session_expired": "Sessão expirada",
  "product.create": "Produto criado",
  "product.update": "Produto editado",
  "product.delete": "Produto excluído",
  "product.duplicate": "Produto duplicado",
  "product.quick": "Ajuste rápido no produto",
  "option.create": "Sabor adicionado",
  "option.update": "Sabor editado",
  "option.delete": "Sabor removido",
  "option.reorder": "Sabores reordenados",
  "option.image": "Foto de sabor enviada",
  "option.image_delete": "Foto de sabor removida",
  "stock.move": "Movimentação de estoque",
  "stock.undo": "Movimentação desfeita",
  "settings.update": "Configurações da loja salvas",
  "settings.banner": "Banner trocado",
  "promo.image": "Foto de promoção enviada",
  "promo.image_delete": "Foto de promoção removida",
  "2fa.setup_started": "Começou a configurar o 2FA",
  "2fa.enabled": "2FA ativado",
  "2fa.failed": "Código 2FA errado",
  "2fa.recovery_used": "Entrou com código de recuperação",
  "2fa.recovery_regenerated": "Códigos de recuperação gerados",
  "2fa.reset": "2FA zerado por administrador",
  "user.create": "Acesso criado",
  "user.delete": "Acesso excluído",
  "user.password": "Senha alterada",
  "audit.clear": "Logs apagados",
  "audit.export": "Logs exportados",
  "security.unauthorized": "Acesso sem permissão",
  "security.forbidden": "Ação bloqueada por permissão",
  "security.csrf": "Requisição sem token válido (CSRF)",
  "security.origin": "Requisição de origem estranha",
  "security.rate_limit": "Limite de requisições atingido",
  "security.session_mismatch": "Sessão usada em outro navegador",
  "security.ip_blocked": "Acesso ao painel de IP não liberado",
  "security.upload_rejected": "Upload recusado",
  "order.placed": "Novo pedido do cliente",
};

function rotateAuditIfNeeded() {
  try {
    const st = fs.statSync(AUDIT_PATH);
    if (st.size < AUDIT_MAX_BYTES) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.renameSync(AUDIT_PATH, path.join(BACKUPS, `audit-${stamp}.jsonl`));
  } catch {
    /* arquivo ainda não existe */
  }
}

function actorFrom(req) {
  const u = req && req.session && req.session.user;
  if (!u) return { id: null, name: "não identificado", role: "guest" };
  return { id: u.id, name: u.name || u.username, role: u.role };
}

function logAction(req, action, extra = {}) {
  const actor = extra.actor || actorFrom(req);
  const severity =
    extra.severity ||
    (action.startsWith("security.") || action.endsWith("_failed") || action === "auth.locked" ? "alert" : "info");
  const entry = {
    id: uid("log"),
    at: new Date().toISOString(),
    action,
    label: AUDIT_ACTIONS[action] || action,
    severity,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    ip: req ? clientIp(req) : "",
    ua: req ? str(req.get("user-agent"), 180) : "",
    method: req ? req.method : "",
    route: req ? str(req.originalUrl || req.path, 160) : "",
    targetType: extra.targetType || "",
    targetId: extra.targetId || "",
    targetName: str(extra.targetName, 160),
    detail: str(extra.detail, 400),
    changes: Array.isArray(extra.changes) && extra.changes.length ? extra.changes.slice(0, 40) : null,
    meta: extra.meta && typeof extra.meta === "object" ? extra.meta : null,
  };
  try {
    rotateAuditIfNeeded();
    fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(entry)}\n`);
  } catch (err) {
    console.error("[audit] falha ao gravar log:", err.message);
  }
  return entry;
}

function readAudit() {
  let raw = "";
  try {
    raw = fs.readFileSync(AUDIT_PATH, "utf8");
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* linha corrompida é ignorada */
    }
  }
  return out.reverse(); // mais novo primeiro
}

/** Diff legível para o log de edições. */
function diffFields(before, after, fields) {
  const changes = [];
  for (const f of fields) {
    const a = before[f] === undefined ? null : before[f];
    const b = after[f] === undefined ? null : after[f];
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field: f, from: a, to: b });
  }
  return changes;
}

/* =========================================================================
   MIGRAÇÃO / SANEAMENTO NA PARTIDA
   ========================================================================= */

function printFirstAccess(password, reason) {
  console.log(
    "\n==================== PRIMEIRO ACESSO ====================\n" +
      `  Usuário: admin\n  Senha:   ${password}\n` +
      `  Banco:   ${DB_PATH}\n` +
      (reason ? `  Motivo:  ${reason}\n` : "") +
      "\n  O painel vai pedir a troca dessa senha no primeiro login.\n" +
      "  Depois da troca ela fica salva no volume e não muda no deploy.\n" +
      "  Anote agora: ela não será mostrada de novo depois da troca.\n" +
      "=========================================================\n"
  );
}

/** Instalação nova: cria o banco a partir do seed com uma senha aleatória (nunca uma senha padrão). */
function ensureDb() {
  const exists = fs.existsSync(DB_PATH);
  const ready = hasAdminReady();
  const established = dbHasEstablishedUser();
  debugLogin("A", "server.js:ensureDb", "antes de criar/reusar banco", {
    dbPath: DB_PATH,
    exists,
    ready,
    established,
  });
  if (ready || established) {
    if (!exists) {
      console.error(
        "[dados] senha do painel já foi definida neste volume, mas db.json não está no caminho " +
          `${DB_PATH}. Não crio um admin novo. Restaure o volume ou ajuste DATA_DIR.`
      );
    } else if (!ready) {
      markAdminReady();
    }
    return false;
  }
  if (exists) return false;
  const seedPath = path.join(ROOT, "db.seed.json");
  const db = normalizeDb(JSON.parse(fs.readFileSync(seedPath, "utf8")));
  const password = process.env.SETUP_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
  db.users = [
    {
      id: "u-admin",
      username: "admin",
      name: "Administrador",
      role: "admin",
      ...hashPasswordSync(password),
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    },
  ];
  saveDb(db);
  debugLogin("A", "server.js:ensureDb", "banco novo criado (PRIMEIRO ACESSO)", {
    dbPath: DB_PATH,
    userCount: 1,
  });
  printFirstAccess(password, "banco criado agora");
  return true;
}
const dbJustCreated = ensureDb();

const DEFAULT_CITIES = ["Itajaí", "Joinville", "Atacado"];

function foldKey(s) {
  return str(s, 80)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function canonicalizeCity(name) {
  const t = foldKey(name);
  if (!t) return "";
  if (t.includes("joinville")) return "Joinville";
  if (t.includes("itajai")) return "Itajaí";
  if (/(brasil|atacado|outras|remoto|transportadora|correios)/.test(t)) return "Atacado";
  return str(name, 60);
}

function defaultShippingFor(id) {
  if (id === "Joinville") return { name: "Joinville", price: 15, description: "Motoboy — entrega rápida na região" };
  if (id === "Atacado") return { name: "Atacado", price: 0, description: "Brasil" };
  return { name: "Itajaí", price: 15, description: "Motoboy — entrega rápida na região" };
}

function normalizeShippingCashboxes(list) {
  const byBox = new Map();
  for (const x of Array.isArray(list) ? list : []) {
    const name = canonicalizeCity(x && x.name);
    if (!DEFAULT_CITIES.includes(name)) continue;
    if (byBox.has(name)) continue;
    const price = Number(x && x.price) || 0;
    const description = str(x && x.description, 160);
    byBox.set(name, {
      name,
      price: name === "Atacado" ? 0 : price,
      description: description || defaultShippingFor(name).description,
    });
  }
  return DEFAULT_CITIES.map((id) => byBox.get(id) || defaultShippingFor(id));
}

function shippingCities(_settings) {
  return DEFAULT_CITIES.slice();
}

function parseCitiesInput(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      const parsed = JSON.parse(t);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* lista simples */
    }
    return t.split(/[,|\n]/);
  }
  return [];
}

function normalizeCities(raw, cityNames) {
  const names = cityNames && cityNames.length ? cityNames : DEFAULT_CITIES;
  const allowed = new Map(names.map((c) => [foldKey(c), c]));
  const out = [];
  const seen = new Set();
  for (const item of parseCitiesInput(raw)) {
    const canon = canonicalizeCity(item);
    if (!canon) continue;
    const official = allowed.get(foldKey(canon)) || (DEFAULT_CITIES.includes(canon) ? canon : null);
    if (!official) continue;
    const key = foldKey(official);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(official);
  }
  return out;
}

function inferProductCities(product, cityNames) {
  const names = cityNames && cityNames.length ? cityNames : DEFAULT_CITIES;
  const existing = normalizeCities(product && product.cities, names);
  if (existing.length) return existing;
  const fromCat = canonicalizeCity(product && product.category);
  const match = names.find((c) => foldKey(c) === foldKey(fromCat));
  if (match) return [match];
  const other = names.find((c) => foldKey(c) === "atacado") || names[names.length - 1];
  return other ? [other] : names.slice(0, 1);
}

const PRODUCT_TYPE_ORDER = ["Pods", "Refis", "Baterias", "Gomas", "Outros"];

function inferProductType(name) {
  const t = foldKey(name);
  if (t.includes("goma")) return "Gomas";
  if (t.includes("bateria")) return "Baterias";
  if (t.includes("refil")) return "Refis";
  if (t.includes("pod")) return "Pods";
  return "Outros";
}

function isLocationCategory(cat, cityNames) {
  const t = foldKey(cat);
  if (!t) return true;
  if (t === "atacado") return true;
  return (cityNames || DEFAULT_CITIES).some((c) => foldKey(c) === t);
}

function recategorizeCatalog(db) {
  const cityNames = shippingCities(db.settings);
  let changed = false;
  for (const p of db.products || []) {
    const cities = inferProductCities(p, cityNames);
    if (JSON.stringify(p.cities || []) !== JSON.stringify(cities)) {
      p.cities = cities;
      changed = true;
    }
    if (isLocationCategory(p.category, cityNames)) {
      const next = inferProductType(p.name);
      if (p.category !== next) {
        p.category = next;
        changed = true;
      }
    }
  }
  const used = [...new Set((db.products || []).map((p) => str(p.category, 60)).filter(Boolean))];
  const nextCats = [];
  for (const t of PRODUCT_TYPE_ORDER) if (used.includes(t)) nextCats.push(t);
  for (const c of db.categories || []) {
    if (isLocationCategory(c, cityNames)) continue;
    if (!nextCats.includes(c)) nextCats.push(c);
  }
  for (const c of used) {
    if (isLocationCategory(c, cityNames)) continue;
    if (!nextCats.includes(c)) nextCats.push(c);
  }
  if (JSON.stringify(db.categories || []) !== JSON.stringify(nextCats)) {
    db.categories = nextCats;
    changed = true;
  }
  return changed;
}

function applyAdminPasswordReset() {
  const password = String(process.env.RESET_ADMIN_PASSWORD || "");
  if (!password) return;

  const problem = passwordProblem(password, "admin");
  if (problem) {
    console.warn(`[admin] RESET_ADMIN_PASSWORD ignorado: ${problem}`);
    return;
  }

  const markerPath = path.join(DATA_DIR, ".admin-reset-done");
  const marker = crypto.createHash("sha256").update(password).digest("hex");
  if (fs.existsSync(markerPath) && fs.readFileSync(markerPath, "utf8") === marker) return;

  const db = readDbFromDisk();
  const admin = (db.users || []).find((u) => String(u.username).toLowerCase() === "admin");
  if (!admin) {
    console.warn("[admin] RESET_ADMIN_PASSWORD ignorado: usuário admin não encontrado.");
    return;
  }

  Object.assign(admin, hashPasswordSync(password));
  admin.mustChangePassword = true;
  admin.totp = null;
  saveDb(db);
  fs.writeFileSync(markerPath, marker);
  clearAdminReady();
  console.log("[admin] senha do usuário admin redefinida por RESET_ADMIN_PASSWORD. Troque no próximo login.");
}

/** Se o painel nunca terminou a troca de senha neste banco, reemite uma senha e imprime no log. */
function ensureAdminBootstrap(createdNow) {
  if (String(process.env.RESET_ADMIN_PASSWORD || "").trim()) return;
  if (createdNow) return;
  if (hasAdminReady()) {
    debugLogin("A", "server.js:ensureAdminBootstrap", "bootstrap já concluído", {
      dbPath: DB_PATH,
      railway: isRailwayHost(),
    });
    return;
  }
  const db = getDb();
  const users = Array.isArray(db.users) ? db.users : [];
  let admin = users.find((u) => String(u.username).toLowerCase() === "admin");
  if (admin && admin.mustChangePassword === false) {
    markAdminReady();
    debugLogin("A", "server.js:ensureAdminBootstrap", "admin já tinha senha definitiva", {
      dbPath: DB_PATH,
    });
    return;
  }
  if (!isRailwayHost() && admin) return;

  const password = process.env.SETUP_ADMIN_PASSWORD || crypto.randomBytes(12).toString("base64url");
  if (!admin) {
    admin = {
      id: "u-admin",
      username: "admin",
      name: "Administrador",
      role: "admin",
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    };
    db.users = [admin, ...users];
  }
  Object.assign(admin, hashPasswordSync(password));
  admin.mustChangePassword = true;
  saveDb(db);
  debugLogin("A", "server.js:ensureAdminBootstrap", "senha de bootstrap reemitida", {
    dbPath: DB_PATH,
    railway: isRailwayHost(),
    createdAdmin: !users.some((u) => String(u.username).toLowerCase() === "admin"),
    userCount: (db.users || []).length,
  });
  printFirstAccess(password, "senha reemitida para este banco — use esta, não a de um log antigo");
}

function importCatalogIfEmpty(db) {
  if (!db || (Array.isArray(db.products) && db.products.length)) return false;
  const storePath = path.join(ROOT, "public", "data", "store.json");
  if (!fs.existsSync(storePath)) return false;
  let store;
  try {
    store = JSON.parse(fs.readFileSync(storePath, "utf8"));
  } catch {
    return false;
  }
  const s = store.settings || {};
  if (s.whatsapp) db.settings.whatsapp = String(s.whatsapp).replace(/\D/g, "").slice(0, 20);
  if (s.checkoutMessage) db.settings.checkoutMessage = str(s.checkoutMessage, 400);
  if (Array.isArray(s.payments) && s.payments.length) db.settings.payments = s.payments.map((p) => str(p, 120)).filter(Boolean);
  if (Array.isArray(s.shipping) && s.shipping.length) {
    db.settings.shipping = normalizeShippingCashboxes(s.shipping);
  }
  if (Array.isArray(s.coupons) && s.coupons.length) {
    db.settings.coupons = s.coupons.map((raw) => readCoupon(raw, [])).filter(Boolean);
  }
  if (s.referral && typeof s.referral === "object") {
    db.settings.referral = {
      enabled: s.referral.enabled !== false,
      referrerBonus: Math.max(0, Number(s.referral.referrerBonus) || 0),
      referredBonus: Math.max(0, Number(s.referral.referredBonus) || 0),
      orderCashbackPercent: Math.min(50, Math.max(0, Number(s.referral.orderCashbackPercent) || 0)),
    };
  }
  if (Array.isArray(store.categories) && store.categories.length) {
    db.categories = store.categories.map((c) => str(c, 60)).filter(Boolean);
  }
  db.products = (store.products || []).map((p) => ({
    id: str(p.id, 60) || uid("p"),
    name: str(p.name, 160) || "Produto",
    description: str(p.description, 4000),
    price: Number(p.price) || 0,
    promoPrice: p.promoPrice == null ? null : Number(p.promoPrice),
    category: str(p.category, 60),
    image: str(p.image, 300),
    stock: p.stock == null ? null : Number(p.stock),
    stockActive: !!p.stockActive,
    pin: !!p.pin,
    active: p.active !== false,
    optionGroup: str(p.optionGroup, 80),
    options: (Array.isArray(p.options) ? p.options : []).map((o, i) => ({
      id: str(o && o.id, 40) || uid("opt"),
      title: str(o && o.title, 80) || `Opção ${i + 1}`,
      image: str(o && o.image, 300),
      available: !(o && o.available === false),
    })),
    cities: inferProductCities(p, shippingCities(db.settings)),
  }));
  console.log(`[catálogo] importados ${db.products.length} produtos de public/data/store.json`);
  return true;
}

function migrate() {
  const db = readDbFromDisk();
  let changed = false;

  // 1) ids de sabores únicos e formato estável
  for (const p of db.products) {
    if (!Array.isArray(p.options)) {
      p.options = [];
      changed = true;
      continue;
    }
    const seen = new Set();
    p.options = p.options.map((o, i) => {
      const title = str(o && o.title, 80) || `Opção ${i + 1}`;
      let id = str(o && o.id, 40);
      if (!id || seen.has(id)) {
        id = uid("opt");
        changed = true;
      }
      seen.add(id);
      const next = {
        id,
        title,
        image: str(o && o.image, 300),
        available: !(o && o.available === false),
      };
      if (JSON.stringify(next) !== JSON.stringify(o)) changed = true;
      return next;
    });
  }

  // 2) usuários: marca troca obrigatória quando a senha é a padrão/fraca
  for (const u of db.users) {
    if (u.mustChangePassword === undefined) {
      const weak = WEAK_PASSWORDS.some((pw) => verifyPasswordSync(pw, u));
      u.mustChangePassword = weak;
      changed = true;
      if (weak) {
        console.warn(`[AVISO] O usuário "${u.username}" usa uma senha padrão/fraca — o painel vai exigir a troca no próximo login.`);
      }
    }
    if (!u.kdf) {
      u.kdf = { ...LEGACY_KDF };
      changed = true;
    }
  }

  if (!Array.isArray(db.ledger)) {
    db.ledger = [];
    changed = true;
  }

  // 2b) o cliente não usa Instagram: some com o campo
  if (db.settings.instagram !== undefined) {
    delete db.settings.instagram;
    changed = true;
  }

  // 2c) área de promoções
  if (!Array.isArray(db.settings.promos)) {
    db.settings.promos = [];
    changed = true;
  }
  if (!db.settings.promoBar || typeof db.settings.promoBar !== "object") {
    db.settings.promoBar = { active: false, text: "", ctaLabel: "", action: "catalogo", value: "" };
    changed = true;
  }

  // 2d) cupons de desconto
  if (!Array.isArray(db.settings.coupons)) {
    db.settings.coupons = [];
    changed = true;
  }
  if (!db.settings.referral || typeof db.settings.referral !== "object") {
    db.settings.referral = { enabled: true, referrerBonus: 10, referredBonus: 5, orderCashbackPercent: 2 };
    changed = true;
  }

  // 2e) clientes da loja
  if (!Array.isArray(db.customers)) {
    db.customers = [];
    changed = true;
  }

  // 2f) catálogo vazio: importa a vitrine estática (útil no primeiro deploy)
  if (importCatalogIfEmpty(db)) changed = true;

  // 2g) caixas Itajaí / Joinville / Atacado + categoria de tipo (Pods, Refis...)
  const nextShip = normalizeShippingCashboxes(db.settings && db.settings.shipping);
  if (JSON.stringify((db.settings && db.settings.shipping) || []) !== JSON.stringify(nextShip)) {
    db.settings.shipping = nextShip;
    changed = true;
  }
  if (recategorizeCatalog(db)) changed = true;
  const cityNames = shippingCities(db.settings);
  for (const e of db.ledger || []) {
    const product = db.products.find((p) => p.id === e.productId);
    const cities = normalizeCities(
      Array.isArray(e.cities) && e.cities.length ? e.cities : [e.city, e.category],
      cityNames
    );
    const nextCities = cities.length
      ? cities
      : product
        ? inferProductCities(product, cityNames)
        : inferProductCities({ category: e.category }, cityNames);
    const nextCity = nextCities[0] || "";
    let nextCat = str(e.category, 60);
    if (!nextCat || isLocationCategory(nextCat, cityNames)) {
      if (product && product.category && !isLocationCategory(product.category, cityNames)) {
        nextCat = product.category;
      } else if ((product && product.name) || e.productName) {
        nextCat = inferProductType((product && product.name) || e.productName);
      } else {
        nextCat = "";
      }
    }
    if (JSON.stringify(e.cities || []) !== JSON.stringify(nextCities) || e.city !== nextCity || e.category !== nextCat) {
      e.cities = nextCities;
      e.city = nextCity;
      e.category = nextCat;
      changed = true;
    }
  }

  // 3) audit antigo dentro do db.json vai para o arquivo de log
  if (Array.isArray(db.audit)) {
    for (const entry of db.audit.slice().reverse()) {
      try {
        fs.appendFileSync(AUDIT_PATH, `${JSON.stringify(entry)}\n`);
      } catch {
        /* ignora */
      }
    }
    delete db.audit;
    changed = true;
  }

  if (changed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    try {
      fs.copyFileSync(DB_PATH, path.join(BACKUPS, `db-antes-da-migracao-${stamp}.json`));
    } catch {
      /* segue mesmo sem backup */
    }
    saveDb(db);
    console.log("[migração] data/db.json normalizado (backup salvo em backups/).");
  } else {
    dbCache = db;
    dbStamp = fileStamp();
  }
}
migrate();
applyAdminPasswordReset();
ensureAdminBootstrap(dbJustCreated);

function logDbBoot(created) {
  try {
    const db = getDb();
    if (dbHasEstablishedUser() && !hasAdminReady()) markAdminReady();
    console.log(
      `[dados] banco: ${DB_PATH} · ready: ${hasAdminReady() ? "sim" : "não"} · ` +
        `usuários: ${(db.users || []).length} · produtos: ${(db.products || []).length}` +
        (created ? " · criado agora" : "")
    );
    debugLogin("A", "server.js:logDbBoot", "estado do banco na partida", {
      dbPath: DB_PATH,
      ready: hasAdminReady(),
      created: !!created,
      userCount: (db.users || []).length,
      usernames: (db.users || []).map((u) => String(u.username || "")),
      productCount: (db.products || []).length,
      volume: String(process.env.RAILWAY_VOLUME_MOUNT_PATH || ""),
      dataDirEnv: String(process.env.DATA_DIR || ""),
    });
  } catch (err) {
    console.error("[dados] não foi possível ler o banco:", err && err.message ? err.message : err);
  }
}
logDbBoot(dbJustCreated);

/* =========================================================================
   RATE LIMITING
   ========================================================================= */

const limitLogged = new Map();
function limitHandler(name) {
  return (req, res) => {
    const key = `${clientIp(req)}|${name}`;
    const now = Date.now();
    if (!limitLogged.has(key) || now - limitLogged.get(key) > 60000) {
      limitLogged.set(key, now);
      logAction(req, "security.rate_limit", { detail: `${name}: ${req.method} ${req.originalUrl}` });
    }
    res.status(429).json({ error: "Muitas tentativas. Espere alguns minutos e tente de novo." });
  };
}

const baseLimit = {
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) => clientIp(req),
  validate: false, // a configuração de proxy é nossa (TRUST_PROXY)
};

const publicLimiter = rateLimit({
  ...baseLimit,
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.LIMIT_PUBLIC || 400),
  handler: limitHandler("catálogo público"),
});

const apiLimiter = rateLimit({
  ...baseLimit,
  windowMs: 5 * 60 * 1000,
  limit: Number(process.env.LIMIT_API || 800),
  handler: limitHandler("api"),
});

const writeLimiter = rateLimit({
  ...baseLimit,
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.LIMIT_WRITE || 400),
  handler: limitHandler("gravação"),
});

const uploadLimiter = rateLimit({
  ...baseLimit,
  windowMs: 10 * 60 * 1000,
  limit: Number(process.env.LIMIT_UPLOAD || 150),
  handler: limitHandler("upload"),
});

const loginLimiter = rateLimit({
  ...baseLimit,
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.LIMIT_LOGIN || 12),
  skipSuccessfulRequests: true,
  handler: limitHandler("login"),
});

// Bloqueio por conta (impede força bruta distribuída em um único usuário)
const loginFails = new Map();
function lockState(username) {
  const rec = loginFails.get(username);
  if (!rec) return null;
  if (rec.until && rec.until > Date.now()) return rec;
  if (rec.until && rec.until <= Date.now()) loginFails.delete(username);
  return null;
}
function registerFail(username) {
  const rec = loginFails.get(username) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= LOGIN_MAX_FAILS) {
    rec.until = Date.now() + LOGIN_LOCK_MS * Math.min(8, Math.ceil(rec.count / LOGIN_MAX_FAILS));
  }
  loginFails.set(username, rec);
  return rec;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of loginFails) if ((v.until && v.until < now) || (!v.until && v.count === 0)) loginFails.delete(k);
  for (const [k, v] of limitLogged) if (now - v > 10 * 60 * 1000) limitLogged.delete(k);
}, 5 * 60 * 1000).unref();

/* =========================================================================
   UPLOADS
   ========================================================================= */

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  // O nome original do arquivo é ignorado de propósito (evita .svg/.html/traversal)
  filename: (_req, file, cb) => cb(null, `${uid("img")}${MIME_EXT[file.mimetype] || ".bin"}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 40, parts: 45, fieldNameSize: 100 },
  fileFilter: (_req, file, cb) => {
    if (!MIME_EXT[file.mimetype]) return cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE", "image"));
    cb(null, true);
  },
});

function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return ".jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return ".png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return ".webp";
  const gif = buf.subarray(0, 6).toString("latin1");
  if (gif === "GIF87a" || gif === "GIF89a") return ".gif";
  return null;
}

function dropUpload(req) {
  if (!req.file) return;
  try {
    fs.unlinkSync(req.file.path);
  } catch {
    /* ignora */
  }
  req.file = null;
}

/** Confere os bytes reais do arquivo. Não confia no Content-Type do cliente. */
function checkUpload(req) {
  if (!req.file) return null;
  let buf = Buffer.alloc(0);
  try {
    const fd = fs.openSync(req.file.path, "r");
    buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
  } catch {
    dropUpload(req);
    return "Não foi possível ler o arquivo enviado.";
  }
  const kind = sniffImage(buf);
  if (!kind || kind !== path.extname(req.file.filename)) {
    logAction(req, "security.upload_rejected", {
      detail: `tipo declarado ${req.file.mimetype}, conteúdo ${kind || "desconhecido"}`,
    });
    dropUpload(req);
    return "Esse arquivo não é uma imagem válida. Use JPG, PNG, WEBP ou GIF.";
  }
  return null;
}

const uploadedUrl = (req) => `/uploads/${req.file.filename}`;

/** Apaga foto antiga só se ninguém mais usa e se está dentro de data/uploads. */
function removeUnusedUpload(db, url) {
  const clean = str(url, 300);
  if (!clean.startsWith("/uploads/")) return;
  const base = path.basename(clean);
  if (!base || base.includes("..")) return;
  const stillUsed =
    db.products.some((p) => p.image === clean || (p.options || []).some((o) => o.image === clean)) ||
    db.settings.banner === clean ||
    (Array.isArray(db.settings.promos) && db.settings.promos.some((p) => p.image === clean));
  if (stillUsed) return;
  for (const dir of [UPLOADS, PUBLIC_UPLOADS]) {
    const full = path.join(dir, base);
    if (!full.startsWith(dir + path.sep)) continue;
    try {
      fs.unlinkSync(full);
    } catch {
      /* já não existe */
    }
  }
}

/* =========================================================================
   APP
   ========================================================================= */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", TRUST_PROXY === "true" ? true : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY);
app.set("etag", "strong");

if (FORCE_HTTPS) {
  app.use((req, res, next) => {
    if (req.secure || req.get("x-forwarded-proto") === "https") return next();
    if (req.method !== "GET" && req.method !== "HEAD") return res.status(403).json({ error: "Use HTTPS." });
    res.redirect(308, `https://${req.get("host")}${req.originalUrl}`);
  });
}

app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'none'"],
        "script-src": ["'self'"],
        "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        "font-src": ["'self'", "https://fonts.gstatic.com"],
        "img-src": ["'self'", "data:", "blob:"],
        "connect-src": ["'self'"],
        "media-src": ["'self'"],
        "manifest-src": ["'self'"],
        "worker-src": ["'self'"], // service worker do PWA
        "form-action": ["'self'"],
        "base-uri": ["'none'"],
        "object-src": ["'none'"],
        "frame-ancestors": ["'none'"],
        ...(FORCE_HTTPS ? { "upgrade-insecure-requests": [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "same-site" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    hsts: FORCE_HTTPS ? { maxAge: 15552000, includeSubDomains: true } : false,
    frameguard: { action: "deny" },
  })
);

app.use((_req, res, next) => {
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  next();
});

// Nada de API em cache de proxy/navegador: as respostas do painel são privadas
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  next();
});

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb", parameterLimit: 60 }));

const sessionStore = new session.MemoryStore();
// MemoryStore padrão nunca limpa sessões expiradas: limpamos aqui.
setInterval(() => {
  sessionStore.all((err, sessions) => {
    if (err || !sessions) return;
    const now = Date.now();
    for (const [sid, sess] of Object.entries(sessions)) {
      const exp = sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : 0;
      if (exp && exp < now) sessionStore.destroy(sid, () => {});
    }
  });
}, 10 * 60 * 1000).unref();

app.use(
  session({
    name: "gs.sid",
    store: sessionStore,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    proxy: FORCE_HTTPS || undefined,
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: FORCE_HTTPS || PROD,
      maxAge: SESSION_IDLE_MS,
      path: "/",
    },
  })
);

/* ---------- IP allowlist do painel ---------- */
function ipAllowed(req) {
  if (!ADMIN_ALLOW_IPS.length) return true;
  const ip = clientIp(req);
  return ADMIN_ALLOW_IPS.includes(ip);
}

app.use((req, res, next) => {
  const isPanel = req.path === "/admin" || req.path.startsWith("/admin/");
  const isPrivateApi = req.path.startsWith("/api/") && !req.path.startsWith("/api/public/");
  if ((isPanel || isPrivateApi) && !ipAllowed(req)) {
    logAction(req, "security.ip_blocked", { detail: req.originalUrl });
    return res.status(403).type("text/plain").send("Acesso não permitido.");
  }
  if (isPanel) res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
  next();
});

/* ---------- sessão: expiração e vínculo com o navegador ---------- */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

app.use("/api", (req, res, next) => {
  const s = req.session;
  if (!s || !s.user) return next();
  const now = Date.now();
  const expired = now - (s.createdAt || now) > SESSION_MAX_MS || now - (s.lastSeen || now) > SESSION_IDLE_MS;
  const otherBrowser = s.uaHash && s.uaHash !== uaHash(req);
  if (expired || otherBrowser) {
    const actor = actorFrom(req);
    logAction(req, otherBrowser ? "security.session_mismatch" : "auth.session_expired", { actor });
    return s.destroy(() => res.status(401).json({ error: "Sessão encerrada. Entre de novo." }));
  }
  s.lastSeen = now;
  next();
});

/* ---------- CSRF + checagem de origem ---------- */
function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(32).toString("hex");
  return req.session.csrf;
}

function sameOrigin(req) {
  const host = req.get("host");
  const check = (value) => {
    try {
      return new URL(value).host === host;
    } catch {
      return false;
    }
  };
  const origin = req.get("origin");
  if (origin) return check(origin);
  const referer = req.get("referer");
  if (referer) return check(referer);
  return false;
}

// Limites primeiro: até requisição inválida entra na conta do IP
app.use("/api/public", publicLimiter);
app.use("/api", apiLimiter);
app.use("/api", (req, res, next) => (SAFE_METHODS.has(req.method) ? next() : writeLimiter(req, res, next)));

app.use("/api", (req, res, next) => {
  if (SAFE_METHODS.has(req.method)) return next();
  if (!sameOrigin(req)) {
    logAction(req, "security.origin", { detail: `origin=${str(req.get("origin"), 120) || "-"} referer=${str(req.get("referer"), 120) || "-"}` });
    return res.status(403).json({ error: "Origem da requisição não autorizada." });
  }
  if (!req.session.csrf || !safeEqual(req.get("x-csrf-token"), req.session.csrf)) {
    logAction(req, "security.csrf", { detail: `${req.method} ${req.originalUrl}` });
    return res.status(403).json({ error: "Token de segurança inválido. Recarregue a página.", csrf: true });
  }
  next();
});

/* ---------- autorização ---------- */
function requireAuth(req, res, next) {
  if (!req.session.user) {
    logAction(req, "security.unauthorized", { detail: `${req.method} ${req.originalUrl}` });
    return res.status(401).json({ error: "Faça login para continuar." });
  }
  const selfPasswordRoute =
    req.method === "PUT" &&
    (req.path === `/api/users/${req.session.user.id}/password` || req.path === "/api/users/me/password");
  if (req.session.user.mustChangePassword && !selfPasswordRoute) {
    return res.status(423).json({ error: "Troque sua senha para continuar.", mustChangePassword: true });
  }
  const setupRoute =
    req.path === "/api/2fa/setup" || req.path === "/api/2fa/activate" || req.path === "/api/2fa/status";
  // allow disabling mandatory 2FA in environments where it's not desirable
  if (!DISABLE_2FA && req.session.user.needs2faSetup && !setupRoute) {
    return res.status(428).json({ error: "Configure a verificação em duas etapas para continuar.", needs2faSetup: true });
  }
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.session.user.role !== "admin") {
      logAction(req, "security.forbidden", { detail: `${req.method} ${req.originalUrl}` });
      return res.status(403).json({ error: "Apenas administradores podem fazer isso." });
    }
    next();
  });
}

/* ---------- arquivos enviados ---------- */
const uploadStaticOptions = {
  index: false,
  dotfiles: "deny",
  maxAge: "7d",
  setHeaders: (res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    // Se algum arquivo malicioso entrar, ele nasce inerte
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  },
};
const DOCS_UPLOADS = path.join(ROOT, "docs", "uploads");
app.use("/uploads", express.static(UPLOADS, uploadStaticOptions));
app.use("/uploads", express.static(PUBLIC_UPLOADS, uploadStaticOptions));
if (fs.existsSync(DOCS_UPLOADS)) app.use("/uploads", express.static(DOCS_UPLOADS, uploadStaticOptions));

app.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send("User-agent: *\nDisallow: /admin\nDisallow: /api\n");
});

/* =========================================================================
   ROTAS PÚBLICAS
   ========================================================================= */

function publicSettings(s) {
  const ref = s.referral && typeof s.referral === "object" ? s.referral : {};
  return {
    name: s.name || "",
    tagline: s.tagline || "",
    extra: s.extra || "",
    whatsapp: String(s.whatsapp || "").replace(/\D/g, "").slice(0, 20),
    address: s.address || "",
    themeColor: s.themeColor || "",
    banner: s.banner || "",
    checkoutMessage: s.checkoutMessage || "",
    payments: Array.isArray(s.payments) ? s.payments.map((p) => String(p)) : [],
    shipping: normalizeShippingCashboxes(s.shipping).map((x) => ({
      name: x.name,
      price: Number(x.price) || 0,
      description: x.description || "",
    })),
    promoBar: s.promoBar && s.promoBar.active
      ? {
          text: String(s.promoBar.text || ""),
          ctaLabel: String(s.promoBar.ctaLabel || ""),
          action: String(s.promoBar.action || "catalogo"),
          value: String(s.promoBar.value || ""),
        }
      : null,
    promos: Array.isArray(s.promos) ? s.promos.filter((p) => p.active !== false) : [],
    coupons: Array.isArray(s.coupons)
      ? s.coupons
          .filter((c) => c.active !== false && c.code)
          .map((c) => ({
            code: String(c.code || "").toUpperCase(),
            type: c.type || "percent",
            value: c.value,
            giftLabel: c.giftLabel || "",
            giftProductId: c.giftProductId || "",
            minOrder: Number(c.minOrder) || 0,
            maxUses: c.maxUses == null ? null : Number(c.maxUses),
            usedCount: Number(c.usedCount) || 0,
            expiresAt: c.expiresAt || null,
          }))
      : [],
    referral: {
      enabled: ref.enabled !== false,
      referrerBonus: Math.max(0, Number(ref.referrerBonus) || 0),
      referredBonus: Math.max(0, Number(ref.referredBonus) || 0),
      orderCashbackPercent: Math.min(50, Math.max(0, Number(ref.orderCashbackPercent) || 0)),
    },
  };
}

app.get("/api/public/csrf", publicLimiter, (req, res) => {
  res.json({ csrf: csrfToken(req) });
});

app.get("/api/public/store", (_req, res) => {
  const db = getDb();
  const products = db.products
    .filter((p) => p.active !== false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      price: p.price,
      promoPrice: p.promoPrice,
      category: p.category,
      image: p.image,
      stock: p.stock,
      stockActive: p.stockActive,
      pin: p.pin,
      optionGroup: p.optionGroup || "",
      cities: Array.isArray(p.cities) && p.cities.length ? p.cities : inferProductCities(p, shippingCities(db.settings)),
      options: (Array.isArray(p.options) ? p.options : []).map((o) => ({
        id: o.id,
        title: o.title,
        image: o.image || "",
        available: o.available !== false,
      })),
    }));
  res.json({ settings: publicSettings(db.settings), categories: db.categories, products });
});

/* ---------- cupons ---------- */

function normalizeCouponCode(code) {
  return str(code, 30).toUpperCase().replace(/[^A-Z0-9_-]/g, "");
}

function readCoupon(raw, existing) {
  const id = str(raw && raw.id, 60) || uid("coupon");
  const prev = (existing || []).find((c) => c.id === id);
  const type = COUPON_TYPES.includes(raw && raw.type) ? raw.type : "percent";
  const code = normalizeCouponCode(raw && raw.code);
  if (!code) return null;
  const minOrderRaw = optNum(raw && raw.minOrder, { min: 0, max: 1e7 });
  const maxUsesRaw = raw && raw.maxUses != null && raw.maxUses !== "" ? Math.floor(Number(raw.maxUses)) : null;
  let expiresAt = str(raw && raw.expiresAt, 30);
  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) expiresAt = "";
  return {
    id,
    code,
    type,
    value: type === "percent" ? Math.min(100, Math.max(0, Number(raw && raw.value) || 0)) : null,
    giftLabel: type === "gift" ? str(raw && raw.giftLabel, 80) || "Jujuba de brinde" : "",
    giftProductId: type === "gift" ? str(raw && raw.giftProductId, 60) : "",
    minOrder: minOrderRaw === INVALID ? 0 : minOrderRaw ?? 0,
    maxUses: maxUsesRaw != null && maxUsesRaw >= 0 ? maxUsesRaw : null,
    usedCount: prev ? Number(prev.usedCount) || 0 : 0,
    expiresAt: expiresAt || null,
    active: bool(raw && raw.active, true),
    createdAt: prev ? prev.createdAt : new Date().toISOString(),
  };
}

function findCouponByCode(db, code) {
  const norm = normalizeCouponCode(code);
  if (!norm) return null;
  return (db.settings.coupons || []).find((c) => c.active !== false && normalizeCouponCode(c.code) === norm) || null;
}

function evaluateCoupon(coupon, { subtotal, shipPrice }) {
  if (!coupon || coupon.active === false) return { error: "Cupom inválido." };
  if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) return { error: "Cupom expirado." };
  if (coupon.maxUses != null && Number(coupon.usedCount) >= Number(coupon.maxUses)) return { error: "Cupom esgotado." };
  const min = Number(coupon.minOrder) || 0;
  if (min > 0 && subtotal < min) {
    return { error: `Pedido mínimo de R$ ${min.toFixed(2).replace(".", ",")} para este cupom.` };
  }
  if (coupon.type === "percent") {
    const pct = Math.min(100, Math.max(0, Number(coupon.value) || 0));
    const discount = Math.round(subtotal * pct) / 100;
    return { discount, freeShipping: false, gift: null, label: `${pct}% de desconto` };
  }
  if (coupon.type === "free_shipping") {
    const discount = Math.max(0, Number(shipPrice) || 0);
    return { discount, freeShipping: true, gift: null, label: "Frete grátis" };
  }
  if (coupon.type === "gift") {
    return {
      discount: 0,
      freeShipping: false,
      gift: { label: coupon.giftLabel || "Jujuba de brinde", productId: coupon.giftProductId || "" },
      label: coupon.giftLabel || "Brinde",
    };
  }
  return { error: "Tipo de cupom inválido." };
}

app.post("/api/public/coupon/validate", publicLimiter, (req, res) => {
  const db = getDb();
  const code = normalizeCouponCode(req.body && req.body.code);
  const subtotal = Math.max(0, Number(req.body && req.body.subtotal) || 0);
  const shipPrice = Math.max(0, Number(req.body && req.body.shipPrice) || 0);
  if (!code) return res.status(400).json({ error: "Digite o código do cupom." });
  const coupon = findCouponByCode(db, code);
  if (!coupon) return res.status(404).json({ error: "Cupom não encontrado." });
  const result = evaluateCoupon(coupon, { subtotal, shipPrice });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json({ ok: true, code: coupon.code, type: coupon.type, ...result });
});

app.post("/api/public/coupon/redeem", publicLimiter, (req, res) => {
  const db = getDb();
  const code = normalizeCouponCode(req.body && req.body.code);
  if (!code) return res.status(400).json({ error: "Cupom inválido." });
  const coupon = findCouponByCode(db, code);
  if (!coupon) return res.status(404).json({ error: "Cupom não encontrado." });
  const subtotal = Math.max(0, Number(req.body && req.body.subtotal) || 0);
  const shipPrice = Math.max(0, Number(req.body && req.body.shipPrice) || 0);
  const result = evaluateCoupon(coupon, { subtotal, shipPrice });
  if (result.error) return res.status(400).json({ error: result.error });
  coupon.usedCount = (Number(coupon.usedCount) || 0) + 1;
  saveDb(db);
  res.json({ ok: true });
});

/* ---------- clientes da loja ---------- */

const CUSTOMER_PIN_MIN = 4;
const CUSTOMER_PIN_MAX = 6;

function normalizePhone(raw) {
  return String(raw || "").replace(/\D/g, "").slice(0, 15);
}

function generateReferralCode(name, db) {
  const base = str(name, 20)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .slice(0, 4)
    .toUpperCase() || "GS";
  for (let i = 0; i < 30; i++) {
    const code = `${base}${crypto.randomBytes(2).toString("hex").toUpperCase().slice(0, 3)}`;
    if (!(db.customers || []).some((c) => c.referralCode === code)) return code;
  }
  return uid("ref").slice(-6).toUpperCase();
}

function customerPublic(c) {
  return {
    id: c.id,
    phone: c.phone,
    name: c.name || "",
    address: c.address || "",
    referralCode: c.referralCode || "",
    cashbackBalance: Math.max(0, Number(c.cashbackBalance) || 0),
    ordersCount: Number(c.ordersCount) || 0,
  };
}

function requireCustomer(req, res, next) {
  if (!req.session.customer) return res.status(401).json({ error: "Entre na sua conta para continuar." });
  next();
}

app.get("/api/public/customer/me", publicLimiter, (req, res) => {
  if (!req.session.customer) return res.json({ customer: null });
  const db = getDb();
  const c = db.customers.find((x) => x.id === req.session.customer.id);
  if (!c) {
    delete req.session.customer;
    return res.json({ customer: null });
  }
  res.json({ customer: customerPublic(c) });
});

app.post("/api/public/customer/register", loginLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const pin = String(req.body && req.body.pin || "");
    const name = str(req.body && req.body.name, 80);
    const address = str(req.body && req.body.address, 200);
    const referralCode = str(req.body && req.body.referralCode, 20).toUpperCase();

    if (phone.length < 10) return res.status(400).json({ error: "WhatsApp inválido. Use DDD + número." });
    if (pin.length < CUSTOMER_PIN_MIN || pin.length > CUSTOMER_PIN_MAX || !/^\d+$/.test(pin)) {
      return res.status(400).json({ error: `Crie um PIN de ${CUSTOMER_PIN_MIN} a ${CUSTOMER_PIN_MAX} dígitos.` });
    }
    if (!name) return res.status(400).json({ error: "Escreva seu nome." });

    const db = getDb();
    if (db.customers.some((c) => c.phone === phone)) {
      return res.status(409).json({ error: "Esse WhatsApp já tem conta. Faça login." });
    }

    const refSettings = db.settings.referral || {};
    let referredBy = null;
    if (referralCode && refSettings.enabled !== false) {
      const referrer = db.customers.find((c) => c.referralCode === referralCode);
      if (referrer) referredBy = referrer.id;
    }

    const pass = await hashPassword(pin);
    const customer = {
      id: uid("cust"),
      phone,
      name,
      address,
      ...pass,
      referralCode: generateReferralCode(name, db),
      referredBy,
      cashbackBalance: 0,
      ordersCount: 0,
      createdAt: new Date().toISOString(),
    };

    if (referredBy && refSettings.enabled !== false) {
      const referrer = db.customers.find((c) => c.id === referredBy);
      const refBonus = Math.max(0, Number(refSettings.referrerBonus) || 0);
      const newBonus = Math.max(0, Number(refSettings.referredBonus) || 0);
      if (referrer && refBonus > 0) referrer.cashbackBalance = (Number(referrer.cashbackBalance) || 0) + refBonus;
      if (newBonus > 0) customer.cashbackBalance = newBonus;
    }

    db.customers.push(customer);
    saveDb(db);

    const unknownReferral = !!(referralCode && !referredBy);

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.customer = { id: customer.id, phone: customer.phone };
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.json({ customer: customerPublic(customer), unknownReferral, csrf: csrfToken(req) });
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/public/customer/login", loginLimiter, async (req, res, next) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const pin = String(req.body && req.body.pin || "");
    if (phone.length < 10 || !pin) return res.status(400).json({ error: "WhatsApp e PIN são obrigatórios." });

    const db = getDb();
    const customer = db.customers.find((c) => c.phone === phone);
    const ok = customer ? await verifyPassword(pin, customer) : false;
    if (!ok) return res.status(401).json({ error: "WhatsApp ou PIN incorretos." });

    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.customer = { id: customer.id, phone: customer.phone };
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.json({ customer: customerPublic(customer), csrf: csrfToken(req) });
      });
    });
  } catch (err) {
    next(err);
  }
});

app.post("/api/public/customer/logout", publicLimiter, (req, res) => {
  delete req.session.customer;
  req.session.save(() => res.json({ ok: true }));
});

app.put("/api/public/customer/profile", publicLimiter, requireCustomer, (req, res) => {
  const db = getDb();
  const customer = db.customers.find((c) => c.id === req.session.customer.id);
  if (!customer) {
    delete req.session.customer;
    return res.status(401).json({ error: "Conta não encontrada." });
  }
  if (req.body.name != null) customer.name = str(req.body.name, 80);
  if (req.body.address != null) customer.address = str(req.body.address, 200);
  saveDb(db);
  res.json({ customer: customerPublic(customer) });
});

app.post("/api/public/customer/checkout", publicLimiter, requireCustomer, (req, res) => {
  const db = getDb();
  const customer = db.customers.find((c) => c.id === req.session.customer.id);
  if (!customer) {
    delete req.session.customer;
    return res.status(401).json({ error: "Conta não encontrada." });
  }

  const subtotal = Math.max(0, Number(req.body && req.body.subtotal) || 0);
  const shipPrice = Math.max(0, Number(req.body && req.body.shipPrice) || 0);
  const cashbackUse = Math.max(0, Number(req.body && req.body.cashbackUse) || 0);
  const couponCode = normalizeCouponCode(req.body && req.body.couponCode);
  const refSettings = db.settings.referral || {};

  let couponDiscount = 0;
  let freeShipping = false;
  let gift = null;
  let coupon = null;

  if (couponCode) {
    coupon = findCouponByCode(db, couponCode);
    if (!coupon) return res.status(404).json({ error: "Cupom não encontrado." });
    const evalResult = evaluateCoupon(coupon, { subtotal, shipPrice });
    if (evalResult.error) return res.status(400).json({ error: evalResult.error });
    couponDiscount = evalResult.discount || 0;
    freeShipping = !!evalResult.freeShipping;
    gift = evalResult.gift || null;
  }

  const effectiveShip = freeShipping ? 0 : shipPrice;
  const afterCoupon = Math.max(0, subtotal - couponDiscount) + effectiveShip;
  const maxCashback = Math.min(Number(customer.cashbackBalance) || 0, afterCoupon);
  const appliedCashback = Math.min(cashbackUse, maxCashback);
  const total = Math.max(0, afterCoupon - appliedCashback);

  customer.cashbackBalance = Math.max(0, (Number(customer.cashbackBalance) || 0) - appliedCashback);
  const earnPct = Math.min(50, Math.max(0, Number(refSettings.orderCashbackPercent) || 0));
  const earned = earnPct > 0 ? Math.round(subtotal * earnPct) / 100 : 0;
  if (earned > 0) customer.cashbackBalance += earned;
  customer.ordersCount = (Number(customer.ordersCount) || 0) + 1;

  if (coupon) {
    coupon.usedCount = (Number(coupon.usedCount) || 0) + 1;
  }

  saveDb(db);
  res.json({
    ok: true,
    total,
    couponDiscount,
    freeShipping,
    gift,
    cashbackUsed: appliedCashback,
    cashbackEarned: earned,
    cashbackBalance: customer.cashbackBalance,
    customer: customerPublic(customer),
  });
});

/** Itens do pedido: valida e corta tamanho antes de guardar. */
function sanitizeOrderItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, 80)
    .map((it) => ({
      name: str(it && it.name, 120),
      qty: Math.max(1, Math.min(999, Math.round(Number(it && it.qty)) || 1)),
      option: str(it && it.option, 80),
      price: Math.max(0, Number(it && it.price) || 0),
    }))
    .filter((it) => it.name);
}

/**
 * Avisa o painel de um novo pedido. O cliente chama isso pelo site logo antes
 * de abrir o WhatsApp — funciona tanto para quem tem conta quanto para convidado.
 * Não bloqueia o checkout: se isso falhar o pedido ainda vai pro WhatsApp normalmente.
 */
app.post("/api/public/order/notify", publicLimiter, (req, res) => {
  const b = req.body || {};
  const items = sanitizeOrderItems(b.items);
  if (!items.length) return res.status(400).json({ error: "Pedido sem itens." });

  const name = str(b.name, 80) || "Cliente";
  const phone = str(b.phone, 20);
  const address = str(b.address, 200);
  const city = str(b.city, 60);
  const payment = str(b.payment, 40);
  const note = str(b.note, 300);
  const couponCode = str(b.couponCode, 30);
  const subtotal = Math.max(0, Number(b.subtotal) || 0);
  const total = Math.max(0, Number(b.total) || 0);
  const cashbackUsed = Math.max(0, Number(b.cashbackUsed) || 0);

  const itemsSummary = items.map((it) => `${it.qty}x ${it.name}${it.option ? ` (${it.option})` : ""}`).join(", ");

  logAction(req, "order.placed", {
    actor: { id: req.session.customer ? req.session.customer.id : null, name, role: "cliente" },
    targetType: "order",
    targetName: name,
    detail: itemsSummary,
    meta: { phone, address, city, payment, note, couponCode, subtotal, total, cashbackUsed, items },
  });

  res.json({ ok: true });
});

/** Pedidos recentes para o sininho do painel (qualquer usuário logado, não só admin). */
app.get("/api/orders/notifications", requireAuth, (_req, res) => {
  const orders = readAudit()
    .filter((e) => e.action === "order.placed")
    .slice(0, 100);
  res.json({ orders });
});

app.get("/api/settings", requireAdmin, (_req, res) => {
  const db = getDb();
  res.json({
    settings: db.settings,
    categories: db.categories,
    customersCount: (db.customers || []).length,
  });
});

app.get("/api/customers", requireAdmin, (_req, res) => {
  const db = getDb();
  res.json({
    customers: (db.customers || []).map((c) => ({
      ...customerPublic(c),
      referredBy: c.referredBy || null,
      createdAt: c.createdAt || "",
    })),
  });
});

/* =========================================================================
   AUTENTICAÇÃO
   ========================================================================= */

app.get("/api/csrf", (req, res) => {
  res.json({ csrf: csrfToken(req) });
});

function sessionUserOf(user) {
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role === "admin" ? "admin" : "editor",
    mustChangePassword: !!user.mustChangePassword,
    needs2faSetup: needsTwoFactorSetup(user),
  };
}

/** Cria a sessão definitiva (sempre com sessão nova, contra fixação de sessão). */
function startSession(req, res, next, user, detail) {
  const sessionUser = sessionUserOf(user);
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = sessionUser;
    req.session.createdAt = Date.now();
    req.session.lastSeen = Date.now();
    req.session.uaHash = uaHash(req);
    const token = csrfToken(req);
    req.session.save((err2) => {
      if (err2) return next(err2);
      logAction(req, "auth.login", { detail: detail || "" });
      res.json({
        user: sessionUser,
        csrf: token,
        stage: sessionUser.mustChangePassword ? "password" : sessionUser.needs2faSetup ? "setup2fa" : "ready",
        mustChangePassword: sessionUser.mustChangePassword,
        needs2faSetup: sessionUser.needs2faSetup,
        recoveryLeft: recoveryLeft(user),
      });
    });
  });
}

/* Etapa 1: usuário e senha */
app.post("/api/login", loginLimiter, async (req, res, next) => {
  try {
    const username = str(req.body.username, 60).toLowerCase();
    const password = String(req.body.password || "");
    const genericError = "Usuário ou senha incorretos.";

    if (!username || !password) return res.status(400).json({ error: genericError });

    const locked = lockState(username);
    if (locked) {
      const mins = Math.ceil((locked.until - Date.now()) / 60000);
      debugLogin("D", "server.js:login", "conta bloqueada", { mins, usernameLen: username.length });
      logAction(req, "auth.locked", { actor: { id: null, name: username, role: "guest" }, detail: `bloqueado por ${mins} min` });
      return res.status(429).json({ error: `Conta bloqueada por ${mins} minuto(s) após várias tentativas.` });
    }

    const db = getDb();
    const user = db.users.find((u) => String(u.username).toLowerCase() === username);
    debugLogin("B", "server.js:login", "lookup do usuário", {
      userFound: Boolean(user),
      userCount: (db.users || []).length,
      usernames: (db.users || []).map((u) => String(u.username || "")),
      passwordLen: password.length,
      dbPath: DB_PATH,
      locked: Boolean(locked),
    });
    let ok = false;
    try {
      ok = user ? await verifyPassword(password, user) : false;
    } catch (err) {
      debugLogin("E", "server.js:login", "scrypt falhou", { err: String(err && err.message ? err.message : err) });
      console.error("[login] falha ao validar senha:", err && err.message ? err.message : err);
      return res.status(500).json({ error: "Falha ao validar senha. Tente de novo." });
    }
    debugLogin("C", "server.js:login", "resultado da senha", {
      ok,
      userFound: Boolean(user),
      mustChange: Boolean(user && user.mustChangePassword),
      hasSalt: Boolean(user && user.salt),
      hasHash: Boolean(user && user.hash),
      ready: hasAdminReady(),
      dbPath: DB_PATH,
    });

    if (!ok) {
      const rec = registerFail(username);
      logAction(req, "auth.login_failed", {
        actor: { id: user ? user.id : null, name: username, role: "guest" },
        detail: `tentativa ${rec.count}${rec.until ? " — conta bloqueada" : ""}`,
      });
      return res.status(401).json({ error: genericError });
    }

    loginFails.delete(username);

    // Atualiza o hash para os parâmetros atuais quando o cadastro é antigo
    if (!user.kdf || user.kdf.N !== KDF.N) {
      Object.assign(user, await hashPassword(password));
      saveDb(db);
    }

    // Senha padrão pendente ou 2FA ainda não configurado: entra em modo restrito
    if (DISABLE_2FA || user.mustChangePassword || !(user.totp && user.totp.confirmedAt)) {
      const detail = user.mustChangePassword
        ? "senha precisa ser trocada"
        : DISABLE_2FA
          ? "2FA temporariamente desativado"
          : "2FA precisa ser configurado";
      return startSession(req, res, next, user, detail);
    }

    // 2FA ativo: a sessão só nasce depois do código
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.pending = { userId: user.id, at: Date.now(), tries: 0 };
      req.session.uaHash = uaHash(req);
      const token = csrfToken(req);
      req.session.save((err2) => {
        if (err2) return next(err2);
        res.json({ stage: "totp", csrf: token, name: user.name || user.username });
      });
    });
  } catch (err) {
    next(err);
  }
});

/* Etapa 2: código do aplicativo (ou código de recuperação) */
app.post("/api/login/totp", loginLimiter, async (req, res, next) => {
  try {
    const pending = req.session.pending;
    if (!pending || Date.now() - pending.at > 5 * 60 * 1000) {
      delete req.session.pending;
      return res.status(440).json({ error: "O tempo para digitar o código acabou. Entre de novo.", restart: true });
    }
    if (pending.tries >= 6) {
      delete req.session.pending;
      logAction(req, "2fa.failed", { detail: "excesso de tentativas — voltou para o login" });
      return res.status(429).json({ error: "Muitas tentativas. Faça o login de novo.", restart: true });
    }

    const db = getDb();
    const user = db.users.find((u) => u.id === pending.userId);
    if (!user || !user.totp || !user.totp.confirmedAt) {
      delete req.session.pending;
      return res.status(440).json({ error: "Sessão inválida. Entre de novo.", restart: true });
    }

    const raw = String(req.body.code || "").trim();
    const asTotp = raw.replace(/\D/g, "");

    // Código de 6 dígitos = app; qualquer outro formato = tentativa de recuperação
    if (asTotp.length === 6) {
      const step = verifyTotp(user.totp.secret, asTotp, user.totp.lastStep);
      if (step == null) {
        pending.tries += 1;
        registerFail(String(user.username).toLowerCase());
        logAction(req, "2fa.failed", {
          actor: { id: user.id, name: user.name || user.username, role: user.role },
          detail: `tentativa ${pending.tries}`,
        });
        return res.status(401).json({ error: "Código inválido. Confira no aplicativo e tente de novo." });
      }
      user.totp.lastStep = step;
      saveDb(db);
      loginFails.delete(String(user.username).toLowerCase());
      return startSession(req, res, next, user, "código do aplicativo");
    }

    if (useRecoveryCode(user, raw)) {
      saveDb(db);
      const left = recoveryLeft(user);
      logAction(req, "2fa.recovery_used", {
        actor: { id: user.id, name: user.name || user.username, role: user.role },
        detail: `restam ${left} código(s)`,
        severity: "alert",
      });
      return startSession(req, res, next, user, `código de recuperação (restam ${left})`);
    }

    pending.tries += 1;
    logAction(req, "2fa.failed", {
      actor: { id: user.id, name: user.name || user.username, role: user.role },
      detail: `código de recuperação inválido (tentativa ${pending.tries})`,
    });
    res.status(401).json({ error: "Código inválido. Confira no aplicativo e tente de novo." });
  } catch (err) {
    next(err);
  }
});

app.post("/api/logout", (req, res) => {
  if (req.session.user) logAction(req, "auth.logout");
  req.session.destroy(() => {
    res.clearCookie("gs.sid", { path: "/" });
    res.json({ ok: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    if (req.session.pending) return res.status(401).json({ error: "Falta o código de verificação.", stage: "totp", csrf: csrfToken(req) });
    return res.status(401).json({ error: "Não logado." });
  }
  const me = (getDb().users || []).find((u) => u.id === req.session.user.id);
  const user = {
    ...req.session.user,
    needs2faSetup: DISABLE_2FA ? false : !!req.session.user.needs2faSetup,
  };
  res.json({
    user,
    csrf: csrfToken(req),
    stage: user.mustChangePassword ? "password" : user.needs2faSetup ? "setup2fa" : "ready",
    mustChangePassword: !!req.session.user.mustChangePassword,
    needs2faSetup: !!user.needs2faSetup,
    recoveryLeft: me ? recoveryLeft(me) : 0,
  });
});

/* =========================================================================
   2FA — configuração e recuperação
   ========================================================================= */

function currentUser(req) {
  const db = getDb();
  return { db, user: (db.users || []).find((u) => u.id === req.session.user.id) };
}

app.get("/api/2fa/status", requireAuth, (req, res) => {
  const { user } = currentUser(req);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  res.json({
    enabled: !!(user.totp && user.totp.confirmedAt),
    confirmedAt: user.totp ? user.totp.confirmedAt || null : null,
    recoveryLeft: recoveryLeft(user),
    recoveryTotal: (user.recoveryCodes || []).length,
  });
});

/** Gera um segredo provisório e o QR Code. Só vira definitivo depois do /activate. */
app.post("/api/2fa/setup", requireAuth, async (req, res, next) => {
  try {
    const { db, user } = currentUser(req);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    if (user.totp && user.totp.confirmedAt) {
      return res.status(409).json({ error: "A verificação em duas etapas já está ativa nesta conta." });
    }
    const secret = newTotpSecret();
    user.totpPending = { secret, createdAt: new Date().toISOString() };
    saveDb(db);
    const uri = otpauthUri(secret, user.username, db.settings && db.settings.name);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 320, color: { dark: "#101014", light: "#ffffff" } });
    logAction(req, "2fa.setup_started", {});
    res.json({ secret, uri, qr });
  } catch (err) {
    next(err);
  }
});

/** Confirma o código do app, liga o 2FA e devolve os códigos de recuperação (única vez). */
app.post("/api/2fa/activate", requireAuth, (req, res) => {
  const { db, user } = currentUser(req);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  if (user.totp && user.totp.confirmedAt) return res.status(409).json({ error: "A verificação em duas etapas já está ativa." });
  if (!user.totpPending || !user.totpPending.secret) {
    return res.status(400).json({ error: "Gere o QR Code antes de confirmar." });
  }
  const step = verifyTotp(user.totpPending.secret, req.body.code, null);
  if (step == null) {
    logAction(req, "2fa.failed", { detail: "código errado na ativação" });
    return res.status(400).json({ error: "Código inválido. Confira a hora do celular e tente de novo." });
  }
  const { plain, stored } = makeRecoveryCodes();
  user.totp = { secret: user.totpPending.secret, confirmedAt: new Date().toISOString(), lastStep: step };
  user.recoveryCodes = stored;
  delete user.totpPending;
  saveDb(db);
  req.session.user = { ...req.session.user, needs2faSetup: false };
  logAction(req, "2fa.enabled", { severity: "alert" });
  res.json({ ok: true, recoveryCodes: plain, user: req.session.user });
});

/** Gera novos códigos de recuperação (pede a senha atual). */
app.post("/api/2fa/recovery-codes", requireAuth, async (req, res, next) => {
  try {
    const { db, user } = currentUser(req);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
    if (!(user.totp && user.totp.confirmedAt)) return res.status(400).json({ error: "Ative a verificação em duas etapas primeiro." });
    if (!(await verifyPassword(String(req.body.password || ""), user))) {
      logAction(req, "auth.login_failed", { detail: "senha errada ao gerar códigos de recuperação", severity: "alert" });
      return res.status(403).json({ error: "Senha atual incorreta." });
    }
    const { plain, stored } = makeRecoveryCodes();
    user.recoveryCodes = stored;
    saveDb(db);
    logAction(req, "2fa.recovery_regenerated", { severity: "alert" });
    res.json({ recoveryCodes: plain });
  } catch (err) {
    next(err);
  }
});

/** Administrador zera o 2FA de outra pessoa (ela configura de novo no próximo login). */
app.delete("/api/2fa/:userId", requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const me = db.users.find((u) => u.id === req.session.user.id);
    const target = db.users.find((u) => u.id === str(req.params.userId, 60));
    if (!target) return res.status(404).json({ error: "Usuário não encontrado." });
    if (!me || !(await verifyPassword(String(req.body.password || ""), me))) {
      logAction(req, "auth.login_failed", { detail: "senha errada ao zerar 2FA de outro usuário", severity: "alert" });
      return res.status(403).json({ error: "Senha atual incorreta." });
    }
    delete target.totp;
    delete target.totpPending;
    target.recoveryCodes = [];
    saveDb(db);
    logAction(req, "2fa.reset", {
      targetType: "user",
      targetId: target.id,
      targetName: target.name || target.username,
      severity: "alert",
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* =========================================================================
   PRODUTOS
   ========================================================================= */

const PRODUCT_LIMITS = { name: 120, description: 6000, category: 60, optionGroup: 60, optionTitle: 80 };

function findProduct(db, id) {
  return db.products.find((p) => p.id === id);
}

function parseOptionPayload(body, existing) {
  const optionGroup =
    body.optionGroup != null ? str(body.optionGroup, PRODUCT_LIMITS.optionGroup) : existing ? existing.optionGroup || "" : "";
  if (body.options == null) return { optionGroup, options: existing ? existing.options || [] : [] };

  let raw = body.options;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { optionGroup, options: [] };
    try {
      raw = JSON.parse(trimmed);
    } catch {
      raw = trimmed.split(/\r?\n/);
    }
  }
  if (!Array.isArray(raw)) raw = [];

  const prev = (existing && existing.options) || [];
  const usedIds = new Set();
  const seenTitles = new Set();
  const options = [];
  for (const item of raw.slice(0, 200)) {
    const title = str(typeof item === "string" ? item : item && item.title, PRODUCT_LIMITS.optionTitle);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    const match = prev.find((o) => o.title === title);
    let id = match && !usedIds.has(match.id) ? match.id : uid("opt");
    usedIds.add(id);
    options.push({
      id,
      title,
      image: match ? match.image || "" : "",
      available: match ? match.available !== false : true,
    });
  }
  return { optionGroup, options };
}

function readProductBody(body, existing) {
  const out = {};
  const errors = [];

  if (body.name != null || !existing) {
    const name = str(body.name, PRODUCT_LIMITS.name);
    if (!name) errors.push("Informe o nome do produto.");
    out.name = name;
  }
  if (body.description != null || !existing) out.description = str(body.description, PRODUCT_LIMITS.description);
  if (body.category != null || !existing) out.category = str(body.category, PRODUCT_LIMITS.category) || "Outros";
  if (body.cities != null || !existing) {
    const names = shippingCities(getDb().settings);
    let cities = normalizeCities(body.cities, names);
    if (!cities.length && existing) cities = inferProductCities({ ...existing, cities: body.cities }, names);
    if (!cities.length) errors.push("Escolha ao menos uma cidade.");
    else out.cities = cities;
  }

  if (body.price != null || !existing) {
    const price = optNum(body.price, { min: 0, max: 1e7 });
    if (price === INVALID) errors.push("Preço inválido.");
    else out.price = price == null ? 0 : price;
  }
  if (body.promoPrice !== undefined) {
    const promo = optNum(body.promoPrice, { min: 0, max: 1e7 });
    if (promo === INVALID) errors.push("Preço promocional inválido.");
    else out.promoPrice = promo;
  }
  if (body.cost !== undefined) {
    const cost = optNum(body.cost, { min: 0, max: 1e7 });
    if (cost === INVALID) errors.push("Custo inválido.");
    else out.cost = cost;
  }
  if (body.stock !== undefined) {
    const stock = optInt(body.stock, { min: 0, max: 1e6 });
    if (stock === INVALID) errors.push("Estoque inválido (use um número inteiro).");
    else out.stock = stock;
  }
  if (body.stockActive !== undefined) out.stockActive = bool(body.stockActive);
  if (body.pin !== undefined) out.pin = bool(body.pin);
  if (body.active !== undefined) out.active = bool(body.active, true);

  return { data: out, errors };
}

app.get("/api/products", requireAuth, (_req, res) => {
  const db = getDb();
  res.json({ products: db.products, categories: db.categories, cities: shippingCities(db.settings) });
});

app.post("/api/products", requireAuth, uploadLimiter, upload.single("image"), (req, res) => {
  const uploadError = checkUpload(req);
  if (uploadError) return res.status(400).json({ error: uploadError });

  const { data, errors } = readProductBody(req.body || {}, null);
  if (errors.length) {
    dropUpload(req);
    return res.status(400).json({ error: errors[0] });
  }

  const db = getDb();
  const product = {
    id: uid("p"),
    name: data.name,
    description: data.description,
    price: data.price || 0,
    promoPrice: data.promoPrice ?? null,
    category: data.category,
    image: req.file ? uploadedUrl(req) : "",
    stock: data.stock ?? null,
    stockActive: !!data.stockActive,
    cost: data.cost ?? null,
    pin: !!data.pin,
    active: data.active !== false,
    cities: data.cities && data.cities.length ? data.cities : inferProductCities({ category: data.category }, shippingCities(db.settings)),
    createdAt: new Date().toISOString(),
    ...parseOptionPayload(req.body || {}, null),
  };
  if (product.category && !db.categories.includes(product.category)) db.categories.push(product.category);
  db.products.unshift(product);
  saveDb(db);
  logAction(req, "product.create", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: `${product.category} · ${product.price} · ${product.options.length} sabor(es)`,
  });
  res.json({ product });
});

app.put("/api/products/:id", requireAuth, uploadLimiter, upload.single("image"), (req, res) => {
  const uploadError = checkUpload(req);
  if (uploadError) return res.status(400).json({ error: uploadError });

  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) {
    dropUpload(req);
    return res.status(404).json({ error: "Produto não encontrado." });
  }

  const body = req.body || {};
  const { data, errors } = readProductBody(body, product);
  if (errors.length) {
    dropUpload(req);
    return res.status(400).json({ error: errors[0] });
  }

  const before = JSON.parse(JSON.stringify(product));
  Object.assign(product, data);
  if (product.category && !db.categories.includes(product.category)) db.categories.push(product.category);

  const oldImage = product.image;
  if (req.file) product.image = uploadedUrl(req);

  if (body.optionGroup !== undefined || body.options !== undefined) {
    const parsed = parseOptionPayload(body, before);
    product.optionGroup = parsed.optionGroup;
    if (body.options !== undefined) {
      // Fotos de sabores que saíram da lista podem ser apagadas
      const keep = new Set(parsed.options.map((o) => o.image).filter(Boolean));
      product.options = parsed.options;
      for (const o of before.options || []) if (o.image && !keep.has(o.image)) removeUnusedUpload(db, o.image);
    }
  }

  saveDb(db);
  if (req.file && oldImage && oldImage !== product.image) removeUnusedUpload(db, oldImage);

  const changes = diffFields(before, product, [
    "name", "price", "promoPrice", "cost", "category", "cities", "description", "stock", "stockActive", "pin", "active", "image", "optionGroup",
  ]);
  logAction(req, "product.update", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: changes.map((c) => c.field).join(", ") || "sem mudanças",
    changes,
  });
  res.json({ product });
});

app.delete("/api/products/:id", requireAuth, (req, res) => {
  const db = getDb();
  const id = str(req.params.id, 60);
  const product = findProduct(db, id);
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  db.products = db.products.filter((p) => p.id !== id);
  saveDb(db);
  removeUnusedUpload(db, product.image);
  for (const o of product.options || []) removeUnusedUpload(db, o.image);
  logAction(req, "product.delete", {
    targetType: "product",
    targetId: id,
    targetName: product.name,
    detail: `${product.category || "sem categoria"} · ${product.price}`,
  });
  res.json({ ok: true });
});

app.post("/api/products/:id/duplicate", requireAuth, (req, res) => {
  const db = getDb();
  const source = findProduct(db, str(req.params.id, 60));
  if (!source) return res.status(404).json({ error: "Produto não encontrado." });
  const copy = {
    ...JSON.parse(JSON.stringify(source)),
    id: uid("p"),
    name: `${source.name} (cópia)`.slice(0, PRODUCT_LIMITS.name),
    createdAt: new Date().toISOString(),
    active: false,
  };
  copy.options = (copy.options || []).map((o) => ({ ...o, id: uid("opt") }));
  db.products.unshift(copy);
  saveDb(db);
  logAction(req, "product.duplicate", {
    targetType: "product",
    targetId: copy.id,
    targetName: copy.name,
    detail: `copiado de ${source.name}`,
  });
  res.json({ product: copy });
});

app.patch("/api/products/:id/quick", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  const b = req.body || {};
  const before = { ...product };

  if (b.active !== undefined) product.active = bool(b.active);
  if (b.pin !== undefined) product.pin = bool(b.pin);
  if (b.stockActive !== undefined) product.stockActive = bool(b.stockActive);
  if (b.stock !== undefined) {
    const stock = optInt(b.stock, { min: 0, max: 1e6 });
    if (stock === INVALID) return res.status(400).json({ error: "Estoque inválido." });
    product.stock = stock;
  }
  if (b.cost !== undefined) {
    const cost = optNum(b.cost, { min: 0, max: 1e7 });
    if (cost === INVALID) return res.status(400).json({ error: "Custo inválido." });
    product.cost = cost;
  }

  saveDb(db);
  const changes = diffFields(before, product, ["active", "pin", "stockActive", "stock", "cost"]);
  logAction(req, "product.quick", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(" · "),
    changes,
  });
  res.json({ product });
});

/* =========================================================================
   SABORES (opções do produto) — cada um com foto própria
   ========================================================================= */

function findOption(product, optId) {
  return (product.options || []).find((o) => o.id === optId);
}

function optionsPayload(product) {
  return { optionGroup: product.optionGroup || "", options: product.options || [] };
}

app.get("/api/products/:id/options", requireAuth, (req, res) => {
  const product = findProduct(getDb(), str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  res.json(optionsPayload(product));
});

app.post("/api/products/:id/options", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });

  const titles = Array.isArray(req.body.titles) ? req.body.titles : [req.body.title];
  const clean = [];
  for (const t of titles.slice(0, 100)) {
    const title = str(t, PRODUCT_LIMITS.optionTitle);
    if (!title) continue;
    if (clean.some((c) => c.toLowerCase() === title.toLowerCase())) continue;
    if ((product.options || []).some((o) => o.title.toLowerCase() === title.toLowerCase())) continue;
    clean.push(title);
  }
  if (!clean.length) return res.status(400).json({ error: "Informe o nome do sabor (e sem repetir os que já existem)." });
  if ((product.options || []).length + clean.length > 200) return res.status(400).json({ error: "Limite de 200 sabores por produto." });

  if (!Array.isArray(product.options)) product.options = [];
  const created = clean.map((title) => ({ id: uid("opt"), title, image: "", available: true }));
  product.options.push(...created);
  if (!product.optionGroup && req.body.optionGroup) product.optionGroup = str(req.body.optionGroup, PRODUCT_LIMITS.optionGroup);
  saveDb(db);
  logAction(req, "option.create", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: `+${created.length}: ${created.map((o) => o.title).join(", ")}`,
  });
  res.json({ ...optionsPayload(product), created });
});

app.patch("/api/products/:id/options/:optId", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  const option = findOption(product, str(req.params.optId, 60));
  if (!option) return res.status(404).json({ error: "Sabor não encontrado." });

  const before = { ...option };
  if (req.body.title !== undefined) {
    const title = str(req.body.title, PRODUCT_LIMITS.optionTitle);
    if (!title) return res.status(400).json({ error: "O sabor precisa de um nome." });
    const dup = product.options.some((o) => o.id !== option.id && o.title.toLowerCase() === title.toLowerCase());
    if (dup) return res.status(400).json({ error: "Já existe um sabor com esse nome." });
    option.title = title;
  }
  if (req.body.available !== undefined) option.available = bool(req.body.available, true);

  saveDb(db);
  const changes = diffFields(before, option, ["title", "available"]);
  logAction(req, "option.update", {
    targetType: "option",
    targetId: option.id,
    targetName: `${product.name} › ${option.title}`,
    detail: changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join(" · "),
    changes,
  });
  res.json({ ...optionsPayload(product), option });
});

app.delete("/api/products/:id/options/:optId", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  const option = findOption(product, str(req.params.optId, 60));
  if (!option) return res.status(404).json({ error: "Sabor não encontrado." });

  product.options = product.options.filter((o) => o.id !== option.id);
  saveDb(db);
  removeUnusedUpload(db, option.image);
  logAction(req, "option.delete", {
    targetType: "option",
    targetId: option.id,
    targetName: `${product.name} › ${option.title}`,
  });
  res.json(optionsPayload(product));
});

app.put("/api/products/:id/options/order", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map((x) => str(x, 60)) : [];
  const current = product.options || [];
  const ordered = [];
  for (const id of ids) {
    const found = current.find((o) => o.id === id);
    if (found && !ordered.includes(found)) ordered.push(found);
  }
  for (const o of current) if (!ordered.includes(o)) ordered.push(o);
  product.options = ordered;
  saveDb(db);
  logAction(req, "option.reorder", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: `${ordered.length} sabores`,
  });
  res.json(optionsPayload(product));
});

app.post(
  "/api/products/:id/options/:optId/image",
  requireAuth,
  uploadLimiter,
  upload.single("image"),
  (req, res) => {
    const uploadError = checkUpload(req);
    if (uploadError) return res.status(400).json({ error: uploadError });
    if (!req.file) return res.status(400).json({ error: "Envie uma imagem." });

    const db = getDb();
    const product = findProduct(db, str(req.params.id, 60));
    const option = product ? findOption(product, str(req.params.optId, 60)) : null;
    if (!product || !option) {
      dropUpload(req);
      return res.status(404).json({ error: "Sabor não encontrado." });
    }

    const oldImage = option.image;
    option.image = uploadedUrl(req);
    saveDb(db);
    if (oldImage && oldImage !== option.image) removeUnusedUpload(db, oldImage);
    logAction(req, "option.image", {
      targetType: "option",
      targetId: option.id,
      targetName: `${product.name} › ${option.title}`,
      detail: option.image,
    });
    res.json({ ...optionsPayload(product), option });
  }
);

app.delete("/api/products/:id/options/:optId/image", requireAuth, (req, res) => {
  const db = getDb();
  const product = findProduct(db, str(req.params.id, 60));
  const option = product ? findOption(product, str(req.params.optId, 60)) : null;
  if (!product || !option) return res.status(404).json({ error: "Sabor não encontrado." });
  const old = option.image;
  option.image = "";
  saveDb(db);
  removeUnusedUpload(db, old);
  logAction(req, "option.image_delete", {
    targetType: "option",
    targetId: option.id,
    targetName: `${product.name} › ${option.title}`,
  });
  res.json({ ...optionsPayload(product), option });
});

/* =========================================================================
   ESTOQUE / MOVIMENTAÇÕES
   ========================================================================= */

function sellPrice(p) {
  if (p.promoPrice != null && Number(p.promoPrice) < Number(p.price)) return Number(p.promoPrice) || 0;
  return Number(p.price) || 0;
}

app.get("/api/ledger", requireAuth, (_req, res) => {
  res.json({ ledger: getDb().ledger });
});

app.post("/api/stock/move", requireAuth, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const type = str(b.type, 10);
  if (!["in", "sale", "adjust"].includes(type)) return res.status(400).json({ error: "Tipo inválido." });
  const qty = optInt(b.qty, { min: 1, max: 100000 });
  if (qty === INVALID || !qty) return res.status(400).json({ error: "Informe a quantidade." });

  const product = findProduct(db, str(b.productId, 60));
  if (!product) return res.status(404).json({ error: "Produto não encontrado." });

  const current = product.stock == null ? 0 : Number(product.stock) || 0;
  if (type === "in") {
    product.stock = current + qty;
    product.stockActive = true;
  } else if (type === "sale") {
    if (product.stockActive && current < qty) return res.status(400).json({ error: `Estoque insuficiente (${current} un.).` });
    if (product.stockActive || product.stock != null) {
      product.stock = Math.max(0, current - qty);
      product.stockActive = true;
    }
  } else {
    product.stock = Math.max(0, current - qty);
    product.stockActive = true;
  }

  const unitPrice = sellPrice(product);
  const unitCost = product.cost == null || product.cost === "" ? null : Number(product.cost);
  const cityNames = shippingCities(db.settings);
  const cities = inferProductCities(product, cityNames);
  const entry = {
    id: uid("l"),
    type,
    productId: product.id,
    productName: product.name,
    category: product.category || "",
    city: cities[0] || "",
    cities,
    qty,
    price: type === "sale" ? unitPrice : 0,
    cost: type === "sale" ? unitCost : null,
    createdAt: new Date().toISOString(),
    userName: req.session.user.name || req.session.user.username,
  };
  db.ledger.unshift(entry);
  saveDb(db);
  logAction(req, "stock.move", {
    targetType: "product",
    targetId: product.id,
    targetName: product.name,
    detail: `${type} ${qty} un. · estoque agora ${product.stock}`,
  });
  res.json({ product, entry, ledger: db.ledger });
});

app.delete("/api/ledger/:id", requireAuth, (req, res) => {
  const db = getDb();
  const id = str(req.params.id, 60);
  const idx = db.ledger.findIndex((x) => x.id === id);
  if (idx < 0) return res.status(404).json({ error: "Registro não encontrado." });
  const entry = db.ledger[idx];
  const product = findProduct(db, entry.productId);
  if (product) {
    const current = product.stock == null ? 0 : Number(product.stock) || 0;
    if (entry.type === "in") product.stock = Math.max(0, current - (entry.qty || 0));
    else if (product.stockActive || product.stock != null) {
      product.stock = current + (entry.qty || 0);
      product.stockActive = true;
    }
  }
  db.ledger.splice(idx, 1);
  saveDb(db);
  logAction(req, "stock.undo", {
    targetType: "product",
    targetId: entry.productId,
    targetName: entry.productName,
    detail: `desfez ${entry.type} de ${entry.qty} un.`,
  });
  res.json({ ok: true, product: product || null, ledger: db.ledger });
});

/* =========================================================================
   USUÁRIOS
   ========================================================================= */

const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  createdAt: u.createdAt || null,
  mustChangePassword: !!u.mustChangePassword,
  twoFactor: !!(u.totp && u.totp.confirmedAt),
  recoveryLeft: recoveryLeft(u),
});

app.get("/api/users", requireAdmin, (_req, res) => {
  res.json({ users: getDb().users.map(publicUser) });
});

app.post("/api/users", requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const username = str(req.body.username, 40).toLowerCase().replace(/\s+/g, "");
    const password = String(req.body.password || "");
    const name = str(req.body.name, 60) || username;
    const role = req.body.role === "admin" ? "admin" : "editor";

    if (!/^[a-z0-9._-]{3,40}$/.test(username)) {
      return res.status(400).json({ error: "Usuário: 3 a 40 caracteres, use letras, números, ponto, hífen ou _." });
    }
    const problem = passwordProblem(password, username);
    if (problem) return res.status(400).json({ error: problem });
    if (db.users.some((u) => String(u.username).toLowerCase() === username)) {
      return res.status(400).json({ error: "Esse usuário já existe." });
    }
    if (db.users.length >= 50) return res.status(400).json({ error: "Limite de acessos atingido." });

    const pass = await hashPassword(password);
    const user = { id: uid("u"), username, name, role, ...pass, mustChangePassword: false, createdAt: new Date().toISOString() };
    db.users.push(user);
    saveDb(db);
    logAction(req, "user.create", { targetType: "user", targetId: user.id, targetName: `${name} (@${username})`, detail: role });
    res.json({ user: publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.put("/api/users/:id/password", requireAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const me = req.session.user;
    const targetId = str(req.params.id, 60) === "me" ? me.id : str(req.params.id, 60);
    const isSelf = me.id === targetId;
    if (!isSelf && me.role !== "admin") {
      logAction(req, "security.forbidden", { detail: "tentou trocar a senha de outra pessoa" });
      return res.status(403).json({ error: "Você só pode alterar a própria senha." });
    }
    const user = db.users.find((u) => u.id === targetId);
    if (!user) return res.status(404).json({ error: "Usuário não encontrado." });

    const password = String(req.body.password || "");
    const problem = passwordProblem(password, user.username);
    if (problem) return res.status(400).json({ error: problem });

    // Trocar a própria senha exige confirmar a senha atual
    if (isSelf) {
      const current = String(req.body.currentPassword || "");
      if (!current || !(await verifyPassword(current, user))) {
        logAction(req, "auth.login_failed", { detail: "senha atual errada na troca de senha", severity: "alert" });
        return res.status(401).json({ error: "Senha atual incorreta." });
      }
      if (await verifyPassword(password, user)) return res.status(400).json({ error: "A nova senha precisa ser diferente da atual." });
    }

    Object.assign(user, await hashPassword(password));
    user.mustChangePassword = isSelf ? false : true; // senha resetada por admin precisa ser trocada no login
    saveDb(db);
    if (isSelf) markAdminReady();

    logAction(req, "user.password", {
      targetType: "user",
      targetId: user.id,
      targetName: `${user.name} (@${user.username})`,
      detail: isSelf ? "trocou a própria senha" : "senha redefinida por administrador",
    });

    if (isSelf) {
      req.session.user = { ...me, mustChangePassword: false, needs2faSetup: DISABLE_2FA ? false : me.needs2faSetup };
      return req.session.save(() => res.json({ ok: true, user: req.session.user }));
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/users/:id", requireAdmin, (req, res) => {
  const db = getDb();
  const id = str(req.params.id, 60);
  if (id === req.session.user.id) return res.status(400).json({ error: "Você não pode excluir o próprio acesso." });
  const user = db.users.find((u) => u.id === id);
  if (!user) return res.status(404).json({ error: "Usuário não encontrado." });
  if (user.role === "admin" && db.users.filter((u) => u.role === "admin").length <= 1) {
    return res.status(400).json({ error: "A loja precisa de pelo menos um administrador." });
  }
  db.users = db.users.filter((u) => u.id !== id);
  saveDb(db);
  logAction(req, "user.delete", { targetType: "user", targetId: id, targetName: `${user.name} (@${user.username})`, detail: user.role });
  res.json({ ok: true });
});

/* =========================================================================
   CONFIGURAÇÕES DA LOJA
   ========================================================================= */

const SETTINGS_LIMITS = {
  name: 60,
  tagline: 120,
  extra: 1200,
  whatsapp: 20,
  address: 160,
  checkoutMessage: 400,
};

const PROMO_ACTIONS = ["catalogo", "categoria", "produto", "whatsapp"];

/** Uma promoção: card com chamada para ação na vitrine. */
function readPromo(raw, existing) {
  const id = str(raw && raw.id, 60) || uid("promo");
  const prev = (existing || []).find((p) => p.id === id);
  const action = PROMO_ACTIONS.includes(raw && raw.action) ? raw.action : "catalogo";
  return {
    id,
    badge: str(raw && raw.badge, 24),
    title: str(raw && raw.title, 70),
    subtitle: str(raw && raw.subtitle, 160),
    ctaLabel: str(raw && raw.ctaLabel, 30) || "Ver ofertas",
    action,
    value: str(raw && raw.value, 80),
    // A imagem só muda pelo endpoint de upload
    image: prev ? prev.image || "" : "",
    active: bool(raw && raw.active, true),
  };
}

app.put("/api/settings", requireAdmin, (req, res) => {
  const db = getDb();
  const s = db.settings;
  const before = JSON.parse(JSON.stringify(s));
  const beforeCats = db.categories.slice();
  const b = req.body || {};

  for (const [key, max] of Object.entries(SETTINGS_LIMITS)) {
    if (b[key] == null) continue;
    s[key] = key === "whatsapp" ? str(b[key], max).replace(/\D/g, "") : str(b[key], max);
  }
  if (Array.isArray(b.payments)) s.payments = b.payments.slice(0, 12).map((x) => str(x, 120)).filter(Boolean);
  if (Array.isArray(b.shipping)) {
    const shipping = [];
    for (const x of b.shipping.slice(0, 30)) {
      const name = str(x && x.name, 60);
      if (!name) continue;
      const price = optNum(x && x.price, { min: 0, max: 1e6 });
      if (price === INVALID) return res.status(400).json({ error: `Frete inválido em "${name}".` });
      shipping.push({ name, price: price == null ? 0 : price, description: str(x && x.description, 160) });
    }
    s.shipping = normalizeShippingCashboxes(shipping);
  }
  if (Array.isArray(b.categories)) {
    const seen = new Set();
    db.categories = b.categories
      .slice(0, 60)
      .map((x) => str(x, 60))
      .filter((x) => x && !seen.has(x.toLowerCase()) && seen.add(x.toLowerCase()));
  }
  if (b.promoBar && typeof b.promoBar === "object") {
    s.promoBar = {
      active: bool(b.promoBar.active),
      text: str(b.promoBar.text, 120),
      ctaLabel: str(b.promoBar.ctaLabel, 30),
      action: PROMO_ACTIONS.includes(b.promoBar.action) ? b.promoBar.action : "catalogo",
      value: str(b.promoBar.value, 80),
    };
  }
  if (Array.isArray(b.promos)) {
    const before = Array.isArray(s.promos) ? s.promos : [];
    const promos = b.promos.slice(0, 12).map((raw) => readPromo(raw, before)).filter((p) => p.title);
    const keep = new Set(promos.map((p) => p.image).filter(Boolean));
    s.promos = promos;
    for (const old of before) if (old.image && !keep.has(old.image)) removeUnusedUpload(db, old.image);
  }
  if (Array.isArray(b.coupons)) {
    const beforeCoupons = Array.isArray(s.coupons) ? s.coupons : [];
    const seenCodes = new Set();
    s.coupons = b.coupons
      .slice(0, 50)
      .map((raw) => readCoupon(raw, beforeCoupons))
      .filter((c) => {
        if (!c || seenCodes.has(c.code)) return false;
        seenCodes.add(c.code);
        return true;
      });
  }
  if (b.referral && typeof b.referral === "object") {
    s.referral = {
      enabled: bool(b.referral.enabled, true),
      referrerBonus: Math.max(0, Number(b.referral.referrerBonus) || 0),
      referredBonus: Math.max(0, Number(b.referral.referredBonus) || 0),
      orderCashbackPercent: Math.min(50, Math.max(0, Number(b.referral.orderCashbackPercent) || 0)),
    };
  }

  saveDb(db);
  const changes = diffFields(before, s, Object.keys(SETTINGS_LIMITS).concat(["payments", "shipping"]));
  if (JSON.stringify(beforeCats) !== JSON.stringify(db.categories)) {
    changes.push({ field: "categories", from: beforeCats, to: db.categories });
  }
  logAction(req, "settings.update", { detail: changes.map((c) => c.field).join(", ") || "sem mudanças", changes });
  res.json({ settings: db.settings, categories: db.categories });
});

app.post("/api/settings/banner", requireAdmin, uploadLimiter, upload.single("image"), (req, res) => {
  const uploadError = checkUpload(req);
  if (uploadError) return res.status(400).json({ error: uploadError });
  if (!req.file) return res.status(400).json({ error: "Envie uma imagem." });
  const db = getDb();
  const old = db.settings.banner;
  db.settings.banner = uploadedUrl(req);
  saveDb(db);
  if (old && old.startsWith("/uploads/")) removeUnusedUpload(db, old);
  logAction(req, "settings.banner", { detail: db.settings.banner });
  res.json({ banner: db.settings.banner });
});

app.post("/api/settings/promos/:id/image", requireAdmin, uploadLimiter, upload.single("image"), (req, res) => {
  const uploadError = checkUpload(req);
  if (uploadError) return res.status(400).json({ error: uploadError });
  if (!req.file) return res.status(400).json({ error: "Envie uma imagem." });
  const db = getDb();
  const promo = (db.settings.promos || []).find((p) => p.id === str(req.params.id, 60));
  if (!promo) {
    dropUpload(req);
    return res.status(404).json({ error: "Promoção não encontrada. Salve as promoções antes de enviar a foto." });
  }
  const old = promo.image;
  promo.image = uploadedUrl(req);
  saveDb(db);
  if (old && old !== promo.image) removeUnusedUpload(db, old);
  logAction(req, "promo.image", { targetType: "promo", targetId: promo.id, targetName: promo.title, detail: promo.image });
  res.json({ promos: db.settings.promos });
});

app.delete("/api/settings/promos/:id/image", requireAdmin, (req, res) => {
  const db = getDb();
  const promo = (db.settings.promos || []).find((p) => p.id === str(req.params.id, 60));
  if (!promo) return res.status(404).json({ error: "Promoção não encontrada." });
  const old = promo.image;
  promo.image = "";
  saveDb(db);
  removeUnusedUpload(db, old);
  logAction(req, "promo.image_delete", { targetType: "promo", targetId: promo.id, targetName: promo.title });
  res.json({ promos: db.settings.promos });
});

/* =========================================================================
   LOGS DE AUDITORIA
   ========================================================================= */

function filterAudit(entries, query) {
  const action = str(query.action, 60);
  const actor = str(query.actor, 60);
  const severity = str(query.severity, 20);
  const q = str(query.q, 120).toLowerCase();
  const from = query.from ? new Date(String(query.from)).getTime() : null;
  const to = query.to ? new Date(String(query.to)).getTime() : null;

  return entries.filter((e) => {
    if (action && e.action !== action) return false;
    if (actor && e.actorId !== actor && e.actorName !== actor) return false;
    if (severity && e.severity !== severity) return false;
    const t = new Date(e.at).getTime();
    if (from && t < from) return false;
    if (to && t > to + 24 * 60 * 60 * 1000 - 1) return false;
    if (q) {
      const hay = `${e.label} ${e.action} ${e.actorName} ${e.targetName} ${e.detail} ${e.ip} ${e.route}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

app.get("/api/audit", requireAdmin, (req, res) => {
  const all = readAudit();
  const filtered = filterAudit(all, req.query);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
  const offset = Math.max(0, Number(req.query.offset) || 0);

  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = all.filter((e) => new Date(e.at).getTime() >= dayAgo);
  res.json({
    total: filtered.length,
    entries: filtered.slice(offset, offset + limit),
    actions: [...new Set(all.map((e) => e.action))].sort().map((a) => ({ action: a, label: AUDIT_ACTIONS[a] || a })),
    actors: [...new Map(all.filter((e) => e.actorId).map((e) => [e.actorId, e.actorName])).entries()].map(([id, name]) => ({ id, name })),
    stats: {
      stored: all.length,
      last24h: recent.length,
      alerts24h: recent.filter((e) => e.severity === "alert").length,
      logins24h: recent.filter((e) => e.action === "auth.login").length,
      failed24h: recent.filter((e) => e.action === "auth.login_failed").length,
    },
  });
});

app.get("/api/audit/export.csv", requireAdmin, (req, res) => {
  const rows = filterAudit(readAudit(), req.query);
  const cols = ["at", "action", "label", "severity", "actorName", "actorRole", "ip", "method", "route", "targetType", "targetName", "detail", "ua"];
  // Aspas duplas + prefixo em =+-@ evitam injeção de fórmula no Excel
  const cell = (v) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const csv = [cols.join(";"), ...rows.map((r) => cols.map((c) => cell(r[c])).join(";"))].join("\r\n");
  logAction(req, "audit.export", { detail: `${rows.length} registros` });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="logs-goldskull-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`\uFEFF${csv}`);
});

app.delete("/api/audit", requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const me = db.users.find((u) => u.id === req.session.user.id);
    const ok = me && (await verifyPassword(String(req.body.password || ""), me));
    if (!ok) {
      logAction(req, "security.forbidden", { detail: "senha errada ao tentar apagar os logs" });
      return res.status(401).json({ error: "Confirme sua senha para apagar os logs." });
    }
    let moved = 0;
    try {
      moved = readAudit().length;
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      fs.renameSync(AUDIT_PATH, path.join(BACKUPS, `audit-apagado-${stamp}.jsonl`));
    } catch {
      /* nada para mover */
    }
    logAction(req, "audit.clear", { detail: `${moved} registros arquivados em backups/` });
    res.json({ ok: true, archived: moved });
  } catch (err) {
    next(err);
  }
});

/* =========================================================================
   ESTÁTICOS E FALLBACK
   ========================================================================= */

app.use(
  express.static(path.join(ROOT, "public"), {
    index: ["index.html"],
    dotfiles: "ignore",
    setHeaders: (res, filePath) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      if (/\.html$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      // O service worker precisa ser sempre buscado do servidor, senão a atualização trava
      else if (/sw\.js$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      else if (/\.webmanifest$/i.test(filePath)) res.setHeader("Cache-Control", "no-cache");
      else if (/[\\/]img[\\/]/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=604800");
      else if (/\.(css|js|woff2?|svg)$/i.test(filePath)) res.setHeader("Cache-Control", "public, max-age=86400");
    },
  })
);

app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  if (req.path.startsWith("/uploads/")) return res.status(404).type("text/plain").send("Arquivo não encontrado.");
  if (req.path === "/admin" || req.path.startsWith("/admin/")) {
    res.setHeader("Cache-Control", "no-store");
    return res.sendFile(path.join(ROOT, "public", "admin", "index.html"));
  }
  res.sendFile(path.join(ROOT, "public", "index.html"));
});

app.use("/api", (_req, res) => res.status(404).json({ error: "Recurso não encontrado." }));

/* ---------- tratamento de erros (sem vazar detalhes) ---------- */
app.use((err, req, res, _next) => {
  if (req && req.file) dropUpload(req);

  if (err && (err.type === "entity.parse.failed" || err instanceof SyntaxError)) {
    return res.status(400).json({ error: "Dados inválidos." });
  }
  if (err && err.type === "entity.too.large") {
    return res.status(413).json({ error: "Conteúdo muito grande." });
  }
  if (err instanceof multer.MulterError) {
    const messages = {
      LIMIT_FILE_SIZE: "A imagem passa de 8 MB. Envie uma menor.",
      LIMIT_UNEXPECTED_FILE: "Formato não aceito. Use JPG, PNG, WEBP ou GIF.",
      LIMIT_FILE_COUNT: "Envie uma imagem por vez.",
    };
    logAction(req, "security.upload_rejected", { detail: err.code });
    return res.status(400).json({ error: messages[err.code] || "Falha no envio da imagem." });
  }

  console.error("[erro]", err && err.stack ? err.stack : err);
  if (req.path && req.path.startsWith("/api/")) return res.status(500).json({ error: "Erro interno. Tente de novo." });
  res.status(500).type("text/plain").send("Erro interno.");
});

/* =========================================================================
   PARTIDA
   ========================================================================= */

process.on("unhandledRejection", (reason) => console.error("[promise não tratada]", reason));
process.on("uncaughtException", (err) => console.error("[exceção não tratada]", err));

const server = app.listen(PORT, HOST, () => {
  console.log(`GOLD SKULL no ar: http://localhost:${PORT}`);
  console.log(`Painel: http://localhost:${PORT}/admin`);
  console.log(
    `Segurança: ${PROD ? "produção" : "desenvolvimento"} · HTTPS obrigatório: ${FORCE_HTTPS ? "sim" : "não"} · ` +
      `IPs do painel: ${ADMIN_ALLOW_IPS.length ? ADMIN_ALLOW_IPS.join(", ") : "todos"}`
  );
  console.log(`Dados: ${DB_PATH}`);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\n[ERRO] A porta ${PORT} já está sendo usada — a loja provavelmente já está aberta em outra janela.\n` +
        "        Feche a outra janela do terminal (ou use outra porta: PORT=3001 npm start).\n"
    );
  } else if (err.code === "EACCES") {
    console.error(`\n[ERRO] Sem permissão para usar a porta ${PORT}. Use uma porta acima de 1024.\n`);
  } else {
    console.error("[ERRO] Não foi possível iniciar o servidor:", err.message);
  }
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log("\nEncerrando a loja...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
