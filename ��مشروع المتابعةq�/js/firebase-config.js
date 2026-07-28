/* ===========================
   SCHOOLHUB PRO - FIREBASE CONFIG
   مدرسة الجيل الجديد الخاصة
   الإصدار: 3.0 (جميع العمليات عبر Worker)
   =========================== */

/**
 * وحدة تهيئة Firebase المركزية
 * يتم استيراد هذا الملف مرة واحدة فقط في كل صفحة
 * يوفر دوال جاهزة للتعامل مع Firestore و Storage
 * 
 * ⚠️ تغيير جوهري في v3.0:
 * جميع عمليات القراءة والكتابة تمر عبر Cloudflare Worker حصرًا.
 * قواعد Firestore يجب أن تكون: allow read, write: if false;
 * 
 * الإصلاحات في هذا الإصدار:
 * - #1: نقل العمليات الحساسة إلى Auth Worker
 * - #2: updateDocument مع createIfMissing اختياري
 * - #3: executeBatch يستخدم set+merge لتفادي الفشل (مع تحذير)
 * - #4: تقسيم تلقائي للـ Batch إذا تجاوز 500 عملية
 * - #5: تحسين Pagination بجلب limit+1
 * - #6: إعادة محاولة تهيئة Firebase تلقائياً
 * - #7: تحسين uploadFile مع اسم ملف آمن وMetadata
 * - #8: تحسين validateFile بفحص الامتداد الحقيقي
 * - #9: إزالة measurementId غير المستخدم
 * - #10: تحسينات عامة في الكود والأداء
 * - #11: [v2.3] إصلاح executeBatch - عدم إنشاء وثائق غير مقصودة
 * - #12: [v2.3] تحديث رابط Worker الفعلي
 * - #13: [v3.0] جميع عمليات القراءة/الكتابة عبر Worker (حل التناقض المعماري)
 */

