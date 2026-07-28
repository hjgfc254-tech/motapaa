/* ===========================
   SCHOOLHUB PRO - UTILITIES
   مدرسة الجيل الجديد الخاصة
   الإصدار: 2.1
   =========================== */

/**
 * مكتبة الأدوات المساعدة المركزية
 * تحتوي على دوال التنسيق والتحقق والتشفير والإشعارات والتواريخ
 * تستخدم في جميع صفحات المشروع
 */

// ===========================
// دوال التشفير والأمان
// ===========================

/**
 * توليد Salt عشوائي
 * @param {number} length - طول الـ salt
 * @returns {string}
 */
function generateSalt(length = 16) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * تشفير كلمة المرور باستخدام SHA-256 + Salt
 * @param {string} password - كلمة المرور
 * @param {string} salt - ملح التشفير (اختياري، يولد تلقائياً)
 * @returns {Promise<{hash: string, salt: string}>} كائن يحتوي على التجزئة والملح
 */
async function hashPasswordWithSalt(password, salt = null) {
  try {
    const usedSalt = salt || generateSalt();
    const encoder = new TextEncoder();
    const data = encoder.encode(password + usedSalt);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return { hash: hashHex, salt: usedSalt };
  } catch (error) {
    console.error('❌ فشل تشفير كلمة المرور:', error.message);
    return { hash: simpleHash(password + (salt || '')), salt: salt || '' };
  }
}

/**
 * تشفير كلمة المرور (متوافق مع النظام القديم)
 * @param {string} password - كلمة المرور
 * @returns {Promise<string>} كلمة المرور المشفرة
 */
async function hashPassword(password) {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
  } catch (error) {
    console.error('❌ فشل تشفير كلمة المرور:', error.message);
    return simpleHash(password);
  }
}

/**
 * تشفير احتياطي بسيط للمتصفحات القديمة
 * @param {string} str - النص المراد تشفيره
 * @returns {string}
 */
function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0') + 
         str.split('').reduce((a, b) => a + b.charCodeAt(0), 0).toString(16);
}

/**
 * التحقق من تطابق كلمتي مرور
 * @param {string} plainPassword - كلمة المرور المدخلة
 * @param {string} hashedPassword - كلمة المرور المخزنة
 * @param {string} salt - ملح التشفير (اختياري)
 * @returns {Promise<boolean>}
 */
async function verifyPassword(plainPassword, hashedPassword, salt = '') {
  if (salt) {
    const { hash } = await hashPasswordWithSalt(plainPassword, salt);
    return hash === hashedPassword;
  }
  const hashedInput = await hashPassword(plainPassword);
  return hashedInput === hashedPassword;
}

/**
 * توليد كلمة مرور عشوائية آمنة
 * @param {number} length - طول كلمة المرور
 * @returns {string}
 */
function generateSecurePassword(length = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*';
  const array = new Uint32Array(length);
  crypto.getRandomValues(array);
  let password = '';
  for (let i = 0; i < length; i++) {
    password += chars[array[i] % chars.length];
  }
  return password;
}

/**
 * توليد كود طالب فريد
 * @param {string} prefix - بادئة الكود
 * @param {number} number - الرقم التسلسلي
 * @returns {string}
 */
function generateStudentCode(prefix = 'STS', number = 1) {
  const year = new Date().getFullYear();
  const paddedNumber = String(number).padStart(4, '0');
  return `${prefix}-${year}-${paddedNumber}`;
}

/**
 * تطهير النص من أكواد HTML الضارة (للحماية من XSS)
 * @param {string} str - النص المراد تطهيره
 * @returns {string} النص المطهر
 */
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

// ===========================
// دوال التحقق من صحة البيانات
// ===========================

/**
 * التحقق من صحة البريد الإلكتروني
 * @param {string} email
 * @returns {boolean}
 */
function isValidEmail(email) {
  if (!email) return false;
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email.trim());
}

/**
 * التحقق من صحة رقم الهاتف المصري
 * @param {string} phone
 * @returns {boolean}
 */
function isValidEgyptianPhone(phone) {
  if (!phone) return false;
  const cleaned = phone.replace(/[\s\-\(\)]/g, '');
  const re = /^(01[0125]\d{8}|00201[0125]\d{8}|\+201[0125]\d{8})$/;
  return re.test(cleaned);
}

