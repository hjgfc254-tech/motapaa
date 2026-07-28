/* ===========================
   SCHOOLHUB PRO - FIRESTORE SECURITY RULES
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1 - الإنتاج مع Cloudflare Worker
   =========================== */

/**
 * قواعد أمان Firestore للإنتاج الكامل
 * 
 * الوضع: جميع الطلبات تمر عبر Cloudflare Worker (auth-worker.js)
 * الـ Worker يستخدم Service Account للوصول إلى Firestore
 * المتصفح لا يتصل مباشرة بـ Firestore أبداً
 * 
 * طريقة الاستخدام:
 * 1. اذهب إلى Firebase Console > Firestore Database > Rules
 * 2. انسخ محتوى FIRESTORE_RULES أدناه
 * 3. الصقه في محرر القواعد واضغط Publish
 * 
 * ملاحظة: هذا الملف للتوثيق والنسخ فقط، لا يتم استيراده في الكود
 */

// ===========================
// نسخة القواعد الكاملة للإنتاج
// ===========================
const FIRESTORE_RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // ===========================
    // إعدادات النظام (للقراءة فقط عبر Worker)
    // ===========================
    match /settings/{document} {
      allow read, write: if false;
    }
    
    // ===========================
    // العدادات
    // ===========================
    match /counters/{document} {
      allow read, write: if false;
    }
    
    // ===========================
    // هيكل المدرسة
    // ===========================
    match /school_structure/{document} {
      allow read, write: if false;
    }
    
    // ===========================
    // الطلاب
    // ===========================
    match /students/{studentId} {
      allow read, write: if false;
    }
    
    // ===========================
    // المشرفين
    // ===========================
    match /admins/{adminId} {
      allow read, write: if false;
    }
    
    // ===========================
    // الإعلانات
    // ===========================
    match /announcements/{announcementId} {
      allow read, write: if false;
    }
    
    // ===========================
    // الرسائل
    // ===========================
    match /messages/{messageId} {
      allow read, write: if false;
    }
    
    // ===========================
    // الأحداث
    // ===========================
    match /events/{eventId} {
      allow read, write: if false;
    }
    
    // ===========================
    // الألبومات والصور
    // ===========================
    match /albums/{albumId} {
      allow read, write: if false;
      
      match /images/{imageId} {
        allow read, write: if false;
      }
    }
    
    // ===========================
    // جداول الحصص
    // ===========================
    match /schedules/{scheduleId} {
      allow read, write: if false;
    }
    
    // ===========================
    // الحضور والغياب
    // ===========================
    match /attendance/{attendanceId} {
      allow read, write: if false;
      
      // Subcollection: سجلات الحضور اليومية
      match /records/{recordId} {
        allow read, write: if false;
      }
    }
    
    // ===========================
    // المصروفات
    // ===========================
    match /expenses/{expenseId} {
      allow read, write: if false;
      
      // Subcollection: سجل المدفوعات
      match /payments/{paymentId} {
        allow read, write: if false;
      }
    }
    
    // ===========================
    // الإشعارات
    // ===========================
    match /notifications/{notificationId} {
      allow read, write: if false;
    }
    
    // ===========================
    // سجل العمليات
    // ===========================
    match /system_logs/{logId} {
      allow read, write: if false;
    }
    
    // ===========================
    // قاعدة عامة - منع أي وصول آخر
    // ===========================
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
`;

// ===========================
// قواعد Firebase Storage
// ===========================
const STORAGE_RULES = `
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    
    // جميع الملفات محمية - الوصول عبر Worker فقط
    match /{allPaths=**} {
      allow read, write: if false;
    }
  }
}
`;

// ===========================
// تعليمات النشر
// ===========================
const SETUP_INSTRUCTIONS = `
📚 طريقة تطبيق قواعد الأمان للإنتاج:

🛡️ Firestore Rules:
1. افتح Firebase Console:
   https://console.firebase.google.com/project/elgeel-f4e0d/firestore/rules
2. انسخ محتوى FIRESTORE_RULES كاملاً
3. الصقه في محرر القواعد
4. اضغط "Publish" (نشر)

🖼️ Storage Rules:
1. اذهب إلى Storage > Rules
2. انسخ محتوى STORAGE_RULES
3. الصقه واضغط Publish

☁️ Cloudflare Worker (متغيرات البيئة المطلوبة):
1. اذهب إلى Cloudflare Dashboard > Workers > schoolhub-auth
2. Settings > Variables > Add:
   - FIREBASE_API_KEY: مفتاح Firebase API
   - PEPPER: سلسلة عشوائية سرية (32 حرف)
   - JWT_SECRET: مفتاح توقيع JWT (64 حرف)
   - FIREBASE_SERVICE_ACCOUNT: JSON كامل لحساب الخدمة (للوصول إلى Firestore)

⚠️ تنبيهات هامة:
- بعد تطبيق هذه القواعد، لن يستطيع أي مستخدم الوصول إلى Firestore مباشرة
- جميع الطلبات يجب أن تمر عبر Cloudflare Worker
- تأكد من نشر الـ Worker أولاً قبل تطبيق هذه القواعد
- اختبر النظام بالكامل بعد تطبيق القواعد
`;

// ===========================
// دالة طباعة القواعد للنسخ
// ===========================
function printFirestoreRules() {
  console.log('📋 Firestore Security Rules (الإنتاج مع Worker):');
  console.log('═══════════════════════════════════════');
  console.log(FIRESTORE_RULES);
  console.log('═══════════════════════════════════════');
  console.log('');
  console.log('📋 Storage Security Rules:');
  console.log('═══════════════════════════════════════');
  console.log(STORAGE_RULES);
  console.log('═══════════════════════════════════════');
}

// ===========================
// دالة نسخ القواعد إلى الحافظة
// ===========================
async function copyRulesToClipboard(type = 'firestore') {
  const rules = type === 'firestore' ? FIRESTORE_RULES : STORAGE_RULES;
  
  try {
    await navigator.clipboard.writeText(rules);
    console.log('✅ تم نسخ القواعد إلى الحافظة');
    return true;
  } catch (error) {
    console.error('❌ فشل نسخ القواعد:', error.message);
    return false;
  }
}

// ===========================
// تصدير
// ===========================
export {
  FIRESTORE_RULES,
  STORAGE_RULES,
  SETUP_INSTRUCTIONS,
  printFirestoreRules,
  copyRulesToClipboard
};

// ===========================
// طباعة تلقائية للشرح عند الاستيراد
// ===========================
console.log('📦 Firestore Rules: جاهز | الإصدار 2.1');
console.log('🛡️ الوضع: إنتاج كامل مع Cloudflare Worker');
console.log('ℹ️ جميع الطلبات تمر عبر Worker - لا وصول مباشر من المتصفح');
console.log('ℹ️ استخدم printFirestoreRules() لعرض القواعد');
console.log('ℹ️ استخدم copyRulesToClipboard("firestore") لنسخ قواعد Firestore');