/* ===========================
   SCHOOLHUB PRO - ADMIN INIT
   مدارس الجيل الجديد الخاصة
   الإصدار: 2.1
   =========================== */

/**
 * ملف التهيئة الرئيسي للوحة تحكم الإدارة
 * يربط واجهة admin-dashboard.html بجميع وحدات الإدارة
 * 
 * تم إصلاحه: #13 - منع تسريب الذاكرة من تكرار تحميل السكريبتات
 */

import { authManager } from './auth-system.js';
import { adminStudents } from './admin-students.js';
import { adminAnnouncements } from './admin-announcements.js';
import { adminMessages } from './admin-messages.js';
import { adminStages } from './admin-stages.js';
import { adminEvents } from './admin-events.js';
import { adminSchedules } from './admin-schedules.js';
import { adminAttendance } from './admin-attendance.js';
import { adminExpenses } from './admin-expenses.js';
import { adminGallery } from './admin-gallery.js';
import { adminSettings } from './admin-settings.js';
import { adminLogs } from './admin-logs.js';
import { initializeSystem, checkSystemStatus } from './auto-seeder.js';
import { fetchDocument } from './firebase-config.js';
import { 
  showToast, showConfirm, showAlert, showSuccess, showError,
  formatDateArabic, formatDateTimeArabic, formatNumberArabic, formatCurrency,
  timeAgoArabic, getInitials
} from './utils.js';
import { cacheManager, CACHE_CONFIG, clearAllCache } from './cache-manager.js';

// ===========================
// إدارة السكريبتات المحملة (منع التسريب)
// ===========================
const loadedScripts = new Map(); // مفتاح: نص السكريبت, قيمة: عنصر السكريبت
const loadedModules = new Set(); // أسماء الوحدات المحملة
const SCRIPT_MARKER = 'data-dynamic-page'; // وسم لتحديد السكريبتات المضافة ديناميكياً

const contentArea = document.getElementById('contentArea');
const pageTitle = document.getElementById('pageTitle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');
const menuToggle = document.getElementById('menuToggle');
const statStudents = document.getElementById('statStudents');
const statActive = document.getElementById('statActive');
const statInactive = document.getElementById('statInactive');
const statStages = document.getElementById('statStages');

let currentAdmin = null;
let currentPage = 'dashboard';

async function initAdminDashboard() {
  try {
    const session = await authManager.initialize();
    
    if (!session.isAuthenticated || session.type !== 'admin') {
      window.location.href = 'admin-login.html';
      return;
    }
    
    currentAdmin = session.user;
    updateAdminUI(currentAdmin);
    await initializeSystem(false);
    await loadDashboardStats();
    setupNavigation();
    setupButtons();
    setupQuickActions();
    
    console.log('✅ لوحة تحكم الإدارة جاهزة');
    
  } catch (error) {
    console.error('❌ فشل تهيئة لوحة التحكم:', error);
    showToast('حدث خطأ في تحميل لوحة التحكم', 'error');
  }
}

function updateAdminUI(admin) {
  const name = admin.display_name || admin.username || 'مشرف';
  const initials = getInitials(name);
  
  const avatarEl = document.getElementById('adminAvatar');
  const nameEl = document.getElementById('adminName');
  const roleEl = document.getElementById('adminRole');
  
  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl) nameEl.textContent = name;
  
  const roleMap = { super_admin: 'مدير عام', admin: 'مشرف', editor: 'محرر' };
  if (roleEl) roleEl.textContent = roleMap[admin.role] || admin.role;
}

async function loadDashboardStats() {
  try {
    const counters = await fetchDocument('counters', 'stats');
    
    if (counters) {
      if (statStudents) statStudents.textContent = formatNumberArabic(counters.total_students || 0);
      if (statActive) statActive.textContent = formatNumberArabic(counters.total_active_students || 0);
      if (statInactive) statInactive.textContent = formatNumberArabic(counters.total_inactive_students || 0);
      if (statStages) statStages.textContent = formatNumberArabic(counters.total_stages || 0);
    }
  } catch (error) {
    console.warn('⚠️ فشل تحميل الإحصائيات');
  }
}

function setupNavigation() {
  if (menuToggle) {
    menuToggle.addEventListener('click', toggleSidebar);
  }
  
  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', closeSidebar);
  }
  
  document.querySelectorAll('.nav-item[data-page]').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      navigateTo(page);
      
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      item.classList.add('active');
      closeSidebar();
    });
  });
  
  const logoutBtn = document.getElementById('sidebarLogout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }
}

