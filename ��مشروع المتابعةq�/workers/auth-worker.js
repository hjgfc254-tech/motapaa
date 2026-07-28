/* ===========================
   SCHOOLHUB PRO - DATA & AUTH WORKER
   مدارس الجيل الجديد الخاصة
   الإصدار: 3.2 (Seed Endpoint لأول مشرف)
   =========================== */

/**
 * Cloudflare Worker موحّد للمصادقة والوصول للبيانات
 * 
 * جميع عمليات القراءة والكتابة تمر عبر هذا الـ Worker حصرًا.
 * قواعد Firestore يجب أن تكون: allow read, write: if false;
 * 
 * للنشر:
 * 1. اذهب إلى Cloudflare Dashboard > Workers & Pages
 * 2. أنشئ Worker جديد
 * 3. انسخ هذا الملف
 * 4. أضف متغيرات البيئة (Settings > Variables):
 *    - FIREBASE_API_KEY: مفتاح Firebase (مطلوب)
 *    - PEPPER: سلسلة عشوائية سرية للتشفير (32 حرف على الأقل) (مطلوب)
 *    - JWT_SECRET: مفتاح توقيع JWT (64 حرف على الأقل) (مطلوب)
 *    - ALLOWED_ORIGINS: قائمة origins مسموحة مفصولة بفواصل (اختياري)
 *    - TOKEN_VERSION: إصدار التوكن الحالي (اختياري، افتراضي "1")
 *    - ENVIRONMENT: بيئة التشغيل (production/staging/development)
 * 5. أضف KV Namespace Binding:
 *    - Variable name: RATE_LIMIT_KV
 *    - KV namespace: RATE_LIMIT_KV
 * 6. انشر
 */

// ===========================
// التحقق من متغيرات البيئة المطلوبة
// ===========================
function validateEnvironment(env) {
  const requiredVars = ['FIREBASE_API_KEY', 'PEPPER', 'JWT_SECRET'];
  const missing = [];
  
  for (const varName of requiredVars) {
    if (!env[varName] || env[varName].includes('default-') || env[varName].includes('change-me')) {
      missing.push(varName);
    }
  }
  
  if (missing.length > 0) {
    throw new Error(`إعدادات الخادم غير مكتملة. المتغيرات المفقودة أو غير الصالحة: ${missing.join(', ')}`);
  }
}

// ===========================
// الإعدادات
// ===========================
const FIREBASE_PROJECT_ID = 'elgeel-f4e0d';
const FIRESTORE_BASE_URL = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const JWT_EXPIRY_HOURS = 8;
const JWT_REFRESH_HOURS = 168;
const JWT_ALGORITHM = 'HS256';
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MINUTES = 15;
const RATE_LIMIT_WINDOW = 10 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 10;
const FIRESTORE_TIMEOUT = 10000;
const MAX_RETRIES = 3;
const INITIAL_BACKOFF = 1000;
const BATCH_LIMIT = 500;

// جميع المجموعات في النظام
const COLLECTIONS = {
  STUDENTS: 'students',
  ADMINS: 'admins',
  SETTINGS: 'settings',
  COUNTERS: 'counters',
  SYSTEM_LOGS: 'system_logs',
  ANNOUNCEMENTS: 'announcements',
  MESSAGES: 'messages',
  EVENTS: 'events',
  ALBUMS: 'albums',
  SCHEDULES: 'schedules',
  ATTENDANCE: 'attendance',
  EXPENSES: 'expenses',
  NOTIFICATIONS: 'notifications',
  SCHOOL_STRUCTURE: 'school_structure'
};

// ===========================
// دوال مساعدة - التشفير والأمان
// ===========================
async function hashPassword(password, pepper) {
  const encoder = new TextEncoder();
  const salted = password + pepper;
  const data = encoder.encode(salted);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function constantTimeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aLen = a.length, bLen = b.length;
  let result = aLen ^ bLen;
  const minLen = Math.min(aLen, bLen);
  for (let i = 0; i < minLen; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = crypto.getRandomValues(new Uint8Array(1))[0] % 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

// ===========================
// Rate Limiting (v3.1 - عبر KV)
// ===========================
async function checkRateLimit(ip, action = 'default', env) {
  const key = `rl_${ip}_${action}`;
  const now = Date.now();
  
  try {
    const stored = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
    
    if (!stored) {
      const record = { count: 1, firstAttempt: now, lastAttempt: now };
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000) * 2 });
      return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
    }
    
    const record = stored;
    const windowElapsed = now - record.firstAttempt;
    
    if (windowElapsed > RATE_LIMIT_WINDOW) {
      const newRecord = { count: 1, firstAttempt: now, lastAttempt: now };
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(newRecord), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000) * 2 });
      return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
    }
    
    record.count++;
    record.lastAttempt = now;
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: Math.ceil(RATE_LIMIT_WINDOW / 1000) * 2 });
    
    if (record.count > MAX_REQUESTS_PER_WINDOW) {
      return { allowed: false, remaining: 0, retryAfter: Math.ceil((RATE_LIMIT_WINDOW - windowElapsed) / 1000) };
    }
    
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - record.count };
  } catch (error) {
    console.error('Rate limit KV error:', error.message);
    return { allowed: true, remaining: MAX_REQUESTS_PER_WINDOW - 1 };
  }
}

// ===========================
// JWT
// ===========================
function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function stringToArrayBuffer(str) {
  return new TextEncoder().encode(str);
}

