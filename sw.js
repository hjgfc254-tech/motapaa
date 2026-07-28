/* ===========================
   SCHOOLHUB PRO - SERVICE WORKER
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1
   =========================== */

/**
 * Service Worker للتخزين المؤقت ودعم Offline
 * يحسن أداء التطبيق ويقلل استهلاك البيانات
 * يدعم التثبيت كتطبيق PWA على الهاتف
 * 
 * تم إصلاحه: #10 - استثناء ملفات الإدارة من الكاش
 * - ملفات /admin/ تُستخدم مع Network Only
 * - إزالة التعارض بين STATIC_ASSETS و NEVER_CACHE
 */

// ===========================
// إعدادات
// ===========================
const CACHE_VERSION = 'sh-v2.1.0';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;
const API_CACHE = `${CACHE_VERSION}-api`;

// الملفات التي يتم تخزينها عند التثبيت
// ملاحظة: ملفات الإدارة غير مضمنة - تُستخدم Network Only
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/student-dashboard.html',
  '/student-schedule.html',
  '/student-announcements.html',
  '/student-messages.html',
  '/student-attendance.html',
  '/student-expenses.html',
  '/student-events.html',
  '/student-gallery.html',
  '/student-profile.html',
  '/offline.html',
  '/css/design-system.css',
  '/js/firebase-config.js',
  '/js/auto-seeder.js',
  '/js/cache-manager.js',
  '/js/utils.js',
  '/js/auth-system.js',
  '/elgeel.png',
  '/manifest.json'
];

// ===========================
// أحداث Service Worker
// ===========================

/**
 * التثبيت - تخزين الملفات الأساسية
 */
self.addEventListener('install', (event) => {
  console.log('🔧 Service Worker: جاري التثبيت...');
  
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('📦 تخزين الملفات الأساسية...');
        return cache.addAll(STATIC_ASSETS);
      })
      .then(() => {
        console.log('✅ Service Worker: تم التثبيت بنجاح');
        return self.skipWaiting();
      })
      .catch((error) => {
        console.error('❌ فشل تخزين الملفات:', error);
      })
  );
});

/**
 * التفعيل - تنظيف الكاش القديم
 */
self.addEventListener('activate', (event) => {
  console.log('🔄 Service Worker: جاري التفعيل...');
  
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((cacheName) => {
              // حذف الكاشات القديمة التي لا تطابق الإصدار الحالي
              return cacheName.startsWith('sh-') && 
                     cacheName !== STATIC_CACHE && 
                     cacheName !== DYNAMIC_CACHE && 
                     cacheName !== IMAGE_CACHE && 
                     cacheName !== API_CACHE;
            })
            .map((cacheName) => {
              console.log('🗑️ حذف الكاش القديم:', cacheName);
              return caches.delete(cacheName);
            })
        );
      })
      .then(() => {
        console.log('✅ Service Worker: تم التفعيل');
        return self.clients.claim();
      })
  );
});

/**
 * الجلب - استراتيجيات مختلفة حسب نوع الملف
 */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  // تجاهل طلبات غير GET
  if (request.method !== 'GET') return;
  
  // تجاهل طلبات Chrome extensions
  if (url.protocol === 'chrome-extension:') return;
  
  // تجاهل طلبات Firebase (تتم عبر WebSocket/HTTP مباشرة)
  if (url.hostname.includes('firebase') || 
      url.hostname.includes('googleapis') ||
      url.hostname.includes('gstatic')) {
    return;
  }
  
  // ملفات الإدارة: Network Only (لا تخزين مؤقت)
  if (isAdminAsset(url)) {
    event.respondWith(networkOnly(request));
    return;
  }
  
  // استراتيجيات مختلفة حسب نوع الملف
  if (isStaticAsset(url)) {
    // الملفات الثابتة: Cache First
    event.respondWith(cacheFirst(request, STATIC_CACHE));
  } else if (isImage(url)) {
    // الصور: Cache First مع تحديث في الخلفية
    event.respondWith(staleWhileRevalidate(request, IMAGE_CACHE));
  } else if (isAPI(url)) {
    // API: Network First مع Cache Fallback
    event.respondWith(networkFirst(request, API_CACHE));
  } else {
    // باقي الملفات: Network First
    event.respondWith(networkFirst(request, DYNAMIC_CACHE));
  }
});

// ===========================
// استراتيجيات التخزين المؤقت
// ===========================

/**
 * Network Only - الشبكة فقط بدون تخزين
 * مناسبة لملفات الإدارة التي يجب أن تكون محدثة دائماً
 */
async function networkOnly(request) {
  console.log('🔒 Network Only (إدارة):', request.url);
  try {
    return await fetch(request);
  } catch (error) {
    console.warn('⚠️ فشل الجلب (Network Only):', request.url);
    throw error;
  }
}