function toggleSidebar() {
  if (sidebar) sidebar.classList.toggle('open');
  if (sidebarOverlay) sidebarOverlay.classList.toggle('open');
}

function closeSidebar() {
  if (sidebar) sidebar.classList.remove('open');
  if (sidebarOverlay) sidebarOverlay.classList.remove('open');
}

/**
 * إزالة السكريبتات القديمة المرتبطة بالصفحة السابقة
 */
function cleanupPageScripts() {
  const dynamicScripts = document.querySelectorAll(`script[${SCRIPT_MARKER}]`);
  dynamicScripts.forEach(script => {
    const key = script.textContent || script.src;
    loadedScripts.delete(key);
    script.remove();
  });
}

function navigateTo(page) {
  // إذا كانت نفس الصفحة الحالية، لا تفعل شيئاً
  if (page === currentPage) return;
  
  currentPage = page;
  
  const pageFiles = {
    dashboard: null,
    students: 'admin-students.html',
    stages: 'admin-stages.html',
    admins: null,
    announcements: 'admin-announcements.html',
    messages: 'admin-messages.html',
    events: 'admin-events.html',
    gallery: 'admin-gallery.html',
    schedules: 'admin-schedules.html',
    attendance: 'admin-attendance.html',
    expenses: 'admin-expenses.html',
    settings: 'admin-settings.html',
    logs: 'admin-logs.html'
  };
  
  const titles = {
    dashboard: 'لوحة التحكم',
    students: 'إدارة الطلاب',
    stages: 'المراحل والفصول',
    admins: 'المشرفين',
    announcements: 'الإعلانات',
    messages: 'الرسائل',
    events: 'الأحداث',
    gallery: 'معرض الصور',
    schedules: 'جداول الحصص',
    attendance: 'الحضور والغياب',
    expenses: 'المصروفات',
    settings: 'الإعدادات',
    logs: 'سجل العمليات'
  };
  
  if (pageTitle) pageTitle.textContent = titles[page] || page;
  
  // تنظيف السكريبتات القديمة قبل تحميل الجديدة
  cleanupPageScripts();
  
  if (page === 'dashboard') {
    renderDashboard();
  } else if (pageFiles[page]) {
    loadPageContent(pageFiles[page]);
  } else {
    renderPageContent(page, titles[page] || page);
  }
}

async function loadPageContent(url) {
  if (!contentArea) return;
  
  contentArea.innerHTML = `
    <div style="text-align:center;padding:var(--space-3xl);">
      <div class="spinner spinner-lg"></div>
      <p style="margin-top:16px;color:var(--mute);">جاري تحميل الصفحة...</p>
    </div>
  `;
  
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('فشل تحميل الصفحة');
    
    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');
    const pageContent = doc.querySelector('.page-container');
    
    if (pageContent) {
      contentArea.innerHTML = pageContent.outerHTML;
      
      // معالجة السكريبتات مع منع التكرار
      const scripts = doc.querySelectorAll('script[type="module"]');
      scripts.forEach(oldScript => {
        const scriptKey = oldScript.textContent || oldScript.src;
        
        // تخطي إذا كان السكريبت محملاً مسبقاً
        if (scriptKey && loadedScripts.has(scriptKey)) {
          console.log('⏭️ تخطي سكريبت محمل مسبقاً');
          return;
        }
        
        const newScript = document.createElement('script');
        newScript.type = 'module';
        newScript.textContent = oldScript.textContent;
        newScript.setAttribute(SCRIPT_MARKER, 'true');
        document.body.appendChild(newScript);
        
        // تخزين مرجع للسكريبت
        if (scriptKey) {
          loadedScripts.set(scriptKey, newScript);
        }
      });
    } else {
      contentArea.innerHTML = html;
    }
  } catch (error) {
    contentArea.innerHTML = `
      <div style="text-align:center;padding:var(--space-3xl);">
        <i class="fas fa-exclamation-circle" style="font-size:40px;color:var(--red);margin-bottom:16px;display:block;"></i>
        <p style="color:var(--red);">فشل تحميل الصفحة</p>
      </div>
    `;
  }
}