async function createJWT(payload, secret, env) {
  const header = { alg: JWT_ALGORITHM, typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const tokenVersion = env.TOKEN_VERSION || '1';
  
  const tokenPayload = {
    ...payload,
    iat: now,
    exp: now + (JWT_EXPIRY_HOURS * 60 * 60),
    nbf: now,
    jti: generateUUID(),
    iss: 'schoolhub-pro-auth',
    aud: payload.type === 'admin' ? 'schoolhub-admin' : 'schoolhub-student',
    version: tokenVersion
  };

  const encodedHeader = base64UrlEncode(stringToArrayBuffer(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(stringToArrayBuffer(JSON.stringify(tokenPayload)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey('raw', stringToArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, stringToArrayBuffer(signingInput));
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function verifyJWT(token, secret, env) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [encodedHeader, encodedPayload, encodedSignature] = parts;
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const payloadBytes = base64UrlDecode(encodedPayload);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now) return null;
    if (payload.iss && payload.iss !== 'schoolhub-pro-auth') return null;
    if (payload.type === 'admin' && payload.aud !== 'schoolhub-admin') return null;
    if (payload.type === 'student' && payload.aud !== 'schoolhub-student') return null;

    const expectedVersion = env.TOKEN_VERSION || '1';
    if (payload.version && payload.version !== expectedVersion) return null;

    const key = await crypto.subtle.importKey('raw', stringToArrayBuffer(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const signatureBytes = base64UrlDecode(encodedSignature);
    const isValid = await crypto.subtle.verify('HMAC', key, signatureBytes, stringToArrayBuffer(signingInput));
    return isValid ? payload : null;
  } catch (error) {
    console.error('JWT verification error:', error.message);
    return null;
  }
}

async function createRefreshToken(payload, secret, env) {
  const now = Math.floor(Date.now() / 1000);
  const refreshPayload = {
    sub: payload.sub, type: payload.type, jti: generateUUID(),
    iat: now, exp: now + (JWT_REFRESH_HOURS * 60 * 60),
    iss: 'schoolhub-pro-auth', purpose: 'refresh'
  };
  return await createJWT(refreshPayload, secret, env);
}

// ===========================
// دوال الاستجابات
// ===========================
function getSecurityHeaders(env) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache'
  };
}

function getCorsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const allowedOrigins = env.ALLOWED_ORIGINS 
    ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:5500', 'https://schoolhub-pro.pages.dev'];
  
  const isAllowed = allowedOrigins.includes('*') || allowedOrigins.includes(origin) || !origin;
  
  return {
    'Access-Control-Allow-Origin': isAllowed ? (origin || '*') : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Request-ID',
    'Access-Control-Max-Age': '86400',
    'Access-Control-Allow-Credentials': 'true'
  };
}

function jsonResponse(data, status = 200, requestId = null, env = {}) {
  const body = { ...data, timestamp: new Date().toISOString() };
  if (requestId) body.requestId = requestId;
  return new Response(JSON.stringify(body, null, 2), { status, headers: { ...getSecurityHeaders(env) } });
}

function errorResponse(message, status = 400, code = 'ERROR', requestId = null, env = {}) {
  return jsonResponse({ success: false, error: { code, message } }, status, requestId, env);
}

function wrapResponse(response, corsHeaders) {
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => newHeaders.set(key, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
}

// ===========================
// دوال Firestore
// ===========================
async function firestoreRequest(env, method, path, body = null, retryCount = 0) {
  let url = `${FIRESTORE_BASE_URL}/${path}`;
  if (env.FIREBASE_API_KEY) url += `${url.includes('?') ? '&' : '?'}key=${env.FIREBASE_API_KEY}`;
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FIRESTORE_TIMEOUT);
  
  try {
    const options = { method, headers: { 'Content-Type': 'application/json' }, signal: controller.signal };
    if (body) options.body = JSON.stringify(body);
    
    const response = await fetch(url, options);
    clearTimeout(timeoutId);
    
    if (!response.ok) {
      const errorText = await response.text();
      if (response.status >= 500 && retryCount < MAX_RETRIES) {
        await new Promise(resolve => setTimeout(resolve, INITIAL_BACKOFF * Math.pow(2, retryCount)));
        return firestoreRequest(env, method, path, body, retryCount + 1);
      }
      throw new Error(`Firestore error: ${response.status} - ${errorText}`);
    }
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    if ((error.name === 'AbortError' || error.message.includes('network')) && retryCount < MAX_RETRIES) {
      await new Promise(resolve => setTimeout(resolve, INITIAL_BACKOFF * Math.pow(2, retryCount)));
      return firestoreRequest(env, method, path, body, retryCount + 1);
    }
    throw error;
  }
}

async function queryDocument(env, collection, field, value) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: collection }],
      where: { fieldFilter: { field: { fieldPath: field }, op: 'EQUAL', value: { stringValue: String(value) } } },
      limit: 1
    }
  };
  
  let url = `${FIRESTORE_BASE_URL}:runQuery`;
  if (env.FIREBASE_API_KEY) url += `?key=${env.FIREBASE_API_KEY}`;
  
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Query error: ${response.status}`);
  
  const data = await response.json();
  return (data && data.length > 0 && data[0].document) ? data[0].document : null;
}

async function queryDocuments(env, collection, options = {}) {
  const from = [{ collectionId: collection }];
  const limitCount = options.limitCount ? options.limitCount + 1 : 50;
  
  let simpleBody = { structuredQuery: { from, limit: limitCount } };
  
  if (options.orderByField) {
    simpleBody.structuredQuery.orderBy = [{ field: { fieldPath: options.orderByField }, direction: options.orderDirection || 'DESCENDING' }];
  }
  
  if (options.startAfterDoc) {
    simpleBody.structuredQuery.startAt = { values: [{ stringValue: options.startAfterDoc }], before: false };
  }
  
  let url = `${FIRESTORE_BASE_URL}:runQuery`;
  if (env.FIREBASE_API_KEY) url += `?key=${env.FIREBASE_API_KEY}`;
  
  const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(simpleBody) });
  if (!response.ok) throw new Error(`Query error: ${response.status}`);
  
  const data = await response.json();
  const documents = (data || []).filter(d => d.document).map(d => parseFirestoreDocument(d.document));
  
  const hasMore = options.limitCount && documents.length > options.limitCount;
  const docs = hasMore ? documents.slice(0, options.limitCount) : documents;
  const lastVisible = docs.length > 0 ? docs[docs.length - 1].id : null;
  
  return { documents: docs, lastVisible, hasMore };
}

async function getDocument(env, path) {
  return await firestoreRequest(env, 'GET', path);
}

async function updateDocument(env, path, data, updateMaskFields = null) {
  const fields = objectToFirestoreFields(data);
  let fullPath = path;
  if (updateMaskFields && updateMaskFields.length > 0) {
    const maskParam = updateMaskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
    fullPath = `${path}?${maskParam}`;
  }
  return await firestoreRequest(env, 'PATCH', fullPath, { fields });
}

async function createDocument(env, collection, documentId, data) {
  const path = documentId ? `${collection}?documentId=${encodeURIComponent(documentId)}` : collection;
  const fields = objectToFirestoreFields(data);
  return await firestoreRequest(env, 'POST', path, { fields });
}

async function deleteDocument(env, path) {
  return await firestoreRequest(env, 'DELETE', path);
}

async function addSystemLog(env, action, details, performedBy, affectedCount = null, requestId = null) {
  try {
    const logData = {
      action, details, performed_by: performedBy,
      timestamp: new Date().toISOString(),
      environment: env.ENVIRONMENT || 'production'
    };
    if (affectedCount !== null) logData.affected_count = affectedCount;
    if (requestId) logData.request_id = requestId;
    await createDocument(env, COLLECTIONS.SYSTEM_LOGS, null, logData);
  } catch (error) {
    console.error('Failed to add system log:', error.message);
  }
}

function objectToFirestoreFields(obj) {
  const fields = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) fields[key] = { nullValue: null };
    else if (typeof value === 'string') fields[key] = { stringValue: value };
    else if (typeof value === 'number') fields[key] = Number.isInteger(value) && Number.isSafeInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    else if (typeof value === 'boolean') fields[key] = { booleanValue: value };
    else if (value instanceof Date) fields[key] = { timestampValue: value.toISOString() };
    else if (Array.isArray(value)) {
      fields[key] = { arrayValue: { values: value.map(v => {
        if (v === null || v === undefined) return { nullValue: null };
        if (typeof v === 'string') return { stringValue: v };
        if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
        if (typeof v === 'boolean') return { booleanValue: v };
        if (v instanceof Date) return { timestampValue: v.toISOString() };
        if (typeof v === 'object') return { mapValue: { fields: objectToFirestoreFields(v) } };
        return { stringValue: String(v) };
      })}};
    } else if (typeof value === 'object' && !Array.isArray(value)) {
      if (value.$ref) fields[key] = { referenceValue: value.$ref };
      else if (value.$geo) fields[key] = { geoPointValue: { latitude: value.$geo.latitude, longitude: value.$geo.longitude } };
      else if (value.$bytes) fields[key] = { bytesValue: value.$bytes };
      else fields[key] = { mapValue: { fields: objectToFirestoreFields(value) } };
    }
  }
  return fields;
}

function parseFirestoreDocument(doc) {
  if (!doc || !doc.fields) return null;
  const result = {};
  const nameParts = doc.name.split('/');
  result.id = nameParts[nameParts.length - 1];
  for (const [key, value] of Object.entries(doc.fields)) {
    result[key] = parseFirestoreValue(value);
  }
  return result;
}

function parseFirestoreValue(value) {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return parseInt(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.timestampValue !== undefined) return value.timestampValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue?.values) return value.arrayValue.values.map(v => parseFirestoreValue(v));
  if (value.mapValue?.fields) {
    const map = {};
    for (const [k, v] of Object.entries(value.mapValue.fields)) map[k] = parseFirestoreValue(v);
    return map;
  }
  if (value.referenceValue !== undefined) return { $ref: value.referenceValue };
  if (value.geoPointValue !== undefined) return { $geo: { latitude: value.geoPointValue.latitude, longitude: value.geoPointValue.longitude } };
  if (value.bytesValue !== undefined) return { $bytes: value.bytesValue };
  return null;
}

// ===========================
// Validation
// ===========================
function validateString(value, fieldName, options = {}) {
  const { minLength = 1, maxLength = 100, allowEmpty = false, pattern = null } = options;
  if (value === null || value === undefined) {
    if (allowEmpty) return null;
    throw new Error(`${fieldName} مطلوب`);
  }
  const str = String(value).trim();
  if (!allowEmpty && str.length === 0) throw new Error(`${fieldName} لا يمكن أن يكون فارغاً`);
  if (str.length > 0 && str.length < minLength) throw new Error(`${fieldName} يجب أن يكون ${minLength} أحرف على الأقل`);
  if (str.length > maxLength) throw new Error(`${fieldName} يجب أن لا يتجاوز ${maxLength} حرفاً`);
  if (pattern && !pattern.test(str)) throw new Error(`${fieldName} يحتوي على أحرف غير مسموح بها`);
  return str;
}

function validateCode(code) { return validateString(code, 'الكود', { minLength: 3, maxLength: 20, pattern: /^[a-zA-Z0-9_-]+$/ }); }
function validatePassword(password) { return validateString(password, 'كلمة المرور', { minLength: 6, maxLength: 50 }); }
function validateUsername(username) { return validateString(username, 'اسم المستخدم', { minLength: 3, maxLength: 30, pattern: /^[a-zA-Z0-9_]+$/ }); }
function validatePhone(phone) {
  if (!phone || phone.trim() === '') return '';
  return validateString(phone, 'رقم الهاتف', { minLength: 10, maxLength: 15, pattern: /^\+?\d{10,15}$/ });
}

// ===========================
// Middleware
// ===========================
function extractToken(request) {
  const authHeader = request.headers.get('Authorization');
  return (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : null;
}

async function requireAuth(request, env) {
  const token = extractToken(request);
  if (!token) return null;
  return await verifyJWT(token, env.JWT_SECRET, env);
}

async function requireAdmin(request, env) {
  const payload = await requireAuth(request, env);
  return (payload && payload.type === 'admin') ? payload : null;
}

async function requireSuperAdmin(request, env) {
  const payload = await requireAdmin(request, env);
  return (payload && payload.role === 'super_admin') ? payload : null;
}

// ===========================
// معالجة المصادقة (v3.1 - عبر KV)
// ===========================
async function recordFailedAttempt(identifier, env) {
  const key = `la_${identifier}`;
  const now = Date.now();
  
  try {
    const stored = await env.RATE_LIMIT_KV.get(key, { type: 'json' });
    
    if (!stored) {
      const record = { count: 1, firstAttempt: now, lastAttempt: now, locked: false };
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: LOCKOUT_DURATION_MINUTES * 60 * 4 });
      return { locked: false, remaining: MAX_LOGIN_ATTEMPTS - 1 };
    }
    
    const record = stored;
    const lockoutDuration = LOCKOUT_DURATION_MINUTES * 60 * 1000;
    
    if (record.locked && (now - record.lockedAt) > lockoutDuration) {
      const newRecord = { count: 1, firstAttempt: now, lastAttempt: now, locked: false };
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(newRecord), { expirationTtl: LOCKOUT_DURATION_MINUTES * 60 * 4 });
      return { locked: false, remaining: MAX_LOGIN_ATTEMPTS - 1 };
    }
    
    if (record.locked) {
      return { locked: true, remaining: 0, remainingMinutes: Math.ceil((lockoutDuration - (now - record.lockedAt)) / 60000) };
    }
    
    record.count++;
    record.lastAttempt = now;
    
    if (record.count >= MAX_LOGIN_ATTEMPTS) {
      record.locked = true;
      record.lockedAt = now;
      await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: LOCKOUT_DURATION_MINUTES * 60 * 4 });
      return { locked: true, remaining: 0, remainingMinutes: LOCKOUT_DURATION_MINUTES };
    }
    
    await env.RATE_LIMIT_KV.put(key, JSON.stringify(record), { expirationTtl: LOCKOUT_DURATION_MINUTES * 60 * 4 });
    return { locked: false, remaining: MAX_LOGIN_ATTEMPTS - record.count };
  } catch (error) {
    console.error('Login attempts KV error:', error.message);
    return { locked: false, remaining: MAX_LOGIN_ATTEMPTS - 1 };
  }
}

async function clearLoginAttempts(identifier, env) {
  const key = `la_${identifier}`;
  try {
    await env.RATE_LIMIT_KV.delete(key);
  } catch (error) {
    console.error('Clear login attempts KV error:', error.message);
  }
}

async function handleStudentLogin(env, code, password, requestId, ip) {
  try {
    const rateCheck = await checkRateLimit(ip, 'student_login', env);
    if (!rateCheck.allowed) return errorResponse('طلبات كثيرة جداً. يرجى المحاولة لاحقاً.', 429, 'RATE_LIMITED', requestId, env);
    
    const attemptCheck = await recordFailedAttempt(`student_${code}`, env);
    if (attemptCheck.locked) {
      await addSystemLog(env, 'student_login_locked', `محاولة تسجيل دخول لحساب مقفل: ${code}`, 'system', null, requestId);
      return errorResponse(`تم قفل الحساب مؤقتاً. يرجى المحاولة بعد ${attemptCheck.remainingMinutes} دقيقة.`, 429, 'ACCOUNT_LOCKED', requestId, env);
    }
    
    const settingsDoc = await getDocument(env, `${COLLECTIONS.SETTINGS}/general`);
    const settings = parseFirestoreDocument(settingsDoc);
    if (settings?.maintenance_mode === true) {
      return errorResponse(settings.maintenance_message || 'النظام في وضع الصيانة', 503, 'MAINTENANCE_MODE', requestId, env);
    }
    
    try { code = validateCode(code); password = validatePassword(password); }
    catch (validationError) { return errorResponse(validationError.message, 400, 'VALIDATION_ERROR', requestId, env); }
    
    const studentDoc = await queryDocument(env, COLLECTIONS.STUDENTS, 'code', code);
    if (!studentDoc) return errorResponse('كود الطالب أو كلمة المرور غير صحيحة', 401, 'INVALID_CREDENTIALS', requestId, env);
    
    const student = parseFirestoreDocument(studentDoc);
    if (student.status === 'inactive') return errorResponse(settings?.inactive_student_message || 'حسابك غير مفعل', 403, 'ACCOUNT_INACTIVE', requestId, env);
    if (student.status === 'locked') return errorResponse('تم قفل حسابك', 403, 'ACCOUNT_LOCKED', requestId, env);
    
    const hashedPassword = await hashPassword(password, env.PEPPER);
    if (!constantTimeCompare(hashedPassword, student.password)) return errorResponse('كود الطالب أو كلمة المرور غير صحيحة', 401, 'INVALID_CREDENTIALS', requestId, env);
    
    await clearLoginAttempts(`student_${code}`, env);
    
    try { await updateDocument(env, `${COLLECTIONS.STUDENTS}/${student.id}`, { last_login: new Date().toISOString() }, ['last_login']); } catch (e) {}
    
    const jwtPayload = { sub: student.id, type: 'student', name: student.name, code: student.code, stage_id: student.stage_id || '', class_id: student.class_id || '' };
    const token = await createJWT(jwtPayload, env.JWT_SECRET, env);
    const refreshToken = await createRefreshToken(jwtPayload, env.JWT_SECRET, env);
    const expiresAt = new Date(Date.now() + (JWT_EXPIRY_HOURS * 60 * 60 * 1000));
    
    const safeStudent = { ...student }; delete safeStudent.password;
    await addSystemLog(env, 'student_login', `تسجيل دخول الطالب: ${student.name}`, student.name, null, requestId);
    
    return jsonResponse({ success: true, student: safeStudent, session: { token, refreshToken, expiresAt: expiresAt.toISOString() } }, 200, requestId, env);
  } catch (error) {
    console.error('Student login error:', error.message);
    return errorResponse('حدث خطأ في الخادم', 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleAdminLogin(env, username, password, requestId, ip) {
  try {
    const rateCheck = await checkRateLimit(ip, 'admin_login', env);
    if (!rateCheck.allowed) return errorResponse('طلبات كثيرة جداً. يرجى المحاولة لاحقاً.', 429, 'RATE_LIMITED', requestId, env);
    
    const attemptCheck = await recordFailedAttempt(`admin_${username}`, env);
    if (attemptCheck.locked) {
      await addSystemLog(env, 'admin_login_locked', `محاولة تسجيل دخول لحساب مقفل: ${username}`, 'system', null, requestId);
      return errorResponse(`تم قفل الحساب مؤقتاً. يرجى المحاولة بعد ${attemptCheck.remainingMinutes} دقيقة.`, 429, 'ACCOUNT_LOCKED', requestId, env);
    }
    
    try { username = validateUsername(username); password = validatePassword(password); }
    catch (validationError) { return errorResponse(validationError.message, 400, 'VALIDATION_ERROR', requestId, env); }
    
    const adminDoc = await queryDocument(env, COLLECTIONS.ADMINS, 'username', username);
    if (!adminDoc) return errorResponse('اسم المستخدم أو كلمة المرور غير صحيحة', 401, 'INVALID_CREDENTIALS', requestId, env);
    
    const admin = parseFirestoreDocument(adminDoc);
    if (!admin.is_active) return errorResponse('حسابك معطل', 403, 'ACCOUNT_INACTIVE', requestId, env);
    
    const hashedPassword = await hashPassword(password, env.PEPPER);
    if (!constantTimeCompare(hashedPassword, admin.password)) return errorResponse('اسم المستخدم أو كلمة المرور غير صحيحة', 401, 'INVALID_CREDENTIALS', requestId, env);
    
    await clearLoginAttempts(`admin_${username}`, env);
    try { await updateDocument(env, `${COLLECTIONS.ADMINS}/${admin.id}`, { last_login: new Date().toISOString() }, ['last_login']); } catch (e) {}
    
    const jwtPayload = { sub: admin.id, type: 'admin', role: admin.role || 'admin', username: admin.username, display_name: admin.display_name || admin.username, permissions: admin.permissions || [] };
    const token = await createJWT(jwtPayload, env.JWT_SECRET, env);
    const refreshToken = await createRefreshToken(jwtPayload, env.JWT_SECRET, env);
    const expiresAt = new Date(Date.now() + (JWT_EXPIRY_HOURS * 60 * 60 * 1000));
    
    const safeAdmin = { ...admin }; delete safeAdmin.password;
    await addSystemLog(env, 'admin_login', `تسجيل دخول المشرف: ${admin.display_name || admin.username}`, admin.username, null, requestId);
    
    return jsonResponse({ success: true, admin: safeAdmin, session: { token, refreshToken, expiresAt: expiresAt.toISOString() } }, 200, requestId, env);
  } catch (error) {
    console.error('Admin login error:', error.message);
    return errorResponse('حدث خطأ في الخادم', 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleRefreshToken(env, refreshToken, requestId) {
  if (!refreshToken) return errorResponse('رمز التجديد مطلوب', 401, 'NO_TOKEN', requestId, env);
  const payload = await verifyJWT(refreshToken, env.JWT_SECRET, env);
  if (!payload || payload.purpose !== 'refresh') return errorResponse('رمز التجديد غير صالح', 401, 'INVALID_REFRESH_TOKEN', requestId, env);
  
  const newPayload = { sub: payload.sub, type: payload.type };
  const newToken = await createJWT(newPayload, env.JWT_SECRET, env);
  const newRefreshToken = await createRefreshToken(newPayload, env.JWT_SECRET, env);
  const expiresAt = new Date(Date.now() + (JWT_EXPIRY_HOURS * 60 * 60 * 1000));
  
  return jsonResponse({ success: true, session: { token: newToken, refreshToken: newRefreshToken, expiresAt: expiresAt.toISOString() } }, 200, requestId, env);
}

async function handleVerifySession(env, token, requestId) {
  if (!token) return errorResponse('رمز الجلسة مطلوب', 401, 'NO_TOKEN', requestId, env);
  const payload = await verifyJWT(token, env.JWT_SECRET, env);
  if (!payload) return errorResponse('الجلسة غير صالحة أو منتهية', 401, 'INVALID_SESSION', requestId, env);
  
  return jsonResponse({ success: true, session: { type: payload.type, user: { id: payload.sub, name: payload.name || payload.display_name, code: payload.code, username: payload.username, display_name: payload.display_name, role: payload.role, permissions: payload.permissions, stage_id: payload.stage_id, class_id: payload.class_id }, expiresAt: new Date(payload.exp * 1000).toISOString() } }, 200, requestId, env);
}

function handleLogout(requestId, env) {
  return jsonResponse({ success: true, message: 'تم تسجيل الخروج بنجاح' }, 200, requestId, env);
}

// ===========================
// معالجات البيانات العامة
// ===========================
async function handleDataRead(env, payload, body, requestId) {
  const { collection, documentId } = body;
  if (!collection || !documentId) return errorResponse('collection و documentId مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const doc = await getDocument(env, `${collection}/${documentId}`);
    const parsed = parseFirestoreDocument(doc);
    return jsonResponse({ success: true, document: parsed }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'FIRESTORE_ERROR', requestId, env);
  }
}

async function handleDataQuery(env, payload, body, requestId) {
  const { collection, options } = body;
  if (!collection) return errorResponse('collection مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const result = await queryDocuments(env, collection, options || {});
    return jsonResponse({ success: true, ...result }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'FIRESTORE_ERROR', requestId, env);
  }
}

async function handleDataWrite(env, payload, body, requestId) {
  const { collection, documentId, data, merge } = body;
  if (!collection || !data) return errorResponse('collection و data مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    if (documentId) {
      await updateDocument(env, `${collection}/${documentId}`, data);
      return jsonResponse({ success: true, documentId }, 200, requestId, env);
    } else {
      const result = await createDocument(env, collection, null, data);
      const newId = result.name ? result.name.split('/').pop() : null;
      return jsonResponse({ success: true, documentId: newId }, 201, requestId, env);
    }
  } catch (error) {
    return errorResponse(error.message, 500, 'FIRESTORE_ERROR', requestId, env);
  }
}

async function handleDataDelete(env, payload, body, requestId) {
  const { collection, documentId } = body;
  if (!collection || !documentId) return errorResponse('collection و documentId مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    await deleteDocument(env, `${collection}/${documentId}`);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'FIRESTORE_ERROR', requestId, env);
  }
}

async function handleDataBatch(env, payload, body, requestId) {
  const { operations } = body;
  if (!operations || !Array.isArray(operations) || operations.length === 0) {
    return errorResponse('operations مطلوبة (مصفوفة)', 400, 'VALIDATION_ERROR', requestId, env);
  }
  
  if (operations.length > BATCH_LIMIT) {
    return errorResponse(`الحد الأقصى ${BATCH_LIMIT} عملية`, 400, 'BATCH_TOO_LARGE', requestId, env);
  }
  
  try {
    const results = [];
    for (const op of operations) {
      try {
        if (op.type === 'set' || op.type === 'update') {
          if (op.documentId) {
            await updateDocument(env, `${op.collection}/${op.documentId}`, op.data || {});
          } else {
            const result = await createDocument(env, op.collection, op.documentId || null, op.data || {});
            results.push({ type: op.type, documentId: result.name ? result.name.split('/').pop() : null, success: true });
            continue;
          }
        } else if (op.type === 'delete') {
          await deleteDocument(env, `${op.collection}/${op.documentId}`);
        }
        results.push({ type: op.type, documentId: op.documentId, success: true });
      } catch (opError) {
        results.push({ type: op.type, documentId: op.documentId, success: false, error: opError.message });
      }
    }
    
    const allSuccess = results.every(r => r.success);
    return jsonResponse({ success: allSuccess, results, completed: results.filter(r => r.success).length, failed: results.filter(r => !r.success).length }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'BATCH_ERROR', requestId, env);
  }
}

async function handleDataIncrement(env, payload, body, requestId) {
  const { collection, documentId, field, amount } = body;
  if (!collection || !documentId || !field) return errorResponse('collection, documentId, field مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const data = { [field]: amount || 1, updatedAt: new Date().toISOString() };
    await updateDocument(env, `${collection}/${documentId}`, data);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'FIRESTORE_ERROR', requestId, env);
  }
}

// ===========================
// معالجات المشرفين
// ===========================
async function handleCreateStudent(env, payload, body, requestId) {
  const { name, code, password: plainPassword, stage_id, stage_name, class_id, class_name, parent_name, parent_phone, seat_number } = body;
  if (!name || !code) return errorResponse('اسم الطالب وكوده مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const existing = await queryDocument(env, COLLECTIONS.STUDENTS, 'code', code);
    if (existing) return errorResponse('هذا الكود مستخدم بالفعل', 409, 'DUPLICATE_CODE', requestId, env);
    
    const generatedPassword = plainPassword || generateRandomString(8);
    const hashedPassword = await hashPassword(generatedPassword, env.PEPPER);
    
    const studentData = {
      name, code, password: hashedPassword,
      stage_id: stage_id || '', stage_name: stage_name || '',
      class_id: class_id || '', class_name: class_name || '',
      parent_name: parent_name || '', parent_phone: parent_phone || '',
      seat_number: seat_number || '',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const result = await createDocument(env, COLLECTIONS.STUDENTS, null, studentData);
    const studentId = result.name ? result.name.split('/').pop() : null;
    
    await addSystemLog(env, 'student_created', `إنشاء طالب: ${name}`, payload.username || payload.display_name, null, requestId);
    
    return jsonResponse({ success: true, studentId, plainPassword: plainPassword ? null : generatedPassword }, 201, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleUpdateStudent(env, payload, body, requestId) {
  const { studentId, ...updateData } = body;
  if (!studentId) return errorResponse('studentId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    delete updateData.password;
    updateData.updated_at = new Date().toISOString();
    await updateDocument(env, `${COLLECTIONS.STUDENTS}/${studentId}`, updateData);
    await addSystemLog(env, 'student_updated', `تحديث بيانات الطالب: ${studentId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleDeleteStudent(env, payload, body, requestId) {
  const { studentId } = body;
  if (!studentId) return errorResponse('studentId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    await deleteDocument(env, `${COLLECTIONS.STUDENTS}/${studentId}`);
    await addSystemLog(env, 'student_deleted', `حذف الطالب: ${studentId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleResetStudentPassword(env, payload, body, requestId) {
  const { studentId, password: plainPassword } = body;
  if (!studentId) return errorResponse('studentId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const generatedPassword = plainPassword || generateRandomString(8);
    const hashedPassword = await hashPassword(generatedPassword, env.PEPPER);
    await updateDocument(env, `${COLLECTIONS.STUDENTS}/${studentId}`, { password: hashedPassword, must_change_password: true });
    await addSystemLog(env, 'student_password_reset', `تغيير كلمة مرور الطالب: ${studentId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true, plainPassword: generatedPassword }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleCreateAdmin(env, payload, body, requestId) {
  const { username, display_name, password: plainPassword, role, permissions, documentId } = body;
  if (!username) return errorResponse('اسم المستخدم مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const existing = await queryDocument(env, COLLECTIONS.ADMINS, 'username', username);
    if (existing) return errorResponse('اسم المستخدم مستخدم بالفعل', 409, 'DUPLICATE_USERNAME', requestId, env);
    
    const generatedPassword = plainPassword || generateRandomString(12);
    const hashedPassword = await hashPassword(generatedPassword, env.PEPPER);
    
    const adminData = {
      username, display_name: display_name || username,
      password: hashedPassword,
      role: role || 'admin',
      permissions: permissions || [],
      is_active: true,
      must_change_password: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const docId = documentId || 'admin_' + generateRandomString(8);
    await createDocument(env, COLLECTIONS.ADMINS, docId, adminData);
    await addSystemLog(env, 'admin_created', `إنشاء مشرف: ${username}`, payload.username || payload.display_name, null, requestId);
    
    return jsonResponse({ success: true, documentId: docId, plainPassword: plainPassword ? null : generatedPassword }, 201, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleUpdateAdmin(env, payload, body, requestId) {
  const { adminId, ...updateData } = body;
  if (!adminId) return errorResponse('adminId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    delete updateData.password;
    updateData.updated_at = new Date().toISOString();
    await updateDocument(env, `${COLLECTIONS.ADMINS}/${adminId}`, updateData);
    await addSystemLog(env, 'admin_updated', `تحديث مشرف: ${adminId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleDeleteAdmin(env, payload, body, requestId) {
  const { adminId } = body;
  if (!adminId) return errorResponse('adminId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    await deleteDocument(env, `${COLLECTIONS.ADMINS}/${adminId}`);
    await addSystemLog(env, 'admin_deleted', `حذف مشرف: ${adminId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleResetAdminPassword(env, payload, body, requestId) {
  const { adminId, password: plainPassword } = body;
  if (!adminId) return errorResponse('adminId مطلوب', 400, 'VALIDATION_ERROR', requestId, env);
  
  try {
    const generatedPassword = plainPassword || generateRandomString(12);
    const hashedPassword = await hashPassword(generatedPassword, env.PEPPER);
    await updateDocument(env, `${COLLECTIONS.ADMINS}/${adminId}`, { password: hashedPassword, must_change_password: true });
    await addSystemLog(env, 'admin_password_reset', `تغيير كلمة مرور مشرف: ${adminId}`, payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true, plainPassword: generatedPassword }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

async function handleUpdateSettings(env, payload, body, requestId) {
  try {
    const updateData = { ...body, updatedAt: new Date().toISOString() };
    delete updateData.adminId;
    await updateDocument(env, `${COLLECTIONS.SETTINGS}/general`, updateData);
    await addSystemLog(env, 'settings_updated', 'تحديث الإعدادات', payload.username || payload.display_name, null, requestId);
    return jsonResponse({ success: true }, 200, requestId, env);
  } catch (error) {
    return errorResponse(error.message, 500, 'SERVER_ERROR', requestId, env);
  }
}

// ===========================
// [v3.2] Seed - إنشاء أول مشرف (بدون مصادقة - لأول تشغيل فقط)
// ===========================
async function handleSeedAdmin(env, body, requestId, ip) {
  try {
    // Rate limiting للحماية
    const rateCheck = await checkRateLimit(ip, 'seed_admin', env);
    if (!rateCheck.allowed) {
      return errorResponse('طلبات كثيرة جداً. يرجى المحاولة لاحقاً.', 429, 'RATE_LIMITED', requestId, env);
    }
    
    const { username, display_name, password, role, permissions, documentId } = body;
    
    if (!username || !password) {
      return errorResponse('اسم المستخدم وكلمة المرور مطلوبان', 400, 'VALIDATION_ERROR', requestId, env);
    }
    
    // التحقق من عدم وجود مشرفين سابقين (أمان - يمنع إعادة التهيئة)
    const existingAdmins = await queryDocuments(env, COLLECTIONS.ADMINS, { limitCount: 1 });
    if (existingAdmins.documents && existingAdmins.documents.length > 0) {
      return errorResponse('النظام مهيأ مسبقاً. لا يمكن استخدام مسار seed.', 409, 'ALREADY_INITIALIZED', requestId, env);
    }
    
    // تجزئة كلمة المرور باستخدام PEPPER من متغيرات البيئة
    const hashedPassword = await hashPassword(password, env.PEPPER);
    
    const adminData = {
      username: username || 'admin',
      display_name: display_name || 'المدير العام',
      password: hashedPassword,
      role: role || 'super_admin',
      permissions: permissions || [
        "students.read", "students.write", "students.delete",
        "stages.read", "stages.write", "stages.delete",
        "announcements.read", "announcements.write", "announcements.delete",
        "messages.read", "messages.write", "messages.delete",
        "events.read", "events.write", "events.delete",
        "albums.read", "albums.write", "albums.delete",
        "schedules.read", "schedules.write", "schedules.delete",
        "attendance.read", "attendance.write",
        "expenses.read", "expenses.write",
        "settings.read", "settings.write",
        "system_logs.read",
        "counters.read"
      ],
      is_active: true,
      must_change_password: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    
    const docId = documentId || 'master_admin';
    await createDocument(env, COLLECTIONS.ADMINS, docId, adminData);
    
    await addSystemLog(env, 'admin_seeded', `إنشاء أول مشرف عبر Seed: ${username}`, 'system', null, requestId);
    
    console.log(`✅ Seed admin created: ${username} (${docId})`);
    
    return jsonResponse({
      success: true,
      documentId: docId,
      message: 'تم إنشاء حساب المشرف الأول بنجاح',
      warning: 'تأكد من حفظ كلمة المرور. لن تظهر مرة أخرى.'
    }, 201, requestId, env);
  } catch (error) {
    console.error('Seed admin error:', error.message);
    return errorResponse('حدث خطأ في إنشاء المشرف الأول', 500, 'SERVER_ERROR', requestId, env);
  }
}

// ===========================
// نقطة الدخول الرئيسية
// ===========================
export default {
  async fetch(request, env, ctx) {
    const requestId = generateUUID();
    
    try {
      try { validateEnvironment(env); }
      catch (configError) { return errorResponse(configError.message, 500, 'CONFIGURATION_ERROR', requestId, env); }
      
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
      }
      
      const url = new URL(request.url);
      const path = url.pathname;
      const corsHeaders = getCorsHeaders(request, env);
      const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
      
      try {
        if (request.method === 'GET' && (path === '/' || path === '')) {
          const response = jsonResponse({
            success: true,
            message: 'SchoolHub Pro - Data & Auth Worker',
            version: '3.2.0',
            environment: env.ENVIRONMENT || 'production',
            rateLimiting: 'KV-backed',
            endpoints: {
              auth: {
                health: 'GET /auth/health',
                studentLogin: 'POST /auth/student/login',
                adminLogin: 'POST /auth/admin/login',
                verify: 'POST /auth/verify',
                refresh: 'POST /auth/refresh',
                logout: 'POST /auth/logout'
              },
              data: {
                read: 'POST /data/read',
                query: 'POST /data/query',
                write: 'POST /data/write',
                delete: 'POST /data/delete',
                batch: 'POST /data/batch',
                increment: 'POST /data/increment'
              },
              admin: {
                seed: 'POST /admin/seed (أول تشغيل فقط - بدون مصادقة)',
                createStudent: 'POST /admin/students/create',
                updateStudent: 'POST /admin/students/update',
                deleteStudent: 'POST /admin/students/delete',
                resetStudentPassword: 'POST /admin/students/reset-password',
                createAdmin: 'POST /admin/admins/create',
                updateAdmin: 'POST /admin/admins/update',
                deleteAdmin: 'POST /admin/admins/delete',
                resetAdminPassword: 'POST /admin/admins/reset-password',
                updateSettings: 'POST /admin/settings/update'
              }
            }
          }, 200, requestId, env);
          return wrapResponse(response, corsHeaders);
        }
        
        // ===========================
        // [v3.2] Seed - أول مشرف بدون مصادقة
        // ===========================
        if (request.method === 'POST' && path === '/admin/seed') {
          const body = await request.json();
          return wrapResponse(await handleSeedAdmin(env, body, requestId, ip), corsHeaders);
        }
        
        if (request.method === 'POST' && path === '/auth/student/login') {
          const body = await request.json();
          return wrapResponse(await handleStudentLogin(env, body.code, body.password, requestId, ip), corsHeaders);
        }
        if (request.method === 'POST' && path === '/auth/admin/login') {
          const body = await request.json();
          return wrapResponse(await handleAdminLogin(env, body.username, body.password, requestId, ip), corsHeaders);
        }
        if (request.method === 'POST' && path === '/auth/verify') {
          return wrapResponse(await handleVerifySession(env, (await request.json()).token, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/auth/refresh') {
          return wrapResponse(await handleRefreshToken(env, (await request.json()).refreshToken, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/auth/logout') {
          return wrapResponse(handleLogout(requestId, env), corsHeaders);
        }
        if (request.method === 'GET' && path === '/auth/health') {
          return wrapResponse(jsonResponse({ success: true, message: 'Auth Worker is running', timestamp: new Date().toISOString(), version: '3.2.0', environment: env.ENVIRONMENT || 'production', jwt_enabled: true, rate_limiting: 'KV', seed_available: true }, 200, requestId, env), corsHeaders);
        }
        
        if (request.method === 'POST' && path === '/data/read') {
          const payload = await requireAuth(request, env);
          if (!payload) return wrapResponse(errorResponse('مصادقة مطلوبة', 401, 'UNAUTHORIZED', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataRead(env, payload, body, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/data/query') {
          const payload = await requireAuth(request, env);
          if (!payload) return wrapResponse(errorResponse('مصادقة مطلوبة', 401, 'UNAUTHORIZED', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataQuery(env, payload, body, requestId), corsHeaders);
        }
        
        if (request.method === 'POST' && path === '/data/write') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataWrite(env, payload, body, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/data/delete') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataDelete(env, payload, body, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/data/batch') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataBatch(env, payload, body, requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/data/increment') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          const body = await request.json();
          return wrapResponse(await handleDataIncrement(env, payload, body, requestId), corsHeaders);
        }
        
        if (request.method === 'POST' && path === '/admin/students/create') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleCreateStudent(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/students/update') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleUpdateStudent(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/students/delete') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleDeleteStudent(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/students/reset-password') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleResetStudentPassword(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/admins/create') {
          const payload = await requireSuperAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مدير عام مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleCreateAdmin(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/admins/update') {
          const payload = await requireSuperAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مدير عام مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleUpdateAdmin(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/admins/delete') {
          const payload = await requireSuperAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مدير عام مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleDeleteAdmin(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/admins/reset-password') {
          const payload = await requireSuperAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مدير عام مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleResetAdminPassword(env, payload, await request.json(), requestId), corsHeaders);
        }
        if (request.method === 'POST' && path === '/admin/settings/update') {
          const payload = await requireAdmin(request, env);
          if (!payload) return wrapResponse(errorResponse('صلاحية مشرف مطلوبة', 403, 'FORBIDDEN', requestId, env), corsHeaders);
          return wrapResponse(await handleUpdateSettings(env, payload, await request.json(), requestId), corsHeaders);
        }
        
        return wrapResponse(errorResponse('المسار غير موجود', 404, 'NOT_FOUND', requestId, env), corsHeaders);
        
      } catch (error) {
        if (error instanceof SyntaxError) return wrapResponse(errorResponse('بيانات الطلب غير صالحة', 400, 'INVALID_JSON', requestId, env), corsHeaders);
        throw error;
      }
    } catch (error) {
      console.error('Worker error:', error.message);
      return wrapResponse(errorResponse('حدث خطأ في الخادم', 500, 'SERVER_ERROR', requestId, env), getCorsHeaders(request, env));
    }
  }
};