/**
 * Cache First - استخدام الكاش أولاً ثم الشبكة
 * مناسبة للملفات الثابتة التي نادراً ما تتغير
 */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  
  if (cached) {
    console.log('⚡ من الكاش:', request.url);
    return cached;
  }
  
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
      console.log('🌐 من الشبكة (تم التخزين):', request.url);
    }
    
    return networkResponse;
  } catch (error) {
    console.warn('⚠️ فشل الجلب من الشبكة:', request.url);
    
    // صفحة Offline احتياطية للصفحات
    if (request.headers.get('accept')?.includes('text/html')) {
      const offlineCache = await caches.match('/offline.html');
      return offlineCache || new Response(
        '<html dir="rtl"><body style="text-align:center;padding:50px;font-family:Tajawal;"><h2>أنت غير متصل بالإنترنت</h2><p>يرجى التحقق من اتصالك والمحاولة مرة أخرى.</p></body></html>',
        { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
    
    throw error;
  }
}

/**
 * Network First - استخدام الشبكة أولاً ثم الكاش
 * مناسبة للبيانات المتغيرة
 */
async function networkFirst(request, cacheName) {
  try {
    const networkResponse = await fetch(request);
    
    if (networkResponse && networkResponse.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, networkResponse.clone());
      console.log('🌐 من الشبكة:', request.url);
    }
    
    return networkResponse;
  } catch (error) {
    console.warn('⚠️ الشبكة غير متاحة، محاولة الكاش:', request.url);
    
    const cached = await caches.match(request);
    if (cached) {
      console.log('⚡ من الكاش الاحتياطي:', request.url);
      return cached;
    }
    
    throw error;
  }
}

/**
 * Stale While Revalidate - استخدام الكاش مع التحديث في الخلفية
 * مناسبة للصور والملفات الكبيرة
 */
async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  
  // تحديث الكاش في الخلفية
  const fetchPromise = fetch(request)
    .then(async (networkResponse) => {
      if (networkResponse && networkResponse.ok) {
        const cache = await caches.open(cacheName);
        cache.put(request, networkResponse.clone());
        console.log('🔄 تم تحديث الكاش في الخلفية:', request.url);
      }
      return networkResponse;
    })
    .catch((error) => {
      console.warn('⚠️ فشل التحديث في الخلفية:', request.url);
    });
  
  // إرجاع النسخة المخزنة فوراً إذا كانت موجودة
  if (cached) {
    console.log('⚡ من الكاش (سيتم التحديث):', request.url);
    return cached;
  }
  
  // وإلا انتظار الشبكة
  return fetchPromise;
}

// ===========================
// دوال مساعدة
// ===========================

/**
 * التحقق مما إذا كان الملف من ملفات الإدارة (Network Only)
 */
function isAdminAsset(url) {
  const pathname = url.pathname;
  return (
    pathname.startsWith('/admin-') ||
    pathname.includes('/js/admin-')
  );
}

/**
 * التحقق مما إذا كان الملف من الأصول الثابتة
 */
function isStaticAsset(url) {
  const pathname = url.pathname;
  
  // استثناء ملفات الإدارة
  if (isAdminAsset(url)) return false;
  
  return (
    pathname.endsWith('.html') ||
    pathname.endsWith('.css') ||
    pathname.endsWith('.js') ||
    pathname === '/' ||
    pathname.endsWith('manifest.json')
  );
}

/**
 * التحقق مما إذا كان الملف صورة
 */
function isImage(url) {
  const pathname = url.pathname;
  return (
    pathname.endsWith('.png') ||
    pathname.endsWith('.jpg') ||
    pathname.endsWith('.jpeg') ||
    pathname.endsWith('.webp') ||
    pathname.endsWith('.svg') ||
    pathname.endsWith('.gif') ||
    pathname.endsWith('.ico')
  );
}

/**
 * التحقق مما إذا كان الطلب API
 */
function isAPI(url) {
  return url.pathname.includes('/api/') || 
         url.hostname.includes('firestore');
}

// ===========================
// أحداث إضافية
// ===========================

/**
 * رسالة من الصفحة الرئيسية
 */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (event.data && event.data.type === 'CLEAR_CACHE') {
    clearAllCaches().then(() => {
      event.ports[0]?.postMessage({ success: true });
    });
  }
  
  if (event.data && event.data.type === 'GET_CACHE_STATS') {
    getCacheStats().then((stats) => {
      event.ports[0]?.postMessage(stats);
    });
  }
});

/**
 * إشعارات Push (مستقبلاً)
 */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  
  try {
    const data = event.data.json();
    
    const options = {
      body: data.body || 'إشعار جديد من المدرسة',
      icon: '/elgeel.png',
      badge: '/elgeel.png',
      vibrate: [200, 100, 200],
      tag: data.tag || 'default',
      data: {
        url: data.url || '/'
      },
      actions: data.actions || [],
      dir: 'rtl',
      lang: 'ar'
    };
    
    event.waitUntil(
      self.registration.showNotification(
        data.title || 'مدارس الجيل الجديد',
        options
      )
    );
  } catch (error) {
    console.warn('⚠️ فشل عرض الإشعار:', error);
  }
});

/**
 * النقر على الإشعار
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  
  const url = event.notification.data?.url || '/';
  
  event.waitUntil(
    clients.matchAll({ type: 'window' })
      .then((clientList) => {
        // فتح نافذة موجودة أو جديدة
        for (const client of clientList) {
          if (client.url.includes(url) && 'focus' in client) {
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});

// ===========================
// دوال إدارة الكاش
// ===========================

/**
 * مسح جميع الكاشات
 */
async function clearAllCaches() {
  const cacheNames = await caches.keys();
  const deletePromises = cacheNames
    .filter(name => name.startsWith('sh-'))
    .map(name => {
      console.log('🗑️ حذف الكاش:', name);
      return caches.delete(name);
    });
  
  await Promise.all(deletePromises);
  console.log('✅ تم مسح جميع الكاشات');
}

/**
 * الحصول على إحصائيات الكاش
 */
async function getCacheStats() {
  const cacheNames = await caches.keys();
  const stats = [];
  
  for (const cacheName of cacheNames) {
    if (cacheName.startsWith('sh-')) {
      const cache = await caches.open(cacheName);
      const keys = await cache.keys();
      stats.push({
        name: cacheName,
        items: keys.length
      });
    }
  }
  
  return stats;
}

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Service Worker: جاهز | الإصدار 2.1');
console.log('💾 إصدار الكاش:', CACHE_VERSION);
console.log('📋 الملفات المخزنة:', STATIC_ASSETS.length);
console.log('🔒 ملفات الإدارة: Network Only');