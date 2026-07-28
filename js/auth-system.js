/* ===========================
   SCHOOLHUB PRO - AUTH SYSTEM
   مدرسة الجيل الجديد الخاصة
   الإصدار: 2.2.1 (تم إصلاح الوصول العام لـ authManager)
   =========================== */

/**
 * نظام المصادقة المركزي
 * يدير تسجيل دخول الطلاب والإدارة
 * يتصل بـ Cloudflare Worker للمصادقة الآمنة
 * يستخدم JWT Tokens بدلاً من الاتصال المباشر بـ Firestore
 * 
 * المتغيرات المطلوبة قبل النشر:
 * - WORKER_URL: رابط Cloudflare Worker
 */

import { 
  saveToLocal, 
  getFromLocal, 
  removeFromLocal,
  showToast,
  showError 
} from './utils.js';

import { 
  cacheManager
} from './cache-manager.js';

// ===========================
// إعدادات Worker
// ===========================

/**
 * رابط Cloudflare Worker للمصادقة
 * تم التحديث إلى الرابط الفعلي المنشور
 */
const WORKER_URL = 'https://floral-moon-768e.hjgfc254.workers.dev';

// ===========================
// ثوابت النظام
// ===========================
const AUTH_CONSTANTS = {
  // مفاتيح التخزين المحلي
  storage_keys: {
    auth_token: 'sh_token',
    auth_user: 'sh_user',
    auth_type: 'sh_type',
    remember_me: 'sh_remember_me',
    last_login: 'sh_last_login',
    login_attempts: 'sh_login_attempts',
    token_expiry: 'sh_token_expiry',
    refresh_token: 'sh_refresh_token'
  },

  // إعدادات الأمان
  security: {
    max_login_attempts: 5,
    lockout_duration_minutes: 15,
    session_duration_hours: 8,
    remember_me_duration_days: 7,
    min_password_length: 6,
    max_password_length: 20,
    request_timeout_login: 10000,    // 10 ثواني لطلبات تسجيل الدخول
    request_timeout_verify: 15000,   // 15 ثانية للتحقق من الجلسة (شبكات بطيئة)
    request_timeout_default: 12000,  // 12 ثانية افتراضي
    max_retries: 1                   // محاولة إعادة واحدة عند فشل الشبكة
  },

  // أنواع الجلسات
  session_types: {
    student: 'student',
    admin: 'admin',
    super_admin: 'super_admin'
  },

  // رموز الأخطاء
  error_codes: {
    invalid_credentials: 'INVALID_CREDENTIALS',
    account_inactive: 'ACCOUNT_INACTIVE',
    account_locked: 'ACCOUNT_LOCKED',
    maintenance_mode: 'MAINTENANCE_MODE',
    session_expired: 'SESSION_EXPIRED',
    invalid_session: 'INVALID_SESSION',
    too_many_attempts: 'TOO_MANY_ATTEMPTS',
    network_error: 'NETWORK_ERROR',
    student_not_found: 'STUDENT_NOT_FOUND',
    admin_not_found: 'ADMIN_NOT_FOUND',
    worker_unreachable: 'WORKER_UNREACHABLE'
  }
};

// ===========================
// كلاس AuthManager
// ===========================
class AuthManager {
  constructor() {
    this.currentUser = null;
    this.sessionType = null;
    this.isAuthenticated = false;
    this.authListeners = [];
    this.initPromise = null;
    this.token = null;
    this.refreshToken = null;
  }

  /**
   * تهيئة نظام المصادقة
   * استعادة الجلسة السابقة إذا كانت موجودة
   * @returns {Promise<Object>} حالة المستخدم الحالي
   */
  async initialize() {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.restoreSession();
    return this.initPromise;
  }