/**
 * تنظيف رقم الهاتف إلى صيغة موحدة
 * @param {string} phone
 * @returns {string}
 */
function normalizePhone(phone) {
  if (!phone) return '';
  let cleaned = phone.replace(/[\s\-\(\)]/g, '');
  if (cleaned.startsWith('0020')) cleaned = cleaned.substring(4);
  if (cleaned.startsWith('+20')) cleaned = cleaned.substring(3);
  if (cleaned.startsWith('0') === false) cleaned = '0' + cleaned;
  return cleaned;
}

/**
 * التحقق من أن النص غير فارغ
 * @param {string} text
 * @returns {boolean}
 */
function isNotEmpty(text) {
  return text && text.trim().length > 0;
}

/**
 * التحقق من أن القيمة رقم موجب
 * @param {*} value
 * @returns {boolean}
 */
function isPositiveNumber(value) {
  const num = Number(value);
  return !isNaN(num) && num > 0;
}

/**
 * التحقق من أن القيمة في نطاق محدد
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {boolean}
 */
function isInRange(value, min, max) {
  const num = Number(value);
  return !isNaN(num) && num >= min && num <= max;
}

// ===========================
// دوال تنسيق النصوص والأرقام
// ===========================

/**
 * تنسيق التاريخ بالعربية
 * @param {Date|Timestamp|string} date - التاريخ
 * @param {Object} options - خيارات التنسيق
 * @returns {string}
 */
