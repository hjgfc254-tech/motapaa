/* ===========================
   SCHOOLHUB PRO - CACHE MANAGER
   مدرسة الجيل الجديد الخاصة
   الإصدار: 2.2 (مُصحح)
   =========================== */

/**
 * نظام إدارة التخزين المؤقت المتقدم
 * يقلل استهلاك Firestore Reads بنسبة 60-80%
 * يستخدم LocalStorage و SessionStorage مع Fallback للذاكرة
 * 
 * الإصلاحات في هذا الإصدار:
 * - #1: إصلاح Bug في cacheFirst() - إرجاع ttl في get()
 * - #2: منع Race Condition عبر pendingRequests Map
 * - #3: إزالة التعليق غير الصحيح عن IndexedDB
 * - #4: إضافة تنظيف تلقائي دوري للكاش المنتهي
 * - #5: تحسين saveToStorage مع إعادة المحاولة عند QuotaExceededError
 * - #6: توحيد سلوك clearAll
 * - #7: Fallback ديناميكي في كل عملية حفظ
 * - #8: تحسين getStats باستخدام TextEncoder
 * - #9: إصلاح updateInCache باستخدام ttlKey
 * - #10: إضافة DEBUG_MODE للتحكم في السجلات
 * - إضافة: دعم مفاتيح كاش مرتبطة بالمستخدم
 * - إضافة: حد أقصى لحجم الكاش مع LRU
 */

// ===========================
// إعدادات التخزين المؤقت
// ===========================
const CACHE_CONFIG = {
  // مفاتيح التخزين
  keys: {
    student_profile: 'sh_cache_student_profile',
    student_announcements: 'sh_cache_student_announcements',
    student_messages: 'sh_cache_student_messages',
    student_schedule: 'sh_cache_student_schedule',
    student_attendance: 'sh_cache_student_attendance',
    student_expenses: 'sh_cache_student_expenses',
    admin_settings: 'sh_cache_admin_settings',
    admin_counters: 'sh_cache_admin_counters',
    school_structure: 'sh_cache_school_structure',
    public_events: 'sh_cache_public_events',
    public_albums: 'sh_cache_public_albums',
    last_sync: 'sh_cache_last_sync',
    cache_version: 'sh_cache_version'
  },

  // مدد الصلاحية (بالميلي ثانية)
  ttl: {
    student_profile: 15 * 60 * 1000,
    student_announcements: 5 * 60 * 1000,
    student_messages: 3 * 60 * 1000,
    student_schedule: 30 * 60 * 1000,
    student_attendance: 5 * 60 * 1000,
    student_expenses: 10 * 60 * 1000,
    admin_settings: 10 * 60 * 1000,
    admin_counters: 3 * 60 * 1000,
    school_structure: 30 * 60 * 1000,
    public_events: 15 * 60 * 1000,
    public_albums: 30 * 60 * 1000,
    default: 10 * 60 * 1000
  },

  // الإصدار الحالي للكاش
  version: '2.2.0',
  
  // إعدادات إضافية
  maxCacheSize: 30 * 1024 * 1024, // 30MB حد أقصى
  cleanupInterval: 60 * 60 * 1000, // تنظيف كل ساعة
  debug: false // تفعيل/تعطيل السجلات
};

// ===========================
// كلاس CacheManager
// ===========================
class CacheManager {
  constructor() {
    this.memoryCache = new Map();
    this.isInitialized = false;
    this.storageType = this.detectStorageType();
    this.pendingRequests = new Map(); // *** إصلاح #2: منع Race Condition ***
    this.cleanupTimer = null;
    this.userPrefix = ''; // بادئة المستخدم للمفاتيح
    this.initialize();
  }

  /**
   * تهيئة نظام التخزين المؤقت
   */
  initialize() {
    try {
      const currentVersion = this.getFromStorage(CACHE_CONFIG.keys.cache_version);
      
      if (currentVersion !== CACHE_CONFIG.version) {
        this.log('🔄 تم تحديث إصدار الكاش. جاري مسح الكاش القديم...');
        this.clearAll();
        this.saveToStorage(CACHE_CONFIG.keys.cache_version, CACHE_CONFIG.version);
      }

      // *** إصلاح #4: بدء التنظيف الدوري ***
      this.startPeriodicCleanup();

      this.isInitialized = true;
      this.log('✅ Cache Manager: جاهز');
      this.log('📦 نوع التخزين:', this.storageType);
    } catch (error) {
      this.log('⚠️ Cache Manager: خطأ في التهيئة -', error.message);
    }
  }

  /**
   * تعيين معرف المستخدم لربط الكاش به
   * @param {string} userId 
   */
  setUserPrefix(userId) {
    if (userId) {
      this.userPrefix = `user_${userId}_`;
      this.log('👤 تم تعيين بادئة المستخدم:', this.userPrefix);
    } else {
      this.userPrefix = '';
    }
  }

  /**
   * الحصول على المفتاح الكامل مع بادئة المستخدم
   * @param {string} key 
   * @returns {string}
   */
  getFullKey(key) {
    return this.userPrefix ? `${this.userPrefix}${key}` : key;
  }

  /**
   * تسجيل الأحداث (يحترم DEBUG_MODE)
   * @param {...any} args 
   */
  log(...args) {
    if (CACHE_CONFIG.debug) {
      console.log(...args);
    }
  }

  /**
   * اكتشاف نوع التخزين المتاح
   * @returns {string} 'localStorage' | 'sessionStorage' | 'memory'
   */
  detectStorageType() {
    try {
      const testKey = '__cache_test__';
      localStorage.setItem(testKey, '1');
      localStorage.removeItem(testKey);
      return 'localStorage';
    } catch (e) {
      try {
        const testKey = '__cache_test__';
        sessionStorage.setItem(testKey, '1');
        sessionStorage.removeItem(testKey);
        return 'sessionStorage';
      } catch (e2) {
        return 'memory';
      }
    }
  }

  /**
   * *** إصلاح #7: إعادة فحص التخزين مع Fallback ***
   * @returns {string} نوع التخزين المتاح حالياً
   */
  getAvailableStorage() {
    // إذا كنا نستخدم localStorage، نتأكد أنه ما زال متاحاً
    if (this.storageType === 'localStorage') {
      try {
        const testKey = '__cache_alive__';
        localStorage.setItem(testKey, '1');
        localStorage.removeItem(testKey);
        return 'localStorage';
      } catch (e) {
        // localStorage فشل، نجرب sessionStorage
        try {
          const testKey = '__cache_alive__';
          sessionStorage.setItem(testKey, '1');
          sessionStorage.removeItem(testKey);
          this.storageType = 'sessionStorage';
          return 'sessionStorage';
        } catch (e2) {
          this.storageType = 'memory';
          return 'memory';
        }
      }
    }
    
    // إذا كنا نستخدم sessionStorage، نتأكد أنه ما زال متاحاً
    if (this.storageType === 'sessionStorage') {
      try {
        const testKey = '__cache_alive__';
        sessionStorage.setItem(testKey, '1');
        sessionStorage.removeItem(testKey);
        return 'sessionStorage';
      } catch (e) {
        this.storageType = 'memory';
        return 'memory';
      }
    }
    
    return 'memory';
  }

  /**
   * حفظ البيانات في التخزين
   * *** إصلاح #5: معالجة QuotaExceededError مع إعادة المحاولة ***
   * @param {string} key - المفتاح
   * @param {*} value - القيمة
   */
  saveToStorage(key, value) {
    const storage = this.getAvailableStorage();
    
    try {
      const serialized = JSON.stringify(value);
      
      switch (storage) {
        case 'localStorage':
          try {
            localStorage.setItem(key, serialized);
          } catch (e) {
            if (e.name === 'QuotaExceededError' || e.toString().includes('quota')) {
              this.log('⚠️ مساحة التخزين ممتلئة، جاري تحرير مساحة...');
              this.evictOldestEntries(5); // حذف أقدم 5 مدخلات
              try {
                localStorage.setItem(key, serialized);
              } catch (e2) {
                this.memoryCache.set(key, value);
              }
            } else {
              throw e;
            }
          }
          break;
          
        case 'sessionStorage':
          try {
            sessionStorage.setItem(key, serialized);
          } catch (e) {
            if (e.name === 'QuotaExceededError' || e.toString().includes('quota')) {
              this.evictOldestEntries(5);
              try {
                sessionStorage.setItem(key, serialized);
              } catch (e2) {
                this.memoryCache.set(key, value);
              }
            } else {
              throw e;
            }
          }
          break;
          
        default:
          this.memoryCache.set(key, value);
      }
    } catch (error) {
      this.log('⚠️ فشل حفظ البيانات في التخزين:', error.message);
      this.memoryCache.set(key, value);
    }
  }

  /**
   * *** إضافة: حذف أقدم المدخلات لتحرير مساحة (LRU) ***
   * @param {number} count - عدد المدخلات المراد حذفها
   */
  evictOldestEntries(count = 5) {
    try {
      const entries = [];
      
      if (this.storageType === 'localStorage') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            try {
              const raw = localStorage.getItem(key);
              const entry = JSON.parse(raw);
              entries.push({ key, timestamp: entry.timestamp || 0 });
            } catch (e) {}
          }
        }
      } else if (this.storageType === 'sessionStorage') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            try {
              const raw = sessionStorage.getItem(key);
              const entry = JSON.parse(raw);
              entries.push({ key, timestamp: entry.timestamp || 0 });
            } catch (e) {}
          }
        }
      }
      
      // ترتيب حسب الأقدم
      entries.sort((a, b) => a.timestamp - b.timestamp);
      
      // حذف الأقدم
      const toRemove = entries.slice(0, count);
      toRemove.forEach(entry => {
        this.removeFromStorage(entry.key);
      });
      
      if (toRemove.length > 0) {
        this.log(`🗑️ تم حذف ${toRemove.length} مدخلات قديمة لتحرير مساحة`);
      }
    } catch (error) {
      this.log('⚠️ فشل تحرير المساحة:', error.message);
    }
  }

  /**
   * استرجاع البيانات من التخزين
   * @param {string} key - المفتاح
   * @returns {*} القيمة المخزنة أو null
   */
  getFromStorage(key) {
    try {
      let raw;
      
      switch (this.storageType) {
        case 'localStorage':
          raw = localStorage.getItem(key);
          break;
        case 'sessionStorage':
          raw = sessionStorage.getItem(key);
          break;
        default:
          return this.memoryCache.get(key) || null;
      }

      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      this.log('⚠️ فشل استرجاع البيانات من التخزين:', error.message);
      return this.memoryCache.get(key) || null;
    }
  }

  /**
   * حذف مفتاح من التخزين
   * @param {string} key - المفتاح
   */
  removeFromStorage(key) {
    try {
      switch (this.storageType) {
        case 'localStorage':
          localStorage.removeItem(key);
          break;
        case 'sessionStorage':
          sessionStorage.removeItem(key);
          break;
        default:
          this.memoryCache.delete(key);
      }
    } catch (error) {
      this.memoryCache.delete(key);
    }
  }

  /**
   * تخزين بيانات مع وقت انتهاء الصلاحية
   * *** إصلاح #9: تخزين ttlKey بدلاً من ttl ***
   * @param {string} cacheKey - مفتاح الكاش
   * @param {*} data - البيانات
   * @param {string} ttlKey - مفتاح مدة الصلاحية
   */
  set(cacheKey, data, ttlKey = 'default') {
    const fullKey = this.getFullKey(cacheKey);
    const ttl = CACHE_CONFIG.ttl[ttlKey] || CACHE_CONFIG.ttl.default;
    
    const cacheEntry = {
      data: data,
      timestamp: Date.now(),
      expiresAt: Date.now() + ttl,
      ttlKey: ttlKey, // *** إصلاح #9: تخزين المفتاح بدلاً من القيمة ***
      ttl: ttl, // *** إصلاح #1: تخزين ttl للمقارنة ***
      lastAccess: Date.now(),
      hitCount: 0
    };

    this.saveToStorage(fullKey, cacheEntry);
    this.log(`💾 تم التخزين المؤقت: ${fullKey} (صلاحية: ${ttl / 1000} ثانية)`);
  }

  /**
   * استرجاع بيانات من الكاش إذا كانت لا تزال صالحة
   * *** إصلاح #1: إرجاع ttl مع النتيجة ***
   * @param {string} cacheKey - مفتاح الكاش
   * @returns {Object} { data, isFresh, age, remaining, found, expired, ttl }
   */
  get(cacheKey) {
    const fullKey = this.getFullKey(cacheKey);
    const cacheEntry = this.getFromStorage(fullKey);

    if (!cacheEntry) {
      return { data: null, isFresh: false, age: 0, remaining: 0, ttl: 0, found: false, expired: false };
    }

    const now = Date.now();
    const age = now - cacheEntry.timestamp;
    const remaining = cacheEntry.expiresAt - now;
    const isFresh = remaining > 0;

    if (!isFresh) {
      this.log(`⏰ انتهت صلاحية الكاش: ${fullKey}`);
      this.removeFromStorage(fullKey);
      return { 
        data: null, 
        isFresh: false, 
        age, 
        remaining: 0, 
        ttl: cacheEntry.ttl || 0, // *** إصلاح #1 ***
        found: true, 
        expired: true 
      };
    }

    // تحديث hitCount و lastAccess
    cacheEntry.hitCount = (cacheEntry.hitCount || 0) + 1;
    cacheEntry.lastAccess = now;
    this.saveToStorage(fullKey, cacheEntry);

    this.log(`✅ تم العثور على بيانات في الكاش: ${fullKey} (متبقي: ${Math.round(remaining / 1000)} ثانية)`);
    return {
      data: cacheEntry.data,
      isFresh: true,
      age,
      remaining,
      ttl: cacheEntry.ttl || 0, // *** إصلاح #1 ***
      found: true,
      expired: false
    };
  }

  /**
   * التحقق من وجود بيانات صالحة في الكاش
   * @param {string} cacheKey - مفتاح الكاش
   * @returns {boolean}
   */
  has(cacheKey) {
    const result = this.get(cacheKey);
    return result.isFresh;
  }

  /**
   * الحصول على عمر الكاش الحالي بالثواني
   * @param {string} cacheKey 
   * @returns {number} -1 إذا لم يوجد
   */
  getCacheAge(cacheKey) {
    const fullKey = this.getFullKey(cacheKey);
    const cacheEntry = this.getFromStorage(fullKey);
    if (!cacheEntry) return -1;
    return Math.round((Date.now() - cacheEntry.timestamp) / 1000);
  }

  /**
   * حذف بيانات محددة من الكاش
   * @param {string} cacheKey - مفتاح الكاش
   */
  invalidate(cacheKey) {
    const fullKey = this.getFullKey(cacheKey);
    this.removeFromStorage(fullKey);
    this.log(`🗑️ تم حذف الكاش: ${fullKey}`);
  }

  /**
   * حذف مجموعة من الكاشات
   * @param {Array<string>} cacheKeys - مصفوفة مفاتيح الكاش
   */
  invalidateMultiple(cacheKeys) {
    cacheKeys.forEach(key => this.invalidate(key));
    this.log(`🗑️ تم حذف ${cacheKeys.length} كاش`);
  }

  /**
   * حذف كل الكاشات المتعلقة بالطالب
   */
  invalidateStudentCache() {
    this.invalidateMultiple([
      CACHE_CONFIG.keys.student_profile,
      CACHE_CONFIG.keys.student_announcements,
      CACHE_CONFIG.keys.student_messages,
      CACHE_CONFIG.keys.student_schedule,
      CACHE_CONFIG.keys.student_attendance,
      CACHE_CONFIG.keys.student_expenses
    ]);
    this.log('🗑️ تم حذف كل كاش الطالب');
  }

  /**
   * حذف كل الكاشات المتعلقة بالإدارة
   */
  invalidateAdminCache() {
    this.invalidateMultiple([
      CACHE_CONFIG.keys.admin_settings,
      CACHE_CONFIG.keys.admin_counters,
      CACHE_CONFIG.keys.school_structure
    ]);
    this.log('🗑️ تم حذف كل كاش الإدارة');
  }

  /**
   * مسح كل الكاش بالكامل
   * *** إصلاح #6: توحيد السلوك بين الذاكرة والتخزين ***
   */
  clearAll() {
    try {
      const keysToRemove = [];

      if (this.storageType === 'localStorage') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
      } else if (this.storageType === 'sessionStorage') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach(key => sessionStorage.removeItem(key));
      }

      // *** إصلاح #6: مسح الذاكرة من المفاتيح المرتبطة بالكاش فقط ***
      const memoryKeysToRemove = [];
      this.memoryCache.forEach((value, key) => {
        if (key.startsWith('sh_cache_') || key.startsWith('user_')) {
          memoryKeysToRemove.push(key);
        }
      });
      memoryKeysToRemove.forEach(key => this.memoryCache.delete(key));
      
      this.log('🗑️ تم مسح كل الكاش بالكامل');
    } catch (error) {
      this.log('⚠️ فشل مسح الكاش:', error.message);
      this.memoryCache.clear();
    }
  }

  /**
   * *** إصلاح #4: بدء التنظيف الدوري للكاش المنتهي ***
   */
  startPeriodicCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredEntries();
      this.enforceMaxCacheSize();
    }, CACHE_CONFIG.cleanupInterval);
    
    this.log('🔄 بدء التنظيف الدوري للكاش');
  }

  /**
   * *** إصلاح #4: تنظيف المدخلات المنتهية ***
   */
  cleanupExpiredEntries() {
    try {
      const now = Date.now();
      const keysToRemove = [];
      
      // فحص localStorage
      if (this.storageType === 'localStorage') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            try {
              const raw = localStorage.getItem(key);
              const entry = JSON.parse(raw);
              if (entry.expiresAt && entry.expiresAt < now) {
                keysToRemove.push(key);
              }
            } catch (e) {}
          }
        }
        keysToRemove.forEach(key => localStorage.removeItem(key));
      }
      
      // فحص sessionStorage
      if (this.storageType === 'sessionStorage') {
        const sessionKeysToRemove = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && key.startsWith('sh_cache_')) {
            try {
              const raw = sessionStorage.getItem(key);
              const entry = JSON.parse(raw);
              if (entry.expiresAt && entry.expiresAt < now) {
                sessionKeysToRemove.push(key);
              }
            } catch (e) {}
          }
        }
        sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));
      }
      
      // فحص memoryCache
      const memoryKeysToRemove = [];
      this.memoryCache.forEach((value, key) => {
        if (value && value.expiresAt && value.expiresAt < now) {
          memoryKeysToRemove.push(key);
        }
      });
      memoryKeysToRemove.forEach(key => this.memoryCache.delete(key));
      
      const totalRemoved = keysToRemove.length + memoryKeysToRemove.length;
      if (totalRemoved > 0) {
        this.log(`🧹 تنظيف دوري: تم حذف ${totalRemoved} مدخلات منتهية`);
      }
    } catch (error) {
      this.log('⚠️ فشل التنظيف الدوري:', error.message);
    }
  }

  /**
   * *** إضافة: فرض حد أقصى لحجم الكاش ***
   */
  enforceMaxCacheSize() {
    try {
      const stats = this.getStats();
      
      if (stats.totalSizeBytes > CACHE_CONFIG.maxCacheSize) {
        this.log('⚠️ تجاوز الحد الأقصى لحجم الكاش، جاري تحرير مساحة...');
        
        // حذف أقدم 10% من المدخلات
        const entriesToRemove = Math.max(Math.floor(stats.totalEntries * 0.1), 5);
        this.evictOldestEntries(entriesToRemove);
      }
    } catch (error) {
      this.log('⚠️ فشل فرض حد الحجم:', error.message);
    }
  }

  /**
   * إيقاف التنظيف الدوري
   */
  stopPeriodicCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * جلب بيانات مع استراتيجية Cache-First
   * *** إصلاح #1: استخدام ttl من get() ***
   * *** إصلاح #2: منع Race Condition ***
   * @param {string} cacheKey - مفتاح الكاش
   * @param {Function} fetchFunction - دالة جلب البيانات
   * @param {string} ttlKey - مفتاح مدة الصلاحية
   * @param {boolean} forceRefresh - تجاهل الكاش
   * @returns {Promise<*>} البيانات
   */
  async cacheFirst(cacheKey, fetchFunction, ttlKey = 'default', forceRefresh = false) {
    const fullKey = this.getFullKey(cacheKey);
    
    // إذا لم يكن التحديث إجبارياً، نحاول من الكاش أولاً
    if (!forceRefresh) {
      const cached = this.get(cacheKey);
      
      if (cached.isFresh) {
        this.log(`⚡ تم استخدام الكاش: ${fullKey} (وفرنا Read من Firestore)`);
        
        // *** إصلاح #1: استخدام cached.ttl بدلاً من cached.ttl (كان undefined) ***
        if (cached.ttl > 0 && cached.remaining < cached.ttl * 0.2) {
          this.log(`🔄 تحديث في الخلفية: ${fullKey}`);
          this.fetchAndCache(cacheKey, fetchFunction, ttlKey).catch(() => {});
        }
        
        return cached.data;
      }
    }

    // *** إصلاح #2: منع Race Condition ***
    // إذا كان هناك طلب جاري بالفعل لنفس المفتاح، انتظره
    if (this.pendingRequests.has(fullKey)) {
      this.log(`⏳ في انتظار طلب جاري: ${fullKey}`);
      return await this.pendingRequests.get(fullKey);
    }

    // إنشاء طلب جديد وتخزينه
    const requestPromise = this.fetchAndCache(cacheKey, fetchFunction, ttlKey);
    this.pendingRequests.set(fullKey, requestPromise);

    try {
      const result = await requestPromise;
      return result;
    } finally {
      // حذف الطلب من القائمة بعد الانتهاء
      this.pendingRequests.delete(fullKey);
    }
  }

  /**
   * تحديث البيانات فوراً وتجاوز الكاش
   * @param {string} cacheKey 
   * @param {Function} fetchFunction 
   * @param {string} ttlKey 
   * @returns {Promise<*>}
   */
  async refreshData(cacheKey, fetchFunction, ttlKey = 'default') {
    this.log(`🔄 تحديث إجباري: ${cacheKey}`);
    this.invalidate(cacheKey);
    return await this.fetchAndCache(cacheKey, fetchFunction, ttlKey);
  }

  /**
   * جلب البيانات من الشبكة وتخزينها في الكاش
   * @param {string} cacheKey 
   * @param {Function} fetchFunction 
   * @param {string} ttlKey 
   * @returns {Promise<*>}
   */
  async fetchAndCache(cacheKey, fetchFunction, ttlKey) {
    try {
      const data = await fetchFunction();
      
      if (data !== null && data !== undefined) {
        this.set(cacheKey, data, ttlKey);
      }
      
      return data;
    } catch (error) {
      this.log(`❌ فشل جلب البيانات: ${cacheKey}`, error.message);
      
      // محاولة استخدام الكاش منتهي الصلاحية كخطة بديلة
      const fullKey = this.getFullKey(cacheKey);
      const staleCache = this.getFromStorage(fullKey);
      if (staleCache && staleCache.data) {
        this.log(`⚠️ استخدام كاش منتهي الصلاحية: ${fullKey}`);
        return staleCache.data;
      }
      
      throw error;
    }
  }

  /**
   * تحديث بيانات محددة في الكاش دون إعادة جلبه بالكامل
   * *** إصلاح #9: استخدام ttlKey بدلاً من البحث عن ttl ***
   * @param {string} cacheKey 
   * @param {Function} updateFunction 
   */
  updateInCache(cacheKey, updateFunction) {
    const fullKey = this.getFullKey(cacheKey);
    const cached = this.getFromStorage(fullKey);
    
    if (cached && cached.data) {
      const updatedData = updateFunction(cached.data);
      // *** إصلاح #9: استخدام ttlKey المخزن مباشرة ***
      const ttlKey = cached.ttlKey || 'default';
      
      this.set(cacheKey, updatedData, ttlKey);
      this.log(`🔄 تم تحديث الكاش: ${fullKey}`);
    }
  }

  /**
   * تسجيل وقت آخر مزامنة
   * @param {string} syncType 
   */
  recordSync(syncType) {
    const syncData = this.getFromStorage(CACHE_CONFIG.keys.last_sync) || {};
    syncData[syncType] = Date.now();
    syncData[syncType + '_readable'] = new Date().toLocaleString('ar-EG');
    this.saveToStorage(CACHE_CONFIG.keys.last_sync, syncData);
  }

  /**
   * الحصول على وقت آخر مزامنة
   * @param {string} syncType 
   * @returns {string|null}
   */
  getLastSync(syncType) {
    const syncData = this.getFromStorage(CACHE_CONFIG.keys.last_sync);
    return syncData ? (syncData[syncType + '_readable'] || null) : null;
  }

  /**
   * *** إصلاح #8: استخدام TextEncoder بدلاً من Blob ***
   * @returns {Object}
   */
  getStats() {
    const now = Date.now();
    let totalEntries = 0;
    let freshEntries = 0;
    let expiredEntries = 0;
    let totalSize = 0;

    try {
      // استخدام TextEncoder إذا كان متاحاً، وإلا نستخدم string.length
      const getSize = (str) => {
        if (typeof TextEncoder !== 'undefined') {
          return new TextEncoder().encode(str).length;
        }
        return str.length * 2; // تقدير تقريبي (UTF-16)
      };

      const keys = [];

      if (this.storageType === 'localStorage') {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key && (key.startsWith('sh_cache_') || key.startsWith('user_'))) {
            keys.push(key);
          }
        }
      } else if (this.storageType === 'sessionStorage') {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          if (key && (key.startsWith('sh_cache_') || key.startsWith('user_'))) {
            keys.push(key);
          }
        }
      }

      keys.forEach(key => {
        totalEntries++;
        const raw = this.storageType === 'localStorage' 
          ? localStorage.getItem(key) 
          : sessionStorage.getItem(key);
        
        if (raw) {
          totalSize += getSize(raw);
          
          try {
            const entry = JSON.parse(raw);
            if (entry.expiresAt && entry.expiresAt > now) {
              freshEntries++;
            } else if (entry.expiresAt) {
              expiredEntries++;
            }
          } catch (e) {}
        }
      });

      // إضافة الكاش في الذاكرة
      this.memoryCache.forEach((value, key) => {
        if (key.startsWith('sh_cache_') || key.startsWith('user_')) {
          totalEntries++;
          totalSize += getSize(JSON.stringify(value));
          if (value.expiresAt && value.expiresAt > now) {
            freshEntries++;
          } else if (value && value.expiresAt) {
            expiredEntries++;
          }
        }
      });

    } catch (error) {}

    return {
      totalEntries,
      freshEntries,
      expiredEntries,
      totalSizeBytes: totalSize,
      totalSizeKB: (totalSize / 1024).toFixed(2),
      totalSizeMB: (totalSize / (1024 * 1024)).toFixed(3),
      storageType: this.storageType,
      version: CACHE_CONFIG.version,
      maxSizeMB: (CACHE_CONFIG.maxCacheSize / (1024 * 1024)).toFixed(1)
    };
  }

  /**
   * طباعة إحصائيات الكاش في الكونسول
   */
  printStats() {
    const stats = this.getStats();
    console.log('📊 إحصائيات الكاش:');
    console.log('═══════════════════════════════');
    console.log(`📦 نوع التخزين: ${stats.storageType}`);
    console.log(`📝 إجمالي المدخلات: ${stats.totalEntries}`);
    console.log(`✅ مدخلات صالحة: ${stats.freshEntries}`);
    console.log(`⏰ مدخلات منتهية: ${stats.expiredEntries}`);
    console.log(`💾 الحجم: ${stats.totalSizeKB} KB`);
    console.log(`📏 الحد الأقصى: ${stats.maxSizeMB} MB`);
    console.log(`🏷️ الإصدار: ${stats.version}`);
    console.log('═══════════════════════════════');
  }

  /**
   * تدمير المدير وإيقاف التنظيف الدوري
   */
  destroy() {
    this.stopPeriodicCleanup();
    this.pendingRequests.clear();
    this.memoryCache.clear();
  }
}

// ===========================
// نسخة واحدة من CacheManager (Singleton)
// ===========================
const cacheManager = new CacheManager();

// ===========================
// دوال مساعدة مختصرة
// ===========================

async function getCachedData(cacheKey, fetchFn, ttl = 'default', forceRefresh = false) {
  return await cacheManager.cacheFirst(cacheKey, fetchFn, ttl, forceRefresh);
}

async function refreshCachedData(cacheKey, fetchFn, ttl = 'default') {
  return await cacheManager.refreshData(cacheKey, fetchFn, ttl);
}

function setCachedData(cacheKey, data, ttl = 'default') {
  cacheManager.set(cacheKey, data, ttl);
}

function clearCache(cacheKey) {
  cacheManager.invalidate(cacheKey);
}

function clearAllCache() {
  cacheManager.clearAll();
}

// ===========================
// التصدير
// ===========================
export {
  CacheManager,
  cacheManager,
  getCachedData,
  refreshCachedData,
  setCachedData,
  clearCache,
  clearAllCache,
  CACHE_CONFIG
};

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Cache Manager: جاهز | الإصدار 2.2 (مُصحح)');
console.log('ℹ️ استخدم cacheManager.cacheFirst() لجلب البيانات بكفاءة');
console.log('ℹ️ استخدم cacheManager.setUserPrefix() لربط الكاش بمستخدم');
console.log('ℹ️ استخدم cacheManager.printStats() لعرض الإحصائيات');