function renderDashboard() {
  if (!contentArea) return;
  
  contentArea.innerHTML = `
    <div class="stats-row">
      <div class="stat-box">
        <div class="stat-icon blue"><i class="fas fa-user-graduate"></i></div>
        <div class="stat-info">
          <div class="stat-value" id="statStudents">${statStudents?.textContent || '—'}</div>
          <div class="stat-label">إجمالي الطلاب</div>
        </div>
      </div>
      <div class="stat-box">
        <div class="stat-icon green"><i class="fas fa-user-check"></i></div>
        <div class="stat-info">
          <div class="stat-value" id="statActive">${statActive?.textContent || '—'}</div>
          <div class="stat-label">طلاب مفعلين</div>
        </div>
      </div>
      <div class="stat-box">
        <div class="stat-icon red"><i class="fas fa-user-xmark"></i></div>
        <div class="stat-info">
          <div class="stat-value" id="statInactive">${statInactive?.textContent || '—'}</div>
          <div class="stat-label">طلاب معطلين</div>
        </div>
      </div>
      <div class="stat-box">
        <div class="stat-icon warning"><i class="fas fa-layer-group"></i></div>
        <div class="stat-info">
          <div class="stat-value" id="statStages">${statStages?.textContent || '—'}</div>
          <div class="stat-label">المراحل الدراسية</div>
        </div>
      </div>
    </div>
    
    <div class="advanced-controls">
      <button class="control-btn" id="btnPromoteAll">
        <i class="fas fa-arrow-up"></i> ترقية جماعية
      </button>
      <button class="control-btn danger" id="btnMaintenanceToggle">
        <i class="fas fa-power-off"></i> وضع الصيانة
      </button>
      <button class="control-btn" id="btnExport">
        <i class="fas fa-file-export"></i> تصدير البيانات
      </button>
      <button class="control-btn" id="btnGuide">
        <i class="fas fa-book"></i> كتالوج النظام
      </button>
    </div>
    
    <h3 style="font-family:var(--font-heading);font-weight:var(--weight-extrabold);color:var(--navy-deep);margin-bottom:var(--space-lg);">
      <i class="fas fa-bolt" style="color:var(--royal);margin-left:8px;"></i>
      إجراءات سريعة
    </h3>
    <div class="quick-actions-grid">
      <div class="quick-action-card" data-action="add-student">
        <div class="quick-action-icon"><i class="fas fa-user-plus"></i></div>
        <span class="quick-action-label">إضافة طالب</span>
      </div>
      <div class="quick-action-card" data-action="add-stage">
        <div class="quick-action-icon"><i class="fas fa-folder-plus"></i></div>
        <span class="quick-action-label">إضافة مرحلة</span>
      </div>
      <div class="quick-action-card" data-action="add-announcement">
        <div class="quick-action-icon"><i class="fas fa-bullhorn"></i></div>
        <span class="quick-action-label">إعلان جديد</span>
      </div>
      <div class="quick-action-card" data-action="send-message">
        <div class="quick-action-icon"><i class="fas fa-paper-plane"></i></div>
        <span class="quick-action-label">إرسال رسالة</span>
      </div>
      <div class="quick-action-card" data-action="add-event">
        <div class="quick-action-icon"><i class="fas fa-calendar-plus"></i></div>
        <span class="quick-action-label">إضافة حدث</span>
      </div>
      <div class="quick-action-card" data-action="import-students">
        <div class="quick-action-icon"><i class="fas fa-file-import"></i></div>
        <span class="quick-action-label">استيراد طلاب</span>
      </div>
    </div>
  `;
  
  setupButtons();
  setupQuickActions();
  loadDashboardStats();
}

function renderPageContent(page, title) {
  if (!contentArea) return;
  
  const icons = {
    students: 'fa-user-graduate',
    stages: 'fa-layer-group',
    admins: 'fa-user-shield',
    announcements: 'fa-bullhorn',
    messages: 'fa-message',
    events: 'fa-calendar-star',
    gallery: 'fa-images',
    schedules: 'fa-calendar-week',
    attendance: 'fa-clipboard-check',
    expenses: 'fa-receipt',
    settings: 'fa-gear',
    logs: 'fa-clock-rotate-left'
  };
  
  const descriptions = {
    admins: 'إدارة حسابات المشرفين وصلاحياتهم'
  };
  
  contentArea.innerHTML = `
    <div style="background:var(--white);border-radius:var(--radius-2xl);padding:var(--space-3xl);text-align:center;box-shadow:var(--shadow-sm);border:1px solid var(--border-light);">
      <div style="width:72px;height:72px;border-radius:20px;background:var(--royal-light);color:var(--royal);display:flex;align-items:center;justify-content:center;font-size:30px;margin:0 auto var(--space-xl);">
        <i class="fas ${icons[page] || 'fa-tools'}"></i>
      </div>
      <h3 style="font-family:var(--font-heading);font-size:var(--text-xl);color:var(--navy-deep);margin-bottom:var(--space-md);">${title}</h3>
      <p style="color:var(--body);font-size:var(--text-sm);margin-bottom:var(--space-xl);">${descriptions[page] || 'هذه الصفحة قيد التطوير'}</p>
      <p style="color:var(--mute);font-size:var(--text-xs);">الوحدة: admin-${page}.js</p>
    </div>
  `;
}