function formatDateArabic(date, options = {}) {
  if (!date) return '—';
  
  try {
    const d = date instanceof Date ? date : new Date(date);
    
    if (isNaN(d.getTime())) return '—';
    
    const defaultOptions = {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    return d.toLocaleDateString('ar-EG', mergedOptions);
  } catch (error) {
    return '—';
  }
}

/**
 * تنسيق الوقت بالعربية
 * @param {Date|Timestamp|string} date
 * @returns {string}
 */
function formatTimeArabic(date) {
  if (!date) return '—';
  
  try {
    const d = date instanceof Date ? date : new Date(date);
    
    if (isNaN(d.getTime())) return '—';
    
    return d.toLocaleTimeString('ar-EG', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  } catch (error) {
    return '—';
  }
}

/**
 * تنسيق التاريخ والوقت معاً
 * @param {Date|Timestamp|string} date
 * @returns {string}
 */
function formatDateTimeArabic(date) {
  if (!date) return '—';
  return `${formatDateArabic(date)} - ${formatTimeArabic(date)}`;
}

/**
 * تنسيق وقت نسبي (منذ دقيقة، منذ ساعة...)
 * @param {Date|Timestamp|string} date
 * @returns {string}
 */
function timeAgoArabic(date) {
  if (!date) return '—';
  
  try {
    const d = date instanceof Date ? date : new Date(date);
    const now = new Date();
    const diff = now - d;
    
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    const weeks = Math.floor(days / 7);
    const months = Math.floor(days / 30);
    const years = Math.floor(days / 365);
    
    if (seconds < 60) return 'الآن';
    if (minutes < 60) return `منذ ${minutes} دقيقة`;
    if (hours < 24) return `منذ ${hours} ساعة`;
    if (days < 7) return `منذ ${days} يوم`;
    if (weeks < 4) return `منذ ${weeks} أسبوع`;
    if (months < 12) return `منذ ${months} شهر`;
    return `منذ ${years} سنة`;
  } catch (error) {
    return '—';
  }
}

/**
 * تنسيق رقم بإضافة فواصل الآلاف
 * @param {number} number
 * @returns {string}
 */
function formatNumberArabic(number) {
  if (number === null || number === undefined) return '0';
  return Number(number).toLocaleString('ar-EG');
}

/**
 * تنسيق المبلغ بالجنيه المصري
 * @param {number} amount
 * @returns {string}
 */
function formatCurrency(amount) {
  if (amount === null || amount === undefined) return '0 ج.م';
  return `${formatNumberArabic(amount)} ج.م`;
}

/**
 * اختصار اسم طويل
 * @param {string} name - الاسم الكامل
 * @param {number} maxLength - أقصى طول
 * @returns {string}
 */
function truncateText(name, maxLength = 25) {
  if (!name) return '';
  if (name.length <= maxLength) return name;
  return name.substring(0, maxLength - 3) + '...';
}

/**
 * الحصول على الأحرف الأولى من الاسم
 * @param {string} name
 * @returns {string}
 */
function getInitials(name) {
  if (!name) return '';
  const parts = name.trim().split(' ');
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

/**
 * تحويل النص إلى حالة عنوان (أول حرف كبير)
 * @param {string} text
 * @returns {string}
 */
function toTitleCase(text) {
  if (!text) return '';
  return text.replace(/\b\w/g, char => char.toUpperCase());
}

// ===========================
// دوال إدارة DOM
// ===========================

/**
 * الحصول على عنصر من DOM بأمان
 * @param {string} selector - المحدد
 * @returns {Element|null}
 */
function $(selector) {
  return document.querySelector(selector);
}

/**
 * الحصول على جميع العناصر المطابقة
 * @param {string} selector
 * @returns {NodeList}
 */
function $$(selector) {
  return document.querySelectorAll(selector);
}

/**
 * إنشاء عنصر HTML
 * @param {string} tag - نوع العنصر
 * @param {Object} attributes - الخصائص
 * @param {string|Element|Array} children - المحتوى
 * @returns {Element}
 */
function createElement(tag, attributes = {}, children = null) {
  const element = document.createElement(tag);
  
  // تعيين الخصائص
  Object.entries(attributes).forEach(([key, value]) => {
    if (key === 'className') {
      element.className = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.substring(2).toLowerCase(), value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.entries(value).forEach(([dataKey, dataValue]) => {
        element.dataset[dataKey] = dataValue;
      });
    } else {
      element.setAttribute(key, value);
    }
  });
  
  // إضافة المحتوى
  if (children) {
    if (typeof children === 'string') {
      element.innerHTML = children;
    } else if (Array.isArray(children)) {
      children.forEach(child => {
        if (typeof child === 'string') {
          element.appendChild(document.createTextNode(child));
        } else if (child instanceof Element) {
          element.appendChild(child);
        }
      });
    } else if (children instanceof Element) {
      element.appendChild(children);
    }
  }
  
  return element;
}

/**
 * إظهار عنصر
 * @param {Element|string} element
 */
function showElement(element) {
  const el = typeof element === 'string' ? $(element) : element;
  if (el) el.classList.remove('hidden');
}

/**
 * إخفاء عنصر
 * @param {Element|string} element
 */
function hideElement(element) {
  const el = typeof element === 'string' ? $(element) : element;
  if (el) el.classList.add('hidden');
}

/**
 * تبديل إظهار/إخفاء عنصر
 * @param {Element|string} element
 */
function toggleElement(element) {
  const el = typeof element === 'string' ? $(element) : element;
  if (el) el.classList.toggle('hidden');
}

// ===========================
// دوال إدارة الـ Toast (الإشعارات المنبثقة)
// ===========================

/**
 * عرض إشعار منبثق
 * @param {string} message - نص الإشعار
 * @param {string} type - النوع: success, error, warning, info
 * @param {number} duration - مدة الظهور بالميلي ثانية
 */
function showToast(message, type = 'info', duration = 4000) {
  // التأكد من وجود حاوية الـ Toast
  let container = $('.toast-container');
  
  if (!container) {
    container = createElement('div', { className: 'toast-container' });
    document.body.appendChild(container);
  }
  
  // تحديد الأيقونة المناسبة
  const icons = {
    success: 'fa-circle-check',
    error: 'fa-circle-xmark',
    warning: 'fa-triangle-exclamation',
    info: 'fa-circle-info'
  };
  
  const icon = icons[type] || icons.info;
  
  // إنشاء عنصر الـ Toast
  const toast = createElement('div', {
    className: `toast toast-${type} fade-in`
  }, [
    createElement('i', { className: `fas ${icon}` }),
    createElement('span', {}, message)
  ]);
  
  // إضافة إلى الحاوية
  container.appendChild(toast);
  
  // إزالة تلقائية بعد المدة
  setTimeout(() => {
    toast.classList.add('toast-hiding');
    toast.addEventListener('animationend', () => {
      toast.remove();
      // إزالة الحاوية إذا كانت فارغة
      if (container && container.children.length === 0) {
        container.remove();
      }
    });
  }, duration);
  
  // إمكانية الإغلاق بالنقر
  toast.addEventListener('click', () => {
    toast.classList.add('toast-hiding');
    toast.addEventListener('animationend', () => {
      toast.remove();
      if (container && container.children.length === 0) {
        container.remove();
      }
    });
  });
}

/**
 * إشعار نجاح
 * @param {string} message
 */
function showSuccess(message) {
  showToast(message, 'success');
}

/**
 * إشعار خطأ
 * @param {string} message
 */
function showError(message) {
  showToast(message, 'error');
}

/**
 * إشعار تحذير
 * @param {string} message
 */
function showWarning(message) {
  showToast(message, 'warning');
}

/**
 * إشعار معلومات
 * @param {string} message
 */
function showInfo(message) {
  showToast(message, 'info');
}

// ===========================
// دوال إدارة الـ Loading
// ===========================

/**
 * إظهار مؤشر تحميل على زر
 * @param {Element} button - عنصر الزر
 * @param {string} text - نص التحميل
 */
function showButtonLoading(button, text = 'جاري التحميل...') {
  if (!button) return;
  button.disabled = true;
  button.dataset.originalText = button.textContent;
  button.innerHTML = `<span class="spinner spinner-sm spinner-white"></span> ${text}`;
}

/**
 * إخفاء مؤشر تحميل من زر
 * @param {Element} button - عنصر الزر
 */
function hideButtonLoading(button) {
  if (!button) return;
  button.disabled = false;
  button.textContent = button.dataset.originalText || button.textContent;
}

/**
 * إظهار تحميل على الصفحة كاملة
 * @param {string} message - رسالة التحميل
 */
function showPageLoading(message = 'جاري التحميل...') {
  let overlay = $('.page-loading-overlay');
  
  if (!overlay) {
    overlay = createElement('div', { className: 'page-loading-overlay overlay' });
    overlay.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 16px;
      z-index: 9999;
    `;
    document.body.appendChild(overlay);
  }
  
  overlay.innerHTML = `
    <div style="background: white; padding: 32px; border-radius: 20px; text-align: center; box-shadow: var(--shadow-2xl);">
      <div class="spinner spinner-lg" style="margin: 0 auto 16px;"></div>
      <p style="font-family: var(--font-heading); font-weight: 600; color: var(--ink);">${message}</p>
    </div>
  `;
  
  showElement(overlay);
}

/**
 * إخفاء تحميل الصفحة
 */
function hidePageLoading() {
  const overlay = $('.page-loading-overlay');
  if (overlay) {
    hideElement(overlay);
  }
}

// ===========================
// دوال التأكيد والحوارات
// ===========================

/**
 * عرض نافذة تأكيد
 * @param {string} message - رسالة التأكيد
 * @param {string} title - عنوان النافذة
 * @param {string} confirmText - نص زر التأكيد
 * @param {string} cancelText - نص زر الإلغاء
 * @returns {Promise<boolean>}
 */
function showConfirm(message, title = 'تأكيد', confirmText = 'نعم', cancelText = 'إلغاء') {
  return new Promise((resolve) => {
    // إنشاء overlay
    const overlay = createElement('div', {
      className: 'confirm-overlay overlay',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '9998'
      }
    });
    
    // إنشاء صندوق الحوار
    const dialog = createElement('div', {
      className: 'card',
      style: {
        maxWidth: '420px',
        width: '90%',
        padding: '24px',
        textAlign: 'center',
        animation: 'slideUp 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)'
      }
    }, [
      createElement('h3', {
        className: 'card-title',
        style: { marginBottom: '12px' }
      }, title),
      createElement('p', {
        style: { color: 'var(--body)', marginBottom: '24px', lineHeight: '1.6' }
      }, message),
      createElement('div', {
        style: { display: 'flex', gap: '12px', justifyContent: 'center' }
      }, [
        createElement('button', {
          className: 'btn btn-outline',
          onClick: () => {
            overlay.remove();
            resolve(false);
          }
        }, cancelText),
        createElement('button', {
          className: 'btn btn-primary',
          onClick: () => {
            overlay.remove();
            resolve(true);
          }
        }, confirmText)
      ])
    ]);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    // إغلاق بالنقر خارج الصندوق
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve(false);
      }
    });
  });
}

/**
 * عرض نافذة تنبيه
 * @param {string} message - الرسالة
 * @param {string} title - العنوان
 */
function showAlert(message, title = 'تنبيه') {
  return new Promise((resolve) => {
    const overlay = createElement('div', {
      className: 'alert-overlay overlay',
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '9998'
      }
    });
    
    const dialog = createElement('div', {
      className: 'card',
      style: {
        maxWidth: '400px',
        width: '90%',
        padding: '24px',
        textAlign: 'center',
        animation: 'slideUp 0.3s cubic-bezier(0.68, -0.55, 0.265, 1.55)'
      }
    }, [
      createElement('h3', {
        className: 'card-title',
        style: { marginBottom: '12px' }
      }, title),
      createElement('p', {
        style: { color: 'var(--body)', marginBottom: '24px', lineHeight: '1.6' }
      }, message),
      createElement('button', {
        className: 'btn btn-secondary',
        style: { minWidth: '120px' },
        onClick: () => {
          overlay.remove();
          resolve();
        }
      }, 'حسناً')
    ]);
    
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
        resolve();
      }
    });
  });
}

// ===========================
// دوال إدارة الـ LocalStorage
// ===========================

/**
 * حفظ بيانات في LocalStorage
 * @param {string} key
 * @param {*} value
 */
function saveToLocal(key, value) {
  try {
    const serialized = JSON.stringify(value);
    localStorage.setItem(`sh_${key}`, serialized);
  } catch (error) {
    console.warn('⚠️ فشل الحفظ في LocalStorage:', error.message);
  }
}

/**
 * استرجاع بيانات من LocalStorage
 * @param {string} key
 * @returns {*}
 */
function getFromLocal(key) {
  try {
    const raw = localStorage.getItem(`sh_${key}`);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}

/**
 * حذف بيانات من LocalStorage
 * @param {string} key
 */
function removeFromLocal(key) {
  try {
    localStorage.removeItem(`sh_${key}`);
  } catch (error) {
    // تجاهل
  }
}

// ===========================
// دوال التصدير والطباعة
// ===========================

/**
 * تصدير بيانات إلى ملف CSV
 * @param {Array<Object>} data - مصفوفة البيانات
 * @param {string} filename - اسم الملف
 */
function exportToCSV(data, filename = 'export.csv') {
  if (!data || data.length === 0) {
    showWarning('لا توجد بيانات للتصدير');
    return;
  }
  
  // استخراج العناوين
  const headers = Object.keys(data[0]);
  
  // بناء محتوى CSV
  let csvContent = '\uFEFF'; // BOM لدعم العربية
  csvContent += headers.join(',') + '\n';
  
  data.forEach(row => {
    const values = headers.map(header => {
      const value = row[header] !== null && row[header] !== undefined ? row[header] : '';
      // تغليف القيم التي تحتوي على فواصل
      const strValue = String(value);
      if (strValue.includes(',') || strValue.includes('"') || strValue.includes('\n')) {
        return '"' + strValue.replace(/"/g, '""') + '"';
      }
      return strValue;
    });
    csvContent += values.join(',') + '\n';
  });
  
  // تحميل الملف
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  
  showSuccess('تم تصدير البيانات بنجاح');
}

/**
 * طباعة عنصر محدد
 * @param {string} selector - محدد العنصر المراد طباعته
 */
function printElement(selector) {
  const element = $(selector);
  if (!element) return;
  
  const originalContents = document.body.innerHTML;
  const printContents = element.outerHTML;
  
  document.body.innerHTML = printContents;
  window.print();
  document.body.innerHTML = originalContents;
  
  // إعادة تحميل الصفحة لاستعادة الأحداث
  window.location.reload();
}

// ===========================
// دوال التعامل مع الملفات
// ===========================

/**
 * تحويل File إلى Base64
 * @param {File} file
 * @returns {Promise<string>}
 */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * التحقق من نوع الملف
 * @param {File} file
 * @param {Array<string>} allowedTypes - الأنواع المسموحة
 * @returns {boolean}
 */
function isValidFileType(file, allowedTypes = ['image/jpeg', 'image/png', 'image/webp']) {
  return allowedTypes.includes(file.type);
}

/**
 * التحقق من حجم الملف
 * @param {File} file
 * @param {number} maxSizeMB - الحجم الأقصى بالميجابايت
 * @returns {boolean}
 */
function isValidFileSize(file, maxSizeMB = 5) {
  const maxSizeBytes = maxSizeMB * 1024 * 1024;
  return file.size <= maxSizeBytes;
}

/**
 * تنسيق حجم الملف للقراءة
 * @param {number} bytes
 * @returns {string}
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ===========================
// دوال عامة
// ===========================

/**
 * تأخير التنفيذ
 * @param {number} ms - المدة بالميلي ثانية
 * @returns {Promise}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * تنفيذ دالة مع محاولات إعادة عند الفشل
 * @param {Function} fn - الدالة المراد تنفيذها
 * @param {number} maxRetries - أقصى عدد محاولات
 * @param {number} delayMs - التأخير بين المحاولات
 * @returns {Promise<*>}
 */
async function retry(fn, maxRetries = 3, delayMs = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      console.warn(`⚠️ محاولة ${attempt}/${maxRetries} فشلت:`, error.message);
      
      if (attempt < maxRetries) {
        await delay(delayMs);
      }
    }
  }
  
  throw lastError;
}

/**
 * نسخ نص إلى الحافظة
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    showSuccess('تم النسخ إلى الحافظة');
    return true;
  } catch (error) {
    // خطة بديلة
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
    showSuccess('تم النسخ إلى الحافظة');
    return true;
  }
}

/**
 * تحويل كائن FormData إلى كائن عادي
 * @param {FormData} formData
 * @returns {Object}
 */
function formDataToObject(formData) {
  const obj = {};
  formData.forEach((value, key) => {
    if (obj[key] !== undefined) {
      if (!Array.isArray(obj[key])) {
        obj[key] = [obj[key]];
      }
      obj[key].push(value);
    } else {
      obj[key] = value;
    }
  });
  return obj;
}

/**
 * التحقق من وجود اتصال بالإنترنت
 * @returns {boolean}
 */
function isOnline() {
  return navigator.onLine;
}

/**
 * مراقبة حالة الاتصال بالإنترنت
 * @param {Function} onlineCallback
 * @param {Function} offlineCallback
 */
function watchConnectivity(onlineCallback, offlineCallback) {
  window.addEventListener('online', () => {
    console.log('🟢 متصل بالإنترنت');
    if (onlineCallback) onlineCallback();
  });
  
  window.addEventListener('offline', () => {
    console.log('🔴 غير متصل بالإنترنت');
    if (offlineCallback) offlineCallback();
  });
}

/**
 * الحصول على اسم المتصفح
 * @returns {string}
 */
function getBrowserName() {
  const userAgent = navigator.userAgent;
  if (userAgent.includes('Firefox')) return 'Firefox';
  if (userAgent.includes('Chrome')) return 'Chrome';
  if (userAgent.includes('Safari')) return 'Safari';
  if (userAgent.includes('Edge')) return 'Edge';
  return 'Unknown';
}

/**
 * إنشاء معرف فريد
 * @returns {string}
 */
function generateUniqueId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}

// ===========================
// التصدير
// ===========================
export {
  // التشفير
  hashPassword,
  hashPasswordWithSalt,
  verifyPassword,
  generateSalt,
  generateSecurePassword,
  generateStudentCode,
  escapeHtml,
  
  // التحقق
  isValidEmail,
  isValidEgyptianPhone,
  normalizePhone,
  isNotEmpty,
  isPositiveNumber,
  isInRange,
  
  // التنسيق
  formatDateArabic,
  formatTimeArabic,
  formatDateTimeArabic,
  timeAgoArabic,
  formatNumberArabic,
  formatCurrency,
  truncateText,
  getInitials,
  toTitleCase,
  
  // DOM
  $,
  $$,
  createElement,
  showElement,
  hideElement,
  toggleElement,
  
  // Toast
  showToast,
  showSuccess,
  showError,
  showWarning,
  showInfo,
  
  // Loading
  showButtonLoading,
  hideButtonLoading,
  showPageLoading,
  hidePageLoading,
  
  // حوارات
  showConfirm,
  showAlert,
  
  // LocalStorage
  saveToLocal,
  getFromLocal,
  removeFromLocal,
  
  // تصدير
  exportToCSV,
  printElement,
  
  // ملفات
  fileToBase64,
  isValidFileType,
  isValidFileSize,
  formatFileSize,
  
  // عامة
  delay,
  retry,
  copyToClipboard,
  formDataToObject,
  isOnline,
  watchConnectivity,
  getBrowserName,
  generateUniqueId
};

// ===========================
// رسالة جاهزية
// ===========================
console.log('📦 Utils: جاهز | الإصدار 2.1');
console.log('ℹ️ تم تحميل جميع الأدوات المساعدة');
console.log('ℹ️ دوال جديدة: escapeHtml, hashPasswordWithSalt, generateSalt');