  /**
   * تسجيل دخول الطالب - عبر Worker
   * @param {string} code - كود الطالب
   * @param {string} password - كلمة المرور
   * @param {boolean} rememberMe - تذكرني
   * @returns {Promise<Object>} نتيجة تسجيل الدخول
   */
  async studentLogin(code, password, rememberMe = false) {
    try {
      // التحقق من محاولات تسجيل الدخول
      this.checkLoginAttempts(code);

      // التحقق من صحة المدخلات
      if (!code || !password) {
        throw this.createError('يرجى إدخال كود الطالب وكلمة المرور', 'VALIDATION_ERROR');
      }

      if (password.length < AUTH_CONSTANTS.security.min_password_length) {
        throw this.createError(`كلمة المرور يجب أن تكون ${AUTH_CONSTANTS.security.min_password_length} أحرف على الأقل`, 'VALIDATION_ERROR');
      }

      // إرسال طلب تسجيل الدخول إلى Worker
      const response = await this.workerRequest('/auth/student/login', {
        code: code.trim(),
        password: password
      }, 'POST', AUTH_CONSTANTS.security.request_timeout_login);

      if (!response.success) {
        const errorData = response.error || {};
        
        if (errorData.code === 'MAINTENANCE_MODE') {
          throw this.createError(errorData.message, AUTH_CONSTANTS.error_codes.maintenance_mode);
        }
        if (errorData.code === 'ACCOUNT_INACTIVE') {
          throw this.createError(errorData.message, AUTH_CONSTANTS.error_codes.account_inactive);
        }
        if (errorData.code === 'ACCOUNT_LOCKED') {
          throw this.createError(errorData.message, AUTH_CONSTANTS.error_codes.account_locked);
        }
        
        this.recordLoginAttempt(code, false);
        throw this.createError(errorData.message || 'كود الطالب أو كلمة المرور غير صحيحة', AUTH_CONSTANTS.error_codes.invalid_credentials);
      }

      // تسجيل دخول ناجح
      this.recordLoginAttempt(code, true);

      // تخزين التوكن والبيانات
      const token = response.session.token;
      const refreshToken = response.session.refreshToken;
      const expiresAt = response.session.expiresAt;
      const student = response.student;

      this.saveToken(token, refreshToken, expiresAt, rememberMe);
      this.saveUserData(student, AUTH_CONSTANTS.session_types.student);
      
      this.token = token;
      this.refreshToken = refreshToken;
      this.setCurrentUser(student, AUTH_CONSTANTS.session_types.student);

      // مسح كاش الطالب القديم
      cacheManager.invalidateStudentCache();

      return {
        success: true,
        student: student,
        token: token
      };

    } catch (error) {
      console.error('❌ فشل تسجيل دخول الطالب:', error.message);
      return {
        success: false,
        error: {
          code: error.code || 'UNKNOWN_ERROR',
          message: error.message || 'حدث خطأ أثناء تسجيل الدخول'
        }
      };
    }
  }

  /**
   * تسجيل دخول الإدارة - عبر Worker
   * @param {string} username - اسم المستخدم
   * @param {string} password - كلمة المرور
   * @param {boolean} rememberMe - تذكرني
   * @returns {Promise<Object>}
   */
  async adminLogin(username, password, rememberMe = false) {
    try {
      // حماية Brute Force للإدارة
      this.checkLoginAttempts(username);

      // التحقق من صحة المدخلات
      if (!username || !password) {
        throw this.createError('يرجى إدخال اسم المستخدم وكلمة المرور', 'VALIDATION_ERROR');
      }

      // إرسال طلب تسجيل الدخول إلى Worker
      const response = await this.workerRequest('/auth/admin/login', {
        username: username.trim(),
        password: password
      }, 'POST', AUTH_CONSTANTS.security.request_timeout_login);

      if (!response.success) {
        const errorData = response.error || {};
        
        // تسجيل المحاولة الفاشلة للإدارة
        this.recordLoginAttempt(username, false);
        
        if (errorData.code === 'ACCOUNT_INACTIVE') {
          throw this.createError(errorData.message, AUTH_CONSTANTS.error_codes.account_inactive);
        }
        
        throw this.createError(errorData.message || 'اسم المستخدم أو كلمة المرور غير صحيحة', AUTH_CONSTANTS.error_codes.invalid_credentials);
      }

      // تسجيل دخول ناجح
      this.recordLoginAttempt(username, true);

      // تخزين التوكن والبيانات
      const token = response.session.token;
      const refreshToken = response.session.refreshToken;
      const expiresAt = response.session.expiresAt;
      const admin = response.admin;

      this.saveToken(token, refreshToken, expiresAt, rememberMe);
      this.saveUserData(admin, AUTH_CONSTANTS.session_types.admin);
      
      this.token = token;
      this.refreshToken = refreshToken;
      this.setCurrentUser(admin, AUTH_CONSTANTS.session_types.admin);

      return {
        success: true,
        admin: admin,
        token: token
      };

    } catch (error) {
      console.error('❌ فشل تسجيل دخول المشرف:', error.message);
      return {
        success: false,
        error: {
          code: error.code || 'UNKNOWN_ERROR',
          message: error.message || 'حدث خطأ أثناء تسجيل الدخول'
        }
      };
    }
  }

  /**
   * تسجيل الخروج
   * @returns {Promise<void>}
   */
  async logout() {
    try {
      // حفظ نوع المستخدم قبل مسح التخزين المحلي
      const userType = this.sessionType;

      // إعلام Worker بتسجيل الخروج (اختياري - Worker لا يفعل شيئاً مع JWT)
      try {
        await this.workerRequest('/auth/logout', {}, 'POST', AUTH_CONSTANTS.security.request_timeout_default);
      } catch (e) {
        // تجاهل فشل الاتصال بالـ Worker أثناء الخروج
      }

      // مسح بيانات الجلسة من الذاكرة
      this.currentUser = null;
      this.sessionType = null;
      this.isAuthenticated = false;
      this.token = null;
      this.refreshToken = null;

      // مسح التخزين المحلي
      removeFromLocal(AUTH_CONSTANTS.storage_keys.auth_token);
      removeFromLocal(AUTH_CONSTANTS.storage_keys.auth_user);
      removeFromLocal(AUTH_CONSTANTS.storage_keys.auth_type);
      removeFromLocal(AUTH_CONSTANTS.storage_keys.token_expiry);
      removeFromLocal(AUTH_CONSTANTS.storage_keys.remember_me);
      removeFromLocal(AUTH_CONSTANTS.storage_keys.refresh_token);

      // استخدام النوع المحفوظ لمسح الكاش الصحيح
      if (userType === AUTH_CONSTANTS.session_types.student) {
        cacheManager.invalidateStudentCache();
      } else if (userType === AUTH_CONSTANTS.session_types.admin || userType === AUTH_CONSTANTS.session_types.super_admin) {
        cacheManager.invalidateAdminCache();
      }

      // إعلام المستمعين
      this.notifyListeners({
        type: 'logout',
        user: null
      });

      console.log('👋 تم تسجيل الخروج بنجاح');
    } catch (error) {
      console.error('❌ فشل تسجيل الخروج:', error.message);
    }
  }

  /**
   * تجديد الجلسة باستخدام Refresh Token
   * @returns {Promise<Object>}
   */
  async refreshSession() {
    try {
      const storedRefreshToken = this.refreshToken || getFromLocal(AUTH_CONSTANTS.storage_keys.refresh_token);
      
      if (!storedRefreshToken) {
        return { success: false, error: { code: 'NO_REFRESH_TOKEN', message: 'لا يوجد رمز تجديد' } };
      }

      const response = await this.workerRequest('/auth/refresh', {
        refreshToken: storedRefreshToken
      }, 'POST', AUTH_CONSTANTS.security.request_timeout_default);

      if (response.success && response.session) {
        const token = response.session.token;
        const refreshToken = response.session.refreshToken;
        const expiresAt = response.session.expiresAt;

        this.token = token;
        this.refreshToken = refreshToken;

        // تحديث التوكن في التخزين المحلي
        saveToLocal(AUTH_CONSTANTS.storage_keys.auth_token, token);
        saveToLocal(AUTH_CONSTANTS.storage_keys.refresh_token, refreshToken);
        saveToLocal(AUTH_CONSTANTS.storage_keys.token_expiry, new Date(expiresAt).getTime().toString());

        console.log('🔄 تم تجديد الجلسة بنجاح');
        return { success: true, token };
      }

      // فشل التجديد — تسجيل الخروج
      await this.logout();
      return { success: false, error: { code: 'REFRESH_FAILED', message: 'فشل تجديد الجلسة' } };

    } catch (error) {
      console.error('❌ فشل تجديد الجلسة:', error.message);
      return { success: false, error: { code: 'NETWORK_ERROR', message: error.message } };
    }
  }

  /**
   * استعادة الجلسة السابقة - التحقق من JWT عبر Worker
   * تم إصلاحها: لا تطرد المستخدم فورًا عند فشل الشبكة، بل تحاول مرة أخرى
   * @returns {Promise<Object>}
   */
  async restoreSession() {
    try {
      const token = getFromLocal(AUTH_CONSTANTS.storage_keys.auth_token);
      const userData = getFromLocal(AUTH_CONSTANTS.storage_keys.auth_user);
      const userType = getFromLocal(AUTH_CONSTANTS.storage_keys.auth_type);
      const expiry = getFromLocal(AUTH_CONSTANTS.storage_keys.token_expiry);
      const storedRefreshToken = getFromLocal(AUTH_CONSTANTS.storage_keys.refresh_token);

      // إذا لم يوجد توكن أو بيانات مستخدم، لا توجد جلسة
      if (!token || !userData || !userType) {
        return { isAuthenticated: false, type: null, user: null };
      }

      // استعادة refresh token
      if (storedRefreshToken) {
        this.refreshToken = storedRefreshToken;
      }

      // التحقق من صلاحية التوكن محلياً (وقت الانتهاء)
      if (expiry && Date.now() > parseInt(expiry)) {
        console.log('⏰ انتهت صلاحية الجلسة — محاولة التجديد...');
        
        // محاولة تجديد الجلسة تلقائيًا
        if (this.refreshToken) {
          const refreshResult = await this.refreshSession();
          if (refreshResult.success) {
            this.setCurrentUser(userData, userType);
            console.log('✅ تم تجديد الجلسة تلقائياً:', userData.name || userData.display_name);
            return { isAuthenticated: true, type: userType, user: userData };
          }
        }
        
        // فشل التجديد — تسجيل خروج
        await this.logout();
        return { isAuthenticated: false, type: null, user: null };
      }

      // التحقق من صحة التوكن عبر Worker
      const verifyResult = await this.verifySessionWithRetry(token);
      
      if (verifyResult.success) {
        // الجلسة صالحة
        this.token = token;
        this.setCurrentUser(userData, userType);
        console.log('✅ تم استعادة الجلسة تلقائياً:', userData.name || userData.display_name);
        return { isAuthenticated: true, type: userType, user: userData };
      } else {
        // محاولة أخيرة: تجديد الجلسة إذا كان لدينا refresh token
        if (this.refreshToken) {
          console.log('🔄 الجلسة غير صالحة — محاولة التجديد...');
          const refreshResult = await this.refreshSession();
          if (refreshResult.success) {
            this.setCurrentUser(userData, userType);
            console.log('✅ تم تجديد الجلسة بنجاح');
            return { isAuthenticated: true, type: userType, user: userData };
          }
        }
        
        // كل المحاولات فشلت — تسجيل خروج
        console.log('⚠️ الجلسة غير صالحة ولا يمكن تجديدها، جاري تسجيل الخروج');
        await this.logout();
        return { isAuthenticated: false, type: null, user: null };
      }

    } catch (error) {
      console.error('❌ فشل استعادة الجلسة:', error.message);
      return { isAuthenticated: false, type: null, user: null };
    }
  }

  /**
   * التحقق من الجلسة مع محاولة إعادة عند فشل الشبكة
   * @param {string} token - JWT Token
   * @returns {Promise<Object>}
   */
  async verifySessionWithRetry(token) {
    // المحاولة الأولى
    try {
      const response = await this.workerRequest('/auth/verify', { token }, 'POST', AUTH_CONSTANTS.security.request_timeout_verify);
      
      if (response.success && response.session) {
        return { success: true };
      }
      
      return { success: false };
    } catch (firstError) {
      // المحاولة الثانية بعد انتظار قصير (للتعامل مع انقطاع الشبكة العابر)
      console.warn('⚠️ المحاولة الأولى للتحقق من الجلسة فشلت — إعادة المحاولة خلال 2 ثانية...');
      
      try {
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        const response = await this.workerRequest('/auth/verify', { token }, 'POST', AUTH_CONSTANTS.security.request_timeout_verify);
        
        if (response.success && response.session) {
          console.log('✅ نجحت المحاولة الثانية للتحقق من الجلسة');
          return { success: true };
        }
        
        return { success: false };
      } catch (secondError) {
        console.error('❌ فشلت المحاولة الثانية للتحقق من الجلسة');
        return { success: false };
      }
    }
  }

  // ===========================
  // دوال Worker
  // ===========================

  /**
   * إرسال طلب إلى Cloudflare Worker مع دعم إعادة المحاولة
   * @param {string} path - المسار (مثل /auth/student/login)
   * @param {Object} data - بيانات الطلب
   * @param {string} method - نوع الطلب (GET/POST)
   * @param {number} timeout - المهلة بالمللي ثانية
   * @param {number} retryCount - عدد مرات إعادة المحاولة (داخلي)
   * @returns {Promise<Object>}
   */
  async workerRequest(path, data = {}, method = 'POST', timeout = null, retryCount = 0) {
    const effectiveTimeout = timeout || AUTH_CONSTANTS.security.request_timeout_default;
    const maxRetries = AUTH_CONSTANTS.security.max_retries;
    
    try {
      const options = {
        method: method,
        headers: {
          'Content-Type': 'application/json'
        }
      };

      // إضافة التوكن إذا كان موجوداً (للطلبات المحمية)
      if (this.token) {
        options.headers['Authorization'] = `Bearer ${this.token}`;
      }

      // إضافة body للطلبات غير GET
      if (method !== 'GET' && Object.keys(data).length > 0) {
        options.body = JSON.stringify(data);
      }

      const url = `${WORKER_URL}${path}`;
      
      // إضافة timeout للطلب
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
      options.signal = controller.signal;

      const response = await fetch(url, options);
      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error: {
            code: errorData.error?.code || 'HTTP_ERROR',
            message: errorData.error?.message || `خطأ في الخادم (${response.status})`
          }
        };
      }

      return await response.json();

    } catch (error) {
      // محاولة الإعادة عند أخطاء الشبكة فقط (وليس أخطاء HTTP)
      if (retryCount < maxRetries && (error.name === 'TypeError' || error.name === 'AbortError' || error.message.includes('network') || error.message.includes('fetch'))) {
        const backoff = 1000 * (retryCount + 1); // تأخير تصاعدي: 1ث، 2ث
        console.warn(`🔄 محاولة إعادة الاتصال (${retryCount + 1}/${maxRetries}) خلال ${backoff / 1000} ثانية...`);
        await new Promise(resolve => setTimeout(resolve, backoff));
        return this.workerRequest(path, data, method, timeout, retryCount + 1);
      }

      console.error('❌ فشل الاتصال بـ Worker:', error.message);

      if (error.name === 'AbortError') {
        return {
          success: false,
          error: {
            code: AUTH_CONSTANTS.error_codes.worker_unreachable,
            message: 'انتهت مهلة الاتصال بالخادم. يرجى المحاولة مرة أخرى.'
          }
        };
      }

      return {
        success: false,
        error: {
          code: AUTH_CONSTANTS.error_codes.worker_unreachable,
          message: 'فشل الاتصال بالخادم. تحقق من اتصالك بالإنترنت.'
        }
      };
    }
  }

  // ===========================
  // دوال التخزين المحلي
  // ===========================

  /**
   * حفظ التوكن في التخزين المحلي
   * @param {string} token - JWT Token
   * @param {string} refreshToken - Refresh Token
   * @param {string} expiresAt - وقت انتهاء الصلاحية (ISO string)
   * @param {boolean} rememberMe - تذكرني
   */
  saveToken(token, refreshToken, expiresAt, rememberMe) {
    // حفظ التوكن
    saveToLocal(AUTH_CONSTANTS.storage_keys.auth_token, token);
    
    // حفظ refresh token
    if (refreshToken) {
      saveToLocal(AUTH_CONSTANTS.storage_keys.refresh_token, refreshToken);
    }
    
    // حفظ وقت انتهاء الصلاحية (milliseconds)
    const expiryTime = new Date(expiresAt).getTime();
    saveToLocal(AUTH_CONSTANTS.storage_keys.token_expiry, expiryTime.toString());
    
    // حفظ تفضيل "تذكرني"
    if (rememberMe) {
      saveToLocal(AUTH_CONSTANTS.storage_keys.remember_me, {
        enabled: true,
        savedAt: Date.now()
      });
    }
  }

  /**
   * حفظ بيانات المستخدم
   * @param {Object} user
   * @param {string} type
   */
  saveUserData(user, type) {
    // لا نخزن كلمة المرور
    const safeUser = { ...user };
    delete safeUser.password;
    
    saveToLocal(AUTH_CONSTANTS.storage_keys.auth_user, safeUser);
    saveToLocal(AUTH_CONSTANTS.storage_keys.auth_type, type);
  }

  /**
   * الحصول على التوكن الحالي
   * @returns {string|null}
   */
  getToken() {
    if (this.token) return this.token;
    
    // محاولة استرجاع التوكن من التخزين
    this.token = getFromLocal(AUTH_CONSTANTS.storage_keys.auth_token);
    return this.token;
  }

  // ===========================
  // دوال مساعدة داخلية
  // ===========================

  /**
   * تعيين المستخدم الحالي
   * @param {Object} user
   * @param {string} type
   */
  setCurrentUser(user, type) {
    this.currentUser = user;
    this.sessionType = type;
    this.isAuthenticated = true;
    
    this.notifyListeners({
      type: 'login',
      user: user,
      sessionType: type
    });
  }

  /**
   * تسجيل محاولات تسجيل الدخول (حماية محلية مكمّلة فقط — الحماية الأساسية على الـ Worker)
   * @param {string} identifier - معرف المستخدم
   * @param {boolean} success - هل نجحت المحاولة
   */
  recordLoginAttempt(identifier, success) {
    try {
      const attempts = getFromLocal(AUTH_CONSTANTS.storage_keys.login_attempts) || {};
      
      if (success) {
        // مسح المحاولات الفاشلة عند النجاح
        delete attempts[identifier];
      } else {
        if (!attempts[identifier]) {
          attempts[identifier] = {
            count: 0,
            firstAttempt: Date.now(),
            lastAttempt: Date.now()
          };
        }
        attempts[identifier].count++;
        attempts[identifier].lastAttempt = Date.now();
      }

      saveToLocal(AUTH_CONSTANTS.storage_keys.login_attempts, attempts);
    } catch (error) {
      // تجاهل أخطاء التسجيل
    }
  }

  /**
   * التحقق من محاولات تسجيل الدخول (حماية محلية مكمّلة)
   * الحماية الأساسية على الـ Worker — هذه مجرد طبقة إضافية لراحة المستخدم
   * @param {string} identifier
   * @throws {Error} إذا تجاوز الحد المسموح
   */
  checkLoginAttempts(identifier) {
    try {
      const attempts = getFromLocal(AUTH_CONSTANTS.storage_keys.login_attempts) || {};
      const userAttempts = attempts[identifier];

      if (userAttempts) {
        const lockoutDuration = AUTH_CONSTANTS.security.lockout_duration_minutes * 60 * 1000;
        const timeSinceFirstAttempt = Date.now() - userAttempts.firstAttempt;

        // إعادة تعيين العداد بعد مدة القفل
        if (timeSinceFirstAttempt > lockoutDuration) {
          delete attempts[identifier];
          saveToLocal(AUTH_CONSTANTS.storage_keys.login_attempts, attempts);
          return;
        }

        // التحقق من تجاوز الحد
        if (userAttempts.count >= AUTH_CONSTANTS.security.max_login_attempts) {
          const remainingMinutes = Math.ceil((lockoutDuration - timeSinceFirstAttempt) / 60000);
          throw this.createError(
            `تم تجاوز الحد الأقصى للمحاولات. يرجى المحاولة بعد ${remainingMinutes} دقيقة.`,
            AUTH_CONSTANTS.error_codes.too_many_attempts
          );
        }
      }
    } catch (error) {
      if (error.code === AUTH_CONSTANTS.error_codes.too_many_attempts) {
        throw error;
      }
      // تجاهل الأخطاء الأخرى في التحقق
    }
  }

  /**
   * إنشاء كائن خطأ موحد
   * @param {string} message
   * @param {string} code
   * @returns {Error}
   */
  createError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  // ===========================
  // نظام المستمعين (Listeners)
  // ===========================

  /**
   * إضافة مستمع لتغييرات المصادقة
   * @param {Function} listener
   * @returns {Function} دالة إزالة المستمع
   */
  onAuthChange(listener) {
    this.authListeners.push(listener);
    
    // إعلام المستمع بالحالة الحالية فوراً
    if (this.currentUser) {
      listener({
        type: 'login',
        user: this.currentUser,
        sessionType: this.sessionType
      });
    }

    // إرجاع دالة إزالة المستمع
    return () => {
      this.authListeners = this.authListeners.filter(l => l !== listener);
    };
  }

  /**
   * إعلام جميع المستمعين
   * @param {Object} event
   */
  notifyListeners(event) {
    this.authListeners.forEach(listener => {
      try {
        listener(event);
      } catch (error) {
        console.error('❌ خطأ في مستمع المصادقة:', error.message);
      }
    });
  }

  // ===========================
  // دوال التحقق من الصلاحيات
  // ===========================

  /**
   * التحقق من أن المستخدم طالب
   * @returns {boolean}
   */
  isStudent() {
    return this.isAuthenticated && this.sessionType === AUTH_CONSTANTS.session_types.student;
  }

  /**
   * التحقق من أن المستخدم مشرف
   * @returns {boolean}
   */
  isAdmin() {
    return this.isAuthenticated && 
      (this.sessionType === AUTH_CONSTANTS.session_types.admin || 
       this.sessionType === AUTH_CONSTANTS.session_types.super_admin);
  }

  /**
   * التحقق من صلاحية محددة
   * - super_admin يملك كل الصلاحيات تلقائياً
   * - باقي الأدوار تتحقق من permissions
   * @param {string} permission
   * @returns {boolean}
   */
  hasPermission(permission) {
    if (!this.isAuthenticated || !this.currentUser) return false;
    
    // Super Admin يملك كل الصلاحيات
    if (this.currentUser.role === 'super_admin') {
      return true;
    }
    
    // التحقق من الصلاحية في قائمة permissions
    if (this.currentUser.permissions && Array.isArray(this.currentUser.permissions)) {
      return this.currentUser.permissions.includes(permission);
    }
    
    return false;
  }

  /**
   * التحقق من المصادقة وتوجيه المستخدم إذا لم يكن مسجل الدخول
   * @param {string} redirectUrl - صفحة تسجيل الدخول
   * @returns {boolean}
   */
  requireAuth(redirectUrl = 'index.html') {
    if (!this.isAuthenticated) {
      window.location.href = redirectUrl;
      return false;
    }
    return true;
  }

  /**
   * اشتراط صلاحية محددة
   * @param {string} permission
   * @param {string} redirectUrl
   * @returns {boolean}
   */
  requirePermission(permission, redirectUrl = 'index.html') {
    if (!this.hasPermission(permission)) {
      showError('ليس لديك صلاحية للوصول إلى هذه الصفحة');
      setTimeout(() => {
        window.location.href = redirectUrl;
      }, 1500);
      return false;
    }
    return true;
  }
}

// ===========================
// نسخة واحدة من AuthManager (Singleton)
// ===========================
const authManager = new AuthManager();

// [FIX] تصدير authManager للنطاق العام ليتمكن firebase-config.js من الوصول إليه
window.authManager = authManager;

// ===========================
// دوال مساعدة مختصرة
// ===========================

/**
 * تسجيل دخول سريع للطالب
 * @param {string} code
 * @param {string} password
 * @param {boolean} rememberMe
 * @returns {Promise<Object>}
 */
async function loginStudent(code, password, rememberMe = false) {
  return await authManager.studentLogin(code, password, rememberMe);
}

/**
 * تسجيل دخول سريع للمشرف
 * @param {string} username
 * @param {string} password
 * @param {boolean} rememberMe
 * @returns {Promise<Object>}
 */
async function loginAdmin(username, password, rememberMe = false) {
  return await authManager.adminLogin(username, password, rememberMe);
}

/**
 * تسجيل خروج سريع
 * @returns {Promise<void>}
 */
async function logoutUser() {
  return await authManager.logout();
}

/**
 * تجديد الجلسة الحالية
 * @returns {Promise<Object>}
 */
async function refreshSession() {
  return await authManager.refreshSession();
}

/**
 * تهيئة نظام المصادقة (استعادة الجلسة)
 * @returns {Promise<Object>}
 */
async function initializeAuth() {
  return await authManager.initialize();
}

/**
 * التحقق من حالة المصادقة الحالية
 * @returns {boolean}
 */
function isAuthenticated() {
  return authManager.isAuthenticated;
}

/**
 * الحصول على المستخدم الحالي
 * @returns {Object|null}
 */
function getCurrentUser() {
  return authManager.currentUser;
}

/**
 * الحصول على التوكن الحالي (للاستخدام في طلبات Worker الأخرى)
 * @returns {string|null}
 */
function getAuthToken() {
  return authManager.getToken();
}

// ===========================
// التصدير
// ===========================
export {
  AuthManager,
  authManager,
  loginStudent,
  loginAdmin,
  logoutUser,
  refreshSession,
  initializeAuth,
  isAuthenticated,
  getCurrentUser,
  getAuthToken,
  AUTH_CONSTANTS,
  WORKER_URL
};

// ===========================
// تهيئة تلقائية
// ===========================
authManager.initialize().then(result => {
  if (result.isAuthenticated) {
    console.log('✅ تم استعادة الجلسة تلقائياً');
  } else {
    console.log('ℹ️ لا توجد جلسة سابقة');
  }
});

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Auth System: جاهز | الإصدار 2.2.1 (تم تصدير authManager للنطاق العام)');
console.log('ℹ️ استخدم loginStudent(code, password) لتسجيل دخول الطالب');
console.log('ℹ️ استخدم loginAdmin(username, password) لتسجيل دخول المشرف');
console.log('🔗 الاتصال بالـ Worker:', WORKER_URL);