function setupButtons() {
  const promoteBtn = document.getElementById('btnPromoteAll');
  if (promoteBtn) {
    promoteBtn.addEventListener('click', async () => {
      const confirmed = await showConfirm(
        'سيتم ترقية جميع الطلاب إلى المرحلة التالية. هذا الإجراء لا يمكن التراجع عنه. هل تريد المتابعة؟',
        'تأكيد الترقية الجماعية',
        'نعم، ترقية',
        'إلغاء'
      );
      if (confirmed) showToast('سيتم تطبيق هذه الميزة قريباً', 'info', 3000);
    });
  }
  
  const maintenanceBtn = document.getElementById('btnMaintenanceToggle');
  if (maintenanceBtn) {
    maintenanceBtn.addEventListener('click', async () => {
      try {
        await adminSettings.toggleMaintenanceMode();
      } catch (error) {
        showError(error.message || 'فشل تغيير وضع الصيانة');
      }
    });
  }
  
  const exportBtn = document.getElementById('btnExport');
  if (exportBtn) {
    exportBtn.addEventListener('click', async () => {
      try {
        const csv = await adminStudents.exportStudentsToCSV();
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `students_export_${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        showSuccess('تم تصدير البيانات بنجاح');
      } catch (error) {
        showError(error.message || 'فشل التصدير');
      }
    });
  }
  
  const guideBtn = document.getElementById('btnGuide');
  if (guideBtn) {
    guideBtn.addEventListener('click', () => {
      showAlert(
        '📚 كتالوج استخدام النظام\n\n' +
        '• إدارة الطلاب: إضافة وتعديل وحذف وتفعيل الطلاب\n' +
        '• المراحل والفصول: إنشاء هيكل المدرسة\n' +
        '• الإعلانات: نشر إعلانات عامة أو موجهة\n' +
        '• الرسائل: التواصل مع الطلاب\n' +
        '• المصروفات: إدارة المدفوعات والمتبقي\n' +
        '• الحضور: تسجيل ومتابعة الحضور اليومي\n' +
        '• جداول الحصص: إنشاء الجدول الأسبوعي\n' +
        '• الإعدادات: التحكم في النظام ووضع الصيانة',
        'كتالوج النظام'
      );
    });
  }
}

function setupQuickActions() {
  document.querySelectorAll('.quick-action-card[data-action]').forEach(card => {
    card.addEventListener('click', () => {
      const action = card.dataset.action;
      const pageMap = {
        'add-student': 'students',
        'add-stage': 'stages',
        'add-announcement': 'announcements',
        'send-message': 'messages',
        'add-event': 'events',
        'import-students': 'students'
      };
      
      const targetPage = pageMap[action];
      if (targetPage) {
        navigateTo(targetPage);
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        const navItem = document.querySelector(`.nav-item[data-page="${targetPage}"]`);
        if (navItem) navItem.classList.add('active');
      }
    });
  });
}

async function handleLogout() {
  const confirmed = await showConfirm('هل أنت متأكد من تسجيل الخروج؟', 'تأكيد');
  if (confirmed) {
    await authManager.logout();
    window.location.href = 'admin-login.html';
  }
}

window.AdminDashboard = {
  navigateTo,
  refreshStats: loadDashboardStats,
  showToast,
  showConfirm,
  showAlert,
  students: adminStudents,
  announcements: adminAnnouncements,
  messages: adminMessages,
  stages: adminStages,
  events: adminEvents,
  schedules: adminSchedules,
  attendance: adminAttendance,
  expenses: adminExpenses,
  gallery: adminGallery,
  settings: adminSettings,
  logs: adminLogs
};

document.addEventListener('DOMContentLoaded', initAdminDashboard);

console.log('📦 Admin Init: جاهز | الإصدار 2.1');
console.log('🔧 منع تسريب الذاكرة: تتبع السكريبتات المحملة');
console.log('ℹ️ جميع وحدات الإدارة متاحة عبر window.AdminDashboard');