// ===========================
// استيراد مكتبات Firebase
// ===========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js";
import { 
  getFirestore, 
  doc, 
  getDoc, 
  getDocs, 
  setDoc, 
  updateDoc, 
  deleteDoc, 
  collection, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter, 
  writeBatch, 
  serverTimestamp, 
  increment, 
  arrayUnion, 
  arrayRemove, 
  onSnapshot, 
  enableIndexedDbPersistence,
  runTransaction
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js";
import { 
  getStorage, 
  ref, 
  uploadBytes, 
  getDownloadURL, 
  deleteObject, 
  listAll,
  uploadBytesResumable,
  getMetadata,
  updateMetadata
} from "https://www.gstatic.com/firebasejs/12.6.0/firebase-storage.js";

// ===========================
// إعدادات Firebase
// ===========================
const firebaseConfig = {
  apiKey: "AIzaSyDt7ous1vSxA6LuPS4VmlB80AUTuL6Q10U",
  authDomain: "elgeel-f4e0d.firebaseapp.com",
  projectId: "elgeel-f4e0d",
  storageBucket: "elgeel-f4e0d.firebasestorage.app",
  messagingSenderId: "87722465380",
  appId: "1:87722465380:web:3b5b1943372ab6167aa771"
};

// ===========================
// إعدادات Auth Worker (v3.0 - طبقة وصول موحدة)
// ===========================

/**
 * رابط Cloudflare Worker للمصادقة وجميع عمليات البيانات
 */
const AUTH_WORKER_URL = 'https://floral-moon-768e.hjgfc254.workers.dev';

/**
 * استدعاء Worker للعمليات العامة (مصادقة + بيانات)
 * 
 * @param {string} endpoint - المسار النسبي
 * @param {Object} data - البيانات
 * @param {string} method - نوع الطلب
 * @returns {Promise<Object>}
 */
async function callAuthWorker(endpoint, data = {}, method = 'POST') {
  try {
    let token = null;
    try {
      if (typeof authManager !== 'undefined' && authManager.getToken) {
        token = authManager.getToken();
      }
    } catch (e) {
      // authManager غير متوفر، نستخدم localStorage
    }
    
    if (!token) {
      token = localStorage.getItem('sh_token') || sessionStorage.getItem('sh_token');
    }
    
    const options = {
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    if (token) {
      options.headers['Authorization'] = `Bearer ${token}`;
    }

    if (method !== 'GET' && Object.keys(data).length > 0) {
      options.body = JSON.stringify(data);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);
    options.signal = controller.signal;

    const response = await fetch(`${AUTH_WORKER_URL}${endpoint}`, options);
    clearTimeout(timeoutId);

    const result = await response.json();

    if (!response.ok || !result.success) {
      throw new Error(result.error?.message || `خطأ في الخادم (${response.status})`);
    }

    return result;
  } catch (error) {
    console.error(`❌ Auth Worker error [${endpoint}]:`, error.message);
    throw error;
  }
}

/**
 * [v3.0] دالة موحدة لطلبات البيانات عبر Worker
 * تستخدم للقراءة والكتابة والحذف والـ batch
 * 
 * @param {string} endpoint - المسار (/data/read, /data/query, /data/write, /data/delete, /data/batch, /data/increment)
 * @param {Object} data - البيانات المرسلة
 * @returns {Promise<Object>}
 */
async function workerDataRequest(endpoint, data = {}) {
  return await callAuthWorker(endpoint, data, 'POST');
}

// ===========================
// إعدادات الملفات المسموح بها
// ===========================
const ALLOWED_FILE_TYPES = {
  // الصور
  'image/jpeg': { maxSize: 5 * 1024 * 1024, label: 'JPEG', extensions: ['.jpg', '.jpeg'] },
  'image/png': { maxSize: 5 * 1024 * 1024, label: 'PNG', extensions: ['.png'] },
  'image/gif': { maxSize: 5 * 1024 * 1024, label: 'GIF', extensions: ['.gif'] },
  'image/webp': { maxSize: 5 * 1024 * 1024, label: 'WebP', extensions: ['.webp'] },
  
  // المستندات
  'application/pdf': { maxSize: 10 * 1024 * 1024, label: 'PDF', extensions: ['.pdf'] },
  'application/msword': { maxSize: 10 * 1024 * 1024, label: 'Word', extensions: ['.doc'] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { 
    maxSize: 10 * 1024 * 1024, label: 'Word', extensions: ['.docx'] 
  },
  'application/vnd.ms-excel': { maxSize: 10 * 1024 * 1024, label: 'Excel', extensions: ['.xls'] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { 
    maxSize: 10 * 1024 * 1024, label: 'Excel', extensions: ['.xlsx'] 
  },
  
  // الملفات النصية
  'text/csv': { maxSize: 5 * 1024 * 1024, label: 'CSV', extensions: ['.csv'] },
  'text/plain': { maxSize: 5 * 1024 * 1024, label: 'Text', extensions: ['.txt'] }
};

const DEFAULT_MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB افتراضي

// ===========================
// الامتدادات الممنوعة تماماً
// ===========================
const BLOCKED_EXTENSIONS = [
  '.exe', '.dll', '.so', '.dylib',
  '.bat', '.cmd', '.sh', '.bash', '.ps1',
  '.php', '.phtml', '.php3', '.php4', '.php5',
  '.js', '.mjs', '.cjs',
  '.vbs', '.vbe',
  '.msi', '.apk', '.ipa',
  '.scr', '.pif', '.cpl',
  '.hta', '.jar', '.jnlp'
];

// ===========================
// تهيئة Firebase (إصلاح #6: إعادة المحاولة التلقائية)
// ===========================
let app = null;
let db = null;
let storage = null;
let isInitialized = false;
let initError = null;
let initAttempts = 0;
const MAX_INIT_ATTEMPTS = 3;

/**
 * تهيئة Firebase مرة واحدة
 * إصلاح #6: السماح بإعادة المحاولة عند الفشل
 * @param {boolean} forceRetry - إعادة المحاولة حتى لو كان مهيأ مسبقاً
 * @returns {Object} { app, db, storage, isInitialized, error }
 */
function initializeFirebase(forceRetry = false) {
  // إذا كان مهيأ مسبقاً ولا نريد إعادة المحاولة
  if (isInitialized && !forceRetry) {
    return { app, db, storage, isInitialized: true, error: null };
  }

  // إعادة تعيين إذا كانت إعادة محاولة
  if (forceRetry) {
    isInitialized = false;
    initError = null;
  }

  try {
    app = initializeApp(firebaseConfig);
    db = getFirestore(app);
    storage = getStorage(app);
    isInitialized = true;
    initError = null;
    initAttempts = 0;

    // محاولة تفعيل التخزين المؤقت المحلي
    enableOfflinePersistence();

    console.log('✅ Firebase initialized successfully');
    console.log('📦 Project:', firebaseConfig.projectId);
    console.log('🗄️ Firestore:', 'Ready');
    console.log('📁 Storage:', 'Ready');

    return { app, db, storage, isInitialized: true, error: null };
  } catch (error) {
    initError = error;
    isInitialized = false;
    initAttempts++;
    
    console.error(`❌ Firebase initialization failed (attempt ${initAttempts}/${MAX_INIT_ATTEMPTS}):`, error.message);
    
    return { app: null, db: null, storage: null, isInitialized: false, error };
  }
}

/**
 * التأكد من أن Firebase مهيأ قبل الاستخدام
 * إصلاح #6: إعادة المحاولة تلقائياً
 */
function ensureInitialized() {
  if (!isInitialized && initAttempts < MAX_INIT_ATTEMPTS) {
    console.log('🔄 إعادة محاولة تهيئة Firebase تلقائياً...');
    return initializeFirebase(true);
  }
  
  if (!isInitialized) {
    const result = initializeFirebase();
    if (!result.isInitialized) {
      console.error('❌ Firebase غير مهيأ. يرجى التحقق من الاتصال بالإنترنت.');
    }
    return result;
  }
  
  return { app, db, storage, isInitialized: true, error: null };
}

/**
 * تفعيل التخزين المؤقت المحلي للعمل بدون إنترنت
 */
async function enableOfflinePersistence() {
  if (!db) return;
  
  try {
    await enableIndexedDbPersistence(db);
    console.log('💾 Offline persistence enabled');
  } catch (error) {
    if (error.code === 'failed-precondition') {
      console.warn('⚠️ Offline persistence already enabled in another tab');
    } else if (error.code === 'unimplemented') {
      console.warn('⚠️ Offline persistence not supported in this browser');
    } else {
      console.warn('⚠️ Offline persistence error:', error.message);
    }
  }
}

// ===========================
// دوال مساعدة لـ Firestore
// ===========================

/**
 * الحصول على مرجع لمجموعة
 * @param {string} collectionName - اسم المجموعة
 * @returns {CollectionReference}
 */
function getCollection(collectionName) {
  ensureInitialized();
  return collection(db, collectionName);
}

/**
 * الحصول على مرجع لوثيقة محددة
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @returns {DocumentReference}
 */
function getDocumentRef(collectionName, documentId) {
  ensureInitialized();
  return doc(db, collectionName, documentId);
}

// ===========================
// دوال القراءة (Read) - عبر Worker (v3.0)
// ===========================

/**
 * [v3.0] جلب وثيقة واحدة عبر Worker
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @returns {Promise<Object|null>} بيانات الوثيقة أو null
 */
async function fetchDocument(collectionName, documentId) {
  try {
    const result = await workerDataRequest('/data/read', {
      collection: collectionName,
      documentId: documentId
    });
    
    return result.document || null;
  } catch (error) {
    console.error(`❌ Error fetching document ${collectionName}/${documentId}:`, error.message);
    throw error;
  }
}

/**
 * [v3.0] جلب مجموعة من الوثائق مع فلترة وترتيب وتقسيم صفحات عبر Worker
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {Object} options - خيارات الفلترة
 * @param {Array} options.filters - مصفوفة شروط where [[field, operator, value], ...]
 * @param {string} options.orderByField - حقل الترتيب
 * @param {string} options.orderDirection - اتجاه الترتيب 'asc' أو 'desc'
 * @param {number} options.limitCount - عدد الوثائق المطلوبة
 * @param {string} options.startAfterDoc - معرف آخر وثيقة في الصفحة السابقة
 * @returns {Promise<Object>} { documents, lastVisible, hasMore }
 */
async function fetchDocuments(collectionName, options = {}) {
  try {
    const workerOptions = {};
    
    if (options.filters && Array.isArray(options.filters)) {
      workerOptions.filters = options.filters;
    }
    
    if (options.orderByField) {
      workerOptions.orderByField = options.orderByField;
      workerOptions.orderDirection = options.orderDirection === 'asc' ? 'ASCENDING' : 'DESCENDING';
    }
    
    if (options.limitCount && options.limitCount > 0) {
      workerOptions.limitCount = options.limitCount;
    }
    
    if (options.startAfterDoc) {
      workerOptions.startAfterDoc = options.startAfterDoc;
    }
    
    const result = await workerDataRequest('/data/query', {
      collection: collectionName,
      options: workerOptions
    });
    
    return {
      documents: result.documents || [],
      lastVisible: result.lastVisible || null,
      hasMore: result.hasMore || false
    };
  } catch (error) {
    console.error(`❌ Error fetching documents from ${collectionName}:`, error.message);
    throw error;
  }
}

// ===========================
// دوال الكتابة (Write) - عبر Worker (v3.0)
// ===========================

/**
 * [v3.0] إضافة أو تحديث وثيقة عبر Worker
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة (اختياري)
 * @param {Object} data - البيانات
 * @param {boolean} merge - دمج البيانات مع الموجودة (افتراضي: true)
 * @returns {Promise<string>} معرف الوثيقة
 */
async function saveDocument(collectionName, documentId, data, merge = true) {
  try {
    const result = await workerDataRequest('/data/write', {
      collection: collectionName,
      documentId: documentId || null,
      data: data,
      merge: merge
    });
    
    console.log(`✅ Document saved: ${collectionName}/${result.documentId || documentId}`);
    return result.documentId || documentId;
  } catch (error) {
    console.error(`❌ Error saving document to ${collectionName}:`, error.message);
    throw error;
  }
}

/**
 * [v3.0] تحديث حقول محددة في وثيقة عبر Worker
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @param {Object} data - البيانات المراد تحديثها
 * @param {Object} options - خيارات إضافية
 * @param {boolean} options.createIfMissing - إنشاء الوثيقة إذا لم تكن موجودة (افتراضي: false)
 * @returns {Promise<void>}
 */
async function updateDocument(collectionName, documentId, data, options = {}) {
  const { createIfMissing = false } = options;
  
  try {
    await workerDataRequest('/data/write', {
      collection: collectionName,
      documentId: documentId,
      data: data,
      merge: true,
      createIfMissing: createIfMissing
    });
    
    console.log(`✅ Document updated: ${collectionName}/${documentId}`);
  } catch (error) {
    console.error(`❌ Error updating document ${collectionName}/${documentId}:`, error.message);
    throw error;
  }
}

/**
 * [v3.0] حذف وثيقة عبر Worker
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @returns {Promise<void>}
 */
async function removeDocument(collectionName, documentId) {
  try {
    await workerDataRequest('/data/delete', {
      collection: collectionName,
      documentId: documentId
    });
    
    console.log(`✅ Document deleted: ${collectionName}/${documentId}`);
  } catch (error) {
    console.error(`❌ Error deleting document ${collectionName}/${documentId}:`, error.message);
    throw error;
  }
}

/**
 * حذف وثيقة مع جميع مجموعاتها الفرعية
 * @param {string} collectionName - اسم المجموعة الرئيسية
 * @param {string} documentId - معرف الوثيقة
 * @param {Array<string>} subcollectionNames - أسماء المجموعات الفرعية
 * @returns {Promise<void>}
 */
async function removeDocumentWithSubcollections(collectionName, documentId, subcollectionNames = []) {
  try {
    const operations = [];
    
    // جمع عمليات الحذف من المجموعات الفرعية
    for (const subName of subcollectionNames) {
      try {
        const subResult = await workerDataRequest('/data/query', {
          collection: `${collectionName}/${documentId}/${subName}`,
          options: { limitCount: 500 }
        });
        
        const subDocs = subResult.documents || [];
        subDocs.forEach((subDoc) => {
          operations.push({
            type: 'delete',
            collection: `${collectionName}/${documentId}/${subName}`,
            documentId: subDoc.id
          });
        });
      } catch (e) {
        console.warn(`⚠️ Could not fetch subcollection ${subName}:`, e.message);
      }
    }
    
    // إضافة حذف الوثيقة الرئيسية
    operations.push({
      type: 'delete',
      collection: collectionName,
      documentId: documentId
    });
    
    // تنفيذ الحذف عبر executeBatch
    await executeBatch(operations);
    
    console.log(`✅ Document and subcollections deleted: ${collectionName}/${documentId}`);
  } catch (error) {
    console.error(`❌ Error deleting document with subcollections:`, error.message);
    throw error;
  }
}

/**
 * [v3.0] تنفيذ عمليات متعددة دفعة واحدة عبر Worker
 * 
 * أنواع العمليات المدعومة:
 * - 'set': إنشاء أو استبدال وثيقة بالكامل
 * - 'update': تحديث حقول محددة فقط
 * - 'delete': حذف وثيقة
 * 
 * @param {Array} operations - مصفوفة عمليات [{type, collection, documentId, data}]
 * @returns {Promise<void>}
 */
async function executeBatch(operations) {
  if (!operations || operations.length === 0) {
    console.log('ℹ️ لا توجد عمليات للتنفيذ');
    return;
  }

  try {
    // تحويل الصيغة القديمة (collection, id) إلى الصيغة الجديدة (collection, documentId)
    const normalizedOps = operations.map(op => ({
      type: op.type,
      collection: op.collection,
      documentId: op.documentId || op.id,
      data: op.data || {}
    }));
    
    const result = await workerDataRequest('/data/batch', {
      operations: normalizedOps
    });
    
    if (!result.success) {
      const failedOps = (result.results || []).filter(r => !r.success);
      if (failedOps.length > 0) {
        console.warn(`⚠️ ${failedOps.length} عمليات فشلت من أصل ${result.results.length}`);
      }
    }
    
    console.log(`✅ Batch completed: ${result.completed || operations.length} عمليات`);
  } catch (error) {
    console.error('❌ Error executing batch:', error.message);
    throw error;
  }
}

/**
 * [v3.0] زيادة قيمة حقل عددي عبر Worker
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @param {string} field - اسم الحقل
 * @param {number} amount - مقدار الزيادة
 * @returns {Promise<void>}
 */
async function incrementField(collectionName, documentId, field, amount = 1) {
  try {
    await workerDataRequest('/data/increment', {
      collection: collectionName,
      documentId: documentId,
      field: field,
      amount: amount
    });
    
    console.log(`✅ Field incremented: ${collectionName}/${documentId}.${field} +${amount}`);
  } catch (error) {
    console.error(`❌ Error incrementing field:`, error.message);
    throw error;
  }
}

// ===========================
// دوال العمليات الحساسة - عبر Auth Worker
// ===========================

/**
 * إنشاء طالب جديد (عبر Worker)
 * @param {Object} studentData - بيانات الطالب
 * @returns {Promise<Object>}
 */
async function createStudentViaWorker(studentData) {
  return await callAuthWorker('/admin/students/create', studentData);
}

/**
 * تحديث طالب (عبر Worker)
 * @param {string} studentId - معرف الطالب
 * @param {Object} updateData - بيانات التحديث
 * @returns {Promise<Object>}
 */
async function updateStudentViaWorker(studentId, updateData) {
  return await callAuthWorker('/admin/students/update', { studentId, ...updateData });
}

/**
 * حذف طالب (عبر Worker)
 * @param {string} studentId - معرف الطالب
 * @returns {Promise<Object>}
 */
async function deleteStudentViaWorker(studentId) {
  return await callAuthWorker('/admin/students/delete', { studentId });
}

/**
 * إضافة مشرف (عبر Worker)
 * @param {Object} adminData - بيانات المشرف
 * @returns {Promise<Object>}
 */
async function createAdminViaWorker(adminData) {
  return await callAuthWorker('/admin/admins/create', adminData);
}

/**
 * تحديث مشرف (عبر Worker)
 * @param {string} adminId - معرف المشرف
 * @param {Object} updateData - بيانات التحديث
 * @returns {Promise<Object>}
 */
async function updateAdminViaWorker(adminId, updateData) {
  return await callAuthWorker('/admin/admins/update', { adminId, ...updateData });
}

/**
 * حذف مشرف (عبر Worker)
 * @param {string} adminId - معرف المشرف
 * @returns {Promise<Object>}
 */
async function deleteAdminViaWorker(adminId) {
  return await callAuthWorker('/admin/admins/delete', { adminId });
}

/**
 * تحديث الإعدادات (عبر Worker)
 * @param {Object} settingsData - بيانات الإعدادات
 * @returns {Promise<Object>}
 */
async function updateSettingsViaWorker(settingsData) {
  return await callAuthWorker('/admin/settings/update', settingsData);
}

/**
 * تغيير كلمة مرور طالب (عبر Worker)
 * @param {string} studentId - معرف الطالب
 * @param {string} newPassword - كلمة المرور الجديدة
 * @returns {Promise<Object>}
 */
async function resetStudentPasswordViaWorker(studentId, newPassword) {
  return await callAuthWorker('/admin/students/reset-password', { studentId, password: newPassword });
}

/**
 * تغيير كلمة مرور مشرف (عبر Worker)
 * @param {string} adminId - معرف المشرف
 * @param {string} newPassword - كلمة المرور الجديدة
 * @returns {Promise<Object>}
 */
async function resetAdminPasswordViaWorker(adminId, newPassword) {
  return await callAuthWorker('/admin/admins/reset-password', { adminId, password: newPassword });
}

// ===========================
// دوال Realtime - مباشرة من Firestore (للاستماع فقط)
// ===========================

/**
 * [v3.0] الاستماع للتغييرات على وثيقة (Real-time) - مباشر
 * هذه الدالة الوحيدة التي تستخدم Firestore SDK مباشرة للاستماع الحي.
 * ملاحظة: تتطلب قواعد Firestore مناسبة للقراءة المباشرة.
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {string} documentId - معرف الوثيقة
 * @param {Function} callback - دالة الاستدعاء عند التغيير
 * @returns {Function} دالة إلغاء الاستماع
 */
function listenToDocument(collectionName, documentId, callback) {
  ensureInitialized();
  const docRef = getDocumentRef(collectionName, documentId);
  
  const unsubscribe = onSnapshot(docRef, (docSnap) => {
    if (docSnap.exists()) {
      callback({ id: docSnap.id, ...docSnap.data() });
    } else {
      callback(null);
    }
  }, (error) => {
    console.error(`❌ Error listening to document:`, error.message);
    callback(null, error);
  });

  return unsubscribe;
}

/**
 * [v3.0] الاستماع للتغييرات على مجموعة (Real-time) - مباشر
 * هذه الدالة الوحيدة التي تستخدم Firestore SDK مباشرة للاستماع الحي.
 * ملاحظة: تتطلب قواعد Firestore مناسبة للقراءة المباشرة.
 * 
 * @param {string} collectionName - اسم المجموعة
 * @param {Object} options - خيارات الفلترة
 * @param {Function} callback - دالة الاستدعاء عند التغيير
 * @returns {Function} دالة إلغاء الاستماع
 */
function listenToCollection(collectionName, options, callback) {
  ensureInitialized();
  const colRef = getCollection(collectionName);
  const constraints = [];

  if (options.filters) {
    options.filters.forEach(([field, operator, value]) => {
      constraints.push(where(field, operator, value));
    });
  }

  if (options.orderByField) {
    constraints.push(orderBy(options.orderByField, options.orderDirection || 'desc'));
  }

  if (options.limitCount) {
    constraints.push(limit(options.limitCount));
  }

  const q = query(colRef, ...constraints);

  const unsubscribe = onSnapshot(q, (querySnapshot) => {
    const documents = [];
    querySnapshot.forEach((doc) => {
      documents.push({ id: doc.id, ...doc.data() });
    });
    callback(documents);
  }, (error) => {
    console.error(`❌ Error listening to collection:`, error.message);
    callback([], error);
  });

  return unsubscribe;
}

// ===========================
// دوال Storage
// ===========================

/**
 * توليد اسم ملف آمن وعشوائي
 */
function generateSafeFileName(originalName, prefix = 'file') {
  const lastDot = originalName.lastIndexOf('.');
  const extension = lastDot > 0 ? originalName.substring(lastDot).toLowerCase() : '';
  const safeExtension = extension.replace(/[^a-z0-9.]/g, '').substring(0, 10);
  const randomStr = generateRandomString(12);
  const timestamp = Date.now().toString(36);
  return `${prefix}_${timestamp}_${randomStr}${safeExtension}`;
}

/**
 * توليد سلسلة عشوائية
 */
function generateRandomString(length) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, byte => chars[byte % chars.length]).join('');
}

/**
 * التحقق من صحة الملف قبل الرفع
 */
function validateFile(file, options = {}) {
  if (!file || !(file instanceof File)) {
    return { valid: false, error: 'الملف غير صالح' };
  }

  const fileName = file.name.toLowerCase();
  const fileType = file.type;
  const lastDot = fileName.lastIndexOf('.');
  const extension = lastDot > 0 ? fileName.substring(lastDot) : '';
  
  if (extension && BLOCKED_EXTENSIONS.includes(extension)) {
    return { valid: false, error: `نوع الملف غير مسموح به: ${extension}` };
  }
  
  const dotCount = (fileName.match(/\./g) || []).length;
  if (dotCount > 1) {
    const allowedDouble = ['.tar.gz', '.tar.bz2'];
    const isAllowed = allowedDouble.some(ext => fileName.endsWith(ext));
    if (!isAllowed) {
      return { valid: false, error: 'اسم الملف يحتوي على امتدادات متعددة غير مسموح بها' };
    }
  }
  
  if (extension && ALLOWED_FILE_TYPES[fileType]) {
    const typeInfo = ALLOWED_FILE_TYPES[fileType];
    if (typeInfo.extensions && !typeInfo.extensions.includes(extension)) {
      return { valid: false, error: `امتداد الملف (${extension}) لا يتوافق مع نوعه الحقيقي (${fileType}). النوع المتوقع: ${typeInfo.label}` };
    }
  }

  if (options.allowedTypes && options.allowedTypes.length > 0) {
    if (!options.allowedTypes.includes(fileType)) {
      const allowedLabels = options.allowedTypes.map(type => ALLOWED_FILE_TYPES[type]?.label || type).join(', ');
      return { valid: false, error: `نوع الملف غير مسموح به. الأنواع المسموحة: ${allowedLabels}` };
    }
  } else {
    if (!ALLOWED_FILE_TYPES[fileType]) {
      return { valid: false, error: `نوع الملف غير مدعوم: ${fileType}` };
    }
  }

  const maxSize = options.maxSize || ALLOWED_FILE_TYPES[fileType]?.maxSize || DEFAULT_MAX_FILE_SIZE;
  if (file.size > maxSize) {
    const maxSizeMB = (maxSize / (1024 * 1024)).toFixed(1);
    const fileSizeMB = (file.size / (1024 * 1024)).toFixed(1);
    return { valid: false, error: `حجم الملف كبير جداً (${fileSizeMB}MB). الحد الأقصى: ${maxSizeMB}MB` };
  }

  if (file.size === 0) return { valid: false, error: 'الملف فارغ' };
  if (fileType === 'image/svg+xml') return { valid: false, error: 'ملفات SVG غير مدعومة حالياً لأسباب أمنية' };

  return { valid: true, error: null };
}

/**
 * رفع ملف إلى Firebase Storage
 */
async function uploadFile(path, file, progressCallback = null, options = {}) {
  try {
    ensureInitialized();
    
    const validation = validateFile(file, options);
    if (!validation.valid) throw new Error(validation.error);

    const safeFileName = generateSafeFileName(file.name, options.prefix || 'file');
    const fullPath = path ? `${path}/${safeFileName}` : safeFileName;
    const storageRef = ref(storage, fullPath);
    
    const metadata = {
      contentType: file.type,
      customMetadata: {
        uploadedAt: new Date().toISOString(),
        uploadedBy: options.uploadedBy || 'anonymous',
        originalName: file.name.substring(0, 100),
        fileSize: String(file.size),
        version: '1.0',
        safeFileName: safeFileName
      }
    };
    
    const uploadTask = uploadBytesResumable(storageRef, file, metadata);

    return new Promise((resolve, reject) => {
      uploadTask.on('state_changed',
        (snapshot) => {
          const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
          if (progressCallback) progressCallback(Math.round(progress), snapshot);
        },
        (error) => { console.error('❌ Upload error:', error.message); reject(error); },
        async () => {
          const downloadURL = await getDownloadURL(uploadTask.snapshot.ref);
          console.log(`✅ File uploaded: ${fullPath}`);
          resolve(downloadURL);
        }
      );
    });
  } catch (error) {
    console.error('❌ Error uploading file:', error.message);
    throw error;
  }
}

/**
 * الحصول على رابط تحميل ملف
 */
async function getFileURL(path) {
  try {
    ensureInitialized();
    const storageRef = ref(storage, path);
    return await getDownloadURL(storageRef);
  } catch (error) {
    console.error('❌ Error getting file URL:', error.message);
    throw error;
  }
}

/**
 * حذف ملف من التخزين
 */
async function deleteFile(path) {
  try {
    ensureInitialized();
    const storageRef = ref(storage, path);
    await deleteObject(storageRef);
    console.log('✅ File deleted:', path);
  } catch (error) {
    console.error('❌ Error deleting file:', error.message);
    throw error;
  }
}

/**
 * جلب قائمة الملفات في مجلد
 */
async function listFiles(folderPath) {
  try {
    ensureInitialized();
    const folderRef = ref(storage, folderPath);
    const result = await listAll(folderRef);
    
    const files = await Promise.all(
      result.items.map(async (itemRef) => {
        const url = await getDownloadURL(itemRef);
        const metadata = await getMetadata(itemRef);
        return {
          name: itemRef.name,
          fullPath: itemRef.fullPath,
          url,
          size: metadata.size,
          contentType: metadata.contentType,
          updated: metadata.updated,
          customMetadata: metadata.customMetadata || {}
        };
      })
    );
    return files;
  } catch (error) {
    console.error('❌ Error listing files:', error.message);
    throw error;
  }
}

// ===========================
// دوال مساعدة عامة
// ===========================

function isFirebaseReady() {
  return isInitialized && db !== null;
}

function getServerTimestamp() {
  return serverTimestamp();
}

function generateDocId(collectionName) {
  ensureInitialized();
  return doc(getCollection(collectionName)).id;
}

// ===========================
// التصدير
// ===========================
export {
  // التهيئة
  initializeFirebase,
  isFirebaseReady,
  ensureInitialized,
  
  // مراجع
  getCollection,
  getDocumentRef,
  
  // عمليات القراءة (عبر Worker)
  fetchDocument,
  fetchDocuments,
  
  // عمليات الكتابة العامة (عبر Worker)
  saveDocument,
  updateDocument,
  removeDocument,
  removeDocumentWithSubcollections,
  executeBatch,
  incrementField,
  
  // عمليات Worker المتخصصة
  callAuthWorker,
  workerDataRequest,
  createStudentViaWorker,
  updateStudentViaWorker,
  deleteStudentViaWorker,
  createAdminViaWorker,
  updateAdminViaWorker,
  deleteAdminViaWorker,
  updateSettingsViaWorker,
  resetStudentPasswordViaWorker,
  resetAdminPasswordViaWorker,
  
  // الاستماع للتغييرات (مباشر - Realtime فقط)
  listenToDocument,
  listenToCollection,
  
  // التخزين
  uploadFile,
  validateFile,
  generateSafeFileName,
  getFileURL,
  deleteFile,
  listFiles,
  
  // مساعدة
  getServerTimestamp,
  generateDocId,
  ALLOWED_FILE_TYPES,
  
  // الكائنات الأصلية للاستخدام المباشر
  db,
  storage,
  app
};

// ===========================
// تهيئة تلقائية عند استيراد الملف
// ===========================
const initResult = initializeFirebase();

export { initResult };

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Firebase Config: جاهز | الإصدار 3.0 (جميع العمليات عبر Worker)');
console.log('🔗 Auth Worker:', AUTH_WORKER_URL);
console.log('🛡️ جميع عمليات القراءة/الكتابة تمر عبر Worker');
console.log('👂 Realtime listeners فقط تستخدم Firestore SDK مباشرة');