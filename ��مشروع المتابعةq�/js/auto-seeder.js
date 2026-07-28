/* ===========================
   SCHOOLHUB PRO - SETUP WIZARD
   مدرسة الجيل الجديد الخاصة
   الإصدار: 3.2 (Seed-First Approach)
   =========================== */

/**
 * نظام التهيئة الآمنة لأول تشغيل
 * 
 * المميزات الأمنية (v3.2):
 * - لا يحتوي على أي كلمة مرور افتراضية صلبة
 * - لا يحتوي على أي Pepper افتراضي
 * - الـ Pepper لا يُولَّد في المتصفح ولا يُعرض أبدًا
 * - كلمة المرور تُولَّد عشوائيًا وتُعرض مرة واحدة فقط
 * - [جديد] جميع عمليات التجزئة والإنشاء تتم عبر الـ Worker حصرًا عبر مسار /admin/seed
 * - [جديد] ينشئ المشرف أولاً، ثم يسجل الدخول للحصول على JWT، ثم ينشئ الكولكشنات
 * 
 * طريقة الاستخدام:
 * 1. يستدعى `startSetupWizard()` عند أول تشغيل
 * 2. يُعرض للمسؤول كلمة المرور المؤقتة فقط
 * 3. يجب على المسؤول حفظها فورًا
 * 4. يُنشأ حساب المشرف عبر الـ Worker
 */

import { 
  saveDocument, 
  fetchDocument, 
  getServerTimestamp,
  initializeFirebase,
  isFirebaseReady,
  callAuthWorker
} from './firebase-config.js';

// ===========================
// إعدادات النظام الافتراضية
// ===========================
const DEFAULT_SETTINGS = {
  school_name: "مدرسة الجيل الجديد الخاصة",
  school_name_short: "الجيل الجديد",
  school_motto: "نبني أجيال المستقبل",
  logo_url: "",
  current_academic_year: "2025-2026",
  current_term: "الأول",
  system_version: "3.2.0",
  maintenance_mode: false,
  maintenance_message: "النظام حالياً في وضع الصيانة الدورية. سيتم إعادة التشغيل قريباً. شكراً لتفهمكم.",
  inactive_student_message: "عزيزي الطالب، حسابك غير مفعل حالياً. يرجى التوجه إلى إدارة المدرسة لدفع المصروفات المقررة وتفعيل حسابك.",
  max_students_per_class: 45,
  default_language: "ar",
  timezone: "Africa/Cairo",
  weekend_days: ["friday", "saturday"],
  working_hours_start: "08:00",
  working_hours_end: "15:00",
  createdAt: null,
  updatedAt: null
};

const DEFAULT_COUNTERS = {
  total_students: 0,
  total_active_students: 0,
  total_inactive_students: 0,
  total_admins: 0,
  total_announcements: 0,
  total_messages: 0,
  total_events: 0,
  total_albums: 0,
  total_stages: 0,
  total_classes: 0,
  total_schedules: 0,
  stages_breakdown: {},
  updatedAt: null
};

const DEFAULT_STRUCTURE_INIT = {
  initialized: true,
  initialized_at: null,
  initialized_by: "system",
  version: "3.2.0",
  note: "هذه الوثيقة تؤكد أن هيكل المدرسة قد تم تهيئته. ابدأ بإضافة المراحل الدراسية."
};

// ===========================
// إعدادات المشرف الأول (بدون كلمة مرور صلبة!)
// ===========================
const DEFAULT_ADMIN_BLUEPRINT = {
  username: "admin",
  display_name: "المدير العام",
  role: "super_admin",
  permissions: [
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
  last_login: null,
  createdAt: null,
  updatedAt: null
};

// ===========================
// دوال مساعدة
// ===========================

/**
 * توليد سلسلة عشوائية آمنة
 * @param {number} length - طول السلسلة
 * @returns {string} سلسلة عشوائية
 */
function generateSecureString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

/**
 * توليد كلمة مرور عشوائية آمنة
 * @param {number} length - الطول (افتراضي: 16)
 * @returns {string}
 */
function generateRandomPassword(length = 16) {
  return generateSecureString(length);
}

// ===========================
// قائمة الكولكشنات المطلوبة
// ===========================
const REQUIRED_COLLECTIONS = [
  {
    name: "settings",
    description: "إعدادات النظام العامة",
    seedDocument: { id: "general", data: DEFAULT_SETTINGS }
  },
  {
    name: "counters",
    description: "عدادات النظام الإحصائية",
    seedDocument: { id: "stats", data: DEFAULT_COUNTERS }
  },
  {
    name: "school_structure",
    description: "هيكل المدرسة (المراحل والفصول)",
    seedDocument: { id: "init", data: DEFAULT_STRUCTURE_INIT }
  },
  {
    name: "admins",
    description: "المشرفين وصلاحياتهم",
    seedDocument: null
  },
  {
    name: "students",
    description: "بيانات الطلاب",
    seedDocument: null
  },
  {
    name: "announcements",
    description: "الإعلانات المدرسية",
    seedDocument: null
  },
  {
    name: "messages",
    description: "الرسائل بين الإدارة والطلاب",
    seedDocument: null
  },
  {
    name: "events",
    description: "الأحداث والأنشطة المدرسية",
    seedDocument: null
  },
  {
    name: "albums",
    description: "معرض الصور والألبومات",
    seedDocument: null
  },
  {
    name: "schedules",
    description: "جداول الحصص",
    seedDocument: null
  },
  {
    name: "attendance",
    description: "الحضور والغياب",
    seedDocument: null
  },
  {
    name: "expenses",
    description: "المصروفات المدرسية",
    seedDocument: null
  },
  {
    name: "notifications",
    description: "الإشعارات والتنبيهات",
    seedDocument: null
  },
  {
    name: "system_logs",
    description: "سجل عمليات النظام",
    seedDocument: null
  }
];

// ===========================
// كلاس الـ SetupWizard
// ===========================
class SetupWizard {
  constructor() {
    this.results = {
      success: [],
      skipped: [],
      failed: [],
      total: REQUIRED_COLLECTIONS.length,
      completed: 0
    };
    this.startTime = null;
    this.endTime = null;
    this.generatedPassword = null;
    this.adminToken = null; // [v3.2] لتخزين JWT بعد تسجيل الدخول التلقائي
  }

  /**
   * بدء معالج الإعداد لأول تشغيل
   * @returns {Promise<Object>} نتائج التهيئة + بيانات الاعتماد المؤقتة
   */
  async startSetup() {
    console.log('🚀 بدء معالج الإعداد الآمن (v3.2 - Seed-First)...');
    console.log('🔐 جاري توليد كلمة المرور المؤقتة...');
    console.log('🛡️ الـ Pepper لا يُولَّد هنا — يُدَار عبر متغيرات بيئة الـ Worker فقط.');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    this.startTime = Date.now();

    // التأكد من جاهزية Firebase
    if (!isFirebaseReady()) {
      initializeFirebase();
      await this.delay(1000);
    }

    // التحقق من وجود تهيئة سابقة
    const alreadyInitialized = await this.checkIfInitialized();
    
    if (alreadyInitialized) {
      console.log('ℹ️ النظام مهيأ مسبقاً. جاري التحقق من سلامة الكولكشنات...');
      await this.verifyExistingCollections();
      return this.buildResult(false);
    }

    // ══════════════════════════════════════
    // أول تشغيل: توليد كلمة مرور آمنة فقط
    // ══════════════════════════════════════
    
    // توليد كلمة مرور عشوائية (الـ Pepper في متغيرات البيئة)
    this.generatedPassword = generateRandomPassword(16);
    
    console.log('🆕 أول تشغيل للنظام.');
    console.log('📤 الخطوة 1: إنشاء حساب المشرف عبر /admin/seed...');
    
    // [v3.2] الخطوة 1: إنشاء حساب المشرف أولاً عبر مسار /admin/seed
    await this.createAdminViaSeed();
    
    // [v3.2] الخطوة 2: تسجيل الدخول تلقائياً للحصول على JWT
    await this.autoLogin();
    
    // [v3.2] الخطوة 3: إنشاء باقي الكولكشنات باستخدام JWT
    console.log('📤 الخطوة 3: إنشاء هيكل قاعدة البيانات...');
    await this.createBaseCollections();
    
    // عرض بيانات الاعتماد بشكل آمن (كلمة المرور فقط)
    this.displayCredentials();

    this.endTime = Date.now();
    const duration = ((this.endTime - this.startTime) / 1000).toFixed(2);

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`✅ اكتملت التهيئة في ${duration} ثانية`);

    return this.buildResult(true);
  }

  /**
   * [v3.2] إنشاء حساب المشرف الأول عبر مسار /admin/seed
   */
  async createAdminViaSeed() {
    try {
      console.log('🔐 جاري إنشاء حساب المشرف الأول عبر /admin/seed...');
      
      const adminData = {
        username: DEFAULT_ADMIN_BLUEPRINT.username,
        display_name: DEFAULT_ADMIN_BLUEPRINT.display_name,
        password: this.generatedPassword,
        role: DEFAULT_ADMIN_BLUEPRINT.role,
        permissions: DEFAULT_ADMIN_BLUEPRINT.permissions,
        documentId: 'master_admin'
      };

      const result = await callAuthWorker('/admin/seed', adminData);
      
      if (result.success) {
        console.log('✅ admins/master_admin: تم إنشاء حساب المشرف بنجاح');
        this.results.success.push('admins');
      } else {
        throw new Error(result.error?.message || 'فشل غير معروف');
      }
      
      this.results.completed++;
    } catch (error) {
      console.error('❌ فشل إنشاء حساب المشرف:', error.message);
      this.results.failed.push({
        collection: 'admins',
        error: error.message
      });
      throw error; // [v3.2] إيقاف التهيئة إذا فشل إنشاء المشرف
    }
  }

  /**
   * [v3.2] تسجيل الدخول تلقائياً للحصول على JWT
   */
  async autoLogin() {
    try {
      console.log('🔑 جاري تسجيل الدخول التلقائي للحصول على صلاحيات المشرف...');
      
      const result = await callAuthWorker('/auth/admin/login', {
        username: DEFAULT_ADMIN_BLUEPRINT.username,
        password: this.generatedPassword
      });
      
      if (result.success && result.session?.token) {
        this.adminToken = result.session.token;
        // تخزين الجلسة في localStorage ليتم استخدامها من قبل auth-system
        localStorage.setItem('sh_token', this.adminToken);
        localStorage.setItem('sh_user', JSON.stringify(result.admin));
        console.log('✅ تم تسجيل الدخول بنجاح. الصلاحيات جاهزة لإنشاء الكولكشنات.');
      } else {
        throw new Error('لم يتم الحصول على جلسة صالحة');
      }
    } catch (error) {
      console.error('❌ فشل تسجيل الدخول التلقائي:', error.message);
      throw error;
    }
  }

  /**
   * إنشاء الكولكشنات الأساسية (ما عدا admins — تم إنشاؤه مسبقاً)
   */
  async createBaseCollections() {
    console.log('🏗️ جاري إنشاء هيكل قاعدة البيانات...');
    
    for (const collection of REQUIRED_COLLECTIONS) {
      if (collection.name === 'admins') {
        continue; // تم إنشاؤه مسبقاً عبر /admin/seed
      }
      
      await this.createDocument(collection);
      this.results.completed++;
      
      const progress = Math.round((this.results.completed / this.results.total) * 100);
      console.log(`📊 التقدم: ${progress}% (${this.results.completed}/${this.results.total})`);
    }
  }

  /**
   * عرض بيانات الاعتماد للمسؤول (كلمة المرور فقط)
   */
  displayCredentials() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     🔐 بيانات الاعتماد المؤقتة - تحذير هام      ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  اسم المستخدم: admin                            ║`);
    console.log(`║  كلمة المرور:  ${this.generatedPassword}          ║`);
    console.log('╠══════════════════════════════════════════════════╣');
    console.log('║  ⚠️  احفظ كلمة المرور هذه فورًا!               ║');
    console.log('║  ⚠️  لن تظهر مرة أخرى بعد إغلاق هذه الصفحة!    ║');
    console.log('║  ⚠️  يجب تغيير كلمة المرور عند أول تسجيل دخول  ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');
  }

  /**
   * بناء نتيجة الإعداد
   * @param {boolean} isFirstRun - هل هذا أول تشغيل
   * @returns {Object}
   */
  buildResult(isFirstRun) {
    const duration = this.endTime 
      ? ((this.endTime - this.startTime) / 1000).toFixed(2) + 's'
      : 'N/A';

    const result = {
      success: this.results.failed.length === 0,
      results: this.results,
      duration: duration,
      isFirstRun: isFirstRun
    };

    if (isFirstRun && this.generatedPassword) {
      result.credentials = {
        username: 'admin',
        password: this.generatedPassword,
        warning: 'احفظ كلمة المرور هذه فورًا. لن تظهر مرة أخرى.',
        mustChangePassword: true
      };
    }

    return result;
  }

  /**
   * التحقق مما إذا كان النظام قد تمت تهيئته مسبقاً
   * @returns {Promise<boolean>}
   */
  async checkIfInitialized() {
    try {
      // [v3.2] استخدام callAuthWorker مباشرة لتجنب مشاكل الصلاحيات
      const result = await callAuthWorker('/data/read', {
        collection: "settings",
        documentId: "general"
      });
      
      if (result && result.document) {
        console.log('✅ النظام مهيأ مسبقاً (الإصدار: ' + (result.document.system_version || 'غير معروف') + ')');
        return true;
      }
      return false;
    } catch (error) {
      console.log('ℹ️ لم يتم العثور على تهيئة سابقة');
      return false;
    }
  }

  /**
   * التحقق من سلامة الكولكشنات الموجودة
   */
  async verifyExistingCollections() {
    console.log('🔍 جاري التحقق من سلامة الكولكشنات...');
    
    for (const collection of REQUIRED_COLLECTIONS) {
      try {
        if (collection.name === 'admins') {
          const result = await callAuthWorker('/data/read', {
            collection: 'admins',
            documentId: 'master_admin'
          });
          
          if (!result.document) {
            console.log('⚠️ حساب المشرف مفقود. يجب إعادة التهيئة.');
            this.results.failed.push({
              collection: 'admins',
              error: 'حساب المشرف مفقود'
            });
          } else {
            console.log('✓ admins/master_admin: سليم');
            this.results.skipped.push('admins');
          }
          this.results.completed++;
          continue;
        }

        if (collection.seedDocument) {
          const result = await callAuthWorker('/data/read', {
            collection: collection.name,
            documentId: collection.seedDocument.id
          });

          if (!result.document) {
            console.log(`⚠️ الكولكشن ${collection.name}: الوثيقة ${collection.seedDocument.id} مفقودة. جاري إعادة إنشائها...`);
            await this.createDocument(collection);
          } else {
            console.log(`✓ ${collection.name}: سليم`);
            this.results.skipped.push(collection.name);
          }
        } else {
          console.log(`✓ ${collection.name}: سليم (فارغ)`);
          this.results.skipped.push(collection.name);
        }
      } catch (error) {
        console.log(`⚠️ ${collection.name}: خطأ في التحقق. جاري محاولة الإصلاح...`);
        try {
          await this.createDocument(collection);
        } catch (repairError) {
          this.results.failed.push({
            collection: collection.name,
            error: repairError.message
          });
        }
      }
      this.results.completed++;
    }
  }

  /**
   * إنشاء وثيقة في كولكشن محدد
   * @param {Object} collection - تعريف الكولكشن
   */
  async createDocument(collection) {
    try {
      if (collection.seedDocument) {
        const dataWithTimestamp = {
          ...collection.seedDocument.data,
          createdAt: getServerTimestamp(),
          updatedAt: getServerTimestamp()
        };

        await saveDocument(
          collection.name,
          collection.seedDocument.id,
          dataWithTimestamp,
          false
        );

        console.log(`✅ ${collection.name}/${collection.seedDocument.id}: تم الإنشاء بنجاح`);
        this.results.success.push(collection.name);
      } else {
        try {
          const tempId = `_temp_init_${Date.now()}`;
          await saveDocument(collection.name, tempId, {
            _temp: true,
            _note: "وثيقة مؤقتة لإنشاء الكولكشن. ستحذف تلقائياً.",
            createdAt: getServerTimestamp()
          }, false);
          
          const { removeDocument } = await import('./firebase-config.js');
          await removeDocument(collection.name, tempId);
          
          console.log(`✅ ${collection.name}: تم إنشاء الكولكشن (فارغ)`);
          this.results.success.push(collection.name);
        } catch (tempError) {
          console.log(`✅ ${collection.name}: تم إنشاء الكولكشن`);
          this.results.success.push(collection.name);
        }
      }
    } catch (error) {
      console.error(`❌ ${collection.name}: فشل الإنشاء - ${error.message}`);
      this.results.failed.push({
        collection: collection.name,
        error: error.message
      });
    }
  }

  /**
   * طباعة تقرير مفصل عن الكولكشنات
   */
  printReport() {
    console.log('\n📊 تقرير التهيئة:');
    console.log('═══════════════════════════════');
    console.log(`✓ تم إنشاء: ${this.results.success.length} كولكشن`);
    console.log(`⊘ تم تخطي: ${this.results.skipped.length} كولكشن`);
    console.log(`✗ فشل: ${this.results.failed.length} كولكشن`);
    
    if (this.results.success.length > 0) {
      console.log('\n✅ الكولكشنات التي تم إنشاؤها:');
      this.results.success.forEach(name => console.log(`   • ${name}`));
    }
    
    if (this.results.skipped.length > 0) {
      console.log('\n⊘ الكولكشنات التي تم تخطيها (موجودة مسبقاً):');
      this.results.skipped.forEach(name => console.log(`   • ${name}`));
    }
    
    if (this.results.failed.length > 0) {
      console.log('\n❌ الكولكشنات التي فشل إنشاؤها:');
      this.results.failed.forEach(item => {
        console.log(`   • ${item.collection}: ${item.error}`);
      });
    }
    
    console.log('═══════════════════════════════\n');
  }

  /**
   * تأخير التنفيذ
   * @param {number} ms - المدة بالميلي ثانية
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ===========================
// دوال مساعدة للاستخدام المباشر
// ===========================

/**
 * بدء معالج الإعداد لأول تشغيل
 * @param {boolean} showReport - عرض تقرير في الكونسول
 * @returns {Promise<Object>} نتيجة التهيئة + بيانات الاعتماد (لأول مرة فقط)
 */
async function startSetupWizard(showReport = true) {
  const wizard = new SetupWizard();
  const result = await wizard.startSetup();
  
  if (showReport) {
    wizard.printReport();
  }
  
  return result;
}

/**
 * الحصول على حالة النظام الحالية
 * @returns {Promise<Object>}
 */
async function checkSystemStatus() {
  try {
    const settings = await fetchDocument("settings", "general");
    const counters = await fetchDocument("counters", "stats");
    const structure = await fetchDocument("school_structure", "init");
    
    return {
      is_initialized: !!(settings && structure),
      version: settings?.system_version || "غير معروف",
      school_name: settings?.school_name || "غير محدد",
      academic_year: settings?.current_academic_year || "غير محدد",
      term: settings?.current_term || "غير محدد",
      maintenance_mode: settings?.maintenance_mode || false,
      statistics: counters || null,
      first_initialized: structure?.initialized_at || null,
      last_checked: new Date().toISOString()
    };
  } catch (error) {
    return {
      is_initialized: false,
      error: error.message,
      last_checked: new Date().toISOString()
    };
  }
}

// ===========================
// التصدير
// ===========================
export {
  SetupWizard,
  startSetupWizard,
  checkSystemStatus,
  REQUIRED_COLLECTIONS,
  DEFAULT_SETTINGS,
  DEFAULT_COUNTERS,
  DEFAULT_ADMIN_BLUEPRINT
};

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Setup Wizard: جاهز | الإصدار 3.2 (Seed-First Approach)');
console.log('🔐 لا توجد كلمات مرور افتراضية صلبة في هذا الإصدار');
console.log('🛡️ الـ Pepper لا يُولَّد ولا يُعرض في المتصفح — يُدَار عبر متغيرات البيئة');
console.log('🆕 [v3.2] الأولوية لإنشاء المشرف عبر /admin/seed، ثم إنشاء الكولكشنات');
console.log('ℹ️ استخدم startSetupWizard() لبدء معالج الإعداد');
console.log('ℹ️ استخدم checkSystemStatus() للتحقق من حالة